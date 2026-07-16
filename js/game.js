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
import { COLOR_NAMES, SLOT_NAMES, PALETTE } from "./palette.js";
import { getBinds } from "./settings.js";
import { mulberry32, generateMaze, wallRects, segmentFirstHit, MAZE_SHAPES, ringDistance, boundaryWalls, shapePolygon } from "./maze.js";
import { botActions, AI_PARAMS } from "./ai.js";
import {
  WEAPON_TYPES, BARRELS, LASER, MG, ROCKET, CANNON, SNIPER, BOOST, PHASE, WALL,
  ARMOUR, HEAL, MUD, MORTAR, mortarFlightMs, mortarDistAt,
  laserPath, castRaySlab, rocketSeekStep, stepShrap, bounceCircle, bounceSlab, drawBarrel, drawGear,
  WEAPON_CATEGORY, WEAPON_LABEL, GEAR_RIM,
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
const TURRET_TURN_SPEED = TURN_SPEED * 1.2 * 0.9; // 1.2× hull, then a 10% turret debuff

const GEAR_R = 14;             // pickup grab radius (added to the tank's)
const GEAR_TYPE_MAX = 2;       // default depth: this many of each ability
const GEAR_MAX = WEAPON_TYPES.length * GEAR_TYPE_MAX; // default field cap (24)
export const GEAR_CAP_LIMIT = 30; // the highest a host can set the cap
const GEAR_FIRST_MS = 2500;    // first pickup after round start
const GEAR_EVERY_MS = 3930;    // then every 3.9–6.4 s (40% faster than 5.5–9)
const GEAR_EVERY_JITTER = 2500;
const GEAR_SPREAD_MIN = CELL * 2.2; // crates keep this far apart when they can

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
// ---- Netcode (see the remote-tank block in stepTanks) ----
// Packets carry position + velocity + a shared-clock timestamp. Sends
// are adaptive: quick while moving or turning hard, slow heartbeats
// while parked. Remote tanks render ~130 ms in the past from a buffer
// of timestamped snapshots, interpolating between them; when a lag
// spike starves the buffer they dead-reckon along their last velocity
// (briefly, damped), and any correction when packets resume is
// rate-capped — never an instant teleport.
const NET_SEND_MS = 75;        // base cadence while moving
const NET_SEND_MIN_MS = 40;    // floor for urgent (sharp-turn) sends
const NET_IDLE_MS = 450;       // heartbeat while parked
const NET_INTERP_MS = 130;     // remotes render this far in the past
const NET_EXTRAP_MS = 250;     // max dead-reckoning past the buffer
const NET_BUF_MAX = 24;        // ~1.8 s of history
const NET_SNAP_DIST = CELL * 2.5;   // beyond this, a jump is deliberate
const NET_CORRECT_SPEED = 2.2;      // × MOVE_SPEED correction cap
// Arenas grouped by grid size. 1v1 (ranked) draws from small+medium,
// 2v2 (ranked) from large+xl; casual/offline use the whole range.
const MAZE_SIZE_GROUPS = {
  small:  [[7, 5], [7, 6], [8, 5], [8, 6], [8, 7]],
  medium: [[9, 5], [9, 6], [9, 7], [10, 6], [10, 7], [11, 6]],
  large:  [[11, 8], [12, 8], [12, 9], [13, 9], [13, 10]],
  xl:     [[14, 10], [15, 10], [15, 11], [16, 11], [17, 12], [18, 12]],
};
const MAZE_SIZES = [
  ...MAZE_SIZE_GROUPS.small, ...MAZE_SIZE_GROUPS.medium,
  ...MAZE_SIZE_GROUPS.large, ...MAZE_SIZE_GROUPS.xl,
];

const HULL = PALETTE; // every pickable paint + the Impossible black
const NO_MUL = { speed: 1, turn: 1 };

// The non-rectangular silhouettes used for casual arenas.
const MAZE_SHAPES_NONRECT = MAZE_SHAPES.filter((s) => s !== "rect");

/* ---------- module state ---------- */

let S = null;
let canvas, ctx, exitBtn, touchPad, scoreEl, shrinkEl, loadoutHudEl, healthHudEl, armourHudEl;
const held = new Set();
// Turret aiming: the mouse position in WORLD coordinates, whether the
// player has aimed at all yet (so we can fall back to hull-facing on
// touch / before first move), and whether the fire button (LMB) is down.
let mouseWorld = { x: 0, y: 0 };
let hasMouseAim = false;
let mouseFire = false;  // LMB — offense (special gun, else basic shots)
let mouseDef = false;   // RMB — defense (wall)
// Mobile: left stick drives the hull (moveVec, components in [-1,1]),
// right stick aims the turret (touchAim = world angle, held after
// release once engaged), and three buttons trigger the categories.
let moveVec = { x: 0, y: 0 };
let touchAim = 0;
let touchAimActive = false;
let touchFire = false, touchDef = false, touchAgi = false;

/* ================================================================
   Public API
   ================================================================ */

export function initGame() {
  canvas = document.getElementById("arena");
  ctx = canvas.getContext("2d");
  exitBtn = document.getElementById("game-exit");
  shrinkEl = document.getElementById("game-shrink");
  loadoutHudEl = document.getElementById("loadout-hud");
  healthHudEl = document.getElementById("health-hud");
  armourHudEl = document.getElementById("armour-hud");
  touchPad = document.getElementById("touch-pad");
  scoreEl = document.getElementById("game-score");

  exitBtn.addEventListener("click", () => {
    const s = S;
    if (s?.mode === "online") {
      // The exit callback (leaveLobby / endMatchForAll) stops the game
      // itself — calling stopGame first would wipe the match state the
      // ranked ABORT penalty needs to read.
      s.onExit?.();
    } else {
      stopGame();
      showScreen("screen-local");
    }
  });

  // Mobile controls: two analog sticks + three category fire buttons.
  // Each stick tracks its own pointer id, so both thumbs work at once.
  const setupStick = (el, onMove, onEnd) => {
    let pid = null;
    const knob = el.querySelector(".tp-knob");
    const update = (e) => {
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const rad = r.width / 2;
      let dx = (e.clientX - cx) / rad;
      let dy = (e.clientY - cy) / rad;
      const mag = Math.hypot(dx, dy);
      if (mag > 1) { dx /= mag; dy /= mag; } // clamp to the ring
      knob.style.transform =
        `translate(calc(-50% + ${dx * rad * 0.62}px), calc(-50% + ${dy * rad * 0.62}px))`;
      onMove(dx, dy);
    };
    el.addEventListener("pointerdown", (e) => {
      if (pid !== null) return;
      pid = e.pointerId;
      el.setPointerCapture(pid);
      e.preventDefault();
      update(e);
    });
    el.addEventListener("pointermove", (e) => {
      if (e.pointerId !== pid) return;
      update(e);
    });
    const release = (e) => {
      if (e.pointerId !== pid) return;
      pid = null;
      knob.style.transform = "translate(-50%, -50%)";
      onEnd();
    };
    el.addEventListener("pointerup", release);
    el.addEventListener("pointercancel", release);
  };

  const moveStick = document.getElementById("tp-move");
  const aimStick = document.getElementById("tp-aim");
  if (moveStick) {
    setupStick(moveStick,
      (dx, dy) => { moveVec.x = dx; moveVec.y = dy; },
      () => { moveVec.x = 0; moveVec.y = 0; });
  }
  if (aimStick) {
    setupStick(aimStick,
      (dx, dy) => {
        if (Math.hypot(dx, dy) > 0.3) { touchAim = Math.atan2(dy, dx); touchAimActive = true; }
      },
      () => { /* hold last aim on release */ });
  }

  touchPad.querySelectorAll(".tp-fire").forEach((btn) => {
    const which = btn.dataset.fire; // off | def | agi
    const set = (v) => {
      if (which === "off") touchFire = v;
      else if (which === "def") touchDef = v;
      else touchAgi = v;
      btn.classList.toggle("held", v);
    };
    btn.addEventListener("pointerdown", (e) => { e.preventDefault(); btn.setPointerCapture(e.pointerId); set(true); });
    const off = () => set(false);
    btn.addEventListener("pointerup", off);
    btn.addEventListener("pointercancel", off);
    btn.addEventListener("contextmenu", (e) => e.preventDefault());
  });

  // Turret aim: track the mouse over the arena in WORLD space using the
  // same view transform draw() lays down (stored on S.view each frame).
  const toWorld = (e) => {
    if (!S || !S.view) return;
    const r = canvas.getBoundingClientRect();
    const cx = e.clientX - r.left;
    const cy = e.clientY - r.top;
    mouseWorld.x = (cx - S.view.ox) / S.view.s;
    mouseWorld.y = (cy - S.view.oy) / S.view.s;
    hasMouseAim = true;
  };
  canvas.addEventListener("mousemove", toWorld);
  // Left mouse button = FIRE (default). Right-click menu is suppressed
  // over the arena so aiming near the edge never pops a context menu.
  canvas.addEventListener("mousedown", (e) => {
    toWorld(e);
    if (e.button === 0) { mouseFire = true; e.preventDefault(); }
    if (e.button === 2) { mouseDef = true; e.preventDefault(); }
  });
  window.addEventListener("mouseup", (e) => {
    if (e.button === 0) mouseFire = false;
    if (e.button === 2) mouseDef = false;
  });
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());
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
    serverNow: o.serverNow,
    gearPool: o.gearPool,
    gearMax: o.gearMax,
    sizePool: o.sizePool,
    teams: o.teams,
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
  if (loadoutHudEl) loadoutHudEl.hidden = true;
  if (armourHudEl) armourHudEl.hidden = true;
  if (healthHudEl) { healthHudEl.hidden = true; healthHudEl._hp = undefined; }
  S = null;
}

export function isGameActive() {
  return !!S;
}

// My tanks' received-damage ledger (attacker → total), for reporting.
export function getMatchStats() {
  return S ? { dmgBy: S.dmgBy ?? {}, killsBy: S.killsBy ?? {}, myId: S.myId } : null;
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
      if (p.pos) {
        // Buffer the timestamped snapshot for interpolation. Old-format
        // packets (no `t`) get stamped with their arrival time.
        const ts = typeof p.pos.t === "number" ? p.pos.t : S.netClock();
        const buf = (t.netBuf ??= []);
        const newest = buf[buf.length - 1];
        if (!newest || ts > newest.ts) {
          // Per-peer clock skew: arrival − stamp = their clock offset +
          // network latency. Chase its rolling minimum so one slow
          // packet can't inflate it; this rebases their timeline onto
          // ours even if a device's clock offset is way off.
          const skew = S.netClock() - ts;
          t.netSkew = t.netSkew == null ? skew : Math.min(t.netSkew * 0.98 + skew * 0.02, skew);
          buf.push({
            ts, x: p.pos.x, y: p.pos.y, a: p.pos.a, u: p.pos.u ?? p.pos.a,
            vx: p.pos.vx ?? 0, vy: p.pos.vy ?? 0,
          });
          if (buf.length > NET_BUF_MAX) buf.shift();
        }
        // Legacy targets stay maintained (spawn/eject code touches them).
        t.tx = p.pos.x; t.ty = p.pos.y; t.ta = p.pos.a;
        if (p.pos.u != null) t.tu = p.pos.u;
      }
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

  // Ranked mid-match departure = an abort. Track who left so their
  // rating is settled apart from the finishers.
  if (S.ranked && !S.matchOver && S.roundStartCount >= 2) {
    S.rankedGone = S.rankedGone ?? new Set();
    for (const t of S.tanks) {
      if (!t.bot && t.gone && t.id !== S.myId) S.rankedGone.add(t.id);
    }
    if (!S.teams) {
      // 1v1: my only opponent bailed → I take the match as a 3:0 win.
      // (Their own client books the matching 0:3 loss as it leaves.)
      const oppGone = S.roster.some((p) => !p.bot && p.id !== S.myId && S.rankedGone.has(p.id));
      if (oppGone && S.present.has(S.myId)) {
        for (const p of S.roster) S.scores[p.id] = p.id === S.myId ? (S.winTarget ?? 3) : 0;
        S.matchOver = true;
        S.banner = { silent: true };
        S.roundOverAt = performance.now();
        updateScoreHUD();
      }
    }
    // 2v2: the remaining three keep playing (the abandoned player is
    // simply down a tank → a 1v2); the aborter is excluded at the end.
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
    netClock: opts.serverNow ?? (() => Date.now()), // shared match clock
    // Custom-lobby host settings (null → defaults everywhere).
    gearPool: opts.gearPool ?? null,   // greenlit ability types
    gearMax: opts.gearMax ?? null,     // field cap (≤ GEAR_CAP_LIMIT)
    sizePool: opts.sizePool ?? null,   // allowed map size groups
    teams: opts.teams ?? null, // { [playerId]: 0|1 } in team modes (2v2)
    winTarget: opts.winTarget ?? 5,
    onRankedEnd: opts.onRankedEnd ?? null,
    matchOver: false,
    rankedEndFired: false,
    dmgBy: {},   // attackerId → damage they dealt to MY tanks
    killsBy: {}, // attackerId → kills of MY tanks
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
    healZones: [],
    mudPits: [],
    mortars: [],
    rects: [],
    diag: [],
    polyWorld: null,
    beams: [],
    booms: [],
    seenShots: {},
    banner: null,
    roundOverAt: 0,
    sentNext: false,
    lastT: performance.now(),
    raf: 0,
  };

  startRound(opts.seed);

  held.clear();
  mouseFire = false;
  mouseDef = false;
  hasMouseAim = false;
  moveVec.x = 0; moveVec.y = 0;
  touchAim = 0; touchAimActive = false;
  touchFire = false; touchDef = false; touchAgi = false;
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
  // Size pool by mode: 1v1 → small+medium, 2v2 → large+xl, casual →
  // the host's chosen groups (all of them by default). Shaped arenas
  // lose cells to the mask, so within the chosen pool they take the
  // larger half to keep the area generous.
  const G = MAZE_SIZE_GROUPS;
  let pool;
  if (S.ranked && S.teams) pool = [...G.large, ...G.xl];       // 2v2
  else if (S.ranked) pool = [...G.small, ...G.medium];         // 1v1
  else if (S.sizePool?.length) {
    pool = S.sizePool.flatMap((k) => G[k] ?? []);
    if (!pool.length) pool = MAZE_SIZES; // host unticked everything
  } else pool = MAZE_SIZES;                                    // casual / offline
  const sizeStart = shape === "rect" ? 0 : Math.floor(pool.length * 0.5);
  const [cols, rows] = pool[sizeStart + Math.floor(rng() * (pool.length - sizeStart))];
  // braid 0.1: roughly a third of the previous loopiness — fewer open
  // cross-connections, so corridors read as corridors.
  S.maze = generateMaze(cols, rows, rng, { shape, braid: 0.1 });
  S.rects = wallRects(S.maze, CELL, WALL_T);
  // Shaped arenas: the angled silhouette edge, as oriented wall slabs
  // (collision) plus the world-space polygon (for the floor + clip).
  // Both are empty/null for a plain rectangle, so nothing changes there.
  S.diag = boundaryWalls(S.maze, CELL, WALL_T);
  S.polyWorld = shapePolygon(S.maze, CELL);
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
  S.healZones = [];
  S.mudPits = [];
  S.mortars = [];
  S.mortarClouds = [];
  S.sparks = [];
  S.mortarAim = null;
  S.beams = [];
  S.booms = [];
  S.seenShots = {};
  S.banner = null;
  S.personalMsg = null;
  S.roundOverAt = 0;
  S.sentNext = false;
  for (const t of S.tanks) { t.phaseUntil = 0; t.wasPhasing = false; t.ejecting = false; }

  // Players 1 & 2 in opposite corners, 3 & 4 in the other pair. In a
  // TEAM match (2v2) the pairing changes: team 0 takes the two LEFT
  // corners, team 1 the two RIGHT corners, so teammates start on the
  // same side facing the enemy duo. For a shaped maze a raw corner may
  // fall outside the silhouette, so snap each to the nearest playable
  // cell.
  const rawCorners = S.teams
    ? [
        [0, 0],               // team 0, first member
        [0, rows - 1],        // team 0, second member
        [cols - 1, 0],        // team 1, first member
        [cols - 1, rows - 1], // team 1, second member
      ]
    : [
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

  // In a team match, hand out corners by TEAM (0 → left pair, 1 →
  // right pair) regardless of roster order.
  let seat0 = 0, seat1 = 0;
  const cornerFor = (spec, i) => {
    if (!S.teams) return corners[i];
    const team = S.teams[spec.id] ?? 0;
    const idx = team === 0 ? seat0++ : 2 + seat1++;
    return corners[Math.min(idx, 3)];
  };

  S.tanks = S.roster.map((spec, i) => {
    const [c, r] = cornerFor(spec, i);
    const x = (c + 0.5) * CELL;
    const y = (r + 0.5) * CELL;
    const a = Math.atan2(S.worldH / 2 - y, S.worldW / 2 - x);
    return {
      ...spec,
      local: S.mode === "local" ? true : spec.id === S.myId,
      x, y, a, tx: x, ty: y, ta: a,
      turret: a, tu: a, // barrel aim (world angle) + remote target
      dead: false,
      hp: TANK_HP, // baseline health; damage chips this down to 0
      armour: 0, armourUntil: 0, // shield HP + expiry (blue glow)
      healInMs: 0,               // continuous time inside a heal pad
      gone: !S.present.has(spec.id),
      prevShoot: false,
      prevDef: false,
      prevAgi: false,
      weapon: null,   // OFFENSE slot (drives the barrel sprite + hitbox)
      defense: null,  // DEFENSE slot (wall)
      agility: null,  // AGILITY slot (boost / phase)
      mg: null,
      gunClearedAt: 0,
      ai: null,
    };
  });
  refreshBotOwnership();

  // Guarantee every tank starts COMPLETELY inside: if a spawn cell is
  // clipped by a maze wall or the shaped arena's diagonal boundary,
  // ease the tank toward the map centre until its whole body is clear.
  const cxW = S.worldW / 2, cyW = S.worldH / 2;
  for (const t of S.tanks) {
    for (let step = 0; step < 40; step++) {
      const clipped =
        tankHitsAnyWall(t, t.x, t.y, t.a) || tankHitsAnyDiag(t, t.x, t.y, t.a) ||
        t.x < TANK_RAD || t.x > S.worldW - TANK_RAD ||
        t.y < TANK_RAD || t.y > S.worldH - TANK_RAD;
      if (!clipped) break;
      const dx = cxW - t.x, dy = cyW - t.y;
      const d = Math.hypot(dx, dy) || 1;
      t.x += (dx / d) * 6;
      t.y += (dy / d) * 6;
    }
    t.x = Math.max(TANK_RAD, Math.min(S.worldW - TANK_RAD, t.x));
    t.y = Math.max(TANK_RAD, Math.min(S.worldH - TANK_RAD, t.y));
    t.tx = t.x; t.ty = t.y;
  }

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
  mouseFire = false;
  mouseDef = false;
  moveVec.x = 0; moveVec.y = 0;
  touchAim = 0; touchAimActive = false;
  touchFire = false; touchDef = false; touchAgi = false;
}

function isBoundCode(code) {
  const b = getBinds();
  return Object.values(b).some((set) =>
    ["up", "down", "left", "right", "shoot"].some((a) => set?.[a] === code),
  );
}

function readActions(tank, binds) {
  const acts = {
    up: false, down: false, left: false, right: false,
    shoot: false, def: false, agi: false,
  };

  // ONE control set drives the human tank everywhere (the legacy
  // multi-player slots are gone — no more ghost binds like the old
  // yellow player's KeyY-to-shoot).
  const set = binds.red ?? Object.values(binds)[0] ?? {};
  for (const a of ["up", "down", "left", "right", "shoot"]) {
    const code = set[a];
    if (code && held.has(code)) acts[a] = true;
  }

  // Touch pad only ever drives the single local human tank.
  if (!tank.bot) {
    // Left stick → hull (thresholded so a centred stick is neutral).
    const DZ = 0.28;
    if (moveVec.y < -DZ) acts.up = true;
    if (moveVec.y > DZ) acts.down = true;
    if (moveVec.x < -DZ) acts.left = true;
    if (moveVec.x > DZ) acts.right = true;
    // Three activation controls, one per loadout category:
    //   LMB / offense button  → offense (special gun, else basic shot)
    //   RMB / defense button  → defense (wall)
    //   LShift / agility button → agility (boost / phase)
    if (mouseFire || touchFire) acts.shoot = true;
    if (mouseDef || touchDef) acts.def = true;
    if (held.has("ShiftLeft") || touchAgi) acts.agi = true;
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
  S.mortarAim = null;
  for (const t of S.tanks) {
    if (t.dead || t.gone) continue;
    if (t.weapon === "laser") {
      const m = muzzlePoint(t, 1);
      S.laserPaths.push({ by: t.id, color: HULL[t.color], pts: laserPath(m.x, m.y, t.turret ?? t.a, S.rects, LASER.previewBounces, S.diag) });
    } else if (t.weapon === "sniper") {
      // Straight line, no bounce, through walls, 3 cells long.
      const m = muzzlePoint(t, 1);
      const len = SNIPER.previewCells * CELL;
      const aim = t.turret ?? t.a;
      S.sniperAims.push({
        by: t.id, color: HULL[t.color],
        x0: m.x, y0: m.y,
        x1: m.x + Math.cos(aim) * len, y1: m.y + Math.sin(aim) * len,
      });
    } else if (t.weapon === "mortar" && !t.bot && t.local) {
      // The shooter's own targeting reticle — where the shell will land
      // if fired now. Only shown to the shooter (the in-flight red dot
      // is what warns everyone else).
      S.mortarAim = mortarTarget(t);
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
      // In 2v2, anyone who left mid-match already booked their abort
      // penalty and is dropped here, so the finishers rate against the
      // players who were actually present (a 1v2 stays a 1v2). In 1v1
      // the departed opponent must stay in with a 0 score so the win
      // computes as a clean 3:0.
      const drop = S.teams ? (S.rankedGone ?? new Set()) : new Set();
      const placements = S.roster
        .filter((p) => !drop.has(p.id))
        .map((p) => ({ id: p.id, color: p.color, score: S.scores[p.id] ?? 0 }))
        .sort((a, b) => b.score - a.score);
      S.onRankedEnd?.(placements, { dmgBy: S.dmgBy ?? {}, killsBy: S.killsBy ?? {}, myId: S.myId });
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

  if (S.mode === "online") {
    const snow = S.netClock();
    for (const t of S.tanks) {
      if (!t.local || t.dead || t.gone) continue;
      const last = t.netLast;
      if (!last) {
        t.netLast = { x: t.x, y: t.y, a: t.a, u: t.turret ?? t.a, at: snow };
        continue;
      }
      const elapsed = snow - last.at;
      if (elapsed < NET_SEND_MIN_MS) continue;
      const dx = t.x - last.x, dy = t.y - last.y;
      const moved = Math.hypot(dx, dy);
      const turned = Math.abs(angleDiff(last.a, t.a));
      const slewed = Math.abs(angleDiff(last.u, t.turret ?? t.a));
      const changed = moved > 1 || turned > 0.02 || slewed > 0.03;
      // Urgent: a sharp course change — remotes need it NOW or they'll
      // extrapolate down the old heading and need a big correction.
      const urgent = turned > 0.14 || moved > CELL * 0.5;
      const due = (changed && elapsed >= NET_SEND_MS) || (urgent) || elapsed >= NET_IDLE_MS;
      if (!due) continue;
      // Velocity from ACTUAL displacement (collisions included), px/s.
      const vx = +(dx / (elapsed / 1000)).toFixed(1);
      const vy = +(dy / (elapsed / 1000)).toFixed(1);
      t.netLast = { x: t.x, y: t.y, a: t.a, u: t.turret ?? t.a, at: snow };
      S.sendPos?.(t.id, {
        x: +t.x.toFixed(1), y: +t.y.toFixed(1),
        a: +t.a.toFixed(3), u: +(t.turret ?? t.a).toFixed(3),
        vx, vy, t: Math.round(snow),
      });
    }
  }

  setEngine(!S.banner, S.engineMovingLocal, S.engineMovingEnemy);
  draw(now);
  S.raf = requestAnimationFrame(frame);
}

// Sample a remote tank's snapshot buffer at "now minus the interp
// delay". Between two buffered states → linear interpolation (angles
// via shortest arc). Past the newest state (packets late) → dead-
// reckon along the last reported velocity, damped to a stop across
// NET_EXTRAP_MS so a silent peer coasts and parks instead of flying.
function sampleNetState(t) {
  const buf = t.netBuf;
  if (!buf || !buf.length) return null;
  const renderT = S.netClock() - (t.netSkew ?? 0) - NET_INTERP_MS;
  const newest = buf[buf.length - 1];

  if (renderT >= newest.ts) {
    // Buffer starved — extrapolate, easing the velocity down.
    const over = Math.min(renderT - newest.ts, NET_EXTRAP_MS);
    const ease = 1 - over / NET_EXTRAP_MS;          // 1 → 0
    const sec = (over / 1000) * (0.5 + 0.5 * ease); // integrated damping
    return {
      x: newest.x + newest.vx * sec,
      y: newest.y + newest.vy * sec,
      a: newest.a, u: newest.u,
    };
  }
  if (renderT <= buf[0].ts) return { x: buf[0].x, y: buf[0].y, a: buf[0].a, u: buf[0].u };

  // Find the straddling pair (buffer is small — a linear walk is fine).
  for (let i = buf.length - 2; i >= 0; i--) {
    const a = buf[i], b = buf[i + 1];
    if (renderT >= a.ts && renderT <= b.ts) {
      const f = (renderT - a.ts) / Math.max(1, b.ts - a.ts);
      return {
        x: a.x + (b.x - a.x) * f,
        y: a.y + (b.y - a.y) * f,
        a: a.a + angleDiff(a.a, b.a) * f,
        u: a.u + angleDiff(a.u, b.u) * f,
      };
    }
  }
  return { x: newest.x, y: newest.y, a: newest.a, u: newest.u };
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
            diag: S.diag,
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
            maxHp: TANK_HP,
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
      // Mud pit: any tank standing in one moves 20% slower.
      const inMud = S.mudPits.some((m) =>
        now - m.born < MUD.lifeMs && (t.x - m.x) ** 2 + (t.y - m.y) ** 2 < m.r * m.r);
      const mudMul = inMud ? MUD.slow : 1;
      if (acts.up) v += MOVE_SPEED * mul.speed * boostMul * mudMul;
      if (acts.down) v -= REVERSE_SPEED * mul.speed * boostMul * mudMul;

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

      // Kick up dust behind a driving tank (boost upgrades the trail —
      // see emitDriveDust, which is shared with remote playback so
      // every player sees the same effects).
      if (v !== 0 && now >= (t.dustAt ?? 0)) {
        emitDriveDust(t, v > 0 ? -1 : 1, boosting, now);
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
        } else if (!tankHitsAnyWall(t, nx, ny, t.a) && !tankHitsAnyDiag(t, nx, ny, t.a)) {
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

      // ---- Turret aim (barrel points independently of the hull) ----
      // Human: slew the barrel toward the mouse, capped at 20% above
      // the hull's turn speed (so it can out-track the body but isn't
      // an instant-snap). Bots aim with the hull (their AI already
      // turns the body onto the target), so the turret tracks it.
      // Before the first mouse move — or on touch, where the aim comes
      // from the right stick — fall back appropriately.
      if (t.bot) {
        t.turret = t.a;
      } else {
        const aimTarget = hasMouseAim
          ? Math.atan2(mouseWorld.y - t.y, mouseWorld.x - t.x)
          : (touchAimActive ? touchAim : t.a);
        const cur = t.turret ?? t.a;
        const step = TURRET_TURN_SPEED * dt;
        const d = angleDiff(cur, aimTarget);
        t.turret = cur + Math.max(-step, Math.min(step, d));
      }

      // Three activation controls, edge-triggered (press, not hold):
      // LMB → offense / basic gun, RMB → defense, LShift → agility.
      if (acts.shoot && !t.prevShoot && !phasing) tryFire(t, now);
      t.prevShoot = acts.shoot;
      if (acts.def && !t.prevDef && !phasing && t.defense) fireDefense(t, now);
      t.prevDef = acts.def;
      if (acts.agi && !t.prevAgi && !phasing && t.agility) fireAgility(t, now);
      t.prevAgi = acts.agi;

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
            const a = (t.turret ?? t.a) + (Math.random() * 2 - 1) * MG.spread;
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
      // Remote tank. Render it NET_INTERP_MS in the past against the
      // snapshot buffer: interpolating between two real states while
      // packets flow, dead-reckoning briefly along the last reported
      // velocity when a lag spike starves the buffer. The correction
      // toward the sampled state is RATE-CAPPED, so a burst of stale
      // packets after a spike eases the tank back on course — it never
      // teleports (unless the jump is a deliberate one, like a spawn).
      const ox = t.x;
      const oy = t.y;
      const oa = t.a;
      const st = sampleNetState(t);
      if (st) {
        const dxs = st.x - t.x, dys = st.y - t.y;
        const err = Math.hypot(dxs, dys);
        if (err > NET_SNAP_DIST) {
          // A jump this size is by design (round spawn, removal glitch).
          t.x = st.x; t.y = st.y; t.a = st.a; t.turret = st.u;
        } else {
          // Exponential pull with a hard speed ceiling: smooth for
          // small errors, bounded (no warp) for big ones.
          const k = 1 - Math.exp(-14 * dt);
          let mx = dxs * k, my = dys * k;
          const step = Math.hypot(mx, my);
          const cap = MOVE_SPEED * NET_CORRECT_SPEED * dt;
          if (step > cap && step > 0) { mx *= cap / step; my *= cap / step; }
          t.x += mx;
          t.y += my;
          t.a += angleDiff(t.a, st.a) * k;
          t.turret = (t.turret ?? t.a) + angleDiff(t.turret ?? t.a, st.u) * k;
        }
      } else {
        // No buffer yet (just joined / round start): legacy glide.
        const k = 1 - Math.exp(-12 * dt);
        t.x += (t.tx - t.x) * k;
        t.y += (t.ty - t.y) * k;
        t.a += angleDiff(t.a, t.ta) * k;
        t.turret = (t.turret ?? t.a) + angleDiff(t.turret ?? t.a, t.tu ?? t.a) * k;
      }

      // Tracks + dust from the observed motion. Boost state arrives
      // over the shot channel (t.boostUntil), so the upgraded trail —
      // and any future drive effect — renders for everyone.
      const fwd = (t.x - ox) * Math.cos(t.a) + (t.y - oy) * Math.sin(t.a);
      const spin = angleDiff(oa, t.a);
      const half = TANK_R * 0.62;
      t.trkL = (t.trkL ?? 0) + fwd + spin * half;
      t.trkR = (t.trkR ?? 0) + fwd - spin * half;

      // Their engine revs ONLY while they're actually observed moving
      // (driving or turning) — never while parked.
      if (Math.abs(fwd) > 20 * dt || Math.abs(spin) > 0.9 * dt) {
        S.engineMovingEnemy = true;
      }

      if (Math.abs(fwd) > 28 * dt && now >= (t.dustAt ?? 0)) {
        const boosting = now < (t.boostUntil ?? 0);
        emitDriveDust(t, fwd > 0 ? -1 : 1, boosting, now);
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
    // Safety: being shoved must never push a tank inside a wall —
    // EXCEPT a phasing tank, which is meant to sit inside walls freely
    // (whole hull, not just the barrel). Only the outer boundary holds.
    for (const t of alive) {
      if (!t.local) continue;
      if (now < (t.phaseUntil ?? 0)) continue; // phasing: don't eject
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
    // The shaped arena's diagonal boundary contains EVERY local tank —
    // phasing included — so no one can slip past the silhouette edge.
    for (const t of alive) {
      if (!t.local) continue;
      for (const w of S.diag) {
        const mtv = obbGenMTV(t.x, t.y, t.a, TANK_HL, TANK_HW, w.x, w.y, w.a, w.hx, w.hy);
        if (mtv) {
          t.x += mtv.nx * mtv.depth;
          t.y += mtv.ny * mtv.depth;
        }
      }
    }
  }
}

// Exhaust dust behind a driving tank — plus the boost trail. Shared
// by the local sim AND remote playback, so this effect (and any
// future drive animation added here) shows identically to all
// players. `back` is -1 driving forward, +1 reversing.
function emitDriveDust(t, back, boosting, now) {
  // Boost pumps particles out at nearly double the rate.
  t.dustAt = now + (boosting ? 34 + Math.random() * 24 : 65 + Math.random() * 45);
  const bx = t.x + Math.cos(t.a) * TANK_R * back;
  const by = t.y + Math.sin(t.a) * TANK_R * back;

  // Boost: 4 puffs per emission (vs 1), thrown wider and harder.
  const puffs = boosting ? 4 : 1;
  const scat = boosting ? 11 : 6;
  const kick = boosting ? 15 : 9;
  for (let p = 0; p < puffs; p++) {
    S.dust.push({
      x: bx + (Math.random() - 0.5) * scat,
      y: by + (Math.random() - 0.5) * scat,
      vx: Math.cos(t.a) * back * kick + (Math.random() - 0.5) * (boosting ? 16 : 8),
      vy: Math.sin(t.a) * back * kick + (Math.random() - 0.5) * (boosting ? 16 : 8),
      born: now,
      boost: boosting,
    });
  }

  if (boosting) {
    // A shower of hot sparks riding the trail: white-hot, yellow and
    // orange flecks of mixed size, kicked out hard and scattering wide.
    for (let k = 0; k < 5; k++) {
      const heat = Math.random();
      S.dust.push({
        x: bx + (Math.random() - 0.5) * 10,
        y: by + (Math.random() - 0.5) * 10,
        vx: Math.cos(t.a) * back * (18 + Math.random() * 26) + (Math.random() - 0.5) * 46,
        vy: Math.sin(t.a) * back * (18 + Math.random() * 26) + (Math.random() - 0.5) * 46,
        born: now,
        spark: true,
        color: heat > 0.72 ? "#fff6cf" : heat > 0.38 ? "#ffd23f" : "#ff8a2a",
        sz: 0.05 + Math.random() * 0.09,
      });
    }
  }
  while (S.dust.length > 600) S.dust.shift();
}

/* ---------- shooting ---------- */

// Barrel tip for the current weapon, pulled back if the barrel pokes
// through a wall so nothing spawns on the far side. projR = the
// projectile's radius (kept clear of the barrel tip).
function muzzlePoint(t, projR) {
  const bl = BARRELS[t.weapon] ?? BARRELS.normal;
  const aim = t.turret ?? t.a;
  const len = bl.len * TANK_R + projR + 2;
  const dx = Math.cos(aim);
  const dy = Math.sin(aim);
  const tipX = t.x + dx * len;
  const tipY = t.y + dy * len;
  // Nearest obstruction between hull centre and barrel tip: interior
  // walls, the shaped arena's diagonal boundary slabs, AND the outer
  // world bounds — so a tank nosed up against ANY edge can't spawn a
  // shot on the far side of it.
  let hit = segmentFirstHit(t.x, t.y, tipX, tipY, S.rects);
  for (const slab of S.diag ?? []) {
    const r = castRaySlab(t.x, t.y, dx, dy, slab, len);
    if (r && r.d / len < hit) hit = r.d / len;
  }
  const pad = projR + 1;
  if (dx > 0) hit = Math.min(hit, (S.worldW - pad - t.x) / (dx * len));
  else if (dx < 0) hit = Math.min(hit, (pad - t.x) / (dx * len));
  if (dy > 0) hit = Math.min(hit, (S.worldH - pad - t.y) / (dy * len));
  else if (dy < 0) hit = Math.min(hit, (pad - t.y) / (dy * len));
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
    fireOffense(t, now);
    return;
  }

  if (specialInPlay(t)) return;                 // your rocket flies alone
  if (now < (t.basicNext ?? 0)) return;         // 0.5 s between shots
  if (magAvailable(t, now) <= 0) return;        // magazine empty — regenerating

  t.basicNext = now + MAG_GAP;
  (t.basicMag ??= []).push(now);
  const m = muzzlePoint(t, BULLET_R);
  const aim = t.turret ?? t.a;
  spawnBullet(t.id, m.x, m.y, aim, now);
  sendTypedShot(t, { x: +m.x.toFixed(1), y: +m.y.toFixed(1), a: +aim.toFixed(3) }, now);
}

// OFFENSE (LMB): the special gun in the offense slot. Fires along the
// turret; the slot clears when the gun is spent (sniper keeps its
// barrel until both rounds are gone; the MG is handled in stepTanks).
function fireOffense(t, now) {
  const w = t.weapon;
  const aim = t.turret ?? t.a;

  if (w === "laser") {
    const m = muzzlePoint(t, 1);
    fireLaser(t.id, m.x, m.y, aim, now);
    sendTypedShot(t, { w: "laser", x: +m.x.toFixed(1), y: +m.y.toFixed(1), a: +aim.toFixed(3) }, now);
  } else if (w === "rocket") {
    const m = muzzlePoint(t, ROCKET.r * BULLET_R);
    spawnRocket(t.id, m.x, m.y, aim, now);
    sendTypedShot(t, { w: "rocket", x: +m.x.toFixed(1), y: +m.y.toFixed(1), a: +aim.toFixed(3) }, now);
  } else if (w === "cannon") {
    const m = muzzlePoint(t, CANNON.r * BULLET_R);
    spawnCannon(t.id, m.x, m.y, aim, now);
    sendTypedShot(t, { w: "cannon", x: +m.x.toFixed(1), y: +m.y.toFixed(1), a: +aim.toFixed(3) }, now);
  } else if (w === "sniper") {
    // Two rounds per pickup; fire one, keep the barrel until spent.
    const m = muzzlePoint(t, BARRELS.sniper.len * BULLET_R);
    spawnSnipe(t.id, m.x, m.y, aim, now);
    sendTypedShot(t, { w: "snipe", x: +m.x.toFixed(1), y: +m.y.toFixed(1), a: +aim.toFixed(3) }, now);
    t.snAmmo = (t.snAmmo ?? SNIPER.shots) - 1;
    if (t.snAmmo > 0) return; // keep the sniper until both rounds are gone
    t.snAmmo = null;
  } else if (w === "mortar") {
    // Indirect fire: aim at the mouse (or, for bots, their target),
    // snap to the CENTRE of that cell, and clamp the target to within
    // MORTAR.rangeCells of the tank. The shell arcs up and comes down
    // there, gaining +50% speed for every cell it travels.
    const tgt = mortarTarget(t);
    launchMortar(t.id, t.x, t.y, tgt.x, tgt.y, now);
    sendTypedShot(t, {
      w: "mortar",
      x0: +t.x.toFixed(1), y0: +t.y.toFixed(1),
      x: +tgt.x.toFixed(1), y: +tgt.y.toFixed(1),
    }, now);
  }

  clearWeapon(t, now);
}

// Where a tank's mortar would land: the mouse cell for the human, the
// nearest enemy for a bot — snapped to that cell's centre and clamped
// to within MORTAR.rangeCells of the tank.
function mortarTarget(t) {
  let ax, ay;
  if (t.bot) {
    // The AI supplies a predicted landing point (leads the target by
    // the shell's travel time). Fall back to the nearest enemy's
    // current position if it hasn't computed one.
    if (t.mortarAim) {
      ax = t.mortarAim.x; ay = t.mortarAim.y;
    } else {
      let best = Infinity, e = null;
      for (const o of S.tanks) {
        if (o === t || o.dead || o.gone) continue;
        const d = (o.x - t.x) ** 2 + (o.y - t.y) ** 2;
        if (d < best) { best = d; e = o; }
      }
      if (e) { ax = e.x; ay = e.y; }
      else { ax = t.x + Math.cos(t.turret ?? t.a) * CELL * 3; ay = t.y + Math.sin(t.turret ?? t.a) * CELL * 3; }
    }
  } else if (hasMouseAim) {
    ax = mouseWorld.x; ay = mouseWorld.y;
  } else if (touchAimActive) {
    ax = t.x + Math.cos(touchAim) * CELL * 3; ay = t.y + Math.sin(touchAim) * CELL * 3;
  } else {
    ax = t.x + Math.cos(t.turret ?? t.a) * CELL * 3; ay = t.y + Math.sin(t.turret ?? t.a) * CELL * 3;
  }
  // Clamp to reach, then lock onto the cell centre.
  const maxR = MORTAR.rangeCells * CELL;
  let dx = ax - t.x, dy = ay - t.y;
  const d = Math.hypot(dx, dy);
  if (d > maxR) { dx *= maxR / d; dy *= maxR / d; ax = t.x + dx; ay = t.y + dy; }
  ax = Math.max(0, Math.min(S.worldW - 1, ax));
  ay = Math.max(0, Math.min(S.worldH - 1, ay));
  const cx = (Math.floor(ax / CELL) + 0.5) * CELL;
  const cy = (Math.floor(ay / CELL) + 0.5) * CELL;
  return { x: cx, y: cy };
}

// Launch an arcing shell from (x0,y0) toward the locked cell (tx,ty).
// The flight ACCELERATES: +50% speed per cell traveled (see weapons.js
// for the shared math — every client and the AI use the same curve).
function launchMortar(byId, x0, y0, tx, ty, now) {
  const distCells = Math.hypot(tx - x0, ty - y0) / CELL;
  S.mortars.push({
    by: byId, x0, y0, x: tx, y: ty, born: now,
    distCells,
    landAt: now + mortarFlightMs(distCells),
  });
  sfx.cannon?.(0.75); // big-cannon report, a touch quieter
}

// Concentric damage rings, from the impact centre outward. Radii are
// fractions of a cell; the whole blast is a 1-cell-diameter circle.
const MORTAR_RINGS = [
  { r: 0.11, dmg: 8 }, // core (~half a tank across): full hit
  { r: 0.24, dmg: 6 },
  { r: 0.37, dmg: 3 },
  { r: 0.50, dmg: 1 }, // outer edge of the 1-cell circle
];

function detonateMortar(m, now) {
  sfx.boom?.();
  // The dark smoke cloud covering the cell.
  (S.mortarClouds ??= []).push({ x: m.x, y: m.y, born: now, seed: (Math.random() * 1e9) | 0 });
  addFade(m.x, m.y, CELL * 0.4, now);
  // Damage rings — the hit FX plays for every tank in the blast on
  // every client; applyHit applies damage only on the authority.
  for (const t of S.tanks) {
    if (t.dead || t.gone) continue;
    const d = Math.hypot(t.x - m.x, t.y - m.y);
    let dmg = 0;
    for (const ring of MORTAR_RINGS) {
      if (d <= ring.r * CELL) { dmg = ring.dmg; break; }
    }
    if (dmg > 0) applyHit(t, dmg, m.by, now, "mortar");
  }
}

function stepMortars(now) {
  if (!S.mortars.length) return;
  const survivors = [];
  for (const m of S.mortars) {
    if (now >= m.landAt) detonateMortar(m, now);
    else survivors.push(m);
  }
  S.mortars = survivors;
}

// DEFENSE (RMB): wall / armour / heal pad / mud pit, whichever is held.
function fireDefense(t, now) {
  const kind = t.defense;
  if (kind === "wall") {
    spawnWall(t, now);
    sfx.wallup?.();
    sendTypedShot(t, {
      w: "wall",
      x: +lastWallPos.x.toFixed(1), y: +lastWallPos.y.toFixed(1),
      a: +(t.turret ?? t.a).toFixed(3),
    }, now);
  } else if (kind === "armour") {
    // Shield: 4 HP that soak damage before health, for 20 s.
    t.armour = ARMOUR.hp;
    t.armourUntil = now + ARMOUR.durationMs;
    sfx.pickup?.();
    sendTypedShot(t, { w: "armour" }, now);
  } else if (kind === "heal") {
    // Green healing pad dropped on the spot.
    addHealZone(t.x, t.y, now);
    sfx.pickup?.();
    sendTypedShot(t, { w: "heal", x: +t.x.toFixed(1), y: +t.y.toFixed(1) }, now);
  } else if (kind === "mud") {
    // Muddy puddle dropped just behind the hull. A shared seed makes
    // every client draw the same blob.
    const back = t.a + Math.PI;
    const mx = t.x + Math.cos(back) * (TANK_RAD + MUD.radiusCells * CELL * 0.5);
    const my = t.y + Math.sin(back) * (TANK_RAD + MUD.radiusCells * CELL * 0.5);
    const seed = (Math.random() * 1e9) | 0;
    addMudPit(mx, my, seed, now);
    sfx.wallup?.();
    sendTypedShot(t, { w: "mud", x: +mx.toFixed(1), y: +my.toFixed(1), s: seed }, now);
  }
  t.defense = null;
}

// AGILITY (LShift): boost or phase, whichever is in the slot.
function fireAgility(t, now) {
  if (t.agility === "boost") {
    // Speed boost: activating it refills your basic gun AND grants a
    // temporary sprint. No projectile.
    t.boostUntil = now + BOOST.durationMs;
    t.basicMag = []; // refill: basic attacks available immediately
    t.basicNext = 0;
    sfx.boost?.();
    sendTypedShot(t, { w: "boost" }, now);
  } else if (t.agility === "phase") {
    // Phase: 2 s of intangibility. Can't shoot while active (handled
    // in the movement loop). Still vulnerable to everything.
    t.phaseUntil = now + PHASE.durationMs;
    sfx.phase?.();
    sendTypedShot(t, { w: "phase" }, now);
  }
  t.agility = null;
}

// Online receive: one dispatcher for every shot type.
function spawnShot(byId, sh, now = performance.now()) {
  switch (sh.w) {
    case "snipe": spawnSnipe(byId, sh.x, sh.y, sh.a, now); break;
    case "boost": {
      const bt = S.tanks.find((x) => x.id === byId);
      if (bt) { bt.boostUntil = now + BOOST.durationMs; sfx.boost?.(); }
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
    case "armour": {
      const at = S.tanks.find((x) => x.id === byId);
      if (at) { at.armour = ARMOUR.hp; at.armourUntil = now + ARMOUR.durationMs; }
      break;
    }
    case "heal": addHealZone(sh.x, sh.y, now); break;
    case "mud": addMudPit(sh.x, sh.y, sh.s ?? 1, now); break;
    case "mortar": launchMortar(byId, sh.x0, sh.y0, sh.x, sh.y, now); break;
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
      if (bounceSlab(b, S.diag, b.r ?? BULLET_R)) sfx.bounce();

      for (const t of S.tanks) {
        if (t.dead || t.gone) continue;
        // Fresh shots can't clip their own barrel on the way out —
        // but the window is short, so point-blank wall bounces bite.
        if (t.id === b.by && now - b.born < 75) continue;
        if (tankHitPoint(t, b.x, b.y, b.r ?? BULLET_R)) {
          alive = false;
          addFade(b.x, b.y, b.r ?? BULLET_R, now);
          // Authority: in local mode we own everyone; online we only
          // pronounce deaths for tanks simulated on this device.
          applyHit(t, b.mini ? DMG.mg : DMG.basic, b.by, now, "bullet");
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
  stepHeal(now, dt);
  stepMortars(now);
  stepBeams(now);
  S.beams = S.beams.filter((bm) => !bm.doneAt || now - bm.doneAt < LASER.flashMs);
  S.booms = S.booms.filter((bo) => now - bo.born < 320);
  S.mudPits = S.mudPits.filter((m) => now - m.born < MUD.lifeMs);
  if (S.mortarClouds) S.mortarClouds = S.mortarClouds.filter((c) => now - c.born < MORTAR.cloudMs);
  if (S.sparks) S.sparks = S.sparks.filter((p) => now - p.born < p.life);
}

// Healing pads: a tank must be CONTINUOUSLY inside for HEAL.tickMs to
// bank 1 HP. Ticks are processed before expiring the pad, so a tank
// present for the pad's whole life banks the full 3 HP. Only the
// authoritative client heals its own tanks (each heals its own).
function stepHeal(now, dt) {
  const active = S.healZones.filter((z) => now - z.born < HEAL.durationMs);
  for (const t of S.tanks) {
    if (!t.local || t.dead || t.gone) continue;
    const inside = active.some((z) => (t.x - z.x) ** 2 + (t.y - z.y) ** 2 < z.r * z.r);
    if (inside) {
      t.healInMs = (t.healInMs ?? 0) + dt * 1000;
      while (t.healInMs >= HEAL.tickMs - HEAL.tickGraceMs) {
        t.healInMs -= HEAL.tickMs;
        if ((t.hp ?? TANK_HP) < TANK_HP) {
          t.hp = Math.min(TANK_HP, (t.hp ?? TANK_HP) + HEAL.healPerHp);
          addHealPop(t.x, t.y, now);
          sfx.pickup?.();
        }
      }
    } else {
      t.healInMs = 0; // left the pad — presence resets
    }
  }
  S.healZones = active;
}

// A small green "+HP" rising pop when a heal tick lands.
function addHealPop(x, y, now) {
  (S.healPops ??= []).push({ x, y, born: now });
}

function stepGear(now) {
  // Spawn (local sim, or the controller online — pushed via sync).
  // Host settings (custom lobbies) decide WHICH abilities are in the
  // rotation and the field cap; both default to the full roster.
  const pool = S.gearPool?.length ? S.gearPool : WEAPON_TYPES;
  const cap = S.gearMax ?? GEAR_MAX;
  if (S.isController && S.gear.length < cap && now >= S.gearNextAt) {
    S.gearNextAt = now + GEAR_EVERY_MS + Math.random() * GEAR_EVERY_JITTER;
    const spot = pickGearSpot();
    if (spot) {
      // Round-robin the roster: always spawn one of the LEAST-common
      // greenlit abilities. With everything enabled and a cap of 30
      // that lays down 2 of each (24), then tops up a 3rd of six of
      // them — an even spread rather than a run on one type.
      const counts = {};
      for (const w of pool) counts[w] = 0;
      for (const g of S.gear) if (counts[g.type] != null) counts[g.type]++;
      const min = Math.min(...pool.map((w) => counts[w]));
      const open = pool.filter((w) => counts[w] === min);
      if (open.length) {
        const type = open[Math.floor(Math.random() * open.length)];
        const key = "g" + (S.gearSeq++) + Math.random().toString(36).slice(2, 6);
        if (S.mode === "local") {
          S.gear.push({ key, x: spot.x, y: spot.y, type, born: now });
          sfx.gearSpawn();
        } else S.sendGear?.(key, { x: spot.x, y: spot.y, type }); // arrives via snapshot
      }
    }
  }

  // Pickups: each client claims gear for its OWN tanks (exact positions).
  for (let i = S.gear.length - 1; i >= 0; i--) {
    const g = S.gear[i];
    const cat = WEAPON_CATEGORY[g.type] ?? "offense";
    for (const t of S.tanks) {
      if (!t.local || t.dead || t.gone) continue;
      // One item per category: the matching slot must be empty.
      // (offense also stays locked until the current gun is fired off.)
      const slotFull =
        cat === "offense" ? t.weapon : cat === "defense" ? t.defense : t.agility;
      if (slotFull) continue;
      const d2 = (t.x - g.x) ** 2 + (t.y - g.y) ** 2;
      if (d2 > (TANK_RAD + GEAR_R) ** 2) continue;
      S.gear.splice(i, 1);
      S.takenGear.set(g.key, now);
      if (cat === "offense") {
        t.weapon = g.type; // barrel (sprite + hitbox) swaps immediately
        if (g.type === "sniper") t.snAmmo = SNIPER.shots;
        // sendPickup atomically removes the crate AND announces the gun
        // (the gun channel drives every remote client's barrel).
        if (S.mode === "online") S.sendPickup?.(g.key, t.id, g.type);
      } else {
        if (cat === "defense") t.defense = g.type;
        else t.agility = g.type;
        // No barrel change → nothing to announce beyond the removal.
        if (S.mode === "online") S.sendGearRemove?.(g.key);
      }
      sfx.pickup();
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

// How many damage TICKS a tank takes from the red zone this pulse, or 0
// if it's not far enough into the red. Damage escalates with depth: a
// cell deals (zoneLevel − its layer) ticks, so each new layer that
// falls makes every already-red ring one tick deadlier — the further
// out (toward the edge) you are, the harder it bites. The tank is
// charged for the DEEPEST red cell under its footprint.
function redZoneTicks(t) {
  const R = TANK_RAD * 0.9;
  const zl = S.zoneLevel ?? 0;
  let minLayer = Infinity;
  let inside = 0, total = 0;
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      total++;
      const L = cellLayerAt(t.x + dx * R, t.y + dy * R);
      if (L < zl) { inside++; if (L < minLayer) minLayer = L; }
    }
  }
  const fullyClosed = zl > S.zoneMaxLayer;
  if (fullyClosed) {
    // No safe corner left — everyone's charged, by the deepest red cell
    // they occupy (centre = least, edge = most).
    if (minLayer === Infinity) minLayer = cellLayerAt(t.x, t.y);
    if (!Number.isFinite(minLayer)) minLayer = zl - 1;
    return Math.max(1, zl - minLayer);
  }
  if (inside / total > ZONE_INSIDE_FRAC && Number.isFinite(minLayer)) {
    return Math.max(1, zl - minLayer);
  }
  return 0;
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

  // --- red-zone damage tick (escalates with depth) ---
  if (now >= (S.zoneDamageAt ?? 0)) {
    S.zoneDamageAt = now + ZONE_DMG_PERIOD;
    for (const t of S.tanks) {
      if (t.dead || t.gone) continue;
      const ticks = redZoneTicks(t);
      if (ticks > 0 && (S.mode === "local" || t.local)) {
        t.lastHitAt = now; // zone burn flashes too
        sfx.hit?.();
        damageTank(t, ticks * ZONE_DMG, null);
      }
    }
  }
}

function pickGearSpot() {
  const { c0, r0, c1, r1 } = safeBox();
  const inside = S.maze.inside;
  const cellInside = (c, r) =>
    !inside || (r >= 0 && r < S.maze.rows && c >= 0 && c < S.maze.cols && inside[r][c]);

  // Gather every VALID candidate we can find, then take the one that
  // sits FARTHEST from the nearest existing crate (farthest-point
  // sampling). Picking the first random hit is what let crates bunch
  // up; scoring the options spreads them across the arena instead —
  // and it degrades gracefully on a cramped map, where it simply
  // returns the roomiest spot available rather than failing.
  const cands = [];
  for (let tries = 0; tries < 60; tries++) {
    const cc = c0 + Math.floor(Math.random() * (c1 - c0 + 1));
    const rr = r0 + Math.floor(Math.random() * (r1 - r0 + 1));
    if (!cellInside(cc, rr)) continue; // stay within the shape
    const x = (cc + 0.5) * CELL;
    const y = (rr + 0.5) * CELL;
    // Shaped arenas: the diagonal boundary slab can slice through an
    // "inside" cell — don't drop a crate into (or poking through) it.
    let clear = true;
    for (const w of S.diag ?? []) {
      const ca = Math.cos(w.a), sa = Math.sin(w.a);
      const lx = (x - w.x) * ca + (y - w.y) * sa;
      const ly = -(x - w.x) * sa + (y - w.y) * ca;
      const dx = Math.max(0, Math.abs(lx) - w.hx);
      const dy = Math.max(0, Math.abs(ly) - w.hy);
      if (Math.hypot(dx, dy) < GEAR_R + 26) { clear = false; break; }
    }
    if (!clear) continue;
    for (const t of S.tanks) {
      if (t.dead || t.gone) continue;
      if ((t.x - x) ** 2 + (t.y - y) ** 2 < (CELL * 1.2) ** 2) { clear = false; break; }
    }
    if (!clear) continue;
    // Hard floor: never stack crates on top of each other.
    let near = Infinity;
    for (const g of S.gear) {
      const d = Math.hypot(g.x - x, g.y - y);
      if (d < near) near = d;
    }
    if (near < CELL) continue;
    cands.push({ x, y, near });
    // Comfortably isolated already — no need to keep searching.
    if (near >= GEAR_SPREAD_MIN && cands.length >= 6) break;
  }
  if (!cands.length) return null;
  cands.sort((a, b) => b.near - a.near); // most isolated first
  return { x: cands[0].x, y: cands[0].y };
}

function fireLaser(byId, x, y, a, now) {
  const pts = laserPath(x, y, a, S.rects, LASER.shotBounces, S.diag);
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
          applyHit(t, dmg, bm.by, now, "laser");
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
        bounceSlab(rk, S.diag, r);
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
          applyHit(t, DMG.rocket, rk.by, now, "bullet");
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

// Drop a brick wall a bit ahead of the tank, perpendicular to the aim.
function spawnWall(t, now) {
  const aim = t.turret ?? t.a;
  const ahead = TANK_RAD + WALL.thickCells * CELL * 0.5 + 4;
  const x = t.x + Math.cos(aim) * ahead;
  const y = t.y + Math.sin(aim) * ahead;
  lastWallPos = { x, y };
  addWall(t.id, x, y, aim, now);
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

// A green healing pad. Heals any tank that stays inside it (see stepHeal).
function addHealZone(x, y, now) {
  S.healZones.push({ x, y, born: now, r: HEAL.radiusCells * CELL });
}

// A muddy puddle that slows any tank inside it. `seed` drives the
// irregular blob outline so every client draws the same shape.
function addMudPit(x, y, seed, now) {
  const rng = mulberry32(seed >>> 0);
  const R = MUD.radiusCells * CELL;
  const N = 11;
  const pts = [];
  for (let i = 0; i < N; i++) {
    const ang = (i / N) * Math.PI * 2;
    const rr = R * (0.72 + rng() * 0.5);          // jittered radius
    pts.push([Math.cos(ang) * rr, Math.sin(ang) * rr * 0.82]); // squashed
  }
  S.mudPits.push({ x, y, r: R, born: now, pts });
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
    for (const t of S.tanks) {
      if (t.dead || t.gone) continue;
      if (now < (t.phaseUntil ?? 0)) continue; // phasing tanks ignore it
      // Exact SAT between the tank's oriented body rectangle and the
      // wall slab — the same rectangles that are drawn on screen, so
      // tanks touch the bricks flush and slide along them cleanly.
      const mtv = obbGenMTV(t.x, t.y, t.a, TANK_HL, TANK_HW, w.x, w.y, w.a, w.hx, w.hy);
      if (mtv) {
        t.x = Math.min(maxX, Math.max(minX, t.x + mtv.nx * mtv.depth));
        t.y = Math.min(maxY, Math.max(minY, t.y + mtv.ny * mtv.depth));
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
      if (t.id === s.by && now - s.born < 60) continue; // don't clip the shooter on exit
      if (tankHitPoint(t, s.x, s.y, r)) {
        alive = false;
        addFade(s.x, s.y, r * 1.4, now);
        applyHit(t, DMG.sniper, s.by, now, "bullet");
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
    bounceSlab(c, S.diag, r);

    for (const t of S.tanks) {
      if (t.dead || t.gone) continue;
      if (t.id === c.by && now - c.born < 100) continue;
      if (tankHitPoint(t, c.x, c.y, r)) {
        applyHit(t, DMG.cannonBall, c.by, now, "bullet");
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
  // A small smoke puff at the point of detonation (reuses the mortar
  // cloud, smaller — the same rising-and-fading render).
  (S.mortarClouds ??= []).push({
    x: c.x, y: c.y, born: now, scale: 0.55, seed: (Math.random() * 1e9) | 0,
  });
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
          applyHit(t, DMG.shrapnel, sh.by, now, "bullet");
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

// A projectile connected with a tank. The FLASH, SPARKS, and SOUND
// play on EVERY client (each simulates the collision locally); the
// actual damage is applied only by the tank's authoritative client.
function applyHit(t, amount, byId, now = performance.now(), kind = "bullet") {
  t.lastHitAt = now;           // red damage flash (drawTank)
  addHitSparks(t.x, t.y, now); // metal sparks at the hull
  // Weapon-specific impact: laser burns through metal; ballistic
  // rounds clang off it; the mortar's own detonation boom covers its
  // hit, so it plays no extra impact tone.
  if (kind === "laser") sfx.hitLaser?.();
  else if (kind === "mortar") { /* the boom is the hit */ }
  else sfx.hitMetal?.();
  if (S.mode === "local" || t.local) damageTank(t, amount, byId);
}

// Short-lived orange/white sparks thrown from a hit.
function addHitSparks(x, y, now) {
  const list = (S.sparks ??= []);
  const n = 5 + (Math.random() * 3 | 0);
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2;
    const sp = 60 + Math.random() * 140;
    list.push({
      x, y,
      vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
      born: now, life: 180 + Math.random() * 140,
      hot: Math.random() < 0.4, // some sparks flash white
    });
  }
}

function damageTank(t, amount, byId = null) {
  if (t.dead || t.gone) return false;
  const now = performance.now();
  let dmg = amount;
  let dealt = 0;
  // Armour shield soaks damage first, while it's active.
  if (now < (t.armourUntil ?? 0) && (t.armour ?? 0) > 0) {
    const soak = Math.min(t.armour, dmg);
    t.armour -= soak;
    dmg -= soak;
    dealt += soak;
    if (t.armour <= 0) t.armourUntil = 0; // shield spent
  }
  t.lastHitAt = now; // for a brief damage flash
  let killed = false;
  if (dmg > 0) {
    const hpBefore = t.hp ?? TANK_HP;
    t.hp = hpBefore - dmg;
    dealt += Math.min(hpBefore, dmg); // don't credit overkill
    if (t.hp <= 0) { killTank(t); killed = true; }
  }
  // Match stats: credit the attacker for damage actually inflicted —
  // INCLUDING damage to yourself (a mortar on your own feet counts) —
  // and for kills of OTHER tanks (a self-kill isn't a kill).
  if (byId && dealt > 0) {
    S.dmgBy = S.dmgBy ?? {};
    S.dmgBy[byId] = (S.dmgBy[byId] ?? 0) + dealt;
    if (killed && byId !== t.id) {
      S.killsBy = S.killsBy ?? {};
      S.killsBy[byId] = (S.killsBy[byId] ?? 0) + 1;
    }
  }
  return killed;
}

function killTank(t) {
  if (t.dead) return;
  t.dead = true;
  const now = performance.now();
  // The full send-off: a dedicated explosion sound, a fireball flash,
  // a debris shower, and a lingering smoke pall over the wreck.
  sfx.explosion ? sfx.explosion() : sfx.boom();
  S.booms.push({ x: t.x, y: t.y, born: now, r: TANK_R * 3.2 });
  addFade(t.x, t.y, TANK_R * 1.6, now);
  addHitSparks(t.x, t.y, now);
  addHitSparks(t.x, t.y, now); // double shower — it's an explosion
  (S.mortarClouds ??= []).push({ x: t.x, y: t.y, born: now, seed: (Math.random() * 1e9) | 0 });
  if (S.mode === "online" && t.local) S.sendDead?.(t.id);

  // If the tank that just died is the local human's, show a black
  // "Destroyed" message. It clears after 2 s (so they can spectate)
  // as long as the round is still going. If they were the last one
  // out, the round-end banner takes over anyway.
  if (isLocalHuman(t)) {
    S.personalMsg = { text: "Destroyed", color: "#0a0c10", born: now, kind: "dead" };
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

  if (S.teams) {
    // TEAM match (2v2): the round runs while BOTH teams still have a
    // tank standing. When one team is wiped, every member of the other
    // team banks the round win — dead or alive ("if your teammate wins
    // the round, you also win the round").
    const aliveTeams = new Set(alive.map((t) => S.teams[t.id] ?? 0));
    if (aliveTeams.size > 1) return;

    const winTeam = aliveTeams.size === 1 ? [...aliveTeams][0] : null;
    if (winTeam != null) {
      let top = 0;
      for (const p of S.roster) {
        if ((S.teams[p.id] ?? 0) !== winTeam) continue;
        S.scores[p.id] = (S.scores[p.id] ?? 0) + 1;
        top = Math.max(top, S.scores[p.id]);
      }
      if (S.ranked && top >= (S.winTarget ?? 5)) S.matchOver = true;
      S.banner = { silent: true };
      // The LOCAL player's team winning is a personal Victory — even
      // if their own tank died earlier in the round.
      const meTank = S.tanks.find((t) => (S.mode === "online" ? t.id === S.myId : !t.bot));
      if (meTank && (S.teams[meTank.id] ?? 0) === winTeam) {
        S.personalMsg = { text: "Victory", color: "#ffd23f", born: now, kind: "win" };
      }
      sfx.roundEnd();
    } else {
      S.banner = { silent: true }; // both teams wiped — a draw
      sfx.roundEnd();
    }
    S.roundOverAt = now;
    updateScoreHUD();
    return;
  }

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
  // Team matches list teammates side by side (team 0 first).
  const order = S.teams
    ? [...S.roster].sort((a, b) => (S.teams[a.id] ?? 0) - (S.teams[b.id] ?? 0))
    : S.roster;
  scoreEl.innerHTML = order
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

// Does the tank's oriented body rectangle overlap any player-built
// brick wall? Exact SAT — matches what's drawn.
function tankInBrickWall(t, x, y) {
  for (const w of S.walls) {
    if (obbGenMTV(x, y, t.a, TANK_HL, TANK_HW, w.x, w.y, w.a, w.hx, w.hy)) return true;
  }
  return false;
}

// Does the tank's body overlap the shaped arena's diagonal boundary?
// Empty (always false) for a plain rectangle.
function tankHitsAnyDiag(t, x, y, a) {
  for (const w of S.diag) {
    if (obbGenMTV(x, y, a, TANK_HL, TANK_HW, w.x, w.y, w.a, w.hx, w.hy)) return true;
  }
  return false;
}

function tankHitsAnyWall(t, x, y, a) {
  // Only the hull body blocks movement/rotation. The barrel is now a
  // free-spinning turret (aimed by the mouse), so it must NOT clunk the
  // hull to a stop — a barrel poking a wall is cosmetic, and the muzzle
  // is pulled back at fire time (see muzzlePoint) so nothing spawns
  // through a wall.
  const reach = TANK_RAD;
  for (const rc of S.rects) {
    if (!nearRect(x, y, rc, reach)) continue;
    if (obbHitsRect(x, y, a, rc)) return true;
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

// Generic SAT MTV between two arbitrary oriented rectangles: rect A
// (center ax,ay, angle aa, half-extents ahl×ahw) vs rect B. Returns
// the push that moves A out of B (normal points B → A), or null if
// they don't overlap. Used for tank vs player-built wall slabs — the
// EXACT drawn rectangles, no inflated circle approximation.
function obbGenMTV(axc, ayc, aa, ahl, ahw, bxc, byc, ba, bhl, bhw) {
  const dx = axc - bxc;
  const dy = ayc - byc;
  const reach = Math.hypot(ahl, ahw) + Math.hypot(bhl, bhw);
  if (dx * dx + dy * dy >= reach * reach) return null; // broadphase
  const axes = [...obbAxes(aa), ...obbAxes(ba)];
  let depth = Infinity;
  let nx = 0;
  let ny = 0;
  for (const [ax, ay] of axes) {
    const overlap =
      obbProjR(aa, ax, ay, ahl, ahw) +
      obbProjR(ba, ax, ay, bhl, bhw) -
      Math.abs(dx * ax + dy * ay);
    if (overlap <= 0) return null; // separating axis found
    if (overlap < depth) { depth = overlap; nx = ax; ny = ay; }
  }
  if (dx * nx + dy * ny < 0) { nx = -nx; ny = -ny; }
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

  // Body: the hull rectangle, in the hull's frame (angle t.a).
  {
    const c = Math.cos(t.a);
    const s = Math.sin(t.a);
    const lx = dx * c + dy * s;   // along the hull
    const ly = -dx * s + dy * c;  // across
    const px = clamp(lx, -TANK_HL, TANK_HL);
    const py = clamp(ly, -TANK_HW, TANK_HW);
    const ox = lx - px;
    const oy = ly - py;
    if (ox * ox + oy * oy < r * r) return true;
  }

  // Barrel: the barrel rectangle, in the TURRET's frame (it now aims
  // independently of the hull, so its hitbox rotates with the mouse).
  {
    const aim = t.turret ?? t.a;
    const c = Math.cos(aim);
    const s = Math.sin(aim);
    const lx = dx * c + dy * s;
    const ly = -dx * s + dy * c;
    const bl = BARRELS[t.weapon] ?? BARRELS.normal;
    const px = clamp(lx, 0, bl.len * TANK_R);
    const py = clamp(ly, -bl.hw * TANK_R, bl.hw * TANK_R);
    const ox = lx - px;
    const oy = ly - py;
    if (ox * ox + oy * oy < r * r) return true;
  }

  return false;
}

/* ================================================================
   Rendering
   ================================================================ */

// Trace a closed polygon path (world-space points) onto ctx.
function tracePoly(pts) {
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.closePath();
}

// One loadout HUD slot: the equipped item's crate icon, enlarged —
// drawn with the SAME painter as the floor pickups, so the HUD always
// matches what you grabbed. An empty slot is a faint dashed socket.
function drawLoadoutIcon(cv, type) {
  const c2 = cv.getContext("2d");
  const w = cv.width;
  const h = cv.height;
  c2.setTransform(1, 0, 0, 1, 0, 0);
  c2.clearRect(0, 0, w, h);
  if (!type) {
    c2.strokeStyle = "rgba(170, 178, 194, 0.35)";
    c2.lineWidth = Math.max(2, w * 0.03);
    c2.setLineDash([w * 0.07, w * 0.06]);
    c2.beginPath();
    c2.arc(w / 2, h / 2, w * 0.36, 0, Math.PI * 2);
    c2.stroke();
    c2.setLineDash([]);
    return;
  }
  // A static frame of the pickup crate: born long ago (no pop-in),
  // now = 0 (no bob/pulse motion), centred and scaled to fill.
  drawGear(c2, { type, x: w / 2, y: h / 2, born: -9999 }, w * 0.68, 0.5, 0);
}

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
  const ox = (cw - S.worldW * s) / 2;
  const oy = (ch - S.worldH * s) / 2;
  // Remember the transform (CSS-pixel space) so pointer events can map
  // mouse position back into world coordinates for turret aiming.
  S.view = { s, ox, oy };
  ctx.save();
  ctx.translate(ox, oy);
  ctx.scale(s, s);

  // During the 3-2-1 the whole arena sits behind frosted glass.
  const counting = now < (S.freezeUntil ?? 0);
  if (counting && "filter" in ctx) ctx.filter = "blur(5px)";

  // Floor. For a shaped arena, clip everything that follows (floor,
  // zone tint, interior walls) to the silhouette polygon: the area
  // outside simply shows the page background — no dark filler cells,
  // and the angled edge reads clean. Rect arenas fill the whole box.
  let clippedToShape = false;
  if (S.polyWorld) {
    ctx.save();
    tracePoly(S.polyWorld);
    ctx.clip();
    clippedToShape = true;
  }
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, S.worldW, S.worldH);

  // Ranked shrink: the dead ring is simply gone — plain white canvas
  // where it used to be. Nothing to draw; the walls there were already
  // stripped from S.rects when the ring dropped.

  // Ranked closing zone: cells already claimed glow a steady red; the
  // layer currently being warned blinks. Painted per-cell UNDER the
  // walls. On shaped arenas the diagonal cuts through boundary cells,
  // so an outside cell can still hold a thin interior sliver — we paint
  // those bordering-outside cells too (the polygon clip trims the rest)
  // to avoid white gaps hugging the angled edge.
  if (S.ranked && S.zoneDist) {
    const zl = S.zoneLevel ?? 0;
    const wl = S.zoneWarnLevel ?? -1;
    const blink = Math.sin(now / 130) * 0.5 + 0.5; // fast strobe
    const rows = S.maze.rows, cols = S.maze.cols;
    // Classify each cell: 2 = claimed red, 1 = warning, 0 = none.
    // Outside cells inherit the strongest state of an inside neighbour
    // (red beats warning), so the sliver they contain matches the ring.
    const stateAt = (r, c) => {
      const L = S.zoneDist[r]?.[c];
      if (L == null || L === Infinity) return 0;
      if (L < zl) return 2;
      if (L === wl) return 1;
      return 0;
    };
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        let st = stateAt(r, c);
        if (st === 0 && (S.zoneDist[r][c] === Infinity)) {
          // Outside cell — inherit from inside neighbours.
          st = Math.max(stateAt(r - 1, c), stateAt(r + 1, c), stateAt(r, c - 1), stateAt(r, c + 1));
        }
        if (st === 2) ctx.fillStyle = "rgba(200, 32, 30, 0.42)";
        else if (st === 1) ctx.fillStyle = `rgba(255, 45, 40, ${0.22 + 0.28 * blink})`;
        else continue;
        ctx.fillRect(c * CELL, r * CELL, CELL, CELL);
      }
    }
  }

  ctx.fillStyle = "#808896";
  for (const r of S.rects) ctx.fillRect(r.x, r.y, r.w, r.h);

  // Shaped arena: lift the silhouette clip and draw the diagonal border
  // as ONE stroked polygon (round joins), so the corners connect
  // smoothly instead of showing a seam between separate edge slabs.
  // The stroke is centred on the polygon with the wall thickness, so it
  // lines up exactly with the slab collision.
  if (clippedToShape) {
    ctx.restore();
    ctx.strokeStyle = "#808896";
    ctx.lineWidth = WALL_T;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    tracePoly(S.polyWorld);
    ctx.stroke();
  }

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
      const px = d.x + d.vx * k;
      const py = d.y + d.vy * k;
      const sz = TANK_R * ((d.sz ?? 0.08) + k * 0.05);
      ctx.fillStyle = d.color ?? "#ffd23f";
      // A soft glowing halo…
      ctx.globalAlpha = 0.22 * (1 - k);
      ctx.beginPath();
      ctx.arc(px, py, sz * 2.6, 0, Math.PI * 2);
      ctx.fill();
      // …around the hot core.
      ctx.globalAlpha = 0.95 * (1 - k);
      ctx.beginPath();
      ctx.arc(px, py, sz, 0, Math.PI * 2);
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

  // Ground defense effects, under walls/tanks: mud puddles then heal pads.
  for (const m of S.mudPits) drawMudPit(m, now);
  for (const z of S.healZones) drawHealZone(z, now);

  // Mortar: impact smoke clouds, in-flight landing markers, and the
  // shooter's own aiming reticle — all on the ground, under the tanks.
  if (S.mortarClouds) for (const c of S.mortarClouds) drawMortarCloud(c, now);
  for (const m of S.mortars) drawMortarMarker(m, now);
  if (S.mortarAim) drawMortarReticle(S.mortarAim, now);
  // Rising "+HP" pops when a heal tick lands.
  if (S.healPops) {
    S.healPops = S.healPops.filter((p) => now - p.born < 700);
    for (const p of S.healPops) {
      const k = (now - p.born) / 700;
      ctx.save();
      ctx.globalAlpha = 1 - k;
      ctx.fillStyle = "#8cf0ad";
      ctx.font = `bold ${Math.round(TANK_R * 0.7)}px "Black Ops One", system-ui`;
      ctx.textAlign = "center";
      ctx.fillText("+1", p.x, p.y - TANK_R - k * 22);
      ctx.restore();
    }
  }

  for (const w of S.walls) drawWall(w, now);
  for (const g of S.gear) drawGear(ctx, g, TANK_R, pulse, now);

  for (const t of S.tanks) if (t.dead && !t.gone) drawWreck(t);
  for (const L of S.laserPaths ?? []) drawLaserPreview(L);
  for (const A of S.sniperAims ?? []) drawSniperAim(A);
  for (const t of S.tanks) if (!t.dead && !t.gone) drawTank(t, now);

  // Lofted mortar shells fly ABOVE everything (they're up in the air).
  for (const m of S.mortars) drawMortarShell(m, now);

  // Impact sparks: short hot streaks thrown from a hull hit.
  if (S.sparks) {
    for (const p of S.sparks) {
      const k = (now - p.born) / p.life;
      const px = p.x + p.vx * (now - p.born) / 1000;
      const py = p.y + p.vy * (now - p.born) / 1000;
      ctx.save();
      ctx.globalAlpha = 1 - k;
      ctx.strokeStyle = p.hot ? "#fff2d8" : "#ffab3d";
      ctx.lineWidth = p.hot ? 2 : 1.5;
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(px - p.vx * 0.03, py - p.vy * 0.03);
      ctx.stroke();
      ctx.restore();
    }
  }

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

  // Loadout readout, bottom-right OUTSIDE the canvas: the enlarged
  // icons of your three equipped items — offense (LMB), defense (RMB),
  // agility (LShift). Redrawn only when the loadout actually changes.
  const myTank = S.mode === "online"
    ? S.tanks.find((t) => t.id === S.myId)
    : S.tanks.find((t) => !t.bot);
  if (loadoutHudEl) {
    const alive = myTank && !myTank.dead && !myTank.gone;
    if (!alive) {
      loadoutHudEl.hidden = true;
      loadoutHudEl._sig = undefined;
    } else {
      const items = {
        offense: myTank.weapon ?? null,
        defense: myTank.defense ?? null,
        agility: myTank.agility ?? null,
      };
      const sig = `${items.offense}|${items.defense}|${items.agility}`;
      loadoutHudEl.hidden = false;
      if (loadoutHudEl._sig !== sig) {
        loadoutHudEl._sig = sig;
        for (const cv of loadoutHudEl.querySelectorAll(".loadout-icon")) {
          drawLoadoutIcon(cv, items[cv.dataset.cat]);
        }
        // Caption each slot with the equipped ability's name in its own
        // colour (blank when the slot is empty) — no more keybind text.
        for (const lbl of loadoutHudEl.querySelectorAll(".loadout-key")) {
          const type = items[lbl.dataset.cat];
          lbl.textContent = type ? (WEAPON_LABEL[type] ?? type) : "";
          lbl.style.color = type ? (GEAR_RIM[type] ?? "#e8eefc") : "";
        }
      }
    }
  }

  // Armour readout: blue pips above health, shown only while the shield
  // is up. Rebuilt only when the count changes.
  if (armourHudEl) {
    const alive = myTank && !myTank.dead && !myTank.gone;
    const ar = alive && now < (myTank.armourUntil ?? 0) ? Math.max(0, Math.ceil(myTank.armour ?? 0)) : 0;
    if (ar <= 0) {
      armourHudEl.hidden = true;
      armourHudEl._ar = undefined;
    } else if (armourHudEl._ar !== ar) {
      armourHudEl._ar = ar;
      armourHudEl.hidden = false;
      let pips = "";
      for (let i = 0; i < ARMOUR.hp; i++) {
        pips += `<span class="ar-pip${i < ar ? "" : " spent"}"></span>`;
      }
      armourHudEl.innerHTML = `<span class="ar-pips">${pips}</span><span class="ar-num">${ar}</span>`;
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

// The shooter's own aiming reticle: a crosshair ringing the target cell.
function drawMortarReticle(a, now) {
  const pulse = 0.5 + 0.5 * Math.sin(now / 160);
  ctx.save();
  ctx.translate(a.x, a.y);
  ctx.strokeStyle = `rgba(232, 69, 46, ${0.55 + 0.35 * pulse})`;
  ctx.lineWidth = 2;
  const r = TANK_R * 1.1;
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  for (const [sx, sy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
    ctx.moveTo(sx * r * 0.55, sy * r * 0.55);
    ctx.lineTo(sx * r * 1.35, sy * r * 1.35);
  }
  ctx.stroke();
  ctx.restore();
}

// In-flight landing marker: a tank-sized pulsing red dot in the target
// cell — the warning enemies react to. Vanishes when the shell lands.
function drawMortarMarker(m, now) {
  const pulse = 0.5 + 0.5 * Math.sin(now / 130);
  ctx.save();
  ctx.translate(m.x, m.y);
  ctx.globalAlpha = 0.3 + 0.25 * pulse;
  ctx.fillStyle = "#e8452e";
  ctx.beginPath();
  ctx.arc(0, 0, TANK_R * (1.0 + 0.12 * pulse), 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 0.9;
  ctx.fillStyle = "#ff5a3c";
  ctx.beginPath();
  ctx.arc(0, 0, TANK_R * 0.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

// The arcing shell: rises high and falls onto the target. Top-down, so
// "height" is a vertical screen offset with a ground shadow beneath.
function drawMortarShell(m, now) {
  // Ground progress follows the ACCELERATING flight curve, so the
  // shell visibly picks up pace the further it goes.
  const d = m.distCells ?? Math.hypot(m.x - m.x0, m.y - m.y0) / CELL;
  const p = d > 0
    ? Math.max(0, Math.min(1, mortarDistAt(now - m.born, d) / d))
    : Math.max(0, Math.min(1, (now - m.born) / (m.landAt - m.born)));
  const gx = m.x0 + (m.x - m.x0) * p;   // ground position
  const gy = m.y0 + (m.y - m.y0) * p;
  const arc = Math.sin(Math.PI * p);    // 0→1→0
  const lift = arc * CELL * 2.6;        // peak height ~2.6 cells
  // Shadow that tightens as the shell nears the ground.
  ctx.save();
  ctx.globalAlpha = 0.18 + 0.22 * (1 - arc);
  ctx.fillStyle = "#000";
  ctx.beginPath();
  ctx.ellipse(gx, gy, TANK_R * (0.55 - 0.2 * arc), TANK_R * (0.34 - 0.12 * arc), 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  // The shell itself, lofted.
  const sx = gx, sy = gy - lift;
  ctx.save();
  ctx.fillStyle = "#2a2f24";
  ctx.beginPath();
  ctx.arc(sx, sy, TANK_R * 0.42, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#8a8f3c";  // olive nose cap
  ctx.beginPath();
  ctx.arc(sx, sy - TANK_R * 0.14, TANK_R * 0.2, 0, Math.PI * 2);
  ctx.fill();
  // Fins hint.
  ctx.strokeStyle = "#4a4f2c";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(sx - TANK_R * 0.42, sy);
  ctx.lineTo(sx + TANK_R * 0.42, sy);
  ctx.stroke();
  ctx.restore();
}

// The dark smoke cloud left by an impact, covering the cell.
function drawMortarCloud(c, now) {
  const age = now - c.born;
  const p = age / MORTAR.cloudMs;
  const grow = 0.5 + 0.5 * Math.min(1, p * 3);
  const fade = Math.max(0, 1 - p);
  const R = CELL * 0.5 * grow * (c.scale ?? 1);
  const rng = mulberry32(c.seed >>> 0);
  ctx.save();
  ctx.translate(c.x, c.y);
  ctx.globalAlpha = 0.72 * fade;
  // A few overlapping dark puffs for a smoky, non-circular blob.
  for (let i = 0; i < 7; i++) {
    const ang = (i / 7) * Math.PI * 2 + rng() * 0.6;
    const rr = R * (0.35 + rng() * 0.5);
    const px = Math.cos(ang) * R * 0.4;
    const py = Math.sin(ang) * R * 0.4;
    const g = ctx.createRadialGradient(px, py, 0, px, py, rr);
    g.addColorStop(0, "rgba(20, 20, 24, 0.9)");
    g.addColorStop(1, "rgba(20, 20, 24, 0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(px, py, rr, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

// A muddy puddle: an irregular squashed blob with a couple of ripples.
function drawMudPit(m, now) {
  const age = now - m.born;
  const k = Math.min(1, age / 300);                 // pop-in
  const fade = Math.min(1, (MUD.lifeMs - age) / 1200); // dry-up fade
  ctx.save();
  ctx.translate(m.x, m.y);
  ctx.globalAlpha = Math.max(0, Math.min(1, fade));
  ctx.scale(k, k);
  // Wet shadow rim.
  ctx.fillStyle = "rgba(38, 24, 12, 0.55)";
  tracePts(m.pts, 1.06);
  ctx.fill();
  // Mud body.
  ctx.fillStyle = "#5c4326";
  tracePts(m.pts, 1);
  ctx.fill();
  // A lighter sheen patch + a ripple.
  ctx.fillStyle = "rgba(120, 92, 54, 0.5)";
  ctx.beginPath();
  ctx.ellipse(-m.r * 0.12, -m.r * 0.08, m.r * 0.28, m.r * 0.18, -0.4, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "rgba(30, 18, 10, 0.4)";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.ellipse(m.r * 0.1, m.r * 0.12, m.r * 0.16, m.r * 0.1, 0.3, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

function tracePts(pts, s) {
  ctx.beginPath();
  ctx.moveTo(pts[0][0] * s, pts[0][1] * s);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0] * s, pts[i][1] * s);
  ctx.closePath();
}

// A green healing pad: a soft filled disc with a breathing ring and a
// medical cross, plus a countdown-thinning outline as it expires.
function drawHealZone(z, now) {
  const age = now - z.born;
  const life = 1 - age / HEAL.durationMs;
  const pop = Math.min(1, age / 260);
  const pulse = 0.5 + 0.5 * Math.sin(now / 260);
  ctx.save();
  ctx.translate(z.x, z.y);
  ctx.scale(pop, pop);
  // Filled glow.
  const g = ctx.createRadialGradient(0, 0, z.r * 0.2, 0, 0, z.r);
  g.addColorStop(0, "rgba(60, 210, 120, 0.34)");
  g.addColorStop(1, "rgba(60, 210, 120, 0.04)");
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(0, 0, z.r, 0, Math.PI * 2);
  ctx.fill();
  // Breathing ring.
  ctx.strokeStyle = `rgba(58, 200, 110, ${0.5 + 0.35 * pulse})`;
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.arc(0, 0, z.r * (0.86 + 0.06 * pulse), 0, Math.PI * 2);
  ctx.stroke();
  // Remaining-life arc.
  ctx.strokeStyle = "rgba(230, 255, 238, 0.6)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(0, 0, z.r * 0.96, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.max(0, life));
  ctx.stroke();
  // Cross.
  ctx.fillStyle = "rgba(235, 255, 240, 0.9)";
  const a = z.r * 0.1, b = z.r * 0.26;
  ctx.fillRect(-a, -b, a * 2, b * 2);
  ctx.fillRect(-b, -a, b * 2, a * 2);
  ctx.restore();
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

  // Armour shield: a pulsing blue halo around the hull while active.
  if (now < (t.armourUntil ?? 0) && (t.armour ?? 0) > 0) {
    const pulse = 0.5 + 0.5 * Math.sin(now / 180);
    ctx.save();
    ctx.rotate(-t.a); // keep the halo upright (circle, but cheap safety)
    const g = ctx.createRadialGradient(0, 0, R * 0.85, 0, 0, R * 1.75);
    g.addColorStop(0, "rgba(74, 168, 255, 0)");
    g.addColorStop(0.6, `rgba(74, 168, 255, ${0.32 + 0.2 * pulse})`);
    g.addColorStop(1, "rgba(74, 168, 255, 0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, R * 1.75, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

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

  // ---- Directional detail: the FRONT and REAR read differently ----
  // Front (+x): a lighter sloped glacis plate ending in a nose chevron.
  ctx.fillStyle = shade(hull, -0.18); // lighter
  ctx.beginPath();
  ctx.moveTo(R * 0.32, -R * 0.5);
  ctx.lineTo(R * 0.86, -R * 0.28);
  ctx.lineTo(R * 0.86, R * 0.28);
  ctx.lineTo(R * 0.32, R * 0.5);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = shade(hull, 0.45);
  ctx.lineWidth = Math.max(1.5, R * 0.07);
  ctx.beginPath(); // nose chevron
  ctx.moveTo(R * 0.52, -R * 0.3);
  ctx.lineTo(R * 0.78, 0);
  ctx.lineTo(R * 0.52, R * 0.3);
  ctx.stroke();
  // Rear (−x): darker engine deck with grille slats + twin exhausts.
  ctx.fillStyle = shade(hull, 0.35); // darker
  rr(-R * 0.9, -R * 0.46, R * 0.42, R * 0.92, R * 0.1);
  ctx.strokeStyle = shade(hull, 0.6);
  ctx.lineWidth = Math.max(1, R * 0.05);
  ctx.beginPath();
  for (let i = -2; i <= 2; i++) {
    ctx.moveTo(-R * 0.84, i * R * 0.16);
    ctx.lineTo(-R * 0.54, i * R * 0.16);
  }
  ctx.stroke();
  ctx.fillStyle = "#3a3f4c"; // exhaust stubs poking past the tail
  rr(-R * 1.0, -R * 0.36, R * 0.14, R * 0.16, R * 0.05);
  rr(-R * 1.0, R * 0.2, R * 0.14, R * 0.16, R * 0.05);

  // Damage flash: the whole tank blinks RED right after taking a hit.
  const sinceHit = now - (t.lastHitAt ?? -9999);
  if (sinceHit < 170) {
    ctx.save();
    ctx.globalAlpha = 0.62 * (1 - sinceHit / 170);
    ctx.fillStyle = "#ff2d28";
    rr(-R * 0.98, -R * 0.86, R * 1.96, R * 1.72, R * 0.2); // treads too
    ctx.restore();
  }

  // Barrel sprite = barrel hitbox, drawn in the TURRET's frame so it
  // aims independently of the hull. We're already rotated by the hull
  // angle, so rotate the extra delta onto the turret heading.
  const wtype = t.weapon ?? "normal";
  const turret = t.turret ?? t.a;
  ctx.save();
  ctx.rotate(turret - t.a);
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
  ctx.restore();

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
  const now = performance.now();
  const seed = (t.x * 7 + t.y * 13) | 0;
  ctx.save();
  ctx.translate(t.x, t.y);

  // Scorch ring on the floor under everything.
  ctx.globalAlpha = 0.5;
  const sg = ctx.createRadialGradient(0, 0, TANK_R * 0.3, 0, 0, TANK_R * 1.5);
  sg.addColorStop(0, "rgba(10, 10, 12, 0.9)");
  sg.addColorStop(1, "rgba(10, 10, 12, 0)");
  ctx.fillStyle = sg;
  ctx.beginPath();
  ctx.arc(0, 0, TANK_R * 1.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;

  ctx.rotate(t.a);
  // Charred hull, slightly crumpled (notched corners).
  ctx.fillStyle = "#1d222b";
  rr(-TANK_R * 0.85, -TANK_R * 0.58, TANK_R * 1.7, TANK_R * 1.16, TANK_R * 0.16);
  ctx.fillStyle = "#232833";
  rr(-TANK_R * 0.7, -TANK_R * 0.44, TANK_R * 1.4, TANK_R * 0.88, TANK_R * 0.12);
  // Burst plating: dark gashes across the deck.
  ctx.strokeStyle = "#0e1116";
  ctx.lineWidth = TANK_R * 0.12;
  ctx.beginPath();
  ctx.moveTo(-TANK_R * 0.5, -TANK_R * 0.3);
  ctx.lineTo(TANK_R * 0.25, TANK_R * 0.15);
  ctx.moveTo(TANK_R * 0.4, -TANK_R * 0.35);
  ctx.lineTo(TANK_R * 0.1, TANK_R * 0.4);
  ctx.stroke();
  // The turret ring, blown loose — sits askew off-centre, hull-toned.
  ctx.save();
  ctx.translate(TANK_R * 0.28, -TANK_R * 0.2);
  ctx.rotate(0.7);
  ctx.fillStyle = shade(HULL[t.color], 0.75);
  ctx.beginPath();
  ctx.arc(0, 0, TANK_R * 0.34, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "#141821";
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.restore();
  // Glowing embers that breathe.
  const glow = 0.4 + 0.35 * Math.sin(now / 210 + seed);
  ctx.fillStyle = `rgba(255, 120, 40, ${0.35 + 0.3 * glow})`;
  ctx.beginPath();
  ctx.arc(-TANK_R * 0.32, TANK_R * 0.18, TANK_R * 0.1, 0, Math.PI * 2);
  ctx.arc(TANK_R * 0.1, -TANK_R * 0.28, TANK_R * 0.07, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // Continuous smoke: three staggered plumes rising and fading on a
  // loop (deterministic from time + position — no particle state).
  ctx.save();
  ctx.translate(t.x, t.y);
  for (let i = 0; i < 3; i++) {
    const period = 1400 + i * 260;
    const k = ((now + seed * 37 + i * 500) % period) / period; // 0→1
    const drift = Math.sin(seed + i * 2.1) * TANK_R * 0.5;
    const px = drift * k;
    const py = -TANK_R * (0.2 + k * 1.7);
    const rr2 = TANK_R * (0.22 + k * 0.5);
    ctx.globalAlpha = 0.34 * (1 - k);
    const g = ctx.createRadialGradient(px, py, 0, px, py, rr2);
    g.addColorStop(0, "rgba(28, 28, 34, 0.9)");
    g.addColorStop(1, "rgba(28, 28, 34, 0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(px, py, rr2, 0, Math.PI * 2);
    ctx.fill();
  }
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
