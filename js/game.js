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

import { showScreen, toast, tankSVG, setInMatch, paintVar } from "./main.js";
import { tankSpriteCanvas } from "./tanksprite.js";
import { COLOR_NAMES, PALETTE } from "./palette.js";
import { skinFinish } from "./skins.js";
import { materialFill, paintMaterial, isMaterial } from "./material.js";
import { getBinds } from "./settings.js";
import { mulberry32, generateMaze, wallRects, segmentFirstHit, MAZE_SHAPES, ringDistance, boundaryWalls, shapePolygon, snapSpawn } from "./maze.js";
import { botActions, AI_PARAMS } from "./ai.js";
import {
  WEAPON_TYPES, BARRELS, LASER, MG, ROCKET, CANNON, SNIPER, BOOST, PHASE, WALL,
  ARMOUR, HEAL, MUD, MORTAR, FLAME, mortarFlightMs, mortarDistAt,
  laserPath, castRay, castRaySlab, rocketSeekStep, stepShrap, bounceCircle, bounceSlab, drawBarrel, drawGear,
  WEAPON_CATEGORY, WEAPON_LABEL, GEAR_RIM,
} from "./weapons.js";
import { SUN, SUN_DIR, SHADOW, buildScene, drawGround, drawWallLayer } from "./scene.js";
import { prebakeCount, prebakeStep } from "./material.js";
import { statsFrom, NO_STATS } from "./upgrades.js";
import { sfx, setEngine, setFlame, startMusic, stopAll } from "./audio.js";

/* ---------- tuning ---------- */

const CELL = 96;                     // corridor spacing — walls are much more spread out
const WALL_T = 10;
const RENDER_W = 2560, RENDER_H = 1440;   // internal render resolution
const ACCEL_TIME = 0.5;   // s from a standstill to full speed
const BRAKE_TIME = 0.2;   // s from full speed back to a stop
const SPIN_UP = 0.28;     // s for the hull to reach full turn rate
const SPIN_DOWN = 0.16;   // s for it to stop turning
const U = 64;                        // tank & ballistics scale (unchanged — tanks stay the same size)
const TANK_R = U * 0.27;             // base scale for the tank's size
const TANK_HL = TANK_R * 0.95;       // hitbox half-LENGTH (along the barrel) — matches the drawn treads
const TANK_HW = TANK_R * 0.83;       // hitbox half-WIDTH — matches the drawn treads
const TANK_RAD = Math.hypot(TANK_HL, TANK_HW); // bounding radius (broadphase / AI planning)

// Tread marks pressed into the floor. The geometry deliberately mirrors
// the treads drawn on the tank itself (bands at ±R*0.62, R*0.42 across,
// links every R*0.34), so what a tank leaves behind lines up with the
// tracks on its own hull.
const TRACK_LIFE = 3000;                 // ms a mark lasts before it's gone
const TRACK_STEP = TANK_R * 0.34;        // stamp spacing = the tank's tread-link pitch
const TRACK_MAX = 1400;                  // hard cap, oldest dropped first (a full
                                         // 8-tank lobby driving flat out for the
                                         // whole 3 s fits inside this)
const TRACK_HALF = TANK_R * 0.62;        // tread centre, either side of the hull
const TRACK_WIDTH = TANK_R * 0.42;       // how wide a tread sits on the ground
const TRACK_CLEAT = TANK_R * 0.21;       // half a cleat bar, across the tread
const MOVE_SPEED = U * 1.89;      // 10% slower
const REVERSE_SPEED = U * 1.305;  // 10% slower, in step with forward
const TURN_SPEED = 3.2 * 1.05; // tanks turn 5% quicker
const TURRET_TURN_SPEED = TURN_SPEED * 1.2 * 0.9; // 1.2× hull, then a 10% turret debuff

// ---- Flamethrower (held-fire) tunables ----
// The flame is a HOLD weapon now: fuel drains only while the trigger is
// down and the barrel reverts when it runs dry, exactly like the MG
// empties its belt. FLAME.durationMs (from weapons.js) is the fuel pool
// — total seconds of fire per pickup.
const FLAME_GROW_MS = 180;     // stream extends over this on trigger-down
const FLAME_FADE_MS = 160;     // ...and pulls back in over this on release
const FLAME_NET_MS = 120;      // online: resend a "still firing" pulse this often
const FLAME_NET_TTL = 360;     // ...and a peer's stream stays lit this long per pulse

const GEAR_R = 14;             // pickup grab radius (added to the tank's)
const GEAR_TYPE_MAX = 2;       // default depth: this many of each ability
const GEAR_MAX = WEAPON_TYPES.length * GEAR_TYPE_MAX; // default field cap (24)
export const GEAR_CAP_LIMIT = 30; // the highest a host can set the cap
const GEAR_FIRST_MS = 2500;    // first pickup after round start
const GEAR_EVERY_MS = 3930;    // then every 3.9–6.4 s (40% faster than 5.5–9)
const GEAR_EVERY_JITTER = 2500;
const GEAR_SPREAD_MIN = CELL * 2.2; // crates keep this far apart when they can

// ---- Closing zone ----
const ZONE_FIRST_MS = 30000;   // first layer claimed 30 s in (1v1)
const ZONE_PERIOD = 30000;     // a new layer every 30 s thereafter (1v1)
const ZONE_WARN_MS = 5000;     // a layer blinks this long before it turns red
export const ZONE_MIN_PERIOD = 10000; // custom-lobby clamp: fastest zone
export const ZONE_MAX_PERIOD = 60000; // custom-lobby clamp: slowest zone
const ZONE_DMG_PERIOD = 2000;  // red cells deal 1 dmg every 2 s
const ZONE_DMG = 1;            // damage per tick
const ZONE_INSIDE_FRAC = 0.30; // a tank must be >30% into a red cell to be hit

const BULLET_SPEED = U * 2.88;    // 10% slower. Every other round —
                                  // MG, sniper, homing missile and the
                                  // big cannon — is a multiple of this,
                                  // so they all come down 10% with it.
                                  // The mortar sets its own speed in
                                  // cells/sec and is deliberately left.
const BULLET_R = U * 0.085;
const BULLET_LIFE = 6000;   // ms a bullet keeps bouncing

// ---- Health & damage ----
// Every tank starts with 6 HP. Weapons chip it down; at 0 the tank is
// destroyed. (Environmental deaths — the ring, the collapse — always
// kill outright regardless of HP.)
const TANK_HP = 10;
const DMG = {
  basic: 3,       // basic cannon ball
  mg: 1,          // machine-gun ball
  cannonBall: 5,  // the big cannon's direct ball hit
  shrapnel: 2,    // each fractal from the cannon
  rocket: 7,      // homing rocket
  laserBase: 7,   // laser at zero bounces; −1 per bounce, min 1
  sniper: 7,      // sniper slug
};

// The basic gun is a 3-round magazine: consecutive shots come 0.5 s
// apart, and each spent round takes 3.5 s to regenerate.
const MAG_SIZE = 3;
const MAG_GAP = 500;        // ms between consecutive shots
const MAG_REGEN = 3500;     // ms for one spent round to come back

function magAvailable(t, now) {
  t.basicMag = (t.basicMag ?? []).filter((ts) => now - ts < MAG_REGEN);
  return magCapOf(t) - t.basicMag.length;
}

// A special projectile still flying blocks the basic trigger — no
// rocket-then-instantly-bullet exploits.
function specialInPlay(t) {
  return S.rockets.some((r) => r.by === t.id)
    || S.cannons.some((c) => c.by === t.id)
    || S.beams.some((bm) => bm.by === t.id && !bm.doneAt)
    || (t.weapon === "flame" && t.flameOn);
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
const NET_EXTRAP_MS = 160;     // max dead-reckoning past the buffer
const NET_BUF_MAX = 24;        // ~1.8 s of history
const NET_SNAP_DIST = CELL * 2.5;   // beyond this, catch up aggressively
const NET_TELEPORT_DIST = CELL * 6; // only THIS is a real discontinuity
// Never replay more than this much wire time into a projectile: past it
// the packet is so old that guessing is worse than just showing it.
const NET_CATCHUP_MAX = 450;
// Hard ceiling on tanks in one match. Custom lobbies fill up to this;
// offline and 1v1 use fewer. Must match online.js's MAX_PLAYERS.
export const MAX_TANKS = 8;
const NET_CATCHUP_SPEED = 6;        // × MOVE_SPEED while closing a big gap
const NET_CORRECT_SPEED = 2.2;      // × MOVE_SPEED correction cap
// Arenas grouped by grid size. A matchmade 1v1 draws from small+medium;
// casual/offline use the whole range.
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
let canvas, ctx, exitBtn, touchPad, scoreEl, shrinkEl, loadoutHudEl, healthHudEl, armourHudEl, multiKillEl;
let p2HudEl, p2HealthEl, p2LoadEl;
const held = new Set();
// Turret aiming: the mouse position in WORLD coordinates, whether the
// player has aimed at all yet (so we can fall back to hull-facing on
// touch / before first move), and whether the fire button (LMB) is down.
// True on phones/tablets: mouse events here are SYNTHESISED from taps,
// so we ignore them for aiming — the mobile turret stays locked forward.
const IS_TOUCH_DEVICE = (typeof navigator !== "undefined" && navigator.maxTouchPoints > 0)
  || (typeof window !== "undefined" && "ontouchstart" in window);
// Mobile: left stick drives the hull directionally (moveVec, components
// in [-1,1] — the hull turns to face the stick and drives that way),
// right stick aims the turret (touchAim = world angle, held after
// release once engaged), and three buttons trigger the categories.
let moveVec = { x: 0, y: 0 };
let moveVecActive = false; // is the move stick currently deflected?
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
  p2HudEl = document.getElementById("p2-hud");
  p2HealthEl = document.getElementById("p2-health");
  p2LoadEl = document.getElementById("p2-load");
  armourHudEl = document.getElementById("armour-hud");
  multiKillEl = document.getElementById("multikill");
  touchPad = document.getElementById("touch-pad");
  scoreEl = document.getElementById("game-score");

  exitBtn.addEventListener("click", () => {
    const s = S;
    if (s?.mode === "online") {
      // The exit callback (leaveLobby / endMatchForAll) stops the game
      // itself — calling stopGame first would wipe the match state the
      // abandon-a-1v1 handling needs to read.
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
  if (moveStick) {
    setupStick(moveStick,
      (dx, dy) => { moveVec.x = dx; moveVec.y = dy; moveVecActive = Math.hypot(dx, dy) > 0.001; },
      () => { moveVec.x = 0; moveVec.y = 0; moveVecActive = false; });
  }

  // On touch, the three LOADOUT INDICATORS double as the fire buttons —
  // tapping the offense/defense/agility slot triggers that category.
  // (Separate fire buttons were redundant.) The same press-and-hold
  // model as before: hold to keep firing (e.g. the MG), release to stop.
  loadoutHudEl?.querySelectorAll(".loadout-slot").forEach((slot) => {
    const which = slot.dataset.fire; // off | def | agi
    const set = (v) => {
      if (which === "off") touchFire = v;
      else if (which === "def") touchDef = v;
      else touchAgi = v;
      slot.classList.toggle("held", v);
    };
    slot.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "mouse") return; // desktop fires with the mouse
      e.preventDefault(); slot.setPointerCapture(e.pointerId); set(true);
    });
    const off = () => set(false);
    slot.addEventListener("pointerup", off);
    slot.addEventListener("pointercancel", off);
    slot.addEventListener("contextmenu", (e) => e.preventDefault());
  });

  // NO MOUSE INPUT. The turret is welded to the hull, so there is
  // nothing to aim with a pointer — you turn the whole tank to aim.
  // Firing is on the keyboard (offense/defense/agility binds) or, on
  // touch, the three loadout buttons. We still swallow the arena's
  // context menu so a stray right-click doesn't pop one mid-match.
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());
}

// specs: [{ color, bot: null | 'easy' | 'medium' | 'hard' }]
// opts (all optional): { sizePool, gearPool, gearMax, zone, zonePeriod }
// — the same match rules a custom lobby host can set.
export function startLocalGame(specs, opts = {}) {
  begin({
    mode: "local",
    seed: randomSeed(),
    roundN: 1,
    sizePool: opts.sizePool ?? null,
    gearPool: opts.gearPool ?? null,
    gearMax: opts.gearMax ?? null,
    zone: opts.zone ?? false,
    zonePeriod: opts.zonePeriod ?? 30,
    roster: specs.map((s) => ({
      id: s.slot ?? s.color,
      slot: s.slot ?? s.color,
      color: s.color,
      pattern: s.pattern ?? "solid",
      patColors: s.patColors ?? [],
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
    // Shooter-authoritative damage. Without this forwarded, S.sendHit is
    // undefined, sendHitTo() bails on every hit, and NOBODY ever takes
    // damage online — the shots land visually and nothing happens.
    sendHit: o.sendHit,
    sendDead: o.sendDead,
    sendNextRound: o.sendNextRound,
    sendGear: o.sendGear,
    sendGearRemove: o.sendGearRemove,
    sendPickup: o.sendPickup,
    sendGun: o.sendGun,
    onExit: o.onExit,
    duel: o.duel,
    upgradesOn: o.upgradesOn,
    winTarget: o.winTarget,
    serverNow: o.serverNow,
    gearPool: o.gearPool,
    gearMax: o.gearMax,
    sizePool: o.sizePool,
    zone: o.zone,
    zonePeriod: o.zonePeriod,
    teams: o.teams,
    onDuelEnd: o.onDuelEnd,
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
  touchPad.parentElement?.classList.remove("has-touch");
  if (scoreEl) scoreEl.innerHTML = "";
  if (loadoutHudEl) loadoutHudEl.hidden = true;
  if (multiKillEl) { multiKillEl.hidden = true; multiKillEl._sig = undefined; }
  if (armourHudEl) armourHudEl.hidden = true;
  if (healthHudEl) { healthHudEl.hidden = true; healthHudEl._hp = undefined; }
  if (p2HudEl) { p2HudEl.hidden = true; p2HudEl._sig = undefined; }
  S = null;
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
        if (!t.bot) toast(`${t.name ?? COLOR_NAMES[t.color]} left the battle.`);
      }
      continue;
    }
    t.gone = false;

    if (p.dead && !t.dead) {
      // A round REBUILDS every tank alive (dead:false). The per-player
      // `dead` flag lives on the lobby node, and the controller clears it
      // when it pushes the new round — but that clear and the round bump
      // can reach us in EITHER order, and a snapshot from the instant
      // before the clear still says dead:true. Applying it would kill the
      // freshly spawned tank the moment the round starts and hand the
      // other player an instant win (with the real reset only landing the
      // round after). So only honour a `dead` flag that was raised DURING
      // the current round — anything stamped before this round began is a
      // leftover from the last one and is ignored.
      const stamp = typeof p.deadAt === "number" ? p.deadAt : null;
      let stale;
      if (stamp != null) {
        // Timestamped: stale iff it predates this round.
        stale = stamp < (S.roundStartedAt ?? 0);
      } else {
        // No timestamp (an older client, or a flag that lost its stamp):
        // treat a `dead` seen in the first moment of the round as a
        // leftover, since a genuine kill can't happen that fast. After
        // the opening grace window, honour it.
        const sinceStart = (S.netClock ? S.netClock() : Date.now()) - (S.roundStartedAt ?? 0);
        stale = sinceStart < 1500;
      }
      if (!stale) {
        t.dead = true;
        // The victim names its killer. If that's me, this is my kill —
        // the only way my client learns about it, since damage is
        // resolved on the victim's machine.
        if (p.deadBy && S.myId && p.deadBy === S.myId) {
          registerKill(S.myId, performance.now());
        }
      }
    }

    // Equipped weapon (drives the barrel sprite AND hitbox everywhere).
    const gun = p.gun ?? null;
    if (!t.local) {
      t.weapon = gun;
      if (gun === "sniper" && t.snAmmo == null) t.snAmmo = SNIPER.shots;
    } else if (gun && gun !== t.weapon && nowMs - t.gunClearedAt > 1500) {
      t.weapon = gun;
      if (gun === "sniper") t.snAmmo = SNIPER.shots;
      // A newly picked-up agility item comes with its full charges.
      t.agiLeft = 1 + Math.round(t.up?.phaseUses ?? 0);
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
          // A shot from a round that's already over must not spawn now.
          if (sh && sh.r != null && sh.r !== S.roundN) continue;
          // How stale is this packet? Fast-forward the projectile by
          // that much so it appears where the shooter's already is,
          // rather than a latency behind it.
          let age = 0;
          if (typeof sh?.t === "number" && S.netClock) {
            age = Math.max(0, Math.min(NET_CATCHUP_MAX, S.netClock() - sh.t));
          }
          spawnShot(t.id, sh, performance.now(), age);
        }
      }
    }

    // Inbound authoritative damage, applied ONLY to my own tank — I own
    // my health. Deduped by key so a re-delivered snapshot can't
    // double-count.
    //
    // Two sources, because the transport changed:
    //  1. outHits — the CURRENT scheme. Each shooter publishes hits in
    //     its OWN node tagged with `to`. Own-node writes are always
    //     permitted, so this survives tightened security rules.
    //  2. hits — the LEGACY inbox a shooter wrote directly into the
    //     victim's node. Kept so a client on the old build can still
    //     damage us.
    // This block must sit OUTSIDE the `!t.local` branch above: it was
    // once nested inside it, making the test `!t.local && t.local` —
    // impossible — so no online hit ever landed.
    if (p.outHits) {
      const seenH = (S.seenHits ??= {});
      const seen = (seenH[t.id] ??= new Set());
      for (const [key, h] of Object.entries(p.outHits)) {
        if (seen.has(key)) continue;
        // `t` is the SHOOTER here; h.to names the victim.
        const victim = S.tanks.find((x) => x.id === h.to && x.local);
        if (!victim) continue; // addressed to someone else's machine
        seen.add(key);
        // Damage from a round that's already finished must never land on
        // this round's freshly spawned tank.
        if (h.r != null && h.r !== S.roundN) continue;
        if (!victim.dead && !victim.gone) {
          const hnow = performance.now();
          victim.lastHitAt = hnow;
          damageTank(victim, h.d ?? 1, h.by ?? t.id);
          // End the round on us if it's already in flight nearby;
          // otherwise arm the absorber for one that's still coming.
          if (!reconcileShot(victim, h.by ?? t.id, hnow)) {
            absorbShot(victim, h.by ?? t.id);
          }
        }
      }
    }
    if (p.hits && t.local) {
      const seenH = (S.seenHits ??= {});
      const mine = (seenH[t.id] ??= new Set());
      for (const [key, h] of Object.entries(p.hits)) {
        if (mine.has(key)) continue;
        mine.add(key);
        if (h.r != null && h.r !== S.roundN) continue; // stale round
        if (!t.dead && !t.gone) {
          const hnow = performance.now();
          t.lastHitAt = hnow;
          damageTank(t, h.d ?? 1, h.by ?? null);
          if (!reconcileShot(t, h.by ?? null, hnow)) absorbShot(t, h.by ?? null);
          absorbShot(t, h.by ?? null);
        }
      }
    }
  }

  // Walking out of a live 1v1 hands the match to whoever stayed: my
  // only opponent bailed → I take it as a 3:0 win. (Their own client
  // books the matching 0:3 loss on the way out, so both sides agree
  // without either needing to referee the other.)
  if (S.duel && !S.matchOver && S.roundStartCount >= 2) {
    const oppGone = S.roster.some((p) =>
      !p.bot && p.id !== S.myId && S.tanks.some((t) => t.id === p.id && t.gone));
    if (oppGone && S.present.has(S.myId)) {
      for (const p of S.roster) S.scores[p.id] = p.id === S.myId ? (S.winTarget ?? 3) : 0;
      S.matchOver = true;
      S.banner = { silent: true };
      S.roundOverAt = performance.now();
      updateScoreHUD();
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
    roster: opts.roster.slice(0, MAX_TANKS),
    scores: Object.fromEntries(opts.roster.map((p) => [p.id, 0])),
    present: new Set(opts.roster.map((p) => p.id)),
    isController: opts.mode === "local",
    sendPos: opts.sendPos,
    sendShot: opts.sendShot,
    sendDead: opts.sendDead,
    sendHit: opts.sendHit,
    sendNextRound: opts.sendNextRound,
    sendGear: opts.sendGear,
    sendGearRemove: opts.sendGearRemove,
    sendPickup: opts.sendPickup,
    sendGun: opts.sendGun,
    onExit: opts.onExit,
    duel: !!opts.duel,
    // Upgrades are a 1v1 and custom-lobby thing. Local play is people
    // on one keyboard, where an account-bound advantage would just be
    // unfair to whoever isn't logged in — so it's always off there.
    upgradesOn: opts.mode !== "local" && !!opts.upgradesOn,
    netClock: opts.serverNow ?? (() => Date.now()), // shared match clock
    // Custom-lobby host settings (null → defaults everywhere).
    gearPool: opts.gearPool ?? null,   // greenlit ability types
    gearMax: opts.gearMax ?? null,     // field cap (≤ GEAR_CAP_LIMIT)
    sizePool: opts.sizePool ?? null,   // allowed map size groups
    zoneOn: !!opts.zone,               // custom lobby: closing zone?
    zoneSec: opts.zonePeriod ?? 30,    // ...and how often it steps in
    winTarget: opts.winTarget ?? 5,
    onDuelEnd: opts.onDuelEnd ?? null,
    matchOver: false,
    duelEndFired: false,
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
    tracks: [],   // tread marks pressed into the floor, oldest first
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
  moveVec.x = 0; moveVec.y = 0; moveVecActive = false;
  touchAim = 0; touchAimActive = false;
  touchFire = false; touchDef = false; touchAgi = false;
  window.addEventListener("keydown", onKeydown);
  window.addEventListener("keyup", onKeyup);
  window.addEventListener("blur", clearHeld);

  // On-screen controls when a touch device drives exactly one human tank.
  // They're overlaid on the arena, so flag the wrap — the corner HUDs
  // shift up out from under the sticks.
  const isTouch = navigator.maxTouchPoints > 0 || "ontouchstart" in window;
  const humanLocal = S.tanks.filter((t) => t.local && !t.bot).length;
  touchPad.hidden = !(isTouch && humanLocal === 1);
  touchPad.parentElement?.classList.toggle("has-touch", !touchPad.hidden);

  updateScoreHUD();
  showScreen("screen-game");
  setInMatch(true);
  startMusic("game");
  S.raf = requestAnimationFrame(frame);
}

function startRound(seed) {
  const rng = mulberry32(seed);
  // Every match can roll a random silhouette now
  // that the closing zone works on any shape. Every maze is braided so
  // there are many open routes.
  let shape = rng() < 0.55
    ? "rect"
    : MAZE_SHAPES_NONRECT[Math.floor(rng() * MAZE_SHAPES_NONRECT.length)];
  // Size pool by mode: a matchmade 1v1 gets small+medium (two tanks
  // need to actually find each other), casual gets the host's chosen
  // groups — all of them by default. Shaped arenas lose cells to the
  // mask, so within the chosen pool they take the larger half to keep
  // the area generous.
  const G = MAZE_SIZE_GROUPS;
  let pool;
  if (S.duel) pool = [...G.small, ...G.medium];                // 1v1
  else if (S.sizePool?.length) {
    pool = S.sizePool.flatMap((k) => G[k] ?? []);
    if (!pool.length) pool = MAZE_SIZES; // host unticked everything
  } else pool = MAZE_SIZES;                                    // casual / offline
  const sizeStart = shape === "rect" ? 0 : Math.floor(pool.length * 0.5);
  const [cols, rows] = pool[sizeStart + Math.floor(rng() * (pool.length - sizeStart))];
  // The arena is a battlefield, not a puzzle: braid 0.3 keeps corridors
  // reading as corridors while opening plenty of cross-connections, and
  // the generator then guarantees every cell has a second exit and that
  // at least two INDEPENDENT routes link the spawns — so there's always
  // a way around, and never one forced corridor.
  S.maze = generateMaze(cols, rows, rng, { shape, braid: 0.3, minRoutes: 2 });
  S.rects = wallRects(S.maze, CELL, WALL_T);
  // Shaped arenas: the angled silhouette edge, as oriented wall slabs
  // (collision) plus the world-space polygon (for the floor + clip).
  // Both are empty/null for a plain rectangle, so nothing changes there.
  S.diag = boundaryWalls(S.maze, CELL, WALL_T);
  S.polyWorld = shapePolygon(S.maze, CELL);
  S.groundSeed = (seed ?? 1) >>> 0;   // arena art is regenerated per layout
  S.worldW = cols * CELL;
  S.worldH = rows * CELL;
  S.bullets = [];
  S.gear = [];
  S.takenGear.clear();
  S.gearSeen.clear();
  S.fades = [];
  S.dust = [];
  S.tracks = [];
  // 3-2-1 countdown: everyone frozen, arena blurred, then GO.
  S.freezeUntil = performance.now() + 3000;
  S.cdLast = 4; // last number we ticked for (4 = none yet)
  // Everything expensive that the round is about to need gets built NOW,
  // during the count, rather than on the first frame anyone moves.
  // Everything expensive the round needs is queued here and drained a
  // few milliseconds at a time while the numbers are on screen.
  planPrewarm();
  S.gearNextAt = S.freezeUntil + GEAR_FIRST_MS;
  // ---- Closing zone ----
  // A creeping "red zone" eats the arena from the outside in. Each
  // layer of cells first BLINKS as a warning, then turns permanently
  // red: red cells delete gear and steadily damage tanks sitting in
  // them. A new layer is claimed every ZONE_PERIOD until the whole map
  // is red. Ring-distance (from maze.js) tells us each cell's layer, so
  // this works for every shape, not just rectangles.
  const rd = ringDistance(S.maze);
  S.zoneDist = rd.dist;        // per-cell layer from the boundary
  // Derive the deepest layer from the SAME geometry the zone is drawn
  // and damaged by. The BFS ring count and the polygon inset don't
  // necessarily close at the same level — on a triangle the polygon runs
  // out a layer earlier — and when they disagreed the final ring drew as
  // fully dead while the game still thought a safe pocket existed, so
  // nothing took damage at all.
  S.zoneMaxLayer = rd.maxLayer;
  {
    let last = 0;
    for (let L = 1; L <= rd.maxLayer + 2; L++) {
      if (zonePolyAt(L)) last = L; else break;
    }
    S.zoneMaxLayer = last;
  }
  S.zoneLevel = 0;             // layers currently permanently red
  S.zoneWarnLevel = -1;        // layer currently blinking (‑1 = none)
  // A matchmade 1v1 always closes on the default cadence. Custom
  // lobbies close only if the host enabled it, and at the host's chosen
  // period (clamped 10–60 s). The warning blink can't outrun the
  // period, so a fast 10 s zone still gets a sensible heads-up.
  const zoneOn = S.duel || !!S.zoneOn;
  // Remember the RESOLVED answer. The renderer used to re-derive this
  // from the match flag alone, which made the zone invisible (but still
  // lethal) in custom lobbies and offline matches.
  S.zoneActive = zoneOn;
  S.zonePeriod = S.duel
    ? ZONE_PERIOD
    : Math.max(ZONE_MIN_PERIOD, Math.min(ZONE_MAX_PERIOD, (S.zoneSec ?? 30) * 1000));
  S.zoneWarn = Math.min(ZONE_WARN_MS, Math.max(2000, S.zonePeriod - 2000));
  S.zoneNextAt = zoneOn ? S.freezeUntil + S.zonePeriod : Infinity;
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
  S.mortarAims = [];
  S.beams = [];
  S.booms = [];
  // NOTE: S.seenShots / S.seenHits are deliberately NOT cleared here.
  //
  // They remember which shot/hit packets have already been applied, keyed
  // by a unique per-packet id. Those packets live on the wire for
  // SHOT_TTL (7 s), but a round turns around in ROUND_PAUSE (2.6 s) plus
  // the 3 s countdown — so when a new round starts, the PREVIOUS round's
  // hits are still sitting in the lobby. Wiping the memory here made the
  // client treat every one of them as brand new and replay all of last
  // round's damage into the freshly spawned tank: it died the instant the
  // round began and handed the other player the win. The round after
  // that looked fine only because the packets had finally expired.
  // The keys are unique, so remembering them across rounds is both
  // correct and cheap.
  // Who owns the on-screen (touch) controls? There's only one pair of
  // sticks, so exactly one tank answers to them.
  //  • Local play → the first human seat (several people, one device).
  //  • Online     → MY OWN tank. It used to take the first non-bot in
  //    the roster, which is join order — i.e. the HOST. Any phone that
  //    joined someone else's lobby was therefore driving nothing: no
  //    movement, no firing. It has to key off myId here.
  S.touchSeat = S.mode === "online"
    ? (S.myId ?? null)
    : ((S.roster.find((p) => !p.bot) ?? {}).id ?? null);
  S.banner = null;
  resetMultiKill();
  S.personalMsg = null;
  S.roundOverAt = 0;
  S.sentNext = false;
  for (const t of S.tanks) { t.phaseUntil = 0; t.wasPhasing = false; t.ejecting = false; }

  // Players 1 & 2 in opposite corners, 3 & 4 in the other pair, then
  // the edge mid-points so a full eight-tank lobby still starts spread
  // evenly around the rim. For a shaped maze a raw corner may fall
  // outside the silhouette, so snap each to the nearest playable cell.
  const midC = Math.floor((cols - 1) / 2);
  const midR = Math.floor((rows - 1) / 2);
  const rawCorners = [
    // Four corners first — best separation for small lobbies.
    [0, 0],
    [cols - 1, rows - 1],
    [cols - 1, 0],
    [0, rows - 1],
    [midC, 0],
    [midC, rows - 1],
    [0, midR],
    [cols - 1, midR],
  ];
  // snapSpawn is the maze generator's OWN rule (nearest playable cell
  // with room to move), so the tanks land exactly on the cells the
  // multi-route guarantee was computed for.
  const corners = rawCorners.map(([c, r]) => snapSpawn(S.maze, c, r));

  // Wrap rather than run off the end — a lobby can never out-number the
  // spawn list now, but a stray index must not crash the match.
  const cornerFor = (spec, i) => corners[i % corners.length];

  S.tanks = S.roster.map((spec, i) => {
    // Resolve this player's upgrades ONCE. Whether they count at all is
    // the match's call, not the player's: local play and any custom
    // lobby with the toggle off hand everyone the neutral set.
    const upSpec = S.upgradesOn ? statsFrom(spec.upgrades ?? {}) : NO_STATS;
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
      // Upgrades, resolved ONCE at spawn into a flat stat block.
      //
      // The roster carries each player's allocation; whether it counts
      // is decided by the match, not the player — S.upgradesOn is false
      // in local play and in any custom lobby with the toggle off, and
      // everyone then gets the neutral set. Resolving here means the
      // rest of the simulation reads plain numbers and never has to
      // know the tree exists.
      up: upSpec,
      hp: TANK_HP + upSpec.hp,
      maxHp: TANK_HP + upSpec.hp,
      regenAt: 0, armourRegenAt: 0,
      // Starting Armour rides for the whole round rather than expiring,
      // so it reads as plating the tank came with rather than a pickup.
      armour: Math.round(upSpec.startArmour),
      armourUntil: upSpec.startArmour > 0 ? Number.MAX_SAFE_INTEGER : 0,
      agiLeft: 0,
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
  // When THIS round began, on our own clock. A `dead` flag on the lobby
  // stamped before this is a leftover from the previous round (see the
  // stale-dead guard in onlineLobbyUpdate).
  S.roundStartedAt = S.netClock ? S.netClock() : Date.now();
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
  moveVec.x = 0; moveVec.y = 0; moveVecActive = false;
  touchAim = 0; touchAimActive = false;
  touchFire = false; touchDef = false; touchAgi = false;
}

function isBoundCode(code) {
  const b = getBinds();
  return Object.values(b).some((set) =>
    ["up", "down", "left", "right", "shoot"].some((a) => set?.[a] === code),
  );
}

// LOCAL DROP-IN. In an offline match, a bot seat can be taken over at
// any time by a person pressing THAT seat's fire key (red/green/blue/
// yellow). The bot hands the tank over and it answers to that seat's
// binds from then on. Lets friends jump in mid-game without returning
// to the setup screen.
function pollLocalJoins(binds) {
  if (!S || S.mode !== "local") return;
  for (const slot of ["red", "green", "blue", "yellow"]) {
    const key = binds?.[slot]?.shoot;
    if (!key || !held.has(key)) continue;
    const seat = S.tanks.find((t) => (t.slot ?? t.color) === slot && t.bot && !t.dead && !t.gone);
    if (seat) {
      seat.bot = null;
      seat.joinedLive = true;
      // Persist across rounds: rounds rebuild tanks from S.roster, so the
      // seat must stay human there too or the AI would retake it.
      const spec = S.roster.find((sp) => (sp.slot ?? sp.color) === slot);
      if (spec) { spec.bot = null; spec.joinedLive = true; }
      toast(`${SLOT_LABEL[slot] ?? "A player"} joined!`);
    }
  }
}

const SLOT_LABEL = { red: "Player 1", green: "Player 2", blue: "Player 3", yellow: "Player 4" };

function readActions(tank, binds) {
  const acts = {
    up: false, down: false, left: false, right: false,
    shoot: false, def: false, agi: false,
  };

  // Which control set drives this tank?
  //  • Local play  → the tank's own seat (four people, one keyboard).
  //  • Online      → Player 1's binds only. Online seats are one tank
  //    per client, so there is no second local driver to arbitrate.
  const seat = S.mode === "local"
    ? (tank.slot ?? tank.color)
    : "red";
  const set = binds[seat] ?? binds.red ?? Object.values(binds)[0] ?? {};
  for (const a of ["up", "down", "left", "right", "shoot", "def", "agi"]) {
    const code = set[a];
    if (code && held.has(code)) acts[a] = true;
  }

  // Touch only ever drives ONE tank: there's a single pair of on-screen
  // controls, so with several people sharing a keyboard it belongs to
  // the first human seat and nobody else.
  if (!tank.bot && tank.id === S.touchSeat) {
    // Left stick → DIRECTIONAL drive: the hull turns to face the stick
    // and moves that way (twin-stick style), rather than tank-style
    // turn/forward. We hand the movement code the stick's world angle
    // and how far it's pushed; it does the steering + throttle.
    const DZ = 0.28;
    const mag = Math.hypot(moveVec.x, moveVec.y);
    if (moveVecActive && mag > DZ) {
      acts.moveAngle = Math.atan2(moveVec.y, moveVec.x);
      acts.moveMag = Math.min(1, (mag - DZ) / (1 - DZ)); // 0..1 past deadzone
    }
    // Three activation controls, one per loadout category. Keyboard
    // binds are read above; the touch buttons OR in here.
    if (touchFire) acts.shoot = true;
    if (touchDef) acts.def = true;
    if (touchAgi) acts.agi = true;
  }
  return acts;
}

/* ================================================================
   Simulation
   ================================================================ */

function frame(now) {
  const frameT0 = performance.now();
  if (!S) return;
  const dt = Math.min((now - S.lastT) / 1000, 0.05);
  S.lastT = now;

  // Chip away at the round's asset queue. While the countdown is up
  // nobody can move, so a generous slice costs nothing; once play starts
  // anything left is finished off in small bites rather than stalling a
  // frame. In practice the queue is empty well before GO.
  // During the countdown nothing is moving, so there is slack to bake
  // in — but a single job must never blow the frame. The scene is the
  // one big one; give it its own generous slot on the very first ticks
  // and keep the rest to a small budget.
  if (S.prewarm) stepPrewarm(now < (S.freezeUntil ?? 0) ? 10 : 2);

  // Shared per-frame data: laser aiming lines (drawn for everyone,
  // dodged by bots) and the hazard list bots treat as bullets.
  S.laserPaths = [];
  S.sniperAims = [];
  S.mortarAims = [];
  for (const t of S.tanks) {
    if (t.dead || t.gone) continue;
    if (t.weapon === "laser") {
      const m = muzzlePoint(t, 1);
      S.laserPaths.push({ by: t.id, color: effBaseHex(t), pts: laserPath(m.x, m.y, t.turret ?? t.a, S.rects,
        LASER.previewBounces + Math.round(t.up?.laserGuide ?? 0), S.diag) });
    } else if (t.weapon === "sniper") {
      // Straight line, no bounce, through walls, 3 cells long.
      const m = muzzlePoint(t, 1);
      const len = SNIPER.previewCells * CELL;
      const aim = t.turret ?? t.a;
      S.sniperAims.push({
        by: t.id, color: effBaseHex(t),
        x0: m.x, y0: m.y,
        x1: m.x + Math.cos(aim) * len, y1: m.y + Math.sin(aim) * len,
      });
    } else if (t.weapon === "mortar" && !t.bot && t.local && t.mortarAiming) {
      // A targeting reticle for EACH locally-driven tank that has its
      // launcher open. This is a list, not a single slot: with two
      // people on one machine (local play) both can be aiming at once, and a shared slot meant only the
      // last one written ever drew. Tinted per tank so each player can
      // pick out their own. The in-flight red dot still warns everyone.
      if (t.mortarAim) {
        S.mortarAims.push({ x: t.mortarAim.x, y: t.mortarAim.y, color: effBaseHex(t) });
      }
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
    // Tread marks are laid AFTER movement has settled for the frame, so a
    // mark always lands where the tread finished up.
    for (const t of S.tanks) emitTracks(t, now);
    stepFlameBurns(now); // arm the after-burn once the flame leaves a tank
    stepBurns(now);
    stepRegen(now);
    stepBullets(now, dt);
    stepSpecials(now, dt);
    maybeEndRound(now);
  } else if (S.matchOver) {
    // The match is decided — hold the banner, then report placements
    // exactly once so both clients settle the same result.
    if (!S.duelEndFired && now - S.roundOverAt > 3500) {
      S.duelEndFired = true;
      // An opponent who walked out stays in the list with a 0 score, so
      // the win computes as the clean 3:0 their own client already
      // booked against itself when it left.
      const placements = S.roster
        .map((p) => ({ id: p.id, color: p.color, score: S.scores[p.id] ?? 0 }))
        .sort((a, b) => b.score - a.score);
      S.onDuelEnd?.(placements, { dmgBy: S.dmgBy ?? {}, killsBy: S.killsBy ?? {}, myId: S.myId });
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
      // Whole px/s: at the ~100 ms we ever extrapolate, a sub-1 px/s
      // difference moves a tank by <0.1 px, so the extra decimal was
      // bytes on every packet for nothing visible.
      const vx = Math.round(dx / (elapsed / 1000));
      const vy = Math.round(dy / (elapsed / 1000));
      t.netLast = { x: t.x, y: t.y, a: t.a, u: t.turret ?? t.a, at: snow };
      S.sendPos?.(t.id, {
        x: +t.x.toFixed(1), y: +t.y.toFixed(1),
        a: +t.a.toFixed(3), u: +(t.turret ?? t.a).toFixed(3),
        vx, vy, t: Math.round(snow),
      });
    }
  }

  // Frame-time governor. A rolling average, checked a few times a
  // second: consistently over budget and the render scale steps down;
  // comfortably under and it steps back up. Bounded so it can never
  // collapse to a blur or overshoot the 1440p ceiling.
  {
    const spent = performance.now() - frameT0;
    S.frameAvg = S.frameAvg == null ? spent : S.frameAvg * 0.9 + spent * 0.1;
    if (now - (S.resCheckAt ?? 0) > 400) {
      S.resCheckAt = now;
      const cur = S.resScale ?? 1;
      if (S.frameAvg > 13 && cur > 0.55) S.resScale = Math.max(0.55, cur - 0.1);
      else if (S.frameAvg < 7 && cur < 1) S.resScale = Math.min(1, cur + 0.05);
    }
  }

  setEngine(!S.banner, S.engineMovingLocal, S.engineMovingEnemy);
  setFlame(!S.banner && !!S.tanks && S.tanks.some(t => t.flameOn && !t.dead && !t.gone));
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
  pollLocalJoins(getBinds());
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
            // The arena as it stands RIGHT NOW, not as it was generated.
            // Brick walls and mud puddles are placed mid-round, and
            // without them the bots plan on a map that no longer
            // exists — routing straight into a wall someone just built
            // and ploughing through mud they could have driven round.
            walls: S.walls,
            mud: S.mudPits,
            mudSlow: MUD.slow,
          // The closing zone. Bots were completely blind to it and would
          // sit in a red cell taking ticks until they died.
          // Give the bots the SAME polygon truth the damage uses, not
          // the old per-cell grid — otherwise they would flee a square
          // staircase that no longer matches where the zone actually is.
          zoneDist: S.zoneActive ? S.zoneDist : null,
          zoneDepthAt: S.zoneActive ? zoneDepthAt : null,
          zoneLevel: S.zoneLevel ?? 0,
          zoneWarn: S.zoneWarnLevel ?? -1,
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
            magSize: magCapOf(t),   // includes this tank's Max Ammo upgrade
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

      // MORTAR AIMING: the tank is planted while the reticle is open.
      // Rather than skipping the rest of the tank's update (which would
      // also skip zone damage, pickups and net sync), we steer the
      // reticle with the movement inputs and then BLANK those inputs,
      // so the drive/turn code below simply has nothing to act on.
      if (t.mortarAiming) {
        if (t.weapon !== "mortar" || t.dead || t.gone) {
          cancelMortarAim(t); // lost the launcher — don't stay stuck
        } else {
          stepMortarAim(t, acts, dt, now);
          acts.up = acts.down = acts.left = acts.right = false;
          acts.moveAngle = null;
          acts.moveMag = 0;
        }
      }

      // Directional (mobile stick) drive takes precedence: steer the
      // hull toward the stick's world angle by the shortest arc, capped
      // at the normal turn rate, and set forward throttle from how far
      // the stick is pushed. Reversing a full 180° would be slow, so if
      // the target is behind the tank we drive in reverse instead of
      // spinning all the way around.
      let turn = 0;              // for tread animation / engine below
      let dirThrottle = null;    // 0..1 forward throttle when steering
      let dirReverse = false;
      if (acts.moveAngle != null) {
        let diff = angleDiff(t.a, acts.moveAngle); // signed shortest arc
        // If the stick points behind us, it's quicker to reverse: aim
        // the REAR at the target and mark reverse.
        if (Math.abs(diff) > Math.PI / 2) {
          diff = angleDiff(t.a, acts.moveAngle + Math.PI);
          dirReverse = true;
        }
        // The hull has rotational inertia too. Snapping straight to full
        // turn rate while forward motion ramps made steering feel
        // disconnected from driving.
        const maxRate = TURN_SPEED * mul.turn;
        const wantRate = Math.max(-maxRate, Math.min(maxRate, diff / Math.max(dt, 1e-3)));
        const spinOpposing = wantRate * (t.spin ?? 0) < 0;
        const spinRate = (spinOpposing || Math.abs(wantRate) < Math.abs(t.spin ?? 0)) ? maxRate / SPIN_DOWN : maxRate / SPIN_UP;
        const dS = wantRate - (t.spin ?? 0);
        const stepS = spinRate * dt;
        t.spin = Math.abs(dS) <= stepS ? wantRate : (t.spin ?? 0) + Math.sign(dS) * stepS;
        const step = t.spin * dt;
        const na = t.a + step;
        if (phasing || !tankHitsAnyWall(t, t.x, t.y, na)) t.a = na;
        turn = Math.sign(step) * (Math.abs(step) > 1e-4 ? 1 : 0);
        // Throttle scales with deflection, and eases off while the hull
        // is still swinging onto heading so it doesn't veer wide.
        const align = Math.max(0, 1 - Math.abs(diff) / Math.PI);
        dirThrottle = (acts.moveMag ?? 1) * (0.35 + 0.65 * align);
      } else {
        // Keyboard tank-style turn.
        turn = (acts.right ? 1 : 0) - (acts.left ? 1 : 0);
        const maxRate = TURN_SPEED * mul.turn;
        const wantRate = turn * maxRate;
        const spinOpposing = wantRate * (t.spin ?? 0) < 0;
        const spinRate = (spinOpposing || Math.abs(wantRate) < Math.abs(t.spin ?? 0)) ? maxRate / SPIN_DOWN : maxRate / SPIN_UP;
        const dS = wantRate - (t.spin ?? 0);
        const stepS = spinRate * dt;
        t.spin = Math.abs(dS) <= stepS ? wantRate : (t.spin ?? 0) + Math.sign(dS) * stepS;
        if (t.spin !== 0) {
          const na = t.a + t.spin * dt;
          if (phasing || !tankHitsAnyWall(t, t.x, t.y, na)) t.a = na;
        }
      }

      let v = 0;
      const boosting = now < (t.boostUntil ?? 0);
      // Top Speed scales the boost itself, so it stacks with the
      // tank's own Speed upgrade rather than replacing it.
      const boostMul = boosting ? BOOST.mult * (t.up?.boostSpeed ?? 1) : 1;
      // Mud pit: any tank standing in one moves 20% slower.
      // The pit's OWN slow, set by whoever laid it — so the Slow Effect
      // upgrade belongs to the player who threw the mud, not the poor
      // soul driving through it.
      let mudMul = 1;
      for (const m of S.mudPits) {
        if (now - m.born >= (m.life ?? MUD.lifeMs)) continue;
        if ((t.x - m.x) ** 2 + (t.y - m.y) ** 2 >= m.r * m.r) continue;
        mudMul = Math.min(mudMul, m.slow ?? MUD.slow);
      }
      const inMud = mudMul < 1;
      if (dirThrottle != null) {
        // Directional stick throttle (forward, or reverse if the target
        // was behind us).
        // `upS` folds in the tank's own Speed upgrade, so it stacks
        // with the bot handicap, the boost and the mud slow rather than
        // replacing any of them.
        const upS = t.up?.speed ?? 1;
        if (dirReverse) v -= REVERSE_SPEED * mul.speed * upS * boostMul * mudMul * dirThrottle;
        else v += MOVE_SPEED * mul.speed * upS * boostMul * mudMul * dirThrottle;
      } else {
        const upS = t.up?.speed ?? 1;
        if (acts.up) v += MOVE_SPEED * mul.speed * upS * boostMul * mudMul;
        if (acts.down) v -= REVERSE_SPEED * mul.speed * upS * boostMul * mudMul;
      }

      // ---- inertia -------------------------------------------------
      // `v` above is the speed the controls are ASKING for. A tank has
      // mass, so it ramps toward that rather than snapping to it:
      // 1.5 s from a standstill to full speed, and 0.8 s to roll to a
      // stop once the gas is released. Braking is deliberately quicker
      // than pulling away, which is how a tracked vehicle behaves.
      {
        const want = v;
        const full = MOVE_SPEED * mul.speed * (t.up?.speed ?? 1); // reference speed
        const cur = t.vel ?? 0;
        // Rates are "reference speeds per second", so boost and mud
        // change the target without changing how briskly it responds.
        const accel = full / ACCEL_TIME;
        const brake = full / BRAKE_TIME;
        // Actively reversing direction counts as braking until we cross
        // zero, so a direction change doesn't feel spongy.
        // Braking only when genuinely reversing at speed. Testing the
        // raw signs made a tank crawling at walking pace brake every
        // time the command wobbled across zero, so it never built any
        // speed at all — it just shuffled on the spot.
        // An input that OPPOSES the current motion is the driver actively
        // braking, not coasting — so it bites at the braking rate rather
        // than waiting for the tank to coast down first. That wait is
        // what made forward-to-reverse feel like the stick had been
        // ignored for a moment.
        const opposing = want * cur < 0;
        const easingOff = Math.abs(want) < Math.abs(cur);
        const rate = (opposing || easingOff) ? brake : accel;
        const d = want - cur;
        const stepV = rate * dt;
        t.vel = Math.abs(d) <= stepV ? want : cur + Math.sign(d) * stepV;
        v = t.vel;
      }

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
        } else {
          // Blocked. Two things have to happen or the tank judders along
          // the bricks: kill the stored momentum (it used to keep
          // building against the wall and then lurch the moment the tank
          // came free — the micro-teleport), and step up to the wall
          // instead of refusing to move at all, so contact is smooth
          // rather than stopping a fraction short and jittering.
          t.vel = 0;
          t.spin = t.spin ?? 0;
          let lo2 = 0, hi2 = 1;
          for (let it = 0; it < 6; it++) {
            const mid = (lo2 + hi2) / 2;
            const mx = t.x + (nx - t.x) * mid, my = t.y + (ny - t.y) * mid;
            if (tankHitsAnyWall(t, mx, my, t.a) || tankHitsAnyDiag(t, mx, my, t.a)) hi2 = mid;
            else lo2 = mid;
          }
          if (lo2 > 0.02) {
            t.x += (nx - t.x) * lo2;
            t.y += (ny - t.y) * lo2;
          }
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

      // ---- Turret: WELDED TO THE HULL ----
      // There is no independent turret control anywhere in the game any
      // more — not for players (no mouse), not for bots. The barrel
      // always points where the tank is facing, so aiming means turning
      // the whole tank. Everything downstream still reads t.turret, so
      // we just keep it pinned to the hull heading.
      t.turret = t.a;

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
            t.mgAmmo ??= MG.shots + Math.round(t.up?.mgAmmo ?? 0);
            const m = muzzlePoint(t, MG.r * BULLET_R);
            const a = (t.turret ?? t.a) + (Math.random() * 2 - 1) * MG.spread;
            spawnBullet(t.id, m.x, m.y, a, now, true);
            sendTypedShot(t, { w: "mini", x: +m.x.toFixed(1), y: +m.y.toFixed(1), a: +a.toFixed(3) }, now);
            // Fire Rate shortens the gap between balls.
            t.mgNext = now + MG.gapMs / (t.up?.mgRate ?? 1);
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
      } else if (t.weapon === "flame") {
        // Flamethrower: HOLD the trigger to breathe fire. Fuel drains ONLY
        // while the button is down (it's not a toggle), the stream dies the
        // instant you let go, and when the 3 s of fuel run out the barrel
        // reverts — a charge that empties like the MG's belt.
        //
        // DAMAGE: while a tank is in the cone it takes 1 damage every
        // FLAME.tickMs (400 ms). We ALSO stamp the contact every frame so
        // stepFlameBurns can start a burn once the flame LEAVES it — the
        // burn never overlaps the direct damage.
        t.flameFuel ??= FLAME.durationMs + (t.up?.flameFuel ?? 0) * 1000;
        const firing = !!acts.shoot && t.flameFuel > 0;
        if (firing) {
          if (!t.flameOn) {
            t.flameOn = true;
            t.flameOnAt = now;      // stream starts to extend
            t.flameNetAt = 0;       // push a fresh pulse to peers at once
            sfx.windup?.();
          }
          const burn = Math.min(t.flameFuel, dt * 1000);       // dt is seconds
          t.flameFuel = Math.max(0, t.flameFuel - burn);
          // Damage is charged against FUEL BURNED, not against the clock.
          // It used to fire whenever `now` passed a deadline, so tapping
          // the trigger once every tick-length spent almost no fuel and
          // still landed full damage every time — a whole tank could be
          // taken down on one clip by spamming taps. Metering it by fuel
          // means a tap costs exactly the damage it pays for.
          t.flameBurn = (t.flameBurn ?? FLAME.tickMs) + burn;
          const doTick = t.flameBurn >= FLAME.tickMs;
          if (doTick) t.flameBurn -= FLAME.tickMs;
          for (const o of S.tanks) {
            if (o === t || o.dead || o.gone) continue;
            if (!tankInFlameCone(t, o)) continue;
            // Stamp the contact EVERY frame so the burn can start the
            // moment the flame comes off them (see stepFlameBurns).
            o.flameHitAt = now;
            o.flameHitBy = t.id;
            o.flameContact = true;
            if (doTick) applyHit(o, FLAME.tickDmg, t.id, now, "flame"); // 1 dmg / 400 ms
          }
          // Online: keep peers' streams alive with a throttled pulse.
          if (S.mode === "online" && t.local && now >= (t.flameNetAt ?? 0)) {
            t.flameNetAt = now + FLAME_NET_MS;
            sendTypedShot(t, { w: "flame", x0: +t.x.toFixed(1), y0: +t.y.toFixed(1) }, now);
          }
          if (t.flameFuel <= 0) {
            t.flameOn = false;
            t.flameOffAt = now;
            clearWeapon(t, now);    // dry — barrel reverts, pickups unlock
          }
        } else if (t.flameOn) {
          // Trigger released with fuel to spare: shut the stream (it pulls
          // in and fades) and keep the rest for later.
          t.flameOn = false;
          t.flameOffAt = now;
          if (t.local && !t.bot) sfx.winddown?.();
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
        if (err > NET_TELEPORT_DIST) {
          // Genuinely discontinuous (round spawn, respawn, rejoin).
          // Nothing to smooth — just be where they are.
          t.x = st.x; t.y = st.y; t.a = st.a; t.turret = st.u;
        } else {
          // Everything else is CLOSED SMOOTHLY. A lag spike used to
          // blow past the old 2.5-cell threshold and hard-snap, which
          // is what read as a teleport. Now a big gap just means a
          // higher speed ceiling: the tank sprints back onto its true
          // position over a few frames instead of jumping there.
          const k = 1 - Math.exp(-16 * dt);
          let mx = dxs * k, my = dys * k;
          const step = Math.hypot(mx, my);
          const rate = err > NET_SNAP_DIST ? NET_CATCHUP_SPEED : NET_CORRECT_SPEED;
          const cap = MOVE_SPEED * rate * dt;
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

      // Flamethrower stream for a remote shooter: it stays lit only while
      // their "still firing" pulses keep arriving. When they release (or
      // lag out) the pulses stop, so we let it pull in and fade.
      if (t.flameOn && now > (t.flamePulseUntil ?? 0)) {
        t.flameOn = false;
        t.flameOffAt = now;
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
// Tread marks. Driven purely by where each tread actually IS from frame
// to frame, so it works identically for a locally driven tank, a bot, and
// a remote tank being interpolated — no separate code path can drift.
// A mark is laid every TRACK_STEP of tread travel, which is the same
// pitch as the links drawn on the tank's own treads.
function emitTracks(t, now) {
  if (t.dead || t.gone) return;
  const sa = Math.sin(t.a), ca = Math.cos(t.a);
  // Contact point of each tread, and the across-tread direction shared by
  // both (computed once — it only depends on the hull angle).
  const nx = -sa * TRACK_CLEAT, ny = ca * TRACK_CLEAT;
  const lx = t.x + sa * TRACK_HALF, ly = t.y - ca * TRACK_HALF;
  const rx = t.x - sa * TRACK_HALF, ry = t.y + ca * TRACK_HALF;

  const lay = (cx, cy, kx, ky, sd) => {
    const px = t[kx], py = t[ky];
    if (px === undefined) { t[kx] = cx; t[ky] = cy; return; }
    const dx = cx - px, dy = cy - py;
    const d2 = dx * dx + dy * dy;
    if (d2 < TRACK_STEP * TRACK_STEP) return;          // hasn't moved far enough yet
    // A jump this big is a respawn or a phase, not driving — pick the
    // trail up at the new spot instead of smearing a stripe across the map.
    if (d2 > CELL * CELL) { t[kx] = cx; t[ky] = cy; return; }
    // `sd` marks which tread this came from, so the two can be drawn as
    // separate continuous lines rather than a pile of loose segments.
    S.tracks.push({ born: now, x: cx, y: cy, px, py, nx, ny, sd });
    t[kx] = cx; t[ky] = cy;
  };
  lay(lx, ly, "trkPLx", "trkPLy", 0);
  lay(rx, ry, "trkPRx", "trkPRy", 1);
}

// Age out marks (the list is oldest-first, so a single splice does it)
// and hold the total under the cap. Called from the draw pass, like the
// dust does, so marks keep fading during a countdown or an end-of-round
// banner — any frame that paints also ages them.
function stepTracks(now) {
  const list = S.tracks;
  if (!list.length) return;
  let cut = 0;
  while (cut < list.length && now - list[cut].born >= TRACK_LIFE) cut++;
  if (cut) list.splice(0, cut);
  if (list.length > TRACK_MAX) list.splice(0, list.length - TRACK_MAX);
}

// Paint the tread marks: a soft dark band per tread with darker cleat
// bars stamped across it. Everything is stroked, and marks are grouped
// into a handful of opacity bands so the whole floor costs a couple of
// dozen stroke calls no matter how many marks are down.
function drawTracks(now) {
  stepTracks(now);
  const list = S.tracks;
  if (!list.length) return;

  // Marks are grouped into this many opacity steps so the whole floor
  // costs a fixed handful of strokes. 20 keeps every step under ~3/255
  // levels, which is below what the eye can pick out — so the fade reads
  // as continuous rather than stepping down in visible stages.
  // Eight opacity steps, not twenty. These marks are faint and short-
  // lived, so the extra bands cost three canvas strokes each for a
  // difference nobody can see — and stroking was the single busiest
  // thing in the frame.
  const BUCKETS = 8;
  const fadeOf = (k) => {
    const life = 1 - (now - k.born) / TRACK_LIFE;      // 1 fresh → 0 gone
    if (life <= 0) return 0;
    if (life >= 1) return 1;
    // Smoothstep. The previous curve held flat and then broke into a
    // straight line, and that corner read as the fade "starting" all at
    // once. This eases out of full strength and into nothing with no
    // kink at either end, so a mark just quietly goes.
    return life * life * (3 - 2 * life);
  };
  const bucketOf = (k) => {
    const b = Math.floor(fadeOf(k) * BUCKETS);
    return b >= BUCKETS ? BUCKETS - 1 : b < 0 ? 0 : b;
  };

  ctx.save();
  const bandW = TRACK_WIDTH;
  const cleatW = Math.max(1, TANK_R * 0.11);

  // The list is time-ordered, so equal-opacity marks are contiguous.
  let i = 0;
  while (i < list.length) {
    const b = bucketOf(list[i]);
    let j = i + 1;
    while (j < list.length && bucketOf(list[j]) === b) j++;
    const a = (b + 0.5) / BUCKETS;
    if (a > 0.001) {
      // The band the tread pressed flat.
      //
      // Each tread is stroked as ONE CONTINUOUS polyline with BUTT caps.
      // Drawing it as separate round-capped segments meant every cap
      // overhung its neighbour, and where two opacity groups met those
      // overhangs blended twice and showed up as dark circles travelling
      // along the trail as it faded. Butt caps butt exactly together, so
      // there's nothing to double-blend and nothing to see.
      ctx.lineCap = "butt";
      ctx.lineJoin = "round";
      ctx.strokeStyle = `rgba(0,0,0,${(0.13 * a).toFixed(3)})`;
      ctx.lineWidth = bandW;
      for (let side = 0; side < 2; side++) {
        ctx.beginPath();
        let lx = NaN, ly = NaN;
        for (let k = i; k < j; k++) {
          const m = list[k];
          if (m.sd !== side) continue;
          if (m.px !== lx || m.py !== ly) ctx.moveTo(m.px, m.py); // new run
          ctx.lineTo(m.x, m.y);
          lx = m.x; ly = m.y;
        }
        ctx.stroke();
      }
      // The cleats that bit into it. These are isolated bars that never
      // touch each other, so they keep their rounded ends safely.
      ctx.lineCap = "round";
      ctx.strokeStyle = `rgba(0,0,0,${(0.25 * a).toFixed(3)})`;
      ctx.lineWidth = cleatW;
      ctx.beginPath();
      for (let k = i; k < j; k++) {
        const m = list[k];
        ctx.moveTo(m.x - m.nx, m.y - m.ny);
        ctx.lineTo(m.x + m.nx, m.y + m.ny);
      }
      ctx.stroke();
    }
    i = j;
  }
  ctx.restore();
}

function emitDriveDust(t, back, boosting, now) {
  // Boost pumps particles out at nearly double the rate.
  t.dustAt = now + (boosting ? 34 + Math.random() * 24 : 65 + Math.random() * 45);
  // Behind the TREADS, not out of the tank's belly. Treads are what
  // actually bite the ground, so that's where the dust comes from — the
  // same ±0.62R offset the tread marks use.
  const bx = t.x + Math.cos(t.a) * TANK_R * back;
  const by = t.y + Math.sin(t.a) * TANK_R * back;
  const px = -Math.sin(t.a) * TANK_R * 0.62;
  const py = Math.cos(t.a) * TANK_R * 0.62;

  // Boost: 4 puffs per emission (vs 1), thrown wider and harder.
  const puffs = boosting ? 6 : 2;   // one per tread, more under boost
  const scat = boosting ? 11 : 6;
  const kick = boosting ? 15 : 9;
  for (let p = 0; p < puffs; p++) {
    const side = (p % 2) ? 1 : -1;          // alternate left / right tread
    S.dust.push({
      // Three or four soft lobes give the puff an irregular, cloudy
      // outline instead of the perfect disc it used to be.
      lobes: [
        { ox: 0, oy: 0, r: 0.9 },
        { ox: (Math.random() - 0.5) * 0.7, oy: (Math.random() - 0.5) * 0.7, r: 0.62 + Math.random() * 0.22 },
        { ox: (Math.random() - 0.5) * 0.9, oy: (Math.random() - 0.5) * 0.9, r: 0.5 + Math.random() * 0.22 },
        { ox: (Math.random() - 0.5) * 1.1, oy: (Math.random() - 0.5) * 1.1, r: 0.36 + Math.random() * 0.2 },
      ],
      spin: (Math.random() - 0.5) * 1.4,
      x: bx + px * side + (Math.random() - 0.5) * scat,
      y: by + py * side + (Math.random() - 0.5) * scat,
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
  // Stamp the round, so a peer never spawns last round's shots into the
  // new one (packets outlive a round on the wire).
  // Stamp the shot on the SHARED clock. Without this a peer had no way
  // to know how old a packet was, so it spawned the round at the muzzle
  // the moment it arrived — one latency behind where the shooter's round
  // already was. At 420 px/s even 100 ms of lag puts it most of a tank
  // length out, and every wall bounce multiplies the gap. This is the
  // single biggest cause of rounds appearing in different places on
  // different screens.
  S.sendShot?.(t.id, key, {
    ...payload,
    r: S.roundN ?? 0,
    t: Math.floor(S.netClock ? S.netClock() : Date.now()),
  });
}

function clearWeapon(t, now) {
  t.weapon = null;
  t.flameUntil = 0;      // legacy field, kept zeroed for safety
  t.flameTickAt = 0;
  t.flameBurn = FLAME.tickMs;   // first pull of a fresh tank bites at once
  t.flameOn = false;
  t.flameOnAt = 0;
  t.flameOffAt = 0;
  t.flameFuel = null;    // a fresh flame pickup refills the pool
  t.flameNetAt = 0;
  t.snNextAt = 0;
  if (t.mortarAiming) cancelMortarAim(t);
  t.mgReadyAt = 0;
  t.mgIdleAt = 0;
  t.mgNext = 0;
  t.mgAmmo = null;
  t.snAmmo = null;
  t.gunClearedAt = now;
  if (S.mode === "online" && t.local) S.sendGun?.(t.id, null);
}

function tryFire(t, now) { 
  // Sniper: a forced beat between the two rounds, so it can't be
  // double-tapped instantly. Blocks the second shot until the gap
  // elapses (and blocks nothing else).
  if (t.weapon === "sniper" && t.snNextAt && now < t.snNextAt) return;

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

  if (t.weapon === "mg") return;    // manual fire — handled in stepTanks
  if (t.weapon === "flame") return; // held fire — handled in stepTanks

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

  // MORTAR is a two-press weapon. The first press plants the tank and
  // opens the reticle; the second (handled below) actually fires. Bots
  // skip straight through — mortarTarget() resolves their aim.
  if (w === "mortar" && !t.bot && !t.mortarAiming) {
    beginMortarAim(t);
    return;
  }

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
    if (t.snAmmo > 0) {
      // Hold the second round back for a full beat.
      t.snNextAt = now + SNIPER.shotGapMs;
      return; // keep the sniper until both rounds are gone
    }
    t.snAmmo = null;
    t.snNextAt = 0;
  } else if (w === "mortar") {
    // Second press: send it. The reticle is already snapped to a grid
    // intersection within reach; the shell arcs over everything and
    // lands there, and the tank is freed the moment it leaves.
    const tgt = mortarTarget(t);
    cancelMortarAim(t);
    launchMortar(t.id, t.x, t.y, tgt.x, tgt.y, now);
    sendTypedShot(t, {
      w: "mortar",
      x0: +t.x.toFixed(1), y0: +t.y.toFixed(1),
      x: +tgt.x.toFixed(1), y: +tgt.y.toFixed(1),
    }, now);
  }

  clearWeapon(t, now);
}

// ---- Mortar aiming --------------------------------------------------
// The mortar is a two-press weapon. The first press PLANTS the tank and
// opens a reticle; you walk the reticle around with your normal
// movement controls; the second press fires and frees the tank.
//
// The reticle always snaps to a grid INTERSECTION — the point where
// four cells meet — because the blast covers all four of them. Reach is
// measured in HALF-cells and clamped to [minHalfCells, maxHalfCells].

// Snap a world point to the nearest grid intersection (4-cell corner).
function snapToIntersection(x, y) {
  return {
    x: Math.round(x / CELL) * CELL,
    y: Math.round(y / CELL) * CELL,
  };
}

// Is intersection (c,r) a legal drop for this tank? It must sit on the
// board and inside the launcher's reach ring.
function mortarCellOK(t, c, r) {
  const cols = Math.round(S.worldW / CELL), rows = Math.round(S.worldH / CELL);
  if (c < 1 || r < 1 || c > cols - 1 || r > rows - 1) return false;
  const half = CELL / 2;
  const d = Math.hypot(c * CELL - t.x, r * CELL - t.y);
  return d >= MORTAR.minHalfCells * half - 0.01
      && d <= MORTAR.maxHalfCells * half + 0.01;
}

// The nearest legal intersection to a world point — used to seed the
// reticle and to place bot shots.
function nearestMortarCell(t, x, y) {
  const base = snapToIntersection(x, y);
  let best = null, bestD = Infinity;
  const c0 = Math.round(base.x / CELL), r0 = Math.round(base.y / CELL);
  for (let dc = -4; dc <= 4; dc++) {
    for (let dr = -4; dr <= 4; dr++) {
      const c = c0 + dc, r = r0 + dr;
      if (!mortarCellOK(t, c, r)) continue;
      const d = Math.hypot(c * CELL - x, r * CELL - y);
      if (d < bestD) { bestD = d; best = { c, r }; }
    }
  }
  return best;
}

function mortarCellPoint(cell) {
  return { x: cell.c * CELL, y: cell.r * CELL };
}

// Open the reticle: plant the tank and seed the aim one step ahead.
function beginMortarAim(t) {
  const ahead = nearestMortarCell(t,
    t.x + Math.cos(t.a) * CELL * 1.5, t.y + Math.sin(t.a) * CELL * 1.5);
  const cell = ahead ?? nearestMortarCell(t, t.x, t.y);
  if (!cell) return;            // nowhere legal to aim — don't plant
  t.mortarAiming = true;
  t.mortarCell = cell;
  t.mortarStepAt = 0;
  t.mortarAim = mortarCellPoint(cell);
}

function cancelMortarAim(t) {
  t.mortarAiming = false;
  t.mortarAim = null;
  t.mortarCell = null;
}

// Walk the reticle with your OWN movement controls, one grid
// intersection per press: up moves it up, left moves it left, and so on.
//
// The old scheme was polar — left/right swung a bearing and up/down
// changed the radius — and because the result then snapped to the
// nearest intersection, every press made the marker hop unpredictably
// between a handful of points. That's the "it just cycles" behaviour.
// Direct grid stepping is what the controls imply, so that's what it
// does now. Holding a direction repeats at a steady cadence; releasing
// re-arms an instant next step, so taps are exactly one square.
const MORTAR_STEP_MS = 150;

function stepMortarAim(t, acts, dt, now) {
  if (!t.mortarCell) { cancelMortarAim(t); return; }
  let sx = 0, sy = 0;
  if (acts.moveAngle != null && (acts.moveMag ?? 0) > 0.35) {
    // Touch stick: take whichever cardinal it leans toward most.
    const ca = Math.cos(acts.moveAngle), sa = Math.sin(acts.moveAngle);
    if (Math.abs(ca) > Math.abs(sa)) sx = ca > 0 ? 1 : -1;
    else sy = sa > 0 ? 1 : -1;
  } else {
    if (acts.right) sx = 1; else if (acts.left) sx = -1;
    if (acts.down) sy = 1; else if (acts.up) sy = -1;   // screen up = -y
  }
  if (!sx && !sy) { t.mortarStepAt = 0; return; }  // released: next tap is instant
  if (now < (t.mortarStepAt ?? 0)) return;          // hold-to-repeat throttle
  t.mortarStepAt = now + MORTAR_STEP_MS;

  // Try the full diagonal, then each axis on its own, so sliding along
  // the edge of the reach ring still works instead of jamming.
  const tries = [[sx, sy], [sx, 0], [0, sy]];
  for (const [dx, dy] of tries) {
    if (!dx && !dy) continue;
    const c = t.mortarCell.c + dx, r = t.mortarCell.r + dy;
    if (mortarCellOK(t, c, r)) { t.mortarCell = { c, r }; break; }
  }
  t.mortarAim = mortarCellPoint(t.mortarCell);
}

// Where a bot's mortar lands. Bots skip the manual walk-around: the AI
// hands us a predicted point and we drop it on the nearest LEGAL
// intersection, so their shells obey exactly the same reach ring and
// 4-cell footprint rules the player's do.
function mortarTarget(t) {
  if (t.mortarAiming && t.mortarAim) return t.mortarAim;
  let ax, ay;
  if (t.mortarAim) { ax = t.mortarAim.x; ay = t.mortarAim.y; }
  else {
    let best = Infinity, e = null;
    for (const o of S.tanks) {
      if (o === t || o.dead || o.gone) continue;
      const d = (o.x - t.x) ** 2 + (o.y - t.y) ** 2;
      if (d < best) { best = d; e = o; }
    }
    if (e) { ax = e.x; ay = e.y; }
    else { ax = t.x + Math.cos(t.a) * CELL * 2; ay = t.y + Math.sin(t.a) * CELL * 2; }
  }
  const cell = nearestMortarCell(t, ax, ay);
  if (cell) return mortarCellPoint(cell);
  // Nothing legal in reach — drop it at the minimum range straight ahead.
  const half = CELL / 2;
  const d = MORTAR.minHalfCells * half;
  return snapToIntersection(t.x + Math.cos(t.a) * d, t.y + Math.sin(t.a) * d);
}

// Launch an arcing shell from (x0,y0) toward the locked cell (tx,ty).
// The flight ACCELERATES: +50% speed per cell traveled (see weapons.js
// for the shared math — every client and the AI use the same curve).
function launchMortar(byId, x0, y0, tx, ty, now) {
  const distCells = Math.hypot(tx - x0, ty - y0) / CELL;
  // Shell Speed shortens the arc's flight time. `flightMs` is stored so
  // the in-flight marker animates against the same figure rather than
  // recomputing the base curve.
  const flightMs = mortarFlightMs(distCells) / upOf(byId).mortarSpeed;
  S.mortars.push({
    by: byId, x0, y0, x: tx, y: ty, born: now,
    distCells, flightMs,
    landAt: now + flightMs,
  });
  sfx.cannon?.(0.75); // big-cannon report, a touch quieter
}

// Concentric damage rings, from the impact centre outward. Radii are
// fractions of a cell. The blast is centred on a grid INTERSECTION and
// reaches a full cell in every direction — a 2-cell span, i.e. the four
// cells meeting at that corner.
// Blast Damage adds to EVERY ring, so the upgrade is worth taking
// whether you land it dead centre or clip someone at the edge.
const MORTAR_RINGS = [
  { r: 0.22, dmg: 8 }, // core: full hit
  { r: 0.48, dmg: 6 },
  { r: 0.74, dmg: 4 },
  { r: 1.00, dmg: 2 }, // outer edge — one whole cell out
];

function detonateMortar(m, now) {
  sfx.boom?.();
  // The dark smoke cloud covering the cell.
  (S.mortarClouds ??= []).push({ x: m.x, y: m.y, born: now, seed: (Math.random() * 1e9) | 0 });
  addFade(m.x, m.y, CELL * MORTAR.blastCells * 0.8, now);
  // Damage rings — the hit FX plays for every tank in the blast on
  // every client; applyHit applies damage only on the authority.
  for (const t of S.tanks) {
    if (t.dead || t.gone) continue;
    const d = Math.hypot(t.x - m.x, t.y - m.y);
    let dmg = 0;
    for (const ring of MORTAR_RINGS) {
      if (d <= ring.r * CELL) { dmg = ring.dmg; break; }
    }
    // Blast Damage lifts every ring, so the upgrade pays whether the
    // shell lands dead centre or only clips someone at the edge.
    if (dmg > 0) applyHit(t, dmg + Math.round(upOf(m.by).mortarDmg), m.by, now, "mortar");
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
    t.armour = ARMOUR.hp + Math.round(t.up?.armourMax ?? 0);
    t.armourUntil = now + ARMOUR.durationMs * (t.up?.armourDuration ?? 1);
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
    addMudPit(mx, my, seed, now, t.id);
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
    t.boostUntil = now + BOOST.durationMs * (t.up?.boostDuration ?? 1);
    t.basicMag = []; // refill: basic attacks available immediately
    t.basicNext = 0;
    sfx.boost?.();
    sendTypedShot(t, { w: "boost" }, now);
  } else if (t.agility === "phase") {
    // Phase: intangibility you can't shoot through — which is why
    // Shorter Phase is an upgrade rather than a nerf. It gets you
    // through the wall and back into the fight sooner.
    t.phaseUntil = now + PHASE.durationMs * (t.up?.phaseDuration ?? 1);
    sfx.phase?.();
    sendTypedShot(t, { w: "phase" }, now);
  }
  // Extra Use lets the pickup fire more than once before it's spent.
  t.agiLeft = (t.agiLeft ?? (1 + Math.round(t.up?.phaseUses ?? 0))) - 1;
  if (t.agiLeft > 0) return;      // keep the slot loaded
  t.agiLeft = 0;
  t.agility = null;
}

// Online receive: one dispatcher for every shot type.
function spawnShot(byId, sh, now = performance.now(), ageMs = 0) {
  // Anything that flies is rewound to when it was actually fired and
  // then replayed forward, so it lands where the shooter has it.
  const before = S.bullets.length;
  const beforeC = S.cannons.length;
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
      if (at) {
        at.armour = ARMOUR.hp + Math.round(at.up?.armourMax ?? 0);
        at.armourUntil = now + ARMOUR.durationMs * (at.up?.armourDuration ?? 1);
      }
      break;
    }
    case "heal": addHealZone(sh.x, sh.y, now); break;
    case "mud": addMudPit(sh.x, sh.y, sh.s ?? 1, now, byId); break;
    case "mortar": launchMortar(byId, sh.x0, sh.y0, sh.x, sh.y, now); break;
    case "flame": {
      // Remote flamethrower: the shooter sends a pulse every FLAME_NET_MS
      // while holding, and each one keeps this peer's stream lit for
      // FLAME_NET_TTL. Cone damage is applied by whoever owns each victim,
      // so nothing is computed here beyond the visual. The remote branch
      // in stepTanks snuffs the stream once the pulses stop.
      const ft = S.tanks.find((x) => x.id === byId);
      if (ft) {
        if (!ft.flameOn) { ft.flameOn = true; ft.flameOnAt = now; }
        ft.flamePulseUntil = now + FLAME_NET_TTL;
      }
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
    case "mini": spawnBullet(byId, sh.x, sh.y, sh.a, now - ageMs, true); break;
    case "laser": fireLaser(byId, sh.x, sh.y, sh.a, now); break;
    case "rocket": spawnRocket(byId, sh.x, sh.y, sh.a, now); break;
    case "cannon": spawnCannon(byId, sh.x, sh.y, sh.a, now); break;
    default: spawnBullet(byId, sh.x, sh.y, sh.a, now - ageMs);
  }
  if (ageMs > 4) {
    for (let i = before; i < S.bullets.length; i++) catchUpBullet(S.bullets[i], ageMs, now);
    for (let i = beforeC; i < S.cannons.length; i++) catchUpBallistic(S.cannons[i], ageMs);
  }
}

// Replay a just-spawned projectile forward through the time its packet
// spent on the wire, using the SAME substepping and wall bounces the
// live simulation uses — so a round that has already ricocheted arrives
// mid-ricochet rather than starting fresh at the muzzle. No tank hits
// are tested during catch-up: hits are shooter-authoritative, and
// re-resolving them here would double-count the damage.
function catchUpBullet(b, ageMs, now) {
  let left = ageMs / 1000;
  const speed = Math.hypot(b.vx, b.vy) || 1;
  while (left > 0) {
    const dt = Math.min(left, 5 / speed);   // ≤5px per step, as stepBullets does
    left -= dt;
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    if (hitWall(b.x, b.y, b.r ?? BULLET_R, b.mini ? "mg" : "basic", now)) { b.dead = true; break; }
    bounceCircle(b, S.rects, b.r ?? BULLET_R);
    bounceSlab(b, S.diag, b.r ?? BULLET_R);
  }
  if (b.dead) S.bullets = S.bullets.filter((x) => x !== b);
}

// Cannon balls travel straight and slowly; the same idea, cheaper.
function catchUpBallistic(c, ageMs) {
  if (!c) return;
  const sec = ageMs / 1000;
  c.x += (c.vx ?? 0) * sec;
  c.y += (c.vy ?? 0) * sec;
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
        // A round the shooter has already resolved against us: swallow
        // it near the hull rather than letting it fly on having
        // "missed" something it has already been paid for.
        if (t.local && b.by !== t.id &&
            (t.x - b.x) ** 2 + (t.y - b.y) ** 2 < (TANK_RAD * 2.4) ** 2 &&
            absorbedBy(t, b, now)) {
          alive = false;
          addFade(b.x, b.y, b.r ?? BULLET_R, now);
          break;
        }
        if (tankHitPoint(t, b.x, b.y, b.r ?? BULLET_R)) {
          alive = false;
          addFade(b.x, b.y, b.r ?? BULLET_R, now);
          // Authority: in local mode we own everyone; online we only
          // pronounce deaths for tanks simulated on this device.
          applyHit(t, b.mini ? DMG.mg : DMG.basic + upOf(b.by).basicDmg,
                   b.by, now, "bullet");
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
  S.mudPits = S.mudPits.filter((m) => now - m.born < (m.life ?? MUD.lifeMs));
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
    // Spawn cadence: 50% faster base, then +25% rate for every tank
    // beyond the first two. As tanks die the count falls, so the rate
    // eases back — reaching the base once only two tanks remain.
    const aliveN = S.tanks.filter((t) => !t.dead && !t.gone).length;
    const rateMul = 1.5 * Math.pow(1.25, Math.max(0, aliveN - 2));
    S.gearNextAt = now + (GEAR_EVERY_MS + Math.random() * GEAR_EVERY_JITTER) / rateMul;
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
        if (g.type === "flame") {
          // A fresh tank of fuel, and a clean slate so the first pull
          // ticks at once and can't be tap-spammed.
          t.flameFuel = FLAME.durationMs + (t.up?.flameFuel ?? 0) * 1000;
          t.flameTickAt = 0;
          t.flameBurn = FLAME.tickMs;
          t.flameOn = false;
          t.flameOnAt = 0;
          t.flameOffAt = 0;
          t.flameNetAt = 0;
        }
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
/* ---------- zone geometry ----------
   The shrinking zone is the arena's OWN outline, stepped inwards one
   cell at a time. It used to be built out of whole grid cells, so on a
   triangular or hexagonal map the boundary came out as a staircase of
   squares that had nothing to do with the arena's actual edges. Insetting
   the polygon instead gives a triangle inside a triangle, with straight
   edges — and because the same polygon drives the damage test, what you
   see is exactly what hurts you.
*/

// Offset a convex polygon inward by `d`, by pushing every edge along its
// inward normal and re-intersecting neighbouring edges. Straight edges
// stay straight and corners stay sharp.
function insetPoly(poly, d) {
  const n = poly.length;
  if (n < 3) return null;
  // Signed area tells us the winding, so the normal points the right way.
  let area = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    area += poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1];
  }
  const sign = area >= 0 ? 1 : -1;
  const lines = [];
  for (let i = 0; i < n; i++) {
    const [x1, y1] = poly[i];
    const [x2, y2] = poly[(i + 1) % n];
    const ex = x2 - x1, ey = y2 - y1;
    const len = Math.hypot(ex, ey) || 1;
    // Inward normal for this winding.
    const nx = (ey / len) * -sign, ny = (-ex / len) * -sign;
    lines.push([x1 + nx * d, y1 + ny * d, x2 + nx * d, y2 + ny * d]);
  }
  const out = [];
  for (let i = 0; i < n; i++) {
    const A = lines[(i + n - 1) % n], B = lines[i];
    const p = lineHit(A, B);
    if (!p) return null;               // collapsed — nothing left inside
    out.push(p);
  }
  return out;
}

function lineHit(A, B) {
  const [ax1, ay1, ax2, ay2] = A, [bx1, by1, bx2, by2] = B;
  const dax = ax2 - ax1, day = ay2 - ay1;
  const dbx = bx2 - bx1, dby = by2 - by1;
  const den = dax * dby - day * dbx;
  if (Math.abs(den) < 1e-9) return null;   // parallel
  const t = ((bx1 - ax1) * dby - (by1 - ay1) * dbx) / den;
  return [ax1 + dax * t, ay1 + day * t];
}

function signedArea(poly) {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    a += poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1];
  }
  return a / 2;
}

function polyArea(poly) {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    a += poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1];
  }
  return Math.abs(a) / 2;
}

function pointInPolyWorld(px, py, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > py) !== (yj > py) &&
        px < ((xj - xi) * (py - yi)) / ((yj - yi) || 1e-9) + xi) inside = !inside;
  }
  return inside;
}

// The safe region at a given layer: the arena outline pulled in by that
// many cells. For a rectangular arena the "polygon" is the box itself,
// so the same code covers every map.
function zonePolyAt(level) {
  const base = S.polyWorld ?? [
    [0, 0], [S.worldW, 0], [S.worldW, S.worldH], [0, S.worldH],
  ];
  if (!level) return base;
  const inset = insetPoly(base, level * CELL);
  if (!inset) return null;
  // An inset past the shape's inradius turns itself inside out and the
  // area starts GROWING again — a triangle inset too far comes back as a
  // triangle pointing the other way. Catch that by checking the winding
  // is unchanged as well as the area, or the zone would reopen into a
  // bogus safe patch at the deepest layers.
  if (polyArea(inset) < CELL * CELL * 0.25) return null;            // closed
  if (signedArea(inset) * signedArea(base) < 0) return null;        // flipped
  // A shape inset past its inradius folds through itself and the area
  // starts GROWING again, so "smaller than the arena" is not enough —
  // each level must also be smaller than the one before it. Once a level
  // closes, everything deeper is closed too.
  if (polyArea(inset) >= polyArea(base)) return null;
  const prev = level > 1 ? insetPoly(base, (level - 1) * CELL) : base;
  if (prev && polyArea(inset) >= polyArea(prev)) return null;
  return inset;
}

// How deep into the closing zone a point is, in cells: 0 = still safe,
// higher = further into the dead ground. Measured against the polygon,
// so it is exact on a diagonal edge rather than rounded to a cell.
function zoneDepthAt(x, y) {
  const base = S.polyWorld ?? [
    [0, 0], [S.worldW, 0], [S.worldW, S.worldH], [0, S.worldH],
  ];
  if (!pointInPolyWorld(x, y, base)) return Infinity;   // outside the arena
  // Distance to the nearest edge, in cells.
  let best = Infinity;
  for (let i = 0, j = base.length - 1; i < base.length; j = i++) {
    const d = ptSegDist(x, y, base[j][0], base[j][1], base[i][0], base[i][1]);
    if (d < best) best = d;
  }
  return best / CELL;
}

function ptSegDist(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const L = dx * dx + dy * dy;
  let t = L > 1e-9 ? ((px - x1) * dx + (py - y1) * dy) / L : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + dx * t), py - (y1 + dy * t));
}

function safeBox() {
  return { c0: 0, r0: 0, c1: S.maze.cols - 1, r1: S.maze.rows - 1 };
}

// Which zone layer a world point sits in (its cell's ring-distance),
// or Infinity if it's outside the shape / off-grid.
function cellLayerAt(x, y) {
  if (!S.zoneActive && !S.zoneDist) return Infinity;
  // Measured against the arena POLYGON rather than looked up per cell, so
  // the boundary is exact on a diagonal edge instead of being rounded out
  // to the nearest square. This is the same geometry the zone is drawn
  // from, which is what keeps the damage honest: if it looks safe, it is.
  const d = zoneDepthAt(x, y);
  return d === Infinity ? Infinity : Math.floor(d);
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
  if (S.zoneNextAt === Infinity) return;

  // --- promote a layer: start its warning blink ---
  if (S.zoneWarnLevel < 0 && S.zoneLevel <= S.zoneMaxLayer && now >= S.zoneNextAt) {
    S.zoneWarnLevel = S.zoneLevel;      // this layer begins blinking
    S.zoneWarnUntil = now + (S.zoneWarn ?? ZONE_WARN_MS);
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
      S.zoneNextAt = now + (S.zonePeriod ?? ZONE_PERIOD);
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
  const up = upOf(byId);
  const pts = laserPath(x, y, a, S.rects,
    LASER.shotBounces + Math.round(up.laserBounce), S.diag);
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
    // Sustained Power: damage holds flat for this many bounces before
    // the usual −1 per reflection starts biting.
    hold: Math.round(up.laserFalloff),
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
          const bounces = Math.max(0, beamBouncesAt(bm, d) - (bm.hold ?? 0));
          const dmg = Math.max(1, DMG.laserBase - bounces);
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
  const up = upOf(byId);
  const speed = BULLET_SPEED * ROCKET.speed * up.rocketSpeed;
  S.rockets.push({
    x, y,
    vx: Math.cos(a) * speed,
    vy: Math.sin(a) * speed,
    born: now,
    by: byId,
    durMul: up.rocketDuration,   // Duration upgrade, fixed at launch
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
    if (age > ROCKET.lifeMs * (rk.durMul ?? 1)) {
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
          applyHit(t, DMG.rocket + upOf(rk.by).rocketDmg, rk.by, now, "bullet");
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
  // The builder's upgrades, looked up from the id. This used to read a
  // bare `t`, which does not exist in this function — placing a wall
  // threw a ReferenceError and killed the frame loop outright.
  const up = upOf(byId);
  const hp = WALL.hp + Math.round(up?.wallHp ?? 0);
  S.walls.push({
    by: byId,
    x, y, a: perp,               // a = orientation of the LONG axis
    hx: half,                    // half-length along `perp`
    hy: WALL.thickCells * CELL * 0.5, // half-thickness
    hp,
    hp0: hp,                     // for the damage tint
    life: WALL.lifeMs * (up?.wallDuration ?? 1),
    born: now,
  });
}

// A green healing pad. Heals any tank that stays inside it (see stepHeal).
function addHealZone(x, y, now) {
  S.healZones.push({ x, y, born: now, r: HEAL.radiusCells * CELL });
}

// A muddy puddle that slows any tank inside it. `seed` drives the
// irregular blob outline so every client draws the same shape.
function addMudPit(x, y, seed, now, byId = null) {
  const rng = mulberry32(seed >>> 0);
  const R = MUD.radiusCells * CELL;
  const N = 11;
  const pts = [];
  for (let i = 0; i < N; i++) {
    const ang = (i / N) * Math.PI * 2;
    const rr = R * (0.72 + rng() * 0.5);          // jittered radius
    pts.push([Math.cos(ang) * rr, Math.sin(ang) * rr * 0.82]); // squashed
  }
  // The pit remembers the Mud Pit upgrades of whoever laid it.
  const up = byId ? upOf(byId) : NO_STATS;
  S.mudPits.push({
    x, y, r: R, born: now, pts,
    life: MUD.lifeMs * up.mudDuration,
    slow: Math.max(0.05, MUD.slow - up.mudSlow),
  });
}

function spawnSnipe(byId, x, y, a, now) {
  sfx.snipe?.();
  const up = upOf(byId);
  const speed = BULLET_SPEED * SNIPER.speed * up.sniperSpeed;
  S.snipes.push({
    x, y,
    vx: Math.cos(a) * speed,
    vy: Math.sin(a) * speed,
    x0: x, y0: y,               // origin, to measure the 5-cell range
    maxDist: (SNIPER.rangeCells + up.sniperRange) * CELL,
    born: now,
    by: byId,
    r: SNIPER.r * BULLET_R,
    mini: true,                 // never counts toward ammo
  });
}

// Damage a brick wall takes per weapon — the SAME numbers tanks take,
// so a 6-HP wall behaves like a 6-HP tank. The laser uses its BASE
// figure here: a fresh, un-bounced beam one-shots a wall, as intended.
// (Stale comments corrected — these said 8 when the value is 7, and
// the cannon ball is 5, not 6.)
const WALL_DMG = {
  basic: DMG.basic,        // 2
  mg: DMG.mg,              // 1
  laser: DMG.laserBase,    // 7 → one hit
  rocket: DMG.rocket,      // 7
  cannon: DMG.cannonBall,  // 5
  shrapnel: DMG.shrapnel,  // 2
  sniper: DMG.sniper,      // 7
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
  S.walls = S.walls.filter((w) => now - w.born < (w.life ?? WALL.lifeMs) && w.hp > 0);
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
        applyHit(t, DMG.sniper + upOf(s.by).sniperDmg, s.by, now, "bullet");
        break;
      }
    }
    if (alive) survivors.push(s);
  }
  S.snipes = survivors;
}

function spawnCannon(byId, x, y, a, now) {
  sfx.cannon();
  const up = upOf(byId);
  const speed = BULLET_SPEED * CANNON.speed * up.cannonSpeed;
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
    // Shell size and the burst it makes are the SHOOTER's, fixed here
    // so the shell behaves the same on every client that sees it.
    sizeMul: up.cannonSize,
    shrapN: CANNON.shrapN + Math.round(up.cannonShrapnel),
    shrapMul: up.shrapSpeed,
    r: CANNON.r * BULLET_R * up.cannonSize, // bots read this to keep clear
    mini: true,             // never counts toward anyone's ammo
  });
}

function stepSnipesWrap() {} // (kept for clarity; stepSnipes called in stepSpecials)

function stepCannons(now, dt) {
  const survivors = [];

  for (const c of S.cannons) {
    if (now - c.born > CANNON.lifeMs) { explodeCannon(c, now); continue; }

    // Per-shell, since the Cannon Size upgrade makes each one its own
    // width. This was being read from `c` ABOVE the loop, where `c` does
    // not exist yet — a ReferenceError that killed the frame the instant
    // physics started, i.e. the moment the countdown hit zero.
    const r = CANNON.r * BULLET_R * (c.sizeMul ?? 1);

    let alive = true;
    c.x += c.vx * dt;
    c.y += c.vy * dt;
    if (hitWall(c.x, c.y, r, "cannon", now)) { explodeCannon(c, now); continue; }
    bounceCircle(c, S.rects, r);
    bounceSlab(c, S.diag, r);

    for (const t of S.tanks) {
      if (t.dead || t.gone) continue;
      // Half a second before your own shell can register on you. Long
      // enough that firing and driving is never self-inflicted; after
      // that it's live against you, so point-blank shots and ricochets
      // still bite.
      if (t.id === c.by && now - c.born < 500) continue;
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
  addFade(c.x, c.y, CANNON.r * BULLET_R * (c.sizeMul ?? 1), now);
  S.booms.push({ x: c.x, y: c.y, born: now, r: CANNON.r * BULLET_R * (c.sizeMul ?? 1) * 4 });
  // A small smoke puff at the point of detonation (reuses the mortar
  // cloud, smaller — the same rising-and-fading render).
  (S.mortarClouds ??= []).push({
    x: c.x, y: c.y, born: now, scale: 0.55, seed: (Math.random() * 1e9) | 0,
  });
  const speed = BULLET_SPEED * CANNON.shrapSpeed * (c.shrapMul ?? 1);
  // Irregular burst, not a perfect ring: seeded jitter on both angle
  // and speed (seeded so online clients all see the same pattern).
  const rng = mulberry32(c.seed ?? 1);
  const shrapN = c.shrapN ?? CANNON.shrapN;
  for (let i = 0; i < shrapN; i++) {
    const a = (i / shrapN) * Math.PI * 2 + (rng() - 0.5) * 0.55;
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
// GHOST ROUNDS.
//
// Hits are shooter-authoritative: their client decides a round
// connected, deletes it on their screen, and tells us. But OUR copy of
// that round is at a slightly different place — everyone else's tank is
// interpolated a frame or two behind — so on our screen it sails past
// and keeps going. The player sees health drop, sparks fly, and the
// bullet carry on as though nothing happened, which reads as the game
// cheating.
//
// So when inbound damage lands, arm a short absorption: the next round
// from that shooter to come near this tank is quietly consumed and
// shown bursting on the hull. The window covers a round that has
// already gone past as well as one that hasn't arrived yet, and it
// deals no further damage — the damage is already applied.
// Make the VICTIM's screen agree with the authoritative result.
//
// The shooter fires at where we were a moment ago (their picture of us is
// interpolated a little behind), so a round that clearly connects on
// their screen can sail past on ours — and we take the damage anyway,
// which looks exactly like being shot through thin air. absorbShot below
// only helps when the round would have collided locally too, which is
// precisely the case that isn't broken. So when a hit lands, find that
// shooter's round near us and END it on us, with the impact, so the two
// screens tell the same story.
function reconcileShot(victim, byId, now) {
  if (!S || S.mode === "local" || !victim) return false;
  const list = S.bullets ?? [];
  let best = -1, bestD = Infinity;
  for (let i = 0; i < list.length; i++) {
    const b = list[i];
    if (byId && b.by !== byId) continue;
    const d = Math.hypot(b.x - victim.x, b.y - victim.y);
    // Generous, because the disagreement between the two views is
    // exactly the interpolation delay times the closing speed.
    if (d < TANK_RAD * 4.5 && d < bestD) { bestD = d; best = i; }
  }
  if (best < 0) return false;
  const b = list[best];
  addFade(b.x, b.y, (BULLET_R ?? 3) * 2.2, now);
  list.splice(best, 1);
  return true;
}

function absorbShot(victim, byId) {
  if (!victim || S.mode === "local") return;
  (victim.absorb ??= []).push({ by: byId ?? null, until: performance.now() + 400 });
}

// Take the pending absorption if this projectile matches one.
function absorbedBy(t, b, now) {
  const list = t.absorb;
  if (!list || !list.length) return false;
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (now > a.until) { list.splice(i--, 1); continue; }
    if (a.by && b.by && a.by !== b.by) continue;
    list.splice(i, 1);
    return true;
  }
  return false;
}

function applyHit(t, amount, byId, now = performance.now(), kind = "bullet") {
  t.lastHitAt = now;           // red damage flash (drawTank)
  addHitSparks(t.x, t.y, now); // metal sparks at the hull
  // Weapon-specific impact: laser burns through metal; ballistic
  // rounds clang off it; the mortar's own detonation boom covers its
  // hit, so it plays no extra impact tone.
  if (kind === "laser") sfx.hitLaser?.();
  else if (kind === "mortar") { /* the boom is the hit */ }
  else sfx.hitMetal?.();

  // ---- WHO DECIDES A HIT LANDED ----
  // Offline, we just apply it. Online we use SHOOTER AUTHORITY: the
  // client that fired the shot decides it connected, and tells the
  // victim. Previously each client re-simulated every projectile
  // against ITS OWN (interpolated, ~130 ms stale) copy of everyone
  // else, so the shooter and the victim routinely disagreed — you'd
  // watch a round hit someone who never took damage, because on their
  // machine they'd already moved. Now what the shooter sees is what
  // counts, while the victim stays authoritative over its own health
  // so hp can never diverge.
  if (S.mode === "local") { damageTank(t, amount, byId); return; }

  const shooter = byId ? S.tanks.find((x) => x.id === byId) : null;
  const mine = !!(shooter && shooter.local);

  if (t.local) {
    // I'm the victim. Apply immediately only when I'm also the shooter
    // (self-inflicted ricochet) or the damage has no owner at all
    // (environmental — the zone, an ownerless blast). Anything fired by
    // a remote peer arrives over the hit channel instead.
    if (mine || !shooter) damageTank(t, amount, byId);
    return;
  }

  if (mine) {
    // My shot, their tank: report it. They apply it.
    sendHitTo(t, amount, byId, kind, now);
  }
  // Otherwise it's someone else's shot on someone else's tank — we just
  // played the FX; their two clients settle the damage between them.
}

// Post an authoritative hit to a remote victim (deduped by key on the
// receiving end, so a re-delivered packet can't double-damage).
function sendHitTo(victim, amount, byId, kind, now) {
  if (!S.sendHit) return;
  const key = Math.floor(now).toString(36) + Math.random().toString(36).slice(2, 8);
  // `r` stamps the ROUND this hit belongs to. Packets outlive a round on
  // the wire, so the receiver drops anything from a round that's already
  // over — damage can never leak across a round boundary.
  S.sendHit(victim.id, key, { d: amount, k: kind, by: byId, r: S.roundN ?? 0 });
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
    if (t.hp <= 0) {
      // Remember the attacker BEFORE killTank runs — it's what the
      // victim reports over the wire so the killer can score a streak.
      t.lastKillerId = (byId && byId !== t.id) ? byId : null;
      killTank(t);
      killed = true;
    }
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
      // NOTE: no streak scoring here. Multi-kills are an ONLINE thing
      // only (custom lobbies) — offline is one player against bots,
      // which doesn't get them.
      // Online, the victim tells the killer over the dead channel.
    }
  }
  return killed;
}

/* ---------- multi-kills ---------- */

// "Is this the tank I'm driving?" Streaks are online-only, where
// exactly one tank is local, so this is simply that flag. (Offline,
// every tank is local — which is part of why streaks don't apply.)
function isMyTank(t) {
  return !!(t && t.local);
}

// Kills landed inside this window of each other chain together. Wide
// enough that a mortar catching two tanks or a laser punching through a
// line both read as one burst, tight enough that unrelated kills a
// fight apart don't.
const MULTIKILL_WINDOW = 4500;
const MULTIKILL_NAMES = {
  2: "DOUBLE KILL",
  3: "TRIPLE KILL",
  4: "QUADRA KILL",
  5: "PENTA KILL",
  6: "HEXA KILL",
  7: "SEPTA KILL",
};
const MULTIKILL_SHOW_MS = 2200;

// Score a kill for `byId`. Only the killer sees their own banner, so we
// bail early for anyone else's kills. A 1v1 has a single opponent and
// so can never chain; the length of a streak falls out naturally from
// how many enemies exist.
function registerKill(byId, now) {
  // Online only: custom lobbies get the full chain, and a 1v1 can't
  // chain at all. Offline (one player vs bots) has no streaks.
  if (!S || S.mode !== "online") return;
  const killer = S.tanks.find((x) => x.id === byId);
  if (!isMyTank(killer)) return;   // only ever show MY own streak

  const chain = (now - (S.mkLastAt ?? -Infinity) <= MULTIKILL_WINDOW)
    ? (S.mkChain ?? 0) + 1
    : 1;
  S.mkChain = chain;
  S.mkLastAt = now;
  if (chain < 2) return;                     // a lone kill isn't news

  const n = Math.min(chain, 7);
  S.multiKill = { text: MULTIKILL_NAMES[n] ?? MULTIKILL_NAMES[7], n, born: now };
  sfx.multiKill?.(n);
}

// Chains don't survive a round boundary or your own death.
function resetMultiKill() {
  if (!S) return;
  S.mkChain = 0;
  S.mkLastAt = -Infinity;
  S.multiKill = null;
}

function killTank(t) {
  if (t.dead) return;
  t.dead = true;
  t.burnUntil = 0; t.burnNextAt = 0; t.flameContact = false;
  t.flameUntil = 0; t.flameOn = false; t.flameOffAt = 0; // a dead tank stops burning/flaming
  if (isMyTank(t)) resetMultiKill(); // dying ends your run
  const now = performance.now();
  // The full send-off: a dedicated explosion sound, a fireball flash,
  // a debris shower, and a lingering smoke pall over the wreck.
  sfx.explosion ? sfx.explosion() : sfx.boom();
  S.booms.push({ x: t.x, y: t.y, born: now, r: TANK_R * 3.2 });
  addFade(t.x, t.y, TANK_R * 1.6, now);
  addHitSparks(t.x, t.y, now);
  addHitSparks(t.x, t.y, now); // double shower — it's an explosion
  (S.mortarClouds ??= []).push({ x: t.x, y: t.y, born: now, seed: (Math.random() * 1e9) | 0 });
  if (S.mode === "online" && t.local) {
    // Stamp WHEN they died on the shared server clock, so peers can tell
    // a real in-round death from a leftover flag when the next round
    // starts (see the stale-dead guard in onlineLobbyUpdate).
    S.sendDead?.(t.id, t.lastKillerId ?? null, S.netClock ? S.netClock() : Date.now());
  }

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

  if (alive.length > 1) return;

  const w = alive[0] ?? null;
  if (w) {
    S.scores[w.id] = (S.scores[w.id] ?? 0) + 1;
    if (S.duel && S.scores[w.id] >= (S.winTarget ?? 5)) {
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

function rosterLabel(p, order) {
  // A player's display name. In LOCAL play the human is "Player 1" and
  // each bot is numbered "Bot 1", "Bot 2", … in roster order. Online,
  // real usernames win; otherwise fall back to the colour name.
  if (p.name) return p.name;
  if (S.mode === "local") {
    if (p.bot) {
      const bots = order.filter((x) => x.bot);
      const n = bots.indexOf(p) + 1;
      return `Bot ${n}`;
    }
    return "Player 1";
  }
  return COLOR_NAMES[p.color];
}

function updateScoreHUD() {
  if (!scoreEl || !S) return;
  const order = S.roster;

  // Build the card shells once (identified by a signature). Rebuilding
  // every score change would trash the animated sprite canvases, so we
  // only lay them out when the roster/labels change and otherwise just
  // poke the score numbers.
  const sig = order.map((p) => `${p.id}:${p.color}:${p.pattern ?? "solid"}:${(p.patColors ?? []).join("-")}` +
    `:${p.colorHex ?? ""}:${(p.patHex ?? []).join("-")}`).join("|");
  if (scoreEl._sig !== sig) {
    scoreEl._sig = sig;
    scoreEl.innerHTML = "";
    scoreEl._scoreEls = {};
    for (const p of order) {
      const card = document.createElement("div");
      card.className = "sc-card";
      card.style.cssText = paintVar(p.color);
      const name = document.createElement("span");
      name.className = "sc-name";
      name.textContent = rosterLabel(p, order);
      const sprite = tankSpriteCanvas({
        color: p.color, pattern: p.pattern, patColors: p.patColors,
      }, 34, p.id);
      const sc = document.createElement("span");
      sc.className = "sc";
      sc.textContent = S.scores[p.id] ?? 0;
      card.append(name, sprite, sc);
      scoreEl.appendChild(card);
      scoreEl._scoreEls[p.id] = sc;
    }
  } else {
    for (const p of order) {
      const el = scoreEl._scoreEls?.[p.id];
      if (el) el.textContent = S.scores[p.id] ?? 0;
    }
  }
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
  // The turret barrel (it points along the hull) must not clip walls
  // either. Walk its centreline and block if any point, inflated by the
  // barrel's half-width, sits inside a wall.
  const bl = BARRELS[t.weapon] ?? BARRELS.normal;
  const bLen = bl.len * TANK_R, bHW = bl.hw * TANK_R;
  const c = Math.cos(a), s = Math.sin(a);
  for (let d = bHW; d <= bLen; d += bHW) {
    const px = x + c * d, py = y + s * d;
    for (const rc of S.rects) {
      if (!nearRect(px, py, rc, bHW + 4)) continue;
      const qx = clamp(px, rc.x, rc.x + rc.w);
      const qy = clamp(py, rc.y, rc.y + rc.h);
      const ox = px - qx, oy = py - qy;
      if (ox * ox + oy * oy < bHW * bHW) return true;
    }
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
// ---- Flame cone: the stream reaches 2/3 of a cell, skinny at the
// nozzle and fanning to a tank's width at the tip. A target is "in" the
// cone if, in the turret frame, it sits between the nozzle and the
// reach, within a half-width that grows linearly from skinny to a full
// tank radius at the tip (plus the target's own radius).
// How far the stream gets before something solid stops it. Fire does
// not go through brickwork: the cone is cut short at the first wall,
// and the same figure drives BOTH the damage test and the drawing, so
// what you see burning is exactly what burns.
//
// Three casts across the width of the cone rather than one down the
// middle, because a stream is wide at the tip — a single centre ray
// would let the edges of the flame lick through a wall corner the
// middle happens to miss.
function flameReach(t) {
  const aim = t.turret ?? t.a;
  const full = FLAME.reachCells * CELL;
  const nozzle = BARRELS.flame.len * TANK_R * 0.5;
  const ox = t.x + Math.cos(aim) * nozzle;
  const oy = t.y + Math.sin(aim) * nozzle;
  const span = full - nozzle;
  if (span <= 0) return 0;
  let shortest = span;
  for (const off of [-0.5, 0, 0.5]) {
    const a2 = aim + off * 0.34;                 // spread across the cone
    const dx = Math.cos(a2), dy = Math.sin(a2);
    let r = castRay(ox, oy, dx, dy, S.rects, span);
    for (const slab of S.diag ?? []) {
      const s2 = castRaySlab(ox, oy, dx, dy, slab, r.hit ? r.d : span);
      if (s2 && s2.d < (r.hit ? r.d : span)) r = s2;
    }
    // Player-built brick walls stop it too.
    for (const w of S.walls ?? []) {
      const s3 = castRaySlab(ox, oy, dx, dy,
        { x: w.x, y: w.y, a: w.a, hx: w.hx, hy: w.hy }, r.hit ? r.d : span);
      if (s3 && s3.d < (r.hit ? r.d : span)) r = s3;
    }
    if (r.hit && r.d < shortest) shortest = r.d;
  }
  return Math.max(0, shortest);
}

function tankInFlameCone(t, o) {
  const aim = t.turret ?? t.a;
  const nozzle = BARRELS.flame.len * TANK_R * 0.5; // stream starts just off the muzzle
  // Only as far as the fire actually gets — a wall between us means no
  // damage, however close the target looks on the compass.
  const reach = nozzle + flameReach(t);
  const dx = o.x - t.x, dy = o.y - t.y;
  const c = Math.cos(aim), s = Math.sin(aim);
  const lx = dx * c + dy * s;   // along the stream
  const ly = -dx * s + dy * c;  // across
  if (lx < nozzle - TANK_R || lx > reach + TANK_R) return false;
  const f = Math.max(0, Math.min(1, (lx - nozzle) / Math.max(1, reach - nozzle)));
  const halfW = (TANK_R * 0.22) + f * (TANK_R * 0.98);
  return Math.abs(ly) < halfW + TANK_R * 0.9;
}

// ---- Burn (damage over time) --------------------------------------
// The flamethrower's burn is DEFERRED: it never overlaps the direct
// flame damage. stepFlameBurns watches every tank that the flame is
// touching and, once the stream comes OFF it (no flame hit for
// FLAME.contactGraceMs), starts a burn — 1 dmg every 1 s for 3 s.
function stepFlameBurns(now) {
  for (const o of S.tanks) {
    if (!o.flameContact) continue;
    if (o.dead || o.gone) { o.flameContact = false; continue; }
    if (now - (o.flameHitAt ?? 0) >= FLAME.contactGraceMs) {
      // The flame has left this tank — light the after-burn. (Re-flaming
      // before it ends simply refreshes it, since flameContact goes true
      // again and this re-arms once contact ends anew.)
      o.flameContact = false;
      // Burn Duration belongs to whoever lit the fire, not the victim.
      const bUp = upOf(o.flameHitBy ?? null);
      o.burnUntil = now + FLAME.burnTotalMs + bUp.flameBurn * 1000 + 60; // +margin
      o.burnNextAt = now + FLAME.burnEveryMs;     // first burn tick 1 s after contact ends
      o.burnBy = o.flameHitBy ?? null;
    }
  }
}

// Regeneration, both flavours.
//
// Health ticks every 17 s and armour every 34 s, per the tree. Both are
// deliberately slow enough to matter between engagements rather than
// during one — a tank that out-heals incoming fire would be miserable
// to play against.
//
// Only the authority ticks these: offline that's us, online it's each
// tank's owner, so a regen tick can't be applied twice by two clients
// watching the same tank.
const REGEN_MS = 17000;
const ARMOUR_REGEN_MS = 34000;

function stepRegen(now) {
  if (!S.upgradesOn) return;
  for (const t of S.tanks) {
    if (t.dead || t.gone) continue;
    if (S.mode === "online" && !t.local) continue;   // owner ticks it
    const up = t.up;
    if (!up) continue;

    if (up.regen > 0) {
      t.regenAt = t.regenAt || now + REGEN_MS;
      if (now >= t.regenAt) {
        t.regenAt = now + REGEN_MS;
        const cap = t.maxHp ?? TANK_HP;
        if (t.hp < cap) {
          // The HUD is rebuilt from tank state every frame, so there
          // is nothing to notify.
          t.hp = Math.min(cap, t.hp + up.regen);
        }
      }
    }

    if (up.armourRegen > 0) {
      t.armourRegenAt = t.armourRegenAt || now + ARMOUR_REGEN_MS;
      if (now >= t.armourRegenAt) {
        t.armourRegenAt = now + ARMOUR_REGEN_MS;
        const cap = ARMOUR.hp + Math.round(up.armourMax);
        if ((t.armour ?? 0) < cap) {
          t.armour = Math.min(cap, (t.armour ?? 0) + up.armourRegen);
          // Armour earned this way persists like the starting plate.
          if (!t.armourUntil || t.armourUntil < now) t.armourUntil = Number.MAX_SAFE_INTEGER;
        }
      }
    }
  }
}

function stepBurns(now) {
  for (const o of S.tanks) {
    if (o.dead || o.gone || !o.burnUntil) continue;
    if (o.flameContact) continue; // the flame is still on them — no burn yet
    if (now >= o.burnUntil) { o.burnUntil = 0; o.burnNextAt = 0; continue; }
    if (now >= (o.burnNextAt ?? Infinity)) {
      o.burnNextAt = now + FLAME.burnEveryMs;
      o.lastHitAt = now; // brief red flash per burn tick
      // applyHit routes by mode: direct damage offline, shooter-authority
      // online (the client that owns the flame sends each burn tick to
      // the victim), so the burn now actually lands in both.
      applyHit(o, FLAME.burnDmg, o.burnBy ?? null, now, "burn");
    }
  }
}

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
// Sample the flame's colour ramp 0..1 nozzle→tip: blue → white → yellow
// → orange → red, like a real torch.
function flameColorAt(u) {
  const stops = [
    [0.00, 90, 150, 255],   // blue
    [0.22, 235, 245, 255],  // white-hot
    [0.45, 255, 235, 120],  // yellow
    [0.70, 255, 150, 40],   // orange
    [1.00, 220, 55, 30],    // red
  ];
  u = Math.max(0, Math.min(1, u));
  for (let i = 1; i < stops.length; i++) {
    if (u <= stops[i][0]) {
      const a = stops[i - 1], b = stops[i];
      const k = (u - a[0]) / (b[0] - a[0]);
      return [
        Math.round(a[1] + (b[1] - a[1]) * k),
        Math.round(a[2] + (b[2] - a[2]) * k),
        Math.round(a[3] + (b[3] - a[3]) * k),
      ];
    }
  }
  return [220, 55, 30];
}

// The animated flamethrower cone. It extends over FLAME_GROW_MS on
// trigger-down, holds while the button is held, and pulls in over
// FLAME_FADE_MS on release. Built in layers: a COOL opaque outer tongue
// and a HOT inner tongue (normal blend, so the stream reads on ANY floor
// — pure additive fire is invisible on the white arena), then additive
// wisps, drifting embers, and a blue-white pilot for the glow and life.
function drawFlameStream(t, now) {
  const aim = t.turret ?? t.a;
  const reach = FLAME.reachCells * CELL;
  const nozzle = BARRELS.flame.len * TANK_R * 0.5;
  const grow = t.flameOn
    ? Math.max(0, Math.min(1, (now - (t.flameOnAt ?? now)) / FLAME_GROW_MS))
    : 1;
  const fade = t.flameOn
    ? 1
    : Math.max(0, Math.min(1, 1 - (now - (t.flameOffAt ?? 0)) / FLAME_FADE_MS));
  // Clamp to whatever the stream can actually reach: the animation
  // stops dead at a wall instead of painting fire on the far side of
  // it. Same figure the damage test uses, so they can never disagree.
  const len = Math.min((reach - nozzle) * grow, flameReach(t)) * fade;
  if (len <= 1) return;

  const tipHalf = TANK_R * 1.05;
  const rootHalf = TANK_R * 0.16;
  const tms = now / 1000;

  ctx.save();
  ctx.translate(t.x, t.y);
  ctx.rotate(aim);

  const cAt = (u, a) => { const [r, g, b] = flameColorAt(u); return `rgba(${r},${g},${b},${a})`; };

  // A wavy flame TONGUE from the nozzle out to length L, its tip curling
  // and its sides rippling so the fire never looks like a static cone.
  const tongue = (L, maxHalf, curlAmt, ph) => {
    const tp = nozzle + L;
    const curl = Math.sin(tms * 9 + ph) * maxHalf * curlAmt;
    ctx.beginPath();
    ctx.moveTo(nozzle, -rootHalf);
    ctx.quadraticCurveTo(nozzle + L * 0.45, -maxHalf * (0.9 + 0.12 * Math.sin(tms * 15 + ph)),
                         tp, -maxHalf * 0.28 + curl);
    ctx.quadraticCurveTo(tp + maxHalf * 0.5, curl, tp, maxHalf * 0.28 + curl);
    ctx.quadraticCurveTo(nozzle + L * 0.45, maxHalf * (0.9 + 0.12 * Math.sin(tms * 15 + ph + 2)), nozzle, rootHalf);
    ctx.closePath();
  };

  // ---- Pass 1a: cool OUTER body (opaque → visible on white) ----
  tongue(len, tipHalf, 0.10, 0.4);
  const outer = ctx.createLinearGradient(nozzle, 0, nozzle + len, 0);
  outer.addColorStop(0.00, cAt(0.50, 0.30 * fade));
  outer.addColorStop(0.32, cAt(0.62, 0.92 * fade));
  outer.addColorStop(0.72, cAt(0.82, 0.95 * fade));
  outer.addColorStop(0.92, cAt(0.99, 0.72 * fade));
  outer.addColorStop(1.00, cAt(1.00, 0.0));
  ctx.fillStyle = outer;
  ctx.fill();

  // ---- Pass 1b: hot INNER core (shorter, brighter) ----
  const coreLen = len * 0.66;
  tongue(coreLen, tipHalf * 0.55, 0.14, 2.1);
  const core = ctx.createLinearGradient(nozzle, 0, nozzle + coreLen, 0);
  core.addColorStop(0.00, cAt(0.12, 0.55 * fade));
  core.addColorStop(0.30, cAt(0.30, 0.95 * fade));
  core.addColorStop(0.72, cAt(0.50, 0.85 * fade));
  core.addColorStop(1.00, cAt(0.66, 0.0));
  ctx.fillStyle = core;
  ctx.fill();

  // ---- Pass 2: additive wisps (soft glow on dark floors) ----
  ctx.globalCompositeOperation = "lighter";
  const steps = 16;
  for (let layer = 0; layer < 3; layer++) {
    const lay = layer - 1;
    for (let i = 0; i <= steps; i++) {
      const u = i / steps;
      const along = nozzle + u * len;
      const half = rootHalf + (tipHalf - rootHalf) * u;
      const flick = Math.sin(tms * 18 + i * 0.9 + layer * 2.1) * half * 0.28
        + Math.sin(tms * 27 - i * 1.7) * half * 0.14;
      const off = lay * half * 0.5 + flick;
      const [r, g, b] = flameColorAt(u);
      const a = (0.26 - 0.18 * u) * (1 - Math.abs(lay) * 0.3) * fade;
      const rad = half * (0.85 + 0.35 * Math.sin(tms * 20 + i));
      const gr = ctx.createRadialGradient(along, off, 0, along, off, rad);
      gr.addColorStop(0, `rgba(${r},${g},${b},${a})`);
      gr.addColorStop(1, `rgba(${r},${g},${b},0)`);
      ctx.fillStyle = gr;
      ctx.beginPath();
      ctx.arc(along, off, rad, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // ---- Pass 3: embers streaming off the flame (still additive) ----
  const rng = patRng((t.id ?? 0) + ":ember");
  for (let i = 0; i < 12; i++) {
    const r0 = rng();
    const speed = 0.5 + r0 * 0.7;
    const prog = ((tms * speed) + r0 * 3.1 + i * 0.13) % 1;   // 0→1 nozzle→tip, loops
    const along = nozzle + prog * len;
    const off = ((r0 - 0.5) * tipHalf * 0.6 + Math.sin(tms * 6 + i) * tipHalf * 0.5) * prog;
    const a = (1 - prog) * 0.8 * fade;
    const rad = Math.max(0.6, (1 - prog) * tipHalf * 0.18 + 0.6);
    const [r, g, b] = flameColorAt(0.4 + prog * 0.6);
    ctx.fillStyle = `rgba(${r},${g},${b},${a})`;
    ctx.beginPath();
    ctx.arc(along, off, rad, 0, Math.PI * 2);
    ctx.fill();
  }

  // ---- Pass 4: bright blue-white pilot flame at the nozzle ----
  const cg = ctx.createRadialGradient(nozzle, 0, 0, nozzle, 0, rootHalf * 3.4);
  cg.addColorStop(0, `rgba(210,235,255,${0.75 * fade})`);
  cg.addColorStop(1, "rgba(120,170,255,0)");
  ctx.fillStyle = cg;
  ctx.beginPath();
  ctx.arc(nozzle, 0, rootHalf * 3.4, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

// Small flames licking off a burning tank + rising embers.
function drawBurn(t, now) {
  ctx.save();
  ctx.translate(t.x, t.y);
  ctx.globalCompositeOperation = "lighter";
  const tms = now / 1000;
  const n = 5;
  for (let i = 0; i < n; i++) {
    const ang = (i / n) * Math.PI * 2 + tms * 0.6;
    const rx = Math.cos(ang) * TANK_R * 0.5;
    const ry = Math.sin(ang) * TANK_R * 0.5;
    const lick = (Math.sin(tms * 12 + i * 2) * 0.5 + 0.5);
    const rad = TANK_R * (0.22 + 0.14 * lick);
    const rise = -TANK_R * 0.3 * lick;
    const [r, g, b] = flameColorAt(0.4 + 0.5 * lick);
    const gr = ctx.createRadialGradient(rx, ry + rise, 0, rx, ry + rise, rad);
    gr.addColorStop(0, `rgba(${r},${g},${b},0.5)`);
    gr.addColorStop(1, `rgba(${r},${g},${b},0)`);
    ctx.fillStyle = gr;
    ctx.beginPath();
    ctx.arc(rx, ry + rise, rad, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

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

  // Render at 2560x1440. The backing store is scaled up to fill that
  // budget without exceeding it, so on a 16:9 display it lands exactly
  // on 2560x1440 and on anything else it gets as close as the aspect
  // allows. Bounded either way, so it can't run away on a big monitor.
  // ADAPTIVE RESOLUTION. 2560x1440 is up to 4x the pixels of a 1:1
  // canvas, and on a mid-range GPU that alone can hold the game under
  // 60fps — every fill, stroke and blit pays for it. Aim for the full
  // budget, but back off when frames are running long and recover when
  // they aren't, so the game stays smooth first and sharp second.
  const target = Math.max(1, Math.min(RENDER_W / Math.max(1, cw), RENDER_H / Math.max(1, ch)));
  const dpr = target * (S.resScale ?? 1);
  if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)) {
    canvas.width = Math.round(cw * dpr);
    canvas.height = Math.round(ch * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cw, ch);
  // Backstop: the ground texture runs well past the arena, but fill the
  // whole viewport with the concrete's own tone first so there is no
  // circumstance — any aspect, any arena shape — where bare canvas shows.
  ctx.fillStyle = "#8e8e8a";
  ctx.fillRect(0, 0, cw, ch);

  const pad = 8;
  const s = Math.min((cw - pad * 2) / S.worldW, (ch - pad * 2) / S.worldH);
  // Remembered so the countdown prewarm can bake at exactly the density
  // the round will be shown at — bake at the wrong one and it is all
  // thrown away and done again on the first frame.
  S.viewScale = s;
  S.viewDpr = dpr;
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
  // The ground goes down FIRST and UNCLIPPED. On a shaped arena the
  // silhouette clip below used to cut the concrete to the play area, so
  // everything outside an angled edge fell back to flat grey — which is
  // why some maps had bare background beyond the wall. The ground is the
  // world; only the things standing on it get clipped.
  const scene = buildScene(S.worldW, S.worldH, S.rects ?? [], S.groundSeed ?? 1, s * dpr, S.maze, CELL, S.diag);
  // Hand the renderer the visible world rect so it only copies what the
  // camera can see, instead of the whole padded ground bitmap.
  drawGround(ctx, scene, {
    x: -ox / s, y: -oy / s,
    w: cw / s, h: ch / s,
  });

  let clippedToShape = false;
  if (S.polyWorld) {
    ctx.save();
    tracePoly(S.polyWorld);
    ctx.clip();
    clippedToShape = true;
  }

  // Tread marks go straight onto the floor — under the zone tint, under
  // the walls, and under everything that moves.
  drawTracks(now);

  // Zone shrink: the dead ring is simply gone — plain white canvas
  // where it used to be. Nothing to draw; the walls there were already
  // stripped from S.rects when the ring dropped.

  // Closing zone: cells already claimed glow a steady red; the
  // layer currently being warned blinks. Painted per-cell UNDER the
  // walls. On shaped arenas the diagonal cuts through boundary cells,
  // so an outside cell can still hold a thin interior sliver — we paint
  // those bordering-outside cells too (the polygon clip trims the rest)
  // to avoid white gaps hugging the angled edge.
  if (S.zoneActive && S.zoneDist) {
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
    // Painted as ONE rounded region per state rather than a cell-by-cell
    // grid of squares. A square per cell gives a hard stair-stepped edge
    // that looks especially wrong on a map that isn't square; rounding
    // each cell's outer corners and overlapping them into a single path
    // lets the boundary read as a closing ring that follows the arena's
    // actual shape.
    const cellState = [];
    for (let r = 0; r < rows; r++) {
      cellState[r] = [];
      for (let c = 0; c < cols; c++) {
        let st = stateAt(r, c);
        if (st === 0 && (S.zoneDist[r][c] === Infinity)) {
          st = Math.max(stateAt(r - 1, c), stateAt(r + 1, c), stateAt(r, c - 1), stateAt(r, c + 1));
        }
        cellState[r][c] = st;
      }
    }
    // Painted as a smooth CONTOUR of the region rather than a grid of
    // rounded squares. Marching-squares over the cell states gives the
    // outline of the doomed area as real polygons, and running those
    // through a corner-cutting pass turns the staircase into a flowing
    // boundary that follows the arena's shape — including the outside of
    // a non-rectangular map, where per-cell rounding looked worst.
    // The zone as REAL GEOMETRY: the arena's own outline, stepped inward
    // one cell per layer. On a triangular map the dead ground is the
    // triangle minus a smaller triangle — straight edges, sharp corners,
    // no staircase of squares and no blur. Drawn even-odd so the safe
    // interior is punched cleanly out of the dead region.
    const drawRing = (outer, inner, style) => {
      if (!outer) return;
      ctx.fillStyle = style;
      ctx.beginPath();
      ctx.moveTo(outer[0][0], outer[0][1]);
      for (let i2 = 1; i2 < outer.length; i2++) ctx.lineTo(outer[i2][0], outer[i2][1]);
      ctx.closePath();
      if (inner) {
        ctx.moveTo(inner[0][0], inner[0][1]);
        for (let i2 = 1; i2 < inner.length; i2++) ctx.lineTo(inner[i2][0], inner[i2][1]);
        ctx.closePath();
      }
      ctx.fill("evenodd");
    };

    const arena = zonePolyAt(0);
    const deadEdge = zonePolyAt(S.zoneLevel ?? 0);      // inside this is not yet dead
    // Everything already fallen: from the arena edge in to the current level.
    drawRing(arena, deadEdge, "rgba(200, 32, 30, 0.42)");

    // The layer that is currently blinking its warning, one cell deeper.
    if ((S.zoneWarnLevel ?? -1) >= 0 && deadEdge) {
      const warnInner = zonePolyAt((S.zoneWarnLevel ?? 0) + 1);
      const a0 = ctx.globalAlpha;
      ctx.globalAlpha = a0 * (0.22 + 0.28 * blink);
      drawRing(deadEdge, warnInner, "rgb(255, 45, 40)");
      ctx.globalAlpha = a0;
    }
  }

  // Mud is a puddle ON THE GROUND, so it goes down before the masonry.
  // Drawn after the walls it lapped OVER them wherever a pit was thrown
  // near one, which made the wall look like it was standing in front of
  // nothing.
  for (const m of S.mudPits) drawMudPit(m, now);

  // Walls: stone brick, markedly darker than the floor, with the shadow
  // the sun casts from them laid down first.
  drawWallLayer(ctx, scene, {
    x: -ox / s, y: -oy / s, w: cw / s, h: ch / s,
  });

  // Shaped arena: just lift the silhouette clip. The angled border used
  // to be painted here as a flat grey stroke, which is why it was the
  // one wall in the arena with no brick on it and no shadow under it.
  // It is now baked into the wall layer above alongside every other
  // wall, from the same slab geometry the collision uses.
  if (clippedToShape) ctx.restore();

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
      // Pale, dry grit — it has to sit LIGHTER than the concrete under
      // it. The old blue-grey was picked when the floor was white paper
      // and simply vanished once the ground became grey.
      ctx.fillStyle = d.boost ? "#e6ded0" : "#d8d2c4";
      // A puff is a few overlapping lobes that spread and drift apart as
      // it ages, so the silhouette is ragged like real kicked-up dust
      // rather than a clean circle.
      const dx0 = d.x + d.vx * k, dy0 = d.y + d.vy * k;
      const R0 = TANK_R * (0.16 + k * 0.34);
      const spread = 1 + k * 1.5;
      const rot = (d.spin ?? 0) * k;
      const cs = Math.cos(rot), sn = Math.sin(rot);
      ctx.globalAlpha = (d.boost ? 0.42 : 0.34) * (1 - k) * (1 - k * 0.3);
      ctx.beginPath();
      // Two lobes, not four: the silhouette still reads as irregular and
      // it halves the arc count, which with a few tanks driving was a
      // meaningful slice of the frame.
      for (const lo of (d.lobes ?? [{ ox: 0, oy: 0, r: 1 }]).slice(0, 2)) {
        const lx = (lo.ox * cs - lo.oy * sn) * R0 * spread;
        const ly = (lo.ox * sn + lo.oy * cs) * R0 * spread;
        ctx.moveTo(dx0 + lx + lo.r * R0, dy0 + ly);
        ctx.arc(dx0 + lx, dy0 + ly, lo.r * R0, 0, Math.PI * 2);
      }
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;

  // Heal pads sit on the floor under the tanks. (Mud is drawn earlier,
  // beneath the walls — see below.)
  for (const z of S.healZones) drawHealZone(z, now);

  // Mortar: impact smoke clouds, in-flight landing markers, and the
  // shooter's own aiming reticle — all on the ground, under the tanks.
  if (S.mortarClouds) for (const c of S.mortarClouds) drawMortarCloud(c, now);
  for (const m of S.mortars) drawMortarMarker(m, now);
  if (S.mortarAims) for (const a of S.mortarAims) drawMortarReticle(a, now);
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

  for (const g of S.gear) drawGear(ctx, g, TANK_R, pulse, now);

  for (const t of S.tanks) if (t.dead && !t.gone) drawWreck(t);
  for (const L of S.laserPaths ?? []) drawLaserPreview(L);
  for (const A of S.sniperAims ?? []) drawSniperAim(A);
  drawTankShadows(now);   // all shadows first, so none lands on a hull
  for (const t of S.tanks) if (!t.dead && !t.gone) drawTank(t, now);

  // Placed walls throw the same shadow the permanent masonry does —
  // same height, same sun, same swept shape — so a dropped wall sits in
  // the scene rather than floating on top of it.
  if (S.walls.length) {
    // A dropped barricade is a lower thing than the arena's masonry, so
    // it throws a correspondingly shorter shadow (permanent walls use 20
    // in scene.js).
    const WH = 13;
    const ox = SHADOW.dx * WH, oy = SHADOW.dy * WH;
    ctx.save();
    ctx.fillStyle = "rgba(20,22,25,0.34)";
    for (const w of S.walls) {
      if ((w.hp ?? 1) <= 0) continue;
      const c = Math.cos(w.a), sn = Math.sin(w.a);
      const pts = [];
      for (const [lx, ly] of [[-w.hx, -w.hy], [w.hx, -w.hy], [w.hx, w.hy], [-w.hx, w.hy]]) {
        const wx = w.x + lx * c - ly * sn, wy = w.y + lx * sn + ly * c;
        pts.push([wx, wy], [wx + ox, wy + oy]);     // footprint AND its offset
      }
      const hull = convexHull2(pts);
      if (!hull.length) continue;
      ctx.beginPath();
      ctx.moveTo(hull[0][0], hull[0][1]);
      for (let i = 1; i < hull.length; i++) ctx.lineTo(hull[i][0], hull[i][1]);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }

  // The barricade itself, on top of the shade it casts.
  for (const w of S.walls) drawWall(w, now);

  // Walls throw their shadows across the tanks too, not just the floor.
  castWallShadowsOnTanks(scene);

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
    ctx.arc(c.x, c.y, CANNON.r * BULLET_R * (c.sizeMul ?? 1), 0, Math.PI * 2);
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
    ctx.globalAlpha = 1;
  }

  // Flamethrower streams: a short animated cone per firing tank, skinny
  // at the nozzle and fanning to a tank's width at the tip. It extends
  // smoothly on trigger-down, holds while the button is down, and pulls
  // back in over FLAME_FADE_MS on release. Colour runs blue → white →
  // yellow → orange → red from the nozzle out, like a real torch.
  for (const t of S.tanks) {
    if (t.dead || t.gone) continue;
    const flaming = t.flameOn || (t.flameOffAt && now - t.flameOffAt < FLAME_FADE_MS);
    if (!flaming) continue;
    drawFlameStream(t, now);
  }

  // Burning tanks: small licking flames + embers rising off the hull
  // for as long as the burn lasts.
  for (const t of S.tanks) {
    if (t.dead || t.gone || !t.burnUntil || now >= t.burnUntil) continue;
    drawBurn(t, now);
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
  // The bottom-right loadout panel is retired: P1 now uses the SAME
  // compact stacked row as every other local player (see below).
  // P1's old bottom-left health/armour bars are gone — everyone uses the
  // compact stacked rows now. The bottom-right loadout stays for MOBILE
  // only: it's the touch player's interactive ability buttons.
  if (loadoutHudEl) {
    const alive = myTank && !myTank.dead && !myTank.gone;
    if (!IS_TOUCH_DEVICE || !alive) {
      loadoutHudEl.hidden = true; loadoutHudEl._sig = undefined;
    } else {
      const items = { offense: myTank.weapon ?? null, defense: myTank.defense ?? null, agility: myTank.agility ?? null };
      const sig = `${items.offense}|${items.defense}|${items.agility}`;
      loadoutHudEl.hidden = false;
      if (loadoutHudEl._sig !== sig) {
        loadoutHudEl._sig = sig;
        for (const cv of loadoutHudEl.querySelectorAll(".loadout-icon")) drawLoadoutIcon(cv, items[cv.dataset.cat]);
        for (const lbl of loadoutHudEl.querySelectorAll(".loadout-key")) {
          const type = items[lbl.dataset.cat];
          lbl.textContent = type ? (WEAPON_LABEL[type] ?? type) : "";
          lbl.style.color = type ? (GEAR_RIM[type] ?? "#e8eefc") : "";
        }
      }
    }
  }

  // ALL LOCAL PLAYERS share one compact readout, stacked UPWARD. P1 sits
  // at the bottom (no "P1" tag); couch co-op / local seats 2–4 stack
  // above. Each row: armour + health (health tinted to that player's
  // tank colour) and the three equipped abilities shown as their ACTUAL
  // pickup-crate icons on a 70%-opacity plate of the tank colour.
  if (p2HudEl) {
    const locals = S.tanks.filter((t) => t.local && !t.bot && !t.dead && !t.gone);
    // Primary first (bottom), then the rest in a stable order.
    const primaryId = myTank && myTank.id;
    locals.sort((a, b) => {
      if (a.id === primaryId) return -1;
      if (b.id === primaryId) return 1;
      return String(a.id).localeCompare(String(b.id));
    });
    if (!locals.length) {
      p2HudEl.hidden = true;
      p2HudEl._sig = undefined;
    } else {
      const label = { red: "", green: "P2", blue: "P3", yellow: "P4" };
      const sig = locals.map((t) => {
        const hp = Math.max(0, Math.ceil(t.hp ?? TANK_HP));
        const ar = now < (t.armourUntil ?? 0) ? Math.max(0, Math.ceil(t.armour ?? 0)) : 0;
        return `${t.id}:${hp}:${ar}:${t.weapon}:${t.defense}:${t.agility}:${effBaseHex(t)}`;
      }).join("|");
      p2HudEl.hidden = false;
      if (p2HudEl._sig !== sig) {
        p2HudEl._sig = sig;
        p2HudEl.innerHTML = locals.map((t, idx) => {
          const hex = effBaseHex(t);
          const hp = Math.max(0, Math.ceil(t.hp ?? TANK_HP));
          const ar = now < (t.armourUntil ?? 0) ? Math.max(0, Math.ceil(t.armour ?? 0)) : 0;
          const isPrimary = t.id === primaryId;
          const name = isPrimary ? "" : (label[t.slot ?? t.color] ?? `P${idx + 1}`);
          let hpips = "";
          for (let i = 0; i < TANK_HP; i++) {
            hpips += `<span class="lp-pip${i < hp ? "" : " spent"}"${i < hp ? ` style="background:${hex};border-color:${hex}"` : ""}></span>`;
          }
          let apips = "";
          for (let i = 0; i < ar; i++) apips += `<span class="lp-ar"></span>`;
          const items = [t.weapon ?? null, t.defense ?? null, t.agility ?? null];
          // Real ability image per slot: a canvas we paint via drawGear.
          const load = items.map((it, k) =>
            `<canvas class="lp-icon" width="44" height="44" data-tank="${t.id}" data-slot="${k}" data-type="${it ?? ""}"></canvas>`
          ).join("");
          const plate = hexToRgba(hex, 0.7);
          return `<div class="lp-row">
              ${name ? `<span class="lp-tag" style="color:${hex}">${name}</span>` : ""}
              <span class="lp-bars">
                ${ar ? `<span class="lp-ars">${apips}</span>` : ""}
                <span class="lp-hps">${hpips}</span>
              </span>
              <span class="lp-load" style="background:${plate}">${load}</span>
            </div>`;
        }).join("");
        // Paint each ability canvas with the true pickup crate image.
        for (const cv of p2HudEl.querySelectorAll(".lp-icon")) {
          drawLoadoutIcon(cv, cv.dataset.type || null);
        }
      }
    }
  }

  // Armour readout: blue pips above health, shown only while the shield
  // is up. Rebuilt only when the count changes.

  // Multi-kill banner across the top of the arena.
  if (multiKillEl) {
    const mk = S.multiKill;
    const age = mk ? now - mk.born : Infinity;
    if (mk && age < MULTIKILL_SHOW_MS) {
      const sig = `${mk.text}:${mk.born}`;
      if (multiKillEl._sig !== sig) {
        multiKillEl._sig = sig;
        multiKillEl.hidden = false;
        multiKillEl.className = `multikill mk-${mk.n}`;
        multiKillEl.textContent = mk.text;
        // restart the pop animation
        void multiKillEl.offsetWidth;
      }
      // Fade over the last third of its life.
      multiKillEl.classList.toggle("is-out", age > MULTIKILL_SHOW_MS * 0.66);
    } else if (!multiKillEl.hidden) {
      multiKillEl.hidden = true;
      multiKillEl._sig = undefined;
      S.multiKill = null;
    }
  }

  // The closing-zone timer lives in the top bar. It counts down to the
  // next layer, flips to a red "CLOSING" flash while a layer blinks,
  // and disappears once the whole map is red.
  if (shrinkEl) {
    const zoneActive = S.zoneNextAt !== Infinity || (S.zoneWarnLevel ?? -1) >= 0;
    if (zoneActive && !counting) {
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
    } else if (!zoneActive) {
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
  // Tinted with the owning tank's paint so two local players aiming at
  // once can tell their reticles apart (falls back to the old red).
  const tint = a.color ?? "#e8452e";
  ctx.strokeStyle = paintHexToRGBA(tint, 0.55 + 0.35 * pulse);
  ctx.lineWidth = 2.5;
  const r = MORTAR.blastCells * CELL;   // the real blast radius
  // The 2x2 footprint it will flatten.
  ctx.globalAlpha = 0.16 + 0.10 * pulse;
  ctx.fillStyle = tint;
  ctx.fillRect(-CELL, -CELL, CELL * 2, CELL * 2);
  ctx.globalAlpha = 1;
  ctx.strokeRect(-CELL, -CELL, CELL * 2, CELL * 2);
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.stroke();
  // Cross-hairs through the intersection.
  ctx.beginPath();
  for (const [sx, sy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
    ctx.moveTo(sx * r * 0.25, sy * r * 0.25);
    ctx.lineTo(sx * r * 0.85, sy * r * 0.85);
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
  ctx.arc(0, 0, MORTAR.blastCells * CELL * (1.0 + 0.06 * pulse), 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 0.9;
  ctx.fillStyle = "#ff5a3c";
  ctx.beginPath();
  ctx.arc(0, 0, TANK_R * 0.6, 0, Math.PI * 2);
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
  const lift = arc * CELL * 3.2;        // peak height ~3.2 cells
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
  const R = CELL * MORTAR.blastCells * grow * (c.scale ?? 1);
  const rng = mulberry32(c.seed >>> 0);
  ctx.save();
  ctx.translate(c.x, c.y);
  ctx.globalAlpha = 0.72 * fade;
  // A few overlapping dark puffs for a smoky, non-circular blob.
  for (let i = 0; i < 11; i++) {
    const ang = (i / 11) * Math.PI * 2 + rng() * 0.6;
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
  const frac = Math.max(0, w.hp / (w.hp0 ?? WALL.hp));
  if (frac < 1) {
    ctx.fillStyle = `rgba(20,10,6,${(1 - frac) * 0.4})`;
    ctx.fillRect(-L, -T, L * 2, T * 2);
  }
  ctx.restore();
}

// The hull fill for a paint id. Ordinary paints are a flat colour;
// the shop's specials are MATERIALS, shaded by material.js — the same
// module the preview canvases use, so bronze on the battlefield is the
// bronze you bought in the shop.
//
// Nothing here reads the clock. The old finishes scrolled a highlight
// across the hull on a timer, which made a metal tank read as an
// effect rather than as metal; a real material's response is fixed to
// the object and its light, so that is how it's drawn now.
//
// The effective BASE hex a tank is wearing right now, honouring any
// paint override so beams/effects match the hull the player sees.
function hexToRgba(hex, a) {
  const n = parseInt(String(hex).slice(1), 16) || 0;
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

function effBaseHex(t) {
  if (!t) return HULL.red;
  const pat = t.pattern && t.pattern !== "solid" ? t.pattern : null;
  if (pat && Array.isArray(t.patHex) && t.patHex[0]) return t.patHex[0];
  if (!pat && t.colorHex) return t.colorHex;
  const pc = Array.isArray(t.patColors) ? t.patColors : [];
  return HULL[pat && pc[0] ? pc[0] : t.color] ?? HULL.red;
}

function hullPaint(color, R, hexOverride, ang = 0) {
  const hex = hexOverride ?? HULL[color] ?? HULL.red;
  return materialFill(ctx, hex, skinFinish(color), R, ang);
}

// Paint a material across the current clip. One drawImage of a
// pre-shaded tile — see material.js. This replaced a per-frame stack of
// gradients, composited quads and facet paths that cost ~110 canvas
// operations PER TANK and was the reason a full lobby dropped frames.
function fillMaterial(color, R, hexOverride, ang) {
  const hex = hexOverride ?? HULL[color] ?? HULL.red;
  return paintMaterial(ctx, hex, skinFinish(color), R, ang);
}

// The material's own structure — brushed grain, a mirror horizon, cut
// facets. The caller has already clipped to the piece being painted.


// Every tank's shadow, laid down in ONE pass before any tank is drawn.
// Done per-tank inside drawTank it landed on top of tanks already
// painted, so shadows piled over each other and over hulls. And it is
// SWEPT from the tank's own footprint out to the offset copy rather than
// being a detached silhouette sitting away from it — a floating shadow
// with a gap under the tank is what makes it look like it is hovering.
// The tank's real outline — rounded hull plus barrel — smeared from
// where it stands out to where the sun throws it. A convex hull of the
// two footprints (what this used to do) fills in the notch either side
// of the barrel and squares off the rounded corners, which is exactly
// why it came out as a box. Stamping the true silhouette at a few points
// along the offset keeps the shape and still joins up.
// Andrew's monotone chain. The hull of a box and its sun-offset copy is
// the volume the light sweeps through, i.e. the shadow's outline.
function convexHull2(pts) {
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], hi = [];
  for (const q of p) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i];
    while (hi.length >= 2 && cr(hi[hi.length - 2], hi[hi.length - 1], q) <= 0) hi.pop(); hi.push(q); }
  lo.pop(); hi.pop();
  return lo.concat(hi);
}

function tankSilhouette(ctx2, t, dx, dy) {
  const R = TANK_R;
  const bar = BARRELS[t.weapon || "normal"] ?? BARRELS.normal;
  const hl = R * 0.95, hw = R * 0.83, rr = R * 0.26;
  const bl = bar.len * R, bw = bar.hw * R;
  const c = Math.cos(t.a), sn = Math.sin(t.a);
  const X = (lx, ly) => t.x + dx + lx * c - ly * sn;
  const Y = (lx, ly) => t.y + dy + lx * sn + ly * c;
  // hull, with its corners actually rounded
  ctx2.moveTo(X(-hl + rr, -hw), Y(-hl + rr, -hw));
  ctx2.lineTo(X(hl - rr, -hw), Y(hl - rr, -hw));
  ctx2.quadraticCurveTo(X(hl, -hw), Y(hl, -hw), X(hl, -hw + rr), Y(hl, -hw + rr));
  ctx2.lineTo(X(hl, hw - rr), Y(hl, hw - rr));
  ctx2.quadraticCurveTo(X(hl, hw), Y(hl, hw), X(hl - rr, hw), Y(hl - rr, hw));
  ctx2.lineTo(X(-hl + rr, hw), Y(-hl + rr, hw));
  ctx2.quadraticCurveTo(X(-hl, hw), Y(-hl, hw), X(-hl, hw - rr), Y(-hl, hw - rr));
  ctx2.lineTo(X(-hl, -hw + rr), Y(-hl, -hw + rr));
  ctx2.quadraticCurveTo(X(-hl, -hw), Y(-hl, -hw), X(-hl + rr, -hw), Y(-hl + rr, -hw));
  ctx2.closePath();
  // barrel
  ctx2.moveTo(X(0, -bw), Y(0, -bw));
  ctx2.lineTo(X(bl, -bw), Y(bl, -bw));
  ctx2.lineTo(X(bl, bw), Y(bl, bw));
  ctx2.lineTo(X(0, bw), Y(0, bw));
  ctx2.closePath();
}

function drawTankShadows(now) {
  // A tank is a low, squat thing next to a wall — so its shadow is much
  // the shorter of the two. This used to be TALLER than the wall height,
  // which read as the tanks looming over the masonry.
  const H = TANK_R * 0.30;
  const ox = SHADOW.dx * H, oy = SHADOW.dy * H;
  ctx.save();

  // A tank's shadow stops at the foot of a wall.
  //
  // Walls stand well above a tank, so a tank's shadow physically cannot
  // be cast onto the top of one — the wall is in the way. Drawn after
  // the masonry with no mask, the smear ran straight up and over the
  // brickwork, which flattened the whole scene: suddenly the wall looked
  // no taller than the tank beside it.
  //
  // Masked with the EVEN-ODD rule: one big rectangle covering the world,
  // plus every wall footprint. Even-odd counts a region covered twice as
  // outside the path, so the walls punch themselves out and what's left
  // is exactly the floor.
  ctx.beginPath();
  ctx.rect(-CELL, -CELL, S.worldW + CELL * 2, S.worldH + CELL * 2);
  for (const rc of S.rects ?? []) ctx.rect(rc.x, rc.y, rc.w, rc.h);
  for (const w of S.diag ?? []) {
    const c = Math.cos(w.a), sn = Math.sin(w.a);
    const ax = c * w.hx, ay = sn * w.hx;
    const bx = -sn * w.hy, by = c * w.hy;
    ctx.moveTo(w.x - ax - bx, w.y - ay - by);
    ctx.lineTo(w.x + ax - bx, w.y + ay - by);
    ctx.lineTo(w.x + ax + bx, w.y + ay + by);
    ctx.lineTo(w.x - ax + bx, w.y - ay + by);
    ctx.closePath();
  }
  // Player-built brick walls are just as tall.
  for (const w of S.walls ?? []) {
    if ((w.hp ?? 1) <= 0) continue;
    const c = Math.cos(w.a), sn = Math.sin(w.a);
    const ax = c * w.hx, ay = sn * w.hx;
    const bx = -sn * w.hy, by = c * w.hy;
    ctx.moveTo(w.x - ax - bx, w.y - ay - by);
    ctx.lineTo(w.x + ax - bx, w.y + ay - by);
    ctx.lineTo(w.x + ax + bx, w.y + ay + by);
    ctx.lineTo(w.x - ax + bx, w.y - ay + by);
    ctx.closePath();
  }
  ctx.clip("evenodd");

  ctx.fillStyle = "rgba(18,20,23,0.34)";
  for (const t of S.tanks) {
    if (t.dead || t.gone || now < (t.phaseUntil ?? 0)) continue;
    // Every stamp goes into ONE path and is filled once, so the overlaps
    // don't darken where they pile up.
    // Two stamps — where the tank stands and where the sun throws it —
    // joined by a quad across the gap. Six full stamps of the outline
    // per tank was ~450 path segments a frame on its own, easily the
    // most expensive thing being drawn, and it looks no different.
    ctx.beginPath();
    tankSilhouette(ctx, t, 0, 0);
    tankSilhouette(ctx, t, ox, oy);
    const R2 = TANK_R;
    const pdir = Math.atan2(oy, ox) + Math.PI / 2;
    const px2 = Math.cos(pdir) * R2 * 0.9, py2 = Math.sin(pdir) * R2 * 0.9;
    ctx.moveTo(t.x + px2, t.y + py2);
    ctx.lineTo(t.x + ox + px2, t.y + oy + py2);
    ctx.lineTo(t.x + ox - px2, t.y + oy - py2);
    ctx.lineTo(t.x - px2, t.y - py2);
    ctx.closePath();
    ctx.fill("nonzero");
  }
  ctx.restore();
}

// A tank driving into the shade of a wall goes into shade.
//
// The wall shadows are baked into one layer over the whole arena, and
// the floor gets them for free because it is drawn underneath. Tanks are
// drawn after, so they were coming out fully lit inside a shadow — a
// gold hull blazing away in a patch of shade, which is the single
// clearest way to make an object look pasted on rather than standing
// there.
//
// So the same layer is laid over the hulls afterwards, clipped to each
// tank, in MULTIPLY. Multiply is the right operator for this and not
// just a darkening trick: shadow means less light arriving, and every
// term in the material — the diffuse, the environment, and crucially
// the specular — scales down together. A mirror in shade shows a dark
// reflection, not a bright one, so the PBR highlight is crushed exactly
// as it should be rather than sitting on top of the shadow.
function castWallShadowsOnTanks(scene) {
  if (!scene?.shadow?.cv || !S.tanks.length) return;
  const sh = scene.shadow.cv;
  const u = sh.__wu ?? { w: sh.width, h: sh.height };
  const pad = scene.shadow.pad;
  const R = TANK_R;
  for (const t of S.tanks) {
    if (t.dead || t.gone) continue;
    // Cheap reject: nothing to do for a tank standing in full sun.
    ctx.save();
    ctx.beginPath();
    ctx.translate(t.x, t.y);
    ctx.rotate(t.a);
    // The hull plus the turret disc and barrel — the tank's whole
    // footprint, so the shade runs across the gun as well.
    // Wide enough to take in the TREADS, not just the hull. The treads
    // sit at ±0.62 R and are 0.42 R across, so they reach 0.83 R — clip
    // at the hull's 0.62 R and the shadow stops dead along the tracks
    // while they stay in full sun, which reads as the treads being
    // sliced off the moment the tank drives into shade.
    if (ctx.roundRect) ctx.roundRect(-R * 1.0, -R * 0.86, R * 2.0, R * 1.72, R * 0.24);
    else ctx.rect(-R * 1.0, -R * 0.86, R * 2.0, R * 1.72);
    ctx.moveTo(R * 1.3, -R * 0.13);
    ctx.arc(0, 0, R * 0.46, 0, Math.PI * 2);
    // The barrel used to be added to this clip as a bare rectangle. Near
    // a wall its hard corners caught the shadow and showed up as a black
    // slab floating off the muzzle. The hull and turret alone are enough
    // to seat the tank in shade; the barrel is thin enough that nobody
    // reads shade on it, and the rectangle was doing real visual harm.
    ctx.clip();
    ctx.rotate(-t.a);
    ctx.translate(-t.x, -t.y);
    ctx.globalCompositeOperation = "multiply";
    // Blit ONLY the patch of shadow under this tank. This used to hand
    // the whole padded shadow canvas to the GPU once per tank, per
    // frame, with multiply blending — on a big arena that is tens of
    // megapixels of blending for a sprite 35 px across, and it was the
    // single biggest cost in the frame.
    const box = R * 2.2;
    const sx = t.x - box, sy = t.y - box, sw = box * 2, sh2 = box * 2;
    const scale = sh.width / u.w;
    ctx.drawImage(sh,
      (sx + pad) * scale, (sy + pad) * scale, sw * scale, sh2 * scale,
      sx, sy, sw, sh2);
    ctx.restore();
  }
  ctx.globalCompositeOperation = "source-over";
}

// Build the round's heavy assets during the countdown.
//
// Two things used to be paid for at the worst possible moment. The arena
// art — concrete, masonry, worn tracks, wall shadows — is generated once
// per layout, and that happened on the first frame the arena was drawn,
// which is the first frame of the round. And each tank's material is
// shaded per orientation on demand, so the first time a hull presented a
// new angle the game stopped to bake it: a burst of small hitches
// arriving precisely as everyone started turning.
//
// Both are deterministic and neither depends on anything that happens
// during the count, so both are built in the three seconds while the
// numbers are on screen — but drained against a TIME BUDGET rather than
// done in one go. Baking a single paint takes long enough to stall a
// frame by itself, so doing the lot at once would simply move the hitch
// from the start of the round to the start of the countdown.
function planPrewarm() {
  const jobs = [];
  jobs.push({ kind: "scene" });
  const want = TANK_R * 2.6 * (S.viewScale ?? 1) * (S.viewDpr ?? 1);
  const seen = new Set();
  for (const t of S.tanks ?? []) {
    for (const id of [t.color, ...(t.patColors ?? [])]) {
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const n = prebakeCount(skinFinish(id));
      for (let i = 0; i < n; i++) {
        jobs.push({ kind: "tile", hex: HULL[id] ?? HULL.red, fin: skinFinish(id), size: want, i });
      }
    }
  }
  S.prewarm = jobs;
  S.prewarmAt = 0;
}

// Drain the queue for at most `budgetMs`. Called every frame while the
// countdown is running.
function stepPrewarm(budgetMs = 4) {
  const jobs = S.prewarm;
  if (!jobs || !jobs.length) return;
  const t0 = performance.now();
  while (jobs.length && performance.now() - t0 < budgetMs) {
    const j = jobs.shift();
    try {
      if (j.kind === "scene") {
        let s2 = S.viewScale, dpr = S.viewDpr;
        if (!s2) {
          const cw = canvas.clientWidth || 1280, ch = canvas.clientHeight || 720;
          dpr = dpr ?? Math.max(1, Math.min(RENDER_W / Math.max(1, cw), RENDER_H / Math.max(1, ch)));
          s2 = Math.min((cw - 16) / S.worldW, (ch - 16) / S.worldH);
        }
        buildScene(S.worldW, S.worldH, S.rects ?? [], S.groundSeed ?? 1, s2 * (dpr ?? 1), S.maze, CELL, S.diag);
      } else {
        prebakeStep(j.hex, j.fin, j.size, j.i);
      }
    } catch (e) { /* the draw path builds anything that failed */ }
  }
  if (!jobs.length) S.prewarm = null;
}

// The upgrade stats belonging to whoever fired a projectile.
//
// Damage and lifetime are settled long after the shot leaves the barrel,
// often on a client that isn't the shooter's, so the projectile carries
// only an owner id. This resolves that back to a stat block, and falls
// back to the neutral set for a shooter who has left or for any match
// with upgrades switched off.
function upOf(byId) {
  const t = S.tanks.find((x) => x.id === byId);
  return t?.up ?? NO_STATS;
}

// The basic gun's magazine, including the Max Ammo upgrade.
function magCapOf(t) {
  return MAG_SIZE + (t?.up?.basicMag ?? 0);
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

  // The shop's premium paints aren't flat colours — they're MATERIALS.
  // Each is lit by a light fixed in WORLD space, so the reflection
  // stays put while the tank turns under it and sweeps across the hull
  // the way it does on real metal. Nothing is on a timer: a parked
  // tank's paint is perfectly still, and it's the ROTATION that moves
  // the highlight. See material.js.
  //
  // A two-tone PATTERN (Splotchy, Camo, Lightning…) paints its second
  // colour over this base, clipped to the hull. When a pattern is worn
  // the base is drawn in the FIRST chosen colour and the pattern shapes
  // in the SECOND; with no pattern it's just the equipped paint.
  //
  // IMPORTANT: every piece of hull detail below (glacis, rear deck,
  // grille) derives from `bodyColor` — the effective base — NOT the raw
  // equipped skin. Otherwise a metal skin worn UNDER a pattern would
  // show through on the nose and tail.
  const pat = t.pattern && t.pattern !== "solid" ? t.pattern : null;
  const pc = Array.isArray(t.patColors) ? t.patColors : [];
  const bodyColor = pat && pc[0] ? pc[0] : t.color;   // colour id (for finish)
  // A caller may override the actual HEXES a tank wears while keeping
  // its skin/pattern IDs for material + shape. t.colorHex is the
  // solid/base override; t.patHex = [h0, h1] overrides the pattern's
  // two colours. Undefined → fall back to the id's own hex.
  const patOv = Array.isArray(t.patHex) ? t.patHex : null;
  const baseHexOv = pat ? (patOv ? patOv[0] : undefined) : (t.colorHex || undefined);
  const overlayHexOv = pat && patOv ? patOv[1] : undefined;
  const bodyHex = baseHexOv ?? (HULL[bodyColor] ?? hull); // effective base hex, for shade()
  const bodyIsMaterial = isMaterial(skinFinish(bodyColor));
  if (bodyIsMaterial || (pat && pc[0] && pc[1])) {
    ctx.save();
    // Clip to the hull rectangle so neither the material nor the
    // pattern ever spills onto the treads.
    ctx.beginPath();
    // Clip to the BODY between the treads — never over them.
    //
    // The treads are painted just above (bands from ±0.83 R in to
    // ±0.41 R), so widening this clip to the full hull, as it briefly
    // was, let the material and pattern paint straight over them and the
    // tank lost its tracks entirely. The body box is the correct extent;
    // the pale-rectangle artefact this was meant to cure is handled by
    // the material tile being drawn to fit rather than overhanging.
    rrPath(-R * 0.9, -R * 0.4, R * 1.8, R * 0.8, R * 0.2);
    ctx.clip();
    if (bodyIsMaterial) fillMaterial(bodyColor, R, baseHexOv, t.a);
    else { ctx.fillStyle = hullPaint(bodyColor, R, baseHexOv, t.a); ctx.fillRect(-R * 1.2, -R * 1.2, R * 2.4, R * 2.4); }
    if (pat && pc[0] && pc[1]) drawPattern(pat, pc[1], R, now, t.id, overlayHexOv, t.a);
    ctx.restore();
  } else {
    ctx.fillStyle = hullPaint(bodyColor, R, baseHexOv, t.a);
    rr(-R * 0.9, -R * 0.58, R * 1.8, R * 1.16, R * 0.24);
  }

  // PHASE GLINT: while phasing, a violet sheen sweeps across the hull.
  // Phase only lasts a second and the tank is already at half opacity,
  // so this is drawn ADDITIVELY and boldly — a subtle tint simply
  // vanished behind the transparency. One sweep completes inside the
  // phase window, and the motion is sine-driven (never a wrapping
  // sawtooth) so it eases in and back out instead of snapping.
  if (now < (t.phaseUntil ?? 0)) {
    ctx.save();
    ctx.beginPath();
    rrPath(-R * 0.9, -R * 0.58, R * 1.8, R * 1.16, R * 0.24);
    ctx.clip();
    // Undo the tank's phase transparency for the glint itself, so the
    // sheen reads at full strength on top of the see-through hull.
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "lighter";
    const sweep = Math.sin(now / 300);                 // ~1.9 s round trip
    const breathe = 0.72 + 0.28 * Math.sin(now / 165);
    const cx = sweep * R * 1.05;
    const pg = ctx.createLinearGradient(cx - R * 1.1, -R, cx + R * 1.1, R);
    pg.addColorStop(0.00, "rgba(90, 20, 190, 0)");
    pg.addColorStop(0.30, `rgba(138, 66, 240, ${0.34 * breathe})`);
    pg.addColorStop(0.50, `rgba(206, 150, 255, ${0.92 * breathe})`);
    pg.addColorStop(0.70, `rgba(138, 66, 240, ${0.34 * breathe})`);
    pg.addColorStop(1.00, "rgba(90, 20, 190, 0)");
    ctx.fillStyle = pg;
    ctx.fillRect(-R * 1.2, -R, R * 2.4, R * 2);
    // A steady violet wash underneath keeps it reading as "phased" even
    // at the moment the sweep is off the edge of the hull.
    ctx.fillStyle = `rgba(150, 88, 255, ${0.22 * breathe})`;
    ctx.fillRect(-R * 1.2, -R, R * 2.4, R * 2);
    ctx.restore();

    // Violet rim so the silhouette pops against the floor.
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = `rgba(196, 140, 255, ${0.55 + 0.35 * Math.sin(now / 165)})`;
    ctx.lineWidth = Math.max(1.5, R * 0.09);
    ctx.beginPath();
    rrPath(-R * 0.9, -R * 0.58, R * 1.8, R * 1.16, R * 0.24);
    ctx.stroke();
    ctx.restore();
  }

  // ---- Directional detail: the FRONT and REAR read differently ----
  // The nose is NOT a separate lighter plate any more (that covered the
  // paint/pattern and looked pasted-on). Instead we just etch a subtle
  // chevron OUTLINE on the front so you can read facing, letting the
  // hull's own colour/pattern carry all the way to the tip.
  ctx.strokeStyle = shade(bodyHex, 0.42);
  ctx.lineWidth = Math.max(1.5, R * 0.06);
  ctx.globalAlpha = 0.5;
  ctx.beginPath(); // nose chevron (etched line only)
  ctx.moveTo(R * 0.52, -R * 0.3);
  ctx.lineTo(R * 0.82, 0);
  ctx.lineTo(R * 0.52, R * 0.3);
  ctx.stroke();
  ctx.globalAlpha = 1;
  // Rear (−x): a light grille etch (no filled plate, so the paint shows
  // through) plus exhaust stubs poking past the tail.
  ctx.strokeStyle = shade(bodyHex, 0.55);
  ctx.lineWidth = Math.max(1, R * 0.05);
  ctx.globalAlpha = 0.55;
  ctx.beginPath();
  for (let i = -2; i <= 2; i++) {
    ctx.moveTo(-R * 0.84, i * R * 0.16);
    ctx.lineTo(-R * 0.58, i * R * 0.16);
  }
  ctx.stroke();
  ctx.globalAlpha = 1;
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

  // ---- One-piece tank turret ----
  // A real turret silhouette, traced as ONE closed path so nothing
  // overlaps: a turret HOUSING near the centre (its shape distinct per
  // weapon) with a BARREL extending forward. The barrel width equals the
  // weapon's bullet size and the barrel hitbox (BARRELS[w]); the housing
  // sits within the hull footprint (already a hitbox), so shots line up.
  // Carries the tank's paint, pattern, phase (transparency + violet
  // glint) and hit-flash, exactly like the hull.
  const wtype = t.weapon ?? "normal";
  const turret = t.turret ?? t.a;
  const bl = BARRELS[wtype] ?? BARRELS.normal;
  const phasing = now < (t.phaseUntil ?? 0);
  ctx.save();
  ctx.rotate(turret - t.a);
  if (phasing) ctx.globalAlpha = PHASE.opacity;

  const bL = bl.len * R;   // muzzle distance (== barrel hitbox length)
  const bW = bl.hw * R;    // barrel half-width (== hitbox width, bullet-sized)
  // Trace this weapon's turret outline into the current path. The
  // housing shape differs per family so the guns read apart at a glance.
  const turretPath = (grow) => turretOutline(wtype, bL, bW, R, grow);

  // 1) Dark outline underneath: the same silhouette grown slightly, so
  //    the paint on top leaves a clean uniform rim. One path, no seams.
  ctx.fillStyle = "rgba(16,20,28,0.92)";
  turretPath(Math.max(1.5, R * 0.085));
  ctx.fill();

  // 2) Paint: skin finish + pattern, clipped to the turret silhouette.
  ctx.save();
  turretPath(0);
  ctx.clip();
  // The turret swivels independently of the hull, so its reflection is
  // anchored using ITS world angle — turning just the gun slides the
  // highlight along the barrel while the hull's stays where it was.
  if (isMaterial(skinFinish(bodyColor))) {
    fillMaterial(bodyColor, R, baseHexOv, turret);
  } else {
    ctx.fillStyle = hullPaint(bodyColor, R, baseHexOv, turret);
    ctx.fillRect(-R * 1.2, -R * 1.2, R * 2.4, R * 2.4);
  }
  if (pat && pc[0] && pc[1]) drawPattern(pat, pc[1], R, now, t.id, overlayHexOv, turret);
  // Cross-tube bevel: light along the top, shadow along the bottom, so
  // the whole turret reads as raised metal.
  const bev = ctx.createLinearGradient(0, -R * 0.55, 0, R * 0.55);
  bev.addColorStop(0, "rgba(255,255,255,0.26)");
  bev.addColorStop(0.5, "rgba(255,255,255,0)");
  bev.addColorStop(1, "rgba(0,0,0,0.28)");
  ctx.fillStyle = bev;
  ctx.fillRect(-R * 1.2, -R * 1.2, R * 2.4, R * 2.4);
  // Muzzle bore at the very tip.
  ctx.fillStyle = "rgba(0,0,0,0.42)";
  ctx.beginPath();
  ctx.ellipse(bL - bW * 0.30, 0, bW * 0.30, bW * 0.6, 0, 0, Math.PI * 2);
  ctx.fill();
  // Phase glint over the turret, clipped to its silhouette, matching the
  // hull's violet sheen so the WHOLE tank phases together.
  if (phasing) {
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "lighter";
    const breathe = 0.72 + 0.28 * Math.sin(now / 165);
    const sweep = Math.sin(now / 300);
    const cx = sweep * R * 1.05;
    const pg = ctx.createLinearGradient(cx - R * 1.1, -R, cx + R * 1.1, R);
    pg.addColorStop(0.0, "rgba(90,20,190,0)");
    pg.addColorStop(0.5, `rgba(206,150,255,${0.92 * breathe})`);
    pg.addColorStop(1.0, "rgba(90,20,190,0)");
    ctx.fillStyle = pg;
    ctx.fillRect(-R * 1.2, -R, R * 2.4, R * 2);
    ctx.fillStyle = `rgba(150,88,255,${0.22 * breathe})`;
    ctx.fillRect(-R * 1.2, -R, R * 2.4, R * 2);
  }
  ctx.restore();

  // Weapon-specific turret DETAIL (gatling tubes, laser emitter, sniper
  // scope, rocket nose, cannon brake, mortar bore, flame nozzle…). Drawn
  // UNCLIPPED so muzzle devices can poke past the barrel, but still inside
  // the turret frame (and its phase alpha), so each gun reads at a glance
  // instead of looking like a differently-sized version of the same tube.
  ctx.save();
  drawTurretDetail(wtype, bL, bW, R, now, effBaseHex(t));
  ctx.restore();

  // Violet rim on the turret while phasing, so its outline pops too.
  if (phasing) {
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = `rgba(196,140,255,${0.55 + 0.35 * Math.sin(now / 165)})`;
    ctx.lineWidth = Math.max(1.5, R * 0.08);
    turretPath(0);
    ctx.stroke();
    ctx.restore();
  }

  // 3) MG spin-up glow at the muzzle.
  if (t.weapon === "mg" && t.mgReadyAt && now < t.mgReadyAt) {
    const f = 1 - (t.mgReadyAt - now) / MG.windupMs;
    ctx.fillStyle = "#e8452e";
    ctx.globalAlpha = (phasing ? PHASE.opacity : 1) * (0.35 + 0.6 * Math.abs(Math.sin(f * 14)));
    ctx.beginPath();
    ctx.arc(bL, 0, bW * 0.8, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = phasing ? PHASE.opacity : 1;
  }

  // 4) Bots keep a small chip on the housing so you can tell them apart.
  if (t.bot) {
    ctx.fillStyle = "#eef1f6";
    ctx.beginPath();
    ctx.arc(0, 0, R * 0.12, 0, Math.PI * 2);
    ctx.fill();
  }

  // 5) Hit flash over the turret too, so the WHOLE tank blinks red.
  if (sinceHit < 170) {
    ctx.globalAlpha = 0.62 * (1 - sinceHit / 170);
    ctx.fillStyle = "#ff2d28";
    turretPath(0);
    ctx.fill();
  }

  ctx.restore(); // turret rotation frame
  ctx.restore(); // tank translate/rotate frame
}

// Trace a weapon's turret silhouette (housing + barrel) into ctx's path
// as ONE closed shape, in the turret frame (+x forward). `grow` expands
// it uniformly (for the dark outline underneath). Each weapon family has
// a distinct housing so the guns are recognisable at a glance.
function turretOutline(wtype, bL, bW, R, grow = 0) {
  const g = grow;
  // Housing footprint (kept inside the hull so it doesn't break the
  // hitbox): half-width HW, from xBack behind centre to xFront ahead.
  let HW = R * 0.46, xBack = -R * 0.42, xFront = R * 0.36, round = R * 0.16;
  let shape = "round"; // round | hex | box | slope
  switch (wtype) {
    case "cannon": HW = R * 0.56; xBack = -R * 0.5; xFront = R * 0.30; shape = "hex"; round = R * 0.1; break;
    case "mortar": HW = R * 0.58; xBack = -R * 0.46; xFront = R * 0.22; shape = "round"; round = R * 0.34; break;
    case "sniper": HW = R * 0.40; xBack = -R * 0.5; xFront = R * 0.42; shape = "slope"; round = R * 0.1; break;
    case "laser":  HW = R * 0.42; xBack = -R * 0.4; xFront = R * 0.40; shape = "box"; round = R * 0.06; break;
    case "mg":     HW = R * 0.50; xBack = -R * 0.4; xFront = R * 0.30; shape = "box"; round = R * 0.12; break;
    case "rocket": HW = R * 0.54; xBack = -R * 0.38; xFront = R * 0.26; shape = "box"; round = R * 0.14; break;
    case "flame":  HW = R * 0.52; xBack = -R * 0.4; xFront = R * 0.28; shape = "round"; round = R * 0.22; break;
    default: break; // normal + utility: rounded housing
  }
  HW += g; const bw = bW + g; const bl2 = bL + g;
  const xb = xBack - g, xf = xFront;
  ctx.beginPath();
  // Barrel top edge out to the muzzle and back (shared by all shapes).
  // Start at housing front-top, go forward along the barrel, around the
  // muzzle, back, then trace the housing rear per its shape.
  if (shape === "hex") {
    // Faceted (angular) housing — heavy weapons.
    ctx.moveTo(xf, -HW);
    ctx.lineTo(xf, -bw);
    ctx.lineTo(bl2, -bw);
    ctx.lineTo(bl2, bw);
    ctx.lineTo(xf, bw);
    ctx.lineTo(xf, HW);
    ctx.lineTo(xb + R * 0.14, HW);
    ctx.lineTo(xb, HW * 0.5);
    ctx.lineTo(xb, -HW * 0.5);
    ctx.lineTo(xb + R * 0.14, -HW);
    ctx.closePath();
  } else if (shape === "slope") {
    // Long, tapered housing — sniper.
    ctx.moveTo(xf, -HW);
    ctx.lineTo(xf, -bw);
    ctx.lineTo(bl2, -bw);
    ctx.lineTo(bl2, bw);
    ctx.lineTo(xf, bw);
    ctx.lineTo(xf, HW);
    ctx.lineTo(xb + R * 0.2, HW * 0.8);
    ctx.lineTo(xb, 0);
    ctx.lineTo(xb + R * 0.2, -HW * 0.8);
    ctx.closePath();
  } else if (shape === "box") {
    // Boxy housing with lightly rounded rear corners.
    const r = round;
    ctx.moveTo(xf, -HW);
    ctx.lineTo(xf, -bw);
    ctx.lineTo(bl2, -bw);
    ctx.lineTo(bl2, bw);
    ctx.lineTo(xf, bw);
    ctx.lineTo(xf, HW);
    ctx.lineTo(xb + r, HW);
    ctx.quadraticCurveTo(xb, HW, xb, HW - r);
    ctx.lineTo(xb, -HW + r);
    ctx.quadraticCurveTo(xb, -HW, xb + r, -HW);
    ctx.closePath();
  } else {
    // Rounded (cast) housing — default/normal, mortar.
    const r = round;
    ctx.moveTo(xf, -HW);
    ctx.lineTo(xf, -bw);
    ctx.lineTo(bl2, -bw);
    ctx.lineTo(bl2, bw);
    ctx.lineTo(xf, bw);
    ctx.lineTo(xf, HW);
    ctx.lineTo(xb + r, HW);
    ctx.quadraticCurveTo(xb - r * 0.2, HW - r * 0.2, xb - r * 0.2, HW - r);
    ctx.lineTo(xb - r * 0.2, -HW + r);
    ctx.quadraticCurveTo(xb - r * 0.2, -HW + r * 0.2, xb + r, -HW);
    ctx.closePath();
  }
}

// Per-weapon turret DETAIL, painted over the finished turret in the turret
// frame (+x forward, origin = hull centre). Gunmetal fills with light
// edges (so shapes read on light AND dark tank paint) plus a signature
// accent colour per gun. This is what makes the weapons distinct: without
// it every barrel is just a rounded rectangle of a different size.
function drawTurretDetail(wtype, bL, bW, R, now, beamHex) {
  const dark = "#2b303b", steel = "#454e5d", lite = "#6b7488", edge = "#8a94a6";
  const tms = now / 1000;
  switch (wtype) {
    case "mg": {
      // A single heavy barrel in a PERFORATED cooling shroud, fed by a
      // side ammo box and belt — not a gatling cluster.
      ctx.fillStyle = steel; rr(R * 0.28, -bW * 0.9, bL - R * 0.28, bW * 1.8, bW * 0.35);
      ctx.fillStyle = dark;
      const slots = 5;
      for (let i = 0; i < slots; i++) {
        const x = R * 0.42 + (bL - R * 0.66) * (i / (slots - 1));
        rr(x - bW * 0.16, -bW * 0.66, bW * 0.32, bW * 1.32, bW * 0.12); // cooling slot
      }
      ctx.fillStyle = dark; rr(bL - R * 0.06, -bW * 0.95, R * 0.1, bW * 1.9, bW * 0.2); // muzzle band
      ctx.fillStyle = dark; rr(-R * 0.44, R * 0.24, R * 0.46, R * 0.34, R * 0.07);      // ammo box
      ctx.fillStyle = lite;
      for (let i = 0; i < 4; i++) rr(-R * 0.10 + i * R * 0.10, R * 0.30 - i * R * 0.05, R * 0.09, R * 0.12, R * 0.02); // belt links
      break;
    }
    case "laser": {
      // A crystalline energy emitter: a glowing core stripe running the
      // barrel to a prism lens at the muzzle, flanked by heat-sink fins.
      // The energy glows in the tank's OWN beam colour (the same colour it
      // fires), with a hot near-white highlight down the centre.
      ctx.fillStyle = steel; rr(R * 0.34, -bW * 0.7, bL - R * 0.34, bW * 1.4, bW * 0.3);
      ctx.fillStyle = dark;
      for (const dy of [-1, 1]) rr(R * 0.42, dy * bW * 1.05 - bW * 0.12, R * 0.26, bW * 0.4, bW * 0.1); // fins
      const glow = 0.7 + 0.3 * Math.sin(tms * 6);
      const beam = beamHex || "#35c8ff";
      const beamLite = mix(beam, "#ffffff", 0.55);
      ctx.fillStyle = beam; rr(R * 0.4, -bW * 0.18, bL - R * 0.55, bW * 0.36, bW * 0.16);       // energy core
      ctx.fillStyle = beamLite; rr(R * 0.4, -bW * 0.09, bL - R * 0.62, bW * 0.18, bW * 0.09);    // hot highlight
      ctx.fillStyle = beam;                                                                       // prism lens
      ctx.beginPath();
      ctx.moveTo(bL + R * 0.1, 0);
      ctx.lineTo(bL - R * 0.06, -bW * 0.95);
      ctx.lineTo(bL - R * 0.16, 0);
      ctx.lineTo(bL - R * 0.06, bW * 0.95);
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = `rgba(255,255,255,${0.7 + 0.3 * glow})`;                                     // white-hot focus
      ctx.beginPath(); ctx.arc(bL - R * 0.02, 0, bW * (0.26 + 0.07 * glow), 0, Math.PI * 2); ctx.fill();
      break;
    }
    case "sniper": {
      // A mounted scope offset from the bore, with a teal lens, and a
      // slotted muzzle brake at the tip.
      ctx.fillStyle = dark; rr(-R * 0.30, -bW * 1.7, R * 0.64, bW * 1.5, bW * 0.5);
      ctx.fillStyle = lite; rr(-R * 0.24, -bW * 1.58, R * 0.5, bW * 0.34, bW * 0.16); // scope highlight
      ctx.fillStyle = "#33c2b0";
      ctx.beginPath(); ctx.arc(R * 0.30, -bW * 0.95, bW * 0.52, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = steel; rr(bL - R * 0.24, -bW * 1.75, R * 0.22, bW * 3.5, bW * 0.35);
      ctx.fillStyle = dark;
      for (const dy of [-1, 1]) rr(bL - R * 0.2, dy * bW * 1.08 - bW * 0.2, R * 0.15, bW * 0.4, bW * 0.12);
      break;
    }
    case "rocket": {
      // A launcher: two side rails and a live rocket nosed in the tube.
      ctx.fillStyle = dark;
      for (const dy of [-1, 1]) rr(R * 0.2, dy * bW * 0.72 - bW * 0.15, bL - R * 0.2, bW * 0.30, bW * 0.1);
      ctx.fillStyle = "#2f7bff";
      ctx.beginPath();
      ctx.moveTo(bL + R * 0.16, 0);
      ctx.lineTo(bL - R * 0.14, -bW * 0.62);
      ctx.lineTo(bL - R * 0.14, bW * 0.62);
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = "#e8452e";
      ctx.beginPath(); ctx.arc(bL - R * 0.03, 0, bW * 0.24, 0, Math.PI * 2); ctx.fill();
      break;
    }
    case "cannon": {
      // Heavy: a big slotted muzzle brake, two barrel bands, and a
      // reinforced breech at the base.
      ctx.fillStyle = dark; rr(bL - R * 0.26, -bW * 1.14, R * 0.26, bW * 2.28, bW * 0.2);
      ctx.fillStyle = "#1c212c"; rr(bL - R * 0.15, -bW * 0.3, R * 0.05, bW * 0.6, bW * 0.08); // brake slot
      ctx.fillStyle = steel;
      for (const fx of [0.34, 0.58]) {
        const x = R * 0.30 + (bL - R * 0.30) * fx;
        rr(x, -bW * 1.08, R * 0.06, bW * 2.16, bW * 0.08);
      }
      ctx.fillStyle = dark; rr(-R * 0.52, -R * 0.3, R * 0.3, R * 0.6, R * 0.08);
      ctx.fillStyle = lite; rr(-R * 0.5, -R * 0.24, R * 0.26, R * 0.1, R * 0.05); // breech highlight
      break;
    }
    case "mortar": {
      // Squat launcher: a stubby tube with a big rimmed MOUTH, a baseplate,
      // and two bipod legs splaying back from the muzzle.
      ctx.fillStyle = steel; rr(R * 0.06, -bW * 0.9, bL - R * 0.06, bW * 1.8, bW * 0.4);
      ctx.strokeStyle = dark; ctx.lineWidth = Math.max(2, bW * 0.34);
      for (const dy of [-1, 1]) {
        ctx.beginPath(); ctx.moveTo(bL - R * 0.2, dy * bW * 0.5); ctx.lineTo(-R * 0.2, dy * R * 0.5); ctx.stroke();
      }
      ctx.fillStyle = lite; ctx.beginPath(); ctx.arc(bL - bW * 0.1, 0, bW * 1.15, 0, Math.PI * 2); ctx.fill(); // rim
      ctx.fillStyle = "#14181f"; ctx.beginPath(); ctx.arc(bL - bW * 0.1, 0, bW * 0.8, 0, Math.PI * 2); ctx.fill(); // bore
      ctx.fillStyle = dark; rr(-R * 0.5, -R * 0.36, R * 0.24, R * 0.72, R * 0.1); // baseplate
      break;
    }
    case "flame": {
      // A flaring nozzle (wider at the muzzle — unlike every other barrel),
      // a fuel tank on the housing, and a lit pilot bead.
      ctx.fillStyle = steel;
      ctx.beginPath();
      ctx.moveTo(R * 0.5, -bW * 0.55);
      ctx.lineTo(bL, -bW * 1.18);
      ctx.lineTo(bL, bW * 1.18);
      ctx.lineTo(R * 0.5, bW * 0.55);
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = "#1c212c";
      ctx.beginPath(); ctx.ellipse(bL, 0, bW * 0.3, bW * 1.08, 0, 0, Math.PI * 2); ctx.fill(); // nozzle mouth
      ctx.fillStyle = lite; rr(-R * 0.46, R * 0.24, R * 0.52, R * 0.3, R * 0.15);   // fuel tank
      ctx.strokeStyle = edge; ctx.lineWidth = Math.max(1, R * 0.04);
      ctx.beginPath(); ctx.moveTo(-R * 0.30, R * 0.24); ctx.lineTo(-R * 0.30, R * 0.54); ctx.stroke();
      // A small BLUE pilot flame at the nozzle lip (a nested teardrop that
      // flickers), instead of a plain dot.
      const flick = 0.75 + 0.25 * Math.sin(tms * 12);
      const pilot = (cx, cy, h, w, col) => {
        ctx.fillStyle = col;
        ctx.beginPath();
        ctx.moveTo(cx, cy - h);                                   // tip up
        ctx.bezierCurveTo(cx + w, cy - h * 0.4, cx + w, cy + h * 0.2, cx, cy + h * 0.5);
        ctx.bezierCurveTo(cx - w, cy + h * 0.2, cx - w, cy - h * 0.4, cx, cy - h);
        ctx.closePath(); ctx.fill();
      };
      const px = bL - bW * 0.1, py = -bW * 0.95;
      pilot(px, py, bW * (0.85 + 0.2 * flick), bW * 0.5, "#2f7bff");
      pilot(px, py + bW * 0.15, bW * 0.5 * flick + bW * 0.2, bW * 0.28, "#bfe6ff");
      break;
    }
    default:
      break; // normal + utility guns keep a clean, plain barrel
  }
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

// Build a rounded-rect PATH without filling (for clipping).
function rrPath(x, y, w, h, r) {
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
  else ctx.rect(x, y, w, h);
}

// A tiny deterministic RNG so a given tank's random-ish pattern (camo
// blobs, lightning forks) stays identical every frame instead of
// shimmering. Seeded from the tank id.
function patRng(seed) {
  let a = 0;
  for (let i = 0; i < String(seed).length; i++) a = (a * 31 + String(seed).charCodeAt(i)) | 0;
  a = (a ^ 0x9e3779b9) >>> 0;
  return () => {
    a ^= a << 13; a >>>= 0;
    a ^= a >> 17;
    a ^= a << 5; a >>>= 0;
    return a / 4294967296;
  };
}

// Paint a pattern's SECOND colour over the (already clipped) hull. The
// caller has clipped to the hull, so these can draw freely. `col` is
// the second colour id (rendered with its material, so a bronze second
// colour is still bronze). `now` only drives the two animated patterns.
function drawPattern(id, col, R, now, seedId, hexOverride, ang = 0) {
  const paint = hullPaint(col, R, hexOverride, ang);
  const colHex = hexOverride ?? HULL[col] ?? HULL.red; // the 2nd colour as a hex, for shade/mix
  ctx.fillStyle = paint;
  ctx.strokeStyle = paint;
  const W = R * 1.8, H = R * 1.16;
  const L = -R * 0.9, T = -R * 0.58;
  // Patterns must cover the WHOLE tank, not just the hull rectangle.
  // This same routine paints the barrel as well, and clipping a pattern
  // to the hull box left the outer half of the barrel bare — a plain
  // stripe down the gun that catches the eye every time the tank turns.
  // The caller has already clipped to whichever piece it is painting,
  // so covering the entire footprint is both correct and simpler.
  const CL = -R * 1.35, CT = -R * 1.35, CW = R * 2.7, CH = R * 2.7;

  if (id === "twoTone") {
    // Clean split: the rear half of the hull in the second colour.
    ctx.fillRect(L, T, W * 0.5, H);

  } else if (id === "splotchy") {
    // Organic blotches: several overlapping lobed shapes rather than
    // plain circles, so it reads as spilled paint instead of polka dots.
    const rng = patRng(seedId + "splotch");
    for (let i = 0; i < 20; i++) {
      const bx = CL + rng() * CW, by = CT + rng() * CH;
      const br = R * (0.13 + rng() * 0.18);
      ctx.beginPath();
      const lobes = 9;
      for (let k = 0; k <= lobes; k++) {
        const a2 = (k / lobes) * Math.PI * 2;
        const rad = br * (0.7 + rng() * 0.6);
        const px = bx + Math.cos(a2) * rad, py = by + Math.sin(a2) * rad;
        if (k === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fill();
    }

  } else if (id === "camo") {
    // Proper woodland camo: big irregular interlocking patches with
    // ragged edges, dense enough to actually break up the silhouette.
    // The old version dropped three lonely blobs on a bare hull, which
    // is not camouflage — it is spots.
    const rng = patRng(seedId + "camo");
    for (let i = 0; i < 22; i++) {
      const bx = CL + rng() * CW, by = CT + rng() * CH;
      const rx = R * (0.20 + rng() * 0.30), ry = R * (0.16 + rng() * 0.26);
      ctx.beginPath();
      const n = 10;
      for (let k = 0; k <= n; k++) {
        const a2 = (k / n) * Math.PI * 2;
        const j = 0.62 + rng() * 0.72;                 // ragged edge
        const px = bx + Math.cos(a2) * rx * j;
        const py = by + Math.sin(a2) * ry * j;
        if (k === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fill();
    }

  } else if (id === "modernCamo") {
    // Digital camo: a pixel grid, filled in clusters so the blocks form
    // connected shapes rather than random confetti.
    const rng = patRng(seedId + "digi");
    const px2 = R * 0.20;
    const cols = Math.ceil(CW / px2), rows = Math.ceil(CH / px2);
    const grid = new Uint8Array(cols * rows);
    for (let s2 = 0; s2 < 34; s2++) {
      let c = Math.floor(rng() * cols), r2 = Math.floor(rng() * rows);
      const runLen = 4 + Math.floor(rng() * 9);
      for (let k = 0; k < runLen; k++) {                // a random walk
        if (c >= 0 && c < cols && r2 >= 0 && r2 < rows) grid[r2 * cols + c] = 1;
        if (rng() < 0.5) c += rng() < 0.5 ? 1 : -1; else r2 += rng() < 0.5 ? 1 : -1;
      }
    }
    for (let r2 = 0; r2 < rows; r2++) {
      for (let c = 0; c < cols; c++) {
        if (grid[r2 * cols + c]) ctx.fillRect(CL + c * px2, CT + r2 * px2, px2 + 0.5, px2 + 0.5);
      }
    }

  } else if (id === "lightning") {
    // A forked bolt: a jagged main channel with shorter branches, drawn
    // in the CHOSEN colour (the old one washed out to near-white, which
    // is why it looked grey whatever you picked). It flickers, which is
    // most of why it costs what it does.
    const rng = patRng(seedId + "bolt");
    const flick = 0.72 + 0.28 * Math.abs(Math.sin(now / 90));
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    const bolt = (x0, y0, x1, y1, w2, depth) => {
      const segs = 6;
      const pts = [];
      for (let i = 0; i <= segs; i++) {
        const u = i / segs;
        const jx = (i === 0 || i === segs) ? 0 : (rng() - 0.5) * R * 0.38;
        const jy = (i === 0 || i === segs) ? 0 : (rng() - 0.5) * R * 0.30;
        pts.push([x0 + (x1 - x0) * u + jx, y0 + (y1 - y0) * u + jy]);
      }
      ctx.globalAlpha = flick;
      ctx.lineWidth = w2;
      ctx.beginPath();
      pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
      ctx.stroke();
      if (depth > 0) {
        for (let b = 0; b < 2; b++) {
          const at = pts[1 + Math.floor(rng() * (pts.length - 2))];
          bolt(at[0], at[1],
               at[0] + (rng() - 0.5) * R * 1.1, at[1] + (rng() - 0.5) * R * 1.1,
               w2 * 0.5, depth - 1);
        }
      }
      ctx.globalAlpha = 1;
    };
    bolt(CL + R * 0.15, CT + R * 0.2, CL + CW - R * 0.15, CT + CH - R * 0.2, R * 0.13, 1);
    bolt(CL + R * 0.2, CT + CH - R * 0.25, CL + CW - R * 0.2, CT + R * 0.25, R * 0.10, 1);

  } else if (id === "stripes") {
    // Racing stripes: two bold diagonal bands sweeping across the hull.
    ctx.save();
    ctx.beginPath();
    ctx.rect(L, T, W, H);
    ctx.clip();
    ctx.lineWidth = R * 0.34;
    ctx.lineCap = "butt";
    ctx.strokeStyle = paint;
    for (const off of [-0.18, 0.14]) {
      ctx.beginPath();
      ctx.moveTo(L + W * (0.30 + off), T - R * 0.3);
      ctx.lineTo(L + W * (0.62 + off), T + H + R * 0.3);
      ctx.stroke();
    }
    ctx.restore();

  } else if (id === "hexScale") {
    // Honeycomb / scale mail: rows of hexagons in the second colour.
    const s = R * 0.26;               // hex "radius"
    const hw = s * Math.sqrt(3) / 2;  // half-width of a flat-top hex
    ctx.save();
    ctx.beginPath();
    ctx.rect(L, T, W, H);
    ctx.clip();
    ctx.lineWidth = Math.max(1, R * 0.04);
    ctx.strokeStyle = shade(colHex, 0.4);
    ctx.fillStyle = paint;
    let row = 0;
    for (let cy = T; cy < T + H + s; cy += s * 1.5, row++) {
      const xoff = row % 2 ? hw : 0;
      for (let cx = L - hw; cx < L + W + hw * 2; cx += hw * 2) {
        const x = cx + xoff, y = cy;
        ctx.beginPath();
        for (let k = 0; k < 6; k++) {
          const a = Math.PI / 180 * (60 * k - 90);
          const px = x + Math.cos(a) * s, py = y + Math.sin(a) * s;
          if (k === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        }
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      }
    }
    ctx.restore();

  } else if (id === "flames") {
    // Hot-rod flames: licks streaming BACK from the nose, each a long
    // tapering tongue with a curled tip. The old one filled the rear of
    // the hull with a single jagged mass, which read as damage rather
    // than as fire.
    const rng = patRng(seedId + "flame");
    for (let i = 0; i < 7; i++) {
      const y0 = CT + CH * (0.08 + (i / 6) * 0.84) + (rng() - 0.5) * R * 0.1;
      const len = R * (0.75 + rng() * 1.15);
      const thick = R * (0.10 + rng() * 0.13);
      const x0 = R * 1.15;                       // start at the nose
      const curl = (rng() - 0.5) * R * 0.5;
      ctx.beginPath();
      ctx.moveTo(x0, y0 - thick);
      ctx.quadraticCurveTo(x0 - len * 0.45, y0 - thick * 1.5,
                           x0 - len, y0 + curl);
      ctx.quadraticCurveTo(x0 - len * 0.4, y0 + thick * 1.4, x0, y0 + thick);
      ctx.closePath();
      ctx.fill();
    }

  } else if (id === "circuit") {
    // A board trace layout: rails running the length of the hull with
    // right-angled branches off them, junction pads where they meet and
    // vias dotted along. Previously a handful of stray lines floating in
    // space, which looked unfinished rather than technical.
    const rng = patRng(seedId + "circ");
    ctx.lineWidth = Math.max(1, R * 0.055);
    ctx.lineCap = "square";
    const rails = 4;
    for (let i = 0; i < rails; i++) {
      const y = CT + CH * ((i + 0.6) / (rails + 0.2));
      ctx.beginPath(); ctx.moveTo(CL + R * 0.1, y); ctx.lineTo(CL + CW - R * 0.1, y); ctx.stroke();
      const branches = 2 + Math.floor(rng() * 3);
      for (let b = 0; b < branches; b++) {
        const x = CL + R * 0.25 + rng() * (CW - R * 0.5);
        const dy = (rng() < 0.5 ? -1 : 1) * R * (0.16 + rng() * 0.24);
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x, y + dy);
        ctx.lineTo(x + (rng() < 0.5 ? -1 : 1) * R * (0.12 + rng() * 0.2), y + dy);
        ctx.stroke();
        ctx.beginPath(); ctx.arc(x, y, R * 0.055, 0, Math.PI * 2); ctx.fill();
      }
    }
    for (let v = 0; v < 9; v++) {
      const x = CL + rng() * CW, y = CT + rng() * CH;
      ctx.beginPath(); ctx.arc(x, y, R * 0.045, 0, Math.PI * 2); ctx.fill();
    }

  } else if (id === "tiger") {
    // Real tiger striping: tapered bars running ACROSS the hull, each
    // pinched to a point at one end and some of them forked. Straight
    // even bands were just Racing Stripes wearing a different hat.
    const rng = patRng(seedId + "tiger");
    const stripe = (yc, w2, lean, len, flip) => {
      ctx.beginPath();
      ctx.moveTo(-len * flip, yc - w2);
      ctx.quadraticCurveTo(lean * 0.3, yc - w2 * 1.25, len * flip, yc - w2 * 0.12);
      ctx.quadraticCurveTo(lean * 0.3, yc + w2 * 1.25, -len * flip, yc + w2);
      ctx.closePath();
      ctx.fill();
    };
    for (let i = 0; i < 11; i++) {
      const yc = CT + CH * ((i + 0.5) / 11) + (rng() - 0.5) * R * 0.08;
      const w2 = R * (0.055 + rng() * 0.075);
      const len = R * (0.55 + rng() * 0.75);
      stripe(yc, w2, (rng() - 0.5) * R, len, i % 2 ? 1 : -1);
      if (rng() < 0.30) stripe(yc + w2 * 2.4, w2 * 0.55, 0, len * 0.55, i % 2 ? 1 : -1);
    }

  } else if (id === "galaxy") {
    // GALAXY (the flashy Diamond one): a deep nebula wash in the second
    // colour, a bright spiral core, and a scatter of twinkling stars —
    // the stars shimmer slowly so it always looks alive.
    const rng = patRng(seedId + "galaxy");
    ctx.save();
    ctx.beginPath();
    ctx.rect(L, T, W, H);
    ctx.clip();
    const cx = L + W * 0.5, cy = T + H * 0.5;
    // nebula: soft radial cloud of the second colour
    const neb = ctx.createRadialGradient(cx, cy, R * 0.05, cx, cy, R * 0.95);
    neb.addColorStop(0, mix(colHex, "#ffffff", 0.5));
    neb.addColorStop(0.4, paintHexToRGBA(colHex, 0.85));
    neb.addColorStop(1, paintHexToRGBA(colHex, 0.12));
    ctx.fillStyle = neb;
    ctx.fillRect(L, T, W, H);
    // spiral arms: a couple of faint logarithmic-ish sweeps
    ctx.strokeStyle = mix(colHex, "#ffffff", 0.55);
    ctx.lineWidth = Math.max(1, R * 0.05);
    ctx.globalAlpha = 0.5;
    for (let arm = 0; arm < 2; arm++) {
      ctx.beginPath();
      for (let t2 = 0; t2 < 1; t2 += 0.05) {
        const ang = arm * Math.PI + t2 * Math.PI * 2.2;
        const rad = t2 * R * 0.7;
        const px = cx + Math.cos(ang) * rad, py = cy + Math.sin(ang) * rad * 0.7;
        if (t2 === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    // bright core
    const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * 0.2);
    core.addColorStop(0, "#ffffff");
    core.addColorStop(1, paintHexToRGBA(colHex, 0));
    ctx.fillStyle = core;
    ctx.beginPath();
    ctx.arc(cx, cy, R * 0.2, 0, Math.PI * 2);
    ctx.fill();
    // twinkling stars
    const stars = 16;
    for (let i = 0; i < stars; i++) {
      const sx = L + rng() * W, sy = T + rng() * H;
      const ph = rng() * Math.PI * 2;
      const tw = 0.4 + 0.6 * Math.abs(Math.sin(now / 520 + ph)); // slow twinkle
      ctx.globalAlpha = tw;
      ctx.fillStyle = "#ffffff";
      const sr = R * (0.02 + rng() * 0.03);
      ctx.beginPath();
      ctx.arc(sx, sy, sr, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    ctx.restore();

  } else if (id === "checker") {
    // Hard geometric squares. The simplest of the new set and priced
    // that way — bold at a glance, nothing clever going on.
    const cols = 6, rows = 4;
    const cw = W / cols, ch = H / rows;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if ((r + c) % 2 === 0) ctx.fillRect(L + c * cw, T + r * ch, cw + 0.5, ch + 0.5);
      }
    }

  } else if (id === "hazard") {
    // Industrial caution barring: heavy diagonals with a clean band at
    // each end. No clip — the bars run the full length of the barrel too.
    const step = R * 0.42;
    for (let x = CL - CH; x < CL + CW + CH; x += step * 2) {
      ctx.beginPath();
      ctx.moveTo(x, CT); ctx.lineTo(x + step, CT);
      ctx.lineTo(x + step + CH, CT + CH); ctx.lineTo(x + CH, CT + CH);
      ctx.closePath(); ctx.fill();
    }
    ctx.fillRect(CL, T, CW, H * 0.14);
    ctx.fillRect(CL, T + H * 0.86, CW, H * 0.14);

  } else if (id === "chevron") {
    // Nested arrowheads pointing down the barrel, so the tank reads as
    // aimed even standing still.
    ctx.lineWidth = R * 0.15;
    ctx.lineJoin = "miter";
    for (let i = 0; i < 8; i++) {
      const x = CL + R * 0.1 + i * R * 0.34;
      ctx.beginPath();
      ctx.moveTo(x, CT + CH * 0.08);
      ctx.lineTo(x + R * 0.30, CT + CH * 0.5);
      ctx.lineTo(x, CT + CH * 0.92);
      ctx.stroke();
    }

  } else if (id === "plaid") {
    // Woven tartan: bands both ways with a thin companion line, and the
    // crossings doubling up the way real cloth does.
    ctx.globalAlpha = 0.5;
    for (let i = 0; i < 7; i++) {
      const x = CL + (i + 0.5) * (CW / 7);
      ctx.fillRect(x - R * 0.13, CT, R * 0.26, CH);
      ctx.fillRect(x - R * 0.30, CT, R * 0.05, CH);
    }
    for (let i = 0; i < 7; i++) {
      const y = CT + (i + 0.5) * (CH / 7);
      ctx.fillRect(CL, y - R * 0.13, CW, R * 0.26);
      ctx.fillRect(CL, y - R * 0.30, CW, R * 0.05);
    }
    ctx.globalAlpha = 1;

  } else if (id === "splatter") {
    // Thrown paint: hard-edged blots with droplet trails flung off them.
    const rng = patRng(seedId + "splat");
    for (let i = 0; i < 15; i++) {
      const bx = CL + rng() * CW, by = CT + rng() * CH;
      const br = R * (0.10 + rng() * 0.14);
      ctx.beginPath();
      const lobes = 9;
      for (let k = 0; k <= lobes; k++) {
        const a2 = (k / lobes) * Math.PI * 2;
        const rad = br * (0.6 + rng() * 0.8);
        const px = bx + Math.cos(a2) * rad, py = by + Math.sin(a2) * rad;
        if (k === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.closePath(); ctx.fill();
      const dir = rng() * Math.PI * 2;
      for (let d = 1; d <= 5; d++) {
        const dd = br * (1.25 + d * 0.62);
        ctx.beginPath();
        ctx.arc(bx + Math.cos(dir) * dd, by + Math.sin(dir) * dd,
                Math.max(0.6, br * (0.32 - d * 0.05)), 0, Math.PI * 2);
        ctx.fill();
      }
    }

  } else if (id === "carbon") {
    // Carbon twill: a proper 2×2 basket weave. Every cell is filled —
    // each holds a pair of tows, and the pair alternates direction from
    // cell to cell, which is what makes a weave look woven. The old
    // version skipped every other cell and left bare gaps.
    const cell2 = R * 0.26;
    const cols2 = Math.ceil(CW / cell2), rows2 = Math.ceil(CH / cell2);
    for (let r2 = 0; r2 < rows2; r2++) {
      for (let c = 0; c < cols2; c++) {
        const x = CL + c * cell2, y = CT + r2 * cell2;
        const flip = (c + r2) % 2 === 0;
        ctx.globalAlpha = flip ? 0.85 : 0.5;
        if (flip) {
          ctx.fillRect(x, y, cell2 * 0.96, cell2 * 0.46);
          ctx.fillRect(x, y + cell2 * 0.5, cell2 * 0.96, cell2 * 0.46);
        } else {
          ctx.fillRect(x, y, cell2 * 0.46, cell2 * 0.96);
          ctx.fillRect(x + cell2 * 0.5, y, cell2 * 0.46, cell2 * 0.96);
        }
      }
    }
    ctx.globalAlpha = 1;

  } else if (id === "scales") {
    // Overlapping reptile scales, offset row to row so each tucks under
    // the one ahead.
    const sw = R * 0.34, sh = R * 0.28;
    let row = 0;
    for (let y = CT - sh; y < CT + CH + sh; y += sh * 0.6, row++) {
      const off = (row % 2) * sw * 0.5;
      for (let x = CL - sw; x < CL + CW + sw; x += sw) {
        ctx.beginPath();
        ctx.moveTo(x + off, y);
        ctx.quadraticCurveTo(x + off + sw * 0.5, y + sh * 1.35, x + off + sw, y);
        ctx.closePath();
        ctx.globalAlpha = 0.4 + (row % 2) * 0.22;
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;

  } else if (id === "topo") {
    // Survey contours: nested rings around a couple of peaks, each ring
    // a fixed height step.
    ctx.lineWidth = Math.max(0.8, R * 0.045);
    const peaks = [
      { x: CL + CW * 0.32, y: CT + CH * 0.40 },
      { x: CL + CW * 0.70, y: CT + CH * 0.62 },
    ];
    for (const pk of peaks) {
      for (let k = 1; k <= 9; k++) {
        const rad = k * R * 0.17;
        ctx.beginPath();
        const steps = 24;
        for (let i2 = 0; i2 <= steps; i2++) {
          const a2 = (i2 / steps) * Math.PI * 2;
          const wob = 1 + Math.sin(a2 * 3 + k) * 0.13 + Math.sin(a2 * 5 - k * 2) * 0.07;
          const px = pk.x + Math.cos(a2) * rad * wob * 1.25;
          const py = pk.y + Math.sin(a2) * rad * wob;
          if (i2 === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        }
        ctx.closePath();
        ctx.stroke();
      }
    }

  } else if (id === "shatter") {
    // Cracked glass: shards radiating from an impact point with the
    // fracture lines drawn over them.
    const rng = patRng(seedId + "shatter");
    const hx2 = 0, hy2 = 0;
    const n = 13;
    const rad = [];
    for (let i = 0; i <= n; i++) rad.push(R * (0.9 + rng() * 1.7));
    for (let i = 0; i < n; i++) {
      if (i % 2) continue;
      const a0 = (i / n) * Math.PI * 2, a1 = ((i + 1) / n) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(hx2, hy2);
      ctx.lineTo(hx2 + Math.cos(a0) * rad[i], hy2 + Math.sin(a0) * rad[i]);
      ctx.lineTo(hx2 + Math.cos(a1) * rad[i + 1], hy2 + Math.sin(a1) * rad[i + 1]);
      ctx.closePath();
      ctx.globalAlpha = 0.5;
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    ctx.lineWidth = Math.max(0.8, R * 0.05);
    for (let i = 0; i < n; i++) {
      const a0 = (i / n) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(hx2, hy2);
      ctx.lineTo(hx2 + Math.cos(a0) * rad[i], hy2 + Math.sin(a0) * rad[i]);
      ctx.stroke();
    }
    for (let ring = 1; ring <= 3; ring++) {
      ctx.beginPath();
      for (let i = 0; i <= n; i++) {
        const a0 = ((i % n) / n) * Math.PI * 2;
        const rr2 = rad[i % n] * (0.3 + ring * 0.24);
        const px = hx2 + Math.cos(a0) * rr2, py = hy2 + Math.sin(a0) * rr2;
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.closePath(); ctx.stroke();
    }

  } else if (id === "aurora") {
    // The most expensive thing on the shelf, so it has to earn it:
    // layered curtains of light, each fading out along its own length
    // as well as top and bottom, drifting slowly, with a scatter of
    // stars behind them. The old one was a single flat swathe of colour
    // — which is precisely why it looked like it belonged near the
    // bottom of the price list.
    const rng = patRng(seedId + "aur");
    const drift = now / 2600;
    for (let st = 0; st < 14; st++) {
      const sx = CL + rng() * CW, sy = CT + rng() * CH;
      ctx.globalAlpha = 0.25 + rng() * 0.5;
      ctx.beginPath();
      ctx.arc(sx, sy, R * (0.018 + rng() * 0.030), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    for (let b = 0; b < 6; b++) {
      const phase = rng() * Math.PI * 2 + drift * (0.5 + rng());
      const amp = CH * (0.10 + rng() * 0.15);
      const yBase = CT + CH * (0.16 + rng() * 0.68);
      const thick = R * (0.10 + rng() * 0.18);
      const g2 = ctx.createLinearGradient(0, yBase - amp - thick * 2, 0, yBase + amp + thick * 2);
      g2.addColorStop(0.00, paintHexToRGBA(colHex, 0));
      g2.addColorStop(0.42, paintHexToRGBA(colHex, 0.95));
      g2.addColorStop(0.58, paintHexToRGBA(colHex, 0.95));
      g2.addColorStop(1.00, paintHexToRGBA(colHex, 0));
      ctx.fillStyle = g2;
      ctx.beginPath();
      const steps = 20;
      for (let i2 = 0; i2 <= steps; i2++) {
        const x = CL + (i2 / steps) * CW;
        const y = yBase + Math.sin(phase + (i2 / steps) * Math.PI * 2.4) * amp;
        const t2 = thick * (0.35 + Math.sin((i2 / steps) * Math.PI) * 0.85);
        if (i2 === 0) ctx.moveTo(x, y - t2); else ctx.lineTo(x, y - t2);
      }
      for (let i2 = steps; i2 >= 0; i2--) {
        const x = CL + (i2 / steps) * CW;
        const y = yBase + Math.sin(phase + (i2 / steps) * Math.PI * 2.4) * amp;
        const t2 = thick * (0.35 + Math.sin((i2 / steps) * Math.PI) * 0.85);
        ctx.lineTo(x, y + t2);
      }
      ctx.closePath();
      ctx.fill();
    }
    ctx.fillStyle = paint;

  }
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

// Blend hexA toward hexB by fraction f (0 = A, 1 = B). Used by the
// metal finishes so highlights ramp cleanly to white and shadows to a
// true near-black, instead of the muddy extrapolation `shade` gives.
function mix(hexA, hexB, f) {
  const a = parseInt(hexA.slice(1), 16);
  const b = parseInt(hexB.slice(1), 16);
  const t = Math.max(0, Math.min(1, f));
  const r = Math.round(((a >> 16) & 255) + (((b >> 16) & 255) - ((a >> 16) & 255)) * t);
  const g = Math.round(((a >> 8) & 255) + (((b >> 8) & 255) - ((a >> 8) & 255)) * t);
  const c = Math.round((a & 255) + ((b & 255) - (a & 255)) * t);
  return `rgb(${r}, ${g}, ${c})`;
}

// A hex colour as an rgba() string at the given alpha (for soft washes
// like the galaxy nebula).
function paintHexToRGBA(hex, alpha) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}
