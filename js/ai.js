// ================================================================
// ai.js — tank AI.
//
// Built the way a game AI normally is, as four separate stages that each
// do one job and hand on to the next:
//
//   SENSE    build a BELIEF about the world. Never reads the live state
//            directly for decisions — everything arrives late, by an
//            amount set by the tier, so nothing is ever reacted to
//            instantly.
//   PLAN     pick a behaviour by utility, then COMMIT to it for a
//            minimum time. Re-deciding every frame is what makes bots
//            twitch and dither.
//   NAVIGATE context steering. Every direction is scored for openness,
//            for how well it serves the goal, and for how much danger
//            lies that way; the best is chosen and eased into. There is
//            always at least one legal direction, so a bot can never
//            argue itself into standing still against a wall.
//   ACT      gunnery and abilities, each with its own discipline.
//
// The one hard constraint that shapes all of this: the turret is welded
// to the hull. Facing IS the direction of travel, so a tank cannot aim
// one way and strafe another. Driving backwards keeps the nose on the
// target (the game reverses when the stick points behind), which is the
// only way to move while keeping a shot lined up. Everything in POSTURE
// below exists to resolve that conflict deliberately, instead of
// flip-flopping between advancing and retreating.
// ================================================================

import { FLAME, MORTAR, SNIPER, ROCKET, MG } from "./weapons.js";

export const AI_LEVELS = ["easy", "medium", "hard", "impossible"];

// `speed` and `turn` multiply the HUMAN rates and never exceed 1 — a bot
// is never physically faster than a player, only better informed and
// better at choosing. Everything else is judgement.
export const AI_PARAMS = {
  easy: {
    speed: 0.84, turn: 0.90,
    react: 0.46,       // s before a new stimulus can be acted on
    lag: 0.30,         // s its picture of a moving target trails reality
    plan: 420,         // ms between behaviour decisions
    commit: 900,       // ms it sticks with a behaviour once chosen
    aimErr: 0.13,      // rad of standing aim error
    aimTol: 0.20,      // rad it must be within before pulling the trigger
    settle: 0.34,      // s on a new target before it may fire
    lead: 0.25,        // fraction of the intercept solution it applies
    dodge: 0.30,       // how well it evades
    look: 0.55,        // s of threat lookahead
    sight: 6.5,        // cells
    fireRange: 4.5,    // cells
    ability: 0.30,     // ability judgement
    aggression: 0.45,
    standoff: 2.0,     // cells it likes to fight at
  },
  medium: {
    speed: 0.94, turn: 1.0,
    react: 0.30, lag: 0.18, plan: 320, commit: 700,
    aimErr: 0.055, aimTol: 0.14, settle: 0.20, lead: 0.55,
    dodge: 0.60, look: 0.85, sight: 9, fireRange: 5.5,
    ability: 0.60, aggression: 0.60, standoff: 2.2,
  },
  hard: {
    speed: 1.0, turn: 1.0,
    react: 0.20, lag: 0.10, plan: 240, commit: 520,
    aimErr: 0.018, aimTol: 0.10, settle: 0.12, lead: 0.85,
    dodge: 0.85, look: 1.15, sight: 12, fireRange: 6.5,
    ability: 0.85, aggression: 0.75, standoff: 2.3,
  },
  impossible: {
    speed: 1.0, turn: 1.0,
    react: 0.13, lag: 0.05, plan: 180, commit: 380,
    aimErr: 0.005, aimTol: 0.08, settle: 0.06, lead: 1.0,
    dodge: 1.0, look: 1.5, sight: 99, fireRange: 7.5,
    ability: 1.0, aggression: 0.9, standoff: 2.3,
  },
};

// What each weapon actually is, so a bot can play it rather than just
// pull the trigger. `hold` means a continuous trigger; `indirect` skips
// the line-of-sight test because the shot arcs over walls.
const GUNS = {
  normal: { hold: false, indirect: false, minCells: 0,   bestCells: 2.4, maxCells: 7,   burst: false },
  mg:     { hold: true,  indirect: false, minCells: 0,   bestCells: 2.0, maxCells: 5,   burst: true  },
  laser:  { hold: false, indirect: false, minCells: 0,   bestCells: 3.0, maxCells: 8,   burst: false },
  sniper: { hold: false, indirect: false, minCells: 1.5, bestCells: 4.0, maxCells: SNIPER.rangeCells, burst: false },
  rocket: { hold: false, indirect: false, minCells: 1.0, bestCells: 3.2, maxCells: 7,   burst: false },
  cannon: { hold: false, indirect: false, minCells: 1.2, bestCells: 2.8, maxCells: 6,   burst: false },
  mortar: { hold: false, indirect: true,  minCells: MORTAR.minHalfCells * 0.5, bestCells: 3.0, maxCells: MORTAR.rangeCells, burst: false },
  flame:  { hold: true,  indirect: false, minCells: 0,   bestCells: 0.6, maxCells: FLAME.reachCells, burst: true },
};
const gunOf = (w) => GUNS[w] || GUNS.normal;

const DIRS = 24;                     // compass resolution for steering
const RAY = [];
for (let i = 0; i < DIRS; i++) {
  const a = (i / DIRS) * Math.PI * 2;
  RAY.push({ a, cx: Math.cos(a), cy: Math.sin(a) });
}

/* ================================================================
   Entry point
   ================================================================ */

export function botActions(t, world, dt, now) {
  const P = AI_PARAMS[t.bot] ?? AI_PARAMS.medium;
  const B = brain(t, now);
  const acts = {
    up: false, down: false, left: false, right: false,
    shoot: false, def: false, agi: false,
    moveAngle: null, moveMag: 0,
  };
  if (t.dead || t.gone) return acts;

  sense(t, B, world, P, now);
  if (now >= B.planAt) {
    B.planAt = now + P.plan * (0.85 + Math.random() * 0.3);
    plan(t, B, world, P, now);
  }
  const gun = gunnery(t, B, world, P, now);
  const nav = navigate(t, B, world, P, now, gun);
  posture(t, B, world, P, now, dt, nav, gun, acts);
  abilities(t, B, world, P, now, acts);
  return acts;
}

/* ================================================================
   Per-tank brain
   ================================================================ */

function brain(t, now) {
  let B = t.ai;
  if (!B || B.v !== 3) {
    B = t.ai = {
      v: 3,
      first: new Map(),     // stimulus -> when it was first sensed
      foes: new Map(),      // id -> lagged belief
      threats: [],
      behaviour: "hunt",
      behaviourAt: now,
      target: null,         // belief object of the current enemy
      goal: null,           // { x, y }
      planAt: 0,
      driveA: t.a,          // smoothed heading actually being driven
      driveM: 0,
      lastDir: null,        // sticky steering slot
      aimErr: 0, aimErrAt: -1e9,
      lockId: null, lockAt: 0,
      shotAt: 0,
      abAt: 0, abSince: {}, abSaw: {},
      histX: t.x, histY: t.y, histAt: now, stuckUntil: 0, stuckA: 0,
      roamAt: 0,
      path: null, pathAt: 0, pathTo: null,
    };
  }
  return B;
}

// A stimulus only becomes actionable once it has been present for the
// tier's reaction time. Anything brand new starts its clock and is NOT
// yet actionable — this is what removes instant reactions everywhere.
function reacted(B, key, now, delayMs) {
  const t0 = B.first.get(key);
  if (t0 === undefined) { B.first.set(key, now); return false; }
  return now - t0 >= delayMs;
}

/* ================================================================
   1. SENSE — build a belief, always a little behind reality
   ================================================================ */

function sense(t, B, world, P, now) {
  const cell = world.cell;
  const sightPx = P.sight * cell;
  const bulletR = world.bulletR ?? 3;

  if (B.first.size > 512) {
    for (const [k, v] of B.first) if (now - v > 6000) B.first.delete(k);
  }

  // --- enemies -----------------------------------------------------
  for (const o of world.tanks) {
    if (o === t || o.dead || o.gone) continue;
    const dx = o.x - t.x, dy = o.y - t.y;
    const d = Math.hypot(dx, dy);
    let bel = B.foes.get(o.id);
    const visible = d <= sightPx && clearLine(world, t.x, t.y, o.x, o.y, bulletR);

    if (!visible) {
      // HEARING. A tank you cannot see is still a running engine two
      // rooms away. Without this a bot has no idea anyone exists until
      // it happens to wander into a clear line — which in a maze is
      // mostly never, so it drifts around alone instead of hunting.
      // The fix is deliberately rough: it gives a direction to search,
      // not something to shoot at.
      const hearPx = 3.4 * cell;
      if (d <= hearPx && reacted(B, "hear:" + o.id, now, P.react * 1400)) {
        let h = B.foes.get(o.id);
        if (!h) {
          const err = cell * 0.45;
          h = { id: o.id, x: o.x + (Math.random() - 0.5) * err, y: o.y + (Math.random() - 0.5) * err,
                vx: 0, vy: 0, at: now, visible: false, heard: true, ref: o };
          B.foes.set(o.id, h);
        } else {
          // Converge slowly: you can tell roughly where, not exactly.
          h.x += (o.x - h.x) * 0.04;
          h.y += (o.y - h.y) * 0.04;
          h.at = now;
          h.visible = false;
          h.heard = true;
        }
      } else if (bel) {
        bel.visible = false;
      }
      continue;
    }
    if (!reacted(B, "see:" + o.id, now, P.react * 1000)) continue;

    if (!bel) {
      bel = { id: o.id, x: o.x, y: o.y, vx: 0, vy: 0, at: now - 16, visible: true, ref: o };
      B.foes.set(o.id, bel);
    }
    // The belief chases the truth at a rate set by the tier, so a weaker
    // bot is always shooting at where the target used to be.
    const step = Math.max(0.001, (now - bel.at) / 1000);
    const k = Math.min(1, step / Math.max(0.02, P.lag));
    const nvx = (o.x - bel.x) / step, nvy = (o.y - bel.y) / step;
    bel.vx += (nvx - bel.vx) * Math.min(1, k * 0.7);
    bel.vy += (nvy - bel.vy) * Math.min(1, k * 0.7);
    bel.x += (o.x - bel.x) * k;
    bel.y += (o.y - bel.y) * k;
    bel.at = now;
    bel.visible = true;
    bel.heard = false;
    bel.ref = o;
  }

  // --- incoming fire ------------------------------------------------
  // Each threat is reduced to one thing the steering can use: how long
  // until it arrives, and which way to step to make it miss.
  B.threats = [];
  const look = P.look;
  const addShot = (s, key, r, horizon) => {
    if (!reacted(B, key, now, P.react * 700)) return;
    const hit = interceptsMe(t, s, world, horizon, r);
    if (!hit) return;
    B.threats.push({
      kind: "shot", x: s.x, y: s.y, vx: s.vx, vy: s.vy,
      t: hit.t, side: hit.side,
    });
  };
  for (const b of world.bullets ?? []) {
    if (b.by === t.id) continue;
    addShot(b, "b:" + b.by + ":" + b.born, b.r ?? world.bulletR ?? 3, look);
  }
  for (const rk of world.rockets ?? []) {
    if (rk.by === t.id) continue;
    // A rocket steers, so it is treated as arriving sooner than it looks.
    addShot(rk, "r:" + rk.by + ":" + rk.born, rk.r ?? 6, look * 1.5);
  }
  // Beams land instantly. There is nothing to outrun — the only answer is
  // to not be on the line, so they read as a line to step off.
  for (const L of [...(world.lasers ?? []), ...(world.snipes ?? [])]) {
    if (L.by === t.id) continue;
    if (!reacted(B, "beam:" + L.by, now, P.react * 1000)) continue;
    const p = nearestOnPath(t.x, t.y, L.pts);
    if (p && p.d < world.tankR * 3.5) {
      B.threats.push({ kind: "beam", x: p.x, y: p.y, t: 0, side: 0 });
    }
  }
  B.threats.sort((a, b) => a.t - b.t);
  B.soonest = B.threats.length ? B.threats[0].t : Infinity;

  // --- stuck detector ------------------------------------------------
  // Steering can, rarely, argue itself into a corner. Rather than trust
  // it never happens, watch actual displacement: if the bot has been
  // asking to move and hasn't, force a committed break-out.
  if (now - B.histAt > 700) {
    const moved = Math.hypot(t.x - B.histX, t.y - B.histY);
    if (moved < world.tankR * 0.5 && B.driveM > 0.25 && now > B.stuckUntil) {
      B.stuckUntil = now + 700;
      B.stuckA = bestOpening(t, world, B.driveA + Math.PI);
    }
    B.histX = t.x; B.histY = t.y; B.histAt = now;
  }
}

// Closest approach of a projectile, in its own frame. Returns when it
// arrives and which way to step off the line (+1/-1 across its path).
function interceptsMe(t, s, world, horizon, r) {
  const rx = t.x - s.x, ry = t.y - s.y;
  const vx = -(s.vx ?? 0), vy = -(s.vy ?? 0);
  const vv = vx * vx + vy * vy;
  if (vv < 1e-6) return null;
  const tca = -(rx * vx + ry * vy) / vv;
  if (tca < 0 || tca > horizon) return null;
  const mx = rx + vx * tca, my = ry + vy * tca;
  const miss = Math.hypot(mx, my);
  const rad = world.tankR + (r ?? 3);
  if (miss > rad * 1.35) return null;
  // Which side of the shot's path we sit on: step that way and the miss
  // distance grows fastest.
  const cross = (s.vx ?? 0) * (t.y - s.y) - (s.vy ?? 0) * (t.x - s.x);
  return { t: tca, side: cross >= 0 ? 1 : -1 };
}

/* ================================================================
   2. PLAN — choose a behaviour, then stay with it
   ================================================================ */

function plan(t, B, world, P, now) {
  const cell = world.cell;
  const hp = t.hp / Math.max(1, world.maxHp ?? 10);

  // Pick the enemy worth fighting: visible ones first, then nearest.
  let best = null, bestScore = -Infinity;
  for (const f of B.foes.values()) {
    if (f.ref?.dead || f.ref?.gone) continue;
    const d = Math.hypot(f.x - t.x, f.y - t.y);
    if (!f.visible && now - f.at > 2500) continue;
    let s = -d / cell;
    if (f.visible) s += 4;
    if ((f.ref?.hp ?? 10) <= 2) s += 2.5;          // finish the wounded
    if (B.target && f.id === B.target.id) s += 1.2; // stickiness
    if (s > bestScore) { bestScore = s; best = f; }
  }
  B.target = best;

  const gearPick = pickGear(t, B, world, P);
  B.gear = gearPick;

  // Utility. Deliberately coarse — a handful of clear reasons beats a
  // pile of tuned weights nobody can reason about.
  const dist = best ? Math.hypot(best.x - t.x, best.y - t.y) / cell : Infinity;
  const armed = (t.weapon && t.weapon !== "normal") || false;
  const U = {
    hunt: 1.0 + P.aggression * 0.6,
    fight: best ? (2.2 + P.aggression * 1.5 - Math.max(0, dist - P.fireRange) * 0.5) : -9,
    collect: gearPick ? (1.6 + (armed ? 0 : 1.4) - gearPick.d / (cell * 5)) : -9,
    retreat: (hp < 0.35 ? 2.6 : hp < 0.6 ? 1.2 : -9) + (best ? 0.5 : -1),
  };
  let pick = "hunt", pv = -Infinity;
  for (const k in U) if (U[k] > pv) { pv = U[k]; pick = k; }

  // Commitment: only switch if the new option is clearly better, or the
  // current one has run its course. This is what stops the dithering.
  if (pick !== B.behaviour) {
    const held = now - B.behaviourAt;
    const cur = U[B.behaviour] ?? -Infinity;
    if (held < P.commit && pv < cur + 1.2) pick = B.behaviour;
  }
  if (pick !== B.behaviour) { B.behaviour = pick; B.behaviourAt = now; }

  // Turn the behaviour into somewhere to be.
  if (B.behaviour === "fight" && best) {
    if (!best.visible) {
      // Can't see them: holding a standoff range is pointless when a
      // wall is in the way. Close until there's a line.
      B.goal = { x: best.x, y: best.y };
    } else {
      // Stand off at the range this weapon actually wants.
      const g = gunOf(t.weapon || "normal");
      const want = Math.min(P.standoff, g.bestCells) * cell;
      const a = Math.atan2(t.y - best.y, t.x - best.x);
      B.goal = { x: best.x + Math.cos(a) * want, y: best.y + Math.sin(a) * want };
    }
  } else if (B.behaviour === "collect" && gearPick) {
    B.goal = { x: gearPick.x, y: gearPick.y };
  } else if (B.behaviour === "retreat") {
    const from = best ?? { x: t.x, y: t.y };
    const a = Math.atan2(t.y - from.y, t.x - from.x);
    B.goal = { x: t.x + Math.cos(a) * cell * 3, y: t.y + Math.sin(a) * cell * 3 };
  } else {
    if (!B.goal || now > B.roamAt || Math.hypot(B.goal.x - t.x, B.goal.y - t.y) < cell * 0.7) {
      B.roamAt = now + 6000 + Math.random() * 3000;
      // Search toward the last place anyone was seen rather than
      // wandering at random — a bot that has heard a fight goes to it.
      let seek = best;
      if (!seek) {
        let recent = null, rt = -Infinity;
        for (const f of B.foes.values()) if (f.at > rt) { rt = f.at; recent = f; }
        seek = recent;
      }
      if (seek) {
        B.goal = { x: seek.x, y: seek.y };
      } else {
        // Patrol properly: commit to a cell well away from here and go
        // there. Drifting to a random point a couple of cells off just
        // jitters on the spot, and two bots doing that never meet.
        const maze = world.maze;
        let pick = null;
        for (let tries = 0; tries < 24 && !pick; tries++) {
          const c = Math.floor(Math.random() * (maze?.cols ?? 8));
          const r = Math.floor(Math.random() * (maze?.rows ?? 6));
          if (maze?.inside && !maze.inside[r][c]) continue;
          const x = (c + 0.5) * cell, y = (r + 0.5) * cell;
          if (Math.hypot(x - t.x, y - t.y) < cell * 2.5) continue;
          pick = { x, y };
        }
        B.goal = pick ?? { x: t.x + (Math.random() - 0.5) * cell * 4,
                           y: t.y + (Math.random() - 0.5) * cell * 4 };
      }
    }
  }
  if (B.goal) {
    B.goal.x = Math.max(world.tankR, Math.min((world.maze?.cols ?? 12) * cell - world.tankR, B.goal.x));
    B.goal.y = Math.max(world.tankR, Math.min((world.maze?.rows ?? 12) * cell - world.tankR, B.goal.y));
  }
}

function pickGear(t, B, world, P) {
  let best = null, bd = Infinity;
  for (const g of world.gear ?? []) {
    const d = Math.hypot(g.x - t.x, g.y - t.y);
    if (d > P.sight * world.cell) continue;
    if (d < bd) { bd = d; best = g; }
  }
  return best ? { x: best.x, y: best.y, d: bd, type: best.type } : null;
}

/* ================================================================
   3. NAVIGATE — context steering
   ================================================================ */

function navigate(t, B, world, P, now, gun) {
  const R = world.tankR;
  const score = new Array(DIRS).fill(0);
  const open = new Array(DIRS).fill(1);

  // --- how far can we actually go each way? --------------------------
  // HALF is the hull's real half-width. world.tankR is the BOUNDING
  // radius (corner to centre), about 50% fatter — probing with that made
  // every maze corridor read as shut, and the bot crept everywhere.
  const HALF = R * 0.66;
  const probe = R * 2.4;
  for (let i = 0; i < DIRS; i++) {
    const d = clearance(t, world, RAY[i], probe, HALF);
    open[i] = d / probe;                       // 0 = blocked at the nose
  }

  // --- interest: toward the goal -------------------------------------
  let goalA = null;
  if (B.goal) goalA = routeHeading(t, B, world, B.goal, now);

  for (let i = 0; i < DIRS; i++) {
    if (goalA != null) {
      const al = Math.cos(angDiff(RAY[i].a, goalA));
      score[i] += Math.max(0, al) * 1.6;
    }
    // Driving forwards is faster than reversing, so a heading the hull is
    // already pointing is better on the merits — not merely tidier. This
    // is what stops a bot spending the whole fight moonwalking.
    score[i] += Math.cos(angDiff(RAY[i].a, t.a)) * 0.9;
    // Openness is a MULTIPLIER on desire, not a veto: a direction that
    // is merely tight stays available, one that is solid stops being
    // attractive. This is what keeps a bot off walls without ever
    // leaving it with nowhere legal to go.
    score[i] *= 0.25 + 0.75 * open[i];
    if (open[i] < 0.18) score[i] -= (0.18 - open[i]) * 8;
  }

  // --- keep out of each other ----------------------------------------
  for (const o of world.tanks) {
    if (o === t || o.dead || o.gone) continue;
    const dx = o.x - t.x, dy = o.y - t.y;
    const d = Math.hypot(dx, dy);
    const near = R * 3;
    if (d > near || d < 1e-3) continue;
    const a = Math.atan2(dy, dx);
    const push = (1 - d / near) * 2.2;
    for (let i = 0; i < DIRS; i++) {
      const c = Math.cos(angDiff(RAY[i].a, a));
      if (c > 0) score[i] -= c * push;
    }
  }

  // --- mud is slow, not deadly ---------------------------------------
  for (const m of world.mud ?? []) {
    const dx = m.x - t.x, dy = m.y - t.y;
    const d = Math.hypot(dx, dy);
    const reach = (m.r ?? R * 2) + R;
    if (d > reach || d < 1e-3) continue;
    const a = Math.atan2(dy, dx);
    for (let i = 0; i < DIRS; i++) {
      const c = Math.cos(angDiff(RAY[i].a, a));
      if (c > 0) score[i] -= c * (1 - d / reach) * 0.8;
    }
  }

  // --- evasion --------------------------------------------------------
  // Directions are rewarded by how far the shot would miss if taken —
  // which naturally favours stepping ACROSS the line of fire rather than
  // running down it. Skill scales how hard this pulls.
  if (B.threats.length) {
    const spd = (world.moveSpeed ?? 130) * P.speed;
    for (const th of B.threats) {
      if (th.kind === "beam") {
        const away = Math.atan2(t.y - th.y, t.x - th.x);
        for (let i = 0; i < DIRS; i++) {
          score[i] += Math.max(0, Math.cos(angDiff(RAY[i].a, away))) * 3 * P.dodge;
        }
        continue;
      }
      const lead = Math.min(P.look, Math.max(0.1, th.t));
      const ex = th.x + th.vx * lead, ey = th.y + th.vy * lead;
      const urgency = 1 - Math.min(1, th.t / Math.max(0.15, P.look));
      for (let i = 0; i < DIRS; i++) {
        const fx = t.x + RAY[i].cx * spd * lead;
        const fy = t.y + RAY[i].cy * spd * lead;
        const miss = segDist(fx, fy, th.x, th.y, ex, ey);
        const safe = Math.min(1, miss / (R * 3));
        // Only worth taking if we can actually get there.
        score[i] += safe * open[i] * 4.5 * P.dodge * (0.4 + urgency);
        if (safe < 0.35) score[i] -= (0.35 - safe) * 5 * P.dodge * urgency;
      }
    }
  }

  // --- sticky choice ---------------------------------------------------
  // Near-ties between neighbouring directions used to flip every frame,
  // which reads as a bot vibrating. Carrying on costs nothing; turning
  // has to be worth it.
  if (B.lastDir != null) {
    for (let i = 0; i < DIRS; i++) {
      const off = Math.min(Math.abs(i - B.lastDir), DIRS - Math.abs(i - B.lastDir));
      if (off === 0) score[i] += 0.5;
      else if (off === 1) score[i] += 0.28;
      else if (off === 2) score[i] += 0.1;
    }
  }

  // --- break-out overrides everything ---------------------------------
  if (now < B.stuckUntil) {
    return { a: B.stuckA, mag: 1, forced: true };
  }

  let bi = 0;
  for (let i = 1; i < DIRS; i++) if (score[i] > score[bi]) bi = i;
  B.lastDir = bi;

  // Sub-slot lean, so headings aren't quantised to 15° steps.
  const l = (bi + DIRS - 1) % DIRS, r = (bi + 1) % DIRS;
  const denom = Math.abs(score[l]) + Math.abs(score[r]) + Math.abs(score[bi]) + 1e-3;
  const a = RAY[bi].a + ((score[r] - score[l]) / denom) * (Math.PI / DIRS);

  // Throttle: full when the way is clear, easing off into clutter and on
  // approach, so it settles rather than overshooting and correcting.
  let mag = 0.95 * (0.6 + 0.4 * open[bi]);
  if (B.goal) {
    const gd = Math.hypot(B.goal.x - t.x, B.goal.y - t.y);
    if (gd < R * 2.5) mag *= Math.max(0.15, gd / (R * 2.5));
  }
  B.mapScore = score;
  return { a, mag, forced: false };
}

// Distance we can travel a given way before something solid stops us.
function clearance(t, world, ray, maxD, halfW) {
  let d = maxD;
  const x2 = t.x + ray.cx * maxD, y2 = t.y + ray.cy * maxD;
  for (const r of world.rects ?? []) {
    const hit = raySlab(t.x, t.y, ray.cx, ray.cy, maxD,
      r.x - halfW, r.y - halfW, r.x + r.w + halfW, r.y + r.h + halfW);
    if (hit != null && hit < d) d = hit;
  }
  for (const w of world.walls ?? []) {
    if ((w.hp ?? 1) <= 0) continue;
    if (segHitsBox(t.x, t.y, x2, y2, w, halfW)) {
      const dd = Math.max(0, Math.hypot(w.x - t.x, w.y - t.y) - Math.max(w.hx, w.hy) - halfW);
      if (dd < d) d = dd;
    }
  }
  return Math.max(0, d);
}

// Most open direction, biased toward a preferred bearing. Used to break
// out of a corner.
function bestOpening(t, world, prefer) {
  let bi = 0, bv = -Infinity;
  for (let i = 0; i < DIRS; i++) {
    const c = clearance(t, world, RAY[i], world.tankR * 3, world.tankR * 0.66);
    const v = c + Math.cos(angDiff(RAY[i].a, prefer)) * world.tankR;
    if (v > bv) { bv = v; bi = i; }
  }
  return RAY[bi].a;
}


/* ================================================================
   Routing — grid path first, steering for the last few metres
   ================================================================ */

// Context steering alone is a LOCAL method: it cannot see round a
// corner, so on its own it walks into concave geometry and sits there.
// A breadth-first route over the maze grid supplies the long-range
// answer ("which way out of this room"), and the steering below handles
// everything within sight. That split is the standard arrangement and
// it's what stops bots getting hung up on walls.
function cellIdx(v, cell, n) {
  return Math.max(0, Math.min(n - 1, Math.floor(v / cell)));
}

function bfsRoute(maze, from, to) {
  const { cols, rows } = maze;
  const inside = (c, r) =>
    c >= 0 && c < cols && r >= 0 && r < rows && (!maze.inside || maze.inside[r][c]);
  if (!inside(from.c, from.r) || !inside(to.c, to.r)) return null;
  const key = (c, r) => r * cols + c;
  const prev = new Map();
  const seen = new Set([key(from.c, from.r)]);
  let frontier = [[from.c, from.r]];
  let found = false;
  while (frontier.length && !found) {
    const next = [];
    for (const [c, r] of frontier) {
      if (c === to.c && r === to.r) { found = true; break; }
      const steps = [];
      if (maze.H && !maze.H[r][c] && inside(c, r - 1)) steps.push([c, r - 1]);
      if (maze.H && !maze.H[r + 1][c] && inside(c, r + 1)) steps.push([c, r + 1]);
      if (maze.V && !maze.V[r][c] && inside(c - 1, r)) steps.push([c - 1, r]);
      if (maze.V && !maze.V[r][c + 1] && inside(c + 1, r)) steps.push([c + 1, r]);
      for (const [nc, nr] of steps) {
        const k = key(nc, nr);
        if (seen.has(k)) continue;
        seen.add(k);
        prev.set(k, [c, r]);
        next.push([nc, nr]);
      }
    }
    frontier = next;
  }
  if (!seen.has(key(to.c, to.r))) return null;
  const path = [];
  let cur = [to.c, to.r];
  while (cur) {
    path.push({ c: cur[0], r: cur[1] });
    const p = prev.get(key(cur[0], cur[1]));
    if (!p) break;
    cur = p;
  }
  path.reverse();
  return path;
}

// Bearing to aim the steering at: straight at the goal when the way is
// open, otherwise at the furthest waypoint we can actually see.
function routeHeading(t, B, world, goal, now) {
  const R = world.tankR;
  if (clearLine(world, t.x, t.y, goal.x, goal.y, R * 0.62)) {
    B.path = null;
    return Math.atan2(goal.y - t.y, goal.x - t.x);
  }
  const maze = world.maze;
  if (!maze || !maze.H || !maze.V) {
    return Math.atan2(goal.y - t.y, goal.x - t.x);
  }
  const cell = world.cell;
  const to = { c: cellIdx(goal.x, cell, maze.cols), r: cellIdx(goal.y, cell, maze.rows) };
  const from = { c: cellIdx(t.x, cell, maze.cols), r: cellIdx(t.y, cell, maze.rows) };

  const stale = !B.path || now - B.pathAt > 900 ||
    !B.pathTo || B.pathTo.c !== to.c || B.pathTo.r !== to.r;
  if (stale) {
    B.path = bfsRoute(maze, from, to);
    B.pathAt = now;
    B.pathTo = to;
  }
  if (!B.path || B.path.length < 2) {
    return Math.atan2(goal.y - t.y, goal.x - t.x);
  }
  // String-pull: head for the furthest waypoint on a clear line, so the
  // bot cuts corners smoothly instead of touring cell centres.
  const cx = (n) => (n.c + 0.5) * cell;
  const cy = (n) => (n.r + 0.5) * cell;
  let pick = 1;
  for (let i = B.path.length - 1; i >= 1; i--) {
    if (clearLine(world, t.x, t.y, cx(B.path[i]), cy(B.path[i]), R * 0.62)) { pick = i; break; }
  }
  // Drop waypoints already behind us so the path is consumed.
  while (B.path.length > 2 &&
         Math.hypot(cx(B.path[1]) - t.x, cy(B.path[1]) - t.y) < cell * 0.55) {
    B.path.splice(1, 1);
    if (pick > 1) pick--;
  }
  return Math.atan2(cy(B.path[pick]) - t.y, cx(B.path[pick]) - t.x);
}

/* ================================================================
   4a. GUNNERY
   ================================================================ */

function gunnery(t, B, world, P, now) {
  const out = { want: false, aim: t.a, dist: Infinity, canFire: false, hold: false };
  const target = B.target;
  if (!target || !target.visible) { B.lockId = null; return out; }

  const cell = world.cell;
  const g = gunOf(t.weapon || "normal");
  const dist = Math.hypot(target.x - t.x, target.y - t.y);
  out.dist = dist;
  const cells = dist / cell;
  if (cells > Math.min(P.fireRange, g.maxCells)) return out;
  if (cells < g.minCells) return out;                   // too close to arm

  // Lead the target by as much of the intercept solution as this tier
  // can work out.
  const speed = shotSpeed(t.weapon, world);
  const sol = intercept(t.x, t.y, target.x, target.y, target.vx * P.lead, target.vy * P.lead, speed);
  if (now - B.aimErrAt > 500) {
    B.aimErrAt = now;
    B.aimErr = (Math.random() - 0.5) * 2 * P.aimErr;
  }
  const bearing = Math.atan2(sol.y - t.y, sol.x - t.x);
  out.aim = bearing + B.aimErr;
  out.bearing = bearing;
  out.want = true;

  // Settle: a target just acquired can't be snapped onto and fired at.
  if (B.lockId !== target.id) { B.lockId = target.id; B.lockAt = now; }
  if (now - B.lockAt < P.settle * 1000) return out;

  // A phasing tank cannot be hit at all; anyone competent waits it out.
  if (P.ability > 0.35 && target.ref && now < (target.ref.phaseUntil ?? 0)) return out;

  if (Math.abs(angDiff(t.a, out.aim)) > P.aimTol) return out;

  // Line of fire: no walls, no team-mates. Mortars arc over everything.
  if (!g.indirect) {
    const mz = world.muzzle ?? world.tankR;
    const mx = t.x + Math.cos(t.a) * mz, my = t.y + Math.sin(t.a) * mz;
    if (!clearLine(world, mx, my, target.x, target.y, world.bulletR ?? 3)) return out;
  }

  // Ammo in flight is ammo you don't have.
  if (!g.indirect && !g.hold) {
    let live = 0;
    for (const b of world.bullets ?? []) if (b.by === t.id) live++;
    if (live >= (world.magSize ?? 3)) return out;
    if (now - B.shotAt < (world.magGap ?? 500) * 0.9) return out;
  }
  // Flame runs on fuel and only reaches so far.
  if (t.weapon === "flame") {
    if ((t.flameFuel ?? FLAME.durationMs) <= 60) return out;
    if (dist > FLAME.reachCells * cell * 0.92) return out;
  }

  out.canFire = true;
  out.hold = g.hold;
  return out;
}

function shotSpeed(w, world) {
  const base = world.bulletSpeed ?? 420;
  if (w === "sniper") return base * (SNIPER.speed ?? 2.1);
  if (w === "rocket") return base * (ROCKET.speed ?? 0.72);
  if (w === "cannon") return base * (CANNON_SPEED);
  if (w === "mg") return base * (MG.speed ?? 1.05);
  if (w === "laser") return 9999;              // effectively instant
  if (w === "mortar") return base * 0.9;
  return base;
}
const CANNON_SPEED = 0.74;

function intercept(px, py, tx, ty, tvx, tvy, speed) {
  const dx = tx - px, dy = ty - py;
  if (!isFinite(speed) || speed > 9000) return { x: tx, y: ty };
  const a = tvx * tvx + tvy * tvy - speed * speed;
  const b = 2 * (dx * tvx + dy * tvy);
  const c = dx * dx + dy * dy;
  let tHit = 0;
  if (Math.abs(a) < 1e-6) {
    if (Math.abs(b) > 1e-6) tHit = -c / b;
  } else {
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const s = Math.sqrt(disc);
      const t1 = (-b + s) / (2 * a), t2 = (-b - s) / (2 * a);
      tHit = Math.min(...[t1, t2].filter((v) => v > 0), 3);
    }
  }
  if (!isFinite(tHit) || tHit < 0) tHit = 0;
  return { x: tx + tvx * tHit, y: ty + tvy * tHit };
}

/* ================================================================
   4b. POSTURE — the movement/aim conflict, resolved on purpose
   ================================================================ */

function posture(t, B, world, P, now, dt, nav, gun, acts) {
  const R = world.tankR;
  const cell = world.cell;

  // Is something about to hit us? If so, moving matters more than
  // shooting, and the better the bot the earlier it makes that call.
  const urgent = B.soonest < 0.22 + 0.34 * P.dodge;   // seconds to impact
  const evading = B.threats.length > 0 && urgent;

  let wantA = nav.a, wantM = nav.mag;

  if (gun.want && !evading && !nav.forced) {
    // Firing posture. The hull has to point at the target, so movement is
    // restricted to the target axis — and which way we go along it is
    // decided by RANGE, not by a score that can flip frame to frame.
    // That is the whole reason these bots used to shuffle back and forth.
    const g = gunOf(t.weapon || "normal");
    const want = Math.min(P.standoff, g.bestCells) * cell;
    const axis = gun.bearing ?? gun.aim;
    const near = want * 0.55, far = want * 1.35;

    if (gun.dist > far) {
      wantA = axis; wantM = 0.9;                       // close the gap
    } else if (gun.dist < near) {
      wantA = axis + Math.PI; wantM = 0.75;            // back off, nose still on
    } else {
      // In the pocket: hold the line, just enough throttle to keep the
      // hull swinging onto the shot.
      wantA = axis; wantM = 0.22;
    }
    // Never drive into something just to keep a shot.
    const slot = Math.round(((wantA % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2) / (Math.PI * 2) * DIRS) % DIRS;
    const room = clearance(t, world, RAY[slot], R * 2.2, R * 0.66) / (R * 2.2);
    if (room < 0.3) { wantA = nav.a; wantM = nav.mag; }
  }

  // Ease onto the heading. Nothing ever snaps — a bot that teleports its
  // steering looks like it is correcting a mistake every frame.
  const rate = nav.forced ? 10 : 4.5 + 5 * P.dodge;
  B.driveA += angDiff(B.driveA, wantA) * Math.min(1, dt * rate);
  B.driveM += (wantM - B.driveM) * Math.min(1, dt * 7);

  if (B.driveM > 0.04) {
    acts.moveAngle = B.driveA;
    acts.moveMag = Math.max(0.2, Math.min(1, B.driveM));
  } else if (gun.want) {
    // Standing but still needs to bring the gun round.
    acts.moveAngle = gun.bearing ?? gun.aim;
    acts.moveMag = 0.2;
  }

  if (gun.canFire) {
    acts.shoot = true;
    if (!gun.hold) B.shotAt = now;
  }
}

/* ================================================================
   4c. ABILITIES — what each one is FOR
   ================================================================ */

// A trigger has to hold for a reaction time before it is acted on, and
// whether this tier reads the situation at all is decided once, when the
// opportunity appears — not re-rolled until it happens to come up true.
function ready(B, key, cond, now, P) {
  if (!cond) { B.abSince[key] = 0; return false; }
  if (!B.abSince[key]) {
    B.abSince[key] = now;
    B.abSaw[key] = Math.random() < 0.4 + 0.6 * P.ability;
    return false;
  }
  if (!B.abSaw[key]) return false;
  return now - B.abSince[key] >= P.react * 1000 * (1.4 - 0.5 * P.ability);
}

function abilities(t, B, world, P, now, acts) {
  if (now - B.abAt < 250) return;
  const cell = world.cell;
  const target = B.target;
  const dist = target ? Math.hypot(target.x - t.x, target.y - t.y) : Infinity;
  const hp = t.hp / Math.max(1, world.maxHp ?? 10);
  const underFire = B.threats.length > 0;
  const beam = B.threats.some((x) => x.kind === "beam");
  const foe = target?.ref ?? null;
  const heavy = foe && (foe.weapon === "sniper" || foe.weapon === "cannon" || foe.weapon === "rocket");

  // ---- defence -------------------------------------------------------
  if (t.defense) {
    let cond = false;
    switch (t.defense) {
      case "armour":
        // 6 extra HP for 20 s. Worth putting on BEFORE the exchange, and
        // wasted if refreshed while it's still up.
        cond = (t.armour ?? 0) <= 0 &&
               (underFire || (target && dist < cell * 4) || (heavy && target));
        break;
      case "heal":
        // A pad you have to stand on for several seconds — only when
        // there's time to use it.
        cond = hp < 0.6 && !underFire && (!target || dist > cell * 3.5);
        break;
      case "wall":
        // Breaks the line of fire. Best against exactly the things that
        // need a line: beams and slow heavy shots.
        cond = beam || (underFire && hp < 0.8) || (target && dist < cell * 2 && hp < 0.5);
        break;
      case "mud":
        // Dropped behind you to slow a chaser.
        cond = !!target && dist < cell * 2.5 &&
               (B.behaviour === "retreat" || hp < 0.5);
        break;
    }
    if (ready(B, "def", cond, now, P)) {
      acts.def = true; B.abAt = now; B.abSince.def = 0; return;
    }
  }

  // ---- agility -------------------------------------------------------
  if (t.agility) {
    let cond = false;
    switch (t.agility) {
      case "phase":
        // One second of intangibility. Spent too early it lapses before
        // the shot lands, so it is timed late — and finer the better the
        // bot is.
        cond = beam || B.soonest < 0.16 + 0.28 * P.ability;
        break;
      case "boost":
        // 40% speed for 6 s: closing, breaking contact, racing for gear,
        // or simply outrunning something when there's no phase.
        cond = (B.behaviour === "retreat") ||
               (B.behaviour === "collect" && (B.gear?.d ?? 0) > cell * 2.5) ||
               (B.behaviour === "fight" && dist > cell * 5) ||
               (underFire && B.soonest < 0.45 && P.ability > 0.5);
        break;
    }
    if (ready(B, "agi", cond, now, P)) {
      acts.agi = true; B.abAt = now; B.abSince.agi = 0;
    }
  }
}

/* ================================================================
   Geometry
   ================================================================ */

function angDiff(from, to) {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

function segDist(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const L = dx * dx + dy * dy;
  let s = L > 1e-9 ? ((px - x1) * dx + (py - y1) * dy) / L : 0;
  s = Math.max(0, Math.min(1, s));
  return Math.hypot(px - (x1 + dx * s), py - (y1 + dy * s));
}

function nearestOnPath(x, y, pts) {
  if (!pts || pts.length < 2) return null;
  let bd = Infinity, bx = 0, by = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const dx = b.x - a.x, dy = b.y - a.y;
    const L = dx * dx + dy * dy;
    let s = L > 1e-9 ? ((x - a.x) * dx + (y - a.y) * dy) / L : 0;
    s = Math.max(0, Math.min(1, s));
    const px = a.x + dx * s, py = a.y + dy * s;
    const d = Math.hypot(x - px, y - py);
    if (d < bd) { bd = d; bx = px; by = py; }
  }
  return { d: bd, x: bx, y: by };
}

// Distance along a ray to an axis-aligned box, or null.
function raySlab(ox, oy, dx, dy, maxD, x1, y1, x2, y2) {
  let tmin = 0, tmax = maxD;
  for (const [o, d, lo, hi] of [[ox, dx, x1, x2], [oy, dy, y1, y2]]) {
    if (Math.abs(d) < 1e-9) { if (o < lo || o > hi) return null; continue; }
    let t1 = (lo - o) / d, t2 = (hi - o) / d;
    if (t1 > t2) { const s = t1; t1 = t2; t2 = s; }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return null;
  }
  return tmin;
}

// Segment vs an oriented box (a wall someone placed): rotate into the
// box's frame and it becomes segment-vs-AABB.
function segHitsBox(x1, y1, x2, y2, w, pad) {
  const c = Math.cos(-w.a), s = Math.sin(-w.a);
  const ax = x1 - w.x, ay = y1 - w.y;
  const bx = x2 - w.x, by = y2 - w.y;
  const p1x = ax * c - ay * s, p1y = ax * s + ay * c;
  const p2x = bx * c - by * s, p2y = bx * s + by * c;
  const hx = w.hx + pad, hy = w.hy + pad;
  let t0 = 0, t1 = 1;
  const dx = p2x - p1x, dy = p2y - p1y;
  const clip = (p, q) => {
    if (Math.abs(p) < 1e-9) return q >= 0;
    const r = q / p;
    if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; }
    else { if (r < t0) return false; if (r < t1) t1 = r; }
    return true;
  };
  return clip(-dx, p1x + hx) && clip(dx, hx - p1x) &&
         clip(-dy, p1y + hy) && clip(dy, hy - p1y);
}

// Is the straight run between two points free of maze AND placed walls?
function clearLine(world, x1, y1, x2, y2, r) {
  for (const rc of world.rects ?? []) {
    if (segHitsRect(x1, y1, x2, y2, rc, r)) return false;
  }
  for (const w of world.walls ?? []) {
    if ((w.hp ?? 1) <= 0) continue;
    if (segHitsBox(x1, y1, x2, y2, w, r)) return false;
  }
  return true;
}

function segHitsRect(x1, y1, x2, y2, rc, r) {
  const lo1 = rc.x - r, lo2 = rc.y - r;
  const hi1 = rc.x + rc.w + r, hi2 = rc.y + rc.h + r;
  const dx = x2 - x1, dy = y2 - y1;
  const L = Math.hypot(dx, dy);
  if (L < 1e-9) return x1 >= lo1 && x1 <= hi1 && y1 >= lo2 && y1 <= hi2;
  const hit = raySlab(x1, y1, dx / L, dy / L, L, lo1, lo2, hi1, hi2);
  return hit != null && hit <= L;
}
