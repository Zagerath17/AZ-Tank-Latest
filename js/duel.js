// ================================================================
// duel.js — 1v1: find someone, fight them.
//
// This is what's left after the ranked system was taken out, and the
// simplification is the point. There is no rating, no ladder, no
// leaderboard and no skill-based matchmaking: the queue is a plain
// first-come-first-served line, and the two people who have been
// waiting longest get paired. Nothing about who you are affects who
// you're put against.
//
//   queue/1v1/{key}         — { at, name } while searching
//   queue/1v1/{key}/match   — lobby code, written by the matchmaker
//
// The matchmaker runs on the client at the FRONT of the queue (the
// longest waiter), which keeps the whole thing serverless: it takes the
// first two waiting entries, makes a lobby, and writes the code to the
// other player. Both then drop into the same match.
//
// A match is still first to 3 round wins, and kills still pay a tag
// apiece into the shop — that's now the game's only economy.
// ================================================================

import { toast, onEnter, onLeave } from "./main.js";
import { ensureFirebase, createMatchLobby } from "./online.js";
import { getAccount } from "./social.js";
import { isConfigured } from "./firebase-config.js";

// Both players fight to this many round wins.
export const WIN_TARGET = 3;

// Where the line forms, and how long an abandoned place in it survives.
const QUEUE_PATH = "queue/1v1";
const STALE_MS = 90000;

let queued = false;
let queueTimer = 0;
let matchUnsub = null;

/* ---------- the queue ---------- */

function setQueueUI(state, extra = "") {
  const btn = document.getElementById("duel-queue");
  const status = document.getElementById("duel-status");
  if (!btn) return;
  btn.disabled = false;
  if (state === "idle") {
    btn.textContent = "FIND MATCH";
    if (status) {
      status.textContent = extra ||
        (getAccount()
          ? `Two tanks, first to ${WIN_TARGET} round wins.`
          : "Log in from the title screen to play 1v1.");
    }
  } else {
    btn.textContent = "CANCEL";
    if (status) status.textContent = extra || "Searching…";
  }
}

export async function joinQueue() {
  const acc = getAccount();
  if (!acc) { toast("Log in to play 1v1."); return; }
  if (queued) return leaveQueue();

  try {
    const f = await ensureFirebase();
    await f.set(f.ref(f.db, `${QUEUE_PATH}/${acc.key}`), {
      at: f.serverTimestamp(),
      name: acc.name,
    });
    queued = true;
    setQueueUI("queued");

    // Whoever ISN'T running the matchmaker learns their lobby code here.
    matchUnsub = f.onValue(f.ref(f.db, `${QUEUE_PATH}/${acc.key}/match`), async (snap) => {
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

    queueTimer = setInterval(() => matchmakerTick(f, acc).catch(() => {}), 2500);
  } catch (e) {
    toast(e?.message ?? "Couldn't join the queue — check the queue rule (README).");
  }
}

async function stopQueueing(removeEntry = true) {
  clearInterval(queueTimer);
  if (matchUnsub) { try { matchUnsub(); } catch (e) { /* already gone */ } matchUnsub = null; }
  queued = false;
  if (removeEntry) {
    try {
      const f = await ensureFirebase();
      const acc = getAccount();
      if (acc) await f.remove(f.ref(f.db, `${QUEUE_PATH}/${acc.key}`));
    } catch (e) { /* the entry ages out on its own */ }
  }
}

export async function leaveQueue() {
  await stopQueueing(true);
  setQueueUI("idle", "Search cancelled.");
}

// Pair the two longest waiters. Only the player at the front of the
// queue does this, so exactly one client is ever making the decision.
async function matchmakerTick(f, acc) {
  if (!queued) return;
  const snap = await f.get(f.ref(f.db, QUEUE_PATH));
  const q = Object.entries(snap.val() ?? {})
    .filter(([, v]) => v && v.at)
    .sort((a, b) => (a[1].at - b[1].at) || (a[0] < b[0] ? -1 : 1));

  const waiting = q.filter(([, v]) => !v.match);
  setQueueUI("queued", "Searching…");   // no head-count — it isn't the player's business
  if (!waiting.length || waiting[0][0] !== acc.key) return; // not my job

  // Sweep up anyone whose tab died mid-search.
  const now = Date.now();
  for (const [k, v] of q) {
    if (now - v.at > STALE_MS) f.remove(f.ref(f.db, `${QUEUE_PATH}/${k}`)).catch(() => {});
  }

  // Straight off the front of the line — no rating window to satisfy.
  if (waiting.length < 2) return;
  const pair = waiting.slice(0, 2);
  if (!pair.some(([k]) => k === acc.key)) return;

  const code = await createMatchLobby(2);
  const updates = {};
  for (const [k] of pair) {
    if (k !== acc.key) updates[`${QUEUE_PATH}/${k}/match`] = code;
  }
  await f.update(f.ref(f.db), updates);
  await stopQueueing(true); // the matchmaker is already in the lobby (host)
}

/* ---------- init ---------- */

export function initDuel() {
  document.getElementById("duel-queue")?.addEventListener("click", joinQueue);

  onEnter("screen-duel", () => {
    setQueueUI("idle", isConfigured
      ? ""
      : "Online play needs a Firebase project — see the README.");
  });

  onLeave("screen-duel", () => {
    // Walking away from the screen gives up your place in the line —
    // otherwise you'd be matched into a fight you're not watching for.
    if (queued) leaveQueue();
  });
}
