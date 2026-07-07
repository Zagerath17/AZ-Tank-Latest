// ================================================================
// maze.js — random maze generation.
//
// Uses a seeded RNG so online players can build the exact same
// maze from one shared number. The generator is a recursive
// backtracker, which produces a *perfect* maze: every cell is
// reachable and there is exactly ONE path between any two cells —
// i.e. no closed loops anywhere, guaranteed by construction.
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

// Returns { cols, rows, H, V }:
//   H[r][c] — horizontal wall ABOVE cell (c, r).  (rows+1) × cols
//   V[r][c] — vertical wall LEFT of cell (c, r).  rows × (cols+1)
export function generateMaze(cols, rows, rng) {
  const H = Array.from({ length: rows + 1 }, () => Array(cols).fill(true));
  const V = Array.from({ length: rows }, () => Array(cols + 1).fill(true));
  const visited = Array.from({ length: rows }, () => Array(cols).fill(false));

  // Iterative depth-first carve, starting from a random cell.
  const stack = [[Math.floor(rng() * cols), Math.floor(rng() * rows)]];
  visited[stack[0][1]][stack[0][0]] = true;

  while (stack.length) {
    const [c, r] = stack[stack.length - 1];

    const options = [];
    if (r > 0 && !visited[r - 1][c]) options.push([c, r - 1, "N"]);
    if (r < rows - 1 && !visited[r + 1][c]) options.push([c, r + 1, "S"]);
    if (c > 0 && !visited[r][c - 1]) options.push([c - 1, r, "W"]);
    if (c < cols - 1 && !visited[r][c + 1]) options.push([c + 1, r, "E"]);

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

  return { cols, rows, H, V };
}

// Turns the wall grid into axis-aligned rectangles (world units)
// used for both collision and drawing. `cell` = cell size,
// `t` = wall thickness. Rects overlap at joints, which is fine.
export function wallRects(maze, cell, t) {
  const rects = [];
  const half = t / 2;

  for (let r = 0; r <= maze.rows; r++) {
    for (let c = 0; c < maze.cols; c++) {
      if (maze.H[r][c]) {
        rects.push({ x: c * cell - half, y: r * cell - half, w: cell + t, h: t });
      }
    }
  }
  for (let r = 0; r < maze.rows; r++) {
    for (let c = 0; c <= maze.cols; c++) {
      if (maze.V[r][c]) {
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
