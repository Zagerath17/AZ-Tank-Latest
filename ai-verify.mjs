// Verification suite for the AI, per AI-DESIGN.md §11.
// Runs the real botActions inside a faithful copy of the game's movement
// integrator, in real generated mazes.
const ROOT = "/home/claude/tb3/Tank-Brawl/js/";
const { generateMaze, wallRects, mulberry32, shapePolygon } = await import(ROOT + "maze.js");
const { botActions, AI_LEVELS } = await import(ROOT + "ai.js");

const CELL = 96, HALF = 14.3, TANKR = 21.8;
const SPEED = 120.96, REV = 83.5, TURN = 3.36;
const ACCEL = 0.5, BRAKE = 0.2, SPIN_UP = 0.28, SPIN_DOWN = 0.16;
const BULLET_SPEED = 184.3, BULLET_R = 5.44;

function arena(seed, cols = 10, rows = 8, shape = "rect") {
  const maze = generateMaze(cols, rows, mulberry32(seed), { shape, braid: 0.35 });
  return { maze, rects: wallRects(maze, CELL, 10), cols, rows };
}
const hitsWall = (rects, x, y) =>
  rects.some((r) => x > r.x - HALF && x < r.x + r.w + HALF &&
                    y > r.y - HALF && y < r.y + r.h + HALF);

function mkWorld(a, tanks, extra = {}) {
  return {
    cell: CELL, maze: a.maze, rects: a.rects, diag: [],
    walls: [], mud: [], mudSlow: 0.3,
    zoneDist: null, zoneDepthAt: null, zoneLevel: 0, zoneWarn: -1,
    tanks, tankR: TANKR, bullets: [], gear: [], rockets: [], lasers: [], snipes: [],
    bulletSpeed: BULLET_SPEED, bulletR: BULLET_R, muzzle: 24,
    magSize: 3, magGap: 500, magRegen: 3500, moveSpeed: SPEED, maxHp: 10,
    ...extra,
  };
}
function mkTank(id, tier, x, y, o = {}) {
  return { id, bot: tier, x, y, a: 0, hp: 10, dead: false, gone: false,
    weapon: o.weapon ?? "normal", defense: o.defense ?? null, agility: o.agility ?? null,
    armour: 0, phaseUntil: 0, healInMs: 0, vel: 0, spin: 0, ...o };
}

// The game's own integrator, reproduced (inertia included).
function drive(t, acts, rects, dt) {
  let reverse = false;
  if (acts.moveAngle != null && (acts.moveMag ?? 0) > 0) {
    let diff = Math.atan2(Math.sin(acts.moveAngle - t.a), Math.cos(acts.moveAngle - t.a));
    if (Math.abs(diff) > Math.PI / 2) {
      const b = acts.moveAngle + Math.PI;
      diff = Math.atan2(Math.sin(b - t.a), Math.cos(b - t.a));
      reverse = true;
    }
    const maxRate = TURN;
    const wantRate = Math.max(-maxRate, Math.min(maxRate, diff / Math.max(dt, 1e-3)));
    const opp = wantRate * (t.spin ?? 0) < 0;
    const sr = (opp || Math.abs(wantRate) < Math.abs(t.spin ?? 0))
      ? maxRate / SPIN_DOWN : maxRate / SPIN_UP;
    const dS = wantRate - (t.spin ?? 0), stepS = sr * dt;
    t.spin = Math.abs(dS) <= stepS ? wantRate : (t.spin ?? 0) + Math.sign(dS) * stepS;
    t.a += t.spin * dt;

    const align = Math.max(0, 1 - Math.abs(diff) / Math.PI);
    const thr = acts.moveMag * (0.35 + 0.65 * align);
    const want = reverse ? -REV * thr : SPEED * thr;
    const cur = t.vel ?? 0, full = SPEED;
    const opposing = want * cur < 0, easing = Math.abs(want) < Math.abs(cur);
    const rate = (opposing || easing) ? full / BRAKE : full / ACCEL;
    const d2 = want - cur, st = rate * dt;
    t.vel = Math.abs(d2) <= st ? want : cur + Math.sign(d2) * st;
  } else {
    const cur = t.vel ?? 0, st = (SPEED / BRAKE) * dt;
    t.vel = Math.abs(cur) <= st ? 0 : cur - Math.sign(cur) * st;
    t.spin = 0;
  }
  const v = t.vel ?? 0;
  const nx = t.x + Math.cos(t.a) * v * dt, ny = t.y + Math.sin(t.a) * v * dt;
  if (!hitsWall(rects, nx, t.y)) t.x = nx; else t.vel = 0;
  if (!hitsWall(rects, t.x, ny)) t.y = ny; else t.vel = 0;
  return reverse;
}

function freeCell(a) {
  for (let r = 0; r < a.rows; r++) for (let c = 0; c < a.cols; c++) {
    const x = (c + 0.5) * CELL, y = (r + 0.5) * CELL;
    if (!hitsWall(a.rects, x, y)) return { x, y };
  }
  return { x: CELL / 2, y: CELL / 2 };
}
function farCell(a, from) {
  let best = null, bd = -1;
  for (let r = 0; r < a.rows; r++) for (let c = 0; c < a.cols; c++) {
    const x = (c + 0.5) * CELL, y = (r + 0.5) * CELL;
    if (hitsWall(a.rects, x, y)) continue;
    const d = Math.hypot(x - from.x, y - from.y);
    if (d > bd) { bd = d; best = { x, y }; }
  }
  return best;
}

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name.padEnd(42)} ${detail}`);
};

/* 1 + 2 + 3 — navigation, smoothness, reverse usage ------------------- */
console.log("\n1-3. NAVIGATION / SMOOTHNESS / REVERSE  (no incoming fire)");
for (const tier of AI_LEVELS) {
  let arrived = 0, wallFrames = 0, totalFrames = 0, flips = 0, revF = 0, movF = 0, stalls = 0;
  for (let s = 1; s <= 4; s++) {
    const a = arena(s * 977);
    const start = freeCell(a), goal = farCell(a, start);
    const bot = mkTank("b", tier, start.x, start.y);
    const foe = mkTank("f", null, goal.x, goal.y);
    foe.bot = null;
    const W = mkWorld(a, [bot, foe]);
    let now = 0; const dt = 1 / 60; let prevSpin = 0, still = 0;
    for (let f = 0; f < 2400; f++) {
      now += dt * 1000;
      const acts = botActions(bot, W, dt, now);
      const px = bot.x, py = bot.y;
      const rev = drive(bot, acts, a.rects, dt);
      totalFrames++;
      if (Math.abs(bot.vel) > 4) { movF++; if (rev) revF++; }
      if (Math.abs(bot.vel) > 20 && Math.hypot(bot.x - px, bot.y - py) < 0.05) still++;
      const sp = bot.spin ?? 0;
      if (sp * prevSpin < 0 && Math.min(Math.abs(sp), Math.abs(prevSpin)) > 0.05) flips++;
      prevSpin = sp;
      // Scraping = asked to move at speed, and didn't. Proximity to a
      // wall is normal in a 96 px corridor; being stopped by one is not.
      if (Math.abs(bot.vel) < 1 && (acts.moveMag ?? 0) > 0.5) wallFrames++;
      if (Math.hypot(bot.x - foe.x, bot.y - foe.y) < CELL * 2.6) { arrived++; break; }
    }
    if (still > 120) stalls++;
  }
  const secs = totalFrames / 60;
  check(`${tier}: closes on a distant enemy`, arrived >= 3, `${arrived}/4 runs`);
  check(`${tier}: scraping < 8%`, wallFrames / totalFrames < 0.08,
    `${(wallFrames / totalFrames * 100).toFixed(1)}%`);
  check(`${tier}: turn reversals < 6/s`, flips / secs < 6, `${(flips / secs).toFixed(1)}/s`);
  check(`${tier}: reverse < 15% of movement`, movF === 0 || revF / movF < 0.15,
    `${movF ? (revF / movF * 100).toFixed(0) : 0}%`);
  check(`${tier}: no stalls`, stalls === 0, `${stalls}/4 runs stalled`);
}

/* 4 — dodging, and it must SEPARATE by tier --------------------------- */
console.log("\n4. DODGING  (hits taken from volleys — lower is better)");
const dodge = {};
for (const tier of AI_LEVELS) {
  dodge[tier] = {};
  for (const n of [1, 3, 5]) {
    let hits = 0;
    for (let s = 1; s <= 8; s++) {
      const a = arena(s * 31);
      const start = freeCell(a);
      const bot = mkTank("b", tier, start.x + CELL * 2, start.y + CELL * 2);
      const foe = { id: "f", x: start.x, y: start.y };   // a gun, not a tank
      const W = mkWorld(a, [bot]);
      let now = 0; const dt = 1 / 60;
      for (let f = 0; f < 1400; f++) {
        now += dt * 1000;
        if (f % 75 === 0) {
          for (let k = 0; k < n; k++) {
            const ang = Math.atan2(bot.y - foe.y, bot.x - foe.x) + (k - (n - 1) / 2) * 0.16;
            W.bullets.push({ by: "f", born: now,
              x: bot.x - Math.cos(ang) * 250, y: bot.y - Math.sin(ang) * 250,
              vx: Math.cos(ang) * BULLET_SPEED, vy: Math.sin(ang) * BULLET_SPEED, r: BULLET_R });
          }
        }
        for (const b of W.bullets) { b.x += b.vx * dt; b.y += b.vy * dt; }
        for (let i = W.bullets.length - 1; i >= 0; i--) {
          const b = W.bullets[i];
          if (Math.hypot(b.x - bot.x, b.y - bot.y) < TANKR * 0.75) { hits++; W.bullets.splice(i, 1); continue; }
          if (b.x < -80 || b.y < -80 || b.x > a.cols * CELL + 80 || b.y > a.rows * CELL + 80) W.bullets.splice(i, 1);
        }
        drive(bot, botActions(bot, W, dt, now), a.rects, dt);
      }
    }
    dodge[tier][n] = hits / 8;
  }
  console.log(`  ${tier.padEnd(11)} 1-round ${dodge[tier][1].toFixed(1)}   3-round ${dodge[tier][3].toFixed(1)}   5-round ${dodge[tier][5].toFixed(1)}`);
}
check("dodging separates by tier (5-round volley)",
  dodge.impossible[5] < dodge.easy[5],
  `easy ${dodge.easy[5].toFixed(1)} -> impossible ${dodge.impossible[5].toFixed(1)}`);

/* 5 — gear discipline -------------------------------------------------- */
console.log("\n5. GEAR");
{
  const a = arena(4242);
  const start = freeCell(a);
  const bot = mkTank("b", "impossible", start.x, start.y, { weapon: "mg" });
  const foe = mkTank("f", null, start.x + CELL * 4, start.y); foe.bot = null;
  const W = mkWorld(a, [bot, foe]);
  W.gear = [{ x: start.x + CELL * 1.5, y: start.y, type: "rocket" }];
  let approached = false;
  let now = 0; const dt = 1 / 60;
  const d0 = Math.hypot(W.gear[0].x - bot.x, W.gear[0].y - bot.y);
  for (let f = 0; f < 600; f++) {
    now += dt * 1000;
    drive(bot, botActions(bot, W, dt, now), a.rects, dt);
    if (Math.hypot(W.gear[0].x - bot.x, W.gear[0].y - bot.y) < d0 * 0.35) approached = true;
  }
  check("armed bot ignores a weapon crate", !approached, approached ? "chased it" : "ignored it");
}
{
  const a = arena(4242);
  const start = freeCell(a);
  const bot = mkTank("b", "impossible", start.x, start.y);       // unarmed
  const W = mkWorld(a, [bot]);
  W.gear = [{ x: start.x + CELL * 1.5, y: start.y, type: "rocket" }];
  let got = false; let now = 0; const dt = 1 / 60;
  for (let f = 0; f < 900; f++) {
    now += dt * 1000;
    drive(bot, botActions(bot, W, dt, now), a.rects, dt);
    if (Math.hypot(W.gear[0].x - bot.x, W.gear[0].y - bot.y) < 30) { got = true; break; }
  }
  check("unarmed bot collects a weapon crate", got, got ? "collected" : "never reached it");
}

/* 6 — the zone --------------------------------------------------------- */
console.log("\n6. ZONE");
{
  const a = arena(555);
  const poly = [[0, 0], [a.cols * CELL, 0], [a.cols * CELL, a.rows * CELL], [0, a.rows * CELL]];
  const ptSeg = (px, py, x1, y1, x2, y2) => {
    const dx = x2 - x1, dy = y2 - y1, L = dx * dx + dy * dy;
    let s = L > 1e-9 ? ((px - x1) * dx + (py - y1) * dy) / L : 0;
    s = Math.max(0, Math.min(1, s));
    return Math.hypot(px - (x1 + dx * s), py - (y1 + dy * s));
  };
  const depthAt = (x, y) => {
    let b = Infinity;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const d = ptSeg(x, y, poly[j][0], poly[j][1], poly[i][0], poly[i][1]);
      if (d < b) b = d;
    }
    return b / CELL;
  };
  for (const tier of ["hard", "impossible"]) {
    const start = { x: CELL * 0.5, y: CELL * 0.5 };      // in the outer ring
    const bot = mkTank("b", tier, start.x, start.y);
    const W = mkWorld(a, [bot], { zoneDepthAt: depthAt, zoneLevel: 1, zoneWarn: 1 });
    let inRed = 0; let now = 0; const dt = 1 / 60;
    for (let f = 0; f < 900; f++) {
      now += dt * 1000;
      drive(bot, botActions(bot, W, dt, now), a.rects, dt);
      if (Math.floor(depthAt(bot.x, bot.y)) < 1) inRed++;
    }
    check(`${tier}: leaves the red zone`, inRed < 300,
      `${(inRed / 9).toFixed(0)}% of frames in red`);
  }
}

/* 7 — abilities -------------------------------------------------------- */
console.log("\n7. ABILITIES");
{
  const a = arena(99);
  const start = freeCell(a);
  // phase should fire with a round inbound, and NOT when nothing is
  const mk = (opts, bullets) => {
    const bot = mkTank("b", "impossible", start.x, start.y, opts);
    const W = mkWorld(a, [bot]);
    let used = false; let now = 0; const dt = 1 / 60;
    for (let f = 0; f < 400; f++) {
      now += dt * 1000;
      if (bullets && f % 40 === 0) {
        // Aimed at where the bot IS, each time, so the test measures the
        // AI rather than whether the bot happened to wander off the line.
        W.bullets.length = 0;
        const ang = Math.random() * Math.PI * 2;
        W.bullets.push({ by: "f", born: now,
          x: bot.x - Math.cos(ang) * 150, y: bot.y - Math.sin(ang) * 150,
          vx: Math.cos(ang) * BULLET_SPEED, vy: Math.sin(ang) * BULLET_SPEED, r: BULLET_R });
      }
      for (const b of W.bullets) { b.x += b.vx * dt; b.y += b.vy * dt; }
      const acts = botActions(bot, W, dt, now);
      if (acts.agi || acts.def) used = true;
      drive(bot, acts, a.rects, dt);
    }
    return used;
  };
  check("phase fires against an inbound round", mk({ agility: "phase" }, true), "");
  check("phase held when nothing is incoming", !mk({ agility: "phase" }, false), "");
  check("heal held while under fire", !mk({ defense: "heal", hp: 4 }, true), "");
}

/* 8 — no stupidity ------------------------------------------------------ */
console.log("\n8. NO STUPIDITY");
{
  const a = arena(1234);
  const start = freeCell(a);
  const bot = mkTank("b", "impossible", start.x, start.y);
  const foe = mkTank("f", null, start.x + CELL * 2, start.y); foe.bot = null;
  foe.phaseUntil = 1e9;                                  // permanently phasing
  const W = mkWorld(a, [bot, foe]);
  let shots = 0; let now = 0; const dt = 1 / 60;
  for (let f = 0; f < 700; f++) {
    now += dt * 1000;
    const acts = botActions(bot, W, dt, now);
    if (acts.shoot) shots++;
    drive(bot, acts, a.rects, dt);
  }
  check("never fires at a phasing target", shots === 0, `${shots} shots`);
}

/* summary --------------------------------------------------------------- */
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log("FAILED:");
  for (const f of failed) console.log("   " + f.name + "  " + f.detail);
}
