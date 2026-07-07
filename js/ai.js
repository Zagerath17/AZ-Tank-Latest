// ================================================================
// ai.js — bot drivers with 3 difficulty levels.
//
// A bot outputs the SAME actions a human does ({up, down, left,
// right, shoot}), so it goes through identical movement, wall
// hard-stop, and shooting code — no cheating physics.
//
// Behavior: pick the nearest living enemy, BFS a path through the
// maze (the maze is loop-free, so the path is unique), drive along
// it, and fire when there's line of sight and the aim is good
// enough for its skill level. Reverses out when stuck on a wall.
// ================================================================

import { segmentHitsAnyRect } from "./maze.js";

export const AI_PARAMS = {
  //        speed  turn  repath aimTol range cooldn fireProb
  easy:   { speed: 0.70, turn: 0.78, repath: 1.30, aimTol: 0.30, range: 4.5, cooldown: 2.2, fireProb: 0.55 },
  medium: { speed: 0.85, turn: 0.92, repath: 0.85, aimTol: 0.16, range: 7.0, cooldown: 1.3, fireProb: 0.85 },
  hard:   { speed: 1.00, turn: 1.08, repath: 0.50, aimTol: 0.08, range: 12,  cooldown: 0.75, fireProb: 1.0 },
};

export const AI_LEVELS = ["easy", "medium", "hard"];

// Escape maneuvers tried in order when the tank is jammed. With
// rectangular hitboxes a wedged tank may have only ONE free action
// (e.g. rotating the other way), so we cycle until something works.
const ESCAPES = [
  { down: true, left: true },
  { down: true, right: true },
  { up: true, right: true },
  { up: true, left: true },
  { down: true },
];

// world = { cell, maze, rects, tanks }, now in ms, dt in seconds.
export function botActions(t, world, dt, now) {
  const P = AI_PARAMS[t.bot];
  const ai = (t.ai ??= {
    path: [],
    tgKey: "",
    repathAt: 0,
    lastX: t.x,
    lastY: t.y,
    lastA: t.a,
    stuckT: 0,
    revUntil: 0,
    escMode: 0,
    jamX: t.x,
    jamY: t.y,
    wantedFwd: false,
    wantedTurn: false,
    fireAt: now + 600 + Math.random() * 1200, // don't all open fire at once
  });

  const acts = { up: false, down: false, left: false, right: false, shoot: false };

  // Nearest living enemy.
  let target = null;
  let best = Infinity;
  for (const o of world.tanks) {
    if (o === t || o.dead || o.gone) continue;
    const d = (o.x - t.x) ** 2 + (o.y - t.y) ** 2;
    if (d < best) { best = d; target = o; }
  }
  if (!target) return acts;

  const cell = world.cell;
  const dist = Math.sqrt(best);

  // Mid-escape: run the current escape maneuver.
  if (now < ai.revUntil) {
    const esc = ESCAPES[ai.escMode % ESCAPES.length];
    if (esc.up) acts.up = true;
    if (esc.down) acts.down = true;
    if (esc.left) acts.left = true;
    if (esc.right) acts.right = true;
    return acts;
  }

  // Stuck detection: wanted to move (or turn — rectangular hitboxes
  // can have their rotation blocked by walls) but barely did.
  const movedSq = (t.x - ai.lastX) ** 2 + (t.y - ai.lastY) ** 2;
  const turned = Math.abs(angleDiff(ai.lastA, t.a));
  ai.lastX = t.x;
  ai.lastY = t.y;
  ai.lastA = t.a;
  const moveStuck = ai.wantedFwd && movedSq < (dt * cell * 0.25) ** 2;
  const turnStuck = ai.wantedTurn && turned < dt * 0.4;
  if (moveStuck || turnStuck) ai.stuckT += dt;
  else ai.stuckT = 0;
  if (ai.stuckT > 0.55) {
    ai.stuckT = 0;
    // Same spot as last jam → try the NEXT pattern; new jam → random
    // pattern + jittered duration, so repeated approaches to a nasty
    // corner never replay the exact same doomed maneuver (livelock).
    const progressed = (t.x - ai.jamX) ** 2 + (t.y - ai.jamY) ** 2 > (cell * 0.5) ** 2;
    ai.escMode = progressed ? Math.floor(Math.random() * ESCAPES.length) : ai.escMode + 1;
    ai.jamX = t.x;
    ai.jamY = t.y;
    ai.revUntil = now + 350 + Math.random() * 350;
    ai.repathAt = 0; // force a fresh path after escaping
  }

  // Attack mode when we can actually see the target.
  const los =
    dist < P.range * cell &&
    !segmentHitsAnyRect(t.x, t.y, target.x, target.y, world.rects);

  // Steering. Hard-stop wall physics punishes corner-cutting, so a
  // leg is only driven directly if the tank BODY fits along it;
  // otherwise re-center in the current cell before turning.
  const rBody = (world.tankR ?? cell * 0.27) * 1.06;
  const myCell = { c: clampCell(t.x / cell, world.maze.cols), r: clampCell(t.y / cell, world.maze.rows) };

  let aimX;
  let aimY;
  if (los && corridorClear(t.x, t.y, target.x, target.y, world.rects, rBody)) {
    aimX = target.x;
    aimY = target.y;
  } else {
    const tgCell = { c: clampCell(target.x / cell, world.maze.cols), r: clampCell(target.y / cell, world.maze.rows) };
    const tgKey = tgCell.c + "," + tgCell.r;

    if (now > ai.repathAt || !ai.path.length || ai.tgKey !== tgKey) {
      ai.path = bfsPath(world.maze, myCell, tgCell);
      ai.tgKey = tgKey;
      ai.repathAt = now + P.repath * 1000;
    }

    // Drop waypoints we've reached. The radius is adaptive: sharp
    // turns ahead demand being nearly centered first (a rotating
    // rectangle needs the clearance of the cell center), while
    // straightaways can be driven loosely.
    while (ai.path.length) {
      const w = ai.path[0];
      const next = ai.path[1];
      let popR = cell * 0.34;
      if (next) {
        const ac = w.c - myCell.c;
        const ar = w.r - myCell.r;
        const bc = next.c - w.c;
        const br = next.r - w.r;
        if (ac * bc + ar * br <= 0) popR = cell * 0.14; // corner coming up
      }
      const wx = (w.c + 0.5) * cell;
      const wy = (w.r + 0.5) * cell;
      if ((wx - t.x) ** 2 + (wy - t.y) ** 2 < popR * popR) ai.path.shift();
      else break;
    }

    const w = ai.path[0];
    if (w) {
      const wx = (w.c + 0.5) * cell;
      const wy = (w.r + 0.5) * cell;
      const ccx = (myCell.c + 0.5) * cell;
      const ccy = (myCell.r + 0.5) * cell;
      const centered = (ccx - t.x) ** 2 + (ccy - t.y) ** 2 < (cell * 0.08) ** 2;
      if (centered || corridorClear(t.x, t.y, wx, wy, world.rects, rBody)) {
        aimX = wx;
        aimY = wy;
      } else {
        aimX = ccx; // line up in the middle of the corridor first
        aimY = ccy;
      }
    } else {
      aimX = target.x;
      aimY = target.y;
    }
  }

  // Steer toward the aim point.
  const want = Math.atan2(aimY - t.y, aimX - t.x);
  const err = angleDiff(t.a, want);
  if (err > 0.06) acts.right = true;
  else if (err < -0.06) acts.left = true;
  ai.wantedTurn = acts.left || acts.right;

  // Drive forward when roughly aligned; don't crowd a visible target.
  const fwd = Math.abs(err) < 0.7 && (los ? dist > cell * 1.1 : true);
  if (fwd) acts.up = true;
  ai.wantedFwd = fwd;

  // Fire: needs line of sight, a good-enough angle for this skill
  // level, and an elapsed cooldown. Easier bots also just... miss
  // their chance sometimes (fireProb).
  if (los && Math.abs(err) < P.aimTol && now >= ai.fireAt) {
    ai.fireAt = now + P.cooldown * 1000 * (0.75 + Math.random() * 0.5);
    if (Math.random() < P.fireProb) acts.shoot = true;
  }

  return acts;
}

/* ---------- helpers ---------- */

function clampCell(v, max) {
  return Math.min(max - 1, Math.max(0, Math.floor(v)));
}

// Can a circle of radius r travel the segment without touching a wall?
function corridorClear(x1, y1, x2, y2, rects, r) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const d = Math.hypot(dx, dy);
  const steps = Math.max(1, Math.ceil(d / (r * 0.5)));
  for (let i = 1; i <= steps; i++) {
    const x = x1 + (dx * i) / steps;
    const y = y1 + (dy * i) / steps;
    for (const rc of rects) {
      const cx = Math.min(rc.x + rc.w, Math.max(rc.x, x));
      const cy = Math.min(rc.y + rc.h, Math.max(rc.y, y));
      const ox = x - cx;
      const oy = y - cy;
      if (ox * ox + oy * oy < r * r) return false;
    }
  }
  return true;
}

function angleDiff(from, to) {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

// Breadth-first search through the maze's open walls. The maze is a
// perfect maze, so this returns THE path (there's only one).
function bfsPath(maze, from, to) {
  const key = (c, r) => r * maze.cols + c;
  const prev = new Map([[key(from.c, from.r), -1]]);
  const queue = [[from.c, from.r]];
  let qi = 0;

  while (qi < queue.length) {
    const [c, r] = queue[qi++];
    if (c === to.c && r === to.r) break;

    const steps = [];
    if (!maze.H[r][c]) steps.push([c, r - 1]);
    if (!maze.H[r + 1][c]) steps.push([c, r + 1]);
    if (!maze.V[r][c]) steps.push([c - 1, r]);
    if (!maze.V[r][c + 1]) steps.push([c + 1, r]);

    for (const [nc, nr] of steps) {
      const k = key(nc, nr);
      if (!prev.has(k)) {
        prev.set(k, key(c, r));
        queue.push([nc, nr]);
      }
    }
  }

  const path = [];
  let k = key(to.c, to.r);
  if (!prev.has(k)) return path; // unreachable — shouldn't happen in a perfect maze
  while (k !== -1) {
    path.push({ c: k % maze.cols, r: Math.floor(k / maze.cols) });
    k = prev.get(k);
  }
  path.reverse();
  return path;
}
