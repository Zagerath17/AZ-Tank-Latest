// ================================================================
// online.js — lobby system on Firebase Realtime Database.
//
//   lobbies/{code}: {
//     createdAt, hostId, state: "waiting" | "starting",
//     round: { n, seed },     // pushed by the controller each round
//     gear: { [key]: {x, y, type} },    // weapon pickups on the floor
//     players: {
//       [id]: {
//         joinedAt: server timestamp,
//         bot: "easy"|...|"impossible"  // only on host-added bots
//         pos:   { x, y, a, u },        // streamed during the match (u = turret aim)
//         dead:  true,                  // this round
//         gun:   "laser"|"mg"|"rocket"|"cannon", // equipped pickup
//         shots: { [key]: {x, y, a, w?} }, // shots; w = special type
//       }
//     }
//   }
//
// Authority model: each client simulates its own tank and reports
// its own shots/death. The "controller" (host, or the first human
// if the host left) also simulates the bots and pushes new rounds.
// Colors come from join order. Max MAX_PLAYERS tanks (bots count).
// ================================================================

import { onEnter, showScreen, toast, COLORS, COLOR_NAMES, tankSVG, paintVar } from "./main.js";
import { SKINS, BOT_SKINS, DEFAULT_SKIN } from "./skins.js";
import { sanitize as sanitizeUpgrades } from "./upgrades.js";
import { firebaseConfig, isConfigured } from "./firebase-config.js";
import { WEAPON_TYPES, WEAPON_LABEL } from "./weapons.js";
import { startOnlineGame, onlineLobbyUpdate, stopGame, getMatchStats, GEAR_CAP_LIMIT } from "./game.js";
import * as social from "./social.js";
import { showVersus, recordResult } from "./versus.js";
import { showMatchResults } from "./results.js";
import { startChat, stopChat, updateChatColors } from "./chat.js";
import { AI_LEVELS } from "./ai.js";

const FB_VERSION = "10.12.2";
// A custom lobby holds up to eight tanks (bots count). 1v1 matchmaking
// makes a lobby of 2; this is the ceiling for everything else, and
// social.js gates its invites on the same number so the two can't
// drift apart.
export const MAX_PLAYERS = 8;
const SHOT_TTL = 7000; // ms before a shot record is cleaned up

let fb = null;      // firebase handle bundle
let current = null; // { code, lobbyRef, playerRef, disc, unsub, inGame, playersCache }

/* ---------- firebase (lazy) ---------- */

export async function ensureFirebase() {
  if (fb) return fb;

  // Catch the most common setup mistake before it turns into a silent hang.
  const url = firebaseConfig.databaseURL || "";
  if (!/^https:\/\/[a-z0-9-]+[^ ]*\.(firebaseio\.com|firebasedatabase\.app)\/?$/i.test(url)) {
    throw new Error(
      "databaseURL looks wrong in firebase-config.js — copy the exact URL " +
      "shown at the top of the Realtime Database → Data tab.",
    );
  }

  const base = `https://www.gstatic.com/firebasejs/${FB_VERSION}`;
  const [appMod, dbMod] = await Promise.all([
    import(`${base}/firebase-app.js`),
    import(`${base}/firebase-database.js`),
  ]).catch(() => {
    throw new Error("Couldn't load Firebase — check your connection.");
  });
  const app = appMod.initializeApp(firebaseConfig);
  fb = {
    app, // the auth SDK attaches to this
    base, // CDN base, so social.js loads matching SDK versions
    db: dbMod.getDatabase(app),
    ref: dbMod.ref,
    get: dbMod.get,
    set: dbMod.set,
    update: dbMod.update,
    remove: dbMod.remove,
    onValue: dbMod.onValue,
    // Child-level listeners: they let the lobby subscription watch each
    // child on its own instead of re-materialising the whole lobby every
    // time any one field changes.
    onChildAdded: dbMod.onChildAdded,
    onChildChanged: dbMod.onChildChanged,
    onChildRemoved: dbMod.onChildRemoved,
    onDisconnect: dbMod.onDisconnect,
    serverTimestamp: dbMod.serverTimestamp,
    query: dbMod.query,
    orderByChild: dbMod.orderByChild,
    limitToLast: dbMod.limitToLast,
    startAt: dbMod.startAt,
    push: dbMod.push,
    goOffline: dbMod.goOffline,
    goOnline: dbMod.goOnline,
  };
  // On page hide, close the realtime socket cleanly. This lets
  // onDisconnect fire server-side WITHOUT the SDK's sync-XHR unload
  // path (the one browsers warn about re: sendBeacon).
  if (!fb._clockHooked) {
    fb._clockHooked = true;
    trackServerClock(fb);
  }

  if (!fb._hideHooked) {
    fb._hideHooked = true;
    // Only on a genuine page teardown — not a tab switch, which would
    // wrongly drop presence. pageshow restores the socket if the page
    // is resurrected from the bfcache.
    window.addEventListener("pagehide", (e) => {
      if (!e.persisted) { try { fb.goOffline(fb.db); } catch (err) {} }
    });
    window.addEventListener("pageshow", (e) => {
      if (e.persisted) { try { fb.goOnline(fb.db); } catch (err) {} }
    });
  }

  return fb;
}

// Firebase publishes the estimated offset between this device's clock
// and the server's at /.info/serverTimeOffset. We track it so every
// client can agree on "now" within a few ms — the backbone of a clean
// synchronized match start.
let serverClockOffset = 0;
function trackServerClock(f) {
  try {
    f.onValue(f.ref(f.db, "/.info/serverTimeOffset"), (snap) => {
      const v = snap.val();
      if (typeof v === "number") serverClockOffset = v;
    });
  } catch (e) { /* offset stays 0 — falls back to local time */ }
}
function serverNow() {
  return Date.now() + serverClockOffset;
}

// Per-tab id, so two tabs count as two players (handy for testing).
// Stable per-tab identity, cached in memory as well as sessionStorage:
// if storage is blocked (private mode / embedded webview) the memory copy
// is the only thing keeping the id from changing on every call.
let cachedMyId = null;

function myId() {
  if (cachedMyId) return cachedMyId;
  let id = null;
  // sessionStorage can THROW outright (Safari private mode, embedded
  // webviews with storage blocked), so never let it kill the join.
  try { id = sessionStorage.getItem("tank.playerId"); } catch (e) { id = null; }
  if (!id) {
    // crypto.randomUUID only exists in a SECURE context. A phone joining
    // a PC's lobby over plain http:// on the LAN has no crypto at all, so
    // touching crypto.randomUUID there throws and the player ends up with
    // no identity — their tank isn't "theirs", so they can't move, shoot,
    // or take damage. Feel for it defensively and fall back.
    try {
      id = (typeof crypto !== "undefined" && crypto && typeof crypto.randomUUID === "function")
        ? crypto.randomUUID()
        : null;
    } catch (e) { id = null; }
    if (!id) {
      id = "p" + Math.random().toString(36).slice(2) + Date.now().toString(36)
        + Math.random().toString(36).slice(2, 6);
    }
    try { sessionStorage.setItem("tank.playerId", id); } catch (e) { /* memory-only id */ }
  }
  cachedMyId = id;
  return id;
}

// Paint is bought in the shop and worn as-is, but no two PLAYERS may
// share a colour: the earliest to join keeps exactly what they equipped,
// and anyone joining later in the same colour is bumped to a free primary
// so the table always reads clearly. Bots then fill in around everyone.
// It's all resolved deterministically in join order, so every client
// agrees on who wears what. Impossible bots are always black.
function resolveColors(entries) {
  const out = {};
  const taken = new Set();
  // Humans first — earliest join wins the colour; later clashers move.
  for (const [id, p] of entries) {
    if (p.bot) continue;
    let c = SKINS[p.color] && !SKINS[p.color].reserved ? p.color : DEFAULT_SKIN;
    if (taken.has(c)) c = pickBotColor(taken, id); // already worn → bump to a free primary
    out[id] = c;
    taken.add(c);
  }
  // Then bots, each avoiding every colour already on the field.
  for (const [id, p] of entries) {
    if (!p.bot) continue;
    if (p.bot === "impossible") { out[id] = "black"; continue; }
    // A bot's stored colour stands unless someone already wears it.
    let c = p.color && BOT_SKINS.includes(p.color) && !taken.has(p.color) ? p.color : null;
    if (!c) c = pickBotColor(taken, id);
    out[id] = c;
    taken.add(c);
  }
  return out;
}

// Deterministic per-bot fallback: every client must land on the same
// colour, so we walk the primary pool from a hash of the bot's id
// rather than calling Math.random().
function pickBotColor(taken, id) {
  const free = BOT_SKINS.filter((c) => !taken.has(c));
  const pool = free.length ? free : BOT_SKINS;
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return pool[h % pool.length];
}

// Join order for seats and conflict priority.
function sortPlayers(players) {
  return Object.entries(players ?? {}).sort(
    (a, b) => (a[1].joinedAt ?? 0) - (b[1].joinedAt ?? 0) || a[0].localeCompare(b[0]),
  );
}

// Matchmade lobbies are made by the 1v1 matchmaker, never by hand: the
// maker becomes host, and the match auto-starts once everyone's in.
export async function createMatchLobby(expect) {
  const f = await ensureFirebase();
  for (let attempt = 0; attempt < 25; attempt++) {
    const code = String(Math.floor(1000 + Math.random() * 9000));
    const lobbyRef = f.ref(f.db, `lobbies/${code}`);
    const existing = await f.get(lobbyRef);
    if (existing.exists()) continue;
    await f.set(lobbyRef, {
      createdAt: f.serverTimestamp(),
      hostId: myId(),
      state: "waiting",
      matched: true,   // came from the queue, not from a shared code
      expect,
      players: { [myId()]: {
        joinedAt: f.serverTimestamp(),
        name: social.getAccount()?.name ?? null,
        ukey: social.getAccount()?.key ?? null,
        color: social.getSkin(), // the paint you bought and equipped
        pattern: social.getPattern(),
        patColors: social.getPatternColors(),
        upgrades: social.getUpgrades(),
        level: social.getLevel(),
      } },
    });
    await enterLobby(code, { matched: true });
    return code;
  }
  throw new Error("Couldn't find a free lobby code.");
}

// What the social layer needs to know about my current lobby.
// Push my CURRENT paint to the lobby I'm sitting in.
//
// The look is written once when you join, so changing colour or pattern
// in the Shop — which is now reachable straight from the lobby — updated
// your profile and left the lobby node showing what you were wearing
// when you walked in. Everyone else, and the match itself, kept using
// the old one, so the change appeared to do nothing.
export async function syncMyLook() {
  if (!current?.code || current.inGame) return;
  try {
    const f = await ensureFirebase();
    const id = myId();
    await f.update(f.ref(f.db, `lobbies/${current.code}/players/${id}`), {
      color: social.getSkin(),
      pattern: social.getPattern(),
      patColors: social.getPatternColors(),
      upgrades: social.getUpgrades(),
      level: social.getLevel(),
    });
  } catch (e) { /* best-effort: the next join writes it anyway */ }
}

export function lobbyInfo() {
  if (!current) return null;
  return {
    code: current.code,
    players: Object.keys(current.playersCache ?? {}).length,
    isHost: !!current.isHost,
  };
}

// ---- outbound write coalescing -------------------------------------
// Every in-game stream (position, shots, hits, deaths) used to fire its
// own Firebase call, so a single frame could open half a dozen separate
// round trips — and sendDead alone made three. They're now queued by
// full path and flushed as ONE atomic update at the end of the current
// JS turn. Same data, same ordering (last write to a path wins, exactly
// as before), a fraction of the round trips and overhead.
//
// The flush is a microtask, so it lands in the same tick the frame
// produced it: nothing is delayed, it's only batched. Paths are resolved
// (lobby code included) at queue time, so a queued packet still goes to
// the right lobby even if the player leaves before it flushes.
let txQueue = null;
let txScheduled = false;

function txFlush() {
  txScheduled = false;
  const q = txQueue;
  txQueue = null;
  if (!q || !fb) return;
  try {
    fb.update(fb.ref(fb.db), q).catch(() => {});
  } catch (e) { /* dropped packet beats a freeze */ }
}

function txPush(fullPath, value) {
  if (!fb) return;
  (txQueue ??= {})[fullPath] = value;
  if (!txScheduled) {
    txScheduled = true;
    queueMicrotask(txFlush);
  }
}

// ---- deferred cleanup ----------------------------------------------
// Transient records (shots, hits) need deleting once they're stale. That
// used to mean one setTimeout AND one delete round trip per packet — in
// a firefight, dozens of each. Now they go on a single sweep that batches
// every due delete into the same coalesced update.
let gcDue = [];
let gcTimer = 0;

function gcLater(fullPath, delay) {
  gcDue.push({ path: fullPath, at: Date.now() + delay });
  if (!gcTimer) gcTimer = setInterval(gcSweep, 1000);
}

function gcSweep() {
  if (!gcDue.length) { clearInterval(gcTimer); gcTimer = 0; return; }
  const now = Date.now();
  const keep = [];
  for (const e of gcDue) {
    if (e.at <= now) txPush(e.path, null); // batched with everything else
    else keep.push(e);
  }
  gcDue = keep;
  if (!gcDue.length) { clearInterval(gcTimer); gcTimer = 0; }
}

function gcReset() {
  gcDue = [];
  if (gcTimer) { clearInterval(gcTimer); gcTimer = 0; }
}

// Fire-and-forget write helper used by the in-game streams.
// Several lobby paths in one atomic update.
function writeMany(map) {
  if (!current || !fb) return;
  for (const [k, v] of Object.entries(map)) txPush(`lobbies/${current.code}/${k}`, v);
}

function write(path, value) {
  if (!current || !fb) return;
  // Queued rather than sent immediately, so everything a frame produces
  // leaves as one update. txFlush swallows errors the same way the old
  // direct set() did — a dropped packet is always better than a freeze.
  txPush(`lobbies/${current.code}/${path}`, value);
}

/* ---------- create / join ---------- */

async function createLobby() {
  const f = await ensureFirebase();

  for (let attempt = 0; attempt < 25; attempt++) {
    const code = String(Math.floor(1000 + Math.random() * 9000)); // 1000–9999
    const lobbyRef = f.ref(f.db, `lobbies/${code}`);

    const snap = await f.get(lobbyRef);
    if (snap.exists()) continue; // code taken, roll again

    await f.set(lobbyRef, {
      createdAt: f.serverTimestamp(),
      hostId: myId(),
      state: "waiting",
      hideCode: localStorage.getItem("tank.hideCode.v1") === "1",
      settings: defaultSettings(),
      players: { [myId()]: {
        joinedAt: f.serverTimestamp(),
        name: social.getAccount()?.name ?? null,
        ukey: social.getAccount()?.key ?? null,
        color: social.getSkin(), // the paint you bought and equipped
        pattern: social.getPattern(),
        patColors: social.getPatternColors(),
        upgrades: social.getUpgrades(),
        level: social.getLevel(),
      } },
    });
    await enterLobby(code);
    return;
  }
  throw new Error("Couldn't find a free code — try again.");
}

export async function joinLobby(code) {
  const f = await ensureFirebase();
  const snap = await f.get(f.ref(f.db, `lobbies/${code}`));

  if (!snap.exists()) throw new Error("No lobby with that code.");
  const lobby = snap.val();
  const ids = Object.keys(lobby.players ?? {});

  if (!ids.includes(myId())) {
    if (lobby.state !== "waiting") throw new Error("That match has already started.");
    if (ids.length >= MAX_PLAYERS) throw new Error(`Lobby is full — ${MAX_PLAYERS} tanks max.`);
    await f.set(f.ref(f.db, `lobbies/${code}/players/${myId()}`), {
      joinedAt: f.serverTimestamp(),
      name: social.getAccount()?.name ?? null,
      ukey: social.getAccount()?.key ?? null,
      color: social.getSkin(), // the paint you bought and equipped
      pattern: social.getPattern(),
      patColors: social.getPatternColors(),
      upgrades: social.getUpgrades(),
      level: social.getLevel(),
    });
  }
  await enterLobby(code, { matched: !!lobby.matched });
}

/* ---------- lobby lifecycle ---------- */

// `opts.matched` — a lobby that came out of the 1v1 queue must NOT drop
// you on the custom lobby screen. Both flows share this plumbing, and
// it used to show the lobby UI unconditionally, so being matchmade
// dumped you into what looked like a custom lobby sitting with your
// opponent. A matchmade lobby instead stays put (the 1v1 screen already
// reads "match found") until the snapshot handler moves everyone to the
// versus card and then into the match.
async function enterLobby(code, opts = {}) {
  const f = await ensureFirebase();

  const lobbyRef = f.ref(f.db, `lobbies/${code}`);
  const playerRef = f.ref(f.db, `lobbies/${code}/players/${myId()}`);

  // If this tab dies, the server removes the player automatically.
  const disc = f.onDisconnect(playerRef);
  await disc.remove();

  // `current` is set BEFORE subscribing: child listeners replay existing
  // data immediately on attach, and every callback checks `current`.
  current = {
    code, lobbyRef, playerRef, disc, unsub: () => {},
    inGame: false, playersCache: {}, matched: !!opts.matched,
  };
  current.unsub = subscribeLobby(f, code, () => {
    stopGame();
    toast("Lost connection to the lobby.");
    exitToOnline();
  });
  if (!opts.matched) showScreen("screen-lobby");
}

function exitToOnline() {
  if (current) {
    try { current.unsub(); } catch { /* already gone */ }
    gcReset();
    current = null;
  }
  showScreen("screen-online");
}

async function leaveLobby() {
  social.setStatus("online");
  stopChat();
  if (current?.versusPoll) clearInterval(current.versusPoll);
  if (current?.versusCountdown) clearInterval(current.versusCountdown);
  const c = current;

  // ABANDONING A 1v1: there's no rating to dock any more, but walking
  // out is still a loss, so the head-to-head record books it as 0:3 and
  // my damage/kill ledger is published so the player who stayed sees a
  // complete results screen rather than half a match. Computed BEFORE I
  // remove myself, best-effort.
  if (c && c.matched && !c.matchSettled && c.inGame && c.matchInfo) {
    c.matchSettled = true;
    const acc = social.getAccount();
    const me = acc ? c.matchInfo.find((r) => r.key === acc.key) : null;
    if (me) {
      const abortStats = getMatchStats(); // grab before stopGame() clears S
      const merged = c.matchInfo.map((r) => ({
        ...r,
        score: r.key === acc.key ? 0 : 3,
      }));
      recordResult(merged.map((m) => ({ id: m.id, key: m.key, score: m.score })))
        .catch(() => {})
        .then(async () => {
          try {
            const f = await ensureFirebase();
            const stats = abortStats;
            if (!stats) return;
            await f.update(f.ref(f.db), {
              [`lobbies/${c.code}/damageLog/${stats.myId}`]: stats.dmgBy ?? {},
              [`lobbies/${c.code}/killLog/${stats.myId}`]: stats.killsBy ?? {},
            });
          } catch (e) { /* best-effort */ }
        });
      toast("Abandoned a 1v1 — counted as a loss.", 5000);
    }
  }

  stopGame(); // no-op if we weren't mid-match
  const dest = c?.matched ? "screen-duel" : "screen-online";
  if (!c) { showScreen(dest); return; }

  gcReset();
  current = null;
  try { c.unsub(); } catch { /* already gone */ }
  showScreen(dest);

  // Best-effort cleanup: remove me; if only bots (or nobody) remain,
  // remove the whole lobby — bots can't play by themselves.
  try {
    const f = await ensureFirebase();
    try { await c.disc.cancel(); } catch { /* fine */ }
    // If I'm the host and other humans remain, hand the crown to the
    // earliest-joined human BEFORE I drop out. Doing it here (rather
    // than only relying on a survivor noticing the empty host seat)
    // makes reassignment reliable even if snapshots race.
    try {
      const myKey = myId();
      const liveHost = (await f.get(f.ref(f.db, `lobbies/${c.code}/hostId`))).val();
      if (liveHost === myKey) {
        const before = await f.get(f.ref(f.db, `lobbies/${c.code}/players`));
        const bp = before.val() ?? {};
        const others = Object.entries(bp)
          .filter(([id, p]) => id !== myKey && !p.bot)
          .sort((a, b) => (a[1].joinedAt ?? 0) - (b[1].joinedAt ?? 0) || a[0].localeCompare(b[0]));
        if (others.length) {
          await f.set(f.ref(f.db, `lobbies/${c.code}/hostId`), others[0][0]);
        }
      }
    } catch { /* best-effort handoff */ }
    await f.remove(c.playerRef);
    const rest = await f.get(f.ref(f.db, `lobbies/${c.code}/players`));
    const players = rest.val();
    const humansLeft = players && Object.values(players).some((p) => !p.bot);
    if (!humansLeft) await f.remove(c.lobbyRef);
  } catch { /* offline — onDisconnect already covered us */ }
}

// Host only: kick off round 1 with a shared seed.
async function startMatch() {
  if (!current) return;
  const f = await ensureFirebase();
  await f.update(current.lobbyRef, {
    state: "starting",
    // startAt is a SERVER timestamp: every client shows the versus
    // card for 3 s measured from this shared clock, then begins — no
    // per-device drift, so everyone drops into the round together.
    round: { n: 1, seed: Math.floor(Math.random() * 2147483647), startAt: f.serverTimestamp() },
  });
}

/* ---------- bots (host manages them as lobby entries) ---------- */

function tableColors(exceptId) {
  const res = current?.resolvedCache ?? {};
  return new Set(Object.entries(res).filter(([id]) => id !== exceptId).map(([, c]) => c));
}

// NOTE: there's no "add a bot" control in the custom lobby any more —
// lobbies fill with real players. cycleBot/removeBot are kept because a
// lobby created before this change (or by an older client) can still
// contain bot entries the host needs to adjust or clear.
async function cycleBot(id, level) {
  if (!current) return;
  const f = await ensureFirebase();
  const next = AI_LEVELS[(AI_LEVELS.indexOf(level) + 1) % AI_LEVELS.length];
  const updates = { [`players/${id}/bot`]: next };
  // Impossible wears black, always. Coming back down from
  // impossible, it needs a normal coat again.
  if (next === "impossible") updates[`players/${id}/color`] = "black";
  else if (level === "impossible") updates[`players/${id}/color`] = freeColor(tableColors(id));
  await f.update(current.lobbyRef, updates);
}


async function removeBot(id) {
  if (!current) return;
  const f = await ensureFirebase();
  await f.remove(f.ref(f.db, `lobbies/${current.code}/players/${id}`));
}

// The code display follows the HOST's synced toggle: when the host
// hides the code (handy while streaming), it's hidden for everyone in
// the room, and only the host gets the button. Copy still copies the
// real code for whoever already has it.
let hideWanted = false;   // what THIS client last asked for, for instant paint

function renderLobbyCode(code, lobby) {
  // Prefer the lobby's own value; fall back to what we just asked for so
  // the first paint after a click is never blank or stale.
  const hidden = lobby && "hideCode" in lobby ? !!lobby.hideCode : hideWanted;
  // Am I the host? Prefer the snapshot, but fall back to what we
  // already worked out. This used to read the snapshot ALONE, so the
  // very first paint — which happens on entering the lobby, before any
  // snapshot has arrived, with lobby === null — hid the button, and if
  // a later render didn't run the host never got it back. That is the
  // failure mode where the host simply has no hide button.
  const host = lobby ? lobby.hostId === myId() : !!current?.isHost;
  // Matchmade 1v1 lobbies have no code worth hiding.
  const matched = !!(lobby ?? current?.lastLobby)?.matched;

  const el = document.getElementById("lobby-code");
  if (el) el.textContent = hidden ? "••••" : (code ?? "····");

  const label = document.getElementById("lobby-code-label");
  if (label) {
    label.textContent = hidden
      ? (host ? "Lobby code — hidden from everyone" : "Lobby code — hidden by the host")
      : "Lobby code — share it with friends";
  }

  const btn = document.getElementById("lobby-hide");
  if (btn) {
    btn.textContent = hidden ? "SHOW CODE" : "HIDE CODE";
    btn.hidden = !host || matched;      // host of a custom lobby only
  }
  // The host keeps Copy either way (they know their own code); everyone
  // else loses it while the code is hidden, or hiding would be pointless.
  const copy = document.getElementById("lobby-copy");
  if (copy) copy.hidden = hidden && !host;
}

/* ---------- custom-lobby match settings (host-controlled) ---------- */

const SIZE_KEYS = ["small", "medium", "large", "xl"];
const SIZE_LABEL = { small: "Small", medium: "Medium", large: "Large", xl: "Extra large" };

// The host's match settings, remembered between lobbies. They used to
// reset to the defaults on every lobby you made, so a host who liked
// (say) large maps with no rockets had to set it up again every single
// time they pressed Create.
const LS_HOST_SET = "tank.hostSettings.v1";

function baseSettings() {
  const gear = {};
  for (const w of WEAPON_TYPES) gear[w] = true;
  const sizes = {};
  for (const k of SIZE_KEYS) sizes[k] = true;
  return { sizes, gear, gearMax: 24, zone: false, zoneSec: 30, upgrades: true };
}

export function saveHostSettings(s) {
  try { localStorage.setItem(LS_HOST_SET, JSON.stringify(s)); } catch { /* ignore */ }
}

function defaultSettings() {
  const d = baseSettings();
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(LS_HOST_SET) || "{}") ?? {}; } catch { saved = {}; }
  const sizes = {};
  for (const k of SIZE_KEYS) sizes[k] = saved.sizes?.[k] ?? d.sizes[k];
  // Never restore a state with nothing enabled — that can't start a match.
  if (!SIZE_KEYS.some((k) => sizes[k])) for (const k of SIZE_KEYS) sizes[k] = true;
  const gear = {};
  for (const w of WEAPON_TYPES) gear[w] = saved.gear?.[w] ?? d.gear[w];
  return {
    sizes, gear,
    gearMax: Math.max(1, Math.min(30, saved.gearMax ?? d.gearMax)),
    zone: saved.zone ?? d.zone,
    zoneSec: Math.max(10, Math.min(60, saved.zoneSec ?? d.zoneSec)),
    upgrades: saved.upgrades ?? d.upgrades,
  };
}

// Normalize whatever's on the lobby into a complete settings object —
// old lobbies (no settings node) and partial writes both land on the
// defaults rather than breaking the match.
function readSettings(lobby) {
  const d = defaultSettings();
  const s = lobby?.settings ?? {};
  const sizes = {};
  for (const k of SIZE_KEYS) sizes[k] = s.sizes?.[k] ?? d.sizes[k];
  const gear = {};
  for (const w of WEAPON_TYPES) gear[w] = s.gear?.[w] ?? d.gear[w];
  const max = Math.max(1, Math.min(GEAR_CAP_LIMIT, s.gearMax ?? d.gearMax));
  const zone = s.zone ?? d.zone;
  const zoneSec = Math.max(10, Math.min(60, s.zoneSec ?? d.zoneSec));
  const upgrades = s.upgrades ?? d.upgrades;
  return { sizes, gear, gearMax: max, zone, zoneSec, upgrades };
}

function settingsToOpts(lobby) {
  const s = readSettings(lobby);
  const sizePool = SIZE_KEYS.filter((k) => s.sizes[k]);
  const gearPool = WEAPON_TYPES.filter((w) => s.gear[w]);
  return {
    sizePool: sizePool.length ? sizePool : SIZE_KEYS,
    gearPool, // may be empty — that means "no pickups this match"
    gearMax: s.gearMax,
    zone: s.zone,
    zonePeriod: s.zoneSec,
  };
}

// The host's settings panel. Guests never see it; the host's edits
// write straight to the lobby so everyone's match uses them.
function renderSettings(lobby, isHost) {
  const panel = document.getElementById("lobby-settings");
  if (!panel) return;
  // Matchmade lobbies use fixed competitive rules — no knobs.
  panel.hidden = !isHost || !!lobby.matched;
  if (panel.hidden) return;
  const s = readSettings(lobby);
  // Remember whatever the host currently has set, so their next lobby
  // opens with the same rules instead of the defaults.
  saveHostSettings(s);

  const sizesEl = document.getElementById("set-sizes");
  sizesEl.innerHTML = SIZE_KEYS.map((k) => `
    <button class="btn btn-small set-chip ${s.sizes[k] ? "is-on" : ""}"
            data-size="${k}" type="button">${SIZE_LABEL[k]}</button>`).join("");
  sizesEl.querySelectorAll("[data-size]").forEach((b) => {
    b.addEventListener("click", () => {
      const k = b.dataset.size;
      const next = { ...s.sizes, [k]: !s.sizes[k] };
      if (!SIZE_KEYS.some((x) => next[x])) { toast("Keep at least one map size."); return; }
      write(`settings/sizes/${k}`, next[k]);
    });
  });

  const gearEl = document.getElementById("set-gear");
  gearEl.innerHTML = WEAPON_TYPES.map((w) => `
    <button class="btn btn-small set-chip ${s.gear[w] ? "is-on" : ""}"
            data-gear="${w}" type="button">${WEAPON_LABEL[w] ?? w}</button>`).join("");
  gearEl.querySelectorAll("[data-gear]").forEach((b) => {
    b.addEventListener("click", () => write(`settings/gear/${b.dataset.gear}`, !s.gear[b.dataset.gear]));
  });

  const slider = document.getElementById("set-max");
  const valEl = document.getElementById("set-max-val");
  slider.max = String(GEAR_CAP_LIMIT);
  slider.value = String(s.gearMax);
  valEl.textContent = String(s.gearMax);
  slider.oninput = () => { valEl.textContent = slider.value; };
  slider.onchange = () => write("settings/gearMax", Math.max(1, Math.min(GEAR_CAP_LIMIT, +slider.value)));

  // Closing zone: an on/off chip plus a 10–60 s timer that only shows
  // when the zone is on.
  const zoneChip = document.getElementById("set-zone");
  if (zoneChip) {
    zoneChip.classList.toggle("is-on", s.zone);
    zoneChip.textContent = s.zone ? "ZONE: ON" : "ZONE: OFF";
    zoneChip.onclick = () => write("settings/zone", !s.zone);
  }
  // Skill points on or off for this lobby. Off gives a level field —
  // useful for a fair game among friends at different levels.
  const upChip = document.getElementById("set-upgrades");
  if (upChip) {
    upChip.classList.toggle("is-on", s.upgrades);
    upChip.textContent = s.upgrades ? "UPGRADES: ON" : "UPGRADES: OFF";
    upChip.onclick = () => write("settings/upgrades", !s.upgrades);
  }
  const zoneRow = document.getElementById("set-zone-timer");
  if (zoneRow) zoneRow.hidden = !s.zone;
  const zSlider = document.getElementById("set-zone-sec");
  const zVal = document.getElementById("set-zone-val");
  if (zSlider && zVal) {
    zSlider.min = "10"; zSlider.max = "60"; zSlider.step = "5";
    zSlider.value = String(s.zoneSec);
    zVal.textContent = `${s.zoneSec}s`;
    zSlider.oninput = () => { zVal.textContent = `${zSlider.value}s`; };
    zSlider.onchange = () => write("settings/zoneSec", Math.max(10, Math.min(60, +zSlider.value)));
  }

  const on = WEAPON_TYPES.filter((w) => s.gear[w]).length;
  const note = document.getElementById("set-note");
  if (!on) {
    note.textContent = "No abilities selected — this match spawns no pickups.";
  } else {
    // The field fills evenly: every greenlit ability reaches this
    // depth before any of them goes deeper.
    const each = Math.floor(s.gearMax / on);
    const extra = s.gearMax % on;
    note.textContent = each < 1
      ? `${s.gearMax} on the field, cycling through ${on} abilit${on === 1 ? "y" : "ies"}.`
      : `${on} abilities · ${each} of each` + (extra ? `, plus a ${each + 1}${each + 1 === 2 ? "nd" : each + 1 === 3 ? "rd" : "th"} of ${extra}.` : ".");
  }
}

/* ---------- snapshot routing ---------- */

// A player node's HOT fields: the high-frequency in-match streams. Every
// other field (name, colour, bot, gun, dead, joinedAt, elo, …) is COLD
// and can change who's in the lobby, who hosts, or what the UI shows.
const HOT_PLAYER_FIELDS = new Set(["pos", "shots", "outHits", "hits"]);

// A compact fingerprint of everything on a player EXCEPT the hot streams.
// Stored as a primitive string rather than comparing objects, because two
// successive snapshots can hand back the same underlying object — and a
// comparison that silently sees "no change" would classify a death or a
// colour swap as hot and skip the prologue that acts on it. A string
// snapshot can't alias, so that whole class of bug is gone.
function coldSignature(p) {
  if (!p) return "";
  const parts = [];
  for (const k of Object.keys(p).sort()) {
    if (HOT_PLAYER_FIELDS.has(k)) continue;
    const v = p[k];
    parts.push(k + "\u0001" + (v !== null && typeof v === "object" ? JSON.stringify(v) : String(v)));
  }
  return parts.join("\u0002");
}

// Subscribe to a lobby WITHOUT re-reading the whole thing on every write.
//
// The old design put one onValue on `lobbies/{code}`, so a single
// position write — and there are several per player per second — handed
// us a freshly materialised copy of the entire lobby (every player, gear,
// settings, chat, kill logs) and re-ran the full prologue over it.
//
// Instead we watch children individually and patch a local mirror:
//   • children of `lobbies/{code}`  — everything except `players`
//   • children of `.../players`     — one entry per player
// so a position update only materialises that one player's node. No key
// list is hardcoded anywhere: Firebase tells us which child changed, so a
// lobby field added later is mirrored automatically.
//
// The mirror is then handed to the SAME handleSnapshot as before, so all
// downstream behaviour is byte-for-byte what it was.
function subscribeLobby(f, code, onError) {
  const lobbyRef = f.ref(f.db, `lobbies/${code}`);
  const playersRef = f.ref(f.db, `lobbies/${code}/players`);
  const mirror = { players: {} };
  const offs = [];

  let pendingKind = null;   // "cold" | "hot"
  let scheduled = false;
  let seeded = false;       // initial load complete?

  // Coalesce a burst into ONE delivery. This matters twice over: on join,
  // Firebase replays a child event per existing field, and we must not
  // hand downstream a half-built lobby; in-match, several players landing
  // in the same tick become one pass instead of several. A microtask is
  // the same JS turn, so nothing is actually deferred.
  //
  // Nothing is delivered at all until `seeded`: the value event below
  // fires only once every child at this path has loaded, so gating on it
  // guarantees the first snapshot downstream sees is complete — exactly
  // the atomicity the single whole-lobby listener used to provide.
  const deliver = (kind) => {
    pendingKind = pendingKind === "cold" ? "cold" : kind; // cold wins
    if (!seeded || scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      const kind2 = pendingKind;
      pendingKind = null;
      if (!current || current.code !== code) return;
      deliverMirror(code, mirror, kind2);
    });
  };

  // --- top-level children, except `players` (handled per-child below).
  // `players` is skipped WITHOUT touching snap.val(), so the whole player
  // map is never materialised here.
  const topAdd = (snap) => {
    if (snap.key === "players") return;
    mirror[snap.key] = snap.val();
    deliver("cold");
  };
  const topRemove = (snap) => {
    if (snap.key === "players") return;
    delete mirror[snap.key];
    deliver("cold");
  };
  offs.push(f.onChildAdded(lobbyRef, topAdd, onError));
  offs.push(f.onChildChanged(lobbyRef, topAdd, onError));
  offs.push(f.onChildRemoved(lobbyRef, topRemove, onError));

  // --- one player at a time.
  // coldSigs remembers each player's non-stream fields, so a change can
  // be classified without ever comparing two snapshot objects.
  const coldSigs = Object.create(null);
  offs.push(f.onChildAdded(playersRef, (snap) => {
    const v = snap.val();
    mirror.players[snap.key] = v;
    coldSigs[snap.key] = coldSignature(v);
    deliver("cold"); // someone arrived
  }, onError));
  offs.push(f.onChildRemoved(playersRef, (snap) => {
    delete mirror.players[snap.key];
    delete coldSigs[snap.key];
    deliver("cold"); // someone left — host may migrate
  }, onError));
  offs.push(f.onChildChanged(playersRef, (snap) => {
    const v = snap.val();
    mirror.players[snap.key] = v;
    const sig = coldSignature(v);
    const hot = coldSigs[snap.key] === sig; // nothing but streams moved
    coldSigs[snap.key] = sig;
    deliver(hot ? "hot" : "cold");
  }, onError));

  // --- existence + load barrier. Fires often, but never calls val(), so
  // there's nothing to materialise — it exists to keep the original
  // "lobby closed" behaviour exactly as it was, and to signal when the
  // initial load is complete (Firebase raises the value event only after
  // every child at this path has arrived).
  offs.push(f.onValue(lobbyRef, (snap) => {
    if (!current || current.code !== code) return;
    if (!snap.exists()) {
      stopGame();
      toast("Lobby closed.");
      exitToOnline();
      return;
    }
    if (!seeded) {
      seeded = true;
      deliver("cold"); // release the complete first snapshot
    }
  }, onError));

  return () => { for (const off of offs) { try { off(); } catch { /* already gone */ } } };
}

// Hand the mirror downstream. A COLD update runs the full prologue
// exactly as before. A HOT one — only positions/shots/hits moved — skips
// straight to the in-match apply, because every branch in that prologue
// is driven by cold state: host migration needs the player list to
// change, cancellation and the screen transitions need `state` to change,
// and the solo-return check needs a human to leave. If we're not
// certainly mid-match, the full path runs regardless.
function deliverMirror(code, mirror, kind) {
  if (kind === "hot" && current.inGame && mirror.state === "starting") {
    current.playersCache = mirror.players ?? {};
    current.lastLobby = mirror;
    onlineLobbyUpdate(mirror);
    return;
  }
  handleSnapshot(code, {
    exists: () => Object.keys(mirror).length > 1 || Object.keys(mirror.players).length > 0,
    val: () => mirror,
  });
}

function handleSnapshot(code, snap) {
  if (!current || current.code !== code) return;

  if (!snap.exists()) {
    stopGame();
    toast("Lobby closed.");
    exitToOnline();
    return;
  }

  const lobby = snap.val();
  current.playersCache = lobby.players ?? {};

  // Host rights follow the players: if the host's seat is empty, the
  // earliest-joined human claims the crown — in the lobby AND mid-game.
  const me = myId();
  const entries = sortPlayers(lobby.players);
  const humans = entries.filter(([, p]) => !p.bot);
  if (lobby.hostId && !lobby.players?.[lobby.hostId] && humans[0]?.[0] === me) {
    write("hostId", me);
  }

  if (lobby.state === "cancelled") {
    toast("A player never arrived — match cancelled. Queue again!");
    leaveLobby();
    showScreen("screen-duel");
    return;
  }

  if (current.inGame && lobby.state !== "starting") {
    // The host ended the match — everyone regroups in the lobby.
    stopGame();
    current.inGame = false;
    social.setStatus("lobby", code);
    toast("Back to the lobby.");
    showScreen("screen-lobby");
  }

  if (lobby.state === "starting" && lobby.round?.seed != null) {
    current.lastLobby = lobby; // keep fresh so the versus timer sees updates
    if (!current.inGame && !current.versusShown) {
      enterVersus(code, lobby);
    } else if (!current.inGame && current.versusShown) {
      maybeBeginFromReady(code, lobby);
    } else if (current.inGame) {
      if (humans.length === 1 && humans[0][0] === me && !lobby.matched) {
        // Casual: alone with bots → back to the lobby.
        returnToLobbySolo(entries);
      } else {
        // A matchmade 1v1 stays in-match even when the opponent bails —
        // onlineLobbyUpdate turns that into an automatic 3:0 win and
        // the results screen follows.
        onlineLobbyUpdate(lobby);
      }
    }
    return;
  }

  renderLobby(code, lobby);
}

// Host pulled the plug: reset the lobby so every client's snapshot
// handler walks them back to the lobby screen together.
function endMatchForAll() {
  if (!current) return;
  stopGame(); // the exit handler no longer pre-stops for online exits
  // The host transitions instantly; everyone else follows on the
  // snapshot that carries the state flip.
  current.inGame = false;
  social.setStatus("lobby", current.code);
  showScreen("screen-lobby");
  const entries = sortPlayers(current.playersCache ?? {});
  const updates = { state: "waiting", round: null, gear: null };
  for (const [id] of entries) {
    updates[`players/${id}/dead`] = null;
    updates[`players/${id}/deadBy`] = null;
    updates[`players/${id}/deadAt`] = null;
    updates[`players/${id}/outHits`] = null;
    updates[`players/${id}/hits`] = null;
    updates[`players/${id}/gun`] = null;
    updates[`players/${id}/shots`] = null;
    updates[`players/${id}/pos`] = null;
  }
  ensureFirebase()
    .then((f) => f.update(current.lobbyRef, updates))
    .catch(() => toast("Couldn't end the match — connection?"));
}

function returnToLobbySolo(entries) {
  stopGame();
  current.inGame = false;
  social.setStatus("lobby", current.code);
  toast("Everyone left — back to the lobby.");
  showScreen("screen-lobby");
  // Reset the lobby to waiting and scrub per-round leftovers so the
  // next START is clean.
  const updates = { state: "waiting", round: null, gear: null };
  for (const [id] of entries) {
    updates[`players/${id}/dead`] = null;
    updates[`players/${id}/deadBy`] = null;
    updates[`players/${id}/deadAt`] = null;
    updates[`players/${id}/outHits`] = null;
    updates[`players/${id}/hits`] = null;
    updates[`players/${id}/gun`] = null;
    updates[`players/${id}/shots`] = null;
    updates[`players/${id}/pos`] = null;
  }
  ensureFirebase()
    .then((f) => f.update(current.lobbyRef, updates))
    .catch(() => { /* the next snapshot retries via state check */ });
}

// Show the head-to-head card, mark myself ready, and wait for the
// rest (or a 6 s grace) before the round actually begins.
function enterVersus(code, lobby) {
  current.versusShown = true;
  const me = myId();
  const entries = sortPlayers(lobby.players);
  const resolved = resolveColors(entries);
  const roster = entries.slice(0, MAX_PLAYERS).map(([id, p]) => ({
    id, name: p.name ?? null, color: resolved[id], ukey: p.ukey ?? null, bot: p.bot ?? null,
    pattern: p.bot ? "solid" : (p.pattern ?? "solid"),
    patColors: p.bot ? [] : (Array.isArray(p.patColors) ? p.patColors : []),
  }));
  showVersus(roster, me, current?.playersCache ?? [], !!lobby.matched,
    lobby.matched ? true : lobby.settings?.upgrades !== false);
  showScreen("screen-versus");

  // Announce readiness (informational — the shared clock, not this
  // flag, is what actually starts the round).
  ensureFirebase().then((f) => {
    f.set(f.ref(f.db, `lobbies/${code}/ready/${me}`), true).catch(() => {});
  });

  // The countdown is driven by the SHARED server timestamp so every
  // client's 3-2-1 lines up. A steady rAF-style interval updates text.
  const waitEl = document.querySelector("#screen-versus .vs-wait");
  clearInterval(current.versusCountdown);
  current.versusCountdown = setInterval(() => {
    const startAt = current.lastLobby?.round?.startAt;
    const left = startAt ? Math.max(0, Math.ceil((startAt + 3000 - serverNow()) / 1000)) : 3;
    if (waitEl) waitEl.textContent = left > 0 ? `Starting in ${left}…` : "Starting…";
  }, 150);

  maybeBeginFromReady(code, lobby);
}

// Begin once the shared 3 s window has elapsed. Because it's anchored
// to the server clock (not each device's local time), all clients fire
// within a frame or two of each other — no straggler stuck on the card.
function maybeBeginFromReady(code, lobby) {
  if (current.inGame) return;
  const startAt = lobby.round?.startAt ?? current.lastLobby?.round?.startAt;
  const elapsed = startAt ? serverNow() - startAt : 0;
  if (elapsed >= 3000) {
    beginOnlineGame(code, lobby);
  } else if (!current.versusPoll) {
    // Poll on a timer AND off snapshots; whichever fires first wins.
    const delay = Math.max(60, 3000 - elapsed);
    current.versusPoll = setTimeout(() => {
      current.versusPoll = 0;
      if (current?.lastLobby && !current.inGame) {
        maybeBeginFromReady(current.code, current.lastLobby);
      }
    }, Math.min(delay, 400));
  }
}

function beginOnlineGame(code, lobby) {
  if (current.versusPoll) { clearTimeout(current.versusPoll); current.versusPoll = 0; }
  if (current.versusCountdown) { clearInterval(current.versusCountdown); current.versusCountdown = 0; }
  const me = myId();
  const entries = sortPlayers(lobby.players);
  const resolved = resolveColors(entries);
  const roster = entries
    .slice(0, MAX_PLAYERS)
    .map(([id, p]) => ({
      id, color: resolved[id], bot: p.bot ?? null, name: p.name ?? null,
      // Patterns ride along so remote tanks show the same two-tone look.
      // Bots always run solid.
      pattern: p.bot ? "solid" : (p.pattern ?? "solid"),
      patColors: p.bot ? [] : (Array.isArray(p.patColors) ? p.patColors : []),
      // Each player's own upgrade allocation, sanitised against the
      // level they claim. It arrives over the network, so it is never
      // trusted as sent: sanitize() pares anything beyond what that
      // level could have earned. Bots run stock.
      upgrades: p.bot ? {} : sanitizeUpgrades(p.upgrades ?? {}, p.level ?? 0),
      level: p.bot ? 0 : (p.level ?? 0),
    }));

  if (!roster.some((p) => p.id === me && !p.bot)) {
    toast("The match started without you.");
    leaveLobby();
    return;
  }

  current.inGame = true;
  social.setStatus("round");

  // Everyone in a matchmade lobby is on their own — there are no teams
  // any more, so nothing here has to resolve team paint or work out
  // whose side someone is on.
  const matchInfo = lobby.matched
    ? entries.slice(0, MAX_PLAYERS).map(([id, p]) => ({
        id,
        key: p.ukey ?? null,
        name: p.name ?? p.ukey ?? "Player",
      }))
    : null;

  // Remember the match context so leaving mid-fight can still book the
  // loss. matchSettled flips true the moment the result is decided
  // normally, so leaveLobby won't double-book it.
  if (current) {
    current.matched = !!lobby.matched;
    current.matchInfo = matchInfo;
    current.matchSettled = false;
  }

  const setOpts = settingsToOpts(lobby);
  startOnlineGame({
    duel: !!lobby.matched,
    // A matchmade 1v1 always runs upgrades; a custom lobby runs them
    // only if the host switched them on.
    upgradesOn: lobby.matched ? true : lobby.settings?.upgrades !== false,
    serverNow, // shared match clock (device clock + Firebase offset)
    // Custom lobbies honour the host's panel; a matchmade 1v1 uses the
    // fixed competitive rules and ignores it.
    sizePool: lobby.matched ? null : setOpts.sizePool,
    gearPool: lobby.matched ? null : setOpts.gearPool,
    gearMax: lobby.matched ? null : setOpts.gearMax,
    zone: lobby.matched ? undefined : setOpts.zone,
    zonePeriod: lobby.matched ? undefined : setOpts.zonePeriod,
    winTarget: lobby.matched ? 3 : null, // 1v1: first to 3
    casualPlayers: !lobby.matched ? entries.slice(0, MAX_PLAYERS).map(([id, p]) => ({
      id, key: p.ukey ?? null,
    })) : null,
    onDuelEnd: (placements, myStats = null) => {
      if (!matchInfo) return;
      if (current) current.matchSettled = true; // decided normally
      const look = (id) => roster.find((r) => r.id === id) ?? {};
      const merged = placements.map((pl) => ({
        ...(matchInfo.find((r) => r.id === pl.id) ?? { key: null }),
        color: look(pl.id).color ?? DEFAULT_SKIN,
        pattern: look(pl.id).pattern ?? "solid",
        patColors: look(pl.id).patColors ?? [],
        score: pl.score,
      }));
      const savedCode = code;
      const myKey = social.getAccount()?.key ?? null;
      (async () => {
        await recordResult(merged.map((m) => ({ id: m.id, key: m.key, score: m.score })))
          .catch(() => {});
        // Publish my damage/kill ledger so every finisher's results
        // screen can total the match up — a kill is only ever known on
        // the victim's own client.
        try {
          const f = await ensureFirebase();
          if (myStats) {
            await f.update(f.ref(f.db), {
              [`lobbies/${savedCode}/damageLog/${myStats.myId}`]: myStats.dmgBy ?? {},
              [`lobbies/${savedCode}/killLog/${myStats.myId}`]: myStats.killsBy ?? {},
            });
          }
        } catch (e) { /* results are best-effort */ }
        showMatchResults(savedCode, merged, myKey,
          () => { leaveLobby(); showScreen("screen-duel"); });
      })();
    },
    roundN: lobby.round.n,
    seed: lobby.round.seed,
    myId: me,
    roster,
    sendPos: (id, pos) => write(`players/${id}/pos`, pos),
    sendShot: (id, key, shot) => {
      write(`players/${id}/shots/${key}`, shot);
      // Shots are transient — swept once the bullet is long dead.
      gcLater(`lobbies/${code}/players/${id}/shots/${key}`, SHOT_TTL);
    },
    // Shooter-authoritative hits: the SHOOTER decides a hit landed and
    // publishes it in ITS OWN node, addressed to the victim.
    //
    // It used to write straight into the victim's node
    // (players/<victim>/hits/...). That's a CROSS-NODE write, and any
    // rule stricter than "anyone may write anything under this lobby" —
    // e.g. per-player write rules — rejects it. write() swallows the
    // rejection, so hits vanished silently while pos/shots (own-node
    // writes) kept working. Publishing to our own subtree means every
    // client only ever writes where it is unambiguously allowed to.
    sendHit: (victimId, key, hit) => {
      write(`players/${me}/outHits/${key}`, { ...hit, to: victimId });
      gcLater(`lobbies/${code}/players/${me}/outHits/${key}`, SHOT_TTL);
    },
    // The victim names its killer so the KILLER's client can score the
    // streak — damage resolves on the victim's machine, so this is the
    // only way they'd ever learn about their own multi-kill.
    sendDead: (id, byId, at) => {
      write(`players/${id}/dead`, true);
      if (byId) write(`players/${id}/deadBy`, byId);
      // When the death happened (shared server clock). Lets peers ignore
      // this flag once a later round has started.
      write(`players/${id}/deadAt`, typeof at === "number" ? at : serverNow());
    },
    sendGear: (key, gear) => write(`gear/${key}`, gear),
    sendGearRemove: (key) => write(`gear/${key}`, null),
    sendPickup: (gearKey, pid, type) => {
      // One atomic update: the pickup vanishes and the gun appears.
      // Queued, so it rides along with whatever else this frame sends.
      writeMany({ [`gear/${gearKey}`]: null, [`players/${pid}/gun`]: type });
    },
    sendGun: (id, type) => write(`players/${id}/gun`, type),
    sendNextRound: (n, seed) => {
      if (!current || !fb) return;
      const updates = { round: { n, seed }, gear: null };
      for (const pid of Object.keys(current.playersCache)) {
        updates[`players/${pid}/dead`] = null;
        updates[`players/${pid}/deadBy`] = null;
        updates[`players/${pid}/deadAt`] = null;
        updates[`players/${pid}/shots`] = null;
        // Damage packets outlive a round (SHOT_TTL), so scrub them too —
        // otherwise last round's hits are still on the wire when the new
        // round spawns and can be replayed into a fresh tank.
        updates[`players/${pid}/outHits`] = null;
        updates[`players/${pid}/hits`] = null;
        updates[`players/${pid}/gun`] = null;
      }
      fb.update(current.lobbyRef, updates).catch(() => {});
    },
    onExit: () => {
      // 1v1: exiting is an ABANDON — always leave (host included), so
      // the penalty path in leaveLobby runs. Casual: the host resets
      // the lobby for everyone; others just leave.
      if (!lobby.matched && current?.isHost) endMatchForAll();
      else leaveLobby();
    },
  });

  onlineLobbyUpdate(lobby); // apply the first snapshot's positions/flags
}

/* ---------- lobby screen render ---------- */

function renderLobby(code, lobby) {
  const me = myId();
  const entries = sortPlayers(lobby.players);
  const isHost = lobby.hostId === me;
  current.isHost = isHost;
  current.lastLobby = lobby;
  if (lobby.state === "waiting") { current.versusShown = false; } // ready for the next match card
  renderLobbyCode(code, lobby);
  social.setStatus("lobby", code);

  // Host with room (and an account) can beckon friends in — but
  // matchmade lobbies: no invites, no bots, auto-start.
  const socialBtn = document.getElementById("lobby-social");
  socialBtn.hidden = !(isHost && social.getAccount()) || !!lobby.matched;
  renderSettings(lobby, isHost);
  if (lobby.matched) {
    document.getElementById("lobby-start").hidden = true;
    if (isHost && lobby.state === "waiting") {
      const count = Object.keys(lobby.players ?? {}).length;
      const age = Date.now() - (lobby.createdAt ?? Date.now());
      if (count >= (lobby.expect ?? 4)) {
        startMatch().catch(() => {}); // strict size — no short-handed starts
      } else if (age > 40000) {
        write("state", "cancelled"); // a no-show — everyone re-queues
      } else if (!current.matchTimer) {
        current.matchTimer = setTimeout(() => {
          current.matchTimer = 0;
          if (current?.lastLobby) renderLobby(current.code, current.lastLobby);
        }, 4000);
      }
    }
  }

  const myIndex = entries.findIndex(([id]) => id === me);
  if (myIndex === -1) { toast("You were removed from the lobby."); exitToOnline(); return; }
  if (myIndex >= MAX_PLAYERS) { toast(`Lobby is full — ${MAX_PLAYERS} tanks max.`); leaveLobby(); return; }

  // Host migration: if the host vanished, the oldest HUMAN claims it.
  const hostP = lobby.players?.[lobby.hostId];
  const hostAlive = hostP && !hostP.bot;
  const firstHuman = entries.find(([, p]) => !p.bot);
  if (!hostAlive && firstHuman && firstHuman[0] === me) {
    ensureFirebase()
      .then((f) => f.update(current.lobbyRef, { hostId: me }))
      .catch(() => { /* retried on next snapshot */ });
  }

  // Pass the ACTUAL lobby. This used to hand in `null`, so every render
  // repainted the panel as "not hidden" — the toggle worked for a single
  // frame and the very next snapshot put the code straight back. That is
  // why the button looked completely dead.
  renderLobbyCode(code, lobby);

  // Paint equipped in the Shop only ever reached the lobby at JOIN time,
  // so changing it while sitting in one updated the Shop preview and
  // nothing else. Fold it in BEFORE colours are resolved — done after,
  // the resolve below immediately wrote the old colour back over it.
  if (!lobby.matched) {
    const worn = social.getSkin();
    const meRow = (lobby.players ?? {})[me];
    if (worn && meRow && !meRow.bot && meRow.color !== worn) {
      meRow.color = worn;                       // resolve against the new paint
      const row = entries.find(([id]) => id === me);
      if (row) row[1].color = worn;
      write(`players/${me}/color`, worn);
    }
  }

  const resolved = resolveColors(entries);
  current.playersCache = entries;
  current.resolvedCache = resolved;

  // My color choice lost a conflict (or was never set)? Adopt the
  // resolved one so the database matches what everyone sees.
  // Spin up casual text chat once (not in matchmade lobbies).
  if (!lobby.matched && !current.chatOn) {
    current.chatOn = true;
    startChat(code, resolved[me]);
  }
  // Keep the chat panel visible only for casual lobbies.
  const chatWrap = document.getElementById("lobby-chat");
  if (chatWrap) chatWrap.hidden = !!lobby.matched;

  // Feed every player's CURRENT color to the chat so old lines recolor
  // live when someone changes paint.
  if (!lobby.matched) {
    const colorMap = {};
    for (const [id, p] of entries) colorMap[id] = resolved[id] ?? p.color ?? DEFAULT_SKIN;
    updateChatColors(colorMap);
  }

  const mine = entries.find(([id]) => id === me);
  // Keep the color our outgoing chat lines are stamped with in sync.
  if (!lobby.matched) window.__myLobbyColor = resolved[me] ?? window.__myLobbyColor;
  if (mine && !mine[1].bot && mine[1].color !== resolved[me]) {
    if (mine[1].color) toast(`That paint was taken — you're ${COLOR_NAMES[resolved[me]]} now.`);
    write(`players/${me}/color`, resolved[me]);
  }

  // Seats are capped by MAX_PLAYERS, not by the 4-entry COLORS list the
  // local (couch) game uses. Empty seats just need a tint to preview, so
  // they borrow the free primaries.
  const SEAT_TINTS = ["red", "green", "blue", "yellow", "orange", "cyan", "pink", "lime"];
  const seats = Array.from({ length: MAX_PLAYERS }, (_, i) => SEAT_TINTS[i % SEAT_TINTS.length]);
  document.getElementById("lobby-players").innerHTML = seats.map((slotColor, i) => {
    const entry = entries[i];
    if (!entry) {
      return `<li class="lobby-row empty">${tankSVG(slotColor)}<span>Waiting for a tank…</span></li>`;
    }
    const [id, p] = entry;
    const color = resolved[id];

    if (p.bot) {
      const locked = p.bot === "impossible";
      // Bot paint isn't chosen any more — it's a random primary that
      // dodges whatever the players are wearing.
      const controls = isHost
        ? `<button class="chip chip-btn" data-bot-cycle="${id}" data-level="${p.bot}">BOT · ${p.bot.toUpperCase()}</button>
           <button class="chip chip-btn" data-bot-remove="${id}" aria-label="Remove bot">✕</button>`
        : `<span class="chip">BOT · ${p.bot.toUpperCase()}</span>`;
      return `
        <li class="lobby-row" style="${paintVar(color)}">
          ${tankSVG(color)}
          <span class="lobby-name">${COLOR_NAMES[color]} <em>· bot${locked ? " · locked" : ""}</em></span>
          <span class="row-end">${controls}</span>
        </li>`;
    }

    return `
      <li class="lobby-row" style="${paintVar(color)}">
        ${tankSVG({ color, pattern: p.pattern, patColors: p.patColors })}
        <span class="lobby-name">${p.name ?? COLOR_NAMES[color]}</span>
        <span class="row-end">${id === lobby.hostId ? '<span class="chip">HOST</span>' : ""}</span>
      </li>`;
  }).join("");

  const startBtn = document.getElementById("lobby-start");
  const status = document.getElementById("lobby-status");

  if (isHost) {
    startBtn.hidden = false;
    startBtn.disabled = entries.length < 2;
    status.textContent = entries.length < 2
      ? "Share the code, or add a bot — you need at least 2 tanks."
      : `${entries.length} tanks ready. You're the host.`;
  } else {
    startBtn.hidden = true;
    status.textContent = "Waiting for the host to start…";
  }
}

/* ---------- wiring ---------- */

// Wraps async actions: disables the button while pending, times out
// instead of hanging forever, and toasts the real error.
function guard(btn, fn) {
  return async () => {
    if (btn.disabled) return;
    btn.disabled = true;
    try {
      await Promise.race([
        fn(),
        new Promise((_, rej) =>
          setTimeout(() => rej(new Error(
            "Timed out reaching Firebase. Check: (1) you created a REALTIME " +
            "Database (not Firestore), (2) databaseURL in firebase-config.js " +
            "matches the URL on its Data tab, (3) the rules are published.",
          )), 10000),
        ),
      ]);
    } catch (err) {
      toast(err?.message ?? "Something went wrong.", 6000);
    } finally {
      btn.disabled = false;
    }
  };
}

// Coming back from the Shop should apply the new paint at once, without
// waiting for whatever the next snapshot happens to be.
export function syncLobbyPaint() {
  if (!current || !current.lastLobby) return;
  const me = myId();
  const lob = current.lastLobby;
  if (lob.matched) return;
  const worn = social.getSkin();
  const row = (lob.players ?? {})[me];
  if (worn && row && !row.bot && row.color !== worn) {
    row.color = worn;
    write(`players/${me}/color`, worn);
  }
}

export function initOnline() {
  // Returning to the lobby (e.g. Back from the Shop) re-applies paint.
  onEnter("screen-lobby", syncLobbyPaint);
  const codeInput = document.getElementById("join-code");
  const createBtn = document.getElementById("btn-create");
  const joinBtn = document.getElementById("btn-join");
  const startBtn = document.getElementById("lobby-start");
  // The HOST's toggle hides the code for the WHOLE lobby: it's written
  // to the lobby node, so every client's snapshot hides it together.
  const hideBtn = document.getElementById("lobby-hide");
  hideBtn.addEventListener("click", () => {
    if (!current) return;
    // No host test here. The button is only ever SHOWN to the host, and
    // gating the click on current.lastLobby / current.isHost meant that
    // whenever either was still undefined the handler returned and the
    // button appeared dead — which is exactly what it was doing.
    const lob = current.lastLobby;
    const next = !(lob && "hideCode" in lob ? !!lob.hideCode : hideWanted);
    hideWanted = next;
    localStorage.setItem("tank.hideCode.v1", next ? "1" : "0"); // remembered for my next lobby
    if (lob) lob.hideCode = next;                                // instant local paint
    renderLobbyCode(current.code, lob);
    write("hideCode", next);
  });

  document.getElementById("lobby-social").addEventListener("click", () => {
    social.toggleInvitePanel();
  });

  // Match settings fold open/shut (host-only panel).
  const setToggle = document.getElementById("settings-toggle");
  setToggle?.addEventListener("click", () => {
    const body = document.getElementById("settings-body");
    const caret = document.getElementById("settings-caret");
    if (!body) return;
    body.hidden = !body.hidden;
    if (caret) caret.textContent = body.hidden ? "▾" : "▴";
  });
  document.getElementById("set-gear-all")?.addEventListener("click", () => {
    if (!current?.isHost) return;
    const up = {};
    for (const w of WEAPON_TYPES) up[`settings/gear/${w}`] = true;
    writeMany(up);
  });
  document.getElementById("set-gear-none")?.addEventListener("click", () => {
    if (!current?.isHost) return;
    const up = {};
    for (const w of WEAPON_TYPES) up[`settings/gear/${w}`] = false;
    writeMany(up);
  });

  const copyBtn = document.getElementById("lobby-copy");

  onEnter("screen-online", () => {
    document.getElementById("online-actions").hidden = !isConfigured;
    document.getElementById("online-warning").hidden = isConfigured;
  });

  onEnter("screen-join", () => { codeInput.value = ""; });

  codeInput.addEventListener("input", () => {
    codeInput.value = codeInput.value.replace(/\D/g, "").slice(0, 4);
  });
  codeInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") joinBtn.click();
  });

  createBtn.addEventListener("click", guard(createBtn, createLobby));

  joinBtn.addEventListener("click", guard(joinBtn, async () => {
    const code = codeInput.value.trim();
    if (!/^\d{4}$/.test(code)) throw new Error("Enter the 4-digit code.");
    await joinLobby(code);
  }));

  startBtn.addEventListener("click", guard(startBtn, startMatch));

  // Bot difficulty / removal chips (host only; delegated). Paint is
  // no longer touchable here — it comes from the shop.
  document.getElementById("screen-lobby").addEventListener("click", async (e) => {
    const cyc = e.target.closest("[data-bot-cycle]");
    const rem = e.target.closest("[data-bot-remove]");
    if (!cyc && !rem) return;
    try {
      if (cyc) await cycleBot(cyc.dataset.botCycle, cyc.dataset.level);
      else await removeBot(rem.dataset.botRemove);
    } catch (err) {
      toast(err?.message ?? "Couldn't update the bot.");
    }
  });

  document.getElementById("lobby-leave").addEventListener("click", () => leaveLobby());

  copyBtn.addEventListener("click", async () => {
    if (!current) return;
    try {
      await navigator.clipboard.writeText(current.code);
      toast("Code copied.");
    } catch {
      toast(`Copy blocked by the browser — code is ${current.code}.`);
    }
  });
}
