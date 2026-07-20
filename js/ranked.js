// ================================================================
// ranked.js — two ladders (1v1 and 2v2 teams), Elo, matchmaking.
//
//   users/{key}/elo1        — 1v1 rating   (default 500, Copper)
//   users/{key}/elo2v2      — 2v2 rating   (default 500)
//   queue/1v1/{key}         — { at, elo, name } while searching
//   queue/2v2/{leaderKey}   — { at, elo (TEAM MEAN), name, duo,
//                               members: [{key,name,elo}×2] }
//   queue/*/{key}/match     — lobby code, written by the matchmaker
//   duos/{code}             — the 2-player team party:
//                             { createdAt, leader, members{key:{name,elo,at}},
//                               match: lobbyCode|null }
//
// 1v1 queues are individuals. 2v2 queues are TEAMS: you party up in a
// duo (max 2), the leader queues the team, and the matchmaker pairs
// two duos whose MEAN Elo is within ±100. All four then join the same
// lobby; the lobby carries teams{ukey:0|1}.
//
// 1v1 (best-of — first to 3 round wins; percent of |gap|):
//   underdog:  3:0 +20%  3:1 +10%  3:2 +5%  | 2:3 −2%  1:3 −5%  0:3 −10%
//   favorite:  3:0 +10%  3:1 +5%   3:2 +1%  | 2:3 −3%  1:3 −10% 0:3 −20%
//   equal:     ±10 / ±5 / ±2 flat by margin (spec silent — symmetric)
//
// 2v2 uses the SAME tables, computed on the TEAM MEANS (my team's mean
// vs the enemy team's mean decides underdog/favorite and the gap); the
// resulting delta is applied to each member's own rating. Winning is
// team-wide: if your teammate is the last one standing, you both won.
// ================================================================

import { toast, onEnter, onLeave, tankSVG, paintVar } from "./main.js";
import { ensureFirebase, createRankedLobby } from "./online.js";
import { getAccount, getInvitableFriends, sendInvite } from "./social.js";
import { isConfigured } from "./firebase-config.js";
import { TOP50_CUTOFF } from "./skins.js";

export const DEFAULT_ELO = 500;

// Global multiplier on every rating change — the ladder moves fast.
export const ELO_SCALE = 3;

export const MODES = {
  "1v1": { label: "1v1", eloField: "elo1", queuePath: "queue/1v1", size: 2, winTarget: 3 },
  // 2v2: a queue ENTRY is a whole team (duo); two entries make a match.
  "2v2": { label: "2v2", eloField: "elo2v2", queuePath: "queue/2v2", size: 2, team: true, winTarget: 3 },
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

// 2v2: the 1v1 tables computed on TEAM MEANS. myMean vs oppMean picks
// underdog/favorite and sets the gap; the delta lands on each member's
// OWN rating. Scores are the round wins of each TEAM (both teammates
// carry the same score).
export function computeMyNewElo2v2(myElo, myMean, oppMean, myScore, oppScore) {
  const gap = Math.abs(oppMean - myMean);
  const won = myScore > oppScore;
  const margin = Math.min(2, won ? oppScore : myScore); // 0, 1, or 2
  let pct;
  if (myMean < oppMean) {
    pct = won ? [0.2, 0.1, 0.05][margin] : [-0.1, -0.05, -0.02][margin];
  } else if (myMean > oppMean) {
    pct = won ? [0.1, 0.05, 0.01][margin] : [-0.2, -0.1, -0.03][margin];
  } else {
    const flat = won ? [10, 5, 2][margin] : [-10, -5, -2][margin];
    return Math.max(0, Math.round(myElo + flat * ELO_SCALE));
  }
  return Math.max(0, Math.round(myElo + pct * gap * ELO_SCALE));
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
    return Math.max(0, Math.round(myElo + flat * ELO_SCALE));
  }
  return Math.max(0, Math.round(myElo + pct * gap * ELO_SCALE));
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
    // 2v2: placements carry team (0|1). Compute both team means; my
    // delta comes from the 1v1 tables on those means, applied to my
    // own rating. My team's score is any teammate's score (lockstep).
    const mine = placements.filter((p) => (p.team ?? 0) === (me.team ?? 0));
    const theirs = placements.filter((p) => (p.team ?? 0) !== (me.team ?? 0));
    if (!theirs.length) return;
    const mean = (arr) => arr.reduce((s, p) => s + (p.elo ?? DEFAULT_ELO), 0) / arr.length;
    const myScore = Math.max(...mine.map((p) => p.score ?? 0));
    const oppScore = Math.max(...theirs.map((p) => p.score ?? 0));
    after = computeMyNewElo2v2(before, mean(mine), mean(theirs), myScore, oppScore);
  }
  if (after == null) return null;
  try {
    const f = await ensureFirebase();
    // Atomically bump the private rating AND the public leaderboard
    // mirror (world-readable), so the Top-50 works without granting
    // read access to every user's full profile.
    await f.update(f.ref(f.db), {
      [`users/${acc.key}/${MODES[mode].eloField}`]: after,
      [`leaderboard/${MODES[mode].eloField}/${acc.key}`]: {
        name: acc.name ?? acc.key, elo: after,
      },
    });
  } catch (e) { /* rating survives to the next match */ }
  return { key: acc.key, name: acc.name ?? acc.key, before, after, delta: after - before };
}

/* ---------- matchmaking queue ---------- */

let activeMode = "1v1";
let queued = false;
let queueTimer = 0;
let matchUnsub = null;

/* ---------- the 2v2 duo (team party) ---------- */
// duos/{code}: { createdAt, leader, members{key:{name,elo,at}}, match }
let duo = null;        // { code, leader, members: [{key,name,elo}] }
let duoUnsub = null;
let duoJoining = false;

function isDuoLeader() {
  const acc = getAccount();
  return !!(duo && acc && duo.leader === acc.key);
}

async function createDuo() {
  const acc = getAccount();
  if (!acc) { toast("Log in to make a team."); return; }
  if (duo) return;
  const f = await ensureFirebase();
  const elo = (await fetchMyElo("2v2")) ?? DEFAULT_ELO;
  for (let attempt = 0; attempt < 25; attempt++) {
    const code = String(Math.floor(1000 + Math.random() * 9000));
    const ref = f.ref(f.db, `duos/${code}`);
    const existing = await f.get(ref);
    if (existing.exists()) continue;
    await f.set(ref, {
      createdAt: f.serverTimestamp(),
      leader: acc.key,
      members: { [acc.key]: { name: acc.name, elo, at: f.serverTimestamp() } },
      match: null,
    });
    watchDuo(code);
    return;
  }
  toast("Couldn't find a free team code.");
}

// The synthetic account key for a couch Player 2. It never owns a real
// account (so it never gains/loses Elo), and it rides along on Player
// 1's client as a second local tank.
export function guestKeyFor(accKey) {
  return `${accKey}~g`;
}

// COUCH CO-OP: seat a second player from THIS machine. Instead of
// inviting a friend, Player 1 fills the empty duo seat with a local
// guest. One client, two tanks — the lobby will carry two player
// entries and both positions stream from here (see online.js).
async function addLocalPlayer2() {
  const acc = getAccount();
  if (!acc) { toast("Log in to play ranked."); return; }
  const f = await ensureFirebase();
  if (!duo) {
    await createDuo();
    for (let i = 0; i < 20 && !duo; i++) await new Promise((r) => setTimeout(r, 100));
    if (!duo) { toast("Couldn't set the team up."); return; }
  }
  if (!isDuoLeader()) { toast("Only the team leader can add a couch player."); return; }
  if (duo.members.length >= 2) { toast("The team is already full."); return; }
  const gkey = guestKeyFor(acc.key);
  const elo = duo.members[0]?.elo ?? DEFAULT_ELO;
  await f.update(f.ref(f.db, `duos/${duo.code}`), {
    local: true, // one client hosts both seats
    [`members/${gkey}`]: { name: "Player 2", elo, at: f.serverTimestamp(), guest: true },
  });
  toast("Player 2 seated — you'll both drop in together.");
}

export async function joinDuo(code) {
  const acc = getAccount();
  if (!acc) { toast("Log in to join a team."); throw new Error("Not logged in."); }
  code = String(code || "").trim();
  if (duo?.code === code) return; // already seated in this team
  // Accepting an invite while holding a (solo) team of your own:
  // leave it first — the silent early-return here was why accepted
  // invites sometimes did nothing.
  if (duo) await leaveDuo();
  if (!/^\d{4}$/.test(code)) throw new Error("That team code looks wrong.");
  const f = await ensureFirebase();
  const ref = f.ref(f.db, `duos/${code}`);
  const snap = await f.get(ref);
  const v = snap.val();
  if (!v) throw new Error("That team no longer exists.");
  if (Object.keys(v.members ?? {}).length >= 2 && !v.members?.[acc.key]) {
    throw new Error("That team is already full (2 max).");
  }
  const elo = (await fetchMyElo("2v2")) ?? DEFAULT_ELO;
  await f.set(f.ref(f.db, `duos/${code}/members/${acc.key}`), {
    name: acc.name, elo, at: f.serverTimestamp(),
  });
  watchDuo(code);
}

function watchDuo(code) {
  ensureFirebase().then((f) => {
    if (duoUnsub) { try { duoUnsub(); } catch (e) {} }
    duoUnsub = f.onValue(f.ref(f.db, `duos/${code}`), async (snap) => {
      const v = snap.val();
      const acc = getAccount();
      if (!v || !acc || !v.members?.[acc.key]) {
        // Team dissolved (or we were removed).
        duo = null;
        if (duoUnsub) { try { duoUnsub(); } catch (e) {} duoUnsub = null; }
        if (queued) leaveQueue();
        renderDuoPanel();
        return;
      }
      duo = {
        code,
        leader: v.leader,
        local: !!v.local,
        members: Object.entries(v.members).map(([key, m]) => ({
          key, name: m.name ?? key, elo: m.elo ?? DEFAULT_ELO, guest: !!m.guest,
        })),
      };
      renderDuoPanel();
      // Matchmade! Everyone in the duo joins the same lobby.
      // Flag it first so navigating into the match doesn't dissolve the
      // team on the way out (onLeave only tears down an IDLE team).
      if (v.match) duo.matched = true;
      if (v.match && !duoJoining) {
        duoJoining = true;
        if (queued) await stopQueueing("2v2", isDuoLeader());
        try {
          const online = await import("./online.js");
          if (v.local && isDuoLeader()) {
            // Couch co-op: ONE client seats both players. Join, then
            // register the guest's own player entry so the lobby holds
            // two tanks from this machine.
            await online.joinLobbyAsLocalDuo(String(v.match), guestKeyFor(acc.key), acc);
          } else {
            await online.joinLobby(String(v.match));
          }
          toast("Match found!");
        } catch (e) {
          toast(e?.message ?? "Match fell apart — try again.");
          setQueueUI("idle");
        } finally {
          duoJoining = false;
          // Clear the flag so the duo can queue again later.
          if (isDuoLeader()) {
            try { f.set(f.ref(f.db, `duos/${code}/match`), null); } catch (e) {}
          }
        }
      }
    });
  }).catch(() => {});
}

async function leaveDuo() {
  const acc = getAccount();
  if (!duo || !acc) return;
  if (queued) await leaveQueue();
  try {
    const f = await ensureFirebase();
    if (isDuoLeader()) {
      await f.remove(f.ref(f.db, `duos/${duo.code}`)); // leader leaving dissolves it
    } else {
      await f.remove(f.ref(f.db, `duos/${duo.code}/members/${acc.key}`));
    }
  } catch (e) {}
  if (duoUnsub) { try { duoUnsub(); } catch (e) {} duoUnsub = null; }
  duo = null;
  renderDuoPanel();
}

function renderDuoPanel() {
  const panel = document.getElementById("duo-panel");
  if (!panel) return;
  panel.hidden = activeMode !== "2v2";
  if (panel.hidden) return;
  const members = document.getElementById("duo-members");
  const leaveBtn = document.getElementById("duo-leave");
  const list = document.getElementById("duo-invite-list");
  const acc = getAccount();

  if (!acc) {
    members.innerHTML = `<span class="hint">Log in from the title screen to build a team.</span>`;
    leaveBtn.hidden = true;
    if (list) list.hidden = true;
    setQueueUI(queued ? "queued" : "idle");
    return;
  }

  // Two seats: you, and your teammate — or an INVITE button in the
  // empty seat (no codes; invites go straight to a friend's screen).
  const meElo = duo?.members.find((m) => m.key === acc.key)?.elo;
  const mate = duo?.members.find((m) => m.key !== acc.key) ?? null;
  const seat = (inner, extra = "") => `<span class="duo-member ${extra}">${inner}</span>`;
  members.innerHTML =
    seat(`${rankBadge(meElo ?? DEFAULT_ELO, 16)} ${acc.name}${duo && duo.leader === acc.key ? " ★" : ""}`) +
    (mate
      ? seat(`${rankBadge(mate.elo, 16)} ${mate.name}${mate.guest ? "" : (duo && duo.leader === mate.key ? " ★" : "")}`)
      : `<span class="duo-empty-seat">
           <button class="btn duo-invite-btn" id="duo-invite" type="button">+ INVITE FRIEND</button>
           <button class="btn duo-couch-btn" id="duo-couch" type="button">+ PLAYER 2 (COUCH)</button>
         </span>`);

  document.getElementById("duo-invite")?.addEventListener("click", toggleDuoInvites);
  document.getElementById("duo-couch")?.addEventListener("click", () => {
    addLocalPlayer2().catch((e) => toast(e?.message ?? "Couldn't add Player 2."));
  });
  leaveBtn.hidden = !duo;
  setQueueUI(queued ? "queued" : "idle");
}

// The friend picker under the empty seat. Creates the duo on demand
// (the code lives on quietly — players never see or type it).
async function toggleDuoInvites() {
  const list = document.getElementById("duo-invite-list");
  if (!list) return;
  if (!list.hidden) { list.hidden = true; return; }
  list.hidden = false;
  list.innerHTML = `<li class="hint">Loading friends…</li>`;
  try {
    if (!duo) {
      await createDuo();
      // createDuo's watch fires async; wait for the local mirror.
      for (let i = 0; i < 20 && !duo; i++) await new Promise((r) => setTimeout(r, 100));
      if (!duo) throw new Error("Couldn't set the team up.");
    }
    const friends = await getInvitableFriends();
    if (!friends.length) {
      list.innerHTML = `<li class="hint">No friends online right now — add some from the title screen.</li>`;
      return;
    }
    list.innerHTML = friends.map((p) => `
      <li class="friend-row" style="${paintVar(p.color)}">
        ${tankSVG(p.color)}
        <span class="friend-name">${p.name}</span>
        <button class="btn btn-small" data-duo-invite="${p.key}" ${p.dnd ? "disabled" : ""}>
          ${p.dnd ? "DND" : "INVITE"}
        </button>
      </li>`).join("");
    list.querySelectorAll("[data-duo-invite]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        try {
          await sendInvite(btn.dataset.duoInvite, duo.code, "duo");
          toast("Team invite sent.");
          btn.disabled = true;
          btn.textContent = "SENT";
        } catch (e) { toast("Couldn't send the invite."); }
      });
    });
  } catch (e) {
    list.innerHTML = `<li class="hint">${e?.message ?? "Couldn't load friends."}</li>`;
  }
}

// Deep-link helper: after accepting a duo invite, land on the 2v2 tab.
export function showRanked2v2() {
  document.getElementById("ranked-tab-2v2")?.click();
}

function setQueueUI(state, extra = "") {
  const btn = document.getElementById("ranked-queue");
  const status = document.getElementById("ranked-status");
  if (!btn) return;
  const M = MODES[activeMode];
  if (M.team) {
    // 2v2: only a full duo can search, and only its leader drives it.
    const full = duo && duo.members.length === 2;
    if (state === "idle") {
      btn.textContent = "FIND 2v2 MATCH";
      btn.disabled = !full || !isDuoLeader();
      status.textContent = extra || (!duo
        ? "Invite a friend to your empty seat to queue. Teams pair by MEAN Elo, within ±100."
        : !full
          ? "Waiting for your teammate to accept the invite…"
          : isDuoLeader()
            ? "Team ready. Find a match!"
            : "Team ready — your leader (★) starts the search.");
    } else {
      btn.textContent = "CANCEL";
      btn.disabled = !isDuoLeader();
      status.textContent = extra || "Searching for an enemy duo…";
    }
    return;
  }
  btn.disabled = false;
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

  // 2v2: the LEADER queues the whole team, under their own key.
  if (M.team) {
    if (!duo || duo.members.length !== 2) { toast("You need a teammate first."); return; }
    if (!isDuoLeader()) { toast("Only the team leader (★) can queue."); return; }
  }

  try {
    const f = await ensureFirebase();
    let entry;
    if (M.team) {
      const mean = duo.members.reduce((s, m) => s + m.elo, 0) / duo.members.length;
      entry = {
        at: f.serverTimestamp(),
        elo: Math.round(mean),          // matched on the TEAM MEAN
        name: acc.name,
        duo: duo.code,
        members: duo.members.map((m) => ({ key: m.key, name: m.name, elo: m.elo })),
      };
    } else {
      const elo = (await fetchMyElo(mode)) ?? DEFAULT_ELO;
      entry = { at: f.serverTimestamp(), elo, name: acc.name };
    }
    await f.set(f.ref(f.db, `${M.queuePath}/${acc.key}`), entry);
    queued = true;
    setQueueUI("queued");

    // 1v1 learns its match code via the queue entry. 2v2 members all
    // learn it via the duo node instead (the matchmaker writes both).
    if (!M.team) {
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
    }

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
  setQueueUI("queued", M.team
    ? `Searching… ${waiting.length} team${waiting.length === 1 ? "" : "s"} in the ${M.label} queue`
    : `Searching… ${waiting.length} in the ${M.label} queue`);
  if (!waiting.length || waiting[0][0] !== acc.key) return; // not my job

  const now = Date.now();
  for (const [k, v] of q) {
    if (now - v.at > 90000) f.remove(f.ref(f.db, `${M.queuePath}/${k}`)).catch(() => {});
  }

  // Strict size + ±100 Elo (team mean for 2v2): scan anchors in join
  // order; the first whose window holds a full match wins; earliest
  // joiners fill it.
  let party = null;
  for (const anchor of waiting) {
    const win = waiting.filter(([, v]) => Math.abs(v.elo - anchor[1].elo) <= 100);
    if (win.length >= M.size) { party = win.slice(0, M.size); break; }
  }
  if (!party || !party.some(([k]) => k === acc.key)) return; // see 1v1 note

  if (M.team) {
    // Two duos found. Build the team map (ukey → 0|1) and the leader of
    // each team (its duo's first member), create the 4-player lobby with
    // both, then flag BOTH duo nodes so all members join.
    const teams = {};
    const teamLeaders = {};
    party.forEach(([, v], ti) => {
      for (const m of v.members ?? []) teams[m.key] = ti;
      // members[0] is the account that queued the duo = its leader.
      if (v.members && v.members[0]) teamLeaders[ti] = v.members[0].key;
    });
    const code = await createRankedLobby(mode, 4, teams, teamLeaders);
    const updates = {};
    for (const [, v] of party) {
      if (v.duo) updates[`duos/${v.duo}/match`] = code;
    }
    for (const [k] of party) {
      updates[`${M.queuePath}/${k}`] = null; // clear both queue entries
    }
    await f.update(f.ref(f.db), updates);
    await stopQueueing(mode, false); // entry already cleared above
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

// ---- elite (top-50) standing --------------------------------------
// Ruby paint is sold only to players currently inside the world top 50.
// We cache the last known position so the shop can render instantly,
// and refresh it from the public mirror whenever the shop opens.
// Cached (not authoritative): the real gate is re-checked at purchase.
const LS_BOARD_POS = "tank.boardPos.v1";
let boardPos = (() => {
  try { return JSON.parse(localStorage.getItem(LS_BOARD_POS) || "null"); }
  catch { return null; }
})();

// Best (lowest) position this account holds across BOTH ladders, or
// null if unranked/unknown. Being top 50 in either mode qualifies.
export function myBoardPosition() {
  return boardPos && typeof boardPos.pos === "number" ? boardPos.pos : null;
}

export function isTop50() {
  const p = myBoardPosition();
  return p != null && p <= TOP50_CUTOFF;
}

// Recompute standing from the public leaderboard mirrors. Best effort:
// on any failure we leave the cached value alone rather than wrongly
// revoking someone's access mid-session.
export async function refreshBoardPosition() {
  const acc = getAccount();
  if (!acc || !isConfigured) return myBoardPosition();
  try {
    const f = await ensureFirebase();
    let best = null;
    for (const key of Object.keys(MODES)) {
      const M = MODES[key];
      // Each ladder is read in ISOLATION. One unreadable mirror used to
      // throw out of the whole loop and leave the standing unknown,
      // which is what kept Ruby locked for players who were obviously
      // inside the top 50.
      let rows = [];
      try { rows = await loadBoardRows(f, M); } catch { continue; }
      if (!rows.length) continue;
      rows.sort((a, b) => b.elo - a.elo);
      const idx = rows.findIndex((r) => r.key === acc.key);
      if (idx >= 0) {
        if (best == null || idx + 1 < best) best = idx + 1;
      } else if (typeof acc[M.eloField] === "number" && rows.length < TOP50_CUTOFF) {
        // We have a rating for this ladder but the public mirror hasn't
        // caught up. The whole ranked population is smaller than the
        // cutoff, so we'd land inside it no matter where we slot in —
        // count us at the end rather than reporting "unranked".
        const wouldBe = rows.length + 1;
        if (best == null || wouldBe < best) best = wouldBe;
      }
    }
    boardPos = { pos: best, at: Date.now() };
    try { localStorage.setItem(LS_BOARD_POS, JSON.stringify(boardPos)); } catch { /* ignore */ }
  } catch { /* keep the cached standing */ }
  return myBoardPosition();
}

// Collect {key,name,elo} rows for the active mode. Preferred source is
// the public `/leaderboard/{mode}` mirror (world-readable, so it works
// under normal "own-data-only" rules). If that's empty or unreadable we
// fall back to enumerating `/users` (for setups that allow it).
async function loadBoardRows(f, M) {
  const rows = [];
  try {
    const snap = await f.get(f.ref(f.db, `leaderboard/${M.eloField}`));
    snap.forEach((c) => {
      const v = c.val();
      if (typeof v?.elo === "number") rows.push({ key: c.key, name: v.name ?? c.key, elo: v.elo });
    });
  } catch (e) { /* mirror unreadable — try /users below */ }

  if (rows.length === 0) {
    const snap = await f.get(f.ref(f.db, "users")); // may throw → surfaced by caller
    snap.forEach((c) => {
      const v = c.val();
      if (typeof v?.[M.eloField] === "number") {
        rows.push({ key: c.key, name: v.name ?? c.key, elo: v[M.eloField] });
      }
    });
  }
  return rows;
}

async function renderLeaderboard() {
  const host = document.getElementById("ranked-board");
  const meLine = document.getElementById("ranked-me");
  const acc = getAccount();
  const M = MODES[activeMode];

  if (!isConfigured) {
    host.innerHTML = `<li class="hint">Leaderboards need a Firebase project — see the README ("Firebase setup").</li>`;
    return;
  }

  try {
    const f = await ensureFirebase();
    const all = await loadBoardRows(f, M);

    let myElo = null;
    let myPos = null;
    if (acc) {
      myElo = (await fetchMyElo(activeMode)) ?? DEFAULT_ELO;
      // Seed/refresh our own public mirror entry so a logged-in player
      // always appears on the board (self-write only). Best effort.
      f.set(f.ref(f.db, `leaderboard/${M.eloField}/${acc.key}`), {
        name: acc.name ?? acc.key, elo: myElo,
      }).catch(() => {});
      if (!all.some((r) => r.key === acc.key)) {
        all.push({ key: acc.key, name: acc.name ?? acc.key, elo: myElo });
      }
    }

    all.sort((a, b) => b.elo - a.elo);
    const rows = all.slice(0, 50);
    if (acc) {
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
    // Surface a short reason (helps diagnose a rules/config problem)
    // instead of a blanket "connection" message.
    const why = /permission|denied/i.test(String(e?.message || e))
      ? "the database rules don't allow reading the leaderboard (see README)"
      : "couldn't reach the leaderboard right now — try again in a moment";
    host.innerHTML = `<li class="hint">${why}.</li>`;
    const badge = document.getElementById("ranked-mybadge");
    if (badge && acc) {
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

  // 2v2 duo panel controls (invites happen inside renderDuoPanel).
  document.getElementById("duo-leave")?.addEventListener("click", leaveDuo);

  const tab1 = document.getElementById("ranked-tab-1v1");
  const tab2 = document.getElementById("ranked-tab-2v2");
  const pick = async (mode) => {
    if (queued) await leaveQueue(); // switching ladders abandons the search
    activeMode = mode;
    tab1.classList.toggle("is-on", mode === "1v1");
    tab2.classList.toggle("is-on", mode === "2v2");
    renderDuoPanel();
    setQueueUI("idle");
    renderLeaderboard();
  };
  tab1.addEventListener("click", () => pick("1v1"));
  tab2.addEventListener("click", () => pick("2v2"));

  let boardTimer = 0;
  onEnter("screen-ranked", () => {
    renderDuoPanel();
    setQueueUI("idle");
    renderLeaderboard();
    boardTimer = setInterval(renderLeaderboard, 10000);
  });
  onLeave("screen-ranked", () => {
    clearInterval(boardTimer);
    if (queued) leaveQueue();
    // Backing out of ranked DISSOLVES an idle team. Keeping it alive
    // meant returning to the screen showed your old partner still
    // seated with no way to clear the slot; now you always come back to
    // an empty seat. A MATCHED team is left alone so being pulled into
    // the lobby doesn't tear it down under us.
    if (duo && !duo.matched) leaveDuo();
    // Leaving the screen keeps the duo alive — you can come back to it.
  });
}
