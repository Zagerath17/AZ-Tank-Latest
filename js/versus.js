// ================================================================
// versus.js — the head-to-head loading screen.
//
// Shown to every player the moment a match is starting, it doubles
// as a SYNC BARRIER: each client marks itself ready under
// lobbies/{code}/ready/{id}, and the actual round only begins once
// everyone's ready (or a short grace timeout elapses). Meanwhile it
// shows your tank vs the opponents' with your win/loss record.
//
// Records live per account:
//   1v1:  users/{me}/records/{oppKey}: { w, l }
//   2v2:  users/{me}/records2v2/{comboKey}: { w, l }
//         comboKey = `${myMateKey}__vs__${oppA__oppB}` (opponents
//         sorted) — the ledger is per EXACT team combination: you &
//         John vs Bill & Frank is a different book from you & Joe vs
//         Bill & Frank.
// ================================================================

import { tankSVG } from "./main.js";
import { ensureFirebase } from "./online.js";
import { getAccount } from "./social.js";

// Fetch my record vs one opponent key → { w, l }.
async function recordVs(f, oppKey) {
  if (!oppKey) return { w: 0, l: 0 };
  try {
    const s = await f.get(f.ref(f.db, `users/${getAccount().key}/records/${oppKey}`));
    return s.exists() ? { w: s.val().w ?? 0, l: s.val().l ?? 0 } : { w: 0, l: 0 };
  } catch (e) { return { w: 0, l: 0 }; }
}

// The 2v2 ledger key for MY mate vs the exact enemy duo.
function comboKey(mateKey, oppKeys) {
  const opp = [...oppKeys].filter(Boolean).sort();
  return `${mateKey ?? "solo"}__vs__${opp.join("__")}`;
}

async function recordVsDuo(f, mateKey, oppKeys) {
  try {
    const s = await f.get(f.ref(f.db,
      `users/${getAccount().key}/records2v2/${comboKey(mateKey, oppKeys)}`));
    return s.exists() ? { w: s.val().w ?? 0, l: s.val().l ?? 0 } : { w: 0, l: 0 };
  } catch (e) { return { w: 0, l: 0 }; }
}

// Render the versus card. roster: [{ id, name, color, ukey, bot }].
// teams (2v2 only): { [ukey]: 0|1 }; players: [[id, p]] to map ukeys.
// ranked=false (custom lobbies): the card still loads, but there's no
// win/loss ledger to show — those records are a ranked-only thing.
export async function showVersus(roster, myId, mode, teams = null, players = [], ranked = true) {
  const acc = getAccount();
  const host = document.getElementById("versus-body");
  // players may arrive as entries ([[id, p]]) or an id→p object.
  const entries = Array.isArray(players) ? players : Object.entries(players ?? {});
  const ukeyOf = (id) =>
    roster.find((r) => r.id === id)?.ukey
    ?? entries.find(([pid]) => pid === id)?.[1]?.ukey
    ?? null;

  const meRow = roster.find((r) => r.id === myId);
  let allies = [];
  let foes = roster.filter((r) => r.id !== myId);

  if (mode === "2v2" && teams && meRow) {
    const myTeam = teams[ukeyOf(myId)] ?? 0;
    allies = roster.filter((r) => r.id !== myId && (teams[ukeyOf(r.id)] ?? 0) === myTeam);
    foes = roster.filter((r) => (teams[ukeyOf(r.id)] ?? 0) !== myTeam);
  }

  // ONE giant number sits under each side — your (team's) wins under
  // yours, the opponents' under theirs — with a hyphen between.
  const spriteBlock = (r, isMe, side) => `
    <div class="vs-fighter p-${r.color}${isMe ? " vs-me" : ""}">
      ${tankSVG(r.color)}
      <span class="vs-name">${r.name ?? "Player"}</span>
      <span class="vs-score" data-fighter="${r.id}" data-side="${side}">${side ? "–" : ""}</span>
    </div>`;

  const mySide = [meRow ?? { id: "me", color: "slate", name: "You" }, ...allies];
  host.innerHTML = `
    <div class="vs-side">${mySide.map((r, i) => spriteBlock(r, r.id === myId, i === 0 ? "me" : "")).join("")}</div>
    <div class="vs-mid"><span class="vs-vs">VS</span><span class="vs-ratio-dash">-</span></div>
    <div class="vs-side vs-foes">${foes.map((f, i) => spriteBlock(f, false, i === 0 ? "foe" : "")).join("")}</div>`;

  if (!acc || !ranked) return; // custom lobby: card only, no records
  try {
    const f = await ensureFirebase();
    const myBox = host.querySelector('.vs-score[data-side="me"]');
    const foeBox = host.querySelector('.vs-score[data-side="foe"]');

    if (mode === "2v2" && teams) {
      // The ledger for THIS exact matchup: my mate vs this enemy duo.
      const mateKey = allies[0] ? ukeyOf(allies[0].id) : null;
      const oppKeys = foes.map((fo) => ukeyOf(fo.id));
      const rec = await recordVsDuo(f, mateKey, oppKeys);
      if (myBox) myBox.textContent = rec.w;
      if (foeBox) foeBox.textContent = rec.l;
      return;
    }

    // 1v1: your record vs the single opponent.
    const only = foes[0];
    const rec = await recordVs(f, only ? ukeyOf(only.id) ?? only.ukey : null);
    if (myBox) myBox.textContent = rec.w;
    if (foeBox) foeBox.textContent = rec.l;
  } catch (e) { /* records are cosmetic */ }
}

// Apply a finished match to the win/loss ledger. placements:
// [{ id, key, score, team? }], best score first. mode "1v1" | "2v2".
export async function recordResult(mode, placements) {
  const acc = getAccount();
  if (!acc) return;
  const me = placements.find((p) => p.key === acc.key);
  if (!me) return;
  try {
    const f = await ensureFirebase();

    if (mode === "2v2") {
      // Per exact team combination: my mate vs the enemy duo.
      const mate = placements.find((p) => p.key !== acc.key && (p.team ?? 0) === (me.team ?? 0));
      const opps = placements.filter((p) => (p.team ?? 0) !== (me.team ?? 0));
      if (!opps.length) return;
      const oppScore = Math.max(...opps.map((p) => p.score ?? 0));
      const iWon = (me.score ?? 0) > oppScore;
      const key = comboKey(mate?.key ?? null, opps.map((p) => p.key));
      const cur = await recordVsDuo(f, mate?.key ?? null, opps.map((p) => p.key));
      await f.set(f.ref(f.db, `users/${acc.key}/records2v2/${key}`), {
        w: cur.w + (iWon ? 1 : 0),
        l: cur.l + (iWon ? 0 : 1),
      });
      return;
    }

    // 1v1.
    const opp = placements.find((p) => p.key !== acc.key);
    if (!opp?.key) return;
    const iWon = (me.score ?? 0) > (opp.score ?? 0);
    const cur = await recordVs(f, opp.key);
    await f.set(f.ref(f.db, `users/${acc.key}/records/${opp.key}`), {
      w: cur.w + (iWon ? 1 : 0),
      l: cur.l + (iWon ? 0 : 1),
    });
  } catch (e) { /* ledger is best-effort */ }
}
