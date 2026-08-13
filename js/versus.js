// ================================================================
// versus.js — the head-to-head loading screen.
//
// Shown to both players the moment a match is starting, it doubles as
// a SYNC BARRIER: each client marks itself ready under
// lobbies/{code}/ready/{id}, and the round only begins once everyone's
// ready (or a short grace timeout elapses). Meanwhile it shows your
// tank against your opponent's with the record between you.
//
// That record is the only thing either of you carries between matches
// now that ratings are gone, and it's deliberately personal rather
// than global: not a rank, just how the two of you have got on.
//
//   users/{me}/records/{oppKey}: { w, l }
// ================================================================

import { paintVar } from "./main.js";
import { tankSpriteCanvas } from "./tanksprite.js";
import { DEFAULT_SKIN } from "./skins.js";
import { describe as describeUpgrades } from "./upgrades.js";
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

// Render the versus card. roster: [{ id, name, color, ukey, bot }].
// players: [[id, p]] (or an id→p object) to map ukeys.
// matched=false (custom lobbies): the card still loads, but there's no
// win/loss ledger to show — records are a 1v1 thing.
export async function showVersus(roster, myId, players = [], matched = true, showPerks = true) {
  const acc = getAccount();
  const host = document.getElementById("versus-body");
  // players may arrive as entries ([[id, p]]) or an id→p object.
  const entries = Array.isArray(players) ? players : Object.entries(players ?? {});
  const ukeyOf = (id) =>
    roster.find((r) => r.id === id)?.ukey
    ?? entries.find(([pid]) => pid === id)?.[1]?.ukey
    ?? null;

  const meRow = roster.find((r) => r.id === myId);
  const foes = roster.filter((r) => r.id !== myId);

  // ONE giant number sits under each side — my wins under mine, my
  // losses under theirs — with a hyphen between.
  // What each side has put its skill points into. Shown BEFORE the
  // match so both players can see what they're up against — the whole
  // point of a build being visible rather than a hidden advantage.
  const perkBlock = (r) => {
    const list = describeUpgrades(r.upgrades ?? {});
    if (!list.length) return `<span class="vs-perks"><span class="vs-perk">No upgrades</span></span>`;
    return `<span class="vs-perks">${
      list.slice(0, 6).map((d) => `<span class="vs-perk">${d.group} · ${d.short} <b>${d.ranks}</b></span>`).join("")
    }${list.length > 6 ? `<span class="vs-perk">+${list.length - 6} more</span>` : ""}</span>`;
  };

  const spriteBlock = (r, isMe, side) => `
    <div class="vs-fighter${isMe ? " vs-me" : ""}" style="${paintVar(r.color)}">
      <span class="vs-sprite" data-sprite="${r.id}"
            data-color="${r.color}" data-pattern="${r.pattern ?? "solid"}"
            data-patcolors="${(r.patColors ?? []).join(",")}"></span>
      <span class="vs-name">${r.name ?? "Player"}${r.level ? ` <em class="vs-lvl">L${r.level}</em>` : ""}</span>
      ${showPerks ? perkBlock(r) : ""}
      <span class="vs-score" data-fighter="${r.id}" data-side="${side}">${matched && side ? "–" : ""}</span>
    </div>`;

  const mySide = [meRow ?? { id: "me", color: DEFAULT_SKIN, name: "You" }];
  host.innerHTML = `
    <div class="vs-side">${mySide.map((r) => spriteBlock(r, r.id === myId, "me")).join("")}</div>
    <div class="vs-mid"><span class="vs-vs">VS</span>${matched ? '<span class="vs-ratio-dash">-</span>' : ""}</div>
    <div class="vs-side vs-foes">${foes.map((f, i) => spriteBlock(f, false, i === 0 ? "foe" : "")).join("")}</div>`;

  // Swap the placeholders for real tank sprites (material paint +
  // pattern), so the head-to-head matches the tanks you'll drive.
  host.querySelectorAll(".vs-sprite").forEach((ph) => {
    const look = {
      color: ph.dataset.color,
      pattern: ph.dataset.pattern,
      patColors: ph.dataset.patcolors ? ph.dataset.patcolors.split(",") : [],
    };
    ph.appendChild(tankSpriteCanvas(look, 64, ph.dataset.sprite));
  });

  if (!acc || !matched) return; // custom lobby: card only, no records
  try {
    const f = await ensureFirebase();
    const myBox = host.querySelector('.vs-score[data-side="me"]');
    const foeBox = host.querySelector('.vs-score[data-side="foe"]');
    const only = foes[0];
    const rec = await recordVs(f, only ? ukeyOf(only.id) ?? only.ukey : null);
    if (myBox) myBox.textContent = rec.w;
    if (foeBox) foeBox.textContent = rec.l;
  } catch (e) { /* records are cosmetic */ }
}

// Apply a finished match to the win/loss ledger. placements:
// [{ id, key, score }], best score first.
export async function recordResult(placements) {
  const acc = getAccount();
  if (!acc) return;
  const me = placements.find((p) => p.key === acc.key);
  if (!me) return;
  try {
    const f = await ensureFirebase();
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
