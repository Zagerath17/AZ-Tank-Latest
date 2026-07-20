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
import { SKINS, BOT_SKINS, DEFAULT_SKIN, skinHex } from "./skins.js";
import { resolveTeamPaint } from "./teamcolor.js";
import { firebaseConfig, isConfigured } from "./firebase-config.js";
import { WEAPON_TYPES, WEAPON_LABEL } from "./weapons.js";
import { startOnlineGame, onlineLobbyUpdate, stopGame, getMatchStats, GEAR_CAP_LIMIT } from "./game.js";
import * as social from "./social.js";
import { rankBadge, applyMatchResult } from "./ranked.js";
import { showVersus, recordResult } from "./versus.js";
import { showRankedResults } from "./results.js";
import { startChat, stopChat, updateChatColors } from "./chat.js";
import { AI_LEVELS } from "./ai.js";

const FB_VERSION = "10.12.2";
// Custom lobbies hold up to eight tanks. (Ranked still matchmakes to
// 2 or 4 — this is just the ceiling.)
const MAX_PLAYERS = 8;
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
function myId() {
  let id = sessionStorage.getItem("tank.playerId");
  if (!id) {
    id = crypto.randomUUID?.() ?? "p" + Math.random().toString(36).slice(2) + Date.now().toString(36);
    sessionStorage.setItem("tank.playerId", id);
  }
  return id;
}

// Paint is bought in the shop and worn as-is — a player's colour is
// their identity now, so nobody gets bumped off theirs. Bots fill in
// around them: a random PRIMARY that no human at the table wears (and
// that no other bot has taken), resolved deterministically in join
// order so every client agrees. Impossible bots are always black.
function resolveColors(entries) {
  const out = {};
  const taken = new Set();
  // Humans first — they keep exactly what they equipped.
  for (const [id, p] of entries) {
    if (p.bot) continue;
    const c = SKINS[p.color] && !SKINS[p.color].reserved ? p.color : DEFAULT_SKIN;
    out[id] = c;
    taken.add(c);
  }
  // Then bots, each avoiding every colour already on the field.
  for (const [id, p] of entries) {
    if (!p.bot) continue;
    if (p.bot === "impossible") { out[id] = "black"; continue; }
    // A bot's stored colour stands unless a player wears it.
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

async function myEloOrNull(f, field) {
  const acc = social.getAccount();
  if (!acc) return null;
  try {
    const s = await f.get(f.ref(f.db, `users/${acc.key}/${field}`));
    return s.exists() ? s.val() : 500;
  } catch (e) { return null; }
}

// Ranked lobbies are made by the matchmaker, never by hand: the
// maker becomes host, everyone auto-starts once assembled.
export async function createRankedLobby(mode, expect, teams = null, teamLeaders = null) {
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
      ranked: true,
      rankedMode: mode, // "1v1" | "2v2"
      expect,
      teams: teams ?? null, // 2v2: { [ukey]: 0|1 }
      teamLeaders: teamLeaders ?? null, // 2v2: { 0: ukey, 1: ukey }
      players: { [myId()]: {
        joinedAt: f.serverTimestamp(),
        name: social.getAccount()?.name ?? null,
        ukey: social.getAccount()?.key ?? null,
        color: social.getSkin(), // the paint you bought and equipped
        pattern: social.getPattern(),
        patColors: social.getPatternColors(),
        e1: await myEloOrNull(f, "elo1"),
        e2: await myEloOrNull(f, "elo2v2"),
      } },
    });
    await enterLobby(code);
    return code;
  }
  throw new Error("Couldn't find a free lobby code.");
}

// What the social layer needs to know about my current lobby.
export function lobbyInfo() {
  if (!current) return null;
  return {
    code: current.code,
    players: Object.keys(current.playersCache ?? {}).length,
    isHost: !!current.isHost,
  };
}

// Roster (humans, excluding me) for the per-player audio mixer.
export function lobbyPeers() {
  if (!current) return [];
  const me = myId();
  const entries = current.playersCache ?? [];
  const resolved = current.resolvedCache ?? {};
  return entries
    .filter(([id, p]) => id !== me && !p.bot)
    .map(([id, p]) => ({ id, name: p.name ?? "Player", color: resolved[id] ?? DEFAULT_SKIN, ukey: p.ukey ?? null }));
}

// Fire-and-forget write helper used by the in-game streams.
// Several lobby paths in one atomic update.
function writeMany(map) {
  if (!current || !fb) return;
  try {
    const full = {};
    for (const [k, v] of Object.entries(map)) full[`lobbies/${current.code}/${k}`] = v;
    fb.update(fb.ref(fb.db), full).catch(() => {});
  } catch (e) { /* dropped packet beats a freeze */ }
}

function write(path, value) {
  if (!current || !fb) return;
  // try/catch as well as .catch(): an invalid path makes ref() throw
  // SYNCHRONOUSLY, and a sync throw here would kill the caller's
  // animation loop. A dropped packet is always better than a freeze.
  try {
    fb.set(fb.ref(fb.db, `lobbies/${current.code}/${path}`), value).catch(() => {});
  } catch (e) {
    console.warn("write skipped:", path, e?.message);
  }
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
        e1: await myEloOrNull(f, "elo1"),
        e2: await myEloOrNull(f, "elo2v2"),
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
      e1: await myEloOrNull(f, "elo1"),
      e2: await myEloOrNull(f, "elo2v2"),
    });
  }
  await enterLobby(code);
}

// The player id this client uses for its couch Player 2. Distinct from
// myId() so both tanks get their own lobby node + position stream.
export function localGuestId() {
  return `${myId()}~g`;
}

// COUCH CO-OP join: seat BOTH players from this machine. Register the
// account normally, then add a second player entry for the guest with
// the synthetic guest ukey (so the teams map places it on our team and
// it never resolves to a real account for Elo). Both entries stream
// their own position from this one client.
export async function joinLobbyAsLocalDuo(code, guestUkey, acc) {
  const f = await ensureFirebase();
  const snap = await f.get(f.ref(f.db, `lobbies/${code}`));
  if (!snap.exists()) throw new Error("No lobby with that code.");
  const lobby = snap.val();
  if (lobby.state !== "waiting") throw new Error("That match has already started.");

  const gid = localGuestId();
  const e2 = await myEloOrNull(f, "elo2v2");
  const updates = {};
  if (!(lobby.players ?? {})[myId()]) {
    updates[`lobbies/${code}/players/${myId()}`] = {
      joinedAt: f.serverTimestamp(),
      name: social.getAccount()?.name ?? null,
      ukey: social.getAccount()?.key ?? null,
      color: social.getSkin(),
      pattern: social.getPattern(),
      patColors: social.getPatternColors(),
      e1: await myEloOrNull(f, "elo1"),
      e2,
    };
  }
  updates[`lobbies/${code}/players/${gid}`] = {
    joinedAt: f.serverTimestamp(),
    name: "Player 2",
    ukey: guestUkey,          // synthetic — never a real account
    guest: true,
    // Colour/pattern are resolved by team paint anyway (guest = host
    // 20% darker); store the host's so any raw reader shows the team.
    color: social.getSkin(),
    pattern: social.getPattern(),
    patColors: social.getPatternColors(),
    e1: null,
    e2,
  };
  await f.update(f.ref(f.db), updates);
  await enterLobby(code);
  // Clean the GUEST entry up too if this tab dies (enterLobby already
  // set that up for the account's own node).
  try {
    const gDisc = f.onDisconnect(f.ref(f.db, `lobbies/${code}/players/${gid}`));
    await gDisc.remove();
    if (current) current.guestDisc = gDisc;
  } catch (e) { /* best-effort */ }
}

/* ---------- lobby lifecycle ---------- */

async function enterLobby(code) {
  const f = await ensureFirebase();

  const lobbyRef = f.ref(f.db, `lobbies/${code}`);
  const playerRef = f.ref(f.db, `lobbies/${code}/players/${myId()}`);

  // If this tab dies, the server removes the player automatically.
  const disc = f.onDisconnect(playerRef);
  await disc.remove();

  const unsub = f.onValue(
    lobbyRef,
    (snap) => handleSnapshot(code, snap),
    () => { stopGame(); toast("Lost connection to the lobby."); exitToOnline(); },
  );

  current = { code, lobbyRef, playerRef, disc, unsub, inGame: false, playersCache: {} };
  showScreen("screen-lobby");
}

function exitToOnline() {
  if (current) {
    try { current.unsub(); } catch { /* already gone */ }
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

  // ABORT PENALTY: bailing on a live ranked match books a maximum loss
  // — a 0:3 scoreline for me. In 1v1 the opponent's own client turns my
  // exit into their 3:0 win; in 2v2 my three tablemates keep playing
  // (the abandoned player is now in a 1v2) and I'm dropped from their
  // final tally. Computed BEFORE I remove myself, best-effort.
  if (c && c.ranked && !c.rankedSettled && c.inGame && c.rankedInfo) {
    c.rankedSettled = true;
    const acc = social.getAccount();
    const me = acc ? c.rankedInfo.find((r) => r.key === acc.key) : null;
    if (me) {
      const abortStats = getMatchStats(); // grab before stopGame() clears S
      const merged = c.rankedInfo.map((r) => ({
        ...r,
        score: c.rMode === "1v1"
          ? (r.key === acc.key ? 0 : 3)
          : ((r.team ?? 0) === (me.team ?? 0) ? 0 : 3), // my team lost 0:3
      }));
      Promise.allSettled([
        applyMatchResult(c.rMode, merged),
        recordResult(c.rMode, merged.map((m) => ({ id: m.id, key: m.key, score: m.score, team: m.team }))),
      ]).then(async ([res]) => {
        // Publish my abort result + damage/kill ledger so the players
        // who stay and finish still see my contribution and my loss.
        try {
          const f = await ensureFirebase();
          const stats = abortStats;
          const updates = {};
          const r = res?.value;
          if (r) updates[`lobbies/${c.code}/results/${r.key}`] =
            { name: r.name, before: r.before, after: r.after, delta: r.delta, team: me.team ?? null };
          if (stats) {
            updates[`lobbies/${c.code}/damageLog/${stats.myId}`] = stats.dmgBy ?? {};
            updates[`lobbies/${c.code}/killLog/${stats.myId}`] = stats.killsBy ?? {};
          }
          if (Object.keys(updates).length) await f.update(f.ref(f.db), updates);
        } catch (e) { /* best-effort */ }
      });
      toast("Abandoned a ranked match — counted as a loss.", 5000);
    }
  }

  stopGame(); // no-op if we weren't mid-match
  const dest = c?.ranked ? "screen-ranked" : "screen-online";
  if (!c) { showScreen(dest); return; }

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

async function addBot() {
  if (!current) return;
  const f = await ensureFirebase();
  const id = "bot-" + Math.random().toString(36).slice(2, 8);
  await f.set(f.ref(f.db, `lobbies/${current.code}/players/${id}`), {
    joinedAt: f.serverTimestamp(),
    bot: "easy",
    color: freeColor(tableColors(null)), // random paint nobody wears
  });
}

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
function renderLobbyCode(code, lobby) {
  const hidden = !!lobby?.hideCode;
  const el = document.getElementById("lobby-code");
  if (el) el.textContent = hidden ? "••••" : (code ?? "····");
  const btn = document.getElementById("lobby-hide");
  if (btn) {
    btn.textContent = hidden ? "SHOW" : "HIDE";
    // Host only — everyone else just sees the result.
    btn.hidden = !lobby || lobby.hostId !== myId();
  }
  const copy = document.getElementById("lobby-copy");
  if (copy) copy.hidden = hidden && lobby?.hostId !== myId();
}

/* ---------- custom-lobby match settings (host-controlled) ---------- */

const SIZE_KEYS = ["small", "medium", "large", "xl"];
const SIZE_LABEL = { small: "Small", medium: "Medium", large: "Large", xl: "Extra large" };

function defaultSettings() {
  const gear = {};
  for (const w of WEAPON_TYPES) gear[w] = true;
  const sizes = {};
  for (const k of SIZE_KEYS) sizes[k] = true;
  return { sizes, gear, gearMax: 24, zone: false, zoneSec: 30 };
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
  return { sizes, gear, gearMax: max, zone, zoneSec };
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
  // Ranked lobbies are fixed by the ladder — no knobs.
  panel.hidden = !isHost || !!lobby.ranked;
  if (panel.hidden) return;
  const s = readSettings(lobby);

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
    showScreen("screen-ranked");
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
      if (humans.length === 1 && humans[0][0] === me && !lobby.ranked) {
        // Casual: alone with bots → back to the lobby.
        returnToLobbySolo(entries);
      } else {
        // Ranked stays in-match even when the last opponent bails —
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
  showVersus(roster, me, lobby.rankedMode ?? "1v1",
    lobby.teams ?? null, current?.playersCache ?? [], !!lobby.ranked);
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
    }));

  if (!roster.some((p) => p.id === me && !p.bot)) {
    toast("The match started without you.");
    leaveLobby();
    return;
  }

  current.inGame = true;
  social.setStatus("round");

  const rMode = lobby.rankedMode ?? "1v1";
  // 2v2: the lobby carries teams { ukey: 0|1 } — remap to player ids.
  const teamsById = lobby.ranked && rMode === "2v2" && lobby.teams
    ? Object.fromEntries(entries
        .filter(([, p]) => p.ukey != null && lobby.teams[p.ukey] != null)
        .map(([id, p]) => [id, lobby.teams[p.ukey]]))
    : null;

  // 2v2 TEAM PAINT. The host (team leader) chooses the colour + pattern
  // for the whole team; the second seat wears it 20% darker. And if the
  // enemy team's paint would clash with ours, we recolour THEM on our
  // own screen (they do the same to us), so the two sides never look
  // alike. Everything below is client-relative, anchored on MY team.
  if (teamsById && lobby.teamLeaders) {
    const leaders = lobby.teamLeaders; // { 0: ukey, 1: ukey }
    // Map a team → its leader's lobby-entry.
    const leaderEntryFor = (team) =>
      entries.find(([, q]) => q.ukey === leaders[team]) ?? null;
    // Build the resolver input (one row per player), using each team's
    // LEADER paint (teammates inherit it).
    const paintEntries = entries.map(([id, p]) => {
      const team = teamsById[id] ?? 0;
      const lead = leaderEntryFor(team);
      const lp = lead ? lead[1] : p;
      const leaderPatColors = Array.isArray(lp.patColors) ? lp.patColors : [];
      const patId = lp.pattern && lp.pattern !== "solid" ? lp.pattern : null;
      return {
        id, team,
        leader: p.ukey != null && leaders[team] === p.ukey,
        baseHex: skinHex(lp.color ?? DEFAULT_SKIN),
        patId,
        patHexes: patId ? leaderPatColors.map((c) => skinHex(c)) : null,
      };
    });
    const myTeam = teamsById[me] ?? 0;
    const paint = resolveTeamPaint(paintEntries, myTeam);
    // Fold the result back into the roster: each member shows the
    // LEADER's colour + pattern IDs (finish + shape) with the resolved
    // HEXES (darkened / shifted) overlaid.
    for (const r of roster) {
      const team = teamsById[r.id];
      if (team == null) continue;
      const lead = leaderEntryFor(team);
      const lp = lead ? lead[1] : null;
      if (lp) {
        r.color = lp.color ?? r.color;              // finish
        r.pattern = lp.pattern ?? "solid";          // shape
        r.patColors = Array.isArray(lp.patColors) ? lp.patColors : [];
      }
      const paints = paint[r.id];
      if (paints) {
        r.colorHex = paints.baseHex;
        r.patHex = paints.patHexes ?? null;
      }
    }
  }

  const rankedInfo = lobby.ranked
    ? entries.slice(0, MAX_PLAYERS).map(([id, p]) => ({
        id,
        key: p.ukey ?? null,
        name: p.name ?? p.ukey ?? "Player",
        elo: (rMode === "1v1" ? p.e1 : p.e2) ?? 500,
        team: teamsById ? (teamsById[id] ?? 0) : null,
      }))
    : null;

  // Remember the ranked context so an abort (leaving mid-match) can
  // book the penalty. rankedSettled flips true the moment the result
  // is decided normally, so leaveLobby won't double-charge.
  if (current) {
    current.ranked = !!lobby.ranked;
    current.rMode = rMode;
    current.rankedInfo = rankedInfo;
    current.rankedSettled = false;
  }

  const setOpts = settingsToOpts(lobby);
  startOnlineGame({
    ranked: !!lobby.ranked,
    serverNow, // shared match clock (device clock + Firebase offset)
    // Custom lobbies honour the host's panel; ranked ignores it.
    sizePool: lobby.ranked ? null : setOpts.sizePool,
    gearPool: lobby.ranked ? null : setOpts.gearPool,
    gearMax: lobby.ranked ? null : setOpts.gearMax,
    zone: lobby.ranked ? undefined : setOpts.zone,
    zonePeriod: lobby.ranked ? undefined : setOpts.zonePeriod,
    teams: teamsById,
    winTarget: lobby.ranked ? 3 : null, // both ladders: first to 3
    casualPlayers: !lobby.ranked ? entries.slice(0, MAX_PLAYERS).map(([id, p]) => ({
      id, key: p.ukey ?? null,
    })) : null,
    onRankedEnd: (placements, myStats = null) => {
      // Everyone computes identically and writes only their OWN elo.
      if (!rankedInfo) return;
      if (current) current.rankedSettled = true; // decided — no abort charge
      const merged = placements.map((pl) => ({
        ...(rankedInfo.find((r) => r.id === pl.id) ?? { key: null, elo: 1000, team: null }),
        color: (roster.find((r) => r.id === pl.id) ?? {}).color ?? DEFAULT_SKIN,
        pattern: (roster.find((r) => r.id === pl.id) ?? {}).pattern ?? "solid",
        patColors: (roster.find((r) => r.id === pl.id) ?? {}).patColors ?? [],
        // Team-paint overrides, so a recoloured enemy team shows the
        // same colours on the results screen as it did in the match.
        colorHex: (roster.find((r) => r.id === pl.id) ?? {}).colorHex ?? null,
        patHex: (roster.find((r) => r.id === pl.id) ?? {}).patHex ?? null,
        score: pl.score,
      }));
      const savedCode = code;
      const myKey = social.getAccount()?.key ?? null;
      (async () => {
        const [myRes] = await Promise.allSettled([
          applyMatchResult(rMode, merged),
          recordResult(rMode, merged.map((m) => ({ id: m.id, key: m.key, score: m.score, team: m.team }))),
        ]);
        // Publish my Elo change + my damage/kill ledger so every
        // finisher's results screen can total the match up.
        try {
          const f = await ensureFirebase();
          const meRow = merged.find((m) => m.key === myKey);
          const updates = {};
          const r = myRes?.value;
          if (r && meRow) {
            updates[`lobbies/${savedCode}/results/${r.key}`] =
              { name: r.name, before: r.before, after: r.after, delta: r.delta, team: meRow.team ?? null };
          }
          if (myStats) {
            updates[`lobbies/${savedCode}/damageLog/${myStats.myId}`] = myStats.dmgBy ?? {};
            updates[`lobbies/${savedCode}/killLog/${myStats.myId}`] = myStats.killsBy ?? {};
          }
          if (Object.keys(updates).length) await f.update(f.ref(f.db), updates);
        } catch (e) { /* results are best-effort */ }
        showRankedResults(savedCode, rMode, merged, myKey,
          () => { leaveLobby(); showScreen("screen-ranked"); });
      })();
    },
    roundN: lobby.round.n,
    seed: lobby.round.seed,
    myId: me,
    // Couch co-op: the second local tank this client also drives (its
    // player id is me+"~g"), or null. Marks that tank local so Player
    // 2's input moves it and its position streams from here.
    localGuest: (lobby.players ?? {})[`${me}~g`] ? `${me}~g` : null,
    roster,
    sendPos: (id, pos) => write(`players/${id}/pos`, pos),
    sendShot: (id, key, shot) => {
      write(`players/${id}/shots/${key}`, shot);
      // Shots are transient — clean up after the bullet is long dead.
      setTimeout(() => {
        if (current && fb) {
          try {
            fb.remove(fb.ref(fb.db, `lobbies/${code}/players/${id}/shots/${key}`)).catch(() => {});
          } catch (e) { /* invalid key — nothing to clean */ }
        }
      }, SHOT_TTL);
    },
    // Shooter-authoritative hits: the SHOOTER decides a hit landed and
    // posts it to the VICTIM's inbox. The victim stays the authority on
    // its own health, so hp can't diverge — but what the shooter saw is
    // what actually counts, which is the fix for "I hit them and
    // nothing happened".
    sendHit: (victimId, key, hit) => {
      write(`players/${victimId}/hits/${key}`, hit);
      setTimeout(() => {
        if (current && fb) {
          try {
            fb.remove(fb.ref(fb.db, `lobbies/${code}/players/${victimId}/hits/${key}`)).catch(() => {});
          } catch (e) { /* invalid key — nothing to clean */ }
        }
      }, SHOT_TTL);
    },
    // The victim names its killer so the KILLER's client can score the
    // streak — damage resolves on the victim's machine, so this is the
    // only way they'd ever learn about their own multi-kill.
    sendDead: (id, byId) => {
      write(`players/${id}/dead`, true);
      if (byId) write(`players/${id}/deadBy`, byId);
    },
    sendGear: (key, gear) => write(`gear/${key}`, gear),
    sendGearRemove: (key) => write(`gear/${key}`, null),
    sendPickup: (gearKey, pid, type) => {
      if (!current || !fb) return;
      // One atomic update: the pickup vanishes and the gun appears.
      fb.update(current.lobbyRef, {
        [`gear/${gearKey}`]: null,
        [`players/${pid}/gun`]: type,
      }).catch(() => {});
    },
    sendGun: (id, type) => write(`players/${id}/gun`, type),
    sendNextRound: (n, seed) => {
      if (!current || !fb) return;
      const updates = { round: { n, seed }, gear: null };
      for (const pid of Object.keys(current.playersCache)) {
        updates[`players/${pid}/dead`] = null;
        updates[`players/${pid}/shots`] = null;
        updates[`players/${pid}/gun`] = null;
      }
      fb.update(current.lobbyRef, updates).catch(() => {});
    },
    onExit: () => {
      // Ranked: exiting is an ABORT — always leave (host included), so
      // the penalty path in leaveLobby runs. Casual: the host resets
      // the lobby for everyone; others just leave.
      if (!lobby.ranked && current?.isHost) endMatchForAll();
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
  // ranked lobbies are matchmade: no invites, no bots, auto-start.
  const socialBtn = document.getElementById("lobby-social");
  socialBtn.hidden = !(isHost && social.getAccount()) || !!lobby.ranked;
  renderSettings(lobby, isHost);
  if (lobby.ranked) {
    document.getElementById("lobby-addbot").hidden = true;
    document.getElementById("lobby-start").hidden = true;
    if (isHost && lobby.state === "waiting") {
      const count = Object.keys(lobby.players ?? {}).length;
      const age = Date.now() - (lobby.createdAt ?? Date.now());
      if (count >= (lobby.expect ?? 4)) {
        startMatch().catch(() => {}); // strict size — no short-handed starts
      } else if (age > 40000) {
        write("state", "cancelled"); // a no-show — everyone re-queues
      } else if (!current.rankedTimer) {
        current.rankedTimer = setTimeout(() => {
          current.rankedTimer = 0;
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

  renderLobbyCode(code, null); // real state paints on the first snapshot

  const resolved = resolveColors(entries);
  current.playersCache = entries;
  current.resolvedCache = resolved;

  // My color choice lost a conflict (or was never set)? Adopt the
  // resolved one so the database matches what everyone sees.
  // Spin up casual text chat once (not in ranked lobbies).
  if (!lobby.ranked && !current.chatOn) {
    current.chatOn = true;
    startChat(code, resolved[me]);
  }
  // Keep the chat panel visible only for casual lobbies.
  const chatWrap = document.getElementById("lobby-chat");
  if (chatWrap) chatWrap.hidden = !!lobby.ranked;

  // Feed every player's CURRENT color to the chat so old lines recolor
  // live when someone changes paint.
  if (!lobby.ranked) {
    const colorMap = {};
    for (const [id, p] of entries) colorMap[id] = resolved[id] ?? p.color ?? DEFAULT_SKIN;
    updateChatColors(colorMap);
  }

  const mine = entries.find(([id]) => id === me);
  // Keep the color our outgoing chat lines are stamped with in sync.
  if (!lobby.ranked) window.__myLobbyColor = resolved[me] ?? window.__myLobbyColor;
  if (mine && !mine[1].bot && mine[1].color !== resolved[me]) {
    if (mine[1].color) toast(`That paint was taken — you're ${COLOR_NAMES[resolved[me]]} now.`);
    write(`players/${me}/color`, resolved[me]);
  }

  document.getElementById("lobby-players").innerHTML = COLORS.map((slotColor, i) => {
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
        ${tankSVG(color)}
        <span class="lobby-name">${(() => {
          // 4-player ranked lobbies show the 4p rating; everywhere
          // else (casual + 1v1) shows the 1v1 rating.
          const e = lobby.ranked && lobby.rankedMode === "2v2" ? p.e2 : p.e1;
          return typeof e === "number" ? rankBadge(e, 16) : "";
        })()} ${p.name ?? COLOR_NAMES[color]}</span>
        <span class="row-end">${id === lobby.hostId ? '<span class="chip">HOST</span>' : ""}</span>
      </li>`;
  }).join("");

  document.getElementById("lobby-addbot").hidden = !(isHost && entries.length < MAX_PLAYERS);

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

export function initOnline() {
  const codeInput = document.getElementById("join-code");
  const createBtn = document.getElementById("btn-create");
  const joinBtn = document.getElementById("btn-join");
  const startBtn = document.getElementById("lobby-start");
  // The HOST's toggle hides the code for the WHOLE lobby: it's written
  // to the lobby node, so every client's snapshot hides it together.
  const hideBtn = document.getElementById("lobby-hide");
  hideBtn.addEventListener("click", () => {
    if (!current?.isHost) return; // guests don't get a say (button is hidden anyway)
    const next = !current?.lastLobby?.hideCode;
    localStorage.setItem("tank.hideCode.v1", next ? "1" : "0"); // remembered for my next lobby
    if (current.lastLobby) current.lastLobby.hideCode = next;   // instant local paint
    renderLobbyCode(current.code, current.lastLobby);
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
  const addBotBtn = document.getElementById("lobby-addbot");

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
  addBotBtn.addEventListener("click", guard(addBotBtn, addBot));

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
