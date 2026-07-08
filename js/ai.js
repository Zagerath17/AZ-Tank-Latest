// ================================================================
// ai.js — bot drivers: easy / medium / hard / impossible.
//
// A bot outputs the SAME actions a human does ({up, down, left,
// right, shoot}), so it obeys identical movement, wall hard-stop,
// and shooting rules — no cheating physics.
//
// The brain, per frame, in priority order:
//   1. ESCAPE  — jam recovery (rare now that corridors are wide)
//   2. DODGE   — simulate every nearby bullet's future path,
//                bounces included; if one is going to hit us, break
//                perpendicular off its line (skill-gated per tier)
//   3. SHOOT   — aim with velocity lead (higher tiers), and VERIFY
//                the shot first by tracing the bullet's actual
//                bouncing path: never fire a shot that comes back
//                on us; Impossible only fires shots the trace says
//                will land — which lets it take bank shots too
//   4. DRIVE   — pursue via BFS through the maze with steering that
//                can reverse, so intersections flow instead of
//                stalling on three-point turns
// ================================================================

import { segmentHitsAnyRect } from "./maze.js";
import { ROCKET } from "./weapons.js";

export const AI_LEVELS = ["easy", "medium", "hard", "impossible"];

// speed/turn are multipliers on the HUMAN rates and are capped at
// 1.0 — bots can never out-drive or out-turn a player. `react` is
// the human-like delay between noticing a stimulus (incoming
// bullet, target appearing) and responding to it. `reserve`: with
// this few shots left, a bot only spends them on verified hits.
export const AI_PARAMS = {
  easy: {
    speed: 0.75, turn: 0.82, react: 0.60,
    aimErr: 0.22,       // random aim wobble (radians)
    aimTol: 0.20,       // required alignment before firing
    range: 5,           // awareness range (cells)
    fireRange: 4.5,     // won't fire beyond this (cells)
    cooldown: 2.0,
    fireProb: 0.75,
    dodgeSkill: 0,      // never dodges
    dodgeHorizon: 0,
    lead: 0,            // no movement prediction
    selfCheckT: 0.35,   // barely checks its own ricochets — still fumbles sometimes
    verifyHit: false,
    verifyBeyond: 99,   // easy never verifies hits — sprays
    standoff: 0.9,      // fights up close (easier to punish)
    reserve: 0,
  },
  medium: {
    speed: 0.88, turn: 0.96, react: 0.40,
    aimErr: 0.09, aimTol: 0.12, range: 8, fireRange: 5.5, cooldown: 1.25, fireProb: 0.92,
    dodgeSkill: 0.55, dodgeHorizon: 0.8,
    lead: 0,
    selfCheckT: 0.9,    // won't shoot itself
    verifyHit: false,
    verifyBeyond: 4,    // long shots must trace to a hit
    standoff: 1.5,
    reserve: 1,
  },
  hard: {
    speed: 1.0, turn: 1.0, react: 0.30,
    aimErr: 0.035, aimTol: 0.07, range: 13, fireRange: 6.5, cooldown: 0.95, fireProb: 1,
    dodgeSkill: 0.92, dodgeHorizon: 1.05,
    lead: 0.65,         // partial movement prediction
    selfCheckT: 1.7,
    verifyHit: false,
    verifyBeyond: 3.5,  // long shots must trace to a hit
    push: true,         // rushes enemies who are out of ammo
    standoff: 2.1,
    reserve: 1,
  },
  impossible: {
    speed: 1.0, turn: 1.0, react: 0.20,
    aimErr: 0.008, aimTol: 0.055, range: 99, fireRange: 7, cooldown: 0.5, fireProb: 1,
    dodgeSkill: 1, dodgeHorizon: 1.35,
    lead: 1,            // full intercept prediction
    selfCheckT: 1.8,
    verifyHit: true,    // only fires traced, landing shots — bank shots included
    push: true,         // rushes enemies who are out of ammo
    standoff: 2.2,
    reserve: 2,
  },
};

// Escape maneuvers tried when jammed; a wedged rectangle may have
// only ONE free action, so we cycle (with randomness → no livelock).
const ESCAPES = [
  { down: true, left: true },
  { down: true, right: true },
  { up: true, right: true },
  { up: true, left: true },
  { down: true },
];

/* ================================================================
   Main driver
   ================================================================ */

// world = { cell, maze, rects, tanks, tankR, bullets, bulletSpeed,
//           bulletR, muzzle }; now in ms, dt in seconds.
export function botActions(t, world, dt, now) {
  const P = AI_PARAMS[t.bot];
  const ai = (t.ai ??= {
    path: [], tgKey: "", repathAt: 0,
    lastX: t.x, lastY: t.y, lastA: t.a,
    stuckT: 0, revUntil: 0, escMode: 0, jamX: t.x, jamY: t.y,
    wantedMove: false, wantedTurn: false,
    fireAt: now + 500 + Math.random() * 900,
    wobble: 0, wobbleAt: 0,
    threat: null, threatScanAt: 0, pendingAt: 0, alertUntil: 0,
    hazPt: null, hazUntil: 0,
    prevLos: false,
    vel: {},
  });

  const acts = { up: false, down: false, left: false, right: false, shoot: false };
  const cell = world.cell;
  const rBody = (world.tankR ?? cell * 0.23) * 1.05;

  // Ammo awareness: count our own live bullets exactly like a player
  // watching their shots fly. Never dry-fire; when down to the
  // reserve, only spend rounds on shots verified to land.
  let liveShots = 0;
  if (world.bullets) {
    for (const b of world.bullets) if (b.by === t.id && !b.mini) liveShots++;
  }
  const ammo = (world.maxBullets ?? 5) - liveShots;
  const special = t.weapon ?? null; // a picked-up weapon fires outside the cap
  const canFire = ammo > 0 || !!special;
  const sureShotsOnly = !special && ammo <= P.reserve;

  /* ---- 1. escape mode ---- */
  if (now < ai.revUntil) {
    const esc = ESCAPES[ai.escMode % ESCAPES.length];
    if (esc.up) acts.up = true;
    if (esc.down) acts.down = true;
    if (esc.left) acts.left = true;
    if (esc.right) acts.right = true;
    return acts;
  }

  // Stuck detection (movement OR rotation blocked while intended).
  const movedSq = (t.x - ai.lastX) ** 2 + (t.y - ai.lastY) ** 2;
  const turned = Math.abs(angleDiff(ai.lastA, t.a));
  ai.lastX = t.x; ai.lastY = t.y; ai.lastA = t.a;
  const moveStuck = ai.wantedMove && movedSq < (dt * cell * 0.2) ** 2;
  const turnStuck = ai.wantedTurn && turned < dt * 0.4;
  ai.stuckT = moveStuck || turnStuck ? ai.stuckT + dt : 0;
  if (ai.stuckT > 0.55) {
    ai.stuckT = 0;
    const progressed = (t.x - ai.jamX) ** 2 + (t.y - ai.jamY) ** 2 > (cell * 0.4) ** 2;
    ai.escMode = progressed ? Math.floor(Math.random() * ESCAPES.length) : ai.escMode + 1;
    ai.jamX = t.x; ai.jamY = t.y;
    ai.revUntil = now + 350 + Math.random() * 350;
    ai.repathAt = 0;
  }

  /* ---- 2. dodge incoming bullets (after a human reaction delay) ---- */
  let dodging = false;
  if (P.dodgeSkill > 0 && world.bullets && world.bullets.length) {
    if (now >= ai.threatScanAt) {
      ai.threatScanAt = now + 70;
      const th = findThreat(t, world, P.dodgeHorizon, now);
      if (!th) {
        ai.pendingAt = 0;
      } else if (ai.threat) {
        // Already reacting — keep tracking the live threat.
        ai.threat = mkThreat(th, now);
        ai.alertUntil = now + 500;
      } else if (now < ai.alertUntil) {
        // Just finished dodging something — still alert, no fresh delay.
        ai.threat = mkThreat(th, now);
        ai.alertUntil = now + 500;
      } else {
        // Stimulus noticed — the response starts `react` seconds later.
        if (!ai.pendingAt) ai.pendingAt = now + P.react * 1000;
        if (now >= ai.pendingAt) {
          ai.pendingAt = 0;
          if (Math.random() < P.dodgeSkill) {
            ai.threat = mkThreat(th, now);
            ai.alertUntil = now + 500;
          } else {
            ai.threatScanAt = now + 300; // flinched but froze — skill gap
          }
        }
      }
    }
    if (ai.threat && now > ai.threat.until) ai.threat = null;
    if (ai.threat) {
      dodging = true;
      dodgeSteer(t, ai.threat, world, rBody, acts, now);
    }
  }

  /* ---- 2b. weapon hazards: flee homing rockets, step off laser lines ---- */
  let hazardSteer = false;
  if (!dodging && P.dodgeSkill > 0) {
    // A rocket hunting US: run. Distance (and broken line of sight)
    // is life — its fuse and wall-death are the only ways out.
    if (world.rockets && world.rockets.length) {
      const rk = rocketHuntingMe(t, world, now);
      if (rk) {
        hazardSteer = true;
        fleeRocket(t, ai, rk, world, rBody, acts, now);
      }
    }
    // Standing on someone's laser aiming line = instant death the
    // moment they tap fire. Step off it.
    if (!hazardSteer && world.lasers && world.lasers.length) {
      for (const L of world.lasers) {
        if (L.by === t.id) continue;
        const near = nearestOnPolyline(t.x, t.y, L.pts);
        if (near && near.d < (world.tankR ?? 22) + world.cell * 0.2) {
          hazardSteer = true;
          sidestepLine(t, ai, L, world, rBody, acts, now);
          break;
        }
      }
    }
  }

  /* ---- 3. target selection + velocity tracking ---- */
  let target = null;
  let best = Infinity;
  for (const o of world.tanks) {
    if (o === t || o.dead || o.gone) continue;
    trackVel(ai, o, now);
    const d = (o.x - t.x) ** 2 + (o.y - t.y) ** 2;
    if (d < best) { best = d; target = o; }
  }
  if (!target) return finish(ai, acts);

  const dist = Math.sqrt(best);
  const los =
    dist < P.range * cell &&
    !segmentHitsAnyRect(t.x, t.y, target.x, target.y, world.rects);

  // Reaction delay on ACQUIRING a target: when someone first comes
  // into view, the bot needs `react` seconds before it can shoot.
  if (los && !ai.prevLos) ai.fireAt = Math.max(ai.fireAt, now + P.react * 1000);
  ai.prevLos = los;

  /* ---- 4. shooting ---- */
  if (now > ai.wobbleAt) {
    ai.wobbleAt = now + 450;
    ai.wobble = (Math.random() * 2 - 1) * P.aimErr;
  }

  let combatSteered = false;
  if (los) {
    // Aim point: lead the target by its tracked velocity (per tier).
    const tv = ai.vel[target.id];
    let aimX = target.x;
    let aimY = target.y;
    const tvSpeed = tv ? Math.hypot(tv.vx, tv.vy) : 0;
    if (P.lead > 0 && tv && tvSpeed > 25) {
      let eta = dist / world.bulletSpeed;
      for (let i = 0; i < 2; i++) { // fixed-point refine
        aimX = target.x + tv.vx * eta * P.lead;
        aimY = target.y + tv.vy * eta * P.lead;
        eta = Math.hypot(aimX - t.x, aimY - t.y) / world.bulletSpeed;
      }
    }

    const wantW = Math.atan2(aimY - t.y, aimX - t.x) + ai.wobble;

    // Combat movement (when not busy dodging): hold the standoff
    // band — advance when far, KITE backward when the enemy pushes
    // in, gun on target the whole time. Higher tiers keep range,
    // where their reaction time can actually beat incoming shots.
    if (!dodging && !hazardSteer) {
      combatSteered = true;
      const errW = angleDiff(t.a, wantW);
      if (errW > 0.05) acts.right = true;
      else if (errW < -0.05) acts.left = true;
      // Ammo read on the TARGET too: an enemy with nothing left to
      // fire is safe to rush (smart tiers only).
      let band = P.standoff * cell;
      if (P.push && world.bullets) {
        let theirs = 0;
        for (const b of world.bullets) if (b.by === target.id && !b.mini) theirs++;
        if (theirs >= (world.maxBullets ?? 5)) band = cell * 0.6;
      }
      if (dist > band * 1.15) {
        if (Math.abs(errW) < 0.8) acts.up = true;
      } else if (dist < band * 0.85) {
        if (Math.abs(errW) < 1.0) acts.down = true; // back up, keep aiming
      }
    }

    // Fire when aligned and in effective range — but VERIFY the
    // ricochet path first, and respect the ammo count: never
    // dry-fire; on reserve rounds, only shots verified to land.
    const aligned = Math.abs(angleDiff(t.a, wantW)) < P.aimTol;
    const inFireRange = dist <= P.fireRange * cell;
    const mediumHold = t.bot === "medium" && dodging; // medium can't multitask
    if (aligned && inFireRange && !mediumHold && canFire && now >= ai.fireAt) {
      if (special) {
        // Pickup weapons fire on a clean look — no ricochet trace
        // needed. Exception: the cannon's shrapnel comes back through
        // walls, so it wants room.
        if (special !== "cannon" || dist > cell * 2.2) {
          ai.fireAt = now + 650;
          acts.shoot = true;
        } else {
          ai.fireAt = now + 200; // too close to shell — reposition
        }
      } else {
        const v = traceShot(t, world, P, ai);
        const needHit = P.verifyHit || sureShotsOnly || dist > (P.verifyBeyond ?? 99) * cell;
        if (v.safe && (!needHit || v.hits)) {
          ai.fireAt = now + P.cooldown * 1000 * (0.8 + Math.random() * 0.4);
          if (Math.random() < P.fireProb) acts.shoot = true;
        } else {
          ai.fireAt = now + 220; // bad angle — hold fire, reposition
        }
      }
    }
  } else if (P.verifyHit && canFire && now >= ai.fireAt) {
    // Impossible, no line of sight: opportunistic BANK shots.
    if (special === "rocket") {
      ai.fireAt = now + 800;
      acts.shoot = true; // fire and forget — it finds its own way
    } else if (special !== "cannon") {
      const v = traceShot(t, world, P, ai);
      if (v.safe && v.hits) {
        ai.fireAt = now + P.cooldown * 1000;
        acts.shoot = true;
      } else {
        ai.fireAt = now + 150;
      }
    }
  }

  /* ---- 5. navigation ---- */
  if (!dodging && !hazardSteer && !combatSteered) {
    // Bare barrel + a weapon crate on the floor? Worth a detour —
    // but only when we don't already carry one.
    let goal = target;
    if (!special && world.gear && world.gear.length) {
      let g = null;
      let gBest = Infinity;
      for (const it of world.gear) {
        const d = (it.x - t.x) ** 2 + (it.y - t.y) ** 2;
        if (d < gBest) { gBest = d; g = it; }
      }
      if (g && (gBest < best || gBest < (cell * 3.5) ** 2)) goal = g;
    }
    navigate(t, ai, goal, world, P, rBody, now, acts);
  }

  return finish(ai, acts);
}

function finish(ai, acts) {
  ai.wantedMove = acts.up || acts.down;
  ai.wantedTurn = acts.left || acts.right;
  return acts;
}

/* ================================================================
   Navigation — BFS path + reverse-capable steering
   ================================================================ */

function navigate(t, ai, target, world, P, rBody, now, acts) {
  const cell = world.cell;
  const myCell = { c: cellOf(t.x, cell, world.maze.cols), r: cellOf(t.y, cell, world.maze.rows) };
  const tgCell = { c: cellOf(target.x, cell, world.maze.cols), r: cellOf(target.y, cell, world.maze.rows) };
  const tgKey = tgCell.c + "," + tgCell.r;

  if (now > ai.repathAt || !ai.path.length || ai.tgKey !== tgKey) {
    ai.path = bfsPath(world.maze, myCell, tgCell);
    ai.tgKey = tgKey;
    ai.repathAt = now + 600;
  }

  // Consume reached waypoints — tighter before corners so the tank
  // swings wide of wall ends instead of clipping them.
  while (ai.path.length) {
    const w = ai.path[0];
    const next = ai.path[1];
    let popR = cell * 0.32;
    if (next) {
      const dot = (w.c - myCell.c) * (next.c - w.c) + (w.r - myCell.r) * (next.r - w.r);
      if (dot <= 0) popR = cell * 0.16;
    }
    const wx = (w.c + 0.5) * cell;
    const wy = (w.r + 0.5) * cell;
    if ((wx - t.x) ** 2 + (wy - t.y) ** 2 < popR * popR) ai.path.shift();
    else break;
  }

  let aimX;
  let aimY;
  const w = ai.path[0];
  if (w) {
    const wx = (w.c + 0.5) * cell;
    const wy = (w.r + 0.5) * cell;
    if (corridorClear(t.x, t.y, wx, wy, world.rects, rBody)) {
      aimX = wx; aimY = wy;
    } else {
      aimX = (myCell.c + 0.5) * cell; // line up mid-corridor first
      aimY = (myCell.r + 0.5) * cell;
    }
  } else {
    aimX = target.x;
    aimY = target.y;
  }

  steerTo(t, aimX, aimY, acts, true);
}

// Steer toward a point; may choose to REVERSE when the point is
// mostly behind us — no more three-point-turn stalls at junctions.
function steerTo(t, px, py, acts, allowReverse) {
  const want = Math.atan2(py - t.y, px - t.x);
  let err = angleDiff(t.a, want);
  let rev = false;
  if (allowReverse && Math.abs(err) > Math.PI * 0.62) {
    err = angleDiff(t.a, want + Math.PI);
    rev = true;
  }
  if (err > 0.05) acts.right = true;
  else if (err < -0.05) acts.left = true;
  if (Math.abs(err) < 0.75) {
    if (rev) acts.down = true;
    else acts.up = true;
  }
}

/* ================================================================
   Bullets — threat detection, dodging, shot verification
   ================================================================ */

// Advance a simulated bullet one step, bouncing off walls.
function stepSim(b, rects, step, r) {
  b.x += b.vx * step;
  b.y += b.vy * step;
  for (const rc of rects) {
    const cx = rc.x + rc.w / 2;
    const cy = rc.y + rc.h / 2;
    const ox = rc.w / 2 + r - Math.abs(b.x - cx);
    if (ox <= 0) continue;
    const oy = rc.h / 2 + r - Math.abs(b.y - cy);
    if (oy <= 0) continue;
    if (ox < oy) {
      const d = b.x < cx ? -1 : 1;
      b.x += d * ox;
      if ((d < 0 && b.vx > 0) || (d > 0 && b.vx < 0)) b.vx = -b.vx;
    } else {
      const d = b.y < cy ? -1 : 1;
      b.y += d * oy;
      if ((d < 0 && b.vy > 0) || (d > 0 && b.vy < 0)) b.vy = -b.vy;
    }
  }
}

// Will any live bullet hit us within `horizon` seconds (bounces
// included)? Returns the soonest threat with its velocity at impact.
function findThreat(t, world, horizon, now) {
  const baseR = (world.tankR ?? 22) + 6;
  const reach = world.bulletSpeed * horizon + baseR + world.bulletR * 4;
  let bestThreat = null;

  for (const b of world.bullets) {
    // Our own bullet is ignored only while it's actually OUTBOUND —
    // the moment a ricochet turns it back toward us, it's a threat.
    if (b.by === t.id) {
      const age = now - b.born;
      if (age < 150) continue;
      const rx = b.x - t.x;
      const ry = b.y - t.y;
      if (age < 700 && b.vx * rx + b.vy * ry > 0) continue;
    }
    const dx = b.x - t.x;
    const dy = b.y - t.y;
    if (dx * dx + dy * dy > reach * reach) continue;

    const dangerR = baseR + (b.r ?? world.bulletR);
    const sim = { x: b.x, y: b.y, vx: b.vx, vy: b.vy };
    const step = 0.02;
    for (let tau = step; tau <= horizon; tau += step) {
      stepSim(sim, world.rects, step, b.r ?? world.bulletR);
      const ox = sim.x - t.x;
      const oy = sim.y - t.y;
      if (ox * ox + oy * oy < dangerR * dangerR) {
        if (!bestThreat || tau < bestThreat.eta) {
          bestThreat = { eta: tau, vx: sim.vx, vy: sim.vy, x: sim.x, y: sim.y };
        }
        break;
      }
    }
  }
  return bestThreat;
}

// Dodge kinematically: a tank can't strafe, so 90° escapes waste the
// whole flight time rotating. Instead, pick escape points CHEAP to
// reach from the current heading (shallow turns keep the tank
// driving the entire time; rear points use reverse) and score them
// by how far they get off the threat's line — and every other
// bullet's line, so we never dodge into crossfire.
function dodgeSteer(t, threat, world, rBody, acts, now) {
  const bs = Math.hypot(threat.vx, threat.vy) || 1;
  const bvx = threat.vx / bs;
  const bvy = threat.vy / bs;
  const etaS = Math.max(0.12, (threat.impactAt - now) / 1000);
  const mv = world.moveSpeed ?? 134;
  const D = Math.min(world.cell * 0.85, Math.max(world.cell * 0.35, mv * etaS));

  const offs = [0.55, -0.55, 1.05, -1.05, 0, Math.PI + 0.55, Math.PI - 0.55, Math.PI];
  let bestPt = null;
  let bestScore = -Infinity;

  for (const off of offs) {
    const h = t.a + off;
    const ox = t.x + Math.cos(h) * D;
    const oy = t.y + Math.sin(h) * D;
    if (!corridorClear(t.x, t.y, ox, oy, world.rects, rBody)) continue;

    // Primary: distance off THIS threat's travel line at the endpoint.
    const rx = ox - threat.x;
    const ry = oy - threat.y;
    let score = Math.abs(rx * -bvy + ry * bvx) * 2;

    // Secondary: clearance from every other live bullet's line.
    let minD = Infinity;
    for (const b of world.bullets) {
      if (b.by === t.id && now - b.born < 150) continue;
      const s2 = Math.hypot(b.vx, b.vy) || 1;
      const qx = ox - b.x;
      const qy = oy - b.y;
      if ((qx * b.vx + qy * b.vy) / s2 < -world.cell * 0.3) continue; // already past it
      const perp = Math.abs(qx * (-b.vy / s2) + qy * (b.vx / s2));
      if (perp < minD) minD = perp;
    }
    if (minD < Infinity) score += Math.min(minD, world.cell);

    if (score > bestScore) { bestScore = score; bestPt = [ox, oy]; }
  }

  if (bestPt) steerTo(t, bestPt[0], bestPt[1], acts, true);
  else steerTo(t, t.x + bvx * D, t.y + bvy * D, acts, true);
}

// Trace the shot we're about to take along our CURRENT heading.
// safe = it never ricochets back into us within the window — checked
// across the WHOLE trace, even past a predicted hit, because a
// dodged shot keeps flying and can boomerang. hits = the path lands
// on an enemy (at their predicted position for the arrival time).
function traceShot(t, world, P, ai) {
  const muz = world.muzzle ?? 27;
  const sim = {
    x: t.x + Math.cos(t.a) * muz,
    y: t.y + Math.sin(t.a) * muz,
    vx: Math.cos(t.a) * world.bulletSpeed,
    vy: Math.sin(t.a) * world.bulletSpeed,
  };
  const selfR = (world.tankR ?? 22) + world.bulletR + 2;
  const mv = world.moveSpeed ?? world.bulletSpeed * 0.65;
  const ca = Math.cos(t.a);
  const sa = Math.sin(t.a);
  const step = 0.02;
  let hits = false;

  for (let tau = step; tau <= P.selfCheckT; tau += step) {
    stepSim(sim, world.rects, step, world.bulletR);

    // Would it come back on US — wherever we'll be? Check the spots
    // we'd occupy if we hold, keep advancing, or keep reversing
    // (firing then driving into your own ricochet is the #1 suicide).
    if (tau > 0.08) {
      for (const k of [0, 1, -0.69]) {
        const sx = sim.x - (t.x + ca * mv * k * tau);
        const sy = sim.y - (t.y + sa * mv * k * tau);
        if (sx * sx + sy * sy < selfR * selfR) return { safe: false, hits };
      }
    }

    // Does it land on someone? Test both their current spot and
    // their lead-predicted spot — erratic movers sit between the two.
    if (!hits) {
      for (const o of world.tanks) {
        if (o === t || o.dead || o.gone) continue;
        const hitR = (world.tankR ?? 22) * 1.35 + world.bulletR;
        let hx = sim.x - o.x;
        let hy = sim.y - o.y;
        if (hx * hx + hy * hy < hitR * hitR) { hits = true; break; }
        const tv = ai.vel[o.id];
        if (tv && P.lead > 0) {
          hx = sim.x - (o.x + tv.vx * tau * P.lead);
          hy = sim.y - (o.y + tv.vy * tau * P.lead);
          if (hx * hx + hy * hy < hitR * hitR) { hits = true; break; }
        }
      }
    }
  }
  return { safe: true, hits };
}

/* ================================================================
   Weapon hazards — rockets and laser aiming lines
   ================================================================ */

// Is any rocket a live danger to THIS tank? Seeking rockets hunt
// whoever is nearest to them; dumb-fire rockets only matter when
// they're flying straight at us.
function rocketHuntingMe(t, world, now) {
  const cell = world.cell;
  for (const rk of world.rockets) {
    const age = now - rk.born;
    if (rk.by === t.id && age < ROCKET.ownerGraceMs) continue; // can't touch its shooter yet
    const dx = t.x - rk.x;
    const dy = t.y - rk.y;
    const d2 = dx * dx + dy * dy;
    if (d2 > (cell * 4.5) ** 2) continue;

    if (age >= ROCKET.straightMs) {
      // Seeking: it chases the nearest living tank — is that us?
      let nearestD = Infinity;
      let nearestMe = false;
      for (const o of world.tanks) {
        if (o.dead || o.gone) continue;
        const od = (o.x - rk.x) ** 2 + (o.y - rk.y) ** 2;
        if (od < nearestD) { nearestD = od; nearestMe = o === t; }
      }
      if (nearestMe) return rk;
    } else if (d2 < (cell * 2.5) ** 2) {
      // Dumb-fire phase: heading our way?
      const sp = Math.hypot(rk.vx, rk.vy) || 1;
      if ((rk.vx * dx + rk.vy * dy) / (sp * Math.sqrt(d2) || 1) > 0.75) return rk;
    }
  }
  return null;
}

// Run for the open neighbor cell that gains the most MAZE distance
// from the rocket (graph hops, not straight-line — the rocket drives
// the corridors too). The pick is committed briefly so the tank
// actually runs instead of dithering between exits.
function fleeRocket(t, ai, rk, world, rBody, acts, now) {
  const cell = world.cell;
  const reached = ai.hazPt &&
    (t.x - ai.hazPt[0]) ** 2 + (t.y - ai.hazPt[1]) ** 2 < (cell * 0.3) ** 2;

  if (!ai.hazPt || reached || now > ai.hazUntil) {
    const maze = world.maze;
    const mc = cellOf(t.x, cell, maze.cols);
    const mr = cellOf(t.y, cell, maze.rows);
    const rkc = { c: cellOf(rk.x, cell, maze.cols), r: cellOf(rk.y, cell, maze.rows) };
    const opts = [];
    if (!maze.H[mr][mc]) opts.push([mc, mr - 1]);
    if (!maze.H[mr + 1][mc]) opts.push([mc, mr + 1]);
    if (!maze.V[mr][mc]) opts.push([mc - 1, mr]);
    if (!maze.V[mr][mc + 1]) opts.push([mc + 1, mr]);

    let bestPt = null;
    let bestScore = -Infinity;
    for (const [c, r] of opts) {
      const x = (c + 0.5) * cell;
      const y = (r + 0.5) * cell;
      if (!corridorClear(t.x, t.y, x, y, world.rects, rBody)) continue;
      const hops = bfsPath(maze, rkc, { c, r }).length; // maze distance from the rocket
      let score = hops * cell + Math.hypot(x - rk.x, y - rk.y) * 0.25;
      if (segmentHitsAnyRect(x, y, rk.x, rk.y, world.rects)) score += cell * 0.8;
      if (score > bestScore) { bestScore = score; bestPt = [x, y]; }
    }
    ai.hazPt = bestPt;
    ai.hazUntil = now + 450;
  }

  if (ai.hazPt) steerTo(t, ai.hazPt[0], ai.hazPt[1], acts, true);
  else steerTo(t, t.x + (t.x - rk.x), t.y + (t.y - rk.y), acts, true);
}

// Closest point on a polyline (the laser preview), with the segment
// direction for a perpendicular escape.
function nearestOnPolyline(x, y, pts) {
  let bestSeg = null;
  for (let i = 0; i < pts.length - 1; i++) {
    const ax = pts[i].x;
    const ay = pts[i].y;
    const dx = pts[i + 1].x - ax;
    const dy = pts[i + 1].y - ay;
    const len2 = dx * dx + dy * dy || 1;
    let u = ((x - ax) * dx + (y - ay) * dy) / len2;
    u = u < 0 ? 0 : u > 1 ? 1 : u;
    const px = ax + dx * u;
    const py = ay + dy * u;
    const d = Math.hypot(x - px, y - py);
    if (!bestSeg || d < bestSeg.d) {
      const len = Math.sqrt(len2);
      bestSeg = { d, px, py, ux: dx / len, uy: dy / len };
    }
  }
  return bestSeg;
}

// Get off a laser aiming line. Perpendicular is best when there's
// room; in a corridor that runs WITH the beam, the only exits are
// the neighboring cells — so those are candidates too. Score by how
// far off the line each drivable option gets us, commit briefly.
function sidestepLine(t, ai, L, world, rBody, acts, now) {
  const cell = world.cell;
  const reached = ai.hazPt &&
    (t.x - ai.hazPt[0]) ** 2 + (t.y - ai.hazPt[1]) ** 2 < (cell * 0.25) ** 2;

  if (!ai.hazPt || reached || now > ai.hazUntil) {
    const near = nearestOnPolyline(t.x, t.y, L.pts);
    let px = -near.uy;
    let py = near.ux;
    if ((t.x - near.px) * px + (t.y - near.py) * py < 0) { px = -px; py = -py; }
    const D = cell * 0.7;

    const maze = world.maze;
    const mc = cellOf(t.x, cell, maze.cols);
    const mr = cellOf(t.y, cell, maze.rows);
    const cands = [
      [t.x + px * D, t.y + py * D],
      [t.x - px * D, t.y - py * D],
    ];
    if (!maze.H[mr][mc]) cands.push([(mc + 0.5) * cell, (mr - 0.5) * cell]);
    if (!maze.H[mr + 1][mc]) cands.push([(mc + 0.5) * cell, (mr + 1.5) * cell]);
    if (!maze.V[mr][mc]) cands.push([(mc - 0.5) * cell, (mr + 0.5) * cell]);
    if (!maze.V[mr][mc + 1]) cands.push([(mc + 1.5) * cell, (mr + 0.5) * cell]);

    // The line tracks with the enemy's aim, so raw distance off it is
    // fleeting — BREAKING LINE OF SIGHT is what actually works.
    const owner = world.tanks.find((o) => o.id === L.by);
    let bestPt = null;
    let bestScore = -Infinity;
    for (const [cx, cy] of cands) {
      if (!corridorClear(t.x, t.y, cx, cy, world.rects, rBody)) continue;
      const nd = nearestOnPolyline(cx, cy, L.pts);
      let score = (nd ? nd.d : cell) - Math.hypot(cx - t.x, cy - t.y) * 0.15;
      if (owner && segmentHitsAnyRect(cx, cy, owner.x, owner.y, world.rects)) score += cell * 2;
      if (score > bestScore) { bestScore = score; bestPt = [cx, cy]; }
    }
    ai.hazPt = bestPt;
    ai.hazUntil = now + 400;
  }

  if (ai.hazPt) steerTo(t, ai.hazPt[0], ai.hazPt[1], acts, true);
}

/* ================================================================
   Helpers
   ================================================================ */

function mkThreat(th, now) {
  return { ...th, impactAt: now + th.eta * 1000, until: now + th.eta * 1000 + 200 };
}

function trackVel(ai, o, now) {
  const h = (ai.vel[o.id] ??= { x: o.x, y: o.y, t: now, vx: 0, vy: 0 });
  const dts = (now - h.t) / 1000;
  if (dts >= 0.08) {
    const nvx = (o.x - h.x) / dts;
    const nvy = (o.y - h.y) / dts;
    h.vx = h.vx * 0.4 + nvx * 0.6;
    h.vy = h.vy * 0.4 + nvy * 0.6;
    h.x = o.x; h.y = o.y; h.t = now;
  }
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

// BFS through the maze's open walls (unique path — perfect maze).
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
  if (!prev.has(k)) return path;
  while (k !== -1) {
    path.push({ c: k % maze.cols, r: Math.floor(k / maze.cols) });
    k = prev.get(k);
  }
  path.reverse();
  return path;
}
