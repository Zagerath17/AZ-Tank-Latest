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
//         pos:   { x, y, a },           // streamed during the match
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
// Colors come from join order. Max 4 players (bots count).
// ================================================================

import { onEnter, showScreen, toast, COLORS, COLOR_NAMES, PICKABLE, freeColor, tankSVG } from "./main.js";
import { firebaseConfig, isConfigured } from "./firebase-config.js";
import { startOnlineGame, onlineLobbyUpdate, stopGame } from "./game.js";
import * as social from "./social.js";
import { AI_LEVELS } from "./ai.js";

const FB_VERSION = "10.12.2";
const MAX_PLAYERS = 4;
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
    db: dbMod.getDatabase(app),
    ref: dbMod.ref,
    get: dbMod.get,
    set: dbMod.set,
    update: dbMod.update,
    remove: dbMod.remove,
    onValue: dbMod.onValue,
    onDisconnect: dbMod.onDisconnect,
    serverTimestamp: dbMod.serverTimestamp,
  };
  return fb;
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

// Colors are CHOSEN now, not assigned by seat — but conflicts are
// resolved deterministically in join order, so every client agrees:
// earliest joinedAt keeps their pick; later duplicates get bumped to
// the first free color. Impossible bots are always black.
function resolveColors(entries) {
  const used = new Set();
  const out = {};
  for (const [id, p] of entries) {
    let c = null;
    if (p.bot === "impossible") c = "black";
    else if (p.color && PICKABLE.includes(p.color) && !used.has(p.color)) c = p.color;
    if (!c) c = PICKABLE.find((k) => !used.has(k)) ?? "slate";
    used.add(c);
    out[id] = c;
  }
  return out;
}

// Join order for seats and conflict priority.
function sortPlayers(players) {
  return Object.entries(players ?? {}).sort(
    (a, b) => (a[1].joinedAt ?? 0) - (b[1].joinedAt ?? 0) || a[0].localeCompare(b[0]),
  );
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

// Fire-and-forget write helper used by the in-game streams.
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
      players: { [myId()]: { joinedAt: f.serverTimestamp() } },
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
    if (ids.length >= MAX_PLAYERS) throw new Error("Lobby is full — 4 tanks max.");
    await f.set(f.ref(f.db, `lobbies/${code}/players/${myId()}`), {
      joinedAt: f.serverTimestamp(),
    });
  }
  await enterLobby(code);
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
  const c = current;
  stopGame(); // no-op if we weren't mid-match
  if (!c) { showScreen("screen-online"); return; }

  current = null;
  try { c.unsub(); } catch { /* already gone */ }
  showScreen("screen-online");

  // Best-effort cleanup: remove me; if only bots (or nobody) remain,
  // remove the whole lobby — bots can't play by themselves.
  try {
    const f = await ensureFirebase();
    try { await c.disc.cancel(); } catch { /* fine */ }
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
    round: { n: 1, seed: Math.floor(Math.random() * 2147483647) },
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

async function paintBot(id) {
  if (!current) return;
  const f = await ensureFirebase();
  // Cycle the bot through the free colors, one tap at a time.
  const cur = current.resolvedCache?.[id];
  const taken = tableColors(id);
  const pool = PICKABLE.filter((c) => !taken.has(c));
  if (!pool.length) return;
  const next = pool[(pool.indexOf(cur) + 1) % pool.length];
  await f.set(f.ref(f.db, `lobbies/${current.code}/players/${id}/color`), next);
}

async function removeBot(id) {
  if (!current) return;
  const f = await ensureFirebase();
  await f.remove(f.ref(f.db, `lobbies/${current.code}/players/${id}`));
}

// The code display honors this device's hide toggle — keep the room
// number off-screen while streaming. Copy still copies the real code.
function renderLobbyCode(code) {
  const hidden = localStorage.getItem("tank.hideCode.v1") === "1";
  const el = document.getElementById("lobby-code");
  el.textContent = hidden ? "••••" : code;
  const btn = document.getElementById("lobby-hide");
  if (btn) btn.textContent = hidden ? "🙈" : "👁";
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

  if (lobby.state === "starting" && lobby.round?.seed != null) {
    if (!current.inGame) beginOnlineGame(code, lobby);
    else if (humans.length === 1 && humans[0][0] === me) {
      // Everyone else walked out mid-match. No point circling an
      // empty arena — take the survivor (now the host) back to the
      // lobby, bots and all, ready to restart.
      returnToLobbySolo(entries);
    } else {
      onlineLobbyUpdate(lobby);
    }
    return;
  }

  renderLobby(code, lobby);
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

function beginOnlineGame(code, lobby) {
  const me = myId();
  const entries = sortPlayers(lobby.players);
  const resolved = resolveColors(entries);
  const roster = entries
    .slice(0, MAX_PLAYERS)
    .map(([id, p]) => ({ id, color: resolved[id], bot: p.bot ?? null }));

  if (!roster.some((p) => p.id === me && !p.bot)) {
    toast("The match started without you.");
    leaveLobby();
    return;
  }

  current.inGame = true;
  social.setStatus("round");

  startOnlineGame({
    roundN: lobby.round.n,
    seed: lobby.round.seed,
    myId: me,
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
    sendDead: (id) => write(`players/${id}/dead`, true),
    sendGear: (key, gear) => write(`gear/${key}`, gear),
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
    onExit: () => leaveLobby(),
  });

  onlineLobbyUpdate(lobby); // apply the first snapshot's positions/flags
}

/* ---------- lobby screen render ---------- */

function renderLobby(code, lobby) {
  const me = myId();
  const entries = sortPlayers(lobby.players);
  const isHost = lobby.hostId === me;
  current.isHost = isHost;
  social.setStatus("lobby", code);

  // Host with room (and an account) can beckon friends in.
  const socialBtn = document.getElementById("lobby-social");
  socialBtn.hidden = !(isHost && social.getAccount() && Object.keys(lobby.players ?? {}).length < MAX_PLAYERS);

  const myIndex = entries.findIndex(([id]) => id === me);
  if (myIndex === -1) { toast("You were removed from the lobby."); exitToOnline(); return; }
  if (myIndex >= MAX_PLAYERS) { toast("Lobby is full — 4 tanks max."); leaveLobby(); return; }

  // Host migration: if the host vanished, the oldest HUMAN claims it.
  const hostP = lobby.players?.[lobby.hostId];
  const hostAlive = hostP && !hostP.bot;
  const firstHuman = entries.find(([, p]) => !p.bot);
  if (!hostAlive && firstHuman && firstHuman[0] === me) {
    ensureFirebase()
      .then((f) => f.update(current.lobbyRef, { hostId: me }))
      .catch(() => { /* retried on next snapshot */ });
  }

  renderLobbyCode(code);

  const resolved = resolveColors(entries);
  current.playersCache = entries;
  current.resolvedCache = resolved;

  // My color choice lost a conflict (or was never set)? Adopt the
  // resolved one so the database matches what everyone sees.
  const mine = entries.find(([id]) => id === me);
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
      const controls = isHost
        ? `${locked ? "" : `<button class="chip chip-btn" data-bot-paint="${id}" aria-label="Change bot color">🎨</button>`}
           <button class="chip chip-btn" data-bot-cycle="${id}" data-level="${p.bot}">BOT · ${p.bot.toUpperCase()}</button>
           <button class="chip chip-btn" data-bot-remove="${id}" aria-label="Remove bot">✕</button>`
        : `<span class="chip">BOT · ${p.bot.toUpperCase()}</span>`;
      return `
        <li class="lobby-row p-${color}">
          ${tankSVG(color)}
          <span class="lobby-name">${COLOR_NAMES[color]} <em>· bot${locked ? " · locked" : ""}</em></span>
          <span class="row-end">${controls}</span>
        </li>`;
    }

    return `
      <li class="lobby-row p-${color}">
        ${tankSVG(color)}
        <span class="lobby-name">${COLOR_NAMES[color]}${id === me ? " <em>(you)</em>" : ""}</span>
        <span class="row-end">${id === lobby.hostId ? '<span class="chip">HOST</span>' : ""}</span>
      </li>`;
  }).join("");

  // My paint strip: every color, minus what the table already wears.
  const paintEl = document.getElementById("lobby-paint");
  const hintEl = document.getElementById("lobby-paint-hint");
  if (mine && !mine[1].bot) {
    paintEl.hidden = false;
    hintEl.hidden = false;
    const others = new Set(entries.filter(([id]) => id !== me).map(([id]) => resolved[id]));
    paintEl.innerHTML = PICKABLE.map((c) => `
      <button class="swatch p-${c} ${resolved[me] === c ? "sel" : ""}"
              data-my-paint="${c}" ${others.has(c) ? "disabled" : ""}
              aria-label="${COLOR_NAMES[c]}"></button>`).join("");
  } else {
    paintEl.hidden = true;
    hintEl.hidden = true;
  }

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
  const hideBtn = document.getElementById("lobby-hide");
  hideBtn.addEventListener("click", () => {
    const k = "tank.hideCode.v1";
    localStorage.setItem(k, localStorage.getItem(k) === "1" ? "0" : "1");
    if (current) renderLobbyCode(current.code);
  });

  document.getElementById("lobby-social").addEventListener("click", () => {
    social.toggleInvitePanel();
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

  // Bot difficulty / removal chips (host only; delegated).
  document.getElementById("lobby-players").addEventListener("click", async (e) => {
    const cyc = e.target.closest("[data-bot-cycle]");
    const rem = e.target.closest("[data-bot-remove]");
    const pnt = e.target.closest("[data-bot-paint]");
    const my = e.target.closest("[data-my-paint]");
    if (!cyc && !rem && !pnt && !my) return;
    try {
      if (my) {
        write(`players/${myId()}/color`, my.dataset.myPaint);
        social.setLastColor(my.dataset.myPaint);
      }
      else if (pnt) await paintBot(pnt.dataset.botPaint);
      else if (cyc) await cycleBot(cyc.dataset.botCycle, cyc.dataset.level);
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
