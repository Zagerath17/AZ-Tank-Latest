// ================================================================
// online.js — lobby system on Firebase Realtime Database.
//
//   lobbies/{code}: {
//     createdAt: server timestamp,
//     hostId:    player id,
//     state:     "waiting" | "starting",
//     seed:      number (set by the host at start — everyone
//                builds the identical maze from it),
//     players:   { [playerId]: {
//       joinedAt: server timestamp,
//       pos: { x, y, a }   // streamed during the match
//     } }
//   }
//
// Colors are derived from join order (red, green, blue, yellow),
// so every client agrees without extra writes. Max 4 players.
// Firebase is loaded on demand so Local play works fully offline.
// ================================================================

import { onEnter, showScreen, toast, COLORS, COLOR_NAMES, tankSVG } from "./main.js";
import { firebaseConfig, isConfigured } from "./firebase-config.js";
import { startOnlineGame, onlinePlayersUpdate, stopGame } from "./game.js";

const FB_VERSION = "10.12.2";
const MAX_PLAYERS = 4;

let fb = null;      // { db, ref, get, set, update, remove, onValue, onDisconnect, serverTimestamp }
let current = null; // { code, lobbyRef, playerRef, disc, unsub, inGame }

/* ---------- firebase (lazy) ---------- */

async function ensureFirebase() {
  if (fb) return fb;
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

// Join order decides color: earliest joinedAt is red, then green…
function sortPlayers(players) {
  return Object.entries(players ?? {}).sort(
    (a, b) => (a[1].joinedAt ?? 0) - (b[1].joinedAt ?? 0) || a[0].localeCompare(b[0]),
  );
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

async function joinLobby(code) {
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
    () => { toast("Lost connection to the lobby."); stopGame(); exitToOnline(); },
  );

  current = { code, lobbyRef, playerRef, disc, unsub, inGame: false };
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
  const c = current;
  stopGame(); // no-op if we weren't mid-match
  if (!c) { showScreen("screen-online"); return; }

  current = null;
  try { c.unsub(); } catch { /* already gone */ }
  showScreen("screen-online");

  // Best-effort cleanup: remove me, and remove the lobby if it's now empty.
  try {
    const f = await ensureFirebase();
    try { await c.disc.cancel(); } catch { /* fine */ }
    await f.remove(c.playerRef);
    const rest = await f.get(f.ref(f.db, `lobbies/${c.code}/players`));
    if (!rest.exists()) await f.remove(c.lobbyRef);
  } catch { /* offline — onDisconnect already covered us */ }
}

// Host only: share a seed so every client builds the same maze.
async function startMatch() {
  if (!current) return;
  const f = await ensureFirebase();
  await f.update(current.lobbyRef, {
    state: "starting",
    seed: Math.floor(Math.random() * 2147483647),
  });
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

  // Match running (or starting right now)?
  if (lobby.state === "starting" && lobby.seed != null) {
    if (!current.inGame) beginOnlineGame(code, lobby);
    else onlinePlayersUpdate(lobby.players ?? {});
    return;
  }

  renderLobby(code, lobby);
}

function beginOnlineGame(code, lobby) {
  const me = myId();
  const entries = sortPlayers(lobby.players);
  const roster = entries
    .slice(0, MAX_PLAYERS)
    .map(([id], i) => ({ id, color: COLORS[i] }));

  if (!roster.some((p) => p.id === me)) {
    // Shouldn't happen (joins are blocked once started), but be safe.
    toast("The match started without you.");
    leaveLobby();
    return;
  }

  current.inGame = true;

  startOnlineGame({
    seed: lobby.seed,
    myId: me,
    roster,
    // Fire-and-forget position stream; throttled inside the game loop.
    sendPos: (pos) => {
      if (!current || !fb) return;
      fb.set(fb.ref(fb.db, `lobbies/${code}/players/${me}/pos`), pos).catch(() => {});
    },
    onExit: () => leaveLobby(),
  });
}

/* ---------- lobby screen render ---------- */

function renderLobby(code, lobby) {
  const me = myId();
  const entries = sortPlayers(lobby.players);

  const myIndex = entries.findIndex(([id]) => id === me);
  if (myIndex === -1) { toast("You were removed from the lobby."); exitToOnline(); return; }
  if (myIndex >= MAX_PLAYERS) { toast("Lobby is full — 4 tanks max."); leaveLobby(); return; }

  // Host migration: if the host vanished, the oldest player claims the seat.
  const hostAlive = entries.some(([id]) => id === lobby.hostId);
  if (!hostAlive && entries[0][0] === me) {
    ensureFirebase()
      .then((f) => f.update(current.lobbyRef, { hostId: me }))
      .catch(() => { /* retried on next snapshot */ });
  }

  document.getElementById("lobby-code").textContent = code;

  document.getElementById("lobby-players").innerHTML = COLORS.map((color, i) => {
    const entry = entries[i];
    if (!entry) {
      return `<li class="lobby-row empty">${tankSVG(color)}<span>Waiting for a tank…</span></li>`;
    }
    const [id] = entry;
    return `
      <li class="lobby-row p-${color}">
        ${tankSVG(color)}
        <span class="lobby-name">${COLOR_NAMES[color]}${id === me ? " <em>(you)</em>" : ""}</span>
        ${id === lobby.hostId ? '<span class="chip">HOST</span>' : ""}
      </li>`;
  }).join("");

  const isHost = lobby.hostId === me;
  const startBtn = document.getElementById("lobby-start");
  const status = document.getElementById("lobby-status");

  if (isHost) {
    startBtn.hidden = false;
    startBtn.disabled = entries.length < 2;
    status.textContent = entries.length < 2
      ? "Share the code — you need at least 2 tanks to start."
      : `${entries.length} tanks ready. You're the host.`;
  } else {
    startBtn.hidden = true;
    status.textContent = "Waiting for the host to start…";
  }
}

/* ---------- wiring ---------- */

// Wraps async actions: disables the button while pending, toasts errors.
function guard(btn, fn) {
  return async () => {
    if (btn.disabled) return;
    btn.disabled = true;
    try {
      await fn();
    } catch (err) {
      toast(err?.message ?? "Something went wrong.");
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
  const copyBtn = document.getElementById("lobby-copy");

  onEnter("screen-online", () => {
    document.getElementById("online-actions").hidden = !isConfigured;
    document.getElementById("online-warning").hidden = isConfigured;
  });

  onEnter("screen-join", () => { codeInput.value = ""; });

  // Digits only, max 4.
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
