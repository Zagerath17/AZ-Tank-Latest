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

import { onEnter, showScreen, toast, COLORS, COLOR_NAMES, tankSVG } from "./main.js";
import { firebaseConfig, isConfigured } from "./firebase-config.js";
import { startOnlineGame, onlineLobbyUpdate, stopGame } from "./game.js";
import { AI_LEVELS } from "./ai.js";

const FB_VERSION = "10.12.2";
const MAX_PLAYERS = 4;
const SHOT_TTL = 7000; // ms before a shot record is cleaned up

let fb = null;      // firebase handle bundle
let current = null; // { code, lobbyRef, playerRef, disc, unsub, inGame, playersCache }

/* ---------- firebase (lazy) ---------- */

async function ensureFirebase() {
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

// Join order decides color: earliest joinedAt is red, then green…
function sortPlayers(players) {
  return Object.entries(players ?? {}).sort(
    (a, b) => (a[1].joinedAt ?? 0) - (b[1].joinedAt ?? 0) || a[0].localeCompare(b[0]),
  );
}

// Fire-and-forget write helper used by the in-game streams.
function write(path, value) {
  if (!current || !fb) return;
  fb.set(fb.ref(fb.db, `lobbies/${current.code}/${path}`), value).catch(() => {});
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

async function addBot() {
  if (!current) return;
  const f = await ensureFirebase();
  const id = "bot-" + Math.random().toString(36).slice(2, 8);
  await f.set(f.ref(f.db, `lobbies/${current.code}/players/${id}`), {
    joinedAt: f.serverTimestamp(),
    bot: "easy",
  });
}

async function cycleBot(id, level) {
  if (!current) return;
  const f = await ensureFirebase();
  const next = AI_LEVELS[(AI_LEVELS.indexOf(level) + 1) % AI_LEVELS.length];
  await f.set(f.ref(f.db, `lobbies/${current.code}/players/${id}/bot`), next);
}

async function removeBot(id) {
  if (!current) return;
  const f = await ensureFirebase();
  await f.remove(f.ref(f.db, `lobbies/${current.code}/players/${id}`));
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

  if (lobby.state === "starting" && lobby.round?.seed != null) {
    if (!current.inGame) beginOnlineGame(code, lobby);
    else onlineLobbyUpdate(lobby);
    return;
  }

  renderLobby(code, lobby);
}

function beginOnlineGame(code, lobby) {
  const me = myId();
  const entries = sortPlayers(lobby.players);
  const roster = entries
    .slice(0, MAX_PLAYERS)
    .map(([id, p], i) => ({ id, color: COLORS[i], bot: p.bot ?? null }));

  if (!roster.some((p) => p.id === me && !p.bot)) {
    toast("The match started without you.");
    leaveLobby();
    return;
  }

  current.inGame = true;

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
          fb.remove(fb.ref(fb.db, `lobbies/${code}/players/${id}/shots/${key}`)).catch(() => {});
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

  document.getElementById("lobby-code").textContent = code;

  document.getElementById("lobby-players").innerHTML = COLORS.map((color, i) => {
    const entry = entries[i];
    if (!entry) {
      return `<li class="lobby-row empty">${tankSVG(color)}<span>Waiting for a tank…</span></li>`;
    }
    const [id, p] = entry;

    if (p.bot) {
      const controls = isHost
        ? `<button class="chip chip-btn" data-bot-cycle="${id}" data-level="${p.bot}">BOT · ${p.bot.toUpperCase()}</button>
           <button class="chip chip-btn" data-bot-remove="${id}" aria-label="Remove bot">✕</button>`
        : `<span class="chip">BOT · ${p.bot.toUpperCase()}</span>`;
      return `
        <li class="lobby-row p-${color}">
          ${tankSVG(color)}
          <span class="lobby-name">${COLOR_NAMES[color]} <em>· bot</em></span>
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
