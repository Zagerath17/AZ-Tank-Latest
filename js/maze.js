// ================================================================
// maze.js — random maze generation.
//
// Uses a seeded RNG so online players can build the exact same
// maze from one shared number. The base carve is a recursive
// backtracker (a perfect maze), but we then BRAID it — knocking
// out a share of the remaining interior walls to create many loops
// and open connections, so there's rarely just one path between two
// points. The playable region can also be a non-rectangular SHAPE
// (triangle, trapezoid, hexagon, octagon), carved inside the grid.
// ================================================================

// Small, fast, seedable RNG (mulberry32). Same seed → same maze.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The shapes a maze region can take. "rect" is the full grid; the
// others mask off cells so the playable area forms that silhouette.
export const MAZE_SHAPES = ["rect", "triangle", "trapezoid", "hexagon", "octagon"];

// Build a boolean mask [rows][cols]: true = the cell is INSIDE the
// playable shape. Shapes are inscribed in the cols×rows grid.
function shapeMask(cols, rows, shape) {
  const inside = Array.from({ length: rows }, () => Array(cols).fill(true));
  if (shape === "rect" || !shape) return inside;

  const cx = (cols - 1) / 2;
  const cy = (rows - 1) / 2;

  const set = (test) => {
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) inside[r][c] = test(c, r);
    }
  };

  if (shape === "triangle") {
    // Apex at top-center, base along the bottom row. A cell is in if
    // it's within the widening triangle at its row.
    set((c, r) => {
      const frac = rows <= 1 ? 1 : r / (rows - 1); // 0 at top → 1 at base
      const halfW = (frac * (cols - 1)) / 2;
      return Math.abs(c - cx) <= halfW + 1e-6;
    });
  } else if (shape === "trapezoid") {
    // Narrow top, wide bottom (top width ~45% of the base).
    set((c, r) => {
      const frac = rows <= 1 ? 1 : r / (rows - 1);
      const topHalf = (cols - 1) * 0.22;
      const baseHalf = (cols - 1) / 2;
      const halfW = topHalf + (baseHalf - topHalf) * frac;
      return Math.abs(c - cx) <= halfW + 1e-6;
    });
  } else if (shape === "hexagon") {
    // Flat-top hexagon: full width in the middle band, chamfered
    // corners top and bottom.
    set((c, r) => {
      const dy = Math.abs(r - cy) / (cy || 1);       // 0 center → 1 edge
      const halfW = (cols - 1) / 2;
      // Chamfer starts at 50% height; corners cut to ~50% width.
      const cut = dy <= 0.5 ? 0 : (dy - 0.5) / 0.5 * (halfW * 0.5);
      return Math.abs(c - cx) <= halfW - cut + 1e-6;
    });
  } else if (shape === "octagon") {
    // Rectangle with the four corners chamfered at 45°.
    set((c, r) => {
      const dx = Math.abs(c - cx);
      const dy = Math.abs(r - cy);
      const hw = (cols - 1) / 2;
      const hh = (rows - 1) / 2;
      const cut = Math.min(hw, hh) * 0.5; // corner bite
      // Outside the rect? never (we're within grid). Cut the corners:
      return (dx - (hw - cut)) + (dy - (hh - cut)) <= cut + 1e-6
        || dx <= hw - cut || dy <= hh - cut;
    });
  }

  // Guarantee the mask is connected: keep only the component that
  // contains the center-most inside cell (masks above are convex, so
  // this is just a safety net).
  return keepMainComponent(inside, cols, rows);
}

// Flood-fill from a seed inside the mask; drop any stray islands.
function keepMainComponent(inside, cols, rows) {
  // Find a seed: the inside cell nearest the center.
  let seed = null, bestD = Infinity;
  const cx = (cols - 1) / 2, cy = (rows - 1) / 2;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (!inside[r][c]) continue;
      const d = (c - cx) ** 2 + (r - cy) ** 2;
      if (d < bestD) { bestD = d; seed = [c, r]; }
    }
  }
  if (!seed) return inside;
  const keep = Array.from({ length: rows }, () => Array(cols).fill(false));
  const stack = [seed];
  keep[seed[1]][seed[0]] = true;
  while (stack.length) {
    const [c, r] = stack.pop();
    for (const [nc, nr] of [[c + 1, r], [c - 1, r], [c, r + 1], [c, r - 1]]) {
      if (nc < 0 || nc >= cols || nr < 0 || nr >= rows) continue;
      if (inside[nr][nc] && !keep[nr][nc]) { keep[nr][nc] = true; stack.push([nc, nr]); }
    }
  }
  return keep;
}

// Returns { cols, rows, H, V, inside }:
//   H[r][c] — horizontal wall ABOVE cell (c, r).  (rows+1) × cols
//   V[r][c] — vertical wall LEFT of cell (c, r).  rows × (cols+1)
//   inside[r][c] — whether the cell is part of the playable shape.
//
// opts: { shape, braid }.  braid ∈ [0,1] is the share of leftover
// interior walls to remove (adds loops). shape ∈ MAZE_SHAPES.
export function generateMaze(cols, rows, rng, opts = {}) {
  const shape = opts.shape ?? "rect";
  const braid = opts.braid ?? 0.3;
  const inside = shapeMask(cols, rows, shape);

  const H = Array.from({ length: rows + 1 }, () => Array(cols).fill(true));
  const V = Array.from({ length: rows }, () => Array(cols + 1).fill(true));
  const visited = Array.from({ length: rows }, () => Array(cols).fill(false));

  const isIn = (c, r) => c >= 0 && c < cols && r >= 0 && r < rows && inside[r][c];

  // Start the carve from an inside cell.
  let start = null;
  for (let r = 0; r < rows && !start; r++) {
    for (let c = 0; c < cols && !start; c++) if (inside[r][c]) start = [c, r];
  }
  if (!start) return { cols, rows, H, V, inside };

  const stack = [start];
  visited[start[1]][start[0]] = true;

  while (stack.length) {
    const [c, r] = stack[stack.length - 1];

    const options = [];
    if (isIn(c, r - 1) && !visited[r - 1][c]) options.push([c, r - 1, "N"]);
    if (isIn(c, r + 1) && !visited[r + 1][c]) options.push([c, r + 1, "S"]);
    if (isIn(c - 1, r) && !visited[r][c - 1]) options.push([c - 1, r, "W"]);
    if (isIn(c + 1, r) && !visited[r][c + 1]) options.push([c + 1, r, "E"]);

    if (!options.length) {
      stack.pop(); // dead end — backtrack
      continue;
    }

    const [nc, nr, dir] = options[Math.floor(rng() * options.length)];
    if (dir === "N") H[r][c] = false;
    if (dir === "S") H[r + 1][c] = false;
    if (dir === "W") V[r][c] = false;
    if (dir === "E") V[r][c + 1] = false;

    visited[nr][nc] = true;
    stack.push([nc, nr]);
  }

  // ---- BRAID: open extra connections so there are many paths ----
  // Collect every interior wall between two inside cells that is still
  // standing, then knock out a `braid` share of them at random. This
  // turns the perfect maze into a loopy, well-connected arena.
  const candidates = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (!inside[r][c]) continue;
      // wall to the EAST (V between (c,r) and (c+1,r))
      if (isIn(c + 1, r) && V[r][c + 1]) candidates.push(["V", r, c + 1]);
      // wall to the SOUTH (H between (c,r) and (c,r+1))
      if (isIn(c, r + 1) && H[r + 1][c]) candidates.push(["H", r + 1, c]);
    }
  }
  // Fisher–Yates shuffle with the seeded rng, then remove the first share.
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }
  const removeN = Math.floor(candidates.length * braid);
  for (let i = 0; i < removeN; i++) {
    const [kind, a, b] = candidates[i];
    if (kind === "V") V[a][b] = false;
    else H[a][b] = false;
  }

  // ---- Seal the shape's border ----
  // Any wall on the boundary between an inside cell and an outside
  // cell (or the grid edge) must stand, so tanks can't leave the shape.
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (!inside[r][c]) continue;
      if (!isIn(c, r - 1)) H[r][c] = true;         // top edge
      if (!isIn(c, r + 1)) H[r + 1][c] = true;     // bottom edge
      if (!isIn(c - 1, r)) V[r][c] = true;         // left edge
      if (!isIn(c + 1, r)) V[r][c + 1] = true;     // right edge
    }
  }

  return { cols, rows, H, V, inside };
}

// For a shrinking "zone", we need to know how many layers deep each
// inside cell sits from the shape's boundary. Layer 0 = the outermost
// ring of inside cells (touching the edge or a masked-off cell); layer
// 1 = the next ring in; and so on. Returns dist[r][c] (Infinity for
// cells outside the shape) plus the maximum layer present.
export function ringDistance(maze) {
  const { cols, rows, inside } = maze;
  const dist = Array.from({ length: rows }, () => Array(cols).fill(Infinity));
  const isIn = (c, r) => c >= 0 && c < cols && r >= 0 && r < rows && inside[r][c];

  // Multi-source BFS from every boundary inside-cell (an inside cell
  // adjacent to the grid edge or a masked-off cell).
  const queue = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (!inside[r][c]) continue;
      const boundary =
        !isIn(c - 1, r) || !isIn(c + 1, r) || !isIn(c, r - 1) || !isIn(c, r + 1);
      if (boundary) { dist[r][c] = 0; queue.push([c, r]); }
    }
  }
  let head = 0, maxLayer = 0;
  while (head < queue.length) {
    const [c, r] = queue[head++];
    const d = dist[r][c];
    maxLayer = Math.max(maxLayer, d);
    for (const [nc, nr] of [[c + 1, r], [c - 1, r], [c, r + 1], [c, r - 1]]) {
      if (isIn(nc, nr) && dist[nr][nc] > d + 1) {
        dist[nr][nc] = d + 1;
        queue.push([nc, nr]);
      }
    }
  }
  return { dist, maxLayer };
}
// used for both collision and drawing. `cell` = cell size,
// `t` = wall thickness. Rects overlap at joints, which is fine.
// Walls entirely outside the playable shape are skipped, so a shaped
// maze draws only its own silhouette (not the full grid block).
export function wallRects(maze, cell, t) {
  const rects = [];
  const half = t / 2;
  const inside = maze.inside;
  const isIn = (c, r) =>
    !inside || (r >= 0 && r < maze.rows && c >= 0 && c < maze.cols && inside[r][c]);

  for (let r = 0; r <= maze.rows; r++) {
    for (let c = 0; c < maze.cols; c++) {
      // A horizontal wall (above row r) is relevant if either the cell
      // above or below it is inside the shape.
      if (maze.H[r][c] && (isIn(c, r) || isIn(c, r - 1))) {
        rects.push({ x: c * cell - half, y: r * cell - half, w: cell + t, h: t });
      }
    }
  }
  for (let r = 0; r < maze.rows; r++) {
    for (let c = 0; c <= maze.cols; c++) {
      // A vertical wall (left of col c) is relevant if either the cell
      // left or right of it is inside the shape.
      if (maze.V[r][c] && (isIn(c, r) || isIn(c - 1, r))) {
        rects.push({ x: c * cell - half, y: r * cell - half, w: t, h: cell + t });
      }
    }
  }
  return rects;
}

/* ---------- segment ↔ rectangle geometry (Liang–Barsky) ---------- */

// Entry parameter t (0..1) where the segment first enters the rect,
// or null if it misses entirely.
function segEntryT(x1, y1, x2, y2, r) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  let t0 = 0;
  let t1 = 1;
  const p = [-dx, dx, -dy, dy];
  const q = [x1 - r.x, r.x + r.w - x1, y1 - r.y, r.y + r.h - y1];

  for (let i = 0; i < 4; i++) {
    if (Math.abs(p[i]) < 1e-9) {
      if (q[i] < 0) return null; // parallel and outside
      continue;
    }
    const t = q[i] / p[i];
    if (p[i] < 0) {
      if (t > t1) return null;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return null;
      if (t < t1) t1 = t;
    }
  }
  return t0;
}

// Does the segment touch any wall? (used for AI line-of-sight)
export function segmentHitsAnyRect(x1, y1, x2, y2, rects) {
  for (const r of rects) {
    if (segEntryT(x1, y1, x2, y2, r) !== null) return true;
  }
  return false;
}

// Smallest entry t across all rects, or 1 if the path is clear.
export function segmentFirstHit(x1, y1, x2, y2, rects) {
  let best = 1;
  for (const r of rects) {
    const t = segEntryT(x1, y1, x2, y2, r);
    if (t !== null && t < best) best = t;
  }
  return best;
}
