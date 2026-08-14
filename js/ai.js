// ================================================================
// ai.js — tank AI
//
// Built to the plan in AI-DESIGN.md. Four stages, run in order, each
// doing one job:
//
//   SENSE   build a BELIEF about the world. Nothing downstream reads the
//           live state, so reaction time is structural rather than a
//           delay bolted on at the end.
//   ASSESS  reduce that belief to a handful of judgements: am I safe,
//           armed, winning, cornered, out-ranged?
//   DECIDE  pick ONE intent by utility — then COMMIT to it. Re-deciding
//           every frame is what makes a bot vibrate instead of act.
//   ACT     turn the intent into steering, gunnery and abilities,
//           honouring the tank's inertia.
//
// The constraint that shapes everything: the turret is welded to the
// hull, so facing IS direction of travel. A tank cannot aim one way and
// drive another. Reverse keeps the gun on target but runs at 69% speed,
// so backing up is a deliberate trade and never a default.
// ================================================================

import { FLAME, MORTAR, SNIPER, ROCKET, MG } from "./weapons.js";

export const AI_LEVELS = ["easy", "medium", "hard", "impossible"];

// Difficulty degrades PERCEPTION AND JUDGEMENT, never the hands. Speed
// and turn stay at 1.0 for every tier: a weak bot should lose because it
// reacted late and dodged one round instead of three, not because it
// drives like it is in treacle.
export const AI_PARAMS = {
  easy: {
    speed: 1, turn: 1,
    react: 0.45,        // s a stimulus must persist before it can be acted on
    lag: 0.30,          // s its picture of a moving target trails reality
    threats: 1,         // how many projectiles it can weigh at once
    bounces: 0,         // how far it follows a ricochet
    aimErr: 0.115,      // rad of standing aim error
    lead: 0.25,         // fraction of the intercept solution it applies
    plan: 420,          // ms between intent decisions
    dwell: 900,         // ms an intent is held before it may change
    settle: 0.34,       // s on a new target before it may fire
    abilitySee: 0.35,   // chance it reads an ability opportunity at all
    phaseErr: 0.30,     // s of error in phase timing
    zoneMath: 0,        // 0 = blind to the zone's cost, 1 = exact
    trick: 0,           // willingness to take a bounce shot
    aggr: 0.45,
  },
  medium: {
    speed: 1, turn: 1,
    react: 0.30, lag: 0.18, threats: 2, bounces: 1,
    aimErr: 0.05, lead: 0.55, plan: 320, dwell: 700, settle: 0.20,
    abilitySee: 0.6, phaseErr: 0.16, zoneMath: 0.4, trick: 0.15, aggr: 0.6,
  },
  hard: {
    speed: 1, turn: 1,
    react: 0.20, lag: 0.10, threats: 3, bounces: 1,
    aimErr: 0.017, lead: 0.85, plan: 240, dwell: 520, settle: 0.12,
    abilitySee: 0.85, phaseErr: 0.07, zoneMath: 0.8, trick: 0.4, aggr: 0.75,
  },
  impossible: {
    speed: 1, turn: 1,
    react: 0.13, lag: 0.05, threats: 99, bounces: 2,
    // Deliberately NOT zero. A bot that never misses is no fun to play
    // against; this is about a third of a tank's width at fighting
    // range, so a good player still takes a fair share of duels.
    aimErr: 0.006, lead: 1.0, plan: 180, dwell: 380, settle: 0.06,
    abilitySee: 1, phaseErr: 0.03, zoneMath: 1, trick: 0.75, aggr: 0.9,
  },
};

// What each gun IS, so a bot plays it rather than just pulling the
// trigger. Ranges in cells.
const GUNS = {
  normal: { hold: false, indirect: false, min: 0,   best: 2.4, max: 7.0, dmg: 3 },
  mg:     { hold: true,  indirect: false, min: 0,   best: 2.0, max: 5.0, dmg: 1 },
  laser:  { hold: false, indirect: false, min: 0,   best: 3.0, max: 8.0, dmg: 7, wantsDirect: true },
  sniper: { hold: false, indirect: false, min: 1.5, best: 4.0, max: SNIPER.rangeCells, dmg: 7 },
  rocket: { hold: false, indirect: false, min: 1.0, best: 3.2, max: 7.0, dmg: 7 },
  cannon: { hold: false, indirect: false, min: 1.2, best: 2.8, max: 6.0, dmg: 5, selfBlast: true },
  mortar: { hold: false, indirect: true,  min: 1.0, best: 3.0, max: MORTAR.rangeCells, dmg: 5 },
  flame:  { hold: true,  indirect: false, min: 0,   best: 0.6, max: FLAME.reachCells, dmg: 1 },
};
const gunOf = (w) => GUNS[w] || GUNS.normal;

const UTILITY = new Set(["armour", "heal", "wall", "mud", "boost", "phase"]);

const DIRS = 24;
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
    shoot: false, def: false, agi: false, moveAngle: null, moveMag: 0,
  };
  if (t.dead || t.gone) return acts;

  sense(t, B, world, P, now);
  assess(t, B, world, P, now);
  if (now >= B.planAt) {
    B.planAt = now + P.plan * (0.85 + Math.random() * 0.3);
    decide(t, B, world, P, now);
  }
  const gun = gunnery(t, B, world, P, now);
  act(t, B, world, P, now, dt, gun, acts);
  abilities(t, B, world, P, now, acts);
  return acts;
}

function brain(t, now) {
  let B = t.ai;
  if (!B || B.v !== 5) {
    B = t.ai = {
      v: 5,
      seen: new Map(),      // stimulus -> when first noticed (reaction gate)
      foes: new Map(),      // id -> lagged belief
      threats: [],
      intent: "hunt",
      intentAt: now,
      target: null,
      goal: null,
      planAt: 0,
      path: null, pathAt: 0, pathKey: "",
      driveA: t.a, driveM: 0,
      lastDir: null,
      aimErr: 0, aimErrAt: -1e9,
      lockId: null, lockAt: 0, shotAt: 0,
      abAt: 0, abSince: {}, abSaw: {},
      hx: t.x, hy: t.y, hAt: now, stuckUntil: 0, stuckA: 0,
      roamAt: 0,
      visited: new Map(),   // cell key -> when we were last there
    };
  }
  return B;
}

// A stimulus is only actionable once it has persisted for the tier's
// reaction time. This is what removes instant reactions everywhere,
// rather than sprinkling delays through the behaviour.
function noticed(B, key, now, ms) {
  const t0 = B.seen.get(key);
  if (t0 === undefined) { B.seen.set(key, now); return false; }
  return now - t0 >= ms;
}

/* ================================================================
   1. SENSE
   ================================================================ */

function sense(t, B, world, P, now) {
  const cell = world.cell;
  const R = world.tankR;

  if (B.seen.size > 400) {
    for (const [k, v] of B.seen) if (now - v > 5000) B.seen.delete(k);
  }

  // ---- enemies ------------------------------------------------------
  // THIS IS A TOP-DOWN GAME WITH THE WHOLE ARENA ON SCREEN. The player
  // can see every tank at every moment, walls or not — so gating a bot's
  // KNOWLEDGE on line of sight was simply wrong, and it produced bots
  // that wandered past an enemy two corridors away because they had no
  // idea it existed. Position is always known, exactly as the player
  // knows it.
  //
  // Line of sight still matters, but only for what it actually governs:
  // whether there is a shot. `seen` therefore means "I can shoot them
  // from here", not "I am aware of them".
  //
  // Skill lives in `lag` — how well a bot TRACKS a moving target for
  // leading — not in whether it knows where the target is.
  for (const o of world.tanks) {
    if (o === t || o.dead || o.gone) continue;
    if (world.teams && world.teams[o.id] === world.teams[t.id]) continue;

    let bel = B.foes.get(o.id);
    if (!bel) {
      bel = { id: o.id, x: o.x, y: o.y, vx: 0, vy: 0, at: now - 16, ref: o };
      B.foes.set(o.id, bel);
    }
    // Track continuously. The belief chases the truth at a rate set by
    // the tier, so a weaker bot is always aiming a little behind a
    // moving target — but it is never ignorant of where that target is.
    const step = Math.max(0.001, (now - bel.at) / 1000);
    const k = Math.min(1, step / Math.max(0.02, P.lag));
    bel.vx += (((o.x - bel.x) / step) - bel.vx) * Math.min(1, k * 0.7);
    bel.vy += (((o.y - bel.y) / step) - bel.vy) * Math.min(1, k * 0.7);
    bel.x += (o.x - bel.x) * k;
    bel.y += (o.y - bel.y) * k;
    bel.at = now;
    bel.ref = o;
    // Can we actually put a round into them from where we stand?
    bel.seen = clearLine(world, t.x, t.y, o.x, o.y, world.bulletR ?? 3);
  }
  for (const [id, f] of B.foes) {
    if (f.ref?.dead || f.ref?.gone) B.foes.delete(id);
  }

  // ---- incoming fire --------------------------------------------------
  B.threats = [];
  const add = (src, key, r, weight) => {
    if (!noticed(B, key, now, P.react * 700)) return;
    // Follow the round through its bounces: a threat model that only
    // looks at the current velocity walks the bot into a shot that is
    // about to come off a wall. Each leg is its own threat.
    const legs = traceShot(world, src, P.bounces, 1.6);
    for (const leg of legs) {
      const hit = closestApproach(t, leg, R + r);
      if (!hit) continue;
      B.threats.push({ t: hit.t + leg.t0, x: leg.x, y: leg.y,
                       vx: leg.vx, vy: leg.vy, w: weight });
      break;                         // the first leg that threatens is enough
    }
  };

  for (const b of world.bullets ?? []) {
    if (b.by === t.id && now - b.born < 200) continue;    // our own, just fired
    add(b, "b" + b.by + b.born, b.r ?? world.bulletR ?? 3, 1);
  }
  for (const rk of world.rockets ?? []) {
    if (rk.by === t.id) continue;
    add(rk, "r" + rk.by + rk.born, rk.r ?? 8, 1.4);       // it steers: worse
  }
  // Beams land instantly — there is nothing to outrun, only a line to
  // not be standing on.
  for (const L of [...(world.lasers ?? []), ...(world.snipes ?? [])]) {
    if (L.by === t.id) continue;
    if (!noticed(B, "beam" + L.by, now, P.react * 1000)) continue;
    const p = nearestOnPath(t.x, t.y, L.pts);
    if (p && p.d < R * 3.5) {
      B.threats.push({ beam: true, t: 0, x: p.x, y: p.y, vx: 0, vy: 0, w: 2 });
    }
  }
  B.threats.sort((a, b) => a.t - b.t);
  // Weaker tiers cannot hold every round in their head — which produces
  // exactly the human failure of dodging the obvious one and walking
  // into the other.
  if (B.threats.length > P.threats) B.threats.length = P.threats;
  B.soonest = B.threats.length ? B.threats[0].t : Infinity;
  if (B.threats.length) B.lastThreatAt = now;
  // Anything hostile in the air nearby counts as being under fire, even
  // if this particular round is going to miss — standing on a healing
  // pad for six seconds during a firefight is how a bot dies on it.
  for (const b of world.bullets ?? []) {
    if (b.by === t.id) continue;
    if (Math.hypot(b.x - t.x, b.y - t.y) < cell * 3) { B.lastThreatAt = now; break; }
  }

  // Coverage memory: note the cell we are standing in. Searching is
  // hopeless without it — a bot that picks random destinations can
  // re-walk the same three rooms for a minute while the enemy sits two
  // corridors away.
  {
    const c = Math.floor(t.x / cell), r = Math.floor(t.y / cell);
    B.visited.set(r * 1000 + c, now);
    if (B.visited.size > 600) {
      for (const [k, v] of B.visited) if (now - v > 30000) B.visited.delete(k);
    }
  }

  // ---- stuck watchdog -------------------------------------------------
  // Steering is a local method and will occasionally trap itself. Watch
  // real displacement rather than trusting that it never happens.
  if (now - B.hAt > 700) {
    const moved = Math.hypot(t.x - B.hx, t.y - B.hy);
    if (moved < R * 0.5 && B.driveM > 0.25 && now > B.stuckUntil) {
      B.stuckUntil = now + 700;
      B.stuckA = mostOpen(t, world, B.driveA + Math.PI);
    }
    B.hx = t.x; B.hy = t.y; B.hAt = now;
  }


}

// March a projectile forward, reflecting off walls, returning each leg.
function traceShot(world, src, bounces, seconds) {
  const legs = [];
  let x = src.x, y = src.y, vx = src.vx ?? 0, vy = src.vy ?? 0;
  const sp = Math.hypot(vx, vy);
  if (sp < 1) return legs;
  let t0 = 0, left = seconds;
  for (let b = 0; b <= bounces; b++) {
    const hit = rayWalls(world, x, y, vx / sp, vy / sp, sp * left);
    const legT = hit ? hit.d / sp : left;
    legs.push({ x, y, vx, vy, t0, dur: legT });
    if (!hit || b === bounces) break;
    x = x + (vx / sp) * hit.d + hit.nx * 0.5;
    y = y + (vy / sp) * hit.d + hit.ny * 0.5;
    const dot = vx * hit.nx + vy * hit.ny;
    vx -= 2 * dot * hit.nx;
    vy -= 2 * dot * hit.ny;
    t0 += legT; left -= legT;
    if (left <= 0) break;
  }
  return legs;
}

// Closest approach of one leg to the tank.
function closestApproach(t, leg, radius) {
  const rx = t.x - leg.x, ry = t.y - leg.y;
  const vx = -leg.vx, vy = -leg.vy;
  const vv = vx * vx + vy * vy;
  if (vv < 1e-6) return null;
  const tca = -(rx * vx + ry * vy) / vv;
  if (tca < 0 || tca > leg.dur) return null;
  const mx = rx + vx * tca, my = ry + vy * tca;
  if (Math.hypot(mx, my) > radius * 1.4) return null;
  return { t: tca };
}

/* ================================================================
   2. ASSESS
   ================================================================ */

function assess(t, B, world, P, now) {
  const cell = world.cell;
  B.hp = t.hp / Math.max(1, world.maxHp ?? 10);
  B.armed = !!t.weapon && t.weapon !== "normal";
  B.gun = gunOf(t.weapon || "normal");

  // Rounds in flight are rounds you do not have, and with 3.5 s regen
  // each, the last one is worth keeping for a defensive shot.
  let live = 0;
  for (const b of world.bullets ?? []) if (b.by === t.id) live++;
  B.ammo = Math.max(0, (world.magSize ?? 3) - live);

  const depth = world.zoneDepthAt ? world.zoneDepthAt(t.x, t.y) : Infinity;
  B.zoneDepth = depth;
  B.inZone = Number.isFinite(depth) && Math.floor(depth) < (world.zoneLevel ?? 0);
  B.zoneSoon = Number.isFinite(depth) && Math.floor(depth) <= (world.zoneWarn ?? -1);

  // Pick the enemy worth thinking about.
  let best = null, bestScore = -Infinity;
  for (const f of B.foes.values()) {
    const d = Math.hypot(f.x - t.x, f.y - t.y) / cell;
    let s = -d;
    if (f.seen) s += 4;      // a target we can actually shoot beats one we can't
    if ((f.ref?.hp ?? 10) <= 3) s += 3;                 // finish the wounded
    if (B.target && f.id === B.target.id) s += 1.2;     // stickiness
    if (s > bestScore) { bestScore = s; best = f; }
  }
  B.target = best;
  B.tdist = best ? Math.hypot(best.x - t.x, best.y - t.y) / cell : Infinity;

  // Read the opponent. Playing around their kit is most of what makes
  // this feel intelligent.
  const foe = best?.ref ?? null;
  B.foePhasing = !!foe && now < (foe.phaseUntil ?? 0);
  B.foeArmoured = !!foe && (foe.armour ?? 0) > 0;
  B.foeHealing = !!foe && (foe.healInMs ?? 0) > 0;
  B.foeHeavy = !!foe && ["sniper", "cannon", "rocket"].includes(foe.weapon);
  B.foeFlame = !!foe && foe.weapon === "flame";
}

/* ================================================================
   3. DECIDE — one intent, then commit
   ================================================================ */

function decide(t, B, world, P, now) {
  const cell = world.cell;
  const gear = pickGear(t, B, world, P);
  B.gearPick = gear;

  const U = {
    // Only relevant when there is genuinely nobody to fight — every
    // living tank is known now, so a bot is never merely "looking" for
    // one it could already see.
    hunt: B.target ? -1 : 2.0,
    fight: B.target ? 2.2 + P.aggr * 1.5 - Math.max(0, B.tdist - B.gun.max) * 0.6 : -9,
    recover: (B.hp < 0.35 ? 2.8 : B.hp < 0.6 ? 1.1 : -9) + (B.ammo === 0 ? 1.2 : 0),
    collect: gear ? 1.5 + gear.value - gear.cost : -9,
    // Being caught in the red is only worth enduring while there is
    // something to gain from it; otherwise get out.
    flee: B.inZone ? (6 - (B.zoneTol ?? 0) * 5) : B.zoneSoon ? 2.2 : -9,
  };

  // A healing enemy is stationary on a known point for six seconds.
  // That is the best attack window in the game, and denying ~7 HP is
  // worth more than landing a hit — so it outranks nearly everything.
  if (B.foeHealing && B.target) U.fight += 3.5;
  // An armoured enemy has +6 HP: the trade maths just changed.
  if (B.foeArmoured) U.fight -= 1.2;
  // Never brawl a flamethrower — its whole threat is a one-cell cone.
  if (B.foeFlame && B.tdist < 1.6) U.fight -= 2.5;

  let pick = "hunt", pv = -Infinity;
  for (const k in U) if (U[k] > pv) { pv = U[k]; pick = k; }

  // COMMITMENT. Only switch if the new option is clearly better, or the
  // current one has run its dwell. This is the difference between a tank
  // with a plan and one that vibrates.
  if (pick !== B.intent) {
    const held = now - B.intentAt;
    const cur = U[B.intent] ?? -Infinity;
    if (held < P.dwell && pv < cur + 1.2) pick = B.intent;
  }
  if (pick !== B.intent) { B.intent = pick; B.intentAt = now; B.bestGd = undefined; }

  if (B.intent === "flee") {
    B.goal = safeSpot(t, world);
  } else if (B.intent === "fight" && B.target) {
    B.goal = B.target.seen ? standoffSpot(t, B, world) : { x: B.target.x, y: B.target.y };
  } else if (B.intent === "collect" && gear) {
    B.goal = { x: gear.x, y: gear.y };
  } else if (B.intent === "recover") {
    B.goal = retreatSpot(t, B, world);
  } else if (!B.goal || now > B.roamAt ||
             Math.hypot(B.goal.x - t.x, B.goal.y - t.y) < cell * 0.8) {
    B.roamAt = now + 6000 + Math.random() * 3000;
    B.goal = B.target ? { x: B.target.x, y: B.target.y } : patrolSpot(t, world, B, now);
  }
}

// Stand off at the range THIS weapon wants. Fighting at the wrong range
// is a common way for a bot to look stupid while doing everything else
// right — a flamethrower needs 0.6 cells, a sniper wants 4.
function standoffSpot(t, B, world) {
  const want = B.gun.best * world.cell;
  const a = Math.atan2(t.y - B.target.y, t.x - B.target.x);
  // The ideal firing position is a point on a circle around the target,
  // and that point is very often INSIDE A WALL. Routing to a spot no
  // tank can occupy fails, the bot falls back to a straight line it
  // cannot drive, and it parks in a corridor doing nothing — which is
  // exactly what the navigation tests were catching. Sweep around the
  // ring for a stance that actually exists, preferring the natural one.
  for (const off of [0, 0.45, -0.45, 0.9, -0.9, 1.4, -1.4, 2.2, -2.2]) {
    const p = { x: B.target.x + Math.cos(a + off) * want,
                y: B.target.y + Math.sin(a + off) * want };
    if (standable(world, p.x, p.y)) return p;
  }
  return { x: B.target.x, y: B.target.y };   // nowhere clean: just go to them
}

// Is there room for a tank here?
function standable(world, x, y) {
  const r = world.tankR * 0.7;
  const w = (world.maze?.cols ?? 12) * world.cell;
  const h = (world.maze?.rows ?? 9) * world.cell;
  if (x < r || y < r || x > w - r || y > h - r) return false;
  for (const rc of world.rects ?? []) {
    if (x > rc.x - r && x < rc.x + rc.w + r && y > rc.y - r && y < rc.y + rc.h + r) return false;
  }
  return true;
}

function retreatSpot(t, B, world) {
  const from = B.target ?? { x: t.x, y: t.y };
  const a = Math.atan2(t.y - from.y, t.x - from.x);
  return clampToArena({ x: t.x + Math.cos(a) * world.cell * 3.5,
                        y: t.y + Math.sin(a) * world.cell * 3.5 }, world);
}

function patrolSpot(t, world, B, nowMs) {
  const mz = world.maze, cell = world.cell;
  const cols = mz?.cols ?? 8, rows = mz?.rows ?? 6;
  const midX = cols * cell * 0.5, midY = rows * cell * 0.5;
  // Weighted toward the middle rather than uniformly random. Two bots
  // patrolling at random can cross a maze for a minute without ever
  // meeting; the centre is where the zone drives everyone eventually,
  // where the sightlines are, and where crates tend to matter — so
  // heading that way finds a fight instead of hoping for one.
  let best = null, bv = -Infinity;
  for (let i = 0; i < 30; i++) {
    const c = Math.floor(Math.random() * cols);
    const r = Math.floor(Math.random() * rows);
    if (mz?.inside && !mz.inside[r][c]) continue;
    const x = (c + 0.5) * cell, y = (r + 0.5) * cell;
    const away = Math.hypot(x - t.x, y - t.y);
    if (away < cell * 2.5) continue;
    if (world.zoneDepthAt &&
        Math.floor(world.zoneDepthAt(x, y)) < (world.zoneLevel ?? 0) + 1) continue;
    // Prefer somewhere we have NOT been recently, lean central, and
    // prefer not to trek the whole map for it. Coverage is what turns
    // aimless wandering into an actual search pattern.
    const last = B.visited?.get(r * 1000 + c) ?? -1e9;
    const fresh = Math.min(1, (nowMs - last) / 20000);      // 0 = just here
    const v = fresh * 3.0
            - Math.hypot(x - midX, y - midY) / cell * 0.45
            - away / cell * 0.30;
    if (v > bv) { bv = v; best = { x, y }; }
  }
  return best ?? { x: t.x, y: t.y };
}

// The nearest ground that is safe NOW and still safe a layer deeper, so
// the bot doesn't flee into cells that die next.
function safeSpot(t, world) {
  const mz = world.maze, cell = world.cell;
  if (!mz || !world.zoneDepthAt) return { x: t.x, y: t.y };
  const need = (world.zoneLevel ?? 0) + 2;
  let best = null, bd = Infinity;
  for (let r = 0; r < mz.rows; r++) {
    for (let c = 0; c < mz.cols; c++) {
      if (mz.inside && !mz.inside[r][c]) continue;
      const x = (c + 0.5) * cell, y = (r + 0.5) * cell;
      const d = world.zoneDepthAt(x, y);
      if (!Number.isFinite(d) || Math.floor(d) < need) continue;
      const dist = Math.hypot(x - t.x, y - t.y);
      if (dist < bd) { bd = dist; best = { x, y }; }
    }
  }
  return best ?? { x: t.x, y: t.y };
}

// Score a crate: value minus what it costs to reach.
function pickGear(t, B, world, P) {
  const cell = world.cell;
  let best = null, bv = -Infinity;
  for (const g of world.gear ?? []) {
    const utility = UTILITY.has(g.type);
    // Another gun when already armed is worth almost nothing — chasing
    // one is what made bots orbit a crate they could not use.
    const dryFlame = t.weapon === "flame" && (t.flameFuel ?? 1e9) < 500;
    if (!utility && B.armed && !dryFlame) continue;
    if (utility && (t.defense === g.type || t.agility === g.type)) continue;

    let value = utility ? 1.4 : 2.2;
    if (g.type === "armour" && B.hp < 0.7) value += 1.6;   // +6 HP beats most guns
    if (g.type === "heal" && B.hp < 0.6) value += 1.8;
    if (!B.armed && !utility) value += 1.4;

    const d = Math.hypot(g.x - t.x, g.y - t.y);
    let cost = d / (cell * 4);
    if (world.zoneDepthAt) {
      const gd = world.zoneDepthAt(g.x, g.y);
      if (!Number.isFinite(gd) || Math.floor(gd) < (world.zoneLevel ?? 0)) continue;
    }
    // Contested: arriving second AND being shot on the way is a bad deal.
    if (B.target) {
      const theirs = Math.hypot(g.x - B.target.x, g.y - B.target.y);
      if (theirs < d * 0.8) cost += 1.5;
      if (clearLine(world, g.x, g.y, B.target.x, B.target.y, 6)) cost += 0.6;
    }
    const s = value - cost;
    if (s > bv) { bv = s; best = { x: g.x, y: g.y, d, type: g.type, value, cost }; }
  }
  return best;
}

/* ================================================================
   4a. NAVIGATION
   ================================================================ */

function routeHeading(t, B, world, goal, now) {
  const R = world.tankR;
  const HALF = R * 0.66;                       // the hull's true half-width
  if (clearLine(world, t.x, t.y, goal.x, goal.y, HALF)) { B.path = null; return null; }
  const mz = world.maze;
  if (!mz?.H || !mz?.V) return null;
  const cell = world.cell;
  const to = { c: cIdx(goal.x, cell, mz.cols), r: cIdx(goal.y, cell, mz.rows) };
  const from = { c: cIdx(t.x, cell, mz.cols), r: cIdx(t.y, cell, mz.rows) };
  const key = to.c + "," + to.r;
  // Re-planning mid-junction is what made bots pirouette: a fresh route
  // can pick a different exit each time it runs.
  if (!B.path || B.pathKey !== key || now - B.pathAt > 2200) {
    B.path = bfs(mz, from, to);
    B.pathAt = now; B.pathKey = key;
  }
  if (!B.path || B.path.length < 2) return null;
  const cx = (n) => (n.c + 0.5) * cell, cy = (n) => (n.r + 0.5) * cell;
  // String-pull: head for the furthest waypoint on a clear line, so the
  // tank cuts corners instead of touring cell centres.
  let pick = 1;
  for (let i = B.path.length - 1; i >= 1; i--) {
    if (clearLine(world, t.x, t.y, cx(B.path[i]), cy(B.path[i]), HALF)) { pick = i; break; }
  }
  while (B.path.length > 2 &&
         Math.hypot(cx(B.path[1]) - t.x, cy(B.path[1]) - t.y) < cell * 0.55) {
    B.path.splice(1, 1); if (pick > 1) pick--;
  }
  return Math.atan2(cy(B.path[pick]) - t.y, cx(B.path[pick]) - t.x);
}

function bfs(mz, from, to) {
  const { cols, rows } = mz;
  const ok = (c, r) => c >= 0 && c < cols && r >= 0 && r < rows &&
                       (!mz.inside || mz.inside[r][c]);
  if (!ok(from.c, from.r) || !ok(to.c, to.r)) return null;
  const key = (c, r) => r * cols + c;
  const prev = new Map(), seen = new Set([key(from.c, from.r)]);
  let frontier = [[from.c, from.r]], found = false;
  while (frontier.length && !found) {
    const next = [];
    for (const [c, r] of frontier) {
      if (c === to.c && r === to.r) { found = true; break; }
      const steps = [];
      if (!mz.H[r][c] && ok(c, r - 1)) steps.push([c, r - 1]);
      if (!mz.H[r + 1][c] && ok(c, r + 1)) steps.push([c, r + 1]);
      if (!mz.V[r][c] && ok(c - 1, r)) steps.push([c - 1, r]);
      if (!mz.V[r][c + 1] && ok(c + 1, r)) steps.push([c + 1, r]);
      for (const [nc, nr] of steps) {
        const k = key(nc, nr);
        if (seen.has(k)) continue;
        seen.add(k); prev.set(k, [c, r]); next.push([nc, nr]);
      }
    }
    frontier = next;
  }
  if (!seen.has(key(to.c, to.r))) return null;
  const path = []; let cur = [to.c, to.r];
  while (cur) {
    path.push({ c: cur[0], r: cur[1] });
    const p = prev.get(key(cur[0], cur[1]));
    if (!p) break;
    cur = p;
  }
  return path.reverse();
}

function navigate(t, B, world, P, now) {
  const R = world.tankR;
  const HALF = R * 0.66;
  const score = new Array(DIRS).fill(0);
  const open = new Array(DIRS).fill(1);

  // Look far enough ahead that the turn starts before contact. A short
  // probe only sees the wall once the nose is on it, by which point the
  // tank is committed and scrapes along the masonry.
  const probe = R * 4.2;
  for (let i = 0; i < DIRS; i++) open[i] = clearance(t, world, RAY[i], probe, HALF) / probe;

  let goalA = null;
  if (B.goal) {
    goalA = routeHeading(t, B, world, B.goal, now) ??
            Math.atan2(B.goal.y - t.y, B.goal.x - t.x);
  }

  for (let i = 0; i < DIRS; i++) {
    if (goalA != null) score[i] += Math.max(0, Math.cos(angDiff(RAY[i].a, goalA))) * 2.0;
    // Reverse is 69% speed, so a backwards heading has to be genuinely
    // better on the merits — otherwise bots trundle around backwards.
    const along = Math.cos(angDiff(RAY[i].a, t.a));
    score[i] += Math.max(0, along) * 2.4 - Math.max(0, -along) * 0.9;
    score[i] *= 0.3 + 0.7 * open[i];
    if (open[i] < 0.45) score[i] -= (0.45 - open[i]) * 14;
  }

  for (const o of world.tanks) {
    if (o === t || o.dead || o.gone) continue;
    const dx = o.x - t.x, dy = o.y - t.y, d = Math.hypot(dx, dy);
    if (d > R * 3 || d < 1e-3) continue;
    const a = Math.atan2(dy, dx), push = (1 - d / (R * 3)) * 2.2;
    for (let i = 0; i < DIRS; i++) {
      const c = Math.cos(angDiff(RAY[i].a, a));
      if (c > 0) score[i] -= c * push;
    }
  }
  for (const m of world.mud ?? []) {
    const dx = m.x - t.x, dy = m.y - t.y, d = Math.hypot(dx, dy);
    const reach = (m.r ?? R * 2) + R;
    if (d > reach || d < 1e-3) continue;
    const a = Math.atan2(dy, dx);
    for (let i = 0; i < DIRS; i++) {
      const c = Math.cos(angDiff(RAY[i].a, a));
      if (c > 0) score[i] -= c * (1 - d / reach) * 0.9;
    }
  }
  if (world.zoneDepthAt && P.zoneMath > 0) {
    const zl = world.zoneLevel ?? 0;
    // HOW MUCH RED IS THIS WORTH? The zone charges 1 HP every 2 s per
    // layer of depth, which makes "should I cut through it to reach
    // them" arithmetic rather than a feeling. Crossing one layer for a
    // few seconds costs a couple of HP — cheap if it finishes a wounded
    // enemy, wasteful if it only repositions. Tolerance scales with what
    // there is to gain and what we can afford to lose.
    let tol = 0;
    if (B.target) {
      const theirHp = (B.target.ref?.hp ?? 10) / Math.max(1, world.maxHp ?? 10);
      const finishing = Math.max(0, 1 - theirHp * 1.6);   // hurt enemy = go
      const canAfford = Math.max(0, B.hp - 0.3);          // and we can take it
      tol = Math.min(0.85, (finishing * 0.9 + P.aggr * 0.35) * canAfford * 1.4);
      // Chasing them THROUGH the zone only makes sense if they are in or
      // beyond it — never wade in after someone standing on safe ground.
      const theirD = world.zoneDepthAt(B.target.x, B.target.y);
      if (Number.isFinite(theirD) && Math.floor(theirD) > zl + 1) tol *= 0.25;
    }
    B.zoneTol = tol;
    const bad = (x, y) => {
      const d = world.zoneDepthAt(x, y);
      if (!Number.isFinite(d)) return 1;
      const L = Math.floor(d);
      // Deeper red hurts proportionally more, and tolerance discounts it.
      if (L < zl) return Math.min(1, (zl - L) * 0.7) * (1 - tol);
      return L === (world.zoneWarn ?? -1) ? 0.5 * (1 - tol * 0.5) : 0;
    };
    const here = bad(t.x, t.y);
    for (let i = 0; i < DIRS; i++) {
      const there = bad(t.x + RAY[i].cx * world.cell * 1.15,
                        t.y + RAY[i].cy * world.cell * 1.15);
      // GATED BY REACHABILITY. Unmultiplied, this term is large enough
      // to overwhelm the wall penalty, so a bot in a corner would drive
      // straight at the masonry because the ground beyond it is safer —
      // and wedge there. Safety is only worth anything down a direction
      // the tank can actually travel; getting AROUND the wall is the
      // route planner's job, not the steering's.
      score[i] -= there * 5 * P.zoneMath * open[i];
      if (here > 0) score[i] += (here - there) * 6 * P.zoneMath * open[i];
    }
  }

  // ---- evasion: WORST CASE across every live round --------------------
  // Scoring each threat independently and adding lets a heading that
  // dodges one shot beautifully while driving into another come out on
  // top. A direction is only as good as the round it handles worst.
  // "A path between active projectiles" is then simply the direction
  // whose worst-case miss is still positive.
  if (B.threats.length) {
    const spd = world.moveSpeed ?? 121;
    const worst = new Array(DIRS).fill(1);
    let urgency = 0;
    for (const th of B.threats) {
      const u = th.beam ? 1 : 1 - Math.min(1, th.t / 0.9);
      if (u > urgency) urgency = u;
      for (let i = 0; i < DIRS; i++) {
        let safe;
        if (th.beam) {
          safe = Math.max(0, Math.cos(angDiff(RAY[i].a,
                   Math.atan2(t.y - th.y, t.x - th.x))));
        } else {
          const lead = Math.min(0.9, Math.max(0.12, th.t));
          // A dodge is only worth taking if the tank can actually get
          // there: 0.5 s to accelerate and 0.28 s to turn are real.
          const reach = spd * lead * Math.max(0.25, Math.cos(angDiff(RAY[i].a, t.a)));
          const fx = t.x + RAY[i].cx * reach, fy = t.y + RAY[i].cy * reach;
          const miss = segDist(fx, fy, th.x, th.y,
                               th.x + th.vx * lead, th.y + th.vy * lead);
          safe = Math.min(1, miss / (R * 3));
        }
        if (safe < worst[i]) worst[i] = safe;
      }
    }
    for (let i = 0; i < DIRS; i++) {
      score[i] += worst[i] * open[i] * 6 * (0.4 + urgency);
      if (worst[i] < 0.35) score[i] -= (0.35 - worst[i]) * 8 * urgency;
    }
  }

  // Sticky choice — near-ties between neighbours used to flip every
  // frame, which reads as a bot vibrating on the spot.
  if (B.lastDir != null) {
    for (let i = 0; i < DIRS; i++) {
      const off = Math.min(Math.abs(i - B.lastDir), DIRS - Math.abs(i - B.lastDir));
      if (off === 0) score[i] += 1.2;
      else if (off === 1) score[i] += 0.8;
      else if (off === 2) score[i] += 0.45;
      else if (off === 3) score[i] += 0.2;
    }
  }

  if (now < B.stuckUntil) return { a: B.stuckA, mag: 1, forced: true };

  let bi = 0;
  for (let i = 1; i < DIRS; i++) if (score[i] > score[bi]) bi = i;
  B.lastDir = bi;
  const l = (bi + DIRS - 1) % DIRS, r = (bi + 1) % DIRS;
  const den = Math.abs(score[l]) + Math.abs(score[r]) + Math.abs(score[bi]) + 1e-3;
  const a = RAY[bi].a + ((score[r] - score[l]) / den) * (Math.PI / DIRS);
  // Move or don't. Arriving is handled by the intent layer picking a new
  // goal, not by creeping the last few pixels.
  const mag = 1;
  return { a, mag, forced: false };
}

/* ================================================================
   4b. GUNNERY
   ================================================================ */

function gunnery(t, B, world, P, now) {
  const out = { want: false, aim: t.a, bearing: t.a, fire: false, hold: false };
  const target = B.target;
  if (!target || !target.seen) { B.lockId = null; return out; }
  const g = B.gun;
  if (B.tdist > Math.min(g.max, 8) || B.tdist < g.min) return out;

  const speed = shotSpeed(t.weapon, world);
  const sol = intercept(t.x, t.y, target.x, target.y,
                        target.vx * P.lead, target.vy * P.lead, speed);
  if (now - B.aimErrAt > 450) {
    B.aimErrAt = now;
    B.aimErr = (Math.random() - 0.5) * 2 * P.aimErr;
  }
  // The wobble is a GUNNERY error, so it belongs on the shot and not on
  // the steering — driving along a noisy vector makes the hull chase a
  // heading that jumps every time the wobble is re-rolled.
  out.bearing = Math.atan2(sol.y - t.y, sol.x - t.x);
  out.aim = out.bearing + B.aimErr;
  out.want = true;

  if (B.lockId !== target.id) { B.lockId = target.id; B.lockAt = now; }
  if (now - B.lockAt < P.settle * 1000) return out;

  // A phasing tank cannot be hit at all. Emptying a magazine into a
  // ghost is the most obviously-dumb thing a bot can do.
  if (B.foePhasing && Math.random() < P.abilitySee) return out;
  if (Math.abs(angDiff(t.a, out.aim)) > 0.10 + P.aimErr) return out;

  const mz = world.muzzle ?? world.tankR;
  const mx = t.x + Math.cos(t.a) * mz, my = t.y + Math.sin(t.a) * mz;

  if (!g.indirect) {                      // mortars arc over everything
    let clear = clearLine(world, mx, my, target.x, target.y, world.bulletR ?? 3);
    // Bank shots. The maths supports them, but only a confident tier
    // takes one, and only when the direct line is genuinely blocked.
    // The laser is excluded: its damage falls 7 -> 1 with bounces.
    if (!clear && P.trick > 0 && !g.wantsDirect && Math.random() < P.trick) {
      clear = bankShotHits(world, mx, my, out.bearing, target, P.bounces);
    }
    if (!clear) return out;

    // Never fire into a wall at point-blank: our own rounds are lethal
    // after 75 ms and they bounce straight back.
    const nose = rayWalls(world, mx, my, Math.cos(t.a), Math.sin(t.a), world.tankR * 2.2);
    if (nose && B.tdist * world.cell > nose.d + world.tankR) return out;
  }
  // The cannon's own shrapnel reaches us if we fire it in our lap.
  if (g.selfBlast && B.tdist < 1.2) return out;

  // Ammo economy: with 3.5 s per round, keep one back unless the kill is
  // on. Hold-trigger guns run on their own fuel instead.
  if (!g.hold && !g.indirect) {
    if (B.ammo <= 0) return out;
    const killShot = (target.ref?.hp ?? 10) <= g.dmg;
    if (B.ammo <= 1 && !killShot && B.threats.length) return out;
    if (now - B.shotAt < (world.magGap ?? 500) * 0.9) return out;
  }
  if (t.weapon === "flame" &&
      ((t.flameFuel ?? FLAME.durationMs) <= 60 || B.tdist > FLAME.reachCells * 0.92)) {
    return out;
  }

  out.fire = true;
  out.hold = g.hold;
  return out;
}

// Does a bounce off the nearby geometry put the round on them?
function bankShotHits(world, x, y, a, target, bounces) {
  if (bounces < 1) return false;
  const legs = traceShot(world,
    { x, y, vx: Math.cos(a) * 400, vy: Math.sin(a) * 400 }, Math.min(2, bounces), 1.4);
  for (let i = 1; i < legs.length; i++) {      // skip the direct leg
    const leg = legs[i];
    const d = segDist(target.x, target.y, leg.x, leg.y,
                      leg.x + leg.vx * leg.dur, leg.y + leg.vy * leg.dur);
    if (d < world.tankR) return true;
  }
  return false;
}

function shotSpeed(w, world) {
  const b = world.bulletSpeed ?? 184;
  if (w === "sniper") return b * (SNIPER.speed ?? 2.1);
  if (w === "rocket") return b * (ROCKET.speed ?? 0.72);
  if (w === "cannon") return b * 0.74;
  if (w === "mg") return b * (MG.speed ?? 1.05);
  if (w === "laser") return 1e5;                   // instant
  if (w === "mortar") return b * 0.9;
  return b;
}

function intercept(px, py, tx, ty, tvx, tvy, speed) {
  const dx = tx - px, dy = ty - py;
  if (!isFinite(speed) || speed > 9000) return { x: tx, y: ty };
  const a = tvx * tvx + tvy * tvy - speed * speed;
  const b = 2 * (dx * tvx + dy * tvy);
  const c = dx * dx + dy * dy;
  let hit = 0;
  if (Math.abs(a) < 1e-6) {
    if (Math.abs(b) > 1e-6) hit = -c / b;
  } else {
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const s = Math.sqrt(disc);
      const cands = [(-b + s) / (2 * a), (-b - s) / (2 * a)].filter((v) => v > 0);
      hit = cands.length ? Math.min(...cands, 3) : 0;
    }
  }
  if (!isFinite(hit) || hit < 0) hit = 0;
  return { x: tx + tvx * hit, y: ty + tvy * hit };
}

/* ================================================================
   4c. ACT — resolve intent into movement
   ================================================================ */

function act(t, B, world, P, now, dt, gun, acts) {
  const R = world.tankR;
  const nav = navigate(t, B, world, P, now);

  // HARD INTERRUPTS. A round about to land, or the ground dying under
  // us, outranks whatever we were doing.
  const urgent = B.soonest < 0.30 || B.inZone;
  let wantA = nav.a, wantM = nav.mag;
  let wantBack = false;   // set only where backing up is the intent

  // The stuck break-out is the other case that genuinely needs reverse:
  // it exists precisely to back out of somewhere, so it must not be
  // clamped into the forward arc.
  if (nav.forced) wantBack = true;
  if (urgent && B.threats.length) wantBack = true;   // any way out will do

  if (gun.want && !urgent && !nav.forced) {
    // Firing posture. The hull has to point at the target, so travel is
    // restricted to the target axis — and which way along it is decided
    // by RANGE, not a score that can flip frame to frame. That flipping
    // was the old shuffle.
    const want = B.gun.best * world.cell;
    const axis = gun.bearing;
    const d = B.tdist * world.cell;
    if (d > want * 1.35) {
      // Close NOSE FIRST: commanding the raw bearing when the hull points
      // away makes the game reverse instead of turning, and the tank
      // trundles the whole way in backwards.
      const off = angDiff(t.a, axis);
      wantA = Math.abs(off) > 1.45 ? t.a + Math.sign(off) * 1.45 : axis;
      wantM = 0.9;
    } else if (d < want * 0.55) {
      wantA = axis + Math.PI; wantM = 1; wantBack = true;   // give ground, gun still on
    } else {
      wantA = axis; wantM = 0;                   // in the pocket: hold and shoot
    }
    // Never drive into something just to keep a shot.
    const two = Math.PI * 2;
    const slot = Math.round((((wantA % two) + two) % two) / two * DIRS) % DIRS;
    if (clearance(t, world, RAY[slot], R * 2.2, R * 0.66) / (R * 2.2) < 0.3) {
      wantA = nav.a; wantM = nav.mag;
    }
  }

  // REVERSE IS OPT-IN. The engine reverses whenever the commanded
  // heading sits more than 90 degrees behind the nose, so a steering
  // solution that happens to point backwards silently turns into
  // moonwalking — and because the forward bias then rewards the nose's
  // direction, the tank oscillates instead of turning around. Unless we
  // deliberately asked to give ground, clamp the command into the
  // forward arc so the only way to go backwards is to mean it.
  if (!wantBack) {
    const off = angDiff(t.a, wantA);
    const LIM = 2.4;                       // ~137 degrees, inside the flip
    if (Math.abs(off) > LIM) wantA = t.a + Math.sign(off) * LIM;
  }

  // Track the wanted heading closely. The hull has its own rotational
  // inertia (0.28 s to reach full turn rate), so it already cannot snap
  // — smoothing here as well just meant the tank pivoted toward a stale
  // heading and then had to correct, which is the double-filtering that
  // made turns look late and vague.
  const rate = nav.forced ? 24 : 18;
  B.driveA += angDiff(B.driveA, wantA) * Math.min(1, dt * rate);
  // driveM is now just "do I want to be moving", not how fast.
  B.driveM += ((wantM > 0.05 ? 1 : 0) - B.driveM) * Math.min(1, dt * 10);

  // THROTTLE IS BINARY: full, or pivot, or reverse. Nothing in between.
  //
  // Two problems this solves at once. Dribbling along at a fraction of
  // throttle for no visible reason looked broken — and it was, since
  // partial throttle came out of arbitrary openness and distance
  // factors rather than any decision. And a tank that keeps driving
  // while it swings onto a new heading turns WIDE: the hull needs
  // 0.28 s to reach full turn rate, during which it is still travelling,
  // so it arcs into the corner it was trying to round. Stopping to
  // pivot removes the arc entirely — the tank rotates on the spot and
  // then drives straight, which is both faster through tight geometry
  // and what a person would do.
  const PIVOT = 1.4;                   // ~34 degrees: past this, turn first
  if (acts.moveAngle == null && B.driveM <= 0.04 && gun.want) {
    // Stationary but still needs the gun brought round. moveAngle alone
    // turns the hull; zero throttle keeps it planted.
    acts.moveAngle = gun.bearing;
    acts.moveMag = 0;
  } else if (B.driveM > 0.04) {
    acts.moveAngle = B.driveA;
    // Deflection measured the way the engine measures it — behind the
    // nose counts as reverse, not as a 180 degree turn.
    let off = Math.abs(angDiff(t.a, B.driveA));
    if (off > Math.PI / 2) off = Math.PI - off;
    acts.moveMag = off > PIVOT ? 0 : 1;
  } else if (gun.want) {
    acts.moveAngle = gun.bearing;
    acts.moveMag = 0;
  }
  if (gun.fire) {
    acts.shoot = true;
    if (!gun.hold) B.shotAt = now;
  }
}

/* ================================================================
   4d. ABILITIES
   ================================================================ */

// A trigger has to hold for a reaction time before it is acted on, and
// whether this tier even reads the opportunity is decided ONCE when it
// appears — not re-rolled every tick until it happens to come up true.
function ready(B, key, cond, now, P) {
  if (!cond) { B.abSince[key] = 0; return false; }
  if (!B.abSince[key]) {
    B.abSince[key] = now;
    B.abSaw[key] = Math.random() < P.abilitySee;
    return false;
  }
  if (!B.abSaw[key]) return false;
  return now - B.abSince[key] >= P.react * 1000;
}

function abilities(t, B, world, P, now, acts) {
  if (now - B.abAt < 250) return;
  const cell = world.cell;
  const beam = B.threats.some((x) => x.beam);
  const d = B.tdist;

  // ---- defence --------------------------------------------------------
  if (t.defense) {
    let cond = false;
    switch (t.defense) {
      case "armour":
        // +6 HP is worth more than most weapons deal. Prevention, so it
        // goes on BEFORE the exchange — and never while it is still up.
        cond = (t.armour ?? 0) <= 0 &&
               (B.threats.length > 0 || (B.target && d < 4) ||
                (B.foeHeavy && B.target && d < 6));
        break;
      case "heal":
        // ~7 HP, but it needs six seconds of standing on a small pad.
        // Dropping it while being shot just makes us a stationary target
        // on a known point.
        // Six seconds standing on a small pad, so it needs a real lull —
        // not the half-second gap between two incoming rounds. Track
        // when we were last threatened and require that to be a while
        // ago, or the bot heals mid-firefight and dies on the pad.
        cond = B.hp < 0.6 && !B.inZone &&
               (now - (B.lastThreatAt ?? -1e9)) > 1800 &&
               (!B.target || !B.target.seen || d > 3.5);
        break;
      case "wall":
        // Breaks a line of fire — best against the things that need one.
        cond = beam || (B.threats.length > 0 && B.hp < 0.8) ||
               (B.target && d < 2 && B.hp < 0.5);
        break;
      case "mud":
        // Laid behind us as we break away, or on ground they must cross.
        // Never on ground we need ourselves.
        cond = !!B.target && d < 2.5 && !B.inZone &&
               (B.intent === "recover" || B.hp < 0.5);
        break;
    }
    if (ready(B, "def", cond, now, P)) {
      acts.def = true; B.abAt = now; B.abSince.def = 0; return;
    }
  }

  // ---- agility ---------------------------------------------------------
  if (t.agility) {
    let cond = false;
    switch (t.agility) {
      case "phase": {
        // One second of intangibility, and the sharpest skill expression
        // in the kit: spent 0.8 s early it lapses before the shot lands.
        // Fire it late, with a tier-scaled timing error.
        const err = (Math.random() - 0.5) * 2 * P.phaseErr;
        cond = beam || B.soonest < 0.22 + err;
        break;
      }
      case "boost":
        // 1.4x for six seconds: closing, escaping, racing for a crate,
        // outrunning the zone. NOT a dodge — half a second to accelerate
        // is far too slow to beat a bullet.
        cond = (B.intent === "flee") ||
               (B.intent === "recover" && B.target && d < 3) ||
               (B.intent === "collect" && (B.gearPick?.d ?? 0) > cell * 2.5) ||
               (B.intent === "fight" && d > B.gun.max * 1.2);
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

function cIdx(v, cell, n) { return Math.max(0, Math.min(n - 1, Math.floor(v / cell))); }

function clampToArena(p, world) {
  const w = (world.maze?.cols ?? 12) * world.cell;
  const h = (world.maze?.rows ?? 9) * world.cell;
  return { x: Math.max(world.tankR, Math.min(w - world.tankR, p.x)),
           y: Math.max(world.tankR, Math.min(h - world.tankR, p.y)) };
}

function segDist(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1, L = dx * dx + dy * dy;
  let s = L > 1e-9 ? ((px - x1) * dx + (py - y1) * dy) / L : 0;
  s = Math.max(0, Math.min(1, s));
  return Math.hypot(px - (x1 + dx * s), py - (y1 + dy * s));
}

function nearestOnPath(x, y, pts) {
  if (!pts || pts.length < 2) return null;
  let bd = Infinity, bx = 0, by = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const dx = b.x - a.x, dy = b.y - a.y, L = dx * dx + dy * dy;
    let s = L > 1e-9 ? ((x - a.x) * dx + (y - a.y) * dy) / L : 0;
    s = Math.max(0, Math.min(1, s));
    const px = a.x + dx * s, py = a.y + dy * s;
    const d = Math.hypot(x - px, y - py);
    if (d < bd) { bd = d; bx = px; by = py; }
  }
  return { d: bd, x: bx, y: by };
}

// Distance along a ray to the nearest wall, with the surface normal, so
// a projectile can be reflected off it.
function rayWalls(world, ox, oy, dx, dy, maxD) {
  let best = null;
  for (const r of world.rects ?? []) {
    const h = raySlab(ox, oy, dx, dy, maxD, r.x, r.y, r.x + r.w, r.y + r.h);
    if (h && (!best || h.d < best.d)) best = h;
  }
  for (const w of world.walls ?? []) {
    if ((w.hp ?? 1) <= 0) continue;
    const c = Math.cos(-w.a), s = Math.sin(-w.a);
    const lx = (ox - w.x) * c - (oy - w.y) * s;
    const ly = (ox - w.x) * s + (oy - w.y) * c;
    const ldx = dx * c - dy * s, ldy = dx * s + dy * c;
    const h = raySlab(lx, ly, ldx, ldy, maxD, -w.hx, -w.hy, w.hx, w.hy);
    if (h && (!best || h.d < best.d)) {
      best = { d: h.d,
               nx: h.nx * Math.cos(w.a) - h.ny * Math.sin(w.a),
               ny: h.nx * Math.sin(w.a) + h.ny * Math.cos(w.a) };
    }
  }
  return best;
}

function raySlab(ox, oy, dx, dy, maxD, x1, y1, x2, y2) {
  let tmin = 0, tmax = maxD, nx = 0, ny = 0;
  const axes = [[ox, dx, x1, x2, 0], [oy, dy, y1, y2, 1]];
  for (const [o, d, lo, hi, ax] of axes) {
    if (Math.abs(d) < 1e-9) { if (o < lo || o > hi) return null; continue; }
    let t1 = (lo - o) / d, t2 = (hi - o) / d, sign = -1;
    if (t1 > t2) { const s = t1; t1 = t2; t2 = s; sign = 1; }
    if (t1 > tmin) { tmin = t1; nx = ax === 0 ? sign : 0; ny = ax === 1 ? sign : 0; }
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return null;
  }
  if (tmin <= 0 || tmin > maxD) return null;
  return { d: tmin, nx, ny };
}

function clearance(t, world, ray, maxD, halfW) {
  let d = maxD;
  for (const r of world.rects ?? []) {
    const h = raySlab(t.x, t.y, ray.cx, ray.cy, maxD,
                      r.x - halfW, r.y - halfW, r.x + r.w + halfW, r.y + r.h + halfW);
    if (h && h.d < d) d = h.d;
  }
  for (const w of world.walls ?? []) {
    if ((w.hp ?? 1) <= 0) continue;
    if (segHitsBox(t.x, t.y, t.x + ray.cx * maxD, t.y + ray.cy * maxD, w, halfW)) {
      const dd = Math.max(0, Math.hypot(w.x - t.x, w.y - t.y) - Math.max(w.hx, w.hy) - halfW);
      if (dd < d) d = dd;
    }
  }
  return Math.max(0, d);
}

function mostOpen(t, world, prefer) {
  let bi = 0, bv = -Infinity;
  for (let i = 0; i < DIRS; i++) {
    const c = clearance(t, world, RAY[i], world.tankR * 3, world.tankR * 0.66);
    const v = c + Math.cos(angDiff(RAY[i].a, prefer)) * world.tankR;
    if (v > bv) { bv = v; bi = i; }
  }
  return RAY[bi].a;
}

function segHitsBox(x1, y1, x2, y2, w, pad) {
  const c = Math.cos(-w.a), s = Math.sin(-w.a);
  const ax = x1 - w.x, ay = y1 - w.y, bx = x2 - w.x, by = y2 - w.y;
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
  const dx = x2 - x1, dy = y2 - y1, L = Math.hypot(dx, dy);
  if (L < 1e-9) {
    return x1 >= rc.x - r && x1 <= rc.x + rc.w + r &&
           y1 >= rc.y - r && y1 <= rc.y + rc.h + r;
  }
  return !!raySlab(x1, y1, dx / L, dy / L, L,
                   rc.x - r, rc.y - r, rc.x + rc.w + r, rc.y + rc.h + r);
}
