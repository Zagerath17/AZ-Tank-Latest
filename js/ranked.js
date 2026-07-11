// ================================================================
// ranked.js — two ladders (1v1 and 4-player), Elo, matchmaking.
//
//   users/{key}/elo1        — 1v1 rating   (default 500, Copper)
//   users/{key}/elo4        — 4-player rating (default 500)
//   queue/1v1/{key}         — { at, elo, name } while searching
//   queue/4p/{key}          —           »
//   queue/*/{key}/match     — lobby code, written by the matchmaker
//
// Matches are STRICT size (2 or 4) and only pair players within
// ±100 Elo. The oldest queued player acts as matchmaker: it scans
// the queue in join order for any anchor whose ±100 window holds a
// full match, then takes the earliest joiners from that window.
//
// 4-player scoring (percent of the |mean − mine| gap):
//   mean above me:  1st +20%   2nd +10%   3rd +5%    4th −15%
//   mean below me:  1st +10%   2nd +5%    3rd +1%    4th −20%
//   mean equal:     1st +10    2nd +5     3rd +2     4th −6   (flat)
//
// 1v1 (best-of — first to 3 round wins; percent of |gap|):
//   underdog:  3:0 +20%  3:1 +10%  3:2 +5%  | 2:3 −2%  1:3 −5%  0:3 −10%
//   favorite:  3:0 +10%  3:1 +5%   3:2 +1%  | 2:3 −3%  1:3 −10% 0:3 −20%
//   equal:     ±10 / ±5 / ±2 flat by margin (spec silent — symmetric)
// ================================================================

import { toast, showScreen, onEnter, onLeave } from "./main.js";
import { ensureFirebase, createRankedLobby } from "./online.js";
import { getAccount } from "./social.js";

export const DEFAULT_ELO = 500;

export const MODES = {
  "1v1": { label: "1v1", eloField: "elo1", queuePath: "queue/1v1", size: 2, winTarget: 3 },
  "4p": { label: "FFA", eloField: "elo4", queuePath: "queue/4p", size: 4, winTarget: 5 },
};

const TIERS = [
  { name: "Copper", min: -Infinity, color: "#c26e4a" },
  { name: "Silver", min: 750, color: "#b9c2cf" },
  { name: "Gold", min: 1000, color: "#e8b93c" },
  { name: "Platinum", min: 1250, color: "#7fd6c2" },
  { name: "Diamond", min: 1500, color: "#7fb4f0" },
];

export function rankOf(elo = DEFAULT_ELO) {
  let t = TIERS[0];
  for (const tier of TIERS) if (elo >= tier.min) t = tier;
  return t;
}

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

/* ---------- ratings ---------- */

export async function fetchMyElo(mode) {
  const acc = getAccount();
  if (!acc) return null;
  const f = await ensureFirebase();
  const s = await f.get(f.ref(f.db, `users/${acc.key}/${MODES[mode].eloField}`));
  return s.exists() ? s.val() : DEFAULT_ELO;
}

/* ---------- Elo math (deterministic on every client) ---------- */

// 4-player: placements = [{ key, elo, score }]. Ties share the better
// placement. Returns my new elo (or null if I'm not in it).
export function computeMyNewElo4(placements, myKey) {
  const sorted = [...placements].sort((a, b) => b.score - a.score);
  // placement index with ties sharing the best slot
  const placeOf = new Map();
  sorted.forEach((p, i) => {
    const tiedWith = sorted.findIndex((q) => q.score === p.score);
    placeOf.set(p.key, tiedWith);
  });
  const me = placements.find((p) => p.key === myKey);
  if (!me) return null;
  const myElo = me.elo ?? DEFAULT_ELO;
  const mean = placements.reduce((s, p) => s + (p.elo ?? DEFAULT_ELO), 0) / placements.length;
  const gap = Math.abs(mean - myElo);
  const place = placeOf.get(myKey); // 0..3

  let delta;
  if (mean > myElo) delta = [0.2, 0.1, 0.05, -0.15][place] * gap;
  else if (mean < myElo) delta = [0.1, 0.05, 0.01, -0.2][place] * gap;
  else delta = [10, 5, 2, -6][place];
  return Math.max(0, Math.round(myElo + delta));
}

// 1v1: myScore / oppScore are round wins (first to 3).
export function computeMyNewElo1v1(myElo, oppElo, myScore, oppScore) {
  const gap = Math.abs(oppElo - myElo);
  const won = myScore > oppScore;
  const margin = won ? oppScore : myScore; // 0, 1, or 2
  let pct;
  if (myElo < oppElo) {
    pct = won ? [0.2, 0.1, 0.05][margin] : [-0.1, -0.05, -0.02][margin];
  } else if (myElo > oppElo) {
    pct = won ? [0.1, 0.05, 0.01][margin] : [-0.2, -0.1, -0.03][margin];
  } else {
    const flat = won ? [10, 5, 2][margin] : [-10, -5, -2][margin];
    return Math.max(0, Math.round(myElo + flat));
  }
  return Math.max(0, Math.round(myElo + pct * gap));
}

export async function applyMatchResult(mode, placements) {
  const acc = getAccount();
  if (!acc) return;
  const me = placements.find((p) => p.key === acc.key);
  if (!me) return;
  const before = me.elo ?? DEFAULT_ELO;
  let after = null;
  if (mode === "1v1") {
    const opp = placements.find((p) => p.key !== acc.key);
    if (!opp) return;
    after = computeMyNewElo1v1(before, opp.elo ?? DEFAULT_ELO, me.score, opp.score);
  } else {
    after = computeMyNewElo4(placements, acc.key);
  }
  if (after == null) return;
  try {
    const f = await ensureFirebase();
    await f.set(f.ref(f.db, `users/${acc.key}/${MODES[mode].eloField}`), after);
    const d = after - before;
    toast(`${d >= 0 ? "+" : ""}${d} Elo — ${rankOf(after).name} ${after}`, 5000);
  } catch (e) { /* rating survives to the next match */ }
}

/* ---------- matchmaking queue ---------- */

let activeMode = "1v1";
let queued = false;
let queueTimer = 0;
let matchUnsub = null;

function setQueueUI(state, extra = "") {
  const btn = document.getElementById("ranked-queue");
  const status = document.getElementById("ranked-status");
  if (!btn) return;
  const M = MODES[activeMode];
  if (state === "idle") {
    btn.textContent = `FIND ${M.label.toUpperCase()} MATCH`;
    status.textContent = extra || `${M.size} players · first to ${M.winTarget} round wins · pairs within ±100 Elo.`;
  } else {
    btn.textContent = "CANCEL";
    status.textContent = extra || "Searching…";
  }
}

export async function joinQueue() {
  const acc = getAccount();
  if (!acc) { toast("Log in to play ranked."); return; }
  if (queued) return leaveQueue();
  const mode = activeMode;
  const M = MODES[mode];
  try {
    const f = await ensureFirebase();
    const elo = (await fetchMyElo(mode)) ?? DEFAULT_ELO;
    await f.set(f.ref(f.db, `${M.queuePath}/${acc.key}`), {
      at: f.serverTimestamp(),
      elo,
      name: acc.name,
    });
    queued = true;
    setQueueUI("queued");

    matchUnsub = f.onValue(f.ref(f.db, `${M.queuePath}/${acc.key}/match`), async (snap) => {
      const code = snap.val();
      if (!code) return;
      await stopQueueing(mode, false);
      try {
        const { joinLobby } = await import("./online.js");
        await joinLobby(String(code));
        toast("Match found!");
      } catch (e) {
        toast(e?.message ?? "Match fell apart — try again.");
        setQueueUI("idle");
      }
    });

    queueTimer = setInterval(() => matchmakerTick(f, acc, mode).catch(() => {}), 2500);
  } catch (e) {
    toast(e?.message ?? "Couldn't join the queue — check the queue rule (README).");
  }
}

async function stopQueueing(mode, removeEntry = true) {
  clearInterval(queueTimer);
  if (matchUnsub) { try { matchUnsub(); } catch (e) {} matchUnsub = null; }
  queued = false;
  if (removeEntry) {
    try {
      const f = await ensureFirebase();
      const acc = getAccount();
      if (acc) await f.remove(f.ref(f.db, `${MODES[mode].queuePath}/${acc.key}`));
    } catch (e) {}
  }
}

export async function leaveQueue() {
  await stopQueueing(activeMode, true);
  setQueueUI("idle", "Search cancelled.");
}

async function matchmakerTick(f, acc, mode) {
  if (!queued) return;
  const M = MODES[mode];
  const snap = await f.get(f.ref(f.db, M.queuePath));
  const q = Object.entries(snap.val() ?? {})
    .filter(([, v]) => v && v.at)
    .sort((a, b) => (a[1].at - b[1].at) || (a[0] < b[0] ? -1 : 1));

  const waiting = q.filter(([, v]) => !v.match);
  setQueueUI("queued", `Searching… ${waiting.length} in the ${M.label} queue`);
  if (!waiting.length || waiting[0][0] !== acc.key) return; // not my job

  const now = Date.now();
  for (const [k, v] of q) {
    if (now - v.at > 90000) f.remove(f.ref(f.db, `${M.queuePath}/${k}`)).catch(() => {});
  }

  // Strict size + ±100 Elo: scan anchors in join order; the first
  // whose window holds a full match wins; earliest joiners fill it.
  let party = null;
  for (const anchor of waiting) {
    const win = waiting.filter(([, v]) => Math.abs(v.elo - anchor[1].elo) <= 100);
    if (win.length >= M.size) { party = win.slice(0, M.size); break; }
  }
  if (!party || !party.some(([k]) => k === acc.key)) {
    // A match may form that excludes the matchmaker — allowed. But
    // the maker must be IN the lobby it creates (it becomes host),
    // so only form matches that include ourselves; a future maker
    // (once we're matched away) handles the rest.
    if (!party) return;
    // Party excludes me: promote its earliest member by writing a
    // hint is overkill — simplest correct behavior: skip; that
    // party's own oldest member becomes matchmaker within 2.5 s of
    // us leaving the front (or stays until sizes shift).
    return;
  }

  const code = await createRankedLobby(mode, M.size);
  const updates = {};
  for (const [k] of party) {
    if (k !== acc.key) updates[`${M.queuePath}/${k}/match`] = code;
  }
  await f.update(f.ref(f.db), updates);
  await stopQueueing(mode, true); // the matchmaker is already in (host)
}

/* ---------- leaderboards ---------- */

async function renderLeaderboard() {
  const host = document.getElementById("ranked-board");
  const meLine = document.getElementById("ranked-me");
  const acc = getAccount();
  const M = MODES[activeMode];
  try {
    const f = await ensureFirebase();
    // Index-free: pull every profile once and rank on the client. This
    // works whether or not the .indexOn rule is set, so the board can
    // never throw a false "connection" error over a missing index.
    const snap = await f.get(f.ref(f.db, "users"));
    const all = [];
    snap.forEach((c) => {
      const v = c.val();
      if (typeof v?.[M.eloField] === "number") {
        all.push({ key: c.key, name: v.name ?? c.key, elo: v[M.eloField] });
      }
    });
    all.sort((a, b) => b.elo - a.elo);
    const rows = all.slice(0, 50);

    let myElo = null;
    let myPos = null;
    if (acc) {
      myElo = (await fetchMyElo(activeMode)) ?? DEFAULT_ELO;
      const idx = all.findIndex((r) => r.key === acc.key);
      myPos = idx >= 0 ? idx + 1 : null;
    }

    const badge = document.getElementById("ranked-mybadge");
    if (badge) {
      badge.innerHTML = acc
        ? `${rankBadge(myElo, 34)} <b>${rankOf(myElo).name}</b> · ${myElo} Elo (${M.label})${myPos ? ` · #${myPos} worldwide` : " · unranked"}`
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
      : `<li class="hint">Nobody's rated in ${M.label} yet — be the first.</li>`;
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
    host.innerHTML = `<li class="hint">Couldn't reach the leaderboard right now. Pull to refresh in a moment.</li>`;
    const badge = document.getElementById("ranked-mybadge");
    if (badge && acc) {
      // We still know our own rating locally even if the board failed.
      const solo = (await fetchMyElo(activeMode).catch(() => DEFAULT_ELO)) ?? DEFAULT_ELO;
      badge.innerHTML = `${rankBadge(solo, 34)} <b>${rankOf(solo).name}</b> · ${solo} Elo (${M.label})`;
    } else if (badge) {
      badge.textContent = "Log in from the title screen to play ranked.";
    }
  }
}

/* ---------- init ---------- */

export function initRanked() {
  document.getElementById("ranked-queue").addEventListener("click", joinQueue);

  const tab1 = document.getElementById("ranked-tab-1v1");
  const tab4 = document.getElementById("ranked-tab-4p");
  const pick = async (mode) => {
    if (queued) await leaveQueue(); // switching ladders abandons the search
    activeMode = mode;
    tab1.classList.toggle("is-on", mode === "1v1");
    tab4.classList.toggle("is-on", mode === "4p");
    setQueueUI("idle");
    renderLeaderboard();
  };
  tab1.addEventListener("click", () => pick("1v1"));
  tab4.addEventListener("click", () => pick("4p"));

  let boardTimer = 0;
  onEnter("screen-ranked", () => {
    setQueueUI("idle");
    renderLeaderboard();
    boardTimer = setInterval(renderLeaderboard, 10000);
  });
  onLeave("screen-ranked", () => {
    clearInterval(boardTimer);
    if (queued) leaveQueue();
  });
}
