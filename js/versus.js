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
//   users/{me}/records/{oppKey}: { w, l }
// In 1v1 a round win/loss updates directly. In 4-player, only FIRST
// place scores — a 1st gives +1 win vs each of the other three, who
// each take a loss vs you. Everyone else's placement does nothing.
// ================================================================

import { tankSVG } from "./main.js";
import { ensureFirebase } from "./online.js";
import { getAccount } from "./social.js";
import { rankBadge } from "./ranked.js";

// Fetch my record vs one opponent key → { w, l }.
async function recordVs(f, oppKey) {
  if (!oppKey) return { w: 0, l: 0 };
  try {
    const s = await f.get(f.ref(f.db, `users/${getAccount().key}/records/${oppKey}`));
    return s.exists() ? { w: s.val().w ?? 0, l: s.val().l ?? 0 } : { w: 0, l: 0 };
  } catch (e) { return { w: 0, l: 0 }; }
}

// Render the versus card. roster: [{ id, name, color, ukey, bot }].
export async function showVersus(roster, myId, mode) {
  const meRow = roster.find((r) => r.id === myId);
  const foes = roster.filter((r) => r.id !== myId);
  const host = document.getElementById("versus-body");
  const acc = getAccount();

  // Big white "W - L" numerals sit UNDER each tank. A dash separates
  // them; no letters. Records fill in async once fetched.
  const spriteBlock = (r, isMe) => `
    <div class="vs-fighter p-${r.color}${isMe ? " vs-me" : ""}">
      ${tankSVG(r.color)}
      <span class="vs-name">${r.name ?? "Player"}</span>
      <span class="vs-record" data-fighter="${r.id}">
        <span class="vs-w">–</span><span class="vs-dash">-</span><span class="vs-l">–</span>
      </span>
    </div>`;

  host.innerHTML = `
    <div class="vs-side">${spriteBlock(meRow ?? { id: "me", color: "slate", name: "You" }, true)}</div>
    <div class="vs-mid">VS</div>
    <div class="vs-side vs-foes">${foes.map((f) => spriteBlock(f, false)).join("")}</div>`;

  if (!acc) return;
  try {
    const f = await ensureFirebase();
    const recs = await Promise.all(foes.map((fo) => recordVs(f, fo.ukey)));
    foes.forEach((fo, i) => {
      if (!fo.ukey) return;
      const rec = recs[i];
      const box = host.querySelector(`.vs-record[data-fighter="${fo.id}"]`);
      if (box) {
        box.querySelector(".vs-w").textContent = rec.w;
        box.querySelector(".vs-l").textContent = rec.l;
      }
    });
  } catch (e) { /* records are cosmetic */ }
}

// Apply a finished match to the win/loss ledger. placements sorted
// best-first: [{ id, key, score }]. mode "1v1" | "4p".
export async function recordResult(mode, placements) {
  const acc = getAccount();
  if (!acc) return;
  const me = placements.find((p) => p.key === acc.key);
  if (!me) return;
  try {
    const f = await ensureFirebase();
    const updates = {};
    const bump = async (oppKey, iWon) => {
      if (!oppKey) return;
      const cur = await recordVs(f, oppKey);
      const w = cur.w + (iWon ? 1 : 0);
      const l = cur.l + (iWon ? 0 : 1);
      updates[`users/${acc.key}/records/${oppKey}`] = { w, l };
    };

    if (mode === "1v1") {
      const opp = placements.find((p) => p.key !== acc.key);
      if (opp?.key) await bump(opp.key, me.score > opp.score);
    } else {
      // Only 1st place matters: the winner banks a win vs everyone,
      // the rest each bank a loss vs the winner (and nothing else).
      const top = placements[0];
      if (top.key === acc.key) {
        for (const p of placements) if (p.key !== acc.key) await bump(p.key, true);
      } else if (top.key) {
        await bump(top.key, false);
      }
    }
    if (Object.keys(updates).length) {
      await f.update(f.ref(f.db), updates);
    }
  } catch (e) { /* ledger is best-effort */ }
}
