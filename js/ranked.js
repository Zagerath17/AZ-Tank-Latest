// ================================================================
// ranked.js — Elo, ranks, matchmaking, and the leaderboard.
//
//   users/{key}/elo        — rating (default 1000)
//   queue/{key}            — { at, elo, name } while searching
//   queue/{key}/match      — lobby code, written by the matchmaker
//
// There is no server, so the OLDEST player in the queue acts as the
// matchmaker: it forms a 4-player match the moment four are waiting,
// or starts a smaller one (2–3) after ~25 s so low-population hours
// still get games. Ranked lobbies auto-start; first to 5 round wins
// takes the match, and every client then writes its OWN new Elo
// (computed identically from the shared final scores).
// ================================================================

import { toast, showScreen, onEnter, onLeave } from "./main.js";
import { ensureFirebase, createRankedLobby } from "./online.js";
import { getAccount } from "./social.js";

export const DEFAULT_ELO = 1000;

const TIERS = [
  { name: "Bronze", min: -Infinity, color: "#b0783f" },
  { name: "Silver", min: 1100, color: "#b9c2cf" },
  { name: "Gold", min: 1300, color: "#e8b93c" },
  { name: "Platinum", min: 1500, color: "#7fd6c2" },
  { name: "Diamond", min: 1700, color: "#7fb4f0" },
];

export function rankOf(elo = DEFAULT_ELO) {
  let t = TIERS[0];
  for (const tier of TIERS) if (elo >= tier.min) t = tier;
  return t;
}

// A small shield badge, colored by tier, with the tier's initial.
export function rankBadge(elo, size = 16) {
  const t = rankOf(elo);
  return `<svg class="rank-badge" width="${size}" height="${size}" viewBox="0 0 20 20"
       role="img" aria-label="${t.name}">
    <path d="M10 1 L18 4 V10 C18 15 14.5 18 10 19.5 C5.5 18 2 15 2 10 V4 Z"
          fill="${t.color}" stroke="rgba(0,0,0,.35)" stroke-width="1"/>
    <text x="10" y="14" text-anchor="middle" font-size="10" font-weight="800"
          fill="rgba(0,0,0,.55)" font-family="system-ui">${t.name[0]}</text>
  </svg>`;
}

/* ---------- my rating ---------- */

export async function fetchMyElo() {
  const acc = getAccount();
  if (!acc) return null;
  const f = await ensureFirebase();
  const s = await f.get(f.ref(f.db, `users/${acc.key}/elo`));
  return s.exists() ? s.val() : DEFAULT_ELO;
}

/* ---------- Elo math (pairwise, identical on every client) ---------- */

// placements: [{ key, elo, score }] for all participants (key may be
// null for guests — they don't rate). Returns my new elo or null.
export function computeMyNewElo(placements, myKey) {
  const me = placements.find((p) => p.key === myKey);
  if (!me) return null;
  const rated = placements.filter((p) => p.key && p.key !== myKey);
  if (!rated.length) return me.elo;
  const K = 40 / rated.length;
  let delta = 0;
  for (const o of rated) {
    const S = me.score > o.score ? 1 : me.score === o.score ? 0.5 : 0;
    const E = 1 / (1 + 10 ** (((o.elo ?? DEFAULT_ELO) - (me.elo ?? DEFAULT_ELO)) / 400));
    delta += K * (S - E);
  }
  return Math.max(0, Math.round((me.elo ?? DEFAULT_ELO) + delta));
}

export async function applyMatchResult(placements) {
  const acc = getAccount();
  if (!acc) return;
  const before = placements.find((p) => p.key === acc.key)?.elo ?? DEFAULT_ELO;
  const after = computeMyNewElo(placements, acc.key);
  if (after == null) return;
  try {
    const f = await ensureFirebase();
    await f.set(f.ref(f.db, `users/${acc.key}/elo`), after);
    const d = after - before;
    toast(`${d >= 0 ? "+" : ""}${d} Elo — ${rankOf(after).name} ${after}`, 5000);
  } catch (e) { /* rating survives to the next match */ }
}

/* ---------- matchmaking queue ---------- */

let queued = false;
let queueTimer = 0;
let matchUnsub = null;

function setQueueUI(state, extra = "") {
  const btn = document.getElementById("ranked-queue");
  const status = document.getElementById("ranked-status");
  if (!btn) return;
  if (state === "idle") {
    btn.textContent = "FIND MATCH";
    status.textContent = extra;
  } else {
    btn.textContent = "CANCEL";
    status.textContent = extra || "Searching…";
  }
}

export async function joinQueue() {
  const acc = getAccount();
  if (!acc) { toast("Log in to play ranked."); return; }
  if (queued) return leaveQueue();
  try {
    const f = await ensureFirebase();
    const elo = (await fetchMyElo()) ?? DEFAULT_ELO;
    await f.set(f.ref(f.db, `queue/${acc.key}`), {
      at: f.serverTimestamp(),
      elo,
      name: acc.name,
    });
    queued = true;
    setQueueUI("queued");

    // My ticket: the matchmaker writes the lobby code here.
    matchUnsub = f.onValue(f.ref(f.db, `queue/${acc.key}/match`), async (snap) => {
      const code = snap.val();
      if (!code) return;
      await stopQueueing(false);
      try {
        const { joinLobby } = await import("./online.js");
        await joinLobby(String(code));
        toast("Match found!");
      } catch (e) {
        toast(e?.message ?? "Match fell apart — try again.");
        setQueueUI("idle");
      }
    });

    // Matchmaker duty check (only the oldest queued player acts).
    queueTimer = setInterval(() => matchmakerTick(f, acc).catch(() => {}), 2500);
  } catch (e) {
    toast(e?.message ?? "Couldn't join the queue — check the queue rule (README).");
  }
}

async function stopQueueing(removeEntry = true) {
  clearInterval(queueTimer);
  if (matchUnsub) { try { matchUnsub(); } catch (e) {} matchUnsub = null; }
  queued = false;
  if (removeEntry) {
    try {
      const f = await ensureFirebase();
      const acc = getAccount();
      if (acc) await f.remove(f.ref(f.db, `queue/${acc.key}`));
    } catch (e) {}
  }
}

export async function leaveQueue() {
  await stopQueueing(true);
  setQueueUI("idle", "Search cancelled.");
}

async function matchmakerTick(f, acc) {
  if (!queued) return;
  const snap = await f.get(f.ref(f.db, "queue"));
  const q = Object.entries(snap.val() ?? {})
    .filter(([, v]) => v && v.at)
    .sort((a, b) => (a[1].at - b[1].at) || (a[0] < b[0] ? -1 : 1));

  const waiting = q.filter(([, v]) => !v.match);
  setQueueUI("queued", `Searching… ${waiting.length} in queue`);
  if (!waiting.length || waiting[0][0] !== acc.key) return; // not my job

  // Matchmaker housekeeping: drop tickets that went stale.
  const now = Date.now();
  for (const [k, v] of q) {
    if (now - v.at > 90000) f.remove(f.ref(f.db, `queue/${k}`)).catch(() => {});
  }

  const oldestWait = now - waiting[0][1].at;
  const enough = waiting.length >= 4 || (waiting.length >= 2 && oldestWait > 25000);
  if (!enough) return;

  const party = waiting.slice(0, 4);
  const code = await createRankedLobby(party.length);
  const updates = {};
  for (const [k] of party) {
    if (k !== acc.key) updates[`queue/${k}/match`] = code;
  }
  await f.update(f.ref(f.db), updates);
  await stopQueueing(true); // the matchmaker is already IN the lobby (host)
  const { joinLobby } = await import("./online.js"); // already entered via create
  void joinLobby; // (host entered during createRankedLobby)
}

/* ---------- leaderboard ---------- */

async function renderLeaderboard() {
  const host = document.getElementById("ranked-board");
  const meLine = document.getElementById("ranked-me");
  const acc = getAccount();
  try {
    const f = await ensureFirebase();
    // Top 50 by elo (needs ".indexOn": ["elo"] on users for speed).
    const qs = await f.get(f.query(f.ref(f.db, "users"), f.orderByChild("elo"), f.limitToLast(50)));
    const rows = [];
    qs.forEach((c) => {
      const v = c.val();
      if (typeof v?.elo === "number") rows.push({ key: c.key, name: v.name ?? c.key, elo: v.elo });
    });
    rows.sort((a, b) => b.elo - a.elo);

    // My elo + global position.
    let myElo = null;
    let myPos = null;
    if (acc) {
      myElo = (await fetchMyElo()) ?? null;
      if (myElo != null) {
        const inTop = rows.findIndex((r) => r.key === acc.key);
        if (inTop >= 0) myPos = inTop + 1;
        else {
          const above = await f.get(f.query(f.ref(f.db, "users"), f.orderByChild("elo"), f.startAt(myElo + 0.001)));
          let n = 0;
          above.forEach(() => { n += 1; });
          myPos = n + 1;
        }
      }
    }

    const badge = document.getElementById("ranked-mybadge");
    if (badge) {
      badge.innerHTML = acc
        ? myElo != null
          ? `${rankBadge(myElo, 34)} <b>${rankOf(myElo).name}</b> · ${myElo} Elo${myPos ? ` · #${myPos} worldwide` : ""}`
          : "Play a ranked match to get rated."
        : "Log in from the title screen to play ranked.";
    }

    host.innerHTML = rows.length
      ? rows.map((r, i) => `
        <li class="board-row ${acc && r.key === acc.key ? "board-me" : ""}">
          <span class="board-pos">#${i + 1}</span>
          ${rankBadge(r.elo, 18)}
          <span class="board-name">${r.name}</span>
          <span class="board-elo">${r.elo}</span>
        </li>`).join("")
      : `<li class="hint">Nobody's rated yet — be the first.</li>`;
    if (meLine) {
      meLine.hidden = !(acc && myElo != null && myPos && myPos > 50);
      if (!meLine.hidden) {
        meLine.innerHTML = `
          <span class="board-pos">#${myPos}</span>
          ${rankBadge(myElo, 18)}
          <span class="board-name">${acc.name}</span>
          <span class="board-elo">${myElo}</span>`;
      }
    }
  } catch (e) {
    host.innerHTML = `<li class="hint">Couldn't load the leaderboard — check your connection (and the users .indexOn rule).</li>`;
    const badge = document.getElementById("ranked-mybadge");
    if (badge) {
      badge.textContent = getAccount()
        ? "Rating unavailable — check your connection."
        : "Log in from the title screen to play ranked.";
    }
  }
}

/* ---------- init ---------- */

export function initRanked() {
  document.getElementById("ranked-queue").addEventListener("click", joinQueue);

  let boardTimer = 0;
  onEnter("screen-ranked", () => {
    renderLeaderboard();
    boardTimer = setInterval(renderLeaderboard, 10000); // live
  });
  onLeave("screen-ranked", () => {
    clearInterval(boardTimer);
    if (queued) leaveQueue(); // leaving the screen abandons the search
  });
}
