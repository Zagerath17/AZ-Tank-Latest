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

export const WEAPON_TYPES = ["laser", "mg", "rocket", "cannon", "sniper", "boost", "phase", "wall"];

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
  boost:  { len: 1.5,  hw: 0.31 },
  phase:  { len: 1.5,  hw: 0.31 },
  wall:   { len: 1.5,  hw: 0.31 },
};

// Tunables (speeds/radii are multipliers of the normal bullet).
export const LASER = {
  previewBounces: 6, // aiming line reflects this many times
  shotBounces: 9,    // the fired beam reflects this many times
  width: 0.9,        // beam half-thickness, × bullet radius
  beamSpeed: 9500,   // px/s — you can SEE it travel, but barely
  flashMs: 320,
};

export const SNIPER = {
  shots: 2,          // two rounds total
  rangeCells: 5,     // the bullet dies after this many cells
  previewCells: 3,   // aim preview reaches this far (no bounce)
  speed: 4.2,        // × normal bullet — a fast round
  r: 0.42,           // slim slug, × bullet radius
};

export const BOOST = {
  mult: 1.2,         // +20% move speed
  durationMs: 6000,  // for six seconds
};

export const PHASE = {
  durationMs: 2000,  // two seconds of intangibility
  opacity: 0.5,      // half-transparent while phasing
};

// A temporary brick wall the player drops. It BLOCKS movement and
// eats projectiles (they don't bounce off it — they're consumed). It
// takes different hit-values per weapon, and expires after 10 s.
export const WALL = {
  lifeMs: 10000,
  lengthCells: 0.5,  // half a cell long
  thickCells: 0.16,  // slab thickness
  // "health" is abstract; each weapon subtracts a share sized so the
  // stated shot-counts destroy it. HP = 12 (LCM-friendly):
  //   basic 3 shots → 4 each; fractal 4 → 3; MG 7 → ~1.72;
  //   laser/cannon/rocket/sniper 1 → 12 (one-shot).
  // HP = 84 (LCM of 3,4,7) so every shot-count divides evenly with
  // integer damage — no floating-point rounding surprises.
  hp: 84,
  dmg: {
    basic: 28,     // 84/3  → 3 basic shots
    shrapnel: 21,  // 84/4  → 4 fractals
    mg: 12,        // 84/7  → 7 MG rounds
    laser: 84,     // one-shot
    cannon: 84,
    rocket: 84,
    sniper: 84,
  },
};

export const MG = {
  windupMs: 500,     // barrel spin-up on the first trigger pull
  shots: 16,         // total balls per pickup — hold or tap to fire
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
  shrapN: 30,        // irregular shrapnel burst on expiry / tank hit
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
  mg: "#e5a13c",      // amber
  rocket: "#c65cff",  // violet
  cannon: "#566072",  // steel
  sniper: "#33c2b0",  // teal
  boost: "#ffd23f",   // yellow
};
export const WEAPON_NAMES = {
  laser: "Laser",
  mg: "Machine Gun",
  rocket: "Homing Rocket",
  cannon: "Cannon",
  sniper: "Sniper",
  boost: "Speed Boost",
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
  }

  ctx.restore();
}
