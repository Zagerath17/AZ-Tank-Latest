// ================================================================
// game.js — the battle arena.
//
// v0.3 adds: shooting (bouncing bullets, 5 live per tank, they kill
// anyone — including you), bot tanks (easy/medium/hard), rounds
// with scores, and Tank-Trouble wall friction: touching a wall at
// any angle is a HARD STOP — tanks never slide along walls.
//
// Modes:
//   startLocalGame(specs)  — specs: [{color, bot: null|'easy'|...}]
//   startOnlineGame(opts)  — you drive your tank; the "controller"
//                            client (host) also drives the bots.
// ================================================================

import { showScreen, toast, COLORS, COLOR_NAMES, tankSVG } from "./main.js";
import { getBinds } from "./settings.js";
import { mulberry32, generateMaze, wallRects, segmentFirstHit } from "./maze.js";
import { botActions, AI_PARAMS } from "./ai.js";
import {
  WEAPON_TYPES, BARRELS, LASER, MG, ROCKET, CANNON,
  laserPath, rocketSeekStep, stepShrap, bounceCircle, drawBarrel, drawGear,
} from "./weapons.js";
import { sfx, setEngine, startMusic, stopAll } from "./audio.js";

/* ---------- tuning ---------- */

const CELL = 96;                     // corridor spacing — walls are much more spread out
const WALL_T = 10;
const U = 64;                        // tank & ballistics scale (unchanged — tanks stay the same size)
const TANK_R = U * 0.27;             // base scale for the tank's size
const TANK_HL = TANK_R * 0.95;       // hitbox half-LENGTH (along the barrel) — matches the drawn treads
const TANK_HW = TANK_R * 0.83;       // hitbox half-WIDTH — matches the drawn treads
const TANK_RAD = Math.hypot(TANK_HL, TANK_HW); // bounding radius (broadphase / AI planning)
const MOVE_SPEED = U * 2.1;
const REVERSE_SPEED = U * 1.45;
const TURN_SPEED = 3.2 * 1.05; // tanks turn 5% quicker

const GEAR_R = 14;             // pickup grab radius (added to the tank's)
const GEAR_MAX = 15;           // pickups on the field at once
const GEAR_FIRST_MS = 3500;    // first pickup after round start
const GEAR_EVERY_MS = 5500;    // then every 5.5–9 s

const BULLET_SPEED = U * 3.2;
const BULLET_R = U * 0.085;
const BULLET_LIFE = 6000;   // ms a bullet keeps bouncing
const MAX_BULLETS = 5;      // live bullets per tank (Tank Trouble classic)

const ROUND_PAUSE = 2600;   // ms between rounds
const NET_SEND_MS = 90;
const MAZE_SIZES = [
  [7, 5], [7, 6], [8, 5], [8, 6], [8, 7], [9, 5],
  [9, 6], [9, 7], [10, 6], [10, 7], [11, 6], [11, 8],
];

const HULL = { red: "#ff5147", green: "#46d160", blue: "#47a3ff", yellow: "#ffc531" };
const NO_MUL = { speed: 1, turn: 1 };

/* ---------- module state ---------- */

let S = null;
let canvas, ctx, exitBtn, touchPad, scoreEl;
const held = new Set();
const touchHeld = new Set();

/* ================================================================
   Public API
   ================================================================ */

export function initGame() {
  canvas = document.getElementById("arena");
  ctx = canvas.getContext("2d");
  exitBtn = document.getElementById("game-exit");
  touchPad = document.getElementById("touch-pad");
  scoreEl = document.getElementById("game-score");

  exitBtn.addEventListener("click", () => {
    const s = S;
    stopGame();
    if (s?.mode === "online") s.onExit?.();
    else showScreen("screen-local");
  });

  touchPad.querySelectorAll(".tp-btn").forEach((btn) => {
    const act = btn.dataset.act;
    const on = (e) => { e.preventDefault(); touchHeld.add(act); btn.classList.add("held"); };
    const off = () => { touchHeld.delete(act); btn.classList.remove("held"); };
    btn.addEventListener("pointerdown", on);
    btn.addEventListener("pointerup", off);
    btn.addEventListener("pointercancel", off);
    btn.addEventListener("pointerleave", off);
    btn.addEventListener("contextmenu", (e) => e.preventDefault());
  });
}

// specs: [{ color, bot: null | 'easy' | 'medium' | 'hard' }]
export function startLocalGame(specs) {
  begin({
    mode: "local",
    seed: randomSeed(),
    roundN: 1,
    roster: specs.map((s) => ({ id: s.color, color: s.color, bot: s.bot ?? null })),
  });
}

// opts: { roundN, seed, myId, roster: [{id, color, bot}],
//         sendPos(id,pos), sendShot(id,key,shot), sendDead(id),
//         sendNextRound(n,seed), onExit() }
export function startOnlineGame(opts) {
  begin(opts_toState(opts));
}

function opts_toState(o) {
  return {
    mode: "online",
    seed: o.seed,
    roundN: o.roundN ?? 1,
    myId: o.myId,
    roster: o.roster,
    sendPos: o.sendPos,
    sendShot: o.sendShot,
    sendDead: o.sendDead,
    sendNextRound: o.sendNextRound,
    sendGear: o.sendGear,
    sendPickup: o.sendPickup,
    sendGun: o.sendGun,
    onExit: o.onExit,
  };
}

export function stopGame() {
  if (!S) return;
  stopAll();
  cancelAnimationFrame(S.raf);
  window.removeEventListener("keydown", onKeydown);
  window.removeEventListener("keyup", onKeyup);
  window.removeEventListener("blur", clearHeld);
  touchPad.hidden = true;
  if (scoreEl) scoreEl.innerHTML = "";
  S = null;
}

export function isGameActive() {
  return !!S;
}

// Called by online.js with the full lobby on every snapshot mid-match.
export function onlineLobbyUpdate(lobby) {
  if (!S || S.mode !== "online") return;
  const players = lobby.players ?? {};

  // Who runs the bots + round resets? The host if they're still a
  // present human; otherwise the first human from the join order.
  let controller = null;
  const hostP = players[lobby.hostId];
  if (hostP && !hostP.bot) controller = lobby.hostId;
  else {
    for (const p of S.roster) {
      if (!p.bot && players[p.id]) { controller = p.id; break; }
    }
  }
  S.isController = controller === S.myId;

  S.present = new Set(Object.keys(players));

  // Controller pushed a new round?
  if (lobby.round && lobby.round.n !== S.roundN) {
    S.roundN = lobby.round.n;
    startRound(lobby.round.seed);
  }
  refreshBotOwnership();

  // Weapon pickups live on the lobby ("gear"). Skip ones we just
  // grabbed locally so a stale snapshot can't resurrect them.
  const nowMs = performance.now();
  S.gear = Object.entries(lobby.gear ?? {})
    .filter(([key]) => !(S.takenGear.has(key) && nowMs - S.takenGear.get(key) < 3000))
    .map(([key, g]) => ({ key, x: g.x, y: g.y, type: g.type }));
  for (const g of S.gear) {
    if (!S.gearSeen.has(g.key)) {
      S.gearSeen.set(g.key, nowMs);
      sfx.gearSpawn();
    }
    g.born = S.gearSeen.get(g.key);
  }

  let meIn = false;
  for (const t of S.tanks) {
    const p = players[t.id];
    if (t.id === S.myId && p) meIn = true;

    if (!p) {
      if (!t.gone) {
        t.gone = true;
        if (!t.bot) toast(`${COLOR_NAMES[t.color]} left the battle.`);
      }
      continue;
    }
    t.gone = false;

    if (p.dead && !t.dead) t.dead = true;

    // Equipped weapon (drives the barrel sprite AND hitbox everywhere).
    const gun = p.gun ?? null;
    if (!t.local) {
      t.weapon = gun;
    } else if (gun && gun !== t.weapon && nowMs - t.gunClearedAt > 1500) {
      t.weapon = gun;
      if (!t.local) sfx.pickup();
    }

    if (!t.local) {
      if (p.pos) { t.tx = p.pos.x; t.ty = p.pos.y; t.ta = p.pos.a; }
      if (p.shots) {
        const seen = (S.seenShots[t.id] ??= new Set());
        for (const [key, sh] of Object.entries(p.shots)) {
          if (seen.has(key)) continue;
          seen.add(key);
          spawnShot(t.id, sh);
        }
      }
    }
  }

  if (!meIn) {
    const cb = S.onExit;
    stopGame();
    toast("You were removed from the lobby.");
    cb?.();
  }
}

/* ================================================================
   Setup
   ================================================================ */

function begin(opts) {
  stopGame();

  S = {
    mode: opts.mode,
    myId: opts.myId ?? null,
    roster: opts.roster.slice(0, 4),
    scores: Object.fromEntries(opts.roster.map((p) => [p.color, 0])),
    present: new Set(opts.roster.map((p) => p.id)),
    isController: opts.mode === "local",
    sendPos: opts.sendPos,
    sendShot: opts.sendShot,
    sendDead: opts.sendDead,
    sendNextRound: opts.sendNextRound,
    sendGear: opts.sendGear,
    sendPickup: opts.sendPickup,
    sendGun: opts.sendGun,
    onExit: opts.onExit,
    roundN: opts.roundN ?? 1,
    tanks: [],
    bullets: [],
    gear: [],
    takenGear: new Map(),
    gearSeen: new Map(), // key -> first-seen time (for pop-in + chime)
    fades: [],    // dying projectiles, briefly ghosting out
    dust: [],     // little clouds kicked up behind driving tanks
    gearNextAt: 0,
    gearSeq: 0,
    rockets: [],
    cannons: [],
    shraps: [],
    beams: [],
    booms: [],
    seenShots: {},
    banner: null,
    roundOverAt: 0,
    sentNext: false,
    lastT: performance.now(),
    lastSend: 0,
    raf: 0,
  };

  startRound(opts.seed);

  held.clear();
  touchHeld.clear();
  window.addEventListener("keydown", onKeydown);
  window.addEventListener("keyup", onKeyup);
  window.addEventListener("blur", clearHeld);

  // On-screen controls when a touch device drives exactly one human tank.
  const isTouch = navigator.maxTouchPoints > 0 || "ontouchstart" in window;
  const humanLocal = S.tanks.filter((t) => t.local && !t.bot).length;
  touchPad.hidden = !(isTouch && humanLocal === 1);

  updateScoreHUD();
  showScreen("screen-game");
  startMusic();
  S.raf = requestAnimationFrame(frame);
}

function startRound(seed) {
  const rng = mulberry32(seed);
  const [cols, rows] = MAZE_SIZES[Math.floor(rng() * MAZE_SIZES.length)];
  S.maze = generateMaze(cols, rows, rng);
  S.rects = wallRects(S.maze, CELL, WALL_T);
  S.worldW = cols * CELL;
  S.worldH = rows * CELL;
  S.bullets = [];
  S.gear = [];
  S.takenGear.clear();
  S.gearSeen.clear();
  S.fades = [];
  S.dust = [];
  S.gearNextAt = performance.now() + GEAR_FIRST_MS;
  S.rockets = [];
  S.cannons = [];
  S.shraps = [];
  S.beams = [];
  S.booms = [];
  S.seenShots = {};
  S.banner = null;
  S.roundOverAt = 0;
  S.sentNext = false;

  // Players 1 & 2 in opposite corners, 3 & 4 in the other pair.
  const corners = [
    [0, 0],
    [cols - 1, rows - 1],
    [cols - 1, 0],
    [0, rows - 1],
  ];

  S.tanks = S.roster.map((spec, i) => {
    const [c, r] = corners[i];
    const x = (c + 0.5) * CELL;
    const y = (r + 0.5) * CELL;
    const a = Math.atan2(S.worldH / 2 - y, S.worldW / 2 - x);
    return {
      ...spec,
      local: S.mode === "local" ? true : spec.id === S.myId,
      x, y, a, tx: x, ty: y, ta: a,
      dead: false,
      gone: !S.present.has(spec.id),
      prevShoot: false,
      weapon: null,
      mg: null,
      gunClearedAt: 0,
      ai: null,
    };
  });
  refreshBotOwnership();

  S.roundStartCount = S.tanks.filter((t) => !t.gone).length;
}

function refreshBotOwnership() {
  if (!S || S.mode !== "online") return;
  for (const t of S.tanks) {
    if (t.bot) t.local = S.isController;
  }
}

/* ================================================================
   Input
   ================================================================ */

function onKeydown(e) {
  if (isBoundCode(e.code)) e.preventDefault();
  held.add(e.code);
}

function onKeyup(e) {
  held.delete(e.code);
}

function clearHeld() {
  held.clear();
  touchHeld.clear();
}

function isBoundCode(code) {
  const b = getBinds();
  return COLORS.some((c) =>
    ["up", "down", "left", "right", "shoot"].some((a) => b[c][a] === code),
  );
}

function readActions(tank, binds) {
  const acts = { up: false, down: false, left: false, right: false, shoot: false };

  // Local: strictly your color's binds. Online: your (only) tank
  // answers to any color's binds, so WASD and arrows both work.
  const sources = S.mode === "online" ? COLORS : [tank.color];
  for (const c of sources) {
    for (const a of ["up", "down", "left", "right", "shoot"]) {
      const code = binds[c][a];
      if (code && held.has(code)) acts[a] = true;
    }
  }

  // Touch pad only ever drives the single local human tank.
  if (!tank.bot) {
    for (const a of touchHeld) acts[a] = true;
  }
  return acts;
}

/* ================================================================
   Simulation
   ================================================================ */

function frame(now) {
  if (!S) return;
  const dt = Math.min((now - S.lastT) / 1000, 0.05);
  S.lastT = now;

  // Shared per-frame data: laser aiming lines (drawn for everyone,
  // dodged by bots) and the hazard list bots treat as bullets.
  S.laserPaths = [];
  for (const t of S.tanks) {
    if (t.dead || t.gone || t.weapon !== "laser") continue;
    const m = muzzlePoint(t, 1);
    S.laserPaths.push({ by: t.id, color: HULL[t.color], pts: laserPath(m.x, m.y, t.a, S.rects, LASER.previewBounces) });
  }
  // Bots treat every projectile as a bullet to dodge: minis, cannon
  // balls, shrapnel, and rockets still in their straight dumb-fire
  // phase (seeking rockets are handled by the flee behavior).
  let straightRk = null;
  for (const rk of S.rockets) {
    if (now - rk.born < ROCKET.straightMs) (straightRk ??= []).push(rk);
  }
  S.aiBullets = (S.cannons.length || S.shraps.length || straightRk)
    ? S.bullets.concat(S.cannons, S.shraps, straightRk ?? [])
    : S.bullets;

  S.engineMoving = false;
  if (!S.banner) {
    stepTanks(now, dt);
    stepBullets(now, dt);
    stepSpecials(now, dt);
    maybeEndRound(now);
  } else if (now - S.roundOverAt > ROUND_PAUSE) {
    if (S.mode === "local") {
      S.roundN += 1;
      startRound(randomSeed());
    } else if (S.isController && !S.sentNext) {
      S.sentNext = true;
      S.sendNextRound?.(S.roundN + 1, randomSeed());
    }
    // Non-controller online clients wait for the round push.
  }

  if (S.mode === "online" && now - S.lastSend > NET_SEND_MS) {
    S.lastSend = now;
    for (const t of S.tanks) {
      if (t.local && !t.dead && !t.gone) {
        S.sendPos?.(t.id, { x: +t.x.toFixed(1), y: +t.y.toFixed(1), a: +t.a.toFixed(3) });
      }
    }
  }

  setEngine(!S.banner, S.engineMoving);
  draw(now);
  S.raf = requestAnimationFrame(frame);
}

function stepTanks(now, dt) {
  const binds = getBinds();

  for (const t of S.tanks) {
    if (t.dead || t.gone) continue;

    if (t.local) {
      const acts = t.bot
        ? botActions(t, {
            cell: CELL,
            maze: S.maze,
            rects: S.rects,
            tanks: S.tanks,
            tankR: TANK_RAD,
            bullets: S.aiBullets ?? S.bullets,
            gear: S.gear,
            rockets: S.rockets,
            lasers: S.laserPaths,
            bulletSpeed: BULLET_SPEED,
            bulletR: BULLET_R,
            muzzle: BARRELS.normal.len * TANK_R + BULLET_R + 2,
            maxBullets: MAX_BULLETS,
            moveSpeed: MOVE_SPEED,
          }, dt, now)
        : readActions(t, binds);
      const mul = t.bot ? AI_PARAMS[t.bot] : NO_MUL;

      // Rotation uses the real rectangular hitbox: if the swing would
      // clip a wall, the turn is blocked until the tank backs off.
      const turn = (acts.right ? 1 : 0) - (acts.left ? 1 : 0);
      if (turn !== 0) {
        const na = t.a + turn * TURN_SPEED * mul.turn * dt;
        if (!tankHitsAnyWall(t, t.x, t.y, na)) t.a = na;
      }

      let v = 0;
      if (acts.up) v += MOVE_SPEED * mul.speed;
      if (acts.down) v -= REVERSE_SPEED * mul.speed;

      if (v !== 0 && !t.bot) S.engineMoving = true;

      // Track link animation: each tread scrolls at its own ground
      // speed. Turning makes them differ; a zero-point turn spins
      // them in OPPOSITE directions, just like a real tank.
      {
        const w = turn * TURN_SPEED * mul.turn; // rad/s (commanded)
        const half = TANK_R * 0.62;
        t.trkL = (t.trkL ?? 0) + (v + w * half) * dt;
        t.trkR = (t.trkR ?? 0) + (v - w * half) * dt;
      }

      // Kick up a faint dust puff behind a driving tank.
      if (v !== 0 && now >= (t.dustAt ?? 0)) {
        t.dustAt = now + 65 + Math.random() * 45;
        const back = v > 0 ? -1 : 1;
        S.dust.push({
          x: t.x + Math.cos(t.a) * TANK_R * back + (Math.random() - 0.5) * 6,
          y: t.y + Math.sin(t.a) * TANK_R * back + (Math.random() - 0.5) * 6,
          vx: Math.cos(t.a) * back * 9 + (Math.random() - 0.5) * 8,
          vy: Math.sin(t.a) * back * 9 + (Math.random() - 0.5) * 8,
          born: now,
        });
        if (S.dust.length > 260) S.dust.shift();
      }

      if (v !== 0) {
        // WALL FRICTION, Tank-Trouble style: if the move would touch
        // a wall — even at a shallow angle — the tank hard-stops.
        // No sliding along walls. Turn away first, then drive.
        const nx = t.x + Math.cos(t.a) * v * dt;
        const ny = t.y + Math.sin(t.a) * v * dt;
        if (!tankHitsAnyWall(t, nx, ny, t.a)) {
          t.x = nx;
          t.y = ny;
        }
      }

      if (acts.shoot && !t.prevShoot) tryFire(t, now);
      t.prevShoot = acts.shoot;

      // Machine gun: the FIRST trigger pull spins the barrel up
      // (glowing muzzle, half a second). After that it's manual —
      // hold to spray at full rate, tap for single shots. The gun
      // stays until all its balls are spent.
      if (t.weapon === "mg" && acts.shoot) {
        if (!t.mgReadyAt) {
          t.mgReadyAt = now + MG.windupMs;
          sfx.windup();
        } else if (now >= t.mgReadyAt && now >= (t.mgNext ?? 0)) {
          t.mgAmmo ??= MG.shots;
          const m = muzzlePoint(t, MG.r * BULLET_R);
          const a = t.a + (Math.random() * 2 - 1) * MG.spread;
          spawnBullet(t.id, m.x, m.y, a, now, true);
          sendTypedShot(t, { w: "mini", x: +m.x.toFixed(1), y: +m.y.toFixed(1), a: +a.toFixed(3) }, now);
          t.mgNext = now + MG.gapMs;
          t.mgAmmo -= 1;
          if (t.mgAmmo <= 0) {
            t.mgAmmo = null;
            clearWeapon(t, now); // spent — barrel reverts, pickups unlock
          }
        }
      }
    } else {
      // Remote tank: glide toward its last reported transform.
      const ox = t.x;
      const oy = t.y;
      const oa = t.a;
      const k = 1 - Math.exp(-12 * dt);
      t.x += (t.tx - t.x) * k;
      t.y += (t.ty - t.y) * k;
      t.a += angleDiff(t.a, t.ta) * k;

      // Tracks + dust from the observed motion.
      const fwd = (t.x - ox) * Math.cos(t.a) + (t.y - oy) * Math.sin(t.a);
      const spin = angleDiff(oa, t.a);
      const half = TANK_R * 0.62;
      t.trkL = (t.trkL ?? 0) + fwd + spin * half;
      t.trkR = (t.trkR ?? 0) + fwd - spin * half;
      if (Math.abs(fwd) > 28 * dt && now >= (t.dustAt ?? 0)) {
        t.dustAt = now + 70 + Math.random() * 45;
        const back = fwd > 0 ? -1 : 1;
        S.dust.push({
          x: t.x + Math.cos(t.a) * TANK_R * back + (Math.random() - 0.5) * 6,
          y: t.y + Math.sin(t.a) * TANK_R * back + (Math.random() - 0.5) * 6,
          vx: Math.cos(t.a) * back * 9,
          vy: Math.sin(t.a) * back * 9,
          born: now,
        });
        if (S.dust.length > 260) S.dust.shift();
      }
    }
  }

  // Tanks shove each other (never through each other).
  const alive = S.tanks.filter((t) => !t.dead && !t.gone);
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < alive.length; i++) {
      for (let j = i + 1; j < alive.length; j++) {
        separate(alive[i], alive[j]);
      }
    }
    // Safety: being shoved must never push a tank inside a wall.
    for (const t of alive) {
      if (!t.local) continue;
      for (const rect of S.rects) {
        const mtv = obbRectMTV(t.x, t.y, t.a, rect);
        if (mtv) {
          t.x += mtv.nx * mtv.depth;
          t.y += mtv.ny * mtv.depth;
        }
      }
      t.x = clamp(t.x, TANK_RAD, S.worldW - TANK_RAD);
      t.y = clamp(t.y, TANK_RAD, S.worldH - TANK_RAD);
    }
  }
}

/* ---------- shooting ---------- */

// Barrel tip for the current weapon, pulled back if the barrel pokes
// through a wall so nothing spawns on the far side. projR = the
// projectile's radius (kept clear of the barrel tip).
function muzzlePoint(t, projR) {
  const bl = BARRELS[t.weapon] ?? BARRELS.normal;
  const len = bl.len * TANK_R + projR + 2;
  const tipX = t.x + Math.cos(t.a) * len;
  const tipY = t.y + Math.sin(t.a) * len;
  const hit = segmentFirstHit(t.x, t.y, tipX, tipY, S.rects);
  const k = Math.min(1, Math.max(0.2, hit * 0.9));
  return { x: t.x + (tipX - t.x) * k, y: t.y + (tipY - t.y) * k };
}

function sendTypedShot(t, payload, now) {
  if (S.mode !== "online" || !t.local) return;
  // Math.floor matters: float timestamps stringify with a "." which
  // is an ILLEGAL character in Firebase paths — the write would throw
  // and take the whole game loop down with it.
  const key = Math.floor(now).toString(36) + Math.random().toString(36).slice(2, 8);
  (S.seenShots[t.id] ??= new Set()).add(key);
  S.sendShot?.(t.id, key, payload);
}

function clearWeapon(t, now) {
  t.weapon = null;
  t.mgReadyAt = 0;
  t.mgNext = 0;
  t.mgAmmo = null;
  t.gunClearedAt = now;
  if (S.mode === "online" && t.local) S.sendGun?.(t.id, null);
}

function tryFire(t, now) {
  if (t.weapon === "mg") return; // manual fire — handled in stepTanks

  if (t.weapon) {
    fireSpecial(t, now);
    return;
  }

  let live = 0;
  for (const b of S.bullets) if (b.by === t.id && !b.mini) live++;
  if (live >= MAX_BULLETS) return;

  const m = muzzlePoint(t, BULLET_R);
  spawnBullet(t.id, m.x, m.y, t.a, now);
  sendTypedShot(t, { x: +m.x.toFixed(1), y: +m.y.toFixed(1), a: +t.a.toFixed(3) }, now);
}

function fireSpecial(t, now) {
  const w = t.weapon;

  if (w === "laser") {
    const m = muzzlePoint(t, 1);
    fireLaser(t.id, m.x, m.y, t.a, now);
    sendTypedShot(t, { w: "laser", x: +m.x.toFixed(1), y: +m.y.toFixed(1), a: +t.a.toFixed(3) }, now);
  } else if (w === "rocket") {
    const m = muzzlePoint(t, ROCKET.r * BULLET_R);
    spawnRocket(t.id, m.x, m.y, t.a, now);
    sendTypedShot(t, { w: "rocket", x: +m.x.toFixed(1), y: +m.y.toFixed(1), a: +t.a.toFixed(3) }, now);
  } else if (w === "cannon") {
    const m = muzzlePoint(t, CANNON.r * BULLET_R);
    spawnCannon(t.id, m.x, m.y, t.a, now);
    sendTypedShot(t, { w: "cannon", x: +m.x.toFixed(1), y: +m.y.toFixed(1), a: +t.a.toFixed(3) }, now);
  }

  clearWeapon(t, now);
}

// Online receive: one dispatcher for every shot type.
function spawnShot(byId, sh, now = performance.now()) {
  switch (sh.w) {
    case "mini": spawnBullet(byId, sh.x, sh.y, sh.a, now, true); break;
    case "laser": fireLaser(byId, sh.x, sh.y, sh.a, now); break;
    case "rocket": spawnRocket(byId, sh.x, sh.y, sh.a, now); break;
    case "cannon": spawnCannon(byId, sh.x, sh.y, sh.a, now); break;
    default: spawnBullet(byId, sh.x, sh.y, sh.a, now);
  }
}

function spawnBullet(byId, x, y, a, now = performance.now(), mini = false) {
  if (mini) sfx.mini(); else sfx.fire();
  const speed = mini ? BULLET_SPEED * MG.speed : BULLET_SPEED;
  S.bullets.push({
    x, y,
    vx: Math.cos(a) * speed,
    vy: Math.sin(a) * speed,
    born: now,
    by: byId,
    r: mini ? BULLET_R * MG.r : BULLET_R,
    life: mini ? MG.lifeMs : BULLET_LIFE,
    mini,
  });
}

function stepBullets(now, dt) {
  const survivors = [];

  for (const b of S.bullets) {
    if (now - b.born > (b.life ?? BULLET_LIFE)) {
      addFade(b.x, b.y, b.r ?? BULLET_R, now);
      continue;
    }

    // Substeps so fast bullets can't tunnel through thin walls.
    const travel = Math.hypot(b.vx, b.vy) * dt;
    const steps = Math.max(1, Math.ceil(travel / 5));
    let alive = true;

    for (let s = 0; s < steps && alive; s++) {
      b.x += (b.vx * dt) / steps;
      b.y += (b.vy * dt) / steps;
      if (bounceCircle(b, S.rects, b.r ?? BULLET_R)) sfx.bounce();

      for (const t of S.tanks) {
        if (t.dead || t.gone) continue;
        // Fresh shots can't clip their own barrel on the way out.
        if (t.id === b.by && now - b.born < 150) continue;
        if (tankHitPoint(t, b.x, b.y, b.r ?? BULLET_R)) {
          alive = false;
          addFade(b.x, b.y, b.r ?? BULLET_R, now);
          // Authority: in local mode we own everyone; online we only
          // pronounce deaths for tanks simulated on this device.
          if (S.mode === "local" || t.local) killTank(t);
          break;
        }
      }
    }

    if (alive) survivors.push(b);
  }

  S.bullets = survivors;
}

/* ---------- special weapons: pickups + projectiles ---------- */

function stepSpecials(now, dt) {
  stepGear(now);
  stepRockets(now, dt);
  stepCannons(now, dt);
  stepShrapnel(now, dt);
  stepBeams(now);
  S.beams = S.beams.filter((bm) => !bm.doneAt || now - bm.doneAt < LASER.flashMs);
  S.booms = S.booms.filter((bo) => now - bo.born < 320);
}

function stepGear(now) {
  // Spawn (local sim, or the controller online — pushed via sync).
  if (S.isController && S.gear.length < GEAR_MAX && now >= S.gearNextAt) {
    S.gearNextAt = now + GEAR_EVERY_MS + Math.random() * 3500;
    const spot = pickGearSpot();
    if (spot) {
      const type = WEAPON_TYPES[Math.floor(Math.random() * WEAPON_TYPES.length)];
      const key = "g" + (S.gearSeq++) + Math.random().toString(36).slice(2, 6);
      if (S.mode === "local") {
        S.gear.push({ key, x: spot.x, y: spot.y, type, born: now });
        sfx.gearSpawn();
      } else S.sendGear?.(key, { x: spot.x, y: spot.y, type }); // arrives via snapshot
    }
  }

  // Pickups: each client claims gear for its OWN tanks (exact positions).
  for (let i = S.gear.length - 1; i >= 0; i--) {
    const g = S.gear[i];
    for (const t of S.tanks) {
      // One gun at a time: an armed tank can't grab another crate
      // until its current weapon has been fired off.
      if (!t.local || t.dead || t.gone || t.weapon) continue;
      const d2 = (t.x - g.x) ** 2 + (t.y - g.y) ** 2;
      if (d2 > (TANK_RAD + GEAR_R) ** 2) continue;
      S.gear.splice(i, 1);
      S.takenGear.set(g.key, now);
      t.weapon = g.type; // barrel (sprite + hitbox) swaps immediately
      sfx.pickup();
      if (S.mode === "online") S.sendPickup?.(g.key, t.id, g.type);
      break;
    }
  }
}

function pickGearSpot() {
  const cols = S.maze.cols;
  const rows = S.maze.rows;
  for (let tries = 0; tries < 25; tries++) {
    const x = (Math.floor(Math.random() * cols) + 0.5) * CELL;
    const y = (Math.floor(Math.random() * rows) + 0.5) * CELL;
    let clear = true;
    for (const t of S.tanks) {
      if (t.dead || t.gone) continue;
      if ((t.x - x) ** 2 + (t.y - y) ** 2 < (CELL * 1.2) ** 2) { clear = false; break; }
    }
    for (const g of S.gear) {
      if ((g.x - x) ** 2 + (g.y - y) ** 2 < CELL * CELL) { clear = false; break; }
    }
    if (clear) return { x, y };
  }
  return null;
}

function fireLaser(byId, x, y, a, now) {
  const pts = laserPath(x, y, a, S.rects, LASER.shotBounces);
  const shooter = S.tanks.find((t) => t.id === byId);
  const cum = [0];
  for (let i = 1; i < pts.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  }
  // The beam is no longer instant — a head races along the reflected
  // path at LASER.beamSpeed, killing in path order as it passes.
  // Borderline instant, but you can watch it go.
  S.beams.push({
    pts, cum, total: cum[cum.length - 1],
    color: HULL[shooter?.color] ?? "#e8452e",
    born: now, by: byId, head: 0, doneAt: 0,
  });
  sfx.laser();
}

// A point at distance d along a beam's polyline.
function beamPointAt(bm, d) {
  for (let i = 1; i < bm.pts.length; i++) {
    if (d <= bm.cum[i] || i === bm.pts.length - 1) {
      const seg = bm.cum[i] - bm.cum[i - 1] || 1;
      const k = Math.min(1, Math.max(0, (d - bm.cum[i - 1]) / seg));
      return {
        x: bm.pts[i - 1].x + (bm.pts[i].x - bm.pts[i - 1].x) * k,
        y: bm.pts[i - 1].y + (bm.pts[i].y - bm.pts[i - 1].y) * k,
      };
    }
  }
  return bm.pts[bm.pts.length - 1];
}

function stepBeams(now) {
  const r = LASER.width * BULLET_R;
  for (const bm of S.beams) {
    if (bm.doneAt) continue;
    const head = Math.min(bm.total, ((now - bm.born) / 1000) * LASER.beamSpeed);
    // Kill along the newly swept span, sampled finely. The shooter
    // is immune only at their own muzzle — reflections still bite.
    for (let d = bm.head; ; d = Math.min(head, d + 4)) {
      const p = beamPointAt(bm, d);
      for (const t of S.tanks) {
        if (t.dead || t.gone) continue;
        if (t.id === bm.by && d < TANK_R * 2.6) continue;
        if (tankHitPoint(t, p.x, p.y, r)) {
          if (S.mode === "local" || t.local) killTank(t);
        }
      }
      if (d >= head) break;
    }
    bm.head = head;
    if (head >= bm.total) bm.doneAt = now;
  }
}

function spawnRocket(byId, x, y, a, now) {
  const speed = BULLET_SPEED * ROCKET.speed;
  S.rockets.push({
    x, y,
    vx: Math.cos(a) * speed,
    vy: Math.sin(a) * speed,
    born: now,
    by: byId,
    r: ROCKET.r * BULLET_R, // bots dodge it like a (fat) bullet
    mini: true,             // never counts toward anyone's ammo
    trail: [],
    tcol: null,
  });
  sfx.rocket();
}

function stepRockets(now, dt) {
  const r = ROCKET.r * BULLET_R;
  const survivors = [];

  for (const rk of S.rockets) {
    const age = now - rk.born;
    if (age > ROCKET.lifeMs) {
      S.booms.push({ x: rk.x, y: rk.y, born: now, r: r * 3 });
      addFade(rk.x, rk.y, r * 1.4, now);
      continue;
    }

    // Phase 1 (first ~1.75 s): dumb-fire — straight, bouncing, no
    // trail, no homing. Phase 2: SEEK the nearest living tank via
    // the maze; no more bouncing — touching a wall kills it.
    const seeking = age >= ROCKET.straightMs;
    let target = null;
    if (seeking) {
      // Limited nose: it only locks tanks within seek range. With no
      // prey in range it coasts (straight + bouncing, grey trail)
      // until someone wanders close.
      let best = (ROCKET.seekRangeCells * CELL) ** 2;
      for (const t of S.tanks) {
        if (t.dead || t.gone) continue;
        const d = (t.x - rk.x) ** 2 + (t.y - rk.y) ** 2;
        if (d < best) { best = d; target = t; }
      }
      rk.tcol = target ? target.color : null;
      rk.huntD = target ? Math.sqrt(best) : Infinity;

      // Proximity beeper: ticks faster as it closes on its prey; at
      // a tank-length the beeps fuse into one constant tone.
      if (target && now >= (rk.beepAt ?? 0)) {
        const tankLen = TANK_R * 1.9;
        if (rk.huntD <= tankLen * 1.25) {
          sfx.beep(1350, 0.1);
          rk.beepAt = now + 78; // overlapping = continuous
        } else {
          sfx.beep(1150, 0.05);
          const range = ROCKET.seekRangeCells * CELL;
          rk.beepAt = now + 120 + 620 * Math.min(1, rk.huntD / range);
        }
      }
    }

    const speed = Math.hypot(rk.vx, rk.vy);
    const steps = Math.max(1, Math.ceil((speed * dt) / 5));
    let alive = true;
    for (let s = 0; s < steps && alive; s++) {
      if (seeking && target) {
        if (rocketSeekStep(rk, target, S.maze, S.rects, CELL, dt / steps, r)) {
          // Nose into a brick — the rocket dies there.
          S.booms.push({ x: rk.x, y: rk.y, born: now, r: r * 2.6 });
          addFade(rk.x, rk.y, r * 1.4, now);
          alive = false;
          break;
        }
      } else {
        rk.x += (rk.vx * dt) / steps;
        rk.y += (rk.vy * dt) / steps;
        bounceCircle(rk, S.rects, r);
      }

      for (const t of S.tanks) {
        if (t.dead || t.gone) continue;
        if (t.id === rk.by && age < ROCKET.ownerGraceMs) continue;
        if (tankHitPoint(t, rk.x, rk.y, r)) {
          alive = false;
          if (S.mode === "local" || t.local) killTank(t);
          S.booms.push({ x: rk.x, y: rk.y, born: now, r: r * 3.5 });
          addFade(rk.x, rk.y, r * 1.4, now);
          break;
        }
      }
    }
    if (!alive) continue;

    // Flare trail: always burning. Dense points, capped at six
    // rocket-lengths of smoke behind the nozzle.
    {
      const lp = rk.trail[rk.trail.length - 1];
      const dseg = lp ? Math.hypot(rk.x - lp.x, rk.y - lp.y) : 0;
      if (!lp || dseg > 1.6) {
        rk.trail.push({
          x: rk.x, y: rk.y, d: dseg,
          jx: (Math.random() - 0.5) * 3.4,
          jy: (Math.random() - 0.5) * 3.4,
        });
        rk.trailD = (rk.trailD ?? 0) + dseg;
        const maxLen = ROCKET.r * BULLET_R * 2.5 * 6; // 6× rocket length
        while (rk.trailD > maxLen && rk.trail.length > 1) {
          rk.trailD -= rk.trail[1].d;
          rk.trail.shift();
        }
      }
    }
    survivors.push(rk);
  }

  S.rockets = survivors;
}

function spawnCannon(byId, x, y, a, now) {
  sfx.cannon();
  const speed = BULLET_SPEED * CANNON.speed;
  // Deterministic per-shot seed: built only from the (fixed-precision)
  // shot parameters, so every online client grows the SAME shrapnel
  // pattern from this ball.
  const seed = (Math.abs(Math.round(x * 10 + y * 1700 + a * 99730)) % 2147483647) >>> 0;
  S.cannons.push({
    seed,
    x, y,
    vx: Math.cos(a) * speed,
    vy: Math.sin(a) * speed,
    born: now,
    by: byId,
    r: CANNON.r * BULLET_R, // bots read this to keep clear
    mini: true,             // never counts toward anyone's ammo
  });
}

function stepCannons(now, dt) {
  const r = CANNON.r * BULLET_R;
  const survivors = [];

  for (const c of S.cannons) {
    if (now - c.born > CANNON.lifeMs) { explodeCannon(c, now); continue; }

    let alive = true;
    c.x += c.vx * dt;
    c.y += c.vy * dt;
    bounceCircle(c, S.rects, r);

    for (const t of S.tanks) {
      if (t.dead || t.gone) continue;
      if (t.id === c.by && now - c.born < 200) continue;
      if (tankHitPoint(t, c.x, c.y, r)) {
        if (S.mode === "local" || t.local) killTank(t);
        explodeCannon(c, now);
        alive = false;
        break;
      }
    }

    if (alive) survivors.push(c);
  }

  S.cannons = survivors;
}

// Shrapnel circle — it phases through walls (slowed inside them).
function explodeCannon(c, now) {
  sfx.shrap();
  addFade(c.x, c.y, CANNON.r * BULLET_R, now);
  S.booms.push({ x: c.x, y: c.y, born: now, r: CANNON.r * BULLET_R * 4 });
  const speed = BULLET_SPEED * CANNON.shrapSpeed;
  // Irregular burst, not a perfect ring: seeded jitter on both angle
  // and speed (seeded so online clients all see the same pattern).
  const rng = mulberry32(c.seed ?? 1);
  for (let i = 0; i < CANNON.shrapN; i++) {
    const a = (i / CANNON.shrapN) * Math.PI * 2 + (rng() - 0.5) * 0.55;
    const jitter = 0.7 + rng() * 0.6;
    S.shraps.push({
      x: c.x, y: c.y,
      vx: Math.cos(a) * speed * jitter,
      vy: Math.sin(a) * speed * jitter,
      born: now,
      by: c.by,
      r: CANNON.shrapR * BULLET_R,
      mini: true,
    });
  }
}

function stepShrapnel(now, dt) {
  const r = CANNON.shrapR * BULLET_R;
  const survivors = [];

  for (const sh of S.shraps) {
    // No timer: shrapnel travels until it leaves the arena.
    if (sh.x < -20 || sh.y < -20 || sh.x > S.worldW + 20 || sh.y > S.worldH + 20) continue;

    let alive = true;
    const steps = 2;
    for (let s = 0; s < steps && alive; s++) {
      sh.inWall = stepShrap(sh, S.rects, dt / steps, r, CANNON.wallSlow);
      for (const t of S.tanks) {
        if (t.dead || t.gone) continue;
        if (tankHitPoint(t, sh.x, sh.y, r)) {
          alive = false;
          addFade(sh.x, sh.y, r * 1.2, now);
          if (S.mode === "local" || t.local) killTank(t);
          break;
        }
      }
    }

    if (alive) survivors.push(sh);
  }

  S.shraps = survivors;
}

function killTank(t) {
  if (t.dead) return;
  t.dead = true;
  sfx.boom();
  if (S.mode === "online" && t.local) S.sendDead?.(t.id);
}

/* ---------- rounds ---------- */

function maybeEndRound(now) {
  if (S.banner || S.roundStartCount < 2) return;
  const alive = S.tanks.filter((t) => !t.dead && !t.gone);
  if (alive.length > 1) return;

  const w = alive[0] ?? null;
  if (w) {
    S.scores[w.color] = (S.scores[w.color] ?? 0) + 1;
    S.banner = { text: `${COLOR_NAMES[w.color].toUpperCase()} WINS THE ROUND`, color: HULL[w.color] };
    sfx.roundEnd();
  } else {
    S.banner = { text: "DRAW", color: "#eef1f6" };
    sfx.roundEnd();
  }
  S.roundOverAt = now;
  updateScoreHUD();
}

function updateScoreHUD() {
  if (!scoreEl || !S) return;
  scoreEl.innerHTML = S.roster
    .map((p) => `<div class="sc-card p-${p.color}">${tankSVG(p.color)}<span class="sc">${S.scores[p.color] ?? 0}</span></div>`)
    .join("");
}

// A projectile just died — leave a quick expanding ghost behind.
function addFade(x, y, r, now, color = "#20242c") {
  S.fades.push({ x, y, r, color, born: now });
  if (S.fades.length > 240) S.fades.shift();
}

/* ---------- collision helpers (rectangular hitboxes) ---------- */

// The tank's hitbox is an oriented rectangle (TANK_HL × TANK_HW,
// rotated to t.a) matching the drawn treads — SAT does the rest.

function obbAxes(a) {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [[c, s], [-s, c]]; // [along-barrel, across]
}

// Projection radius of an oriented rectangle onto a unit axis.
function obbProjR(a, ax, ay, hl = TANK_HL, hw = TANK_HW) {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return Math.abs(c * ax + s * ay) * hl + Math.abs(-s * ax + c * ay) * hw;
}

// Broadphase: is the wall rect even near the tank's bounding circle?
function nearRect(x, y, rc, r) {
  const cx = clamp(x, rc.x, rc.x + rc.w);
  const cy = clamp(y, rc.y, rc.y + rc.h);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy < r * r;
}

// SAT: oriented rectangle vs axis-aligned wall rect (boolean).
function obbHitsRect(x, y, a, rc, hl = TANK_HL, hw = TANK_HW) {
  const rcx = rc.x + rc.w / 2;
  const rcy = rc.y + rc.h / 2;
  const axes = [[1, 0], [0, 1], ...obbAxes(a)];
  for (const [ax, ay] of axes) {
    const tC = x * ax + y * ay;
    const tR = obbProjR(a, ax, ay, hl, hw);
    const rC = rcx * ax + rcy * ay;
    const rR = Math.abs(ax) * (rc.w / 2) + Math.abs(ay) * (rc.h / 2);
    if (Math.abs(tC - rC) >= tR + rR) return false; // separating axis found
  }
  return true;
}

// The tank's full hitbox = body rectangle + BARREL rectangle (which
// changes shape with the equipped weapon). Barrels clunk against
// walls now: a swing or a move that would poke the barrel into a
// wall is blocked, exactly like the hull.
function tankHitsAnyWall(t, x, y, a) {
  const bl = BARRELS[t?.weapon] ?? BARRELS.normal;
  const off = (bl.len * TANK_R) / 2;
  const bx = x + Math.cos(a) * off;
  const by = y + Math.sin(a) * off;
  const bhw = bl.hw * TANK_R;
  const reach = Math.max(TANK_RAD, bl.len * TANK_R + 2);
  for (const rc of S.rects) {
    if (!nearRect(x, y, rc, reach)) continue;
    if (obbHitsRect(x, y, a, rc)) return true;
    if (obbHitsRect(bx, by, a, rc, off, bhw)) return true;
  }
  return false;
}

// SAT with minimum-translation-vector: how to push the tank out of a wall.
function obbRectMTV(x, y, a, rc) {
  if (!nearRect(x, y, rc, TANK_RAD)) return null;
  const rcx = rc.x + rc.w / 2;
  const rcy = rc.y + rc.h / 2;
  const axes = [[1, 0], [0, 1], ...obbAxes(a)];
  let depth = Infinity;
  let nx = 0;
  let ny = 0;
  for (const [ax, ay] of axes) {
    const tC = x * ax + y * ay;
    const tR = obbProjR(a, ax, ay);
    const rC = rcx * ax + rcy * ay;
    const rR = Math.abs(ax) * (rc.w / 2) + Math.abs(ay) * (rc.h / 2);
    const overlap = tR + rR - Math.abs(tC - rC);
    if (overlap <= 0) return null;
    if (overlap < depth) { depth = overlap; nx = ax; ny = ay; }
  }
  // Push away from the wall's center.
  if ((x - rcx) * nx + (y - rcy) * ny < 0) { nx = -nx; ny = -ny; }
  return { nx, ny, depth };
}

// SAT MTV between two tanks' rectangles.
function obbObbMTV(A, B) {
  const dx = B.x - A.x;
  const dy = B.y - A.y;
  if (dx * dx + dy * dy >= (TANK_RAD * 2) ** 2) return null; // broadphase
  const axes = [...obbAxes(A.a), ...obbAxes(B.a)];
  let depth = Infinity;
  let nx = 0;
  let ny = 0;
  for (const [ax, ay] of axes) {
    const aC = A.x * ax + A.y * ay;
    const bC = B.x * ax + B.y * ay;
    const overlap = obbProjR(A.a, ax, ay) + obbProjR(B.a, ax, ay) - Math.abs(aC - bC);
    if (overlap <= 0) return null;
    if (overlap < depth) { depth = overlap; nx = ax; ny = ay; }
  }
  if (dx * nx + dy * ny < 0) { nx = -nx; ny = -ny; } // normal points A → B
  return { nx, ny, depth };
}

// Tanks shove each other apart along the true contact normal.
function separate(a, b) {
  const mtv = obbObbMTV(a, b);
  if (!mtv) return;
  const { nx, ny, depth } = mtv;

  if (a.local && b.local) {
    a.x -= (nx * depth) / 2; a.y -= (ny * depth) / 2;
    b.x += (nx * depth) / 2; b.y += (ny * depth) / 2;
  } else if (a.local) {
    a.x -= nx * depth; a.y -= ny * depth;
  } else if (b.local) {
    b.x += nx * depth; b.y += ny * depth;
  }
}

// Exact projectile (circle, radius r) vs tank test: the hitbox is
// the body rectangle PLUS the barrel rectangle of whatever weapon
// the tank carries. Transform into the tank's local frame and clamp.
function tankHitPoint(t, x, y, r) {
  const dx = x - t.x;
  const dy = y - t.y;
  const c = Math.cos(t.a);
  const s = Math.sin(t.a);
  const lx = dx * c + dy * s;   // along the barrel
  const ly = -dx * s + dy * c;  // across

  // Body.
  let px = clamp(lx, -TANK_HL, TANK_HL);
  let py = clamp(ly, -TANK_HW, TANK_HW);
  let ox = lx - px;
  let oy = ly - py;
  if (ox * ox + oy * oy < r * r) return true;

  // Barrel (shape depends on the equipped weapon).
  const bl = BARRELS[t.weapon] ?? BARRELS.normal;
  px = clamp(lx, 0, bl.len * TANK_R);
  py = clamp(ly, -bl.hw * TANK_R, bl.hw * TANK_R);
  ox = lx - px;
  oy = ly - py;
  return ox * ox + oy * oy < r * r;
}

/* ================================================================
   Rendering
   ================================================================ */

function draw(now) {
  const cw = canvas.clientWidth;
  const ch = canvas.clientHeight;
  if (!cw || !ch) return;

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)) {
    canvas.width = Math.round(cw * dpr);
    canvas.height = Math.round(ch * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cw, ch);

  const pad = 8;
  const s = Math.min((cw - pad * 2) / S.worldW, (ch - pad * 2) / S.worldH);
  ctx.save();
  ctx.translate((cw - S.worldW * s) / 2, (ch - S.worldH * s) / 2);
  ctx.scale(s, s);

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, S.worldW, S.worldH);

  ctx.fillStyle = "#808896";
  for (const r of S.rects) ctx.fillRect(r.x, r.y, r.w, r.h);

  // Pickups on the floor, wrecks, tanks, then projectiles on top.
  const pulse = Math.sin(now / 220) * 0.5 + 0.5;
  // Dust puffs drift and dissolve beneath everything that moves.
  S.dust = S.dust.filter((d) => now - d.born < 560);
  for (const d of S.dust) {
    const k = (now - d.born) / 560;
    ctx.fillStyle = "#8b93a3";
    ctx.globalAlpha = 0.16 * (1 - k);
    ctx.beginPath();
    ctx.arc(d.x + d.vx * k, d.y + d.vy * k, TANK_R * (0.22 + k * 0.4), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  for (const g of S.gear) drawGear(ctx, g, TANK_R, pulse, now);

  for (const t of S.tanks) if (t.dead && !t.gone) drawWreck(t);
  for (const L of S.laserPaths ?? []) drawLaserPreview(L);
  for (const t of S.tanks) if (!t.dead && !t.gone) drawTank(t, now);

  ctx.fillStyle = "#20242c";
  for (const b of S.bullets) {
    ctx.beginPath();
    ctx.arc(b.x, b.y, b.r ?? BULLET_R, 0, Math.PI * 2);
    ctx.fill();
  }

  // Dying projectiles ghost out: a quick expand-and-fade.
  S.fades = S.fades.filter((f) => now - f.born < 180);
  for (const f of S.fades) {
    const k = (now - f.born) / 180;
    ctx.fillStyle = f.color;
    ctx.globalAlpha = 0.65 * (1 - k);
    ctx.beginPath();
    ctx.arc(f.x, f.y, f.r * (1 + k * 1.1), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  // Cannonballs — big, dark, slow.
  ctx.fillStyle = "#14171d";
  for (const c of S.cannons) {
    ctx.beginPath();
    ctx.arc(c.x, c.y, CANNON.r * BULLET_R, 0, Math.PI * 2);
    ctx.fill();
  }

  // Shrapnel — ghostly while phasing through a wall.
  for (const sh of S.shraps) {
    ctx.fillStyle = sh.inWall ? "rgba(32, 36, 44, .35)" : "#20242c";
    ctx.beginPath();
    ctx.arc(sh.x, sh.y, CANNON.shrapR * BULLET_R, 0, Math.PI * 2);
    ctx.fill();
  }

  // Rockets: a dense flare cloud — grey while dumb-firing, tinted
  // with the hunted tank's color once it locks on. Then the body.
  for (const rk of S.rockets) {
    const locked = now - rk.born >= ROCKET.straightMs && rk.tcol;
    const tc = locked ? (HULL[rk.tcol] ?? "#9aa3b2") : "#9aa3b2";
    const rr0 = ROCKET.r * BULLET_R;
    // Outer soft smoke, then a brighter core = flare density.
    for (const pass of [0, 1]) {
      for (let i = 0; i < rk.trail.length; i++) {
        const p = rk.trail[i];
        const f = (i + 1) / rk.trail.length;
        ctx.fillStyle = pass ? tc : "#c6ccd8";
        ctx.globalAlpha = pass ? f * 0.5 : f * 0.22;
        const rad = pass ? rr0 * (0.3 + f * 0.75) : rr0 * (0.55 + f * 1.05);
        ctx.beginPath();
        ctx.arc(p.x + p.jx, p.y + p.jy, rad, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
    const ra = Math.atan2(rk.vy, rk.vx);
    ctx.save();
    ctx.translate(rk.x, rk.y);
    ctx.rotate(ra);
    const rr2 = ROCKET.r * BULLET_R;
    ctx.fillStyle = "#20242c";
    ctx.beginPath();
    ctx.moveTo(rr2 * 1.5, 0);
    ctx.lineTo(-rr2, -rr2 * 0.8);
    ctx.lineTo(-rr2, rr2 * 0.8);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "#e8452e";
    ctx.beginPath();
    ctx.arc(rr2 * 0.6, 0, rr2 * 0.45, 0, Math.PI * 2);
    ctx.fill();
    // Exhaust flare licking out the back.
    ctx.fillStyle = "#ffb24a";
    ctx.globalAlpha = 0.85;
    ctx.beginPath();
    ctx.ellipse(-rr2 * 1.35, 0, rr2 * (0.55 + Math.random() * 0.25), rr2 * 0.4, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  // Laser beams race along their path, then flash and fade.
  for (const bm of S.beams) {
    const f = bm.doneAt ? 1 - (now - bm.doneAt) / LASER.flashMs : 1;
    ctx.strokeStyle = bm.color;
    ctx.globalAlpha = Math.max(0, f);
    ctx.lineWidth = LASER.width * BULLET_R * 2 * (0.4 + f * 0.6);
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(bm.pts[0].x, bm.pts[0].y);
    for (let i = 1; i < bm.pts.length; i++) {
      if (bm.cum[i] <= bm.head) {
        ctx.lineTo(bm.pts[i].x, bm.pts[i].y);
      } else {
        const tip = beamPointAt(bm, bm.head);
        ctx.lineTo(tip.x, tip.y);
        break;
      }
    }
    ctx.stroke();
    if (!bm.doneAt) {
      const tip = beamPointAt(bm, bm.head);
      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      ctx.arc(tip.x, tip.y, LASER.width * BULLET_R * 1.6, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  // Explosion rings.
  for (const bo of S.booms) {
    const f = (now - bo.born) / 320;
    ctx.strokeStyle = "#20242c";
    ctx.globalAlpha = Math.max(0, 1 - f);
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(bo.x, bo.y, (bo.r ?? 30) * (0.3 + f), 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  if (S.banner) drawBanner();

  ctx.restore();
}

// Aiming line for a held laser: 4 bounces, everyone can see it —
// human or bot, local or remote.
function drawLaserPreview(L) {
  const pts = L.pts;
  ctx.strokeStyle = L.color;
  ctx.globalAlpha = 0.4;
  ctx.lineWidth = BULLET_R * 0.45;
  ctx.setLineDash([7, 6]);
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
}

function drawTank(t, now) {
  const hull = HULL[t.color];
  const R = TANK_R;

  ctx.save();
  ctx.translate(t.x, t.y);
  ctx.rotate(t.a);

  // Treads with scrolling links — the phases come from each track's
  // actual ground speed (they counter-rotate in a zero-point turn).
  ctx.fillStyle = "#2a303c";
  rr(-R * 0.95, -R * 0.83, R * 1.9, R * 0.42, R * 0.15);
  rr(-R * 0.95, R * 0.41, R * 1.9, R * 0.42, R * 0.15);
  ctx.strokeStyle = "#454c5c";
  ctx.lineWidth = Math.max(1.4, R * 0.075);
  const linkGap = R * 0.3;
  const bands = [
    [-R * 0.8, -R * 0.44, t.trkL ?? 0],
    [R * 0.44, R * 0.8, t.trkR ?? 0],
  ];
  for (const [y0, y1, ph] of bands) {
    // Forward motion scrolls the links toward the rear (they grip
    // the ground while the hull moves over them).
    let off = (-ph % linkGap + linkGap) % linkGap;
    ctx.beginPath();
    for (let x = -R * 0.88 + off; x <= R * 0.88; x += linkGap) {
      ctx.moveTo(x, y0);
      ctx.lineTo(x, y1);
    }
    ctx.stroke();
  }

  ctx.fillStyle = hull;
  rr(-R * 0.9, -R * 0.58, R * 1.8, R * 1.16, R * 0.24);

  // Barrel sprite = barrel hitbox, swapping shape with the weapon.
  const wtype = t.weapon ?? "normal";
  drawBarrel(ctx, wtype, R, shade(hull, 0.35), shade(hull, 0.6));

  // Machine gun wind-up: the muzzle glows while it spins up.
  if (t.weapon === "mg" && t.mgReadyAt && now < t.mgReadyAt) {
    const bl = BARRELS.mg;
    const f = 1 - (t.mgReadyAt - now) / MG.windupMs;
    ctx.fillStyle = "#e8452e";
    ctx.globalAlpha = 0.35 + 0.6 * Math.abs(Math.sin(f * 14));
    ctx.beginPath();
    ctx.arc(bl.len * R, 0, R * 0.16, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  ctx.fillStyle = shade(hull, 0.42);
  ctx.beginPath();
  ctx.arc(0, 0, R * 0.5, 0, Math.PI * 2);
  ctx.fill();

  // Bots get a small "chip" dot so you can tell them apart.
  if (t.bot) {
    ctx.fillStyle = "#eef1f6";
    ctx.beginPath();
    ctx.arc(0, 0, R * 0.16, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();
}

function drawWreck(t) {
  ctx.save();
  ctx.translate(t.x, t.y);
  ctx.rotate(t.a);
  ctx.fillStyle = "#232833";
  rr(-TANK_R * 0.8, -TANK_R * 0.55, TANK_R * 1.6, TANK_R * 1.1, TANK_R * 0.2);
  ctx.fillStyle = shade(HULL[t.color], 0.75);
  ctx.beginPath();
  ctx.arc(0, 0, TANK_R * 0.32, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawBanner() {
  ctx.fillStyle = "rgba(10, 12, 16, .55)";
  ctx.fillRect(0, 0, S.worldW, S.worldH);

  let size = CELL * 0.75;
  ctx.font = `${size}px "Black Ops One", system-ui, sans-serif`;
  const w = ctx.measureText(S.banner.text).width;
  if (w > S.worldW * 0.9) {
    size *= (S.worldW * 0.9) / w;
    ctx.font = `${size}px "Black Ops One", system-ui, sans-serif`;
  }
  ctx.fillStyle = S.banner.color;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(S.banner.text, S.worldW / 2, S.worldH / 2);
}

function rr(x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
  else ctx.rect(x, y, w, h);
  ctx.fill();
}

/* ================================================================
   Small helpers
   ================================================================ */

function randomSeed() {
  return Math.floor(Math.random() * 2147483647);
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function angleDiff(from, to) {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

function shade(hex, f) {
  const n = parseInt(hex.slice(1), 16);
  const mix = (x, target) => Math.round(x + (target - x) * f);
  const r = mix((n >> 16) & 255, 16);
  const g = mix((n >> 8) & 255, 19);
  const b = mix(n & 255, 26);
  return `rgb(${r}, ${g}, ${b})`;
}
