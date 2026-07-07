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

import { showScreen, toast, COLORS, COLOR_NAMES } from "./main.js";
import { getBinds } from "./settings.js";
import { mulberry32, generateMaze, wallRects, segmentFirstHit } from "./maze.js";
import { botActions, AI_PARAMS } from "./ai.js";

/* ---------- tuning ---------- */

const CELL = 64;
const WALL_T = 8;
const TANK_R = CELL * 0.27;          // base scale for the tank's size
const TANK_HL = TANK_R * 0.95;       // hitbox half-LENGTH (along the barrel) — matches the drawn treads
const TANK_HW = TANK_R * 0.83;       // hitbox half-WIDTH — matches the drawn treads
const TANK_RAD = Math.hypot(TANK_HL, TANK_HW); // bounding radius (broadphase / AI planning)
const MOVE_SPEED = CELL * 2.1;
const REVERSE_SPEED = CELL * 1.45;
const TURN_SPEED = 3.2;

const BULLET_SPEED = CELL * 3.2;
const BULLET_R = CELL * 0.085;
const BULLET_LIFE = 6000;   // ms a bullet keeps bouncing
const MAX_BULLETS = 5;      // live bullets per tank (Tank Trouble classic)

const ROUND_PAUSE = 2600;   // ms between rounds
const NET_SEND_MS = 90;
const MAZE_SIZES = [[11, 8], [12, 9], [13, 9]];

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
    onExit: o.onExit,
  };
}

export function stopGame() {
  if (!S) return;
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

    if (!t.local) {
      if (p.pos) { t.tx = p.pos.x; t.ty = p.pos.y; t.ta = p.pos.a; }
      if (p.shots) {
        const seen = (S.seenShots[t.id] ??= new Set());
        for (const [key, sh] of Object.entries(p.shots)) {
          if (seen.has(key)) continue;
          seen.add(key);
          spawnBullet(t.id, sh.x, sh.y, sh.a);
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
    onExit: opts.onExit,
    roundN: opts.roundN ?? 1,
    tanks: [],
    bullets: [],
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

  if (!S.banner) {
    stepTanks(now, dt);
    stepBullets(now, dt);
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

  draw(now);
  S.raf = requestAnimationFrame(frame);
}

function stepTanks(now, dt) {
  const binds = getBinds();

  for (const t of S.tanks) {
    if (t.dead || t.gone) continue;

    if (t.local) {
      const acts = t.bot
        ? botActions(t, { cell: CELL, maze: S.maze, rects: S.rects, tanks: S.tanks, tankR: TANK_RAD }, dt, now)
        : readActions(t, binds);
      const mul = t.bot ? AI_PARAMS[t.bot] : NO_MUL;

      // Rotation uses the real rectangular hitbox: if the swing would
      // clip a wall, the turn is blocked until the tank backs off.
      const turn = (acts.right ? 1 : 0) - (acts.left ? 1 : 0);
      if (turn !== 0) {
        const na = t.a + turn * TURN_SPEED * mul.turn * dt;
        if (!obbHitsAnyWall(t.x, t.y, na)) t.a = na;
      }

      let v = 0;
      if (acts.up) v += MOVE_SPEED * mul.speed;
      if (acts.down) v -= REVERSE_SPEED * mul.speed;

      if (v !== 0) {
        // WALL FRICTION, Tank-Trouble style: if the move would touch
        // a wall — even at a shallow angle — the tank hard-stops.
        // No sliding along walls. Turn away first, then drive.
        const nx = t.x + Math.cos(t.a) * v * dt;
        const ny = t.y + Math.sin(t.a) * v * dt;
        if (!obbHitsAnyWall(nx, ny, t.a)) {
          t.x = nx;
          t.y = ny;
        }
      }

      if (acts.shoot && !t.prevShoot) tryFire(t, now);
      t.prevShoot = acts.shoot;
    } else {
      // Remote tank: glide toward its last reported transform.
      const k = 1 - Math.exp(-12 * dt);
      t.x += (t.tx - t.x) * k;
      t.y += (t.ty - t.y) * k;
      t.a += angleDiff(t.a, t.ta) * k;
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

function tryFire(t, now) {
  let live = 0;
  for (const b of S.bullets) if (b.by === t.id) live++;
  if (live >= MAX_BULLETS) return;

  // Muzzle at the barrel tip — pulled back if the barrel is poking
  // through a wall, so bullets can never spawn on the far side.
  const tipX = t.x + Math.cos(t.a) * TANK_R * 1.55;
  const tipY = t.y + Math.sin(t.a) * TANK_R * 1.55;
  const hit = segmentFirstHit(t.x, t.y, tipX, tipY, S.rects);
  const k = Math.min(1, Math.max(0.2, hit * 0.9));
  const x = t.x + (tipX - t.x) * k;
  const y = t.y + (tipY - t.y) * k;

  spawnBullet(t.id, x, y, t.a, now);

  if (S.mode === "online") {
    const key = now.toString(36) + Math.random().toString(36).slice(2, 6);
    (S.seenShots[t.id] ??= new Set()).add(key);
    S.sendShot?.(t.id, key, { x: +x.toFixed(1), y: +y.toFixed(1), a: +t.a.toFixed(3) });
  }
}

function spawnBullet(byId, x, y, a, now = performance.now()) {
  S.bullets.push({
    x, y,
    vx: Math.cos(a) * BULLET_SPEED,
    vy: Math.sin(a) * BULLET_SPEED,
    born: now,
    by: byId,
  });
}

function stepBullets(now, dt) {
  const survivors = [];

  for (const b of S.bullets) {
    if (now - b.born > BULLET_LIFE) continue;

    // Substeps so fast bullets can't tunnel through thin walls.
    const travel = BULLET_SPEED * dt;
    const steps = Math.max(1, Math.ceil(travel / 5));
    let alive = true;

    for (let s = 0; s < steps && alive; s++) {
      b.x += (b.vx * dt) / steps;
      b.y += (b.vy * dt) / steps;
      bounce(b);

      for (const t of S.tanks) {
        if (t.dead || t.gone) continue;
        if (bulletHitsTank(b, t)) {
          alive = false;
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

// Reflect off walls. Axis of reflection = the shallower penetration;
// only flip velocity if the bullet is actually heading into the wall
// (overlapping joint rects would otherwise flip it right back).
function bounce(b) {
  for (const rc of S.rects) {
    const cx = rc.x + rc.w / 2;
    const cy = rc.y + rc.h / 2;
    const ox = rc.w / 2 + BULLET_R - Math.abs(b.x - cx);
    if (ox <= 0) continue;
    const oy = rc.h / 2 + BULLET_R - Math.abs(b.y - cy);
    if (oy <= 0) continue;

    if (ox < oy) {
      const dir = b.x < cx ? -1 : 1;
      b.x += dir * ox;
      if ((dir < 0 && b.vx > 0) || (dir > 0 && b.vx < 0)) b.vx = -b.vx;
    } else {
      const dir = b.y < cy ? -1 : 1;
      b.y += dir * oy;
      if ((dir < 0 && b.vy > 0) || (dir > 0 && b.vy < 0)) b.vy = -b.vy;
    }
  }
}

function killTank(t) {
  if (t.dead) return;
  t.dead = true;
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
  } else {
    S.banner = { text: "DRAW", color: "#eef1f6" };
  }
  S.roundOverAt = now;
  updateScoreHUD();
}

function updateScoreHUD() {
  if (!scoreEl || !S) return;
  scoreEl.innerHTML = S.roster
    .map((p) => `<span class="sc p-${p.color}">${S.scores[p.color] ?? 0}</span>`)
    .join("");
}

/* ---------- collision helpers (rectangular hitboxes) ---------- */

// The tank's hitbox is an oriented rectangle (TANK_HL × TANK_HW,
// rotated to t.a) matching the drawn treads — SAT does the rest.

function obbAxes(a) {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [[c, s], [-s, c]]; // [along-barrel, across]
}

// Projection radius of the tank's rectangle onto a unit axis.
function obbProjR(a, ax, ay) {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return Math.abs(c * ax + s * ay) * TANK_HL + Math.abs(-s * ax + c * ay) * TANK_HW;
}

// Broadphase: is the wall rect even near the tank's bounding circle?
function nearRect(x, y, rc, r) {
  const cx = clamp(x, rc.x, rc.x + rc.w);
  const cy = clamp(y, rc.y, rc.y + rc.h);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy < r * r;
}

// SAT: oriented tank rectangle vs axis-aligned wall rect (boolean).
function obbHitsRect(x, y, a, rc) {
  const rcx = rc.x + rc.w / 2;
  const rcy = rc.y + rc.h / 2;
  const axes = [[1, 0], [0, 1], ...obbAxes(a)];
  for (const [ax, ay] of axes) {
    const tC = x * ax + y * ay;
    const tR = obbProjR(a, ax, ay);
    const rC = rcx * ax + rcy * ay;
    const rR = Math.abs(ax) * (rc.w / 2) + Math.abs(ay) * (rc.h / 2);
    if (Math.abs(tC - rC) >= tR + rR) return false; // separating axis found
  }
  return true;
}

function obbHitsAnyWall(x, y, a) {
  for (const rc of S.rects) {
    if (!nearRect(x, y, rc, TANK_RAD)) continue;
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

// Exact bullet (circle) vs tank (oriented rectangle) test: transform
// the bullet into the tank's local frame and clamp to the rectangle.
function bulletHitsTank(b, t) {
  const dx = b.x - t.x;
  const dy = b.y - t.y;
  const c = Math.cos(t.a);
  const s = Math.sin(t.a);
  const lx = dx * c + dy * s;   // along the barrel
  const ly = -dx * s + dy * c;  // across
  const px = clamp(lx, -TANK_HL, TANK_HL);
  const py = clamp(ly, -TANK_HW, TANK_HW);
  const ox = lx - px;
  const oy = ly - py;
  return ox * ox + oy * oy < BULLET_R * BULLET_R;
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

  // Wrecks under everything, live tanks above, bullets on top.
  for (const t of S.tanks) if (t.dead && !t.gone) drawWreck(t);
  for (const t of S.tanks) if (!t.dead && !t.gone) drawTank(t);

  ctx.fillStyle = "#20242c";
  for (const b of S.bullets) {
    ctx.beginPath();
    ctx.arc(b.x, b.y, BULLET_R, 0, Math.PI * 2);
    ctx.fill();
  }

  if (S.banner) drawBanner();

  ctx.restore();
}

function drawTank(t) {
  const hull = HULL[t.color];
  const R = TANK_R;

  ctx.save();
  ctx.translate(t.x, t.y);
  ctx.rotate(t.a);

  ctx.fillStyle = "#2a303c";
  rr(-R * 0.95, -R * 0.83, R * 1.9, R * 0.42, R * 0.15);
  rr(-R * 0.95, R * 0.41, R * 1.9, R * 0.42, R * 0.15);

  ctx.fillStyle = hull;
  rr(-R * 0.9, -R * 0.58, R * 1.8, R * 1.16, R * 0.24);

  ctx.fillStyle = shade(hull, 0.35);
  rr(0, -R * 0.31, R * 1.5, R * 0.62, R * 0.18); // barrel — as thick as the shots it fires

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
