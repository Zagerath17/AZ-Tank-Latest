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
  PATTERNS, SHOP_PATTERNS, DEFAULT_PATTERN, patternColors,
} from "./skins.js";
import {
  getAccount, getSkin, getTags, ownsSkin, bestElo, buySkin, equipSkin,
  ownsPattern, getPattern, getPatternColors, buyPattern, equipPattern, ownedSkins,
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
  // These mirror hullPaint() in game.js — a swatch has to promise the
  // same material the tank will actually wear. Hard stops, not soft
  // ramps: at chip size a gentle blend reads as a flat colour.
  switch (s.finish) {
    case "metallic": // brushed bands
      return `background: linear-gradient(128deg, #0006 0%, #fff6 16%, #0007 30%, #fff9 46%,
        ${hex} 58%, #0007 72%, #fff7 86%, #0006 100%), ${hex};`;
    case "reflective": // chrome: hard horizon + mirror band
      return `background: linear-gradient(128deg, #0009 0%, #0008 40%, #fffa 42%, #ffffff 50%,
        #fff8 56%, #0006 58%, #0009 100%), ${hex};`;
    case "shiny": // gloss bloom
      return `background: linear-gradient(128deg, #0007 0%, transparent 28%, #fffb 46%,
        #fffdf0 52%, #fff9 60%, transparent 80%, #0007 100%), ${hex};`;
    case "shinyReflective": // diamond: faceted mirror + gloss
      return `background: linear-gradient(128deg, #0008 0%, #fff5 22%, #0007 30%, #ffffff 32%,
        #fff4 38%, transparent 52%, #ffffff 62%, #fff6 66%, #0006 80%, #fff4 100%), ${hex};`;
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
            afford: tags >= (SKINS[id].cost ?? 0),
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
        : `${rank} rank · paint up to ${rank} is open to you.`;
  }
}

/* ---------- the patterns tab ---------- */

// A little swatch showing the pattern shape in neutral tones, so the
// tile reads as "camo" / "lightning" etc. before you pick colours.
function patternChip(id) {
  const dark = "#2a2f3a", light = "#c7d0de";
  switch (id) {
    case "twoTone":
      return `background: linear-gradient(90deg, ${light} 50%, ${dark} 50%);`;
    case "splotchy":
      return `background:
        radial-gradient(circle at 30% 35%, ${dark} 18%, transparent 19%),
        radial-gradient(circle at 68% 60%, ${dark} 15%, transparent 16%),
        radial-gradient(circle at 50% 80%, ${dark} 12%, transparent 13%), ${light};`;
    case "camo":
      return `background:
        radial-gradient(ellipse 40% 30% at 30% 40%, ${dark} 60%, transparent 62%),
        radial-gradient(ellipse 35% 40% at 70% 65%, ${dark} 60%, transparent 62%), ${light};`;
    case "modernCamo":
      return `background:
        conic-gradient(${dark} 90deg, ${light} 90deg 180deg, ${dark} 180deg 270deg, ${light} 270deg)
        0 0 / 33% 33% ${light};`;
    case "lightning":
      return `background: linear-gradient(115deg, ${light} 46%, ${dark} 47%, ${dark} 53%, ${light} 54%),
        linear-gradient(65deg, transparent 60%, ${dark} 61%, ${dark} 66%, transparent 67%), ${light};`;
    default:
      return `background: ${light};`;
  }
}

function patternTile(id, { owned, worn, afford, unlocked }) {
  const p = PATTERNS[id];
  const cost = p.cost ?? 0;
  let state = "", foot = "";
  if (worn) { state = "is-worn"; foot = "WORN"; }
  else if (owned) { state = "is-owned"; foot = "WEAR"; }
  else if (!unlocked) { state = "is-locked"; foot = `🔒 ${p.tier}`; }
  else if (!afford) { state = "is-broke"; foot = `💀 ${cost}`; }
  else { foot = `💀 ${cost}`; }
  return `
    <button class="shop-tile ${state}" data-pattern="${id}" type="button"
            aria-label="${p.name}${owned ? "" : `, ${cost} tags`}">
      <span class="shop-chip" style="${patternChip(id)}"></span>
      <span class="shop-name">${p.name}</span>
      <span class="shop-foot">${foot}</span>
    </button>`;
}

function renderPatterns() {
  const host = document.getElementById("shop-patterns");
  if (!host) return;
  const acc = getAccount();
  const elo = bestElo();
  const rank = elo == null ? "Copper" : rankOf(elo).name;
  const tags = getTags();
  const worn = getPattern();

  const groups = [{ tier: null, label: "Standard issue", ids: [DEFAULT_PATTERN] }];
  for (const t of TIER_ORDER) {
    const ids = SHOP_PATTERNS.filter((id) => PATTERNS[id].tier === t);
    if (ids.length) groups.push({ tier: t, label: `${t} rank`, ids });
  }

  host.innerHTML = `
    <p class="shop-rank" id="shop-pattern-rank">${
      !acc
        ? "Log in to earn tags and buy patterns."
        : `${rank} rank · patterns need two colours you own to wear.`
    }</p>` + groups.map((g) => {
    const unlocked = tierUnlocked(g.tier, rank);
    const ownedN = g.ids.filter((id) => ownsPattern(id)).length;
    return `
      <section class="shop-group ${unlocked ? "" : "locked"}">
        <h3 class="shop-group-head">
          <span>${g.label}</span>
          <span class="shop-group-note">
            ${unlocked ? `${ownedN}/${g.ids.length} owned` : `🔒 Reach ${g.tier}`}
          </span>
        </h3>
        <div class="shop-grid">
          ${g.ids.map((id) => patternTile(id, {
            owned: ownsPattern(id),
            worn: id === worn,
            afford: tags >= (PATTERNS[id].cost ?? 0),
            unlocked,
          })).join("")}
        </div>
      </section>`;
  }).join("");
}

// The two-colour picker shown when equipping a multi-colour pattern.
// Lists the colours you own; the player taps two DIFFERENT ones.
function openPatternPicker(patternId) {
  const modal = document.getElementById("pattern-picker");
  if (!modal) return;
  const owned = Object.keys(ownedSkins()).filter((id) => SKINS[id] && !SKINS[id].reserved);
  const pre = getPatternColors();
  const chosen = getPattern() === patternId && pre.length === 2 ? [...pre] : [];

  const grid = modal.querySelector("#pattern-picker-grid");
  const err = modal.querySelector("#pattern-picker-msg");
  const paint = () => {
    grid.innerHTML = owned.map((id) => {
      const slot = chosen.indexOf(id);
      const badge = slot === 0 ? "①" : slot === 1 ? "②" : "";
      return `
        <button class="pp-swatch ${slot >= 0 ? "is-picked" : ""}" data-color="${id}" type="button"
                title="${SKINS[id].name}">
          <span class="pp-chip" style="background:${SKINS[id].hex};"></span>
          <span class="pp-badge">${badge}</span>
        </button>`;
    }).join("");
  };
  paint();
  err.textContent = "";
  modal.hidden = false;

  const onPick = (e) => {
    const sw = e.target.closest("[data-color]");
    if (!sw) return;
    const id = sw.dataset.color;
    const at = chosen.indexOf(id);
    if (at >= 0) chosen.splice(at, 1);
    else if (chosen.length < 2) chosen.push(id);
    else { chosen.shift(); chosen.push(id); }
    paint();
  };
  grid.onclick = onPick;

  modal.querySelector("#pattern-picker-apply").onclick = async () => {
    if (chosen.length < 2) { err.textContent = "Pick two different colours."; return; }
    try {
      await equipPattern(patternId, chosen);
      modal.hidden = true;
      refresh();
      toast(`${PATTERNS[patternId].name} equipped.`);
    } catch (e2) { err.textContent = e2?.message ?? "Couldn't equip that."; }
  };
  modal.querySelector("#pattern-picker-cancel").onclick = () => { modal.hidden = true; };
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

  // Patterns: tap to wear (opening the colour picker for two-tone ones)
  // or to buy what you can afford.
  document.getElementById("shop-patterns")?.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-pattern]");
    if (!btn) return;
    const id = btn.dataset.pattern;
    const p = PATTERNS[id];
    if (!p) return;
    if (!getAccount()) { toast("Log in to buy and wear patterns."); return; }

    if (ownsPattern(id)) {
      if (id === DEFAULT_PATTERN) {
        // Solid takes no colours — equip straight away.
        try { await equipPattern(id, []); refresh(); }
        catch (err) { toast(err?.message ?? "Couldn't equip that."); }
        return;
      }
      // Owned multi-colour pattern → pick its two colours.
      if (patternColors(id) >= 2) openPatternPicker(id);
      return;
    }
    const elo = bestElo();
    const rank = elo == null ? "Copper" : rankOf(elo).name;
    if (!tierUnlocked(p.tier, rank)) {
      toast(`${p.name} needs ${p.tier} rank.`);
      return;
    }
    btn.disabled = true;
    try {
      await buyPattern(id);
      toast(`${p.name} bought — pick two colours to wear it.`);
      refresh();
      if (patternColors(id) >= 2) openPatternPicker(id);
    } catch (err) {
      toast(err?.message ?? "Couldn't buy that.");
      btn.disabled = false;
    }
  });
}

export { skinFinish };
