// ================================================================
// results.js — the post-match scoreboard.
//
// Shown to both finishers after a 1v1. Because damage and kills are
// only ever known on each VICTIM's client, the numbers are gathered
// from the lobby: every client writes its received-damage ledger
// (keyed by attacker) under damageLog/{id} and killLog/{id}, and this
// screen sums those into per-player totals.
//
// There's no rating column any more — what a match pays out is TAGS,
// one per kill, which is the game's only currency and the entire
// reason the shop has anything in it.
// ================================================================

import { showScreen, paintVar } from "./main.js";
import { tankSpriteCanvas } from "./tanksprite.js";
import { ensureFirebase } from "./online.js";
import { awardTags, awardXp } from "./social.js";
import { XP_PER_KILL, XP_PER_WIN, MAX_SKILL_POINTS } from "./upgrades.js";

// Claim this match's kill tags exactly once. The claim flag lives on
// the lobby, so reloading the results screen — or a second device —
// can't collect the same kills twice.
async function payTags(f, code, myKey, kills) {
  if (!f || !myKey) return;
  const ref = f.ref(f.db, `lobbies/${code}/tagged/${myKey}`);
  const already = (await f.get(ref)).val();
  if (already) return;
  await f.set(ref, kills);
  await awardTags(kills);
}

// Pay out XP and play it back on the bar.
//
// Claimed once per match, guarded on the lobby exactly like the tags —
// a reload, or the poll below firing again, must not pay twice.
//
// The animation is the point: the bar fills from where it was, and when
// it reaches the end it announces the level, resets to empty and keeps
// going, so a match that crosses two levels shows both. For the first
// ten levels it also calls out the skill point, because that is the
// thing the player actually cares about.
async function payXp(f, code, myKey, kills, won) {
  if (!f || !myKey) return null;
  const amount = kills * XP_PER_KILL + (won ? XP_PER_WIN : 0);
  if (amount <= 0) return null;
  const ref = f.ref(f.db, `lobbies/${code}/xpPaid/${myKey}`);
  if ((await f.get(ref)).val()) return null;
  await f.set(ref, amount);
  return awardXp(amount);
}

function animateXp(res) {
  const box = document.getElementById("results-xp");
  if (!box || !res) return;
  box.hidden = false;
  const lvlEl = box.querySelector(".res-xp-lvl");
  const gainEl = box.querySelector(".res-xp-gain");
  const barEl = box.querySelector(".res-xp-bar > i");
  const noteEl = box.querySelector(".res-xp-note");
  gainEl.textContent = `+${res.gained} XP`;

  // One segment per level crossed, plus the remainder in the last one.
  const segs = [];
  let cur = res.from;
  for (const lv of res.levels) {
    segs.push({ from: cur.into / cur.need, to: 1, level: cur.level, ding: lv });
    cur = { level: lv.level, into: 0, need: cur.need };
  }
  const end = res.to;
  segs.push({
    from: res.levels.length ? 0 : res.from.into / res.from.need,
    to: end.need === Infinity ? 1 : end.into / end.need,
    level: end.level, ding: null,
  });

  let i = 0;
  const run = () => {
    if (i >= segs.length) return;
    const s2 = segs[i++];
    lvlEl.textContent = `LEVEL ${s2.level}`;
    barEl.style.transition = "none";
    barEl.style.width = `${Math.max(0, Math.min(1, s2.from)) * 100}%`;
    // Force the reset to land before the fill starts.
    void barEl.offsetWidth;
    const ms = 520;
    barEl.style.transition = `width ${ms}ms ease-out`;
    barEl.style.width = `${Math.max(0, Math.min(1, s2.to)) * 100}%`;
    setTimeout(() => {
      if (s2.ding) {
        noteEl.textContent = s2.ding.point
          ? `LEVEL ${s2.ding.level} — skill point earned!`
          : `LEVEL ${s2.ding.level}!`;
        noteEl.classList.add("pop");
        setTimeout(() => { noteEl.classList.remove("pop"); run(); }, 720);
      } else if (res.points > 0) {
        noteEl.textContent = `${res.points} skill point${res.points === 1 ? "" : "s"} to spend in the Shop.`;
      }
    }, ms + 40);
  };
  run();
}

// players: [{ id, key, name, color, score }]. onContinue is called when
// the player dismisses the screen.
export async function showMatchResults(code, players, myKey, onContinue) {
  showScreen("screen-results");
  const body = document.getElementById("results-body");
  const btn = document.getElementById("results-continue");
  if (btn) {
    btn.onclick = () => onContinue?.();
    btn.disabled = false;
  }

  let timer = 0;
  let paid = false;
  let xpPaid = false;
  let f = null;
  try { f = await ensureFirebase(); } catch (e) { /* render offline-ish */ }

  const draw = async () => {
    let dmgLog = {}, killLog = {};
    if (f) {
      try {
        const base = `lobbies/${code}`;
        const [d, k] = await Promise.all([
          f.get(f.ref(f.db, `${base}/damageLog`)),
          f.get(f.ref(f.db, `${base}/killLog`)),
        ]);
        dmgLog = d.val() ?? {};
        killLog = k.val() ?? {};
      } catch (e) { /* keep whatever we have */ }
    }
    // Sum each attacker's damage / kills across every victim's ledger.
    const dmgByPlayer = {}, killsByPlayer = {};
    for (const victim of Object.values(dmgLog)) {
      for (const [att, v] of Object.entries(victim ?? {})) dmgByPlayer[att] = (dmgByPlayer[att] ?? 0) + (+v || 0);
    }
    for (const victim of Object.values(killLog)) {
      for (const [att, v] of Object.entries(victim ?? {})) killsByPlayer[att] = (killsByPlayer[att] ?? 0) + (+v || 0);
    }
    render(body, players, myKey, dmgByPlayer, killsByPlayer);
    // Tags: one skull coin per kill. A kill is only ever known on the
    // VICTIM's client, so this is the first moment my own count exists
    // — every ledger has landed and been summed. Paid once per match,
    // guarded in the lobby itself so a reload (or the poll below firing
    // again) can't pay twice.
    const meRow = players.find((p) => p.key === myKey);
    if (meRow && !paid) {
      const mine = killsByPlayer[meRow.id] ?? 0;
      if (mine > 0) {
        paid = true; // don't re-enter while the guard write is in flight
        payTags(f, code, myKey, mine).catch(() => { paid = false; });
      }
    }
    // XP is paid on the same tick, and only once — including for a win
    // with no kills, which tags alone would miss.
    if (meRow && !xpPaid) {
      xpPaid = true;
      const top = players.slice().sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0];
      payXp(f, code, myKey, killsByPlayer[meRow.id] ?? 0, top && top.key === myKey)
        .then((r) => { if (r && r.gained) animateXp(r); })
        .catch(() => { xpPaid = false; });
    }
  };

  await draw();
  // Poll briefly to catch an opponent who settles a beat later.
  let n = 0;
  timer = setInterval(async () => {
    n++;
    try { await draw(); } catch (e) { /* keep polling */ }
    if (n >= 6) clearInterval(timer);
  }, 1500);
  if (btn) {
    const prev = btn.onclick;
    btn.onclick = () => { clearInterval(timer); prev?.(); };
  }
}

function render(body, players, myKey, dmgByPlayer, killsByPlayer) {
  if (!body) return;
  const w = players.slice().sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0];
  const iWon = w && w.key === myKey;
  const winnerText = `${iWon ? "Victory" : "Defeat"} — ${w ? w.name : "?"} wins`;

  // Order: winner first, then by damage.
  const rows = players.slice().sort((a, b) =>
    (b.score ?? 0) - (a.score ?? 0) ||
    (dmgByPlayer[b.id] ?? 0) - (dmgByPlayer[a.id] ?? 0));

  const cell = (p) => {
    const dmg = Math.round(dmgByPlayer[p.id] ?? 0);
    const kills = killsByPlayer[p.id] ?? 0;
    return `
      <div class="res-row ${p.key === myKey ? "res-me" : ""}" style="${paintVar(p.color)}">
        <span class="res-sprite" data-color="${p.color}" data-pattern="${p.pattern ?? "solid"}" data-patcolors="${(p.patColors ?? []).join(",")}" data-seed="${p.id ?? p.key ?? p.color}"></span>
        <span class="res-name">${p.name}</span>
        <span class="res-stat"><b>${dmg}</b><em>dmg</em></span>
        <span class="res-stat"><b>${kills}</b><em>kills</em></span>
        <span class="res-stat res-tags"><b>+${kills}</b><em>tags</em></span>
      </div>`;
  };

  body.innerHTML = `
    <h3 class="res-winner ${iWon ? "res-win" : "res-lose"}">${winnerText}</h3>
    <div class="res-head">
      <span>Player</span><span>Damage</span><span>Kills</span><span>Tags</span>
    </div>
    <div class="res-rows">${rows.map(cell).join("")}</div>`;

  // Swap in the real tank sprites (material paint + patterns).
  body.querySelectorAll(".res-sprite").forEach((ph) => {
    const look = {
      color: ph.dataset.color,
      pattern: ph.dataset.pattern,
      patColors: ph.dataset.patcolors ? ph.dataset.patcolors.split(",") : [],
    };
    ph.appendChild(tankSpriteCanvas(look, 30, ph.dataset.seed));
  });
}
