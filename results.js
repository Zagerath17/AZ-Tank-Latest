// ================================================================
// results.js — the post-match ranked scoreboard.
//
// Shown to every finisher after a ranked session. Because damage and
// kills are only known on each VICTIM's client, the numbers are
// gathered from the lobby: each client wrote its received-damage
// ledger (keyed by attacker) under damageLog/{id} and killLog/{id},
// and its own Elo change under results/{ukey}. Here we sum those into
// per-player totals and render: the winner, then damage / kills / Elo
// swing for each player.
// ================================================================

import { showScreen, paintVar } from "./main.js";
import { tankSpriteCanvas } from "./tanksprite.js";
import { ensureFirebase } from "./online.js";
import { rankBadge } from "./ranked.js";
import { awardTags } from "./social.js";

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

// players: [{ id, key, name, color, team, score, elo }]. onContinue is
// called when the player dismisses the screen.
export async function showRankedResults(code, rMode, players, myKey, onContinue) {
  showScreen("screen-results");
  const body = document.getElementById("results-body");
  const btn = document.getElementById("results-continue");
  if (btn) {
    btn.onclick = () => onContinue?.();
    btn.disabled = false;
  }

  let timer = 0;
  let paid = false;
  let f = null;
  try { f = await ensureFirebase(); } catch (e) { /* render offline-ish */ }

  const draw = async () => {
    let results = {}, dmgLog = {}, killLog = {};
    if (f) {
      try {
        const base = `lobbies/${code}`;
        const [r, d, k] = await Promise.all([
          f.get(f.ref(f.db, `${base}/results`)),
          f.get(f.ref(f.db, `${base}/damageLog`)),
          f.get(f.ref(f.db, `${base}/killLog`)),
        ]);
        results = r.val() ?? {};
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
    render(body, rMode, players, myKey, results, dmgByPlayer, killsByPlayer);
    // Tags: one skull coin per ranked kill. A kill is only ever known
    // on the VICTIM's client, so this is the first moment my own count
    // exists — every ledger has landed and been summed. Paid once per
    // match, guarded in the lobby itself so a reload (or the poll
    // below firing again) can't pay twice.
    const meRow = players.find((p) => p.key === myKey);
    if (meRow && !paid) {
      const mine = killsByPlayer[meRow.id] ?? 0;
      if (mine > 0) {
        paid = true; // don't re-enter while the guard write is in flight
        payTags(f, code, myKey, mine).catch(() => { paid = false; });
      }
    }
  };

  await draw();
  // Poll briefly to catch tablemates who settle a beat later.
  let n = 0;
  timer = setInterval(async () => {
    n++;
    try { await draw(); } catch (e) {}
    if (n >= 6) clearInterval(timer);
  }, 1500);
  if (btn) {
    const prev = btn.onclick;
    btn.onclick = () => { clearInterval(timer); prev?.(); };
  }
}

function render(body, rMode, players, myKey, results, dmgByPlayer, killsByPlayer) {
  if (!body) return;
  // Winner: top score; in 2v2 the whole winning team.
  const topScore = Math.max(0, ...players.map((p) => p.score ?? 0));
  let winnerText;
  if (rMode === "2v2") {
    const winTeam = players.find((p) => (p.score ?? 0) === topScore)?.team ?? 0;
    const names = players.filter((p) => (p.team ?? 0) === winTeam).map((p) => p.name);
    const iWon = players.some((p) => p.key === myKey && (p.team ?? 0) === winTeam);
    winnerText = `${iWon ? "Victory" : "Defeat"} — ${names.join(" & ")} win`;
  } else {
    const w = players.slice().sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0];
    const iWon = w && w.key === myKey;
    winnerText = `${iWon ? "Victory" : "Defeat"} — ${w ? w.name : "?"} wins`;
  }

  // Order: winning side first, then by damage.
  const rows = players.slice().sort((a, b) =>
    (b.score ?? 0) - (a.score ?? 0) ||
    (dmgByPlayer[b.id] ?? 0) - (dmgByPlayer[a.id] ?? 0));

  const cell = (p) => {
    const res = results[p.key];
    const delta = res ? res.delta : null;
    const dsign = delta == null ? "…" : `${delta >= 0 ? "+" : ""}${delta}`;
    const dcls = delta == null ? "" : delta >= 0 ? "elo-up" : "elo-down";
    const dmg = Math.round(dmgByPlayer[p.id] ?? 0);
    const kills = killsByPlayer[p.id] ?? 0;
    return `
      <div class="res-row ${p.key === myKey ? "res-me" : ""} ${rMode === "2v2" ? "team-" + (p.team ?? 0) : ""}" style="${paintVar(p.color)}">
        <span class="res-sprite" data-color="${p.color}" data-pattern="${p.pattern ?? "solid"}" data-patcolors="${(p.patColors ?? []).join(",")}" data-colorhex="${p.colorHex ?? ""}" data-pathex="${(p.patHex ?? []).join(",")}" data-seed="${p.id ?? p.key ?? p.color}"></span>
        <span class="res-name">${res ? rankBadge(res.after, 16) : ""} ${p.name}</span>
        <span class="res-stat"><b>${dmg}</b><em>dmg</em></span>
        <span class="res-stat"><b>${kills}</b><em>kills</em></span>
        <span class="res-elo ${dcls}">${dsign}<em>elo</em></span>
      </div>`;
  };

  body.innerHTML = `
    <h3 class="res-winner ${winnerText.startsWith("Victory") ? "res-win" : "res-lose"}">${winnerText}</h3>
    <div class="res-head">
      <span>Player</span><span>Damage</span><span>Kills</span><span>Elo</span>
    </div>
    <div class="res-rows">${rows.map(cell).join("")}</div>`;

  // Swap in the live animated tank sprites (metal shimmer + patterns).
  body.querySelectorAll(".res-sprite").forEach((ph) => {
    const look = {
      color: ph.dataset.color,
      pattern: ph.dataset.pattern,
      patColors: ph.dataset.patcolors ? ph.dataset.patcolors.split(",") : [],
      // 2v2 team paint: a recoloured enemy team must look the same here
      // as it did in the arena and on the scoreboard.
      colorHex: ph.dataset.colorhex || null,
      patHex: ph.dataset.pathex ? ph.dataset.pathex.split(",") : null,
    };
    ph.appendChild(tankSpriteCanvas(look, 30, ph.dataset.seed));
  });
}
