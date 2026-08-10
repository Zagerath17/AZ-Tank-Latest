// ================================================================
// shop.js — where paint is earned and worn.
//
// Tags (skull coins) come from kills, one apiece. What you can BUY is
// no longer a question of rank — it's a question of what you already
// own, so the shop reads as a route through itself rather than a list
// of things other people have unlocked:
//
//   • a shade needs the same hue one step back (blue → dark blue),
//     and since red is free, dark red is open from your very first tag;
//   • a MATERIAL needs its whole family finished (Bronze wants every
//     primary, Silver every dark, and so on);
//   • Ruby needs the entire rest of the catalogue.
//
// Patterns have no gates at all — they cost tags and that's it.
//
// Two tabs, both equipping the same way: tap something you own to wear
// it, tap something you can afford to buy it.
// ================================================================

import { onEnter, toast } from "./main.js";
import {
  SKINS, SHOP_SKINS, FAMILY_ORDER, FAMILY_LABEL, DEFAULT_SKIN,
  skinFinish, skinUnlocked, lockReason, requirements, isMaterialSkin,
  PATTERNS, SHOP_PATTERNS, DEFAULT_PATTERN, patternColors,
} from "./skins.js";
import {
  getAccount, getSkin, getTags, ownsSkin, buySkin, equipSkin,
  ownsPattern, getPattern, getPatternColors, buyPattern, equipPattern, ownedSkins,
} from "./social.js";
import { finishSwatchCanvas } from "./tanksprite.js";

let tab = "colours";

/* ---------- swatch rendering ---------- */

// A CSS stand-in for a material chip, shown for the instant before the
// real canvas swatch replaces it. Deliberately plain: the canvas is the
// authority on what bronze looks like (material.js), and a CSS gradient
// pretending otherwise would just disagree with it.
function swatchStyle(id) {
  const s = SKINS[id];
  return `background: ${s.hex};`;
}

function tile(id, { owned, worn, afford, unlocked }) {
  const s = SKINS[id];
  const cost = s.cost ?? 0;
  let state = "";
  let foot = "";
  if (worn) { state = "is-worn"; foot = "WORN"; }
  else if (owned) { state = "is-owned"; foot = "WEAR"; }
  else if (!unlocked) { state = "is-locked"; foot = "🔒"; }
  else if (!afford) { state = "is-broke"; foot = `💀 ${cost}`; }
  else { foot = `💀 ${cost}`; }
  // A locked tile says what's missing, not just that it's shut.
  const why = unlocked || owned ? "" : lockReason(id, ownsSkin);
  return `
    <button class="shop-tile ${state}" data-skin="${id}" type="button"
            aria-label="${s.name}${owned ? "" : `, ${cost} tags${why ? `, locked: ${why}` : ""}`}">
      <span class="shop-chip" data-chip="${id}" style="${swatchStyle(id)}"></span>
      <span class="shop-name">${s.name}</span>
      <span class="shop-foot">${foot}</span>
      ${why ? `<span class="shop-need">${why}</span>` : ""}
    </button>`;
}

/* ---------- the colours tab ---------- */

function renderColours() {
  const host = document.getElementById("shop-colours");
  if (!host) return;
  const acc = getAccount();
  const tags = getTags();
  const worn = getSkin();

  // Grouped by family, in progression order, with the materials last —
  // that ordering IS the unlock chain, so the shelf reads top to bottom
  // the same way you actually work through it.
  const groups = FAMILY_ORDER
    .map((fam) => ({
      fam,
      label: FAMILY_LABEL[fam] ?? fam,
      ids: SHOP_SKINS.filter((id) => SKINS[id].fam === fam),
    }))
    .filter((g) => g.ids.length);

  const materialIds = SHOP_SKINS.filter((id) => isMaterialSkin(id));
  if (materialIds.length) {
    groups.push({ fam: "material", label: "Materials", ids: materialIds, material: true });
  }

  host.innerHTML = groups.map((g) => {
    const ownedN = g.ids.filter((id) => ownsSkin(id)).length;
    const note = `${ownedN}/${g.ids.length} owned`;
    return `
      <section class="shop-group ${g.material ? "shop-group-material" : ""}">
        <h3 class="shop-group-head">
          <span>${g.label}</span>
          <span class="shop-group-note">${note}</span>
        </h3>
        <div class="shop-grid">
          ${g.ids.map((id) => tile(id, {
            owned: ownsSkin(id),
            worn: id === worn,
            afford: tags >= (SKINS[id].cost ?? 0),
            unlocked: skinUnlocked(id, ownsSkin),
          })).join("")}
        </div>
      </section>`;
  }).join("");

  const rankEl = document.getElementById("shop-rank");
  if (rankEl) {
    if (!acc) {
      rankEl.textContent = "Log in to earn tags and buy paint — you're running standard red for now.";
    } else {
      // Point at the next thing that's actually within reach, so there's
      // always a concrete next step rather than a wall of padlocks.
      const next = SHOP_SKINS.find((id) =>
        !ownsSkin(id) && skinUnlocked(id, ownsSkin) && tags >= (SKINS[id].cost ?? 0));
      const owned = SHOP_SKINS.filter((id) => ownsSkin(id)).length;
      rankEl.textContent = next
        ? `${owned}/${SHOP_SKINS.length} colours owned · ${SKINS[next].name} is yours for ${SKINS[next].cost}.`
        : `${owned}/${SHOP_SKINS.length} colours owned · every colour opens the one after it.`;
    }
  }

  // Swap each material's flat CSS chip for the real thing: the same
  // static shading the tank will wear, drawn by material.js.
  host.querySelectorAll(".shop-chip[data-chip]").forEach((chip) => {
    const id = chip.dataset.chip;
    if (skinFinish(id) === "flat") return; // plain colours keep the plain fill
    chip.replaceWith(finishSwatchCanvas(id, 40));
  });
}

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
    case "stripes":
      return `background: repeating-linear-gradient(125deg, ${light} 0 22%, ${dark} 22% 34%, ${light} 34% 44%);`;
    case "hexScale":
      return `background:
        radial-gradient(circle at 50% 0, ${dark} 22%, transparent 24%) 0 0 / 40% 40%,
        radial-gradient(circle at 50% 0, ${dark} 22%, transparent 24%) 20% 20% / 40% 40%, ${light};`;
    case "flames":
      return `background:
        radial-gradient(ellipse 60% 22% at 0 30%, ${dark} 55%, transparent 57%),
        radial-gradient(ellipse 55% 22% at 0 70%, ${dark} 55%, transparent 57%), ${light};`;
    case "circuit":
      return `background:
        linear-gradient(${dark}, ${dark}) 20% 0 / 8% 60% no-repeat,
        linear-gradient(${dark}, ${dark}) 20% 55% / 55% 8% no-repeat,
        linear-gradient(${dark}, ${dark}) 70% 20% / 8% 55% no-repeat, ${light};`;
    case "tiger":
      return `background: repeating-linear-gradient(92deg, ${light} 0 14%, ${dark} 14% 20%, ${light} 20% 30%);`;
    case "galaxy":
      return `background:
        radial-gradient(circle at 50% 50%, #fff 4%, transparent 6%),
        radial-gradient(circle at 22% 30%, #fff 3%, transparent 5%),
        radial-gradient(circle at 74% 68%, #fff 3%, transparent 5%),
        radial-gradient(circle at 50% 50%, ${light} 8%, ${dark} 70%);`;
    default:
      return `background: ${light};`;
  }
}

function patternTile(id, { owned, worn, afford }) {
  const p = PATTERNS[id];
  const cost = p.cost ?? 0;
  let state = "", foot = "";
  if (worn) { state = "is-worn"; foot = "WORN"; }
  else if (owned) { state = "is-owned"; foot = "WEAR"; }
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
  const tags = getTags();
  const worn = getPattern();

  // No gates and no shelves: one grid, cheapest first, and the only
  // question is whether you can pay for it.
  const ownedN = SHOP_PATTERNS.filter((id) => ownsPattern(id)).length;
  host.innerHTML = `
    <p class="shop-rank" id="shop-pattern-rank">${
      !acc
        ? "Log in to earn tags and buy patterns."
        : `${ownedN}/${SHOP_PATTERNS.length} owned · patterns need two colours you own to wear.`
    }</p>
    <section class="shop-group">
      <div class="shop-grid">
        ${SHOP_PATTERNS.map((id) => patternTile(id, {
          owned: ownsPattern(id),
          worn: id === worn,
          afford: tags >= (PATTERNS[id].cost ?? 0),
        })).join("")}
      </div>
    </section>`;
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
  onEnter("screen-shop", () => pickTab(tab));

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

    // The chain is checked here as well as in the UI — an enabled
    // button is never the authority on whether something can be sold.
    if (!skinUnlocked(id, ownsSkin)) {
      toast(lockReason(id, ownsSkin) || `${s.name} is still locked.`);
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

export { skinFinish, requirements };
