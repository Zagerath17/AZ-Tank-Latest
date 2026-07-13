// ================================================================
// weapons.js — the AZ-Tank pickup weapons: laser, machine gun,
// homing rocket, big cannon.
//
// This module owns the pure parts: per-weapon barrel geometry (the
// drawn sprite and the hitbox are the SAME rectangle), ray casting
// with reflections for the laser, and the projectile physics for
// rockets (homing + wall bounce) and cannon shrapnel (phases through
// walls at reduced speed). game.js owns spawning, kills, and sync.
// ================================================================

import { segmentHitsAnyRect } from "./maze.js";

export const WEAPON_TYPES = ["laser", "mg", "rocket", "cannon", "sniper", "mortar", "boost", "phase", "wall", "armour", "heal", "mud"];

// Every pickup belongs to one loadout category. A tank holds at most
// ONE item per category (offense / defense / agility), each with its
// own activation control.
export const WEAPON_CATEGORY = {
  laser: "offense",
  mg: "offense",
  rocket: "offense",
  cannon: "offense",
  sniper: "offense",
  mortar: "offense",
  wall: "defense",
  armour: "defense",
  heal: "defense",
  mud: "defense",
  boost: "agility",
  phase: "agility",
};

// Barrel geometry in multiples of TANK_R. The barrel hitbox is the
// rectangle from the hull center to len·R forward, hw·R half-wide —
// exactly what's drawn.
export const BARRELS = {
  normal: { len: 1.5,  hw: 0.31 },
  laser:  { len: 1.85, hw: 0.15 },
  sniper: { len: 2.05, hw: 0.19 },
  mg:     { len: 1.45, hw: 0.36 },
  rocket: { len: 1.3,  hw: 0.44 },
  cannon: { len: 1.2,  hw: 0.52 },
  mortar: { len: 0.95, hw: 0.46 },
  boost:  { len: 1.5,  hw: 0.31 },
  phase:  { len: 1.5,  hw: 0.31 },
  wall:   { len: 1.5,  hw: 0.31 },
  armour: { len: 1.5,  hw: 0.31 },
  heal:   { len: 1.5,  hw: 0.31 },
  mud:    { len: 1.5,  hw: 0.31 },
};

// Tunables (speeds/radii are multipliers of the normal bullet).
export const LASER = {
  previewBounces: 4, // aiming line reflects this many times
  shotBounces: 7,    // the fired beam reflects this many times
  width: 0.9,        // beam half-thickness, × bullet radius
  beamSpeed: 9500,   // px/s — you can SEE it travel, but barely
  flashMs: 320,
};

export const SNIPER = {
  shots: 2,          // two rounds total
  rangeCells: 5,     // the bullet dies after this many cells
  previewCells: 3,   // aim preview reaches this far (no bounce)
  speed: 4.2,        // × normal bullet — a fast round
  r: 0.75,           // between a basic ball (1.0) and an MG ball (0.5)
};

export const BOOST = {
  mult: 1.4,         // +40% move speed
  durationMs: 6000,  // for six seconds
};

export const PHASE = {
  durationMs: 1500,  // 1.5 seconds of intangibility
  opacity: 0.5,      // half-transparent while phasing
};

// Armour: a 4-point shield that soaks damage before your health, for
// 20 s. Shows as a blue glow around the tank.
export const ARMOUR = {
  hp: 4,
  durationMs: 20000,
};

// Healing station: a green pad ~1 cell across. A tank must stay inside
// for a full 3 s to bank 1 HP; the pad lives 9 s (so 3 HP max). Heals
// ANY tank standing in it.
export const HEAL = {
  radiusCells: 0.5,   // ~1 cell diameter
  durationMs: 9000,
  tickMs: 3000,       // 3 s inside per HP
  tickGraceMs: 60,    // absorbs the one-frame boundary so 9 s → the full 3 HP
  healPerHp: 1,
};

// Mud pit: an irregular puddle ~1 cell across dropped behind the hull.
// Any tank inside moves 20% slower. Dries up after a while.
export const MUD = {
  radiusCells: 0.55,
  slow: 0.8,          // 20% slow-down
  lifeMs: 15000,
};

// Mortar: indirect fire. The shot is aimed at the mouse, snapped to
// the centre of that cell (max reach rangeCells), arcs high over
// everything, and lands after msPerCell of flight per cell of
// distance. A pulsing red marker warns the landing cell; impact
// throws a dark smoke cloud over it. Damage rings live in game code
// (they're sized off the tank/cell constants).
export const MORTAR = {
  rangeCells: 5,      // "going out 5 cells takes 5 seconds"
  msPerCell: 1000,    // flight time per cell of distance
  cloudMs: 1100,      // the dark cloud lingers this long
};

// A temporary brick wall the player drops. It BLOCKS movement and
// eats projectiles (they don't bounce off it — they're consumed). It
// takes different hit-values per weapon, and expires after 10 s.
export const WALL = {
  lifeMs: 10000,
  lengthCells: 0.5,  // half a cell long
  thickCells: 0.1067, // slab thickness (2/3 of the original 0.16)
  // The wall absorbs 6 points of damage — the same pool as a tank —
  // and takes the SAME per-weapon damage values as a tank does. So a
  // laser (8) or big cannon ball (6) shatters it in one hit, three
  // basic shots (2 each) chip it down, six MG rounds do it, etc.
  hp: 6,
};

export const MG = {
  windupMs: 500,     // barrel spin-up on the first trigger pull
  shots: 26,         // total balls per pickup — hold or tap to fire
  gapMs: 90,         // minimum gap between balls while holding
  spread: 0.07,      // radians of random scatter per ball
  r: 0.5,            // × bullet radius — "half sized balls"
  speed: 1.05,
  lifeMs: 3000,
};

export const ROCKET = {
  speed: 0.72,        // ~10% faster than a driving tank — outrunnable-ish
  straightMs: 1750,   // flies straight (bouncing) this long, like AZ Tank
  seekTurn: 12.0,     // rad/s once seeking — U-turns fit inside a corridor
  r: 1.4,
  lifeMs: 8000,       // 8 s fuse, then it detonates harmlessly
  seekRangeCells: 4.5, // it can only smell tanks this close
  ownerGraceMs: 1000, // can't collide with its shooter right away
  trailLen: 26,
};

export const CANNON = {
  speed: 0.55,       // one slow-ish projectile
  r: 1.62,           // big ball, 8% bigger than before
  lifeMs: 3500,
  shrapN: 36,        // irregular shrapnel burst on expiry / tank hit
  shrapSpeed: 1.1,
  shrapR: 0.6,
  wallSlow: 0.15,    // shrapnel crawls while phasing through a wall
};

/* ================================================================
   Ray casting (laser)
   ================================================================ */

// First wall hit of a ray, with the surface normal for reflection.
export function castRay(x, y, dx, dy, rects, maxDist) {
  let bestT = maxDist;
  let nx = 0;
  let ny = 0;
  let hit = false;

  for (const rc of rects) {
    let tmin = 0;
    let tmax = bestT;
    let axis = -1;

    if (Math.abs(dx) > 1e-9) {
      const inv = 1 / dx;
      let t1 = (rc.x - x) * inv;
      let t2 = (rc.x + rc.w - x) * inv;
      if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
      if (t1 > tmin) { tmin = t1; axis = 0; }
      if (t2 < tmax) tmax = t2;
    } else if (x <= rc.x || x >= rc.x + rc.w) continue;

    if (Math.abs(dy) > 1e-9) {
      const inv = 1 / dy;
      let t1 = (rc.y - y) * inv;
      let t2 = (rc.y + rc.h - y) * inv;
      if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
      if (t1 > tmin) { tmin = t1; axis = 1; }
      if (t2 < tmax) tmax = t2;
    } else if (y <= rc.y || y >= rc.y + rc.h) continue;

    if (tmax >= tmin && tmin > 1e-6 && tmin < bestT) {
      bestT = tmin;
      hit = true;
      if (axis === 1) { nx = 0; ny = -Math.sign(dy); }
      else { nx = -Math.sign(dx) || 1; ny = 0; }
    }
  }
  return { d: bestT, nx, ny, hit };
}

// Polyline of a beam reflecting off walls `bounces` times.
export function laserPath(x, y, a, rects, bounces) {
  let dx = Math.cos(a);
  let dy = Math.sin(a);
  let px = x;
  let py = y;
  const pts = [{ x: px, y: py }];

  for (let i = 0; i <= bounces; i++) {
    const r = castRay(px, py, dx, dy, rects, 5000);
    px += dx * r.d;
    py += dy * r.d;
    pts.push({ x: px, y: py });
    if (!r.hit) break;
    if (r.nx !== 0) dx = -dx;
    else dy = -dy;
    px += r.nx * 0.5; // nudge off the surface so the next cast is clean
    py += r.ny * 0.5;
  }
  return pts;
}

/* ================================================================
   Projectile physics (pure — game.js applies kills)
   ================================================================ */

// Circle overlapping any wall rect?
export function insideAnyWall(x, y, r, rects) {
  for (const rc of rects) {
    const cx = x < rc.x ? rc.x : x > rc.x + rc.w ? rc.x + rc.w : x;
    const cy = y < rc.y ? rc.y : y > rc.y + rc.h ? rc.y + rc.h : y;
    const dx = x - cx;
    const dy = y - cy;
    if (dx * dx + dy * dy < r * r) return true;
  }
  return false;
}

// Reflect a circle off walls (same rule the bullets use).
export function bounceCircle(b, rects, r) {
  let bounced = false;
  for (const rc of rects) {
    const cx = rc.x + rc.w / 2;
    const cy = rc.y + rc.h / 2;
    const ox = rc.w / 2 + r - Math.abs(b.x - cx);
    if (ox <= 0) continue;
    const oy = rc.h / 2 + r - Math.abs(b.y - cy);
    if (oy <= 0) continue;
    if (ox < oy) {
      const dir = b.x < cx ? -1 : 1;
      b.x += dir * ox;
      if ((dir < 0 && b.vx > 0) || (dir > 0 && b.vx < 0)) { b.vx = -b.vx; bounced = true; }
    } else {
      const dir = b.y < cy ? -1 : 1;
      b.y += dir * oy;
      if ((dir < 0 && b.vy > 0) || (dir > 0 && b.vy < 0)) { b.vy = -b.vy; bounced = true; }
    }
  }
  return bounced;
}

// Reflect a projectile (circle radius r) off oriented wall slabs
// { x, y, a, hx, hy } — the diagonal arena boundary. Works in each
// slab's local frame (x along the edge, y = surface normal), pushing
// out and flipping the velocity component on whichever local axis is
// shallower, then rotating the correction back to world space.
export function bounceSlab(b, slabs, r) {
  let bounced = false;
  for (const w of slabs) {
    const ca = Math.cos(w.a), sa = Math.sin(w.a);
    const dx = b.x - w.x, dy = b.y - w.y;
    const lx = dx * ca + dy * sa;    // along the edge
    const ly = -dx * sa + dy * ca;   // across (normal)
    const ox = w.hx + r - Math.abs(lx);
    if (ox <= 0) continue;
    const oy = w.hy + r - Math.abs(ly);
    if (oy <= 0) continue;
    let lvx = b.vx * ca + b.vy * sa;
    let lvy = -b.vx * sa + b.vy * ca;
    let nlx = lx, nly = ly;
    if (oy < ox) {
      const dir = ly < 0 ? -1 : 1;
      nly = ly + dir * oy;
      if ((dir < 0 && lvy > 0) || (dir > 0 && lvy < 0)) { lvy = -lvy; bounced = true; }
    } else {
      const dir = lx < 0 ? -1 : 1;
      nlx = lx + dir * ox;
      if ((dir < 0 && lvx > 0) || (dir > 0 && lvx < 0)) { lvx = -lvx; bounced = true; }
    }
    b.x = w.x + nlx * ca - nly * sa;
    b.y = w.y + nlx * sa + nly * ca;
    b.vx = lvx * ca - lvy * sa;
    b.vy = lvx * sa + lvy * ca;
  }
  return bounced;
}

// Rotate a projectile's velocity toward a point, capped at maxTurn.
export function steerToward(rk, tx, ty, maxTurn, dt) {
  const want = Math.atan2(ty - rk.y, tx - rk.x);
  const cur = Math.atan2(rk.vy, rk.vx);
  let d = (want - cur) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  const cap = maxTurn * dt;
  const na = cur + (d > cap ? cap : d < -cap ? -cap : d);
  const sp = Math.hypot(rk.vx, rk.vy);
  rk.vx = Math.cos(na) * sp;
  rk.vy = Math.sin(na) * sp;
}

// BFS through the maze's open walls (rocket-local copy — keeps this
// module dependency-free of ai.js).
function rocketBfs(maze, from, to) {
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
      if (!prev.has(k)) { prev.set(k, key(c, r)); queue.push([nc, nr]); }
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

// One SEEK-phase substep: pick an aim point (the target directly if
// visible, otherwise the farthest visible BFS waypoint toward it),
// steer at seekTurn, and advance at constant speed. Returns TRUE if
// the rocket clipped a wall — the caller kills it (no bouncing while
// seeking).
export function rocketSeekStep(rk, target, maze, rects, cell, dt, r) {
  const cellOf = (v, max) => Math.min(max - 1, Math.max(0, Math.floor(v / cell)));
  const ctr = (p) => ({ x: (p.c + 0.5) * cell, y: (p.r + 0.5) * cell });

  let ax = target.x;
  let ay = target.y;

  if (segmentHitsAnyRect(rk.x, rk.y, target.x, target.y, rects)) {
    const my = { c: cellOf(rk.x, maze.cols), r: cellOf(rk.y, maze.rows) };
    const tg = { c: cellOf(target.x, maze.cols), r: cellOf(target.y, maze.rows) };
    const tgKey = tg.c + "," + tg.r;

    rk.repathIn = (rk.repathIn ?? 0) - dt;
    if (!rk.path || !rk.path.length || rk.repathIn <= 0 || rk.pathTg !== tgKey) {
      rk.path = rocketBfs(maze, my, tg);
      rk.pathTg = tgKey;
      rk.repathIn = 0.15;
    }

    // Drop cells already reached, then ride the corridor CENTERLINE:
    // aim at the next cell center only. Centers are the farthest
    // points from every wall, so turns happen where clearance is max.
    while (rk.path.length) {
      const c = ctr(rk.path[0]);
      const same = rk.path[0].c === my.c && rk.path[0].r === my.r;
      // Pop early only when the FOLLOWING waypoint is already visible —
      // otherwise hold course to the center before committing to the turn.
      let popR = cell * 0.22;
      const nxt = rk.path[1];
      if (nxt) {
        const n = ctr(nxt);
        if (!segmentHitsAnyRect(rk.x, rk.y, n.x, n.y, rects)) popR = cell * 0.42;
      } else if (!segmentHitsAnyRect(rk.x, rk.y, target.x, target.y, rects)) {
        popR = cell * 0.42;
      }
      if (same || (c.x - rk.x) ** 2 + (c.y - rk.y) ** 2 < popR * popR) rk.path.shift();
      else break;
    }
    if (rk.path.length) { const c = ctr(rk.path[0]); ax = c.x; ay = c.y; }
  } else {
    rk.path = null;
  }

  // Blend waypoint attraction with WALL REPULSION so the rocket
  // sheers away from anything it drifts near — that's what keeps it
  // off the bricks at full speed.
  let dirX = ax - rk.x;
  let dirY = ay - rk.y;
  const dl = Math.hypot(dirX, dirY) || 1;
  dirX /= dl;
  dirY /= dl;

  // Push away from EVERY wall inside the influence radius — corners
  // have two walls, and both matter.
  const influence = r + 28;
  for (const rc of rects) {
    const cx = rk.x < rc.x ? rc.x : rk.x > rc.x + rc.w ? rc.x + rc.w : rk.x;
    const cy = rk.y < rc.y ? rc.y : rk.y > rc.y + rc.h ? rc.y + rc.h : rk.y;
    const ox = rk.x - cx;
    const oy = rk.y - cy;
    const d = Math.hypot(ox, oy);
    if (d >= influence || d < 0.001) continue;
    const w = ((influence - d) / influence) * 2.8;
    dirX += (ox / d) * w;
    dirY += (oy / d) * w;
  }

  steerToward(rk, rk.x + dirX * 60, rk.y + dirY * 60, ROCKET.seekTurn, dt);
  rk.x += rk.vx * dt;
  rk.y += rk.vy * dt;
  return insideAnyWall(rk.x, rk.y, r * 0.6, rects);
}

// Advance a shrapnel piece: it PHASES through walls, crawling at
// `slow` speed inside them and resuming full speed once through.
export function stepShrap(sh, rects, dt, r, slow) {
  const f = insideAnyWall(sh.x, sh.y, r, rects) ? slow : 1;
  sh.x += sh.vx * f * dt;
  sh.y += sh.vy * f * dt;
  return f !== 1;
}

/* ================================================================
   Sprites
   ================================================================ */

// The barrel, drawn to match its hitbox exactly. Origin = hull
// center, +x = forward. cMain/cDark are the tank's barrel shades.
export function drawBarrel(ctx, type, R, cMain, cDark) {
  const b = BARRELS[type] ?? BARRELS.normal;
  const L = b.len * R;
  const W = b.hw * R;

  const rrect = (x, y, w, h, rad) => {
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, w, h, rad);
    else ctx.rect(x, y, w, h);
    ctx.fill();
  };

  switch (type) {
    case "laser":
      ctx.fillStyle = cMain;
      rrect(0, -W, L, W * 2, W * 0.6);
      ctx.fillStyle = "#e8452e"; // emitter tip
      ctx.beginPath();
      ctx.arc(L - R * 0.06, 0, R * 0.13, 0, Math.PI * 2);
      ctx.fill();
      break;

    case "sniper":
      // Long, slim barrel with a teal muzzle bead.
      ctx.fillStyle = cMain;
      rrect(0, -W, L, W * 2, W * 0.55);
      ctx.fillStyle = "#33c2b0";
      ctx.beginPath();
      ctx.arc(L - R * 0.05, 0, R * 0.11, 0, Math.PI * 2);
      ctx.fill();
      break;

    case "mg": {
      // Gatling: housing + three thin tubes filling the hitbox.
      ctx.fillStyle = cDark;
      rrect(0, -W, L * 0.45, W * 2, W * 0.4);
      ctx.fillStyle = cMain;
      const tw = W * 0.52;
      rrect(0, -W, L, tw, tw * 0.5);
      rrect(0, -tw / 2, L * 0.94, tw, tw * 0.5);
      rrect(0, W - tw, L, tw, tw * 0.5);
      break;
    }

    case "rocket":
      ctx.fillStyle = cMain;
      rrect(0, -W, L, W * 2, W * 0.45);
      ctx.fillStyle = cDark; // tube mouth
      rrect(L * 0.72, -W, L * 0.28, W * 2, W * 0.3);
      ctx.fillStyle = "#e8452e"; // rocket nose peeking out
      ctx.beginPath();
      ctx.moveTo(L + R * 0.14, 0);
      ctx.lineTo(L - R * 0.1, -W * 0.5);
      ctx.lineTo(L - R * 0.1, W * 0.5);
      ctx.closePath();
      ctx.fill();
      break;

    case "cannon":
      ctx.fillStyle = cMain;
      rrect(0, -W, L, W * 2, W * 0.35);
      ctx.fillStyle = cDark; // muzzle band
      rrect(L * 0.78, -W, L * 0.22, W * 2, W * 0.25);
      break;

    case "mortar": {
      // A stubby, wide launch tube: reinforced base ring, then the
      // tube, with a dark open bore at the muzzle (it lobs, not shoots).
      ctx.fillStyle = cDark;
      rrect(0, -W, L * 0.32, W * 2, W * 0.3); // base collar
      ctx.fillStyle = cMain;
      rrect(L * 0.22, -W * 0.86, L * 0.78, W * 1.72, W * 0.5);
      ctx.fillStyle = "#1c212c"; // open bore
      ctx.beginPath();
      ctx.ellipse(L * 0.92, 0, W * 0.34, W * 0.66, 0, 0, Math.PI * 2);
      ctx.fill();
      break;
    }

    default:
      ctx.fillStyle = cMain;
      rrect(0, -W, L, W * 2, W * 0.55);
  }
}

// Pickup icon on the arena floor.
// Redesigned: a plated badge with a colored rim per weapon, a crisp
// glyph, a springy pop-in when it lands, and a soft idle bob.
// Each weapon gets its own distinct accent color — used for the crate
// rim AND the equipped-weapon label, so they always correspond.
export const GEAR_RIM = {
  laser: "#e8452e",   // red
  mg: "#ff8c1a",      // orange
  rocket: "#2f7bff",  // blue
  cannon: "#8a94a6",  // steel grey
  sniper: "#18c29a",  // teal-green
  boost: "#ffe11f",   // bright yellow
  phase: "#c04bff",   // magenta-purple
  wall: "#7a4a2a",    // dark brick brown
  armour: "#4aa8ff",  // armour blue
  heal: "#2fbf5f",    // healing green
  mud: "#6b4a2a",     // muddy brown
  mortar: "#8a8f3c",  // olive drab
};
function easeOutBack(t) {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}

export function drawGear(ctx, g, R, pulse, now = 0) {
  const rrect = (x, y, w, h, rad) => {
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, w, h, rad);
    else ctx.rect(x, y, w, h);
    ctx.fill();
  };
  const age = now - (g.born ?? now - 9999);
  const k = Math.min(1, age / 280);
  const scale = k < 1 ? Math.max(0.01, easeOutBack(k)) : 1;
  const bob = k >= 1 ? Math.sin(now / 420 + (g.x + g.y) * 0.05) * 1.6 : 0;

  ctx.save();
  ctx.translate(g.x, g.y + bob);

  // Landing shockwave ring during the pop-in.
  if (age < 340) {
    const rk = age / 340;
    ctx.strokeStyle = GEAR_RIM[g.type] ?? "#566072";
    ctx.globalAlpha = 0.5 * (1 - rk);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(0, 0, R * (0.4 + rk * 0.9), 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  ctx.scale(scale, scale);

  // Drop shadow.
  ctx.fillStyle = "rgba(16, 19, 26, 0.22)";
  ctx.beginPath();
  ctx.ellipse(0, R * 0.16, R * 0.62, R * 0.5, 0, 0, Math.PI * 2);
  ctx.fill();

  // Plate + weapon-colored rim (with a soft breathing pulse).
  const rim = GEAR_RIM[g.type] ?? "#566072";
  ctx.fillStyle = "#f4f6f9";
  ctx.strokeStyle = rim;
  ctx.lineWidth = 2.6 + pulse * 0.8;
  ctx.beginPath();
  ctx.arc(0, 0, R * 0.6, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.strokeStyle = "rgba(32, 36, 44, 0.28)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(0, 0, R * 0.48, 0, Math.PI * 2);
  ctx.stroke();

  switch (g.type) {
    case "laser": {
      // A beam ricocheting between two pips, with a bright core.
      ctx.lineCap = "round";
      ctx.strokeStyle = rim;
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(-R * 0.32, R * 0.26);
      ctx.lineTo(R * 0.02, -R * 0.1);
      ctx.lineTo(R * 0.13, R * 0.06);
      ctx.lineTo(R * 0.34, -R * 0.24);
      ctx.stroke();
      ctx.strokeStyle = "#ffd7cf";
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(-R * 0.32, R * 0.26);
      ctx.lineTo(R * 0.02, -R * 0.1);
      ctx.lineTo(R * 0.13, R * 0.06);
      ctx.lineTo(R * 0.34, -R * 0.24);
      ctx.stroke();
      ctx.fillStyle = "#20242c";
      for (const [px, py] of [[-0.32, 0.26], [0.34, -0.24]]) {
        ctx.beginPath();
        ctx.arc(px * R, py * R, R * 0.06, 0, Math.PI * 2);
        ctx.fill();
      }
      break;
    }
    case "mg": {
      // Three angled cartridges.
      ctx.save();
      ctx.rotate(-0.5);
      for (const dx of [-0.2, 0, 0.2]) {
        const x = dx * R;
        ctx.fillStyle = "#e5a13c";
        rrect(x - R * 0.055, -R * 0.22, R * 0.11, R * 0.36, R * 0.05);
        ctx.fillStyle = "#8a5a18";
        ctx.beginPath();
        ctx.arc(x, -R * 0.22, R * 0.055, Math.PI, 0);
        ctx.fill();
      }
      ctx.restore();
      break;
    }
    case "rocket": {
      // A proper little missile: body, nose, fins, window, flame.
      ctx.save();
      ctx.rotate(-0.7);
      ctx.fillStyle = "#d7dce6";
      rrect(-R * 0.28, -R * 0.11, R * 0.42, R * 0.22, R * 0.08);
      ctx.fillStyle = rim;
      ctx.beginPath(); // nose cone
      ctx.moveTo(R * 0.14, -R * 0.11);
      ctx.quadraticCurveTo(R * 0.4, 0, R * 0.14, R * 0.11);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath(); // fins
      ctx.moveTo(-R * 0.28, -R * 0.1);
      ctx.lineTo(-R * 0.42, -R * 0.22);
      ctx.lineTo(-R * 0.34, 0);
      ctx.lineTo(-R * 0.42, R * 0.22);
      ctx.lineTo(-R * 0.28, R * 0.1);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = "#20242c";
      ctx.beginPath(); // window
      ctx.arc(R * 0.02, 0, R * 0.05, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#ffb24a";
      ctx.beginPath(); // exhaust flame
      ctx.moveTo(-R * 0.42, -R * 0.05);
      ctx.lineTo(-R * 0.56, 0);
      ctx.lineTo(-R * 0.42, R * 0.05);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
      break;
    }
    case "cannon": {
      // A heavy ball mid-flight with speed arcs and a glint.
      ctx.fillStyle = "#20242c";
      ctx.beginPath();
      ctx.arc(R * 0.06, 0, R * 0.24, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#4a5261";
      ctx.beginPath();
      ctx.arc(-R * 0.02, -R * 0.08, R * 0.07, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#566072";
      ctx.lineWidth = 2;
      ctx.lineCap = "round";
      for (const [ro, a0, a1] of [[0.36, 2.5, 3.4], [0.44, 2.6, 3.2]]) {
        ctx.beginPath();
        ctx.arc(R * 0.06, 0, R * ro, a0, a1);
        ctx.stroke();
      }
      break;
    }
    case "sniper": {
      // A crosshair over a small black round — precision.
      ctx.strokeStyle = rim;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(0, 0, R * 0.28, 0, Math.PI * 2);
      ctx.stroke();
      ctx.lineCap = "round";
      for (const [x0, y0, x1, y1] of [
        [-0.42, 0, -0.16, 0], [0.16, 0, 0.42, 0],
        [0, -0.42, 0, -0.16], [0, 0.16, 0, 0.42],
      ]) {
        ctx.beginPath();
        ctx.moveTo(x0 * R, y0 * R);
        ctx.lineTo(x1 * R, y1 * R);
        ctx.stroke();
      }
      ctx.fillStyle = "#20242c";
      ctx.beginPath();
      ctx.arc(0, 0, R * 0.09, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case "boost": {
      // A double chevron pointing right — speed.
      ctx.strokeStyle = rim;
      ctx.lineWidth = 4;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      for (const dx of [-0.16, 0.14]) {
        ctx.beginPath();
        ctx.moveTo((dx - 0.16) * R, -R * 0.24);
        ctx.lineTo((dx + 0.16) * R, 0);
        ctx.lineTo((dx - 0.16) * R, R * 0.24);
        ctx.stroke();
      }
      break;
    }
    case "phase": {
      // A ghostly ring with a dashed inner ring — intangibility.
      ctx.strokeStyle = rim;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(0, 0, R * 0.3, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 0.55;
      ctx.lineWidth = 2;
      ctx.setLineDash([R * 0.12, R * 0.1]);
      ctx.beginPath();
      ctx.arc(0, 0, R * 0.16, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      break;
    }
    case "wall": {
      // A little brick wall — a couple of staggered courses.
      ctx.fillStyle = rim;
      const bw = R * 0.44, bh = R * 0.16;
      rrect(-bw, -R * 0.24, bw * 2, bh, R * 0.03);
      rrect(-bw, -R * 0.04, bw * 2, bh, R * 0.03);
      rrect(-bw, R * 0.16, bw * 2, bh, R * 0.03);
      ctx.strokeStyle = "rgba(40, 22, 12, 0.5)";
      ctx.lineWidth = 1.4;
      // vertical mortar joints, staggered per course
      for (const [y, off] of [[-0.24, 0], [-0.04, 0.22], [0.16, 0]]) {
        for (const fx of [-0.5, 0, 0.5]) {
          const x = (fx + off) * bw;
          if (x <= -bw || x >= bw) continue;
          ctx.beginPath();
          ctx.moveTo(x, y * R);
          ctx.lineTo(x, (y * R) + bh);
          ctx.stroke();
        }
      }
      break;
    }
    case "mortar": {
      // A tilted launch tube lobbing a dashed arc onto a landing dot.
      ctx.save();
      ctx.rotate(-0.5);
      ctx.fillStyle = rim;
      rrect(-R * 0.36, -R * 0.1, R * 0.34, R * 0.2, R * 0.05);
      ctx.restore();
      ctx.strokeStyle = rim;
      ctx.lineWidth = 2;
      ctx.setLineDash([R * 0.07, R * 0.06]);
      ctx.beginPath();
      ctx.arc(R * 0.02, R * 0.34, R * 0.42, -Math.PI * 0.82, -Math.PI * 0.18);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = "#e8452e"; // the landing marker
      ctx.beginPath();
      ctx.arc(R * 0.34, R * 0.22, R * 0.09, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case "armour": {
      // A shield crest.
      ctx.fillStyle = rim;
      ctx.beginPath();
      ctx.moveTo(0, -R * 0.34);
      ctx.lineTo(R * 0.3, -R * 0.2);
      ctx.lineTo(R * 0.3, R * 0.05);
      ctx.quadraticCurveTo(R * 0.3, R * 0.3, 0, R * 0.4);
      ctx.quadraticCurveTo(-R * 0.3, R * 0.3, -R * 0.3, R * 0.05);
      ctx.lineTo(-R * 0.3, -R * 0.2);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = "#eaf4ff";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(0, -R * 0.18);
      ctx.lineTo(0, R * 0.22);
      ctx.moveTo(-R * 0.16, R * 0.02);
      ctx.lineTo(R * 0.16, R * 0.02);
      ctx.stroke();
      break;
    }
    case "heal": {
      // A rounded medical cross.
      ctx.fillStyle = rim;
      const a = R * 0.12, b = R * 0.34;
      rrect(-a, -b, a * 2, b * 2, R * 0.05);
      rrect(-b, -a, b * 2, a * 2, R * 0.05);
      break;
    }
    case "mud": {
      // A muddy puddle with a couple of ripple rings.
      ctx.fillStyle = rim;
      ctx.beginPath();
      const N = 10;
      for (let i = 0; i <= N; i++) {
        const ang = (i / N) * Math.PI * 2;
        const rr2 = R * (0.3 + 0.08 * Math.sin(ang * 3 + 1.1));
        const px = Math.cos(ang) * rr2;
        const py = Math.sin(ang) * rr2 * 0.7 + R * 0.05;
        i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = "rgba(30, 18, 10, 0.45)";
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.ellipse(-R * 0.05, R * 0.02, R * 0.12, R * 0.08, 0, 0, Math.PI * 2);
      ctx.stroke();
      break;
    }
  }

  ctx.restore();
}
