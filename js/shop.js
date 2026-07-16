// ================================================================
// shop.js — where paint is earned and worn.
//
// Tags (skull coins) come from ranked kills, one apiece. Every colour
// past the free default costs tags AND needs a rank, so what a tank
// wears says something about what its driver has done.
//
// Two tabs: COLOURS (the paint itself) and PATTERNS. Both equip the
// same way — tap something you own to wear it, tap something you can
// afford to buy it.
// ================================================================

import { onEnter, toast } from "./main.js";
import {
  SKINS, SHOP_SKINS, TIER_ORDER, DEFAULT_SKIN, tierUnlocked, skinFinish,
} from "./skins.js";
import {
  getAccount, getSkin, getTags, ownsSkin, bestElo, buySkin, equipSkin, isDev,
} from "./social.js";
import { rankOf } from "./ranked.js";

let tab = "colours";

/* ---------- swatch rendering ---------- */

// The metals aren't flat colours — they're finishes. A swatch shows
// that: a raked highlight for metallic, a hard mirror band for
// reflective, a bright bloom for shiny, and a spectral sweep for
// diamond. drawTank paints the real hulls the same way.
function swatchStyle(id) {
  const s = SKINS[id];
  const hex = s.hex;
  switch (s.finish) {
    case "metallic":
      return `background: linear-gradient(135deg, ${hex} 0%, #fff6 22%, ${hex} 42%, #0006 68%, ${hex} 100%);`;
    case "reflective":
      return `background: linear-gradient(120deg, #6a7382 0%, ${hex} 18%, #ffffff 34%, ${hex} 50%, #59606d 72%, ${hex} 100%);`;
    case "shiny":
      return `background: radial-gradient(circle at 32% 28%, #fffbe6 0%, ${hex} 46%, #8a6a12 100%);`;
    case "prismatic":
      return `background: linear-gradient(115deg, ${hex} 0%, #ffd9f2 18%, #d9fff0 34%, #ffffff 48%, #d9ecff 62%, ${hex} 84%, #ffe9fb 100%);`;
    default:
      return `background: ${hex};`;
  }
}

function tile(id, { owned, worn, afford, unlocked }) {
  const s = SKINS[id];
  const cost = s.cost ?? 0;
  let state = "";
  let foot = "";
  if (worn) { state = "is-worn"; foot = "WORN"; }
  else if (owned) { state = "is-owned"; foot = "WEAR"; }
  else if (!unlocked) { state = "is-locked"; foot = `🔒 ${s.tier}`; }
  else if (!afford) { state = "is-broke"; foot = `💀 ${cost}`; }
  else { foot = `💀 ${cost}`; }
  return `
    <button class="shop-tile ${state}" data-skin="${id}" type="button"
            aria-label="${s.name}${owned ? "" : `, ${cost} tags`}">
      <span class="shop-chip" style="${swatchStyle(id)}"></span>
      <span class="shop-name">${s.name}</span>
      <span class="shop-foot">${foot}</span>
    </button>`;
}

/* ---------- the colours tab ---------- */

function renderColours() {
  const host = document.getElementById("shop-colours");
  if (!host) return;
  const acc = getAccount();
  const elo = bestElo();
  const rank = elo == null ? "Copper" : rankOf(elo).name;
  const tags = getTags();
  const worn = getSkin();

  // Group by the rank that unlocks them; the default sits on its own.
  const groups = [{ tier: null, label: "Standard issue", ids: [DEFAULT_SKIN] }];
  for (const t of TIER_ORDER) {
    const ids = SHOP_SKINS.filter((id) => SKINS[id].tier === t);
    if (ids.length) groups.push({ tier: t, label: `${t} rank`, ids });
  }

  host.innerHTML = groups.map((g) => {
    const unlocked = tierUnlocked(g.tier, rank);
    const ownedN = g.ids.filter((id) => ownsSkin(id)).length;
    return `
      <section class="shop-group ${unlocked ? "" : "locked"}">
        <h3 class="shop-group-head">
          <span>${g.label}</span>
          <span class="shop-group-note">
            ${unlocked ? `${ownedN}/${g.ids.length} owned` : `🔒 Reach ${g.tier}`}
          </span>
        </h3>
        <div class="shop-grid">
          ${g.ids.map((id) => tile(id, {
            owned: ownsSkin(id),
            worn: id === worn,
            afford: isDev() || tags >= (SKINS[id].cost ?? 0),
            unlocked,
          })).join("")}
        </div>
      </section>`;
  }).join("");

  const rankEl = document.getElementById("shop-rank");
  if (rankEl) {
    rankEl.textContent = !acc
      ? "Log in to earn tags and buy paint — you're running standard red for now."
      : elo == null
        ? "Play a ranked match to set your rank. Copper paint is open to you now."
        : `${rank} rank · paint up to ${rank} is open to you.${isDev() ? " · DEV: unlimited tags" : ""}`;
  }
}

/* ---------- the patterns tab ---------- */

function renderPatterns() {
  const host = document.getElementById("shop-patterns");
  if (!host) return;
  host.innerHTML = `
    <section class="shop-group">
      <h3 class="shop-group-head"><span>Standard issue</span><span class="shop-group-note">1/1 owned</span></h3>
      <div class="shop-grid">
        <button class="shop-tile is-worn" type="button" aria-label="Solid">
          <span class="shop-chip" style="background:${SKINS[getSkin()].hex};"></span>
          <span class="shop-name">Solid</span>
          <span class="shop-foot">WORN</span>
        </button>
      </div>
    </section>
    <p class="shop-empty">
      No patterns in the catalogue yet — every tank runs Solid. Tags you
      bank now will spend here when they land.
    </p>`;
}

/* ---------- wiring ---------- */

function refresh() {
  const tagsEl = document.getElementById("shop-tags");
  if (tagsEl) {
    const n = getTags();
    tagsEl.textContent = Number.isFinite(n) ? String(n) : "∞";
  }
  if (tab === "colours") renderColours();
  else renderPatterns();
}

function pickTab(which) {
  tab = which;
  document.getElementById("shop-tab-colours")?.classList.toggle("is-on", which === "colours");
  document.getElementById("shop-tab-patterns")?.classList.toggle("is-on", which !== "colours");
  const c = document.getElementById("shop-colours");
  const p = document.getElementById("shop-patterns");
  if (c) c.hidden = which !== "colours";
  if (p) p.hidden = which === "colours";
  const rankEl = document.getElementById("shop-rank");
  if (rankEl) rankEl.hidden = which !== "colours";
  refresh();
}

export function initShop() {
  onEnter("screen-shop", () => { pickTab(tab); });

  document.getElementById("shop-tab-colours")?.addEventListener("click", () => pickTab("colours"));
  document.getElementById("shop-tab-patterns")?.addEventListener("click", () => pickTab("patterns"));

  // One delegated handler: tap to wear what you own, or to buy what
  // you can afford.
  document.getElementById("shop-colours")?.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-skin]");
    if (!btn) return;
    const id = btn.dataset.skin;
    const s = SKINS[id];
    if (!s) return;
    if (!getAccount()) { toast("Log in to buy and wear paint."); return; }

    if (ownsSkin(id)) {
      if (id === getSkin()) return; // already wearing it
      try {
        await equipSkin(id);
        refresh();
      } catch (err) {
        toast(err?.message ?? "Couldn't equip that.");
      }
      return;
    }
    const elo = bestElo();
    const rank = elo == null ? "Copper" : rankOf(elo).name;
    if (!tierUnlocked(s.tier, rank)) {
      toast(`${s.name} needs ${s.tier} rank.`);
      return;
    }
    btn.disabled = true;
    try {
      await buySkin(id);
      await equipSkin(id); // buying it means you want to wear it
      toast(`${s.name} bought — you're wearing it.`);
      refresh();
    } catch (err) {
      toast(err?.message ?? "Couldn't buy that.");
      btn.disabled = false;
    }
  });
}

export { skinFinish };
