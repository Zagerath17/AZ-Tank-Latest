// ================================================================
// game.js — the battle arena.
//
// What's in: seeded random maze (no closed loops), tanks spawning
// in opposite corners facing the center, Tank-Trouble-style
// movement (turn left/right + forward/reverse), collision with
// maze walls and with other tanks.
// What's NOT in yet (on purpose): weapons, shooting, scoring.
//
// Two modes:
//   startLocalGame(colors)  — every tank driven from this keyboard
//   startOnlineGame(opts)   — you drive one tank, others stream in
// ================================================================

import { showScreen, toast, COLORS, COLOR_NAMES } from "./main.js";
import { getBinds } from "./settings.js";
import { mulberry32, generateMaze, wallRects } from "./maze.js";

/* ---------- tuning ---------- */

const CELL = 64;                    // world px per maze cell
const WALL_T = 8;                   // wall thickness
const TANK_R = CELL * 0.27;         // collision radius (circle)
const MOVE_SPEED = CELL * 2.1;      // forward speed, world px/s
const REVERSE_SPEED = CELL * 1.45;  // reverse is a bit slower
const TURN_SPEED = 3.2;             // rad/s
const NET_SEND_MS = 90;             // how often we publish our position online
const MAZE_SIZES = [[11, 8], [12, 9], [13, 9]]; // cols × rows, picked by seed

const HULL = { red: "#ff5147", green: "#46d160", blue: "#47a3ff", yellow: "#ffc531" };

/* ---------- module state ---------- */

let S = null; // active game, or null
let canvas, ctx, exitBtn, touchPad;
const held = new Set();      // held KeyboardEvent.codes
const touchHeld = new Set(); // held touch actions: up/down/left/right

/* ================================================================
   Public API
   ================================================================ */

export function initGame() {
  canvas = document.getElementById("arena");
  ctx = canvas.getContext("2d");
  exitBtn = document.getElementById("game-exit");
  touchPad = document.getElementById("touch-pad");

  exitBtn.addEventListener("click", () => {
    const s = S;
    stopGame();
    if (s?.mode === "online") s.onExit?.();
    else showScreen("screen-local");
  });

  // On-screen controls (phones). pointerdown/up per button = multi-touch OK.
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

export function startLocalGame(colors) {
  begin({
    mode: "local",
    seed: Math.floor(Math.random() * 2 ** 31),
    tanksSpec: colors.map((c) => ({ id: c, color: c, local: true })),
  });
}

// opts: { seed, myId, roster: [{id, color}], sendPos(pos), onExit() }
export function startOnlineGame(opts) {
  begin({
    mode: "online",
    seed: opts.seed,
    tanksSpec: opts.roster.map((p) => ({ id: p.id, color: p.color, local: p.id === opts.myId })),
    sendPos: opts.sendPos,
    onExit: opts.onExit,
  });
}

export function stopGame() {
  if (!S) return;
  cancelAnimationFrame(S.raf);
  window.removeEventListener("keydown", onKeydown);
  window.removeEventListener("keyup", onKeyup);
  window.removeEventListener("blur", clearHeld);
  touchPad.hidden = true;
  S = null;
}

export function isGameActive() {
  return !!S;
}

// Called by online.js on every lobby snapshot while a match runs.
export function onlinePlayersUpdate(players) {
  if (!S || S.mode !== "online") return;

  let meGone = true;
  for (const t of S.tanks) {
    const p = players?.[t.id];
    if (t.local) {
      if (p) meGone = false;
      continue;
    }
    if (!p) {
      if (!t.gone) { t.gone = true; toast(`${COLOR_NAMES[t.color]} left the battle.`); }
      continue;
    }
    t.gone = false;
    if (p.pos) { t.tx = p.pos.x; t.ty = p.pos.y; t.ta = p.pos.a; }
  }

  if (meGone) {
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

  const rng = mulberry32(opts.seed);
  const [cols, rows] = MAZE_SIZES[Math.floor(rng() * MAZE_SIZES.length)];
  const maze = generateMaze(cols, rows, rng);
  const rects = wallRects(maze, CELL, WALL_T);
  const worldW = cols * CELL;
  const worldH = rows * CELL;

  // Spawn corners: player 1 & 2 get OPPOSITE corners (TL vs BR),
  // players 3 & 4 fill the remaining opposite pair (TR vs BL).
  const corners = [
    [0, 0],
    [cols - 1, rows - 1],
    [cols - 1, 0],
    [0, rows - 1],
  ];

  const tanks = opts.tanksSpec.slice(0, 4).map((spec, i) => {
    const [c, r] = corners[i];
    const x = (c + 0.5) * CELL;
    const y = (r + 0.5) * CELL;
    const a = Math.atan2(worldH / 2 - y, worldW / 2 - x); // face the center
    return { ...spec, x, y, a, tx: x, ty: y, ta: a, gone: false };
  });

  S = {
    mode: opts.mode,
    sendPos: opts.sendPos,
    onExit: opts.onExit,
    maze, rects, worldW, worldH, tanks,
    lastT: performance.now(),
    lastSend: 0,
    raf: 0,
  };

  held.clear();
  touchHeld.clear();
  window.addEventListener("keydown", onKeydown);
  window.addEventListener("keyup", onKeyup);
  window.addEventListener("blur", clearHeld);

  // Show touch controls on touch devices when exactly one tank is
  // driven from this device (i.e. online play on a phone).
  const isTouch = navigator.maxTouchPoints > 0 || "ontouchstart" in window;
  const localCount = tanks.filter((t) => t.local).length;
  touchPad.hidden = !(isTouch && localCount === 1);

  showScreen("screen-game");
  S.raf = requestAnimationFrame(frame);
}

/* ================================================================
   Input
   ================================================================ */

function onKeydown(e) {
  if (isBoundCode(e.code)) e.preventDefault(); // stop Space/arrows scrolling the page
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
  const acts = { up: false, down: false, left: false, right: false };

  // Local mode: a tank answers strictly to its own color's binds.
  // Online: you only drive one tank, so it answers to ANY color's
  // binds (WASD and arrows both work out of the box).
  const sources = S.mode === "online" ? COLORS : [tank.color];
  for (const c of sources) {
    for (const a of ["up", "down", "left", "right"]) {
      const code = binds[c][a];
      if (code && held.has(code)) acts[a] = true;
    }
  }

  for (const a of touchHeld) acts[a] = true; // empty unless the pad is shown
  return acts;
}

/* ================================================================
   Simulation
   ================================================================ */

function frame(now) {
  if (!S) return;
  const dt = Math.min((now - S.lastT) / 1000, 0.05);
  S.lastT = now;

  const binds = getBinds();

  for (const t of S.tanks) {
    if (t.gone) continue;

    if (t.local) {
      const acts = readActions(t, binds);
      if (acts.left) t.a -= TURN_SPEED * dt;
      if (acts.right) t.a += TURN_SPEED * dt;
      let v = 0;
      if (acts.up) v += MOVE_SPEED;
      if (acts.down) v -= REVERSE_SPEED;
      t.x += Math.cos(t.a) * v * dt;
      t.y += Math.sin(t.a) * v * dt;
    } else {
      // Remote tank: glide toward its last reported transform.
      const k = 1 - Math.exp(-12 * dt);
      t.x += (t.tx - t.x) * k;
      t.y += (t.ty - t.y) * k;
      t.a += angleDiff(t.a, t.ta) * k;
    }
  }

  resolveCollisions();

  if (S.mode === "online" && now - S.lastSend > NET_SEND_MS) {
    S.lastSend = now;
    const me = S.tanks.find((t) => t.local);
    if (me) {
      S.sendPos?.({ x: +me.x.toFixed(1), y: +me.y.toFixed(1), a: +me.a.toFixed(3) });
    }
  }

  draw();
  S.raf = requestAnimationFrame(frame);
}

function resolveCollisions() {
  const tanks = S.tanks.filter((t) => !t.gone);

  // Two passes so corner cases (wall + tank at once) settle cleanly.
  for (let pass = 0; pass < 2; pass++) {
    // Tank ↔ wall. Only local tanks are simulated here; remote tanks
    // already resolved collisions on their own device.
    for (const t of tanks) {
      if (!t.local) continue;
      for (const rect of S.rects) pushOutOfRect(t, rect);
      t.x = clamp(t.x, TANK_R, S.worldW - TANK_R); // safety net at the border
      t.y = clamp(t.y, TANK_R, S.worldH - TANK_R);
    }

    // Tank ↔ tank.
    for (let i = 0; i < tanks.length; i++) {
      for (let j = i + 1; j < tanks.length; j++) {
        separate(tanks[i], tanks[j]);
      }
    }
  }
}

// Circle-vs-rectangle push-out.
function pushOutOfRect(t, rect) {
  const cx = clamp(t.x, rect.x, rect.x + rect.w);
  const cy = clamp(t.y, rect.y, rect.y + rect.h);
  const dx = t.x - cx;
  const dy = t.y - cy;
  const d2 = dx * dx + dy * dy;
  if (d2 >= TANK_R * TANK_R) return;

  if (d2 > 1e-9) {
    const d = Math.sqrt(d2);
    const push = (TANK_R - d) / d;
    t.x += dx * push;
    t.y += dy * push;
  } else {
    // Center ended up inside the wall — escape along the thinnest side.
    const left = t.x - rect.x;
    const right = rect.x + rect.w - t.x;
    const up = t.y - rect.y;
    const down = rect.y + rect.h - t.y;
    const m = Math.min(left, right, up, down);
    if (m === left) t.x = rect.x - TANK_R;
    else if (m === right) t.x = rect.x + rect.w + TANK_R;
    else if (m === up) t.y = rect.y - TANK_R;
    else t.y = rect.y + rect.h + TANK_R;
  }
}

// Circle-vs-circle: tanks can't drive through each other.
function separate(a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const d2 = dx * dx + dy * dy;
  const min = TANK_R * 2;
  if (d2 >= min * min) return;

  if (d2 < 1e-9) {
    // Perfectly stacked (shouldn't happen) — nudge a local one aside.
    if (a.local) a.x -= min / 2;
    else if (b.local) b.x += min / 2;
    return;
  }

  const d = Math.sqrt(d2);
  const overlap = min - d;
  const nx = dx / d;
  const ny = dy / d;

  if (a.local && b.local) {
    a.x -= (nx * overlap) / 2; a.y -= (ny * overlap) / 2;
    b.x += (nx * overlap) / 2; b.y += (ny * overlap) / 2;
  } else if (a.local) {
    a.x -= nx * overlap; a.y -= ny * overlap;
  } else if (b.local) {
    b.x += nx * overlap; b.y += ny * overlap;
  }
}

/* ================================================================
   Rendering
   ================================================================ */

function draw() {
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

  // Fit the whole maze in view, centered.
  const pad = 8;
  const s = Math.min((cw - pad * 2) / S.worldW, (ch - pad * 2) / S.worldH);
  ctx.save();
  ctx.translate((cw - S.worldW * s) / 2, (ch - S.worldH * s) / 2);
  ctx.scale(s, s);

  // Floor.
  ctx.fillStyle = "#151922";
  ctx.fillRect(0, 0, S.worldW, S.worldH);

  // Walls.
  ctx.fillStyle = "#b9c3d2";
  for (const r of S.rects) ctx.fillRect(r.x, r.y, r.w, r.h);

  // Tanks.
  for (const t of S.tanks) {
    if (!t.gone) drawTank(t);
  }

  ctx.restore();
}

function drawTank(t) {
  const hull = HULL[t.color];
  const R = TANK_R;

  ctx.save();
  ctx.translate(t.x, t.y);
  ctx.rotate(t.a); // angle 0 = facing +x

  // Treads.
  ctx.fillStyle = "#2a303c";
  rr(-R * 0.95, -R * 0.83, R * 1.9, R * 0.42, R * 0.15);
  rr(-R * 0.95, R * 0.41, R * 1.9, R * 0.42, R * 0.15);

  // Hull.
  ctx.fillStyle = hull;
  rr(-R * 0.9, -R * 0.58, R * 1.8, R * 1.16, R * 0.24);

  // Barrel — part of the tank's silhouette; firing comes later.
  ctx.fillStyle = shade(hull, 0.35);
  rr(0, -R * 0.14, R * 1.5, R * 0.28, R * 0.1);

  // Turret.
  ctx.fillStyle = shade(hull, 0.42);
  ctx.beginPath();
  ctx.arc(0, 0, R * 0.5, 0, Math.PI * 2);
  ctx.fill();

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

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

// Shortest signed angle from `from` to `to`.
function angleDiff(from, to) {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

// Mix a hex color toward the dark floor tone by factor f (0..1).
function shade(hex, f) {
  const n = parseInt(hex.slice(1), 16);
  const mix = (x, target) => Math.round(x + (target - x) * f);
  const r = mix((n >> 16) & 255, 16);
  const g = mix((n >> 8) & 255, 19);
  const b = mix(n & 255, 26);
  return `rgb(${r}, ${g}, ${b})`;
}
