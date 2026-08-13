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

import { onEnter, toast, showScreen } from "./main.js";
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
import {
  UPGRADE_TREE, MAX_SKILL_POINTS, RESET_COST, TOTAL_RANKS,
  ranksIn, pointsSpent, pointsLeft, canRank, xpForLevel,
} from "./upgrades.js";
import {
  getXp, getLevel, getLevelInfo, getUpgrades, getSkillPointsLeft,
  rankUpgrade, resetUpgrades, getUpgradesSpent,
} from "./social.js";

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
    case "checker":
      return `background:
        conic-gradient(${dark} 90deg, ${light} 90deg 180deg, ${dark} 180deg 270deg, ${light} 270deg)
        0 0 / 50% 50%;`;
    case "hazard":
      return `background: repeating-linear-gradient(135deg, ${dark} 0 18%, ${light} 18% 36%);`;
    case "chevron":
      return `background:
        repeating-linear-gradient(115deg, ${dark} 0 8%, transparent 8% 22%),
        repeating-linear-gradient(65deg, ${dark} 0 8%, transparent 8% 22%), ${light};`;
    case "plaid":
      return `background:
        repeating-linear-gradient(90deg, ${dark} 0 9%, transparent 9% 30%),
        repeating-linear-gradient(0deg, ${dark} 0 9%, transparent 9% 30%), ${light};`;
    case "splatter":
      return `background:
        radial-gradient(circle at 32% 34%, ${dark} 20%, transparent 21%),
        radial-gradient(circle at 66% 62%, ${dark} 16%, transparent 17%),
        radial-gradient(circle at 78% 26%, ${dark} 8%, transparent 9%),
        radial-gradient(circle at 22% 72%, ${dark} 7%, transparent 8%), ${light};`;
    case "carbon":
      return `background:
        linear-gradient(45deg, ${dark} 25%, transparent 25% 75%, ${dark} 75%) 0 0 / 30% 30%,
        linear-gradient(45deg, ${dark} 25%, transparent 25% 75%, ${dark} 75%) 15% 15% / 30% 30%, ${light};`;
    case "scales":
      return `background:
        radial-gradient(circle at 50% 0, transparent 40%, ${dark} 41% 52%, transparent 53%) 0 0 / 34% 26%,
        radial-gradient(circle at 50% 0, transparent 40%, ${dark} 41% 52%, transparent 53%) 17% 13% / 34% 26%, ${light};`;
    case "topo":
      return `background:
        radial-gradient(circle at 40% 45%, transparent 14%, ${dark} 15% 19%, transparent 20% 32%, ${dark} 33% 37%, transparent 38%),
        radial-gradient(circle at 74% 68%, transparent 10%, ${dark} 11% 15%, transparent 16%), ${light};`;
    case "shatter":
      return `background:
        conic-gradient(from 10deg at 45% 50%, ${dark} 0 22deg, ${light} 22deg 58deg,
          ${dark} 58deg 92deg, ${light} 92deg 150deg, ${dark} 150deg 195deg,
          ${light} 195deg 250deg, ${dark} 250deg 300deg, ${light} 300deg);`;
    case "aurora":
      return `background:
        linear-gradient(170deg, transparent 20%, ${dark} 34% 42%, transparent 56%),
        linear-gradient(190deg, transparent 40%, ${dark} 58% 66%, transparent 78%), ${light};`;
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

/* ---------- the upgrades tab ---------- */

function renderUpgrades() {
  const host = document.getElementById("shop-upgrades");
  if (!host) return;
  const acc = getAccount();
  if (!acc) {
    host.innerHTML = `<p class="shop-rank">Log in to earn XP and spend skill points.</p>`;
    return;
  }
  const alloc = getUpgrades();
  const level = getLevel();
  const info = getLevelInfo();
  const left = pointsLeft(alloc, level);
  const spent = pointsSpent(alloc);
  const tags = getTags();
  const pct = info.need === Infinity ? 100 : Math.round((info.into / info.need) * 100);

  const groups = UPGRADE_TREE.map((g) => `
    <section class="up-group">
      <h3 class="shop-group-head"><span>${g.name}</span></h3>
      <div class="up-rows">
        ${g.nodes.map((n) => {
          const key = `${g.id}.${n.id}`;
          const have = ranksIn(alloc, key);
          const full = have >= n.ranks;
          const can = canRank(alloc, key, level);
          const pips = Array.from({ length: n.ranks },
            (_, i) => `<i class="up-pip${i < have ? " on" : ""}"></i>`).join("");
          return `
            <div class="up-row${full ? " is-full" : ""}">
              <div class="up-info">
                <span class="up-name">${n.name}</span>
                <span class="up-effect">${n.fmt(n.per)} per rank${have ? ` · now ${n.fmt(have * n.per)}` : ""}</span>
              </div>
              <span class="up-pips" aria-label="${have} of ${n.ranks}">${pips}</span>
              <button class="btn btn-small up-buy" data-up="${key}"
                      ${can ? "" : "disabled"}>${full ? "MAX" : "+1"}</button>
            </div>`;
        }).join("")}
      </div>
    </section>`).join("");

  host.innerHTML = `
    <div class="up-head">
      <div class="up-level">
        <span class="up-lvl">LEVEL ${level}</span>
        <div class="up-bar"><i style="width:${pct}%"></i></div>
        <span class="up-xp">${info.need === Infinity
          ? `${getXp()} XP · max level`
          : `${info.into} / ${info.need} XP to level ${level + 1}`}</span>
      </div>
      <div class="up-points">
        <b>${left}</b><em>point${left === 1 ? "" : "s"} left</em>
      </div>
    </div>
    <p class="shop-rank">
      ${level >= MAX_SKILL_POINTS
        ? `All ${MAX_SKILL_POINTS} skill points earned — ${spent} of them spent across ${TOTAL_RANKS} possible ranks.`
        : `A skill point per level to level ${MAX_SKILL_POINTS}. XP comes from 1v1: 10 a kill, 25 a win.`}
    </p>
    <div class="up-reset-line">
      <button class="btn btn-small" id="up-reset" ${spent && tags >= RESET_COST ? "" : "disabled"}>
        RESET · 💀 ${RESET_COST}
      </button>
      <span class="hint">${spent ? `${spent} point${spent === 1 ? "" : "s"} allocated` : "nothing allocated yet"}</span>
    </div>
    ${groups}`;
}

/* ---------- wiring ---------- */

function refresh() {
  const tagsEl = document.getElementById("shop-tags");
  if (tagsEl) {
    const n = getTags();
    tagsEl.textContent = Number.isFinite(n) ? String(n) : "∞";
  }
  if (tab === "colours") renderColours();
  else if (tab === "upgrades") renderUpgrades();
  else renderPatterns();
}

function pickTab(which) {
  tab = which;
  for (const t of ["colours", "patterns", "upgrades"]) {
    document.getElementById(`shop-tab-${t}`)?.classList.toggle("is-on", which === t);
    const pane = document.getElementById(`shop-${t}`);
    if (pane) pane.hidden = which !== t;
  }
  const rankEl = document.getElementById("shop-rank");
  if (rankEl) rankEl.hidden = which !== "colours";
  refresh();
}

export function initShop() {
  // Where Back should go. The Shop is reachable from the menu, from a
  // custom lobby and from the local setup screen, and dumping someone
  // back at the menu from a lobby would quietly drop them out of it —
  // so remember where they came from and return them there.
  let cameFrom = "screen-menu";
  onEnter("screen-shop", (prev) => {
    if (prev && prev !== "screen-shop") cameFrom = prev;
    pickTab(tab);
  });
  document.getElementById("shop-back")?.addEventListener("click", () => {
    showScreen(cameFrom || "screen-menu");
  });

  document.getElementById("shop-tab-colours")?.addEventListener("click", () => pickTab("colours"));
  document.getElementById("shop-tab-patterns")?.addEventListener("click", () => pickTab("patterns"));
  document.getElementById("shop-tab-upgrades")?.addEventListener("click", () => pickTab("upgrades"));

  document.getElementById("shop-upgrades")?.addEventListener("click", async (e) => {
    const buy = e.target.closest("[data-up]");
    if (buy) {
      buy.disabled = true;
      try { await rankUpgrade(buy.dataset.up); refresh(); }
      catch (err) { toast(err?.message ?? "Couldn't spend that point."); buy.disabled = false; }
      return;
    }
    if (e.target.closest("#up-reset")) {
      const btn = e.target.closest("#up-reset");
      btn.disabled = true;
      try {
        await resetUpgrades();
        toast(`Skill points reset — ${RESET_COST} tags spent.`);
        refresh();
      } catch (err) { toast(err?.message ?? "Couldn't reset."); btn.disabled = false; }
    }
  });

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
