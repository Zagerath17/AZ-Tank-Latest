// ================================================================
// ai.js — bot drivers: easy / medium / hard / impossible.
//
// A bot emits exactly the same actions a human does, so it obeys the
// identical movement, collision and firing rules. No cheating physics.
//
// The brain is a pipeline, run per bot:
//
//   PERCEPTION → BELIEF → DECISION → STEERING → ACTS
//
//   1. PERCEPTION. Nothing is known the instant it happens. Every
//      stimulus (a tank coming into view, a shot in the air, a pickup
//      appearing) is stamped when first sensed and only becomes
//      actionable once that bot's reaction time has elapsed. Targets
//      are tracked as a LAGGED estimate that eases toward the truth,
//      so a bot follows a jinking enemy the way a person does —
//      slightly behind it, not welded to it.
//
//   2. BELIEF. The bot reasons about the world it *believes* in: those
//      lagged tracks, the threats it has actually noticed, the gear it
//      has spotted. Nothing downstream reads the raw world.
//
//   3. DECISION. Utility scoring picks the behaviour — engage, dodge,
//      collect, retreat, patrol. Whatever it's already doing gets a
//      commitment bonus, which is what stops the twitchy re-deciding
//      that makes bots look like they're constantly correcting
//      themselves. Decisions happen on a think tick, staggered per bot,
//      not every frame.
//
//   4. STEERING. Context steering: score every direction on a compass
//      for interest (where it wants to go) and danger (walls, incoming
//      fire, crowding), then drive the best one. The result is low-pass
//      filtered so the hull sweeps instead of snapping. This is also
//      what makes dodging work properly — the bot slides out of a
//      bullet's line rather than reversing back down it.
//
// Abilities are table-driven: each item has a rule for when it's worth
// using, including as an answer to what someone else just did.
//
// THE WORLD IS NOT JUST THE MAZE. Players reshape the arena mid-round:
// a brick wall dropped across a corridor is a new dead end, and a mud
// puddle is a stretch of ground that costs three times as much to
// cross. Both are treated as first-class terrain here — they block or
// weight line of sight, the steering compass, and the route planner —
// so a bot goes AROUND a wall someone just built instead of grinding
// into it, and prefers a clean corridor to a slow one. Neither is
// known instantly: a freshly placed slab has to be seen for a reaction
// time first, so bots can still be caught out by a wall dropped in
// their face.
// ================================================================

import {
  ROCKET, FLAME, WEAPON_CATEGORY,
} from "./weapons.js";

export const AI_LEVELS = ["easy", "medium", "hard", "impossible"];

// `speed` and `turn` are multipliers on the HUMAN rates, capped at 1.0 —
// a bot can never out-drive or out-turn a player. Everything else shapes
// how well it thinks, not how fast it moves.
export const AI_PARAMS = {
  easy: {
    speed: 0.82, turn: 0.88,
    react: 0.52,        // s from stimulus to response
    think: 320,         // ms between decisions
    trackLag: 0.42,     // s its picture of a moving target trails reality
    aimErr: 0.26,       // radians of aim wobble
    aimTol: 0.13,       // how aligned it must be before firing
    aimSettle: 0.40,    // s it must hold a target before shooting
    lead: 0.15,         // how much of the intercept solution it uses
    dodge: 0.35,        // how reliably it commits to a dodge
    dodgeHorizon: 0.6,  // s of lookahead on incoming fire
    range: 6, fireRange: 5,
    reserve: 0,         // rounds kept in reserve
    ability: 0.3,       // how well it plays its abilities
    aggression: 0.5,
    standoff: 1.20,      // preferred fighting distance (cells)
  },
  medium: {
    speed: 0.94, turn: 1.0,
    react: 0.34, think: 240, trackLag: 0.26,
    aimErr: 0.10, aimTol: 0.13, aimSettle: 0.24,
    lead: 0.5, dodge: 0.68, dodgeHorizon: 1.0,
    range: 10, fireRange: 6, reserve: 0,
    ability: 0.6, aggression: 0.6, standoff: 1.60,
  },
  hard: {
    speed: 1.0, turn: 1.0,
    react: 0.24, think: 180, trackLag: 0.15,
    aimErr: 0.030, aimTol: 0.13, aimSettle: 0.14,
    lead: 0.85, dodge: 0.92, dodgeHorizon: 1.3,
    range: 13, fireRange: 7, reserve: 0,
    ability: 0.85, aggression: 0.75, standoff: 1.85,
  },
  impossible: {
    speed: 1.0, turn: 1.0,
    react: 0.16, think: 130, trackLag: 0.08,
    aimErr: 0.004, aimTol: 0.13, aimSettle: 0.08,
    lead: 1.0, dodge: 1.0, dodgeHorizon: 1.6,
    range: 99, fireRange: 7.5, reserve: 0,
    ability: 1.0, aggression: 0.9, standoff: 1.95,
  },
};

const SLOTS = 16;                 // compass resolution for context steering

// What a direction's interest gives up per unit of mud in it. Tuned so
// a bot will still wade through a puddle for something it genuinely
// wants (a full-strength goal scores 1.0) but takes the clean line
// whenever one is going spare.
const MUD_TOLL = 0.55;
// Extra route cost, in cells, for planning a path through a muddy cell.
const MUD_CELL_COST = 2.5;
const SLOT_A = [];
for (let i = 0; i < SLOTS; i++) {
  const a = (i / SLOTS) * Math.PI * 2;
  SLOT_A.push({ a, cx: Math.cos(a), cy: Math.sin(a) });
}

/* ================================================================
   Entry point
   ================================================================ */

export function botActions(t, world, dt, now) {
  const P = AI_PARAMS[t.bot] ?? AI_PARAMS.medium;
  const mem = memory(t, now);
  const acts = {
    up: false, down: false, left: false, right: false,
    shoot: false, def: false, agi: false,
    moveAngle: null, moveMag: 0,
  };
  const rBody = world.tankR;
  world.now = now;            // so path staleness can be timed

  // --- 1/2. PERCEPTION → BELIEF --------------------------------------
  perceive(t, mem, world, P, now);

  // --- 3. DECISION, on a think tick ----------------------------------
  if (now >= mem.thinkAt) {
    mem.thinkAt = now + P.think * (0.85 + Math.random() * 0.3);
    decide(t, mem, world, P, now);
    mem.wallDanger = wallDanger(t, mem, world, rBody);
    mem.mudAhead = mudDanger(t, mem, world, rBody);
  }

  // --- 4. STEERING ---------------------------------------------------
  const desired = steer(t, mem, world, P, rBody);

  // Low-pass the heading so the hull sweeps rather than snaps. Sharper
  // bots settle faster, but nobody teleports their steering.
  if (mem.driveA == null) mem.driveA = t.a;
  if (desired.mag > 0.02) {
    const k = Math.min(1, dt * (5 + 7 * P.dodge));
    mem.driveA += angleDiff(mem.driveA, desired.a) * k;
    mem.driveM += (desired.mag - mem.driveM) * Math.min(1, dt * 6);
  } else {
    mem.driveM += (0 - mem.driveM) * Math.min(1, dt * 6);
  }

  // --- AIM + FIRE ----------------------------------------------------
  const gun = aimAndFire(t, mem, world, P, now, acts);

  // --- ARBITRATION: shoot, or save yourself? --------------------------
  // The turret is welded to the hull, so holding an aim means the tank can
  // only travel along the firing line — it cannot strafe. That makes this
  // a genuine either/or, and it used to be resolved the wrong way: the
  // firing line was forced on unconditionally whenever a target existed,
  // which threw away the whole steering solution and left the bot with
  // exactly two options, straight at the enemy or straight back down the
  // same line. That is why they never dodged and why they twitched — the
  // choice flipped every time the two ends scored close together.
  //
  // Now the nearest threat sets an urgency, and each tier decides how
  // early it will give up a shot to live. Sharper bots hold the shot
  // longer AND break off sooner when it actually matters.
  let urgency = 0;
  for (const th of mem.threats) {
    const tca = th.kind === "beam" ? 0 : th.tca;
    const u = 1 - Math.min(1, tca / Math.max(0.15, P.dodgeHorizon));
    if (u > urgency) urgency = u;
  }
  const evade = urgency > 1 - P.dodge * 0.92;

  if (gun.holdAim && !evade) {
    // Safe enough to keep the gun on. Travel along the firing line and
    // take whichever end the steering map prefers — that is what lets a
    // bot give ground with the nose still on its target.
    const line = gun.bearing ?? gun.aim;   // clean bearing, no gunnery wobble
    const fwd = dirScore(mem, line);
    const back = dirScore(mem, line + Math.PI);
    // Hysteresis: once committed to an end, it takes a clear margin to
    // switch. Without this the bot dithers on the spot whenever the two
    // ends score alike, which reads as constant self-correction.
    const margin = mem.lineBack ? -0.22 : 0.22;
    mem.lineBack = back > fwd + margin;
    const lineA = mem.lineBack ? line + Math.PI : line;
    // Eased onto like any other heading — nothing ever snaps.
    mem.driveA += angleDiff(mem.driveA, lineA) * Math.min(1, dt * (6 + 8 * P.dodge));
    if (mem.driveM < 0.2) mem.driveM = 0.2;
  } else {
    mem.lineBack = false;
  }

  if (mem.driveM > 0.03) {
    acts.moveAngle = mem.driveA;
    acts.moveMag = Math.max(0.25, Math.min(1, mem.driveM));
  } else if (gun.holdAim) {
    // Standing still but still needs to bring the gun round: a trickle of
    // throttle so the hull actually turns.
    acts.moveAngle = gun.aim;
    acts.moveMag = 0.26;
  }

  // --- ABILITIES -----------------------------------------------------
  useAbilities(t, mem, world, P, now, acts);
  return acts;
}

/* ================================================================
   Memory / blackboard
   ================================================================ */

function memory(t, now) {
  let m = t.ai;
  if (!m || m.tag !== "v2") {
    m = t.ai = {
      tag: "v2",
      seen: new Map(),      // stimulus id -> when first sensed
      tracks: new Map(),    // tank id -> lagged belief about it
      threats: [],          // incoming fire the bot has actually noticed
      behaviour: "patrol",
      behAt: now,
      target: null,
      gear: null,
      goal: null,
      path: null,
      pathAt: 0,
      pathGoal: null,
      wanderAt: 0,
      thinkAt: 0,
      driveA: null,
      driveM: 0,
      wallDanger: new Array(SLOTS).fill(0),
      mudAhead: new Array(SLOTS).fill(0),  // how sludgy each direction is
      obs: null,           // the obstacle set this bot currently believes in
      obsSig: 0,           // changes when a wall/puddle appears or dies
      lastSlot: null,      // sticky steering choice
      aimSince: 0,
      aimAt: null,
      aimNoise: 0,
      aimNoiseAt: -1e9,
      lastShot: 0,
      abilityAt: 0,
      lineBack: false,      // committed to giving ground along the firing line
      abSince: {},          // ability condition -> when it first became true
      abRoll: {},           // and whether this bot spotted that opportunity
    };
  }
  return m;
}

// True once a stimulus has been in view long enough for the bot to have
// reacted to it. Anything never sensed before starts its clock now and is
// NOT yet actionable — this is what removes instant reactions.
function noticed(mem, id, now, delayMs) {
  const first = mem.seen.get(id);
  if (first === undefined) { mem.seen.set(id, now); return false; }
  return now - first >= delayMs;
}

/* ================================================================
   1. Perception
   ================================================================ */

function perceive(t, mem, world, P, now) {
  const cell = world.cell;
  const reactMs = P.react * 1000;
  const rangePx = P.range * cell;
  const bulletR = world.bulletR ?? 3;

  // --- the reshaped arena: brick walls and mud that players put there.
  // Each one has to be SEEN for a reaction time before this bot will
  // plan around it, which is what lets a wall dropped in someone's face
  // still catch them out.
  const walls = [];
  for (const w of world.walls ?? []) {
    if (!noticed(mem, "w:" + w.by + ":" + w.born, now, reactMs)) continue;
    walls.push(w);
  }
  const mud = [];
  for (const m of world.mud ?? []) {
    if (!noticed(mem, "m:" + m.born + ":" + Math.round(m.x), now, reactMs)) continue;
    mud.push(m);
  }
  // One obstacle set, reused by every query this frame (line of sight,
  // steering, routing) so they can never disagree with each other.
  mem.obs = { rects: world.rects, walls };
  mem.mud = mud;

  // A route is only as good as the map it was planned on. Re-plan the
  // moment the furniture changes rather than waiting out the staleness
  // timer, or a bot drives into a wall that appeared after it committed.
  const sig = obstacleSig(walls, mud);
  if (sig !== mem.obsSig) { mem.obsSig = sig; mem.path = null; }

  // Forget stale stimuli so the map can't grow without bound.
  if (mem.seen.size > 400) {
    for (const [k, v] of mem.seen) if (now - v > 8000) mem.seen.delete(k);
  }

  // --- enemy tracks: a lagged, smoothed belief.
  for (const o of world.tanks) {
    if (o === t || o.dead || o.gone) continue;
    if (sameTeam(t, o, world)) continue;
    const d = Math.hypot(o.x - t.x, o.y - t.y);
    const los = d <= rangePx && corridorClear(t.x, t.y, o.x, o.y, mem.obs, bulletR);
    if (!los) {
      const stale = mem.tracks.get(o.id);
      if (stale) stale.fresh = false;
      continue;
    }
    if (!noticed(mem, "tank:" + o.id, now, reactMs)) continue;

    let tr = mem.tracks.get(o.id);
    if (!tr) {
      tr = { id: o.id, x: o.x, y: o.y, vx: 0, vy: 0, at: now - 16, fresh: true };
      mem.tracks.set(o.id, tr);
    }
    const dtS = Math.max(0.001, (now - tr.at) / 1000);
    const k = Math.min(1, dtS / Math.max(0.02, P.trackLag));
    const nvx = (o.x - tr.x) / dtS, nvy = (o.y - tr.y) / dtS;
    tr.vx += (nvx - tr.vx) * Math.min(1, k * 0.8);
    tr.vy += (nvy - tr.vy) * Math.min(1, k * 0.8);
    tr.x += (o.x - tr.x) * k;
    tr.y += (o.y - tr.y) * k;
    tr.at = now;
    tr.fresh = true;
    tr.ref = o;
  }

  // --- incoming fire it has noticed.
  mem.threats = [];
  const horizon = P.dodgeHorizon;
  for (const b of world.bullets ?? []) {
    if (b.by === t.id) continue;
    if (!noticed(mem, "b:" + b.by + ":" + b.born, now, reactMs * 0.7)) continue;
    const hit = willHit(t, b, world, horizon);
    if (hit) mem.threats.push({ x: b.x, y: b.y, vx: b.vx, vy: b.vy, tca: hit.tca, kind: "bullet" });
  }
  for (const rk of world.rockets ?? []) {
    if (rk.by === t.id) continue;
    if (!noticed(mem, "r:" + rk.by + ":" + rk.born, now, reactMs * 0.7)) continue;
    const hit = willHit(t, rk, world, horizon * 1.6);
    if (hit) mem.threats.push({ x: rk.x, y: rk.y, vx: rk.vx, vy: rk.vy, tca: hit.tca, kind: "rocket" });
  }
  // Beams land instantly — the only counter is not being on the line, so
  // they read as a danger band rather than something to outrun.
  for (const L of world.lasers ?? []) {
    if (L.by === t.id) continue;
    if (!noticed(mem, "l:" + L.by, now, reactMs)) continue;
    const p = nearestOnPolyline(t.x, t.y, L.pts);
    if (p && p.d < world.tankR * 3) mem.threats.push({ near: p, kind: "beam", tca: 0 });
  }
  for (const A of world.snipes ?? []) {
    if (A.by === t.id) continue;
    if (!noticed(mem, "s:" + A.by, now, reactMs)) continue;
    const p = nearestOnPolyline(t.x, t.y, A.pts);
    if (p && p.d < world.tankR * 3) mem.threats.push({ near: p, kind: "beam", tca: 0 });
  }
}

// Will this projectile pass close enough to hit within `horizon` seconds?
// Closest approach in the projectile's own frame.
function willHit(t, b, world, horizon) {
  const rx = t.x - b.x, ry = t.y - b.y;
  const vx = -b.vx, vy = -b.vy;
  const vv = vx * vx + vy * vy;
  if (vv < 1e-6) return null;
  const tca = -(rx * vx + ry * vy) / vv;
  if (tca < 0 || tca > horizon) return null;
  const mx = rx + vx * tca, my = ry + vy * tca;
  const miss = Math.hypot(mx, my);
  const rad = world.tankR + (b.r ?? world.bulletR ?? 3);
  return miss <= rad * 1.25 ? { tca, miss } : null;
}

function sameTeam(a, b, world) {
  const tm = world.teams;
  if (!tm) return false;
  return (tm[a.id] ?? 0) === (tm[b.id] ?? 1e9);
}

/* ================================================================
   3. Decision — utility scoring with commitment
   ================================================================ */

function decide(t, mem, world, P, now) {
  const cell = world.cell;
  const hpFrac = t.hp / Math.max(1, world.maxHp ?? 10);

  let target = null, tdist = Infinity;
  for (const tr of mem.tracks.values()) {
    if (!tr.fresh) continue;
    const d = Math.hypot(tr.x - t.x, tr.y - t.y);
    if (d < tdist) { tdist = d; target = tr; }
  }
  mem.target = target;

  const gear = bestGear(t, mem, world, P, now);
  mem.gear = gear;

  const scores = {
    patrol: 0.25,
    dodge: mem.threats.length ? 0.55 + 0.5 * P.dodge : 0,
    engage: target ? 0.5 + 0.5 * P.aggression - 0.25 * Math.min(1, tdist / (P.range * cell)) : 0,
    retreat: target && hpFrac < 0.34 - 0.12 * P.aggression ? 0.5 + (1 - hpFrac) * 0.6 : 0,
    // Looting is for lulls. With an enemy engaged, only a genuinely
    // valuable pickup is worth breaking off for.
    collect: gear ? gear.want * (target ? 0.45 : 1) : 0,
  };

  // Commitment: the current behaviour gets a bonus, so the bot doesn't
  // dither between two near-equal options on every tick.
  const held = 0.14 + 0.1 * (1 - P.dodge);
  scores[mem.behaviour] = (scores[mem.behaviour] ?? 0) + held;

  let best = "patrol", bestV = -Infinity;
  for (const k in scores) if (scores[k] > bestV) { bestV = scores[k]; best = k; }
  if (best !== mem.behaviour) { mem.behaviour = best; mem.behAt = now; }

  mem.goal = goalFor(t, mem, world, P, now, target, gear);
}

// Keep a goal inside the arena — a flee vector can easily point off the
// map, and a bot chasing a point outside the walls just grinds the edge.
function clampGoal(g, world) {
  const m = world.tankR * 1.2;
  const w = (world.maze?.cols ?? 12) * world.cell;
  const h = (world.maze?.rows ?? 9) * world.cell;
  return { x: Math.max(m, Math.min(w - m, g.x)), y: Math.max(m, Math.min(h - m, g.y)) };
}

function goalFor(t, mem, world, P, now, target, gear) {
  const cell = world.cell;
  switch (mem.behaviour) {
    case "engage": {
      if (!target) return wanderGoal(t, mem, world, now);
      // Hold a standoff ring — but never sit still on it. Because the
      // turret is welded to the hull, a bot that's holding its aim can
      // only travel along the firing line, so it works that line: it
      // presses in and backs off in a slow rhythm, staying a moving
      // target while keeping the gun on. Sharper bots weave faster and
      // less predictably.
      if (mem.jinkPhase === undefined) mem.jinkPhase = Math.random() * Math.PI * 2;
      const rate = 1100 - 500 * P.aggression;
      const swing = Math.sin(now / rate + mem.jinkPhase);
      const want = P.standoff * cell * (1 + 0.42 * swing);
      const ang = Math.atan2(t.y - target.y, t.x - target.x);
      return clampGoal({ x: target.x + Math.cos(ang) * want, y: target.y + Math.sin(ang) * want }, world);
    }
    case "retreat": {
      const heal = nearestGearOf(world, "heal", t);
      if (heal) return { x: heal.x, y: heal.y };
      if (!target) return wanderGoal(t, mem, world, now);
      const ang = Math.atan2(t.y - target.y, t.x - target.x);
      return clampGoal({ x: t.x + Math.cos(ang) * cell * 3, y: t.y + Math.sin(ang) * cell * 3 }, world);
    }
    case "collect":
      return gear ? { x: gear.g.x, y: gear.g.y } : wanderGoal(t, mem, world, now);
    case "dodge":
      // Keep whatever goal we had; steering handles the evasion itself.
      return mem.goal ?? wanderGoal(t, mem, world, now);
    default:
      return wanderGoal(t, mem, world, now);
  }
}

function wanderGoal(t, mem, world, now) {
  const cell = world.cell;
  if (mem.goal && now - mem.wanderAt < 3500 &&
      Math.hypot(mem.goal.x - t.x, mem.goal.y - t.y) > cell * 0.8) return mem.goal;
  mem.wanderAt = now;
  const maze = world.maze;
  if (!maze) return { x: t.x, y: t.y };
  for (let i = 0; i < 12; i++) {
    const c = Math.floor(Math.random() * maze.cols);
    const r = Math.floor(Math.random() * maze.rows);
    if (maze.inside && !maze.inside[r][c]) continue;
    return { x: (c + 0.5) * cell, y: (r + 0.5) * cell };
  }
  return { x: t.x, y: t.y };
}

// Which pickup is worth going for, and how badly.
function bestGear(t, mem, world, P, now) {
  const cell = world.cell;
  const maxHp = world.maxHp ?? 10;
  let best = null;
  for (const g of world.gear ?? []) {
    const cat = WEAPON_CATEGORY[g.type];
    const have = cat === "offense" ? t.weapon : cat === "defense" ? t.defense : t.agility;
    if (have === g.type) continue;
    if (!noticed(mem, "g:" + (g.key ?? g.x + ":" + g.y), now, P.react * 700)) continue;
    const d = Math.hypot(g.x - t.x, g.y - t.y);
    if (d > P.range * cell * 1.2) continue;
    // An empty slot is worth far more than a swap.
    let want = have ? 0.30 : 0.62;
    if (g.type === "heal" && t.hp < maxHp * 0.5) want += 0.35;
    if (g.type === "armour") want += 0.10;
    want *= 1 - Math.min(0.55, d / (P.range * cell * 1.3));
    if (!best || want > best.want) best = { g, want, d };
  }
  return best;
}

function nearestGearOf(world, type, t) {
  let best = null, bd = Infinity;
  for (const g of world.gear ?? []) {
    if (g.type !== type) continue;
    const d = Math.hypot(g.x - t.x, g.y - t.y);
    if (d < bd) { bd = d; best = g; }
  }
  return best;
}

/* ================================================================
   4. Context steering
   ================================================================ */

// Danger from geometry — the maze AND anything players have built.
// Rebuilt on the think tick, because probing the walls is the expensive
// part of the whole brain.
function wallDanger(t, mem, world, rBody) {
  const out = new Array(SLOTS).fill(0);
  // `tankR` is the hull's BOUNDING (diagonal) radius. Using it as the
  // clearance would have the bot believe it can't fit down corridors it
  // actually drives through every day, so probe with something closer to
  // the hull's half-width.
  const clear = rBody * 0.78;
  const far = rBody * 2.6;
  const near = rBody * 1.35;
  const obs = mem.obs ?? { rects: world.rects, walls: [] };
  for (let i = 0; i < SLOTS; i++) {
    const s = SLOT_A[i];
    // Near band: genuinely blocked, this direction is out.
    if (!corridorClear(t.x, t.y, t.x + s.cx * near, t.y + s.cy * near, obs, clear)) {
      out[i] += 1;
      out[(i + 1) % SLOTS] += 0.28;
      out[(i + SLOTS - 1) % SLOTS] += 0.28;
    } else if (!corridorClear(t.x, t.y, t.x + s.cx * far, t.y + s.cy * far, obs, clear)) {
      // Open for now but closes up ahead: mildly discouraged, never vetoed.
      out[i] += 0.25;
    }
  }
  return out;
}

// How much sludge lies each way, 0..1 per direction. Mud is NOT an
// obstacle — it's a toll. A bot that treated it as a wall would refuse
// perfectly good ground; one that ignored it would wade through a
// puddle to reach a pickup it could have driven round. So this comes
// back as a penalty on INTEREST rather than as danger: the direction
// stays available, it just has to be worth the slowdown.
function mudDanger(t, mem, world, rBody) {
  const out = new Array(SLOTS).fill(0);
  const mud = mem.mud;
  if (!mud || !mud.length) return out;
  const reach = rBody * 3.0;
  for (let i = 0; i < SLOTS; i++) {
    const s = SLOT_A[i];
    // Two probes down each spoke: stepping into a puddle costs more
    // than one that only starts a body-length further on.
    for (const [at, weight] of [[0.45, 1], [1.0, 0.55]]) {
      const px = t.x + s.cx * reach * at;
      const py = t.y + s.cy * reach * at;
      for (const m of mud) {
        const dx = px - m.x, dy = py - m.y;
        if (dx * dx + dy * dy < m.r * m.r) { out[i] += weight; break; }
      }
    }
    out[i] = Math.min(1, out[i]);
  }
  return out;
}

function steer(t, mem, world, P, rBody) {
  const interest = new Array(SLOTS).fill(0);
  const danger = mem.wallDanger.slice();

  // --- interest: toward the goal, routed around walls when needed.
  const goal = mem.goal;
  let goalDist = Infinity;
  if (goal) {
    goalDist = Math.hypot(goal.x - t.x, goal.y - t.y);
    const aim = pathHeading(t, mem, world, goal, rBody);
    if (aim != null) {
      for (let i = 0; i < SLOTS; i++) {
        const c = Math.cos(angleDiff(SLOT_A[i].a, aim));
        interest[i] += Math.max(0, c) ** 2;
      }
    }
  }

  // --- danger: other tanks, so bots don't grind against each other.
  for (const o of world.tanks) {
    if (o === t || o.dead || o.gone) continue;
    const dx = o.x - t.x, dy = o.y - t.y;
    const d = Math.hypot(dx, dy);
    if (d > rBody * 4 || d < 1e-3) continue;
    const a = Math.atan2(dy, dx);
    for (let i = 0; i < SLOTS; i++) {
      const diff = Math.abs(angleDiff(SLOT_A[i].a, a));
      if (diff < Math.PI / 2) {
        danger[i] += (1 - diff / (Math.PI / 2)) * (1 - d / (rBody * 4)) * 1.3;
      }
    }
  }

  // --- mud: a toll on interest, not a wall. Crossing a puddle is
  // allowed and sometimes right — it just has to beat going round.
  const mudAhead = mem.mudAhead;
  if (mudAhead) {
    for (let i = 0; i < SLOTS; i++) interest[i] -= mudAhead[i] * MUD_TOLL;
  }

  // --- the dodge. Score every direction by how far the shot would miss
  // if we went that way, so the bot slides off the line instead of
  // backing down it. Skill decides how strongly it weighs this.
  if (mem.threats.length) {
    // Standing in mud, the bot really is slower — so its dodge lookahead
    // has to be shorter, or it plans an evasion it can't physically make
    // and eats the shot while believing it slipped the line.
    const bogged = inMud(t.x, t.y, mem.mud);
    const speed = (world.moveSpeed ?? 130) * P.speed * (bogged ? (world.mudSlow ?? 1) : 1);
    for (const th of mem.threats) {
      if (th.kind === "beam") {
        const a = Math.atan2(t.y - th.near.y, t.x - th.near.x);
        for (let i = 0; i < SLOTS; i++) {
          interest[i] += Math.max(0, Math.cos(angleDiff(SLOT_A[i].a, a))) * 1.5 * P.dodge;
        }
        continue;
      }
      const horizon = Math.min(P.dodgeHorizon, Math.max(0.12, th.tca));
      const px = th.x + th.vx * horizon, py = th.y + th.vy * horizon;
      for (let i = 0; i < SLOTS; i++) {
        const s = SLOT_A[i];
        const fx = t.x + s.cx * speed * horizon;
        const fy = t.y + s.cy * speed * horizon;
        const miss = pointSegDist(fx, fy, th.x, th.y, px, py);
        const safe = Math.min(1, miss / (world.tankR * 3));
        interest[i] += safe * 1.4 * P.dodge;
        if (safe < 0.4) danger[i] += (0.4 - safe) * 4 * P.dodge;
      }
    }
  }

  // --- pick the direction.
  //
  // Danger MASKS and interest CHOOSES. Subtracting one from the other
  // sounds reasonable but fails badly indoors: in a corridor most of the
  // compass is wall, so the danger term buries the goal term and the bot
  // ends up shuffling against the nearest surface instead of driving
  // round it. Instead, throw away only the directions that are clearly
  // worse than the best available, then pick whichever of the survivors
  // best serves the goal. There is always at least one survivor, so a
  // bot can never be pinned by its own scoring.
  let minD = Infinity;
  for (let i = 0; i < SLOTS; i++) if (danger[i] < minD) minD = danger[i];
  const cut = minD + 0.3;

  // Sticky selection. Two neighbouring directions often score within a
  // hair of each other, and picking strictly the best made the choice
  // flip between them frame after frame — a 20-odd Hz shimmy in the hull
  // that reads exactly like a bot constantly correcting itself. Giving
  // the direction already committed to a small bonus means a real change
  // in the situation is needed to turn, not a rounding difference.
  const prevSlot = mem.lastSlot;
  const STICK = 0.14;
  let bi = -1, bv = -Infinity;
  for (let i = 0; i < SLOTS; i++) {
    if (danger[i] > cut) continue;
    let v = interest[i];
    if (prevSlot != null) {
      const off = Math.min(Math.abs(i - prevSlot), SLOTS - Math.abs(i - prevSlot));
      if (off === 0) v += STICK;
      else if (off === 1) v += STICK * 0.5;   // neighbours count as "carrying on"
    }
    if (v > bv) { bv = v; bi = i; }
  }
  if (bi < 0) {                       // everything is equally bad — take the openest
    bi = 0;
    for (let i = 1; i < SLOTS; i++) if (danger[i] < danger[bi]) bi = i;
    bv = interest[bi];
  }

  // Sub-slot refinement: lean toward whichever open neighbour scores
  // better, so headings aren't quantised into 22.5° steps.
  const l = (bi + SLOTS - 1) % SLOTS, r = (bi + 1) % SLOTS;
  const vl = danger[l] > cut ? -1 : interest[l];
  const vr = danger[r] > cut ? -1 : interest[r];
  const denom = Math.abs(vr) + Math.abs(vl) + Math.abs(bv) + 1e-3;
  const a = SLOT_A[bi].a + ((vr - vl) / denom) * (Math.PI / SLOTS);

  // Keep the maps: when the bot holds an aim it can only travel along the
  // firing line, and it still needs to know which end of that line is the
  // safer one to be on.
  mem.mapI = interest; mem.mapD = danger; mem.mapCut = cut;
  mem.lastSlot = bi;

  // Throttle: commit when the way is open, ease off into clutter and on
  // arrival, so the bot settles instead of overshooting and correcting.
  let mag = 0.9;
  if (danger[bi] > 0.25) mag *= 0.7;
  if (goalDist < rBody * 2.2) mag *= Math.max(0.12, goalDist / (rBody * 2.2));
  return { a, mag };
}

// Heading toward the goal: a straight line when the corridor is open,
// otherwise the next reachable waypoint of a cached BFS route.
function pathHeading(t, mem, world, goal, rBody) {
  const obs = mem.obs ?? { rects: world.rects, walls: [] };
  if (corridorClear(t.x, t.y, goal.x, goal.y, obs, rBody * 0.78) &&
      !crossesMud(t.x, t.y, goal.x, goal.y, mem.mud)) {
    mem.path = null;
    return Math.atan2(goal.y - t.y, goal.x - t.x);
  }
  const cell = world.cell;
  const maze = world.maze;
  if (!maze) return Math.atan2(goal.y - t.y, goal.x - t.x);

  const moved = !mem.pathGoal ||
    Math.hypot(goal.x - mem.pathGoal.x, goal.y - mem.pathGoal.y) > cell;
  // Re-plan periodically too: the bot has been driving since the route
  // was made, and a stale route is how bots end up shoving at a corner.
  const stale = world.now - (mem.pathAt ?? 0) > 900;
  // NOTE: an EMPTY route (goal walled off) is a real answer and gets
  // cached like any other — recomputing it every frame just burns the
  // planner on a question that hasn't changed.
  if (!mem.path || moved || stale) {
    mem.pathAt = world.now;
    const from = { c: cellOf(t.x, cell, maze.cols), r: cellOf(t.y, cell, maze.rows) };
    const to = { c: cellOf(goal.x, cell, maze.cols), r: cellOf(goal.y, cell, maze.rows) };
    mem.path = routePath(maze, from, to, cell, obs, mem.mud, rBody);
    mem.pathGoal = { x: goal.x, y: goal.y };
  }
  const path = mem.path;
  if (!path || path.length < 2) return Math.atan2(goal.y - t.y, goal.x - t.x);

  // Carrot point: aim at the furthest waypoint still directly reachable.
  // That's what turns a blocky grid route into a smooth line.
  let pick = 1;
  for (let i = path.length - 1; i >= 1; i--) {
    const wx = (path[i].c + 0.5) * cell, wy = (path[i].r + 0.5) * cell;
    if (corridorClear(t.x, t.y, wx, wy, obs, rBody * 0.78)) { pick = i; break; }
  }
  const wx = (path[pick].c + 0.5) * cell, wy = (path[pick].r + 0.5) * cell;
  if (pick > 0 && Math.hypot(wx - t.x, wy - t.y) < cell * 0.35 && path.length > pick + 1) {
    path.splice(0, pick);
  }
  return Math.atan2(wy - t.y, wx - t.x);
}

// How good is this heading, per the maps the steering just built?
function dirScore(mem, ang) {
  if (!mem.mapI) return 0;
  let i = Math.round((((ang % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)) / (Math.PI * 2) * SLOTS) % SLOTS;
  const blocked = mem.mapD[i] > mem.mapCut;
  return (blocked ? -2 : 0) + mem.mapI[i] - mem.mapD[i];
}

/* ================================================================
   Aiming and firing
   ================================================================ */

function aimAndFire(t, mem, world, P, now, acts) {
  const out = { holdAim: false, aim: t.a, bearing: t.a };
  const target = mem.target;
  if (!target || !target.fresh) { mem.aimAt = null; return out; }

  const cell = world.cell;
  const dist = Math.hypot(target.x - t.x, target.y - t.y);
  const wep = t.weapon || "normal";
  const indirect = wep === "mortar";   // arcs over walls, needs no line

  if (dist > P.fireRange * cell && !indirect) return out;

  // Intercept solution, scaled by how well this tier predicts movement,
  // plus its own slowly-wandering aim wobble.
  const speed = projectileSpeed(wep, world);
  const sol = intercept(t.x, t.y, target.x, target.y, target.vx * P.lead, target.vy * P.lead, speed);
  if (now - mem.aimNoiseAt > 400) {
    mem.aimNoiseAt = now;
    mem.aimNoise = (Math.random() - 0.5) * 2 * P.aimErr;
  }
  // The wobble is a GUNNERY error, so it belongs on the shot, not on the
  // steering. Driving along the noisy vector made the hull chase a
  // heading that jumped every time the wobble was re-rolled, which is a
  // large part of why bots looked like they were constantly correcting.
  const bearing = Math.atan2(sol.y - t.y, sol.x - t.x);
  const aim = bearing + mem.aimNoise;
  out.aim = aim;
  out.bearing = bearing;
  out.holdAim = true;

  // Phase makes a tank intangible: rounds pass straight through. Anyone
  // paying attention keeps the gun on and waits it out rather than
  // emptying the magazine into a ghost. Weaker tiers don't read it.
  if (P.ability > 0.4 && target.ref && now < (target.ref.phaseUntil ?? 0)) return out;

  // A newly acquired target can't be fired on instantly — the bot has to
  // settle onto it first.
  if (mem.aimAt !== target.id) { mem.aimAt = target.id; mem.aimSince = now; }
  if (now - mem.aimSince < P.aimSettle * 1000) return out;

  if (Math.abs(angleDiff(t.a, aim)) > P.aimTol) return out;

  // Ammo: rounds in flight are rounds you don't have.
  if (!indirect) {
    let live = 0;
    for (const b of world.bullets ?? []) if (b.by === t.id) live++;
    if ((world.magSize ?? 3) - live <= P.reserve) {
      // Nothing to fire. Release the firing line so the bot is free to
      // reposition and evade while it reloads instead of standing on the
      // one axis its enemy is already aiming down.
      out.holdAim = false;
      return out;
    }
  }
  if (now - mem.lastShot < (world.magGap ?? 500) * 0.9) return out;

  // Don't shoot a wall, and never shoot a team-mate.
  if (!indirect) {
    const mz = world.muzzle ?? world.tankR;
    const mx = t.x + Math.cos(t.a) * mz, my = t.y + Math.sin(t.a) * mz;
    // A brick wall someone dropped stops a round dead, so it counts as
    // "shooting a wall" every bit as much as the maze does.
    if (!corridorClear(mx, my, target.x, target.y, mem.obs ?? world.rects, world.bulletR ?? 3)) return out;
    for (const o of world.tanks) {
      if (o === t || o.dead || o.gone || !sameTeam(t, o, world)) continue;
      if (pointSegDist(o.x, o.y, t.x, t.y, target.x, target.y) < world.tankR * 1.3) return out;
    }
  }

  // Continuous weapons hold the trigger; everything else taps it.
  if (wep === "mg" || wep === "flame") {
    if (wep === "flame" && dist > FLAME.reachCells * cell * 0.95) return out;
    acts.shoot = true;
    return out;
  }
  acts.shoot = true;
  mem.lastShot = now;
  return out;
}

function projectileSpeed(wep, world) {
  const base = world.bulletSpeed ?? 420;
  if (wep === "rocket") return ROCKET.speed ?? base * 0.8;
  if (wep === "sniper") return base * 3;
  if (wep === "laser") return base * 12;     // effectively instant
  return base;
}

// Iterative intercept: where will the target be when the shot arrives?
function intercept(px, py, tx, ty, tvx, tvy, speed) {
  let tt = 0;
  for (let i = 0; i < 3; i++) {
    const ax = tx + tvx * tt, ay = ty + tvy * tt;
    tt = Math.hypot(ax - px, ay - py) / Math.max(1, speed);
  }
  return { x: tx + tvx * tt, y: ty + tvy * tt, t: tt };
}

/* ================================================================
   Abilities — one rule per item, including as an answer to others
   ================================================================ */

// An ability fires only once its trigger has HELD for a reaction time.
// The old code re-rolled a die every 260 ms, so a bot would sit on a
// perfect opportunity and then use the ability at a random moment — or
// burn it on a condition that had already passed. Now the opportunity is
// spotted once, on the rising edge, and acted on after a delay that
// shortens with skill. Nothing is ever instant.
function abilityReady(mem, key, cond, now, P) {
  if (!cond) { mem.abSince[key] = 0; return false; }
  if (!mem.abSince[key]) {
    mem.abSince[key] = now;
    // Whether this tier even reads the situation is decided once, here —
    // not re-rolled until it happens to come up true.
    mem.abRoll[key] = Math.random() < 0.45 + 0.55 * P.ability;
    return false;
  }
  if (!mem.abRoll[key]) return false;
  // Weaker bots hesitate noticeably longer before committing.
  const wait = P.react * 1000 * (1.5 - 0.6 * P.ability);
  return now - mem.abSince[key] >= wait;
}

function useAbilities(t, mem, world, P, now, acts) {
  if (now - mem.abilityAt < 260) return;      // no frame-perfect chaining
  const cell = world.cell;
  const target = mem.target;
  const dist = target ? Math.hypot(target.x - t.x, target.y - t.y) : Infinity;
  const hpFrac = t.hp / Math.max(1, world.maxHp ?? 10);
  const underFire = mem.threats.length > 0;

  // How soon is the nearest thing going to arrive? Drives the panic
  // abilities — phase in particular is worthless if used too early.
  let soonest = Infinity;
  let beamOnUs = false;
  for (const th of mem.threats) {
    if (th.kind === "beam") { beamOnUs = true; soonest = 0; continue; }
    if (th.tca < soonest) soonest = th.tca;
  }
  // What is the enemy holding? Bots that understand the kit play around
  // it: you don't trade with someone who just put armour up, and a tank
  // that is winding up a slow, heavy shot is worth breaking line on.
  const foe = target?.ref ?? null;
  const foeArmoured = !!foe && (foe.armour ?? 0) > 0;
  const foePhasing = !!foe && now < (foe.phaseUntil ?? 0);
  const foeHeavy = !!foe && (foe.weapon === "sniper" || foe.weapon === "cannon" || foe.weapon === "rocket");

  // --- defence slot
  if (t.defense) {
    let cond = false;
    switch (t.defense) {
      case "armour":
        // Plate goes on for the fight, not on spawn — and it is worth
        // spending early against a heavy hitter rather than after it lands.
        cond = !(t.armour > 0) &&
               (underFire || (target && dist < P.range * cell * 0.7) ||
                (foeHeavy && target && dist < P.range * cell));
        break;
      case "heal":
        // Standing on a pad is a commitment: only worth it out of contact.
        cond = hpFrac < 0.6 && !underFire && (!target || dist > cell * 3);
        break;
      case "wall":
        // Break the line of fire. Most valuable against something that
        // needs that line — beams and slow heavy rounds.
        cond = (underFire && hpFrac < 0.8) ||
               (beamOnUs) ||
               (target && dist < cell * 1.8 && hpFrac < 0.5);
        break;
      case "mud":
        // Dropped behind us as we break away, to slow whoever follows.
        cond = !!target && dist < cell * 2.2 &&
               (mem.behaviour === "retreat" || hpFrac < 0.5);
        break;
    }
    if (abilityReady(mem, "def", cond, now, P)) {
      acts.def = true; mem.abilityAt = now; mem.abSince.def = 0;
      return;
    }
  }

  // --- agility slot
  if (t.agility) {
    let cond = false;
    switch (t.agility) {
      case "phase":
        // Intangibility. The one true answer to a shot that WILL land and
        // to a beam already on the line — but only if spent late enough
        // to still be up when it arrives. Skilled bots cut it finer.
        cond = beamOnUs || (soonest < 0.18 + 0.30 * P.ability);
        break;
      case "boost":
        // Closing, breaking off, beating someone to a pickup — and a way
        // out of a shot when there is no phase to fall back on.
        cond = (mem.behaviour === "retreat") ||
               (mem.behaviour === "collect" && (mem.gear?.d ?? 0) > cell * 2) ||
               (mem.behaviour === "engage" && dist > P.standoff * cell * 2) ||
               (underFire && soonest < 0.4 && P.ability > 0.5);
        break;
    }
    if (abilityReady(mem, "agi", cond, now, P)) {
      acts.agi = true; mem.abilityAt = now; mem.abSince.agi = 0;
    }
  }

  // Unused-but-known: a bot that sees armour or a phase on its target
  // holds its own burst rather than trading into it. Handled in the aim
  // layer; recorded here so the read is in one place.
  mem.foeArmoured = foeArmoured;
  mem.foePhasing = foePhasing;
}

/* ================================================================
   Geometry helpers
   ================================================================ */

// Is this point inside a puddle the bot knows about?
function inMud(x, y, mud) {
  if (!mud) return false;
  for (const m of mud) {
    const dx = x - m.x, dy = y - m.y;
    if (dx * dx + dy * dy < m.r * m.r) return true;
  }
  return false;
}

// A cheap fingerprint of the built terrain. When it changes, something
// was placed or expired and every cached route is suspect.
function obstacleSig(walls, mud) {
  let h = (walls.length * 131 + mud.length) | 0;
  for (const w of walls) h = (h * 31 + (w.born | 0) + (w.hp | 0)) | 0;
  for (const m of mud) h = (h * 31 + (m.born | 0)) | 0;
  return h;
}

function cellOf(v, cell, max) {
  return Math.min(max - 1, Math.max(0, Math.floor(v / cell)));
}

function angleDiff(from, to) {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

function pointSegDist(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const L = dx * dx + dy * dy;
  if (L < 1e-9) return Math.hypot(px - x1, py - y1);
  let u = ((px - x1) * dx + (py - y1) * dy) / L;
  u = Math.max(0, Math.min(1, u));
  return Math.hypot(px - (x1 + dx * u), py - (y1 + dy * u));
}

function nearestOnPolyline(x, y, pts) {
  if (!pts || pts.length < 2) return null;
  let best = null;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const d = pointSegDist(x, y, a.x, a.y, b.x, b.y);
    if (!best || d < best.d) {
      const dx = b.x - a.x, dy = b.y - a.y;
      const L = dx * dx + dy * dy || 1;
      let u = ((x - a.x) * dx + (y - a.y) * dy) / L;
      u = Math.max(0, Math.min(1, u));
      best = { d, x: a.x + dx * u, y: a.y + dy * u };
    }
  }
  return best;
}

// Squared distance from a point to an ORIENTED slab (a player-built
// brick wall), zero if the point is inside it.
function obbGap2(x, y, w) {
  const ca = Math.cos(w.a), sa = Math.sin(w.a);
  const dx = x - w.x, dy = y - w.y;
  const lx = dx * ca + dy * sa;      // along the slab's long axis
  const ly = -dx * sa + dy * ca;     // across its thickness
  const ox = Math.max(0, Math.abs(lx) - w.hx);
  const oy = Math.max(0, Math.abs(ly) - w.hy);
  return ox * ox + oy * oy;
}

// Can a circle of radius r travel the segment without touching anything
// solid? `obs` is the bot's believed obstacle set: the maze's
// axis-aligned rects plus whatever brick walls it has noticed. Passing
// a bare array still works, so callers that only care about the maze
// don't have to build a set.
function corridorClear(x1, y1, x2, y2, obs, r) {
  if (!obs) return true;
  const rects = Array.isArray(obs) ? obs : obs.rects;
  const walls = Array.isArray(obs) ? null : obs.walls;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const d = Math.hypot(dx, dy);
  const steps = Math.max(1, Math.ceil(d / Math.max(1, r * 0.6)));
  for (let i = 1; i <= steps; i++) {
    const x = x1 + (dx * i) / steps;
    const y = y1 + (dy * i) / steps;
    if (rects) {
      for (const rc of rects) {
        const cx = Math.min(rc.x + rc.w, Math.max(rc.x, x));
        const cy = Math.min(rc.y + rc.h, Math.max(rc.y, y));
        const ox = x - cx;
        const oy = y - cy;
        if (ox * ox + oy * oy < r * r) return false;
      }
    }
    if (walls) {
      for (const w of walls) {
        if (obbGap2(x, y, w) < r * r) return false;
      }
    }
  }
  return true;
}

// Does the straight line from A to B wade through a puddle? Used to
// decide whether the direct route is good enough or whether it's worth
// asking the planner for something drier.
function crossesMud(x1, y1, x2, y2, mud) {
  if (!mud || !mud.length) return false;
  for (const m of mud) {
    if (pointSegDist(m.x, m.y, x1, y1, x2, y2) < m.r) return true;
  }
  return false;
}

// Route through the maze, kept strictly inside the arena silhouette so
// a path never hugs a sealed boundary the hull can't cross.
//
// This is a WEIGHTED search, not a plain BFS, because the arena is not
// uniform any more. Two things changed it:
//
//   • A brick wall a player dropped seals a corridor the maze says is
//     open. Those edges are cut, so a route is never planned through
//     something the tank would just grind against.
//   • Mud doesn't block, it costs. A muddy cell is charged extra, so
//     the planner takes a longer clean way round when one exists and
//     still ploughs straight through when it doesn't — which is
//     exactly the judgement a person makes.
//
// Costs are small and the grid is a few hundred cells, so a linear-scan
// Dijkstra is comfortably cheaper than the wall probing that feeds it.
function routePath(maze, from, to, cell, obs, mud, rBody) {
  const key = (c, r) => r * maze.cols + c;
  const isIn = (c, r) =>
    !maze.inside || (r >= 0 && r < maze.rows && c >= 0 && c < maze.cols && maze.inside[r][c]);
  const centre = (c, r) => [(c + 0.5) * cell, (r + 0.5) * cell];
  const clear = rBody * 0.78;
  const walls = (obs && !Array.isArray(obs) ? obs.walls : null) ?? [];

  // Can the hull actually get from one cell centre to the next, given
  // what's been built since the maze was generated?
  const passable = (c0, r0, c1, r1) => {
    if (!walls.length) return true;
    const [x0, y0] = centre(c0, r0);
    const [x1, y1] = centre(c1, r1);
    return corridorClear(x0, y0, x1, y1, { rects: null, walls }, clear);
  };

  // What this cell costs to stand in.
  const tollOf = (c, r) => {
    if (!mud || !mud.length) return 1;
    const [x, y] = centre(c, r);
    return inMud(x, y, mud) ? 1 + MUD_CELL_COST : 1;
  };

  const dist = new Map([[key(from.c, from.r), 0]]);
  const prev = new Map([[key(from.c, from.r), -1]]);
  const open = [[from.c, from.r]];
  const done = new Set();
  const goal = key(to.c, to.r);

  while (open.length) {
    // Cheapest frontier cell.
    let bi = 0;
    for (let i = 1; i < open.length; i++) {
      if (dist.get(key(open[i][0], open[i][1])) < dist.get(key(open[bi][0], open[bi][1]))) bi = i;
    }
    const [c, r] = open.splice(bi, 1)[0];
    const k = key(c, r);
    if (done.has(k)) continue;
    done.add(k);
    if (k === goal) break;

    const steps = [];
    if (!maze.H[r][c] && isIn(c, r - 1)) steps.push([c, r - 1]);
    if (!maze.H[r + 1][c] && isIn(c, r + 1)) steps.push([c, r + 1]);
    if (!maze.V[r][c] && isIn(c - 1, r)) steps.push([c - 1, r]);
    if (!maze.V[r][c + 1] && isIn(c + 1, r)) steps.push([c + 1, r]);

    for (const [nc, nr] of steps) {
      const nk = key(nc, nr);
      if (done.has(nk)) continue;
      if (!passable(c, r, nc, nr)) continue;   // a wall now stands in the gap
      const cost = dist.get(k) + tollOf(nc, nr);
      if (dist.has(nk) && dist.get(nk) <= cost) continue;
      dist.set(nk, cost);
      prev.set(nk, k);
      open.push([nc, nr]);
    }
  }

  const path = [];
  let k = goal;
  if (!prev.has(k)) return path;
  while (k !== -1) {
    path.push({ c: k % maze.cols, r: Math.floor(k / maze.cols) });
    k = prev.get(k);
  }
  path.reverse();
  return path;
}
