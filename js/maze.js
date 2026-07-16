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
// others are real polygons (with diagonal edges) inscribed in the
// grid. A cell is "inside" when its CENTRE falls in the polygon, so
// cells straddling a diagonal edge are simply cut short — the angled
// boundary wall runs through them.
export const MAZE_SHAPES = ["rect", "triangle", "trapezoid", "hexagon", "octagon"];

// Each silhouette as a convex polygon in fractional coords (0..1 across
// the world box, y pointing down). Convex matters: any segment between
// two interior points stays interior, so nothing (AI sight lines,
// pathing) has to reason about the angled border.
const OCT_CUT = 0.29;
export const SHAPE_POLYS = {
  triangle: [[0.5, 0], [1, 1], [0, 1]],
  trapezoid: [[0.28, 0], [0.72, 0], [1, 1], [0, 1]],
  hexagon: [[0.25, 0], [0.75, 0], [1, 0.5], [0.75, 1], [0.25, 1], [0, 0.5]],
  octagon: [
    [OCT_CUT, 0], [1 - OCT_CUT, 0], [1, OCT_CUT], [1, 1 - OCT_CUT],
    [1 - OCT_CUT, 1], [OCT_CUT, 1], [0, 1 - OCT_CUT], [0, OCT_CUT],
  ],
};

// Standard even-odd point-in-polygon test (poly in fractional coords).
function pointInPoly(px, py, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if ((yi > py) !== (yj > py) &&
        px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

// Build a boolean mask [rows][cols]: true = the cell's centre is INSIDE
// the shape polygon. "rect" (or unknown) fills the whole grid.
function shapeMask(cols, rows, shape) {
  const inside = Array.from({ length: rows }, () => Array(cols).fill(true));
  const poly = SHAPE_POLYS[shape];
  if (!poly) return inside; // rect / unknown → full grid

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      inside[r][c] = pointInPoly((c + 0.5) / cols, (r + 0.5) / rows, poly);
    }
  }
  // Trim one-cell nubs: a cell with a single playable neighbour is a
  // spike off the silhouette (a triangle's apex, say). It can only ever
  // be a dead end no matter how the maze is carved, and if a tank spawns
  // beside one it eats half that tank's exits — so the shape sheds them
  // before anything is carved. Capped at a few passes, and it never
  // erodes a small arena away.
  for (let pass = 0; pass < 3; pass++) {
    const doomed = [];
    let live = 0;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (!inside[r][c]) continue;
        live++;
        const n =
          (r > 0 && inside[r - 1][c] ? 1 : 0) +
          (r < rows - 1 && inside[r + 1][c] ? 1 : 0) +
          (c > 0 && inside[r][c - 1] ? 1 : 0) +
          (c < cols - 1 && inside[r][c + 1] ? 1 : 0);
        if (n < 2) doomed.push([c, r]);
      }
    }
    if (!doomed.length || live - doomed.length < 12) break;
    for (const [c, r] of doomed) inside[r][c] = false;
  }
  // Convex shapes are always connected; this is just a safety net.
  return keepMainComponent(inside, cols, rows);
}

// The shape polygon in WORLD coordinates (or null for rect), so callers
// can draw the silhouette and build its boundary walls.
export function shapePolygon(maze, cell) {
  const poly = SHAPE_POLYS[maze.shape];
  if (!poly) return null;
  const W = maze.cols * cell, H = maze.rows * cell;
  return poly.map(([fx, fy]) => [fx * W, fy * H]);
}

// The shape's diagonal/edge boundary as oriented wall slabs
// { x, y, a, hx, hy } — the same shape the brick-wall collision already
// understands. Each polygon edge becomes one slab, over-extended at its
// ends by the wall thickness so neighbouring slabs overlap at every
// vertex (no gaps for tanks or bullets to slip through). Empty for rect.
export function boundaryWalls(maze, cell, t) {
  const pts = shapePolygon(maze, cell);
  if (!pts) return [];
  const half = t / 2;
  const walls = [];
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % pts.length];
    const dx = x2 - x1, dy = y2 - y1;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) continue;
    walls.push({
      x: (x1 + x2) / 2,
      y: (y1 + y2) / 2,
      a: Math.atan2(dy, dx),
      hx: len / 2 + t,   // overlap corners
      hy: half,
    });
  }
  return walls;
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
  if (!start) return { cols, rows, H, V, inside, shape };

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

  const maze = { cols, rows, H, V, inside, shape };

  // ---- DE-BRAID THE TRAPS: every cell gets at least two exits ----
  // Random braiding sprinkles loops around the middle but leaves plenty
  // of one-way pockets. Giving every dead end a second opening removes
  // every trap and puts every cell on a loop.
  killDeadEnds(maze, rng);

  // ---- GUARANTEE MULTIPLE ROUTES BETWEEN SPAWNS ----
  // The point of the arena is flanking, so a single choke corridor
  // between two players is a bug, not a maze. Widen the tightest cut
  // between every pair of spawn corners until at least `minRoutes`
  // fully independent paths exist.
  ensureRoutes(maze, rng, opts.minRoutes ?? 2);

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

  return { cols, rows, H, V, inside, shape };
}


/* ================================================================
   Connectivity — making the arena playable, not just solvable
   ================================================================
   A textbook "perfect" maze has exactly ONE path between any two
   cells, which for a shooter means no flanking, no escape, and a
   single corridor both players are forced down. These two passes fix
   that: every cell gets a second exit (no traps), and the tightest
   cut between spawn corners is widened until several genuinely
   independent routes exist.
   ================================================================ */

// How many open sides a cell has.
function cellDegree(m, c, r) {
  const inB = (cc, rr) =>
    cc >= 0 && cc < m.cols && rr >= 0 && rr < m.rows && (!m.inside || m.inside[rr][cc]);
  let d = 0;
  if (inB(c, r - 1) && !m.H[r][c]) d++;
  if (inB(c, r + 1) && !m.H[r + 1][c]) d++;
  if (inB(c - 1, r) && !m.V[r][c]) d++;
  if (inB(c + 1, r) && !m.V[r][c + 1]) d++;
  return d;
}

// Classic braiding: every dead end gets a second opening, so no cell
// is a one-way pocket and every cell sits on a loop.
function killDeadEnds(m, rng) {
  const inB = (c, r) =>
    c >= 0 && c < m.cols && r >= 0 && r < m.rows && (!m.inside || m.inside[r][c]);
  for (let pass = 0; pass < 4; pass++) {
    let changed = false;
    for (let r = 0; r < m.rows; r++) {
      for (let c = 0; c < m.cols; c++) {
        if (!inB(c, r) || cellDegree(m, c, r) !== 1) continue;
        const opts = [];
        if (inB(c, r - 1) && m.H[r][c]) opts.push(() => { m.H[r][c] = false; });
        if (inB(c, r + 1) && m.H[r + 1][c]) opts.push(() => { m.H[r + 1][c] = false; });
        if (inB(c - 1, r) && m.V[r][c]) opts.push(() => { m.V[r][c] = false; });
        if (inB(c + 1, r) && m.V[r][c + 1]) opts.push(() => { m.V[r][c + 1] = false; });
        if (opts.length) { opts[Math.floor(rng() * opts.length)](); changed = true; }
      }
    }
    if (!changed) break;
  }
}

// The cells tanks spawn in: the four grid corners, each snapped to the
// nearest playable cell — but never onto a one-neighbour spike (the
// apex of a triangle, say). A tank parked in a spike has a single way
// out no matter how the maze is carved, so we step in to the nearest
// cell with real room. game.js places tanks with this same function,
// so spawns and the connectivity guarantee always agree.
export function snapSpawn(m, c0, r0) {
  const inB = (c, r) =>
    c >= 0 && c < m.cols && r >= 0 && r < m.rows && (!m.inside || m.inside[r][c]);
  // How many playable neighbours a cell has, walls ignored — the
  // shape's own ceiling on how many exits that cell could ever get.
  const room = (c, r) =>
    (inB(c, r - 1) ? 1 : 0) + (inB(c, r + 1) ? 1 : 0) +
    (inB(c - 1, r) ? 1 : 0) + (inB(c + 1, r) ? 1 : 0);
  let best = null, bestD = Infinity;
  for (let r = 0; r < m.rows; r++) {
    for (let c = 0; c < m.cols; c++) {
      if (!inB(c, r) || room(c, r) < 2) continue;
      const d = (c - c0) ** 2 + (r - r0) ** 2;
      if (d < bestD) { bestD = d; best = [c, r]; }
    }
  }
  if (best) return best;
  // Degenerate shape — fall back to any playable cell at all.
  for (let r = 0; r < m.rows; r++) {
    for (let c = 0; c < m.cols; c++) if (inB(c, r)) return [c, r];
  }
  return [0, 0];
}

// The cells tanks spawn in: the four grid corners, each snapped inward
// to the nearest cell with real room. game.js places tanks with the
// same snapSpawn, so spawns and the connectivity guarantee below can
// never drift apart.
export function spawnCells(m) {
  const raw = [[0, 0], [m.cols - 1, m.rows - 1], [m.cols - 1, 0], [0, m.rows - 1]];
  const out = [];
  for (const [c, r] of raw) {
    const s = snapSpawn(m, c, r);
    if (s && !out.some(([oc, or]) => oc === s[0] && or === s[1])) out.push(s);
  }
  return out;
}

// Edge-disjoint paths between two cells (max-flow, unit capacities).
// Returns { flow, reach } where `reach` is the source side of the
// min-cut — the walls out of that set are exactly what's choking it.
function maxFlow(m, src, snk) {
  const inB = (c, r) =>
    c >= 0 && c < m.cols && r >= 0 && r < m.rows && (!m.inside || m.inside[r][c]);
  const id = (c, r) => r * m.cols + c;
  const cap = new Map();
  const adj = new Map();
  const addEdge = (a, b) => {
    cap.set(a + "," + b, (cap.get(a + "," + b) ?? 0) + 1);
    cap.set(b + "," + a, (cap.get(b + "," + a) ?? 0) + 1);
    if (!adj.has(a)) adj.set(a, new Set());
    if (!adj.has(b)) adj.set(b, new Set());
    adj.get(a).add(b);
    adj.get(b).add(a);
  };
  for (let r = 0; r < m.rows; r++) {
    for (let c = 0; c < m.cols; c++) {
      if (!inB(c, r)) continue;
      if (inB(c + 1, r) && !m.V[r][c + 1]) addEdge(id(c, r), id(c + 1, r));
      if (inB(c, r + 1) && !m.H[r + 1][c]) addEdge(id(c, r), id(c, r + 1));
    }
  }
  const S = id(src[0], src[1]);
  const T = id(snk[0], snk[1]);
  let flow = 0;
  let reach = new Set([S]);
  for (let guard = 0; guard < 64; guard++) {
    // BFS along edges with spare capacity.
    const prev = new Map([[S, -1]]);
    const q = [S];
    let hit = false;
    for (let qi = 0; qi < q.length; qi++) {
      const u = q[qi];
      if (u === T) { hit = true; break; }
      for (const v of (adj.get(u) ?? [])) {
        if (!prev.has(v) && (cap.get(u + "," + v) ?? 0) > 0) { prev.set(v, u); q.push(v); }
      }
    }
    reach = new Set(prev.keys());
    if (!hit) break;
    const path = [];
    for (let v = T; v !== -1; v = prev.get(v)) path.push(v);
    path.reverse();
    let bn = Infinity;
    for (let i = 0; i < path.length - 1; i++) {
      bn = Math.min(bn, cap.get(path[i] + "," + path[i + 1]) ?? 0);
    }
    for (let i = 0; i < path.length - 1; i++) {
      const a = path[i] + "," + path[i + 1];
      const b = path[i + 1] + "," + path[i];
      cap.set(a, cap.get(a) - bn);
      cap.set(b, (cap.get(b) ?? 0) + bn);
    }
    flow += bn;
  }
  return { flow, reach };
}

// Widen the tightest cut between every pair of spawn corners until at
// least `target` independent routes connect them. Each pass finds the
// min-cut and knocks out a standing wall that spans it, which is
// guaranteed to open a genuinely NEW route (not a parallel copy of an
// existing one). A corner cell only has two neighbours, so two routes
// is the ceiling from a corner — but two is the difference between
// "one forced corridor" and "you can flank".
function ensureRoutes(m, rng, target) {
  if (target < 2) return;
  const inB = (c, r) =>
    c >= 0 && c < m.cols && r >= 0 && r < m.rows && (!m.inside || m.inside[r][c]);
  const id = (c, r) => r * m.cols + c;
  const spawns = spawnCells(m);

  for (let i = 0; i < spawns.length; i++) {
    for (let j = i + 1; j < spawns.length; j++) {
      for (let guard = 0; guard < 24; guard++) {
        const { flow, reach } = maxFlow(m, spawns[i], spawns[j]);
        if (flow >= target) break;
        // Every standing wall from the cut's source side to its sink
        // side; removing any one raises the cut by exactly 1.
        const spans = [];
        for (let r = 0; r < m.rows; r++) {
          for (let c = 0; c < m.cols; c++) {
            if (!inB(c, r) || !reach.has(id(c, r))) continue;
            if (inB(c + 1, r) && m.V[r][c + 1] && !reach.has(id(c + 1, r))) spans.push(["V", r, c + 1]);
            if (inB(c, r + 1) && m.H[r + 1][c] && !reach.has(id(c, r + 1))) spans.push(["H", r + 1, c]);
            if (inB(c - 1, r) && m.V[r][c] && !reach.has(id(c - 1, r))) spans.push(["V", r, c]);
            if (inB(c, r - 1) && m.H[r][c] && !reach.has(id(c, r - 1))) spans.push(["H", r, c]);
          }
        }
        if (!spans.length) break; // geometrically impossible — leave it
        const [kind, a, b] = spans[Math.floor(rng() * spans.length)];
        if (kind === "V") m.V[a][b] = false;
        else m.H[a][b] = false;
      }
    }
  }
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
  // Shaped mazes get their border from the polygon boundary walls, so
  // here we emit only walls BETWEEN two inside cells (interior maze).
  // Rect mazes emit every standing wall that borders an inside cell —
  // which includes the grid's outer edge, i.e. the arena wall.
  const shaped = !!SHAPE_POLYS[maze.shape];
  const isIn = (c, r) =>
    !inside || (r >= 0 && r < maze.rows && c >= 0 && c < maze.cols && inside[r][c]);
  const keep = (a, b) => (shaped ? a && b : a || b);

  for (let r = 0; r <= maze.rows; r++) {
    for (let c = 0; c < maze.cols; c++) {
      // A horizontal wall (above row r) separates cell (c, r) and (c, r-1).
      if (maze.H[r][c] && keep(isIn(c, r), isIn(c, r - 1))) {
        rects.push({ x: c * cell - half, y: r * cell - half, w: cell + t, h: t });
      }
    }
  }
  for (let r = 0; r < maze.rows; r++) {
    for (let c = 0; c <= maze.cols; c++) {
      // A vertical wall (left of col c) separates cell (c, r) and (c-1, r).
      if (maze.V[r][c] && keep(isIn(c, r), isIn(c - 1, r))) {
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
