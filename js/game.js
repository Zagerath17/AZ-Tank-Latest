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

import { showScreen, toast, tankSVG, setInMatch } from "./main.js";
import { COLORS, COLOR_NAMES, SLOT_NAMES, PALETTE } from "./palette.js";
import { getBinds } from "./settings.js";
import { mulberry32, generateMaze, wallRects, segmentFirstHit, MAZE_SHAPES, ringDistance } from "./maze.js";
import { botActions, AI_PARAMS } from "./ai.js";
import {
  WEAPON_TYPES, BARRELS, LASER, MG, ROCKET, CANNON, SNIPER, BOOST, PHASE, WALL,
  laserPath, rocketSeekStep, stepShrap, bounceCircle, drawBarrel, drawGear,
  GEAR_RIM, WEAPON_NAMES,
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

// ---- Ranked closing zone ----
const ZONE_FIRST_MS = 30000;   // first layer claimed 30 s in
const ZONE_PERIOD = 30000;     // a new layer every 30 s thereafter
const ZONE_WARN_MS = 5000;     // a layer blinks this long before it turns red
const ZONE_DMG_PERIOD = 2000;  // red cells deal 1 dmg every 2 s
const ZONE_DMG = 1;            // damage per tick
const ZONE_INSIDE_FRAC = 0.30; // a tank must be >30% into a red cell to be hit

const BULLET_SPEED = U * 3.2;
const BULLET_R = U * 0.085;
const BULLET_LIFE = 6000;   // ms a bullet keeps bouncing

// ---- Health & damage ----
// Every tank starts with 6 HP. Weapons chip it down; at 0 the tank is
// destroyed. (Environmental deaths — the ring, the collapse — always
// kill outright regardless of HP.)
const TANK_HP = 6;
const DMG = {
  basic: 2,       // basic cannon ball
  mg: 1,          // machine-gun ball
  cannonBall: 6,  // the big cannon's direct ball hit
  shrapnel: 2,    // each fractal from the cannon
  rocket: 5,      // homing rocket
  laserBase: 8,   // laser at zero bounces; −1 per bounce, min 1
  sniper: 4,      // sniper slug
};

// The basic gun is a 3-round magazine: consecutive shots come 0.5 s
// apart, and each spent round takes 3.5 s to regenerate.
const MAG_SIZE = 3;
const MAG_GAP = 500;        // ms between consecutive shots
const MAG_REGEN = 3500;     // ms for one spent round to come back

function magAvailable(t, now) {
  t.basicMag = (t.basicMag ?? []).filter((ts) => now - ts < MAG_REGEN);
  return MAG_SIZE - t.basicMag.length;
}

// A special projectile still flying blocks the basic trigger — no
// rocket-then-instantly-bullet exploits.
function specialInPlay(t) {
  return S.rockets.some((r) => r.by === t.id)
    || S.cannons.some((c) => c.by === t.id)
    || S.beams.some((bm) => bm.by === t.id && !bm.doneAt);
}

const ROUND_PAUSE = 2600;   // ms between rounds
const NET_SEND_MS = 90;
const MAZE_SIZES = [
  [7, 5], [7, 6], [8, 5], [8, 6], [8, 7], [9, 5],
  [9, 6], [9, 7], [10, 6], [10, 7], [11, 6], [11, 8],
  // The big leagues: sprawling arenas for longer hunts.
  [12, 8], [12, 9], [13, 9], [13, 10], [14, 10], [15, 10],
  [15, 11], [16, 11], [17, 12], [18, 12],
];

const HULL = PALETTE; // every pickable paint + the Impossible black
const NO_MUL = { speed: 1, turn: 1 };

// The non-rectangular silhouettes used for casual arenas.
const MAZE_SHAPES_NONRECT = MAZE_SHAPES.filter((s) => s !== "rect");

/* ---------- module state ---------- */

let S = null;
let canvas, ctx, exitBtn, touchPad, scoreEl, shrinkEl, weaponHudEl, healthHudEl;
const held = new Set();
const touchHeld = new Set();

/* ================================================================
   Public API
   ================================================================ */

export function initGame() {
  canvas = document.getElementById("arena");
  ctx = canvas.getContext("2d");
  exitBtn = document.getElementById("game-exit");
  shrinkEl = document.getElementById("game-shrink");
  weaponHudEl = document.getElementById("weapon-hud");
  healthHudEl = document.getElementById("health-hud");
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
    roster: specs.map((s) => ({
      id: s.slot ?? s.color,
      slot: s.slot ?? s.color,
      color: s.color,
      bot: s.bot ?? null,
    })),
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
    sendGearRemove: o.sendGearRemove,
    sendPickup: o.sendPickup,
    sendGun: o.sendGun,
    onExit: o.onExit,
    ranked: o.ranked,
    winTarget: o.winTarget,
    onRankedEnd: o.onRankedEnd,
    casualPlayers: o.casualPlayers,
  };
}

export function stopGame() {
  if (!S) return;
  setInMatch(false);
  stopAll();
  cancelAnimationFrame(S.raf);
  window.removeEventListener("keydown", onKeydown);
  window.removeEventListener("keyup", onKeyup);
  window.removeEventListener("blur", clearHeld);
  touchPad.hidden = true;
  if (scoreEl) scoreEl.innerHTML = "";
  if (weaponHudEl) weaponHudEl.hidden = true;
  if (healthHudEl) { healthHudEl.hidden = true; healthHudEl._hp = undefined; }
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
      if (gun === "sniper" && t.snAmmo == null) t.snAmmo = SNIPER.shots;
    } else if (gun && gun !== t.weapon && nowMs - t.gunClearedAt > 1500) {
      t.weapon = gun;
      if (gun === "sniper") t.snAmmo = SNIPER.shots;
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
    scores: Object.fromEntries(opts.roster.map((p) => [p.id, 0])),
    present: new Set(opts.roster.map((p) => p.id)),
    isController: opts.mode === "local",
    sendPos: opts.sendPos,
    sendShot: opts.sendShot,
    sendDead: opts.sendDead,
    sendNextRound: opts.sendNextRound,
    sendGear: opts.sendGear,
    sendGearRemove: opts.sendGearRemove,
    sendPickup: opts.sendPickup,
    sendGun: opts.sendGun,
    onExit: opts.onExit,
    ranked: !!opts.ranked,
    winTarget: opts.winTarget ?? 5,
    onRankedEnd: opts.onRankedEnd ?? null,
    matchOver: false,
    rankedEndFired: false,
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
    snipes: [],
    walls: [],
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
  setInMatch(true);
  startMusic("game");
  S.raf = requestAnimationFrame(frame);
}

function startRound(seed) {
  const rng = mulberry32(seed);
  // Every match — ranked included — can roll a random silhouette now
  // that the closing zone works on any shape. Every maze is braided so
  // there are many open routes.
  let shape = rng() < 0.55
    ? "rect"
    : MAZE_SHAPES_NONRECT[Math.floor(rng() * MAZE_SHAPES_NONRECT.length)];
  // Shaped arenas lose cells to the mask, so pull their grid size from
  // the upper half of the list to keep the playable area generous.
  let sizeIdx;
  if (shape === "rect") {
    sizeIdx = Math.floor(rng() * MAZE_SIZES.length);
  } else {
    const lo = Math.floor(MAZE_SIZES.length * 0.5);
    sizeIdx = lo + Math.floor(rng() * (MAZE_SIZES.length - lo));
  }
  const [cols, rows] = MAZE_SIZES[sizeIdx];
  S.mazeShape = shape;
  S.maze = generateMaze(cols, rows, rng, { shape, braid: 0.3 });
  S.rects = wallRects(S.maze, CELL, WALL_T);
  S.worldW = cols * CELL;
  S.worldH = rows * CELL;
  S.bullets = [];
  S.gear = [];
  S.takenGear.clear();
  S.gearSeen.clear();
  S.fades = [];
  S.dust = [];
  // 3-2-1 countdown: everyone frozen, arena blurred, then GO.
  S.freezeUntil = performance.now() + 3000;
  S.cdLast = 4; // last number we ticked for (4 = none yet)
  S.gearNextAt = S.freezeUntil + GEAR_FIRST_MS;
  // ---- Ranked closing zone ----
  // A creeping "red zone" eats the arena from the outside in. Each
  // layer of cells first BLINKS as a warning, then turns permanently
  // red: red cells delete gear and steadily damage tanks sitting in
  // them. A new layer is claimed every ZONE_PERIOD until the whole map
  // is red. Ring-distance (from maze.js) tells us each cell's layer, so
  // this works for every shape, not just rectangles.
  const rd = ringDistance(S.maze);
  S.zoneDist = rd.dist;        // per-cell layer from the boundary
  S.zoneMaxLayer = rd.maxLayer;
  S.zoneLevel = 0;             // layers currently permanently red
  S.zoneWarnLevel = -1;        // layer currently blinking (‑1 = none)
  S.zoneNextAt = S.ranked ? S.freezeUntil + ZONE_FIRST_MS : Infinity;
  S.zoneWarnUntil = 0;
  S.zoneDamageAt = 0;          // next time red cells tick damage
  S.rockets = [];
  S.cannons = [];
  S.shraps = [];
  S.snipes = [];
  S.walls = [];
  S.beams = [];
  S.booms = [];
  S.seenShots = {};
  S.banner = null;
  S.personalMsg = null;
  S.roundOverAt = 0;
  S.sentNext = false;
  for (const t of S.tanks) { t.phaseUntil = 0; t.wasPhasing = false; t.ejecting = false; }

  // Players 1 & 2 in opposite corners, 3 & 4 in the other pair. For a
  // shaped maze a raw corner may fall outside the silhouette, so snap
  // each to the nearest playable cell.
  const rawCorners = [
    [0, 0],
    [cols - 1, rows - 1],
    [cols - 1, 0],
    [0, rows - 1],
  ];
  const inside = S.maze.inside;
  const cellInside = (c, r) =>
    !inside || (r >= 0 && r < rows && c >= 0 && c < cols && inside[r][c]);
  const snapInside = (c0, r0) => {
    if (cellInside(c0, r0)) return [c0, r0];
    // Spiral outward for the closest inside cell.
    let best = [Math.floor(cols / 2), Math.floor(rows / 2)], bestD = Infinity;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (!cellInside(c, r)) continue;
        const d = (c - c0) ** 2 + (r - r0) ** 2;
        if (d < bestD) { bestD = d; best = [c, r]; }
      }
    }
    return best;
  };
  const corners = rawCorners.map(([c, r]) => snapInside(c, r));

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
      hp: TANK_HP, // baseline health; damage chips this down to 0
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

  // Local: strictly your SLOT's binds (colors are just paint now).
  // Online: your (only) tank answers to any slot's binds, so WASD
  // and arrows both work.
  const sources = S.mode === "online" ? COLORS : [tank.slot ?? tank.color];
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
  S.sniperAims = [];
  for (const t of S.tanks) {
    if (t.dead || t.gone) continue;
    if (t.weapon === "laser") {
      const m = muzzlePoint(t, 1);
      S.laserPaths.push({ by: t.id, color: HULL[t.color], pts: laserPath(m.x, m.y, t.a, S.rects, LASER.previewBounces) });
    } else if (t.weapon === "sniper") {
      // Straight line, no bounce, through walls, 3 cells long.
      const m = muzzlePoint(t, 1);
      const len = SNIPER.previewCells * CELL;
      S.sniperAims.push({
        by: t.id, color: HULL[t.color],
        x0: m.x, y0: m.y,
        x1: m.x + Math.cos(t.a) * len, y1: m.y + Math.sin(t.a) * len,
      });
    }
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

  S.engineMovingLocal = false;
  S.engineMovingEnemy = false;
  const frozen = now < (S.freezeUntil ?? 0);
  if (frozen) {
    // Countdown: nobody moves, nothing flies. Tick the numbers.
    const n = Math.ceil((S.freezeUntil - now) / 1000);
    if (n !== S.cdLast) {
      S.cdLast = n;
      sfx.count(n);
    }
  } else if (!S.banner) {
    if (S.cdLast !== 0) { S.cdLast = 0; sfx.count(0); } // GO!
    stepShrink(now);
    stepTanks(now, dt);
    stepBullets(now, dt);
    stepSpecials(now, dt);
    maybeEndRound(now);
  } else if (S.matchOver) {
    // The match is decided — hold the banner, then report placements
    // exactly once so every client settles its own Elo.
    if (!S.rankedEndFired && now - S.roundOverAt > 3500) {
      S.rankedEndFired = true;
      const placements = S.roster
        .map((p) => ({ id: p.id, color: p.color, score: S.scores[p.id] ?? 0 }))
        .sort((a, b) => b.score - a.score);
      S.onRankedEnd?.(placements);
    }
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

  setEngine(!S.banner, S.engineMovingLocal, S.engineMovingEnemy);
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
            snipes: (S.sniperAims ?? []).map((A) => ({
              by: A.by, pts: [{ x: A.x0, y: A.y0 }, { x: A.x1, y: A.y1 }],
            })),
            bulletSpeed: BULLET_SPEED,
            bulletR: BULLET_R,
            muzzle: BARRELS.normal.len * TANK_R + BULLET_R + 2,
            magSize: MAG_SIZE,
            magGap: MAG_GAP,
            magRegen: MAG_REGEN,
            moveSpeed: MOVE_SPEED,
          }, dt, now)
        : readActions(t, binds);
      const mul = t.bot ? AI_PARAMS[t.bot] : NO_MUL;

      // Rotation uses the real rectangular hitbox: if the swing would
      // clip a wall, the turn is blocked until the tank backs off.
      const phasing = now < (t.phaseUntil ?? 0);
      const turn = (acts.right ? 1 : 0) - (acts.left ? 1 : 0);
      if (turn !== 0) {
        const na = t.a + turn * TURN_SPEED * mul.turn * dt;
        if (phasing || !tankHitsAnyWall(t, t.x, t.y, na)) t.a = na;
      }

      let v = 0;
      const boosting = now < (t.boostUntil ?? 0);
      const boostMul = boosting ? BOOST.mult : 1;
      if (acts.up) v += MOVE_SPEED * mul.speed * boostMul;
      if (acts.down) v -= REVERSE_SPEED * mul.speed * boostMul;

      // The engine is "running" whenever the tank drives OR turns in
      // place — a stationary spin still spins the treads.
      if (v !== 0 || turn !== 0) {
        const isMine = S.mode === "online" ? (t.id === S.myId) : !t.bot;
        if (isMine) S.engineMovingLocal = true;
        else S.engineMovingEnemy = true;
      }

      // Track link animation: each tread scrolls at its own ground
      // speed. Turning makes them differ; a zero-point turn spins
      // them in OPPOSITE directions, just like a real tank.
      {
        const w = turn * TURN_SPEED * mul.turn; // rad/s (commanded)
        const half = TANK_R * 0.62;
        t.trkL = (t.trkL ?? 0) + (v + w * half) * dt;
        t.trkR = (t.trkR ?? 0) + (v - w * half) * dt;
      }

      // Kick up a faint dust puff behind a driving tank. While boosting
      // the trail lasts 20% longer, reads much darker, DOUBLES the puff
      // count, and throws yellow sparks.
      if (v !== 0 && now >= (t.dustAt ?? 0)) {
        t.dustAt = now + 65 + Math.random() * 45;
        const back = v > 0 ? -1 : 1;
        const puffs = boosting ? 2 : 1; // boost dispenses double the dust
        for (let p = 0; p < puffs; p++) {
          S.dust.push({
            x: t.x + Math.cos(t.a) * TANK_R * back + (Math.random() - 0.5) * 6,
            y: t.y + Math.sin(t.a) * TANK_R * back + (Math.random() - 0.5) * 6,
            vx: Math.cos(t.a) * back * 9 + (Math.random() - 0.5) * 8,
            vy: Math.sin(t.a) * back * 9 + (Math.random() - 0.5) * 8,
            born: now,
            boost: boosting,
          });
        }
        if (boosting) {
          // A couple of bright yellow sparks riding inside the dust.
          for (let k = 0; k < 2; k++) {
            S.dust.push({
              x: t.x + Math.cos(t.a) * TANK_R * back + (Math.random() - 0.5) * 8,
              y: t.y + Math.sin(t.a) * TANK_R * back + (Math.random() - 0.5) * 8,
              vx: Math.cos(t.a) * back * 12 + (Math.random() - 0.5) * 20,
              vy: Math.sin(t.a) * back * 12 + (Math.random() - 0.5) * 20,
              born: now,
              spark: true,
            });
          }
        }
        while (S.dust.length > 400) S.dust.shift();
      }

      if (v !== 0) {
        const nx = t.x + Math.cos(t.a) * v * dt;
        const ny = t.y + Math.sin(t.a) * v * dt;
        if (phasing) {
          // Through inner walls freely — but the outer boundary still
          // holds. Clamp to the play area (one tank-radius in).
          const lo = safeBox();
          const minX = lo.c0 * CELL + TANK_RAD, maxX = (lo.c1 + 1) * CELL - TANK_RAD;
          const minY = lo.r0 * CELL + TANK_RAD, maxY = (lo.r1 + 1) * CELL - TANK_RAD;
          t.x = Math.min(maxX, Math.max(minX, nx));
          t.y = Math.min(maxY, Math.max(minY, ny));
        } else if (!tankHitsAnyWall(t, nx, ny, t.a)) {
          t.x = nx;
          t.y = ny;
        }
      }

      // Phase just ended? Mark the tank for ejection. It then glides
      // out over as many frames as it takes (see ejectFromWall), not
      // just the single frame the ability expired.
      if (t.wasPhasing && !phasing) t.ejecting = true;
      t.wasPhasing = phasing;
      if (t.ejecting && !phasing) {
        const clear = ejectFromWall(t, dt);
        if (clear) t.ejecting = false;
      }

      if (acts.shoot && !t.prevShoot && !phasing) tryFire(t, now);
      t.prevShoot = acts.shoot;

      // Machine gun: the trigger pull spins the barrel up (glowing
      // muzzle, half a second). Once hot it's manual — hold to spray
      // at full rate, tap for single shots. Let go and the barrel
      // keeps spinning for exactly half a second: press again inside
      // that window and it fires instantly (each release restarts
      // the window); leave it longer and it spins down, so the next
      // pull needs a full wind-up again. The gun stays until all
      // its balls are spent.
      if (t.weapon === "mg") {
        if (acts.shoot) {
          t.mgIdleAt = 0; // trigger held — the spin-down clock is off
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
        } else if (t.mgReadyAt) {
          // Trigger just released (or still idle): the clock starts
          // at the moment of release.
          if (!t.mgIdleAt) {
            t.mgIdleAt = now;
          } else if (now - t.mgIdleAt >= 500) {
            t.mgReadyAt = 0; // spun down — next pull winds up again
            t.mgIdleAt = 0;
            if (t.local && !t.bot) sfx.winddown();
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
  t.mgIdleAt = 0;
  t.mgNext = 0;
  t.mgAmmo = null;
  t.snAmmo = null;
  t.gunClearedAt = now;
  if (S.mode === "online" && t.local) S.sendGun?.(t.id, null);
}

function tryFire(t, now) { 
  // A cannon ball you fired can be command-detonated: tap fire again
  // and it bursts wherever it is right now. (Give it a brief arming
  // window so the same press that launched it doesn't pop it.)
  const myBall = S.cannons.find((c) => c.by === t.id && now - c.born > 120);
  if (myBall) {
    explodeCannon(myBall, now);
    S.cannons = S.cannons.filter((c) => c !== myBall);
    if (S.mode === "online" && t.local) {
      sendTypedShot(t, { w: "detonate", x: +myBall.x.toFixed(1), y: +myBall.y.toFixed(1) }, now);
    }
    return;
  }

  if (t.weapon === "mg") return; // manual fire — handled in stepTanks

  if (t.weapon) {
    fireSpecial(t, now);
    return;
  }

  if (specialInPlay(t)) return;                 // your rocket flies alone
  if (now < (t.basicNext ?? 0)) return;         // 0.5 s between shots
  if (magAvailable(t, now) <= 0) return;        // magazine empty — regenerating

  t.basicNext = now + MAG_GAP;
  (t.basicMag ??= []).push(now);
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
  } else if (w === "sniper") {
    // Two rounds per pickup; fire one, keep the barrel until spent.
    const m = muzzlePoint(t, BARRELS.sniper.len * BULLET_R);
    spawnSnipe(t.id, m.x, m.y, t.a, now);
    sendTypedShot(t, { w: "snipe", x: +m.x.toFixed(1), y: +m.y.toFixed(1), a: +t.a.toFixed(3) }, now);
    t.snAmmo = (t.snAmmo ?? SNIPER.shots) - 1;
    if (t.snAmmo > 0) return; // keep the sniper until both rounds are gone
    t.snAmmo = null;
  } else if (w === "boost") {
    // Speed boost: activating it hands your basic gun straight back
    // AND grants a temporary sprint. No projectile.
    t.boostUntil = now + BOOST.durationMs;
    t.basicMag = []; // refill: basic attacks available immediately
    t.basicNext = 0;
    sfx.boost?.();
    sendTypedShot(t, { w: "boost" }, now);
  } else if (w === "phase") {
    // Phase: 2 s of intangibility. Can't shoot while active (handled
    // in the movement loop). Still vulnerable to everything.
    t.phaseUntil = now + PHASE.durationMs;
    sfx.phase?.();
    sendTypedShot(t, { w: "phase" }, now);
  } else if (w === "wall") {
    // Drop a temporary brick wall just ahead of the barrel.
    spawnWall(t, now);
    sfx.wallup?.();
    sendTypedShot(t, {
      w: "wall",
      x: +lastWallPos.x.toFixed(1), y: +lastWallPos.y.toFixed(1), a: +t.a.toFixed(3),
    }, now);
  }

  clearWeapon(t, now);
}

// Online receive: one dispatcher for every shot type.
function spawnShot(byId, sh, now = performance.now()) {
  switch (sh.w) {
    case "snipe": spawnSnipe(byId, sh.x, sh.y, sh.a, now); break;
    case "boost": {
      const bt = S.tanks.find((x) => x.id === byId);
      if (bt) { bt.boostUntil = now + BOOST.durationMs; }
      break;
    }
    case "phase": {
      const pt = S.tanks.find((x) => x.id === byId);
      if (pt) pt.phaseUntil = now + PHASE.durationMs;
      break;
    }
    case "wall": {
      // Rebuild the wall at the shared position (deterministic).
      addWall(byId, sh.x, sh.y, sh.a, now);
      break;
    }
    case "detonate": {
      // Command detonation from the owner: burst their airborne ball.
      const ball = S.cannons.find((c) => c.by === byId);
      if (ball) {
        ball.x = sh.x; ball.y = sh.y; // snap to the owner's burst point
        explodeCannon(ball, now);
        S.cannons = S.cannons.filter((c) => c !== ball);
      }
      break;
    }
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
      if (hitWall(b.x, b.y, b.r ?? BULLET_R, b.mini ? "mg" : "basic", now)) { alive = false; break; }
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
          if (S.mode === "local" || t.local) damageTank(t, b.mini ? DMG.mg : DMG.basic);
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
  stepSnipes(now, dt);
  stepWalls(now, dt);
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
      if (g.type === "sniper") t.snAmmo = SNIPER.shots;
      sfx.pickup();
      if (S.mode === "online") S.sendPickup?.(g.key, t.id, g.type);
      break;
    }
  }
}

// The safe box under the current shrink level: [c0..c1] × [r0..r1].
// The map never physically shrinks now, so the "safe box" is simply
// the full playable grid — tanks may drive anywhere, red zone or not.
function safeBox() {
  return { c0: 0, r0: 0, c1: S.maze.cols - 1, r1: S.maze.rows - 1 };
}

// Which zone layer a world point sits in (its cell's ring-distance),
// or Infinity if it's outside the shape / off-grid.
function cellLayerAt(x, y) {
  if (!S.zoneDist) return Infinity;
  const c = Math.floor(x / CELL);
  const r = Math.floor(y / CELL);
  if (r < 0 || r >= S.maze.rows || c < 0 || c >= S.maze.cols) return Infinity;
  return S.zoneDist[r][c];
}

// Is the cell containing (x,y) permanently red? (layer < zoneLevel)
function inRedZone(x, y) {
  return cellLayerAt(x, y) < (S.zoneLevel ?? 0);
}

// Is that cell currently BLINKING as the next-to-fall layer?
function inWarnZone(x, y) {
  return (S.zoneWarnLevel ?? -1) >= 0 && cellLayerAt(x, y) === S.zoneWarnLevel;
}

// Fraction of the tank's body sitting inside red cells, sampled over a
// small grid of points across its footprint. Used to gate damage at
// the ">30% inside" threshold.
function redOverlapFrac(t) {
  const R = TANK_RAD * 0.9;
  let inside = 0, total = 0;
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      total++;
      if (inRedZone(t.x + dx * R, t.y + dy * R)) inside++;
    }
  }
  return inside / total;
}

// The creeping zone. Every ZONE_PERIOD a new outer layer is claimed:
// it blinks for ZONE_WARN_MS as a warning, then turns permanently red.
// Red cells delete gear sitting in them and chip 1 HP off any tank
// more than 30% inside them, every ZONE_DMG_PERIOD. This proceeds until
// every cell is red (at which point any survivors all die → draw).
function stepShrink(now) {
  if (!S.ranked || S.zoneNextAt === Infinity) return;

  // --- promote a layer: start its warning blink ---
  if (S.zoneWarnLevel < 0 && S.zoneLevel <= S.zoneMaxLayer && now >= S.zoneNextAt) {
    S.zoneWarnLevel = S.zoneLevel;      // this layer begins blinking
    S.zoneWarnUntil = now + ZONE_WARN_MS;
    S.zoneFlashTick = -1;
  }

  // --- during the blink: tick the warning voice once a second ---
  if (S.zoneWarnLevel >= 0 && now < S.zoneWarnUntil) {
    const sec = Math.ceil((S.zoneWarnUntil - now) / 1000);
    if (sec !== S.zoneFlashTick) { S.zoneFlashTick = sec; sfx.count(sec); }
  }

  // --- blink finished: the layer turns permanently red ---
  if (S.zoneWarnLevel >= 0 && now >= S.zoneWarnUntil) {
    S.zoneLevel = S.zoneWarnLevel + 1;  // this layer is now red
    S.zoneWarnLevel = -1;
    sfx.boom(0.4);
    // Purge gear now trapped in the red zone (and erase from the DB if
    // we're the online controller, so a snapshot can't rebuild it).
    const doomedGear = S.gear.filter((g) => inRedZone(g.x, g.y));
    S.gear = S.gear.filter((g) => !inRedZone(g.x, g.y));
    for (const g of doomedGear) {
      S.takenGear.set(g.key, now);
      if (S.mode === "online" && S.isController) S.sendGearRemove?.(g.key);
    }
    // Schedule the next layer, or — once the whole map is red — a final
    // sweep that finishes off anyone still standing.
    if (S.zoneLevel <= S.zoneMaxLayer) {
      S.zoneNextAt = now + ZONE_PERIOD;
    } else {
      S.zoneNextAt = Infinity; // fully closed
    }
  }

  // --- red-zone damage tick ---
  if (now >= (S.zoneDamageAt ?? 0)) {
    S.zoneDamageAt = now + ZONE_DMG_PERIOD;
    const fullyClosed = (S.zoneLevel ?? 0) > S.zoneMaxLayer;
    for (const t of S.tanks) {
      if (t.dead || t.gone) continue;
      // Once the entire map is red, everyone left takes damage no
      // matter where they stand (no safe corner remains).
      if (fullyClosed || redOverlapFrac(t) > ZONE_INSIDE_FRAC) {
        if (S.mode === "local" || t.local) damageTank(t, ZONE_DMG);
      }
    }
  }
}

function pickGearSpot() {
  const { c0, r0, c1, r1 } = safeBox();
  const inside = S.maze.inside;
  const cellInside = (c, r) =>
    !inside || (r >= 0 && r < S.maze.rows && c >= 0 && c < S.maze.cols && inside[r][c]);
  for (let tries = 0; tries < 30; tries++) {
    const cc = c0 + Math.floor(Math.random() * (c1 - c0 + 1));
    const rr = r0 + Math.floor(Math.random() * (r1 - r0 + 1));
    if (!cellInside(cc, rr)) continue; // stay within the shape
    const x = (cc + 0.5) * CELL;
    const y = (rr + 0.5) * CELL;
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

// How many times the beam has reflected by distance d (0 = the first,
// un-bounced segment; 1 after the first wall; etc).
function beamBouncesAt(bm, d) {
  for (let i = 1; i < bm.pts.length; i++) {
    if (d <= bm.cum[i] || i === bm.pts.length - 1) return i - 1;
  }
  return 0;
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
    let cut = false;
    for (let d = bm.head; ; d = Math.min(head, d + 4)) {
      const p = beamPointAt(bm, d);
      // A brick wall stops the beam cold (and one laser destroys it).
      if (!bm.wallHit && hitWall(p.x, p.y, r, "laser", now)) {
        bm.total = d;          // truncate the beam here
        bm.wallHit = true;
        cut = true;
        break;
      }
      // Track which tanks the beam is currently passing THROUGH so a
      // single crossing = one hit, but a later crossing (after a
      // bounce) hits again. bm.inside holds ids we're mid-crossing.
      bm.inside = bm.inside ?? new Set();
      for (const t of S.tanks) {
        if (t.dead || t.gone) continue;
        const selfMuzzle = t.id === bm.by && d < TANK_R * 2.6;
        const touching = !selfMuzzle && tankHitPoint(t, p.x, p.y, r);
        if (touching && !bm.inside.has(t.id)) {
          // Just ENTERED the tank at this point along the path — one
          // hit. 8 dmg fresh, −1 per bounce so far, floored at 1.
          bm.inside.add(t.id);
          const dmg = Math.max(1, DMG.laserBase - beamBouncesAt(bm, d));
          if (S.mode === "local" || t.local) damageTank(t, dmg);
        } else if (!touching && bm.inside.has(t.id)) {
          bm.inside.delete(t.id); // exited — a later re-entry hits again
        }
      }
      if (d >= head) break;
    }
    bm.head = Math.min(head, bm.total);
    if (cut || head >= bm.total) bm.doneAt = now;
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

      if (hitWall(rk.x, rk.y, r, "rocket", now)) {
        S.booms.push({ x: rk.x, y: rk.y, born: now, r: r * 3 });
        addFade(rk.x, rk.y, r * 1.4, now);
        alive = false;
        break;
      }
      for (const t of S.tanks) {
        if (t.dead || t.gone) continue;
        if (t.id === rk.by && age < ROCKET.ownerGraceMs) continue;
        if (tankHitPoint(t, rk.x, rk.y, r)) {
          alive = false;
          if (S.mode === "local" || t.local) damageTank(t, DMG.rocket);
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

// Where the last wall was placed (so the network payload matches).
let lastWallPos = { x: 0, y: 0 };

// Drop a brick wall a bit ahead of the tank, perpendicular to facing.
function spawnWall(t, now) {
  const ahead = TANK_RAD + WALL.thickCells * CELL * 0.5 + 4;
  const x = t.x + Math.cos(t.a) * ahead;
  const y = t.y + Math.sin(t.a) * ahead;
  lastWallPos = { x, y };
  addWall(t.id, x, y, t.a, now);
}

// Create the wall object. Its long axis is perpendicular to `a`
// (the tank's facing), so it stands like a barrier in front of you.
function addWall(byId, x, y, a, now) {
  const half = WALL.lengthCells * CELL * 0.5;
  const perp = a + Math.PI / 2;
  S.walls.push({
    by: byId,
    x, y, a: perp,               // a = orientation of the LONG axis
    hx: half,                    // half-length along `perp`
    hy: WALL.thickCells * CELL * 0.5, // half-thickness
    hp: WALL.hp,
    born: now,
  });
}

function spawnSnipe(byId, x, y, a, now) {
  sfx.snipe?.();
  const speed = BULLET_SPEED * SNIPER.speed;
  S.snipes.push({
    x, y,
    vx: Math.cos(a) * speed,
    vy: Math.sin(a) * speed,
    x0: x, y0: y,               // origin, to measure the 5-cell range
    maxDist: SNIPER.rangeCells * CELL,
    born: now,
    by: byId,
    r: SNIPER.r * BULLET_R,
    mini: true,                 // never counts toward ammo
  });
}

// Damage a brick wall takes per weapon — the SAME numbers tanks take,
// so a 6-HP wall behaves like a 6-HP tank. Laser here is its base 8
// (a fresh, un-bounced beam one-shots the wall, as the design intends).
const WALL_DMG = {
  basic: DMG.basic,        // 2
  mg: DMG.mg,              // 1
  laser: DMG.laserBase,    // 8 → one hit
  rocket: DMG.rocket,      // 5
  cannon: DMG.cannonBall,  // 6 → one hit
  shrapnel: DMG.shrapnel,  // 2
  sniper: DMG.sniper,      // 4
};

// Point-vs-walls with damage. `dmgKey` selects the per-weapon value.
// Returns true if the projectile should die (it hit a wall).
function hitWall(x, y, r, dmgKey, now) {
  for (const w of S.walls) {
    const ca = Math.cos(w.a), sa = Math.sin(w.a);
    const dx = x - w.x, dy = y - w.y;
    const lx = dx * ca + dy * sa;
    const ly = -dx * sa + dy * ca;
    if (Math.abs(lx) < w.hx + r && Math.abs(ly) < w.hy + r) {
      w.hp -= WALL_DMG[dmgKey] ?? WALL_DMG.basic;
      addFade(x, y, r * 1.3, now, "#b5623a"); // brick puff
      if (w.hp <= 0) { sfx.wallbreak?.(); }
      return true;
    }
  }
  return false;
}

function stepWalls(now, dt) {
  S.walls = S.walls.filter((w) => now - w.born < WALL.lifeMs && w.hp > 0);
  // A wall blocks tanks: if a tank overlaps a wall slab, push it out
  // along the slab's short axis (gently). Clamp so we never eject a
  // tank past the arena boundary (no escaping the map).
  const lo = safeBox();
  const minX = lo.c0 * CELL + TANK_RAD, maxX = (lo.c1 + 1) * CELL - TANK_RAD;
  const minY = lo.r0 * CELL + TANK_RAD, maxY = (lo.r1 + 1) * CELL - TANK_RAD;
  for (const w of S.walls) {
    const ca = Math.cos(w.a), sa = Math.sin(w.a);
    for (const t of S.tanks) {
      if (t.dead || t.gone) continue;
      if (now < (t.phaseUntil ?? 0)) continue; // phasing tanks ignore it
      // tank center in the wall's local frame
      const dx = t.x - w.x, dy = t.y - w.y;
      const lx = dx * ca + dy * sa;   // along length
      const ly = -dx * sa + dy * ca;  // along thickness
      const ox = w.hx + TANK_RAD;     // overlap extents (circle approx)
      const oy = w.hy + TANK_RAD;
      if (Math.abs(lx) < ox && Math.abs(ly) < oy) {
        // Push out along whichever local axis needs the least travel.
        // length axis unit = (ca, sa); thickness axis unit = (-sa, ca).
        const pushL = ox - Math.abs(lx);
        const pushT = oy - Math.abs(ly);
        let nx, ny;
        if (pushT <= pushL) {
          const s = Math.sign(ly) || 1;
          nx = t.x + (-sa) * (s * pushT);
          ny = t.y + (ca) * (s * pushT);
        } else {
          const s = Math.sign(lx) || 1;
          nx = t.x + (ca) * (s * pushL);
          ny = t.y + (sa) * (s * pushL);
        }
        t.x = Math.min(maxX, Math.max(minX, nx));
        t.y = Math.min(maxY, Math.max(minY, ny));
        t.tx = t.x; t.ty = t.y;
      }
    }
  }
}

function stepSnipes(now, dt) {
  const r = SNIPER.r * BULLET_R;
  const survivors = [];
  for (const s of S.snipes) {
    s.x += s.vx * dt;
    s.y += s.vy * dt;
    // The sniper phases through MAZE walls — but a player-built brick
    // wall is a solid obstacle and stops it (one hit destroys it).
    if (hitWall(s.x, s.y, SNIPER.r * BULLET_R, "sniper", now)) continue;
    // Dies at its range limit or when it leaves the arena.
    const dx = s.x - s.x0, dy = s.y - s.y0;
    if (dx * dx + dy * dy > s.maxDist * s.maxDist) continue;
    if (s.x < -20 || s.y < -20 || s.x > S.worldW + 20 || s.y > S.worldH + 20) continue;

    let alive = true;
    for (const t of S.tanks) {
      if (t.dead || t.gone) continue;
      if (t.id === s.by && now - s.born < 120) continue; // don't clip the shooter on exit
      if (tankHitPoint(t, s.x, s.y, r)) {
        alive = false;
        addFade(s.x, s.y, r * 1.4, now);
        if (S.mode === "local" || t.local) damageTank(t, DMG.sniper);
        break;
      }
    }
    if (alive) survivors.push(s);
  }
  S.snipes = survivors;
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

function stepSnipesWrap() {} // (kept for clarity; stepSnipes called in stepSpecials)

function stepCannons(now, dt) {
  const r = CANNON.r * BULLET_R;
  const survivors = [];

  for (const c of S.cannons) {
    if (now - c.born > CANNON.lifeMs) { explodeCannon(c, now); continue; }

    let alive = true;
    c.x += c.vx * dt;
    c.y += c.vy * dt;
    if (hitWall(c.x, c.y, r, "cannon", now)) { explodeCannon(c, now); continue; }
    bounceCircle(c, S.rects, r);

    for (const t of S.tanks) {
      if (t.dead || t.gone) continue;
      if (t.id === c.by && now - c.born < 200) continue;
      if (tankHitPoint(t, c.x, c.y, r)) {
        if (S.mode === "local" || t.local) damageTank(t, DMG.cannonBall);
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
      if (hitWall(sh.x, sh.y, r, "shrapnel", now)) { alive = false; break; }
      for (const t of S.tanks) {
        if (t.dead || t.gone) continue;
        if (tankHitPoint(t, sh.x, sh.y, r)) {
          alive = false;
          addFade(sh.x, sh.y, r * 1.2, now);
          if (S.mode === "local" || t.local) damageTank(t, DMG.shrapnel);
          break;
        }
      }
    }

    if (alive) survivors.push(sh);
  }

  S.shraps = survivors;
}

// Apply `amount` of damage to a tank. When HP runs out, it's killed.
// Returns true if this hit destroyed it. Only the authoritative client
// (local sim, or the tank's owner online) should call this so scores
// stay consistent — callers already gate on (S.mode === "local" || t.local).
function damageTank(t, amount) {
  if (t.dead || t.gone) return false;
  t.hp = (t.hp ?? TANK_HP) - amount;
  t.lastHitAt = performance.now(); // for a brief damage flash
  if (t.hp <= 0) {
    killTank(t);
    return true;
  }
  sfx.hit?.();
  return false;
}

function killTank(t) {
  if (t.dead) return;
  t.dead = true;
  sfx.boom();
  if (S.mode === "online" && t.local) S.sendDead?.(t.id);

  // If the tank that just died is the local human's, show a black
  // "Destroyed" message. It clears after 2 s (so they can spectate)
  // as long as the round is still going. If they were the last one
  // out, the round-end banner takes over anyway.
  if (isLocalHuman(t)) {
    S.personalMsg = { text: "Destroyed", color: "#0a0c10", born: performance.now(), kind: "dead" };
  }
}

// The tank the human on THIS device controls (online: their id; local
// hot-seat: the first non-bot seat).
function isLocalHuman(t) {
  if (!t) return false;
  return S.mode === "online" ? t.id === S.myId : (!t.bot && t === S.tanks.find((x) => !x.bot));
}

/* ---------- rounds ---------- */

function maybeEndRound(now) {
  if (S.banner || S.roundStartCount < 2) return;
  const alive = S.tanks.filter((t) => !t.dead && !t.gone);
  if (alive.length > 1) return;

  const w = alive[0] ?? null;
  if (w) {
    S.scores[w.id] = (S.scores[w.id] ?? 0) + 1;
    if (S.ranked && S.scores[w.id] >= (S.winTarget ?? 5)) {
      S.matchOver = true;
    }
    // No "X wins" banner any more — the round just freezes. The only
    // end-of-round headline is the personal one: gold "Victory" for the
    // local human's win, black "Destroyed" (set on death) otherwise.
    S.banner = { silent: true };
    if (isLocalHuman(w)) {
      S.personalMsg = { text: "Victory", color: "#ffd23f", born: now, kind: "win" };
    }
    sfx.roundEnd();
  } else {
    // Everyone's out (a draw). Still freeze the round; no banner text.
    S.banner = { silent: true };
    sfx.roundEnd();
  }
  S.roundOverAt = now;
  updateScoreHUD();
}

function updateScoreHUD() {
  if (!scoreEl || !S) return;
  scoreEl.innerHTML = S.roster
    .map((p) => {
      const label = p.name ?? (S.mode === "local" ? SLOT_NAMES[p.slot ?? p.color] : null) ?? COLOR_NAMES[p.color];
      return `<div class="sc-card p-${p.color}">
        <span class="sc-name">${label}</span>
        ${tankSVG(p.color)}
        <span class="sc">${S.scores[p.id] ?? 0}</span>
      </div>`;
    })
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
// After phase ends, if the tank is buried in a wall, ease it to the
// closest open spot (a few px per frame — "smoothly pushes you out").
// Returns true once the tank is fully clear. Called every frame while
// t.ejecting is set, so the glide plays out smoothly over time.
function ejectFromWall(t, dt) {
  // Clear of BOTH maze walls and any player-built brick wall?
  if (!tankHitsAnyWall(t, t.x, t.y, t.a) && !tankInBrickWall(t, t.x, t.y)) {
    return true;
  }
  // Find the nearest position that clears everything.
  let best = null, bestD = Infinity;
  for (let r = 4; r <= CELL * 1.6; r += 4) {
    for (let k = 0; k < 24; k++) {
      const ang = (k / 24) * Math.PI * 2;
      const px = t.x + Math.cos(ang) * r;
      const py = t.y + Math.sin(ang) * r;
      if (!tankHitsAnyWall(t, px, py, t.a) && !tankInBrickWall(t, px, py)) {
        const d = (px - t.x) ** 2 + (py - t.y) ** 2;
        if (d < bestD) { bestD = d; best = { x: px, y: py }; }
      }
    }
    if (best) break;
  }
  if (!best) return false;
  // Glide toward it: up to ~260 px/s so the push reads as smooth but
  // doesn't dawdle.
  const dx = best.x - t.x, dy = best.y - t.y;
  const dist = Math.hypot(dx, dy) || 1;
  const step = Math.min(dist, 260 * dt);
  t.x += (dx / dist) * step;
  t.y += (dy / dist) * step;
  t.tx = t.x; t.ty = t.y;
  return dist <= step + 0.5; // reached it this frame → clear
}

// Does the tank (circle approx) overlap any player-built brick wall?
function tankInBrickWall(t, x, y) {
  for (const w of S.walls) {
    const ca = Math.cos(w.a), sa = Math.sin(w.a);
    const dx = x - w.x, dy = y - w.y;
    const lx = dx * ca + dy * sa;
    const ly = -dx * sa + dy * ca;
    if (Math.abs(lx) < w.hx + TANK_RAD && Math.abs(ly) < w.hy + TANK_RAD) return true;
  }
  return false;
}

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

  // During the 3-2-1 the whole arena sits behind frosted glass.
  const counting = now < (S.freezeUntil ?? 0);
  if (counting && "filter" in ctx) ctx.filter = "blur(5px)";

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, S.worldW, S.worldH);

  // Shaped arenas: paint the cells OUTSIDE the silhouette with the
  // page's dark background so only the shape reads as playable floor.
  if (S.maze?.inside && S.mazeShape && S.mazeShape !== "rect") {
    const inside = S.maze.inside;
    ctx.fillStyle = "#0c0f16";
    for (let r = 0; r < S.maze.rows; r++) {
      for (let c = 0; c < S.maze.cols; c++) {
        if (!inside[r][c]) ctx.fillRect(c * CELL, r * CELL, CELL, CELL);
      }
    }
  }

  // Ranked shrink: the dead ring is simply gone — plain white canvas
  // where it used to be. Nothing to draw; the walls there were already
  // stripped from S.rects when the ring dropped.

  // Ranked closing zone: cells already claimed glow a steady red; the
  // layer currently being warned blinks. Both are painted per-cell (so
  // any shape works) UNDER the walls, which stay drawn on top.
  if (S.ranked && S.zoneDist) {
    const zl = S.zoneLevel ?? 0;
    const wl = S.zoneWarnLevel ?? -1;
    const blink = Math.sin(now / 130) * 0.5 + 0.5; // fast strobe
    for (let r = 0; r < S.maze.rows; r++) {
      for (let c = 0; c < S.maze.cols; c++) {
        const layer = S.zoneDist[r][c];
        if (layer === Infinity) continue;
        if (layer < zl) {
          ctx.fillStyle = "rgba(200, 32, 30, 0.42)"; // permanently red
          ctx.fillRect(c * CELL, r * CELL, CELL, CELL);
        } else if (layer === wl) {
          ctx.fillStyle = `rgba(255, 45, 40, ${0.22 + 0.28 * blink})`; // warning
          ctx.fillRect(c * CELL, r * CELL, CELL, CELL);
        }
      }
    }
  }

  ctx.fillStyle = "#808896";
  for (const r of S.rects) ctx.fillRect(r.x, r.y, r.w, r.h);

  // Pickups on the floor, wrecks, tanks, then projectiles on top.
  const pulse = Math.sin(now / 220) * 0.5 + 0.5;
  // Dust puffs drift and dissolve beneath everything that moves.
  // Boosted puffs live 20% longer and read 10% darker; sparks are
  // bright yellow flecks riding inside the trail.
  const DUST_LIFE = 560, BOOST_LIFE = 560 * 1.2;
  S.dust = S.dust.filter((d) => now - d.born < (d.boost || d.spark ? BOOST_LIFE : DUST_LIFE));
  for (const d of S.dust) {
    const life = d.boost || d.spark ? BOOST_LIFE : DUST_LIFE;
    const k = (now - d.born) / life;
    if (d.spark) {
      ctx.fillStyle = "#ffd23f";
      ctx.globalAlpha = 0.9 * (1 - k);
      ctx.beginPath();
      ctx.arc(d.x + d.vx * k, d.y + d.vy * k, TANK_R * (0.08 + k * 0.06), 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.fillStyle = d.boost ? "#646974" : "#8b93a3"; // boosted = 20% darker again
      ctx.globalAlpha = (d.boost ? 0.18 : 0.16) * (1 - k);
      ctx.beginPath();
      ctx.arc(d.x + d.vx * k, d.y + d.vy * k, TANK_R * (0.22 + k * 0.4), 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;

  for (const w of S.walls) drawWall(w, now);
  for (const g of S.gear) drawGear(ctx, g, TANK_R, pulse, now);

  for (const t of S.tanks) if (t.dead && !t.gone) drawWreck(t);
  for (const L of S.laserPaths ?? []) drawLaserPreview(L);
  for (const A of S.sniperAims ?? []) drawSniperAim(A);
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

  // Shrapnel — always solid, even while passing through a wall.
  ctx.fillStyle = "#20242c";
  for (const sh of S.shraps) {
    ctx.beginPath();
    ctx.arc(sh.x, sh.y, CANNON.shrapR * BULLET_R, 0, Math.PI * 2);
    ctx.fill();
  }

  // Sniper slugs: a black ball (sized between a basic and MG round)
  // with a short dark motion streak.
  for (const s of S.snipes) {
    const len = 10;
    const sp = Math.hypot(s.vx, s.vy) || 1;
    ctx.strokeStyle = "rgba(20,24,28,.5)";
    ctx.lineWidth = SNIPER.r * BULLET_R * 1.2;
    ctx.beginPath();
    ctx.moveTo(s.x - (s.vx / sp) * len, s.y - (s.vy / sp) * len);
    ctx.lineTo(s.x, s.y);
    ctx.stroke();
    ctx.fillStyle = "#14181c";
    ctx.beginPath();
    ctx.arc(s.x, s.y, SNIPER.r * BULLET_R, 0, Math.PI * 2);
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

  // Round over: just dim the field (a silent freeze). The only
  // headline is the personal "Victory"/"Destroyed" message — there are
  // no "X wins the round" banners any more.
  if (S.banner) {
    ctx.fillStyle = "rgba(10, 12, 16, .55)";
    ctx.fillRect(0, 0, S.worldW, S.worldH);
  }
  if (S.personalMsg) drawPersonalMsg(now);

  if (counting) {
    if ("filter" in ctx) ctx.filter = "none";
    drawCountdown(now);
  }

  ctx.restore();

  // Held-weapon readout: a chip OUTSIDE the canvas, bottom-right.
  // Shows the local human's own equipped weapon/ability, in local AND
  // online play. (In local hot-seat, that's the first non-bot tank.)
  const myTank = S.mode === "online"
    ? S.tanks.find((t) => t.id === S.myId)
    : S.tanks.find((t) => !t.bot);
  if (weaponHudEl) {
    const w = myTank && !myTank.dead && !myTank.gone ? myTank.weapon : null;
    if (w) {
      weaponHudEl.hidden = false;
      weaponHudEl.textContent = WEAPON_NAMES[w] ?? w;
      weaponHudEl.style.color = GEAR_RIM[w] ?? "#eef1f6";
    } else {
      weaponHudEl.hidden = true;
    }
  }

  // Health readout: pips + number, bottom-left, for the local human's
  // own tank. Rebuilt only when the value changes to avoid DOM churn.
  if (healthHudEl) {
    const alive = myTank && !myTank.dead && !myTank.gone;
    const hp = alive ? Math.max(0, Math.ceil(myTank.hp ?? TANK_HP)) : 0;
    if (!alive) {
      healthHudEl.hidden = true;
      healthHudEl._hp = undefined;
    } else if (healthHudEl._hp !== hp) {
      healthHudEl._hp = hp;
      healthHudEl.hidden = false;
      let pips = "";
      for (let i = 0; i < TANK_HP; i++) {
        pips += `<span class="hp-pip${i < hp ? "" : " spent"}"></span>`;
      }
      healthHudEl.innerHTML = `<span class="hp-pips">${pips}</span><span class="hp-num">${hp}/${TANK_HP}</span>`;
    }
  }

  // The ranked zone timer lives in the top bar. It counts down to the
  // next layer, flips to a red "CLOSING" flash while a layer blinks,
  // and disappears once the whole map is red.
  if (shrinkEl) {
    if (S.ranked && !counting) {
      const warning = (S.zoneWarnLevel ?? -1) >= 0;
      if (warning) {
        const left = Math.max(0, Math.ceil((S.zoneWarnUntil - now) / 1000));
        shrinkEl.hidden = false;
        shrinkEl.textContent = `⚠ ZONE CLOSING ${left}`;
        shrinkEl.classList.add("warn");
      } else if (S.zoneNextAt === Infinity) {
        shrinkEl.hidden = true;
        shrinkEl.classList.remove("warn");
      } else {
        const left = Math.max(0, Math.ceil((S.zoneNextAt - now) / 1000));
        const mm = Math.floor(left / 60);
        const ss = String(left % 60).padStart(2, "0");
        shrinkEl.hidden = false;
        shrinkEl.textContent = `ZONE ${mm}:${ss}`;
        shrinkEl.classList.remove("warn");
      }
    } else if (!S.ranked) {
      shrinkEl.hidden = true;
    }
  }
}

// Giant blue 3-2-1 with a black border. No motion — it simply fades
// in and back out over each second.
function drawCountdown(now) {
  const remain = S.freezeUntil - now;
  const n = Math.ceil(remain / 1000);
  if (n < 1) return;
  const intoSec = (remain / 1000) % 1 || 1; // 1→0 across the second
  const alpha = Math.sin(Math.PI * intoSec); // 0 at the edges, 1 mid-second
  const size = S.worldH * 0.36; // fixed — no grow

  ctx.save();
  ctx.globalAlpha = Math.max(0, alpha);
  ctx.font = `900 ${size}px "Black Ops One", system-ui`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineWidth = size * 0.09;
  ctx.lineJoin = "round";
  ctx.strokeStyle = "#0a0c10";
  ctx.strokeText(String(n), S.worldW / 2, S.worldH / 2);
  ctx.fillStyle = "#47a3ff";
  ctx.fillText(String(n), S.worldW / 2, S.worldH / 2);
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

function drawSniperAim(A) {
  ctx.strokeStyle = A.color;
  ctx.globalAlpha = 0.4;
  ctx.lineWidth = BULLET_R * 0.4;
  ctx.setLineDash([5, 5]);
  ctx.beginPath();
  ctx.moveTo(A.x0, A.y0);
  ctx.lineTo(A.x1, A.y1);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
}

function drawWall(w, now) {
  ctx.save();
  ctx.translate(w.x, w.y);
  ctx.rotate(w.a);
  const L = w.hx, T = w.hy;
  // Brick slab.
  ctx.fillStyle = "#9c5638";
  ctx.fillRect(-L, -T, L * 2, T * 2);
  // Mortar lines: a couple of courses of staggered bricks.
  ctx.strokeStyle = "rgba(40,20,12,.55)";
  ctx.lineWidth = Math.max(1, T * 0.14);
  ctx.beginPath();
  ctx.moveTo(-L, 0); ctx.lineTo(L, 0);           // mid course line
  const brickW = (L * 2) / 3;
  for (let i = 1; i < 3; i++) {
    const x = -L + brickW * i;
    ctx.moveTo(x, -T); ctx.lineTo(x, 0);          // top course verticals
    const x2 = -L + brickW * (i - 0.5);
    ctx.moveTo(x2, 0); ctx.lineTo(x2, T);         // bottom course, staggered
  }
  ctx.stroke();
  // Damage tint as HP drops (the only visual cue — no timer bar).
  const frac = Math.max(0, w.hp / WALL.hp);
  if (frac < 1) {
    ctx.fillStyle = `rgba(20,10,6,${(1 - frac) * 0.4})`;
    ctx.fillRect(-L, -T, L * 2, T * 2);
  }
  ctx.restore();
}

function drawTank(t, now) {
  const hull = HULL[t.color];
  const R = TANK_R;

  ctx.save();
  // Phasing tanks are half-transparent.
  if (now < (t.phaseUntil ?? 0)) ctx.globalAlpha = PHASE.opacity;
  ctx.translate(t.x, t.y);
  ctx.rotate(t.a);

  // Treads with scrolling links — the phases come from each track's
  // actual ground speed (they counter-rotate in a zero-point turn).
  ctx.fillStyle = "#2a303c";
  rr(-R * 0.95, -R * 0.83, R * 1.9, R * 0.42, R * 0.15);
  rr(-R * 0.95, R * 0.41, R * 1.9, R * 0.42, R * 0.15);
  ctx.strokeStyle = "#6b7488"; // bright enough to read on a phone
  ctx.lineWidth = Math.max(2, R * 0.12);
  const linkGap = R * 0.34;
  const bands = [
    [-R * 0.8, -R * 0.44, t.trkL ?? 0],
    [R * 0.44, R * 0.8, t.trkR ?? 0],
  ];
  for (const [y0, y1, ph] of bands) {
    // Tread links scroll (direction reversed per design).
    let off = (ph % linkGap + linkGap) % linkGap;
    ctx.beginPath();
    for (let x = -R * 0.88 + off; x <= R * 0.88; x += linkGap) {
      ctx.moveTo(x, y0);
      ctx.lineTo(x, y1);
    }
    ctx.stroke();
  }

  ctx.fillStyle = hull;
  rr(-R * 0.9, -R * 0.58, R * 1.8, R * 1.16, R * 0.24);

  // Damage flash: a quick white overlay right after taking a hit.
  const sinceHit = now - (t.lastHitAt ?? -9999);
  if (sinceHit < 160) {
    ctx.save();
    ctx.globalAlpha = 0.6 * (1 - sinceHit / 160);
    ctx.fillStyle = "#ffffff";
    rr(-R * 0.9, -R * 0.58, R * 1.8, R * 1.16, R * 0.24);
    ctx.restore();
  }

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

// A personal, centered message for the local player: "Destroyed"
// (black) on death, "Victory" (gold) on a round win. The death one
// fades out after 2 s so the player can spectate the rest of the round.
function drawPersonalMsg(now) {
  const m = S.personalMsg;
  if (!m) return;
  const age = now - m.born;
  // Death message auto-clears after 2 s (unless the round already
  // ended and its banner is up, which supersedes it visually).
  if (m.kind === "dead" && age > 2000) { S.personalMsg = null; return; }
  // Fade in over 150 ms; the death one fades out over its final 400 ms.
  let alpha = Math.min(1, age / 150);
  if (m.kind === "dead") alpha *= Math.min(1, Math.max(0, (2000 - age) / 400));

  ctx.save();
  ctx.globalAlpha = alpha;
  let size = CELL * 0.9;
  ctx.font = `${size}px "Black Ops One", system-ui, sans-serif`;
  const tw = ctx.measureText(m.text).width;
  if (tw > S.worldW * 0.9) {
    size *= (S.worldW * 0.9) / tw;
    ctx.font = `${size}px "Black Ops One", system-ui, sans-serif`;
  }
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  // Subtle outline so black reads on dark walls and gold reads on white.
  ctx.lineWidth = size * 0.08;
  ctx.lineJoin = "round";
  ctx.strokeStyle = m.kind === "dead" ? "rgba(245,247,250,.6)" : "rgba(10,12,16,.7)";
  ctx.strokeText(m.text, S.worldW / 2, S.worldH / 2);
  ctx.fillStyle = m.color;
  ctx.fillText(m.text, S.worldW / 2, S.worldH / 2);
  ctx.restore();
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
