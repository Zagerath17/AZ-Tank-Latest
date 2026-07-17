// ================================================================
// local.js — OFFLINE battle setup.
//
// Offline is strictly YOU vs the AI. Seat 1 is always the human
// player (WASD to drive, mouse to aim, left-click to fire); the
// other three seats can each hold a bot of a chosen difficulty.
// Paint isn't picked here any more: you wear whatever you bought and
// equipped in the SHOP, and bots take random primaries that avoid it.
// Impossible bots are locked to black.
// ================================================================

import { onEnter, onLeave, COLORS, SLOT_NAMES, tankSVG, paintVar } from "./main.js";
import { freeBotSkin } from "./skins.js";
import { getSkin, getPattern, getPatternColors } from "./social.js";
import { startLocalGame, GEAR_CAP_LIMIT } from "./game.js";
import { AI_LEVELS } from "./ai.js";
import { WEAPON_TYPES, WEAPON_LABEL } from "./weapons.js";

/* ---------- offline match settings (same knobs as a custom lobby) ---------- */

const SIZE_KEYS = ["small", "medium", "large", "xl"];
const SIZE_LABEL = { small: "Small", medium: "Medium", large: "Large", xl: "Extra large" };
const LS_LOCAL_SET = "tank.localSettings.v1";

function defaultLocalSettings() {
  const gear = {};
  for (const w of WEAPON_TYPES) gear[w] = true;
  const sizes = {};
  for (const k of SIZE_KEYS) sizes[k] = true;
  return { sizes, gear, gearMax: 24, zone: false, zoneSec: 30 };
}

// Load saved offline settings, normalised so a partial/old blob can't
// break the setup screen.
function loadLocalSettings() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(LS_LOCAL_SET) || "{}") ?? {}; } catch { saved = {}; }
  const d = defaultLocalSettings();
  const sizes = {};
  for (const k of SIZE_KEYS) sizes[k] = saved.sizes?.[k] ?? d.sizes[k];
  const gear = {};
  for (const w of WEAPON_TYPES) gear[w] = saved.gear?.[w] ?? d.gear[w];
  const gearMax = Math.max(1, Math.min(GEAR_CAP_LIMIT, saved.gearMax ?? d.gearMax));
  const zone = saved.zone ?? d.zone;
  const zoneSec = Math.max(10, Math.min(60, saved.zoneSec ?? d.zoneSec));
  return { sizes, gear, gearMax, zone, zoneSec };
}

let localSettings = loadLocalSettings();
function saveLocalSettings() {
  try { localStorage.setItem(LS_LOCAL_SET, JSON.stringify(localSettings)); } catch { /* ignore */ }
}

// Turn the settings into the opts startLocalGame expects.
function localSettingsToOpts() {
  const s = localSettings;
  const sizePool = SIZE_KEYS.filter((k) => s.sizes[k]);
  const gearPool = WEAPON_TYPES.filter((w) => s.gear[w]);
  return {
    sizePool: sizePool.length ? sizePool : SIZE_KEYS,
    gearPool, // empty = no pickups this match
    gearMax: s.gearMax,
    zone: s.zone,
    zonePeriod: s.zoneSec,
  };
}

// Paint the offline settings panel from `localSettings` and wire the
// controls. Every edit updates the object, saves it, and repaints.
function renderLocalSettings() {
  const s = localSettings;

  const sizesEl = document.getElementById("loc-set-sizes");
  if (sizesEl) {
    sizesEl.innerHTML = SIZE_KEYS.map((k) => `
      <button class="btn btn-small set-chip ${s.sizes[k] ? "is-on" : ""}"
              data-size="${k}" type="button">${SIZE_LABEL[k]}</button>`).join("");
    sizesEl.querySelectorAll("[data-size]").forEach((b) => {
      b.addEventListener("click", () => {
        const k = b.dataset.size;
        const next = !s.sizes[k];
        if (!next && !SIZE_KEYS.some((x) => x !== k && s.sizes[x])) {
          document.getElementById("local-hint").textContent = "Keep at least one map size.";
          return;
        }
        s.sizes[k] = next; saveLocalSettings(); renderLocalSettings();
      });
    });
  }

  const gearEl = document.getElementById("loc-set-gear");
  if (gearEl) {
    gearEl.innerHTML = WEAPON_TYPES.map((w) => `
      <button class="btn btn-small set-chip ${s.gear[w] ? "is-on" : ""}"
              data-gear="${w}" type="button">${WEAPON_LABEL[w] ?? w}</button>`).join("");
    gearEl.querySelectorAll("[data-gear]").forEach((b) => {
      b.addEventListener("click", () => {
        s.gear[b.dataset.gear] = !s.gear[b.dataset.gear];
        saveLocalSettings(); renderLocalSettings();
      });
    });
  }

  const slider = document.getElementById("loc-set-max");
  const valEl = document.getElementById("loc-set-max-val");
  if (slider && valEl) {
    slider.max = String(GEAR_CAP_LIMIT);
    slider.value = String(s.gearMax);
    valEl.textContent = String(s.gearMax);
    slider.oninput = () => { valEl.textContent = slider.value; };
    slider.onchange = () => {
      s.gearMax = Math.max(1, Math.min(GEAR_CAP_LIMIT, +slider.value));
      saveLocalSettings();
    };
  }

  const zoneChip = document.getElementById("loc-set-zone");
  if (zoneChip) {
    zoneChip.classList.toggle("is-on", s.zone);
    zoneChip.textContent = s.zone ? "ZONE: ON" : "ZONE: OFF";
    zoneChip.onclick = () => { s.zone = !s.zone; saveLocalSettings(); renderLocalSettings(); };
  }
  const zoneRow = document.getElementById("loc-set-zone-timer");
  if (zoneRow) zoneRow.hidden = !s.zone;
  const zSlider = document.getElementById("loc-set-zone-sec");
  const zVal = document.getElementById("loc-set-zone-val");
  if (zSlider && zVal) {
    zSlider.value = String(s.zoneSec);
    zVal.textContent = `${s.zoneSec}s`;
    zSlider.oninput = () => { zVal.textContent = `${zSlider.value}s`; };
    zSlider.onchange = () => {
      s.zoneSec = Math.max(10, Math.min(60, +zSlider.value));
      saveLocalSettings();
    };
  }

  const on = WEAPON_TYPES.filter((w) => s.gear[w]).length;
  const note = document.getElementById("loc-set-note");
  if (note) note.textContent = on ? "" : "No abilities selected — this match spawns no pickups.";
}

const HUMAN = COLORS[0];           // seat 1 is always the human ("You")
const BOT_SEATS = COLORS.slice(1); // the rest can hold bots
const bots = { green: null, blue: null, yellow: null };
const paint = { red: "red", green: "green", blue: "blue", yellow: "yellow" };

const BOT_CYCLE = [null, ...AI_LEVELS];

function active(slot) {
  return slot === HUMAN || !!bots[slot];
}

function takenColors(except) {
  const s = new Set();
  for (const slot of COLORS) {
    if (slot !== except && active(slot)) s.add(paint[slot]);
  }
  return s;
}

// The human always wears their equipped shop paint. Bots take a
// random primary that nobody at the table is wearing — re-rolled only
// when their current one would clash. Impossible is locked to black.
function ensurePaint(slot) {
  if (slot === HUMAN) { paint[slot] = getSkin(); return; }
  if (bots[slot] === "impossible") { paint[slot] = "black"; return; }
  if (!bots[slot]) { paint[slot] = null; return; }
  const taken = takenColors(slot);
  if (!paint[slot] || paint[slot] === "black" || taken.has(paint[slot])) {
    paint[slot] = freeBotSkin(taken);
  }
}

// Repaint every seat, human first so the bots dodge the player.
function ensureAllPaint() {
  ensurePaint(HUMAN);
  for (const slot of BOT_SEATS) ensurePaint(slot);
}

/* ---------- render ---------- */

function render() {
  const host = document.getElementById("local-slots");

  host.innerHTML = COLORS.map((slot) => {
    const isHuman = slot === HUMAN;
    const bot = bots[slot];
    const col = paint[slot];

    const status = isHuman ? "YOU" : bot ? "BOT" : "OPEN";
    const prompt = isHuman
      ? "WASD · mouse · LMB/RMB/Shift"
      : bot
        ? "A bot drives this tank"
        : "Add a bot to fill this seat";

    // The human seat has no bot chip; bot seats cycle difficulty.
    const chip = isHuman
      ? ""
      : `<button class="bot-chip" data-bot="${slot}">
          ${bot ? "BOT · " + bot.toUpperCase() : "+ ADD BOT"}
        </button>`;

    return `
      <div class="slot ${isHuman ? "joined" : ""} ${bot ? "botted" : ""}" style="${paintVar(col)}"
           data-slot="${slot}">
        ${tankSVG(col)}
        <span class="slot-name">${isHuman ? "You" : SLOT_NAMES[slot]}</span>
        <span class="slot-status">${status}</span>
        <span class="slot-prompt">${prompt}</span>
        ${chip}
      </div>`;
  }).join("");

  // Bot chip cycles difficulty (only on the three bot seats).
  host.querySelectorAll(".bot-chip").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const slot = btn.dataset.bot;
      bots[slot] = BOT_CYCLE[(BOT_CYCLE.indexOf(bots[slot]) + 1) % BOT_CYCLE.length];
      paint[slot] = null;  // fresh coat for the new occupant
      ensureAllPaint();
      render();
    });
  });

  updateStart();
}

function updateStart() {
  const botCount = BOT_SEATS.filter((c) => bots[c]).length;
  document.getElementById("local-start").disabled = botCount < 1;
  document.getElementById("local-hint").textContent =
    botCount < 1
      ? "Add at least 1 bot to battle against."
      : `You vs ${botCount} bot${botCount > 1 ? "s" : ""}.`;
}

/* ---------- init ---------- */

export function initLocal() {
  onEnter("screen-local", () => {
    ensureAllPaint(); // picks up any paint swapped in the shop since
    render();
    renderLocalSettings();
  });

  onLeave("screen-local", () => {});

  // Collapsible settings header (mirrors the custom-lobby panel).
  const setToggle = document.getElementById("loc-settings-toggle");
  setToggle?.addEventListener("click", () => {
    const body = document.getElementById("loc-settings-body");
    const caret = document.getElementById("loc-settings-caret");
    if (!body) return;
    body.hidden = !body.hidden;
    if (caret) caret.textContent = body.hidden ? "▾" : "▴";
  });
  document.getElementById("loc-set-gear-all")?.addEventListener("click", () => {
    for (const w of WEAPON_TYPES) localSettings.gear[w] = true;
    saveLocalSettings(); renderLocalSettings();
  });
  document.getElementById("loc-set-gear-none")?.addEventListener("click", () => {
    for (const w of WEAPON_TYPES) localSettings.gear[w] = false;
    saveLocalSettings(); renderLocalSettings();
  });

  document.getElementById("local-start").addEventListener("click", () => {
    const specs = COLORS
      .filter((c) => active(c))
      .map((c) => ({
        slot: c,
        color: paint[c],
        bot: c === HUMAN ? null : bots[c],
        // Only the human carries a bought pattern; bots run solid.
        pattern: c === HUMAN ? getPattern() : "solid",
        patColors: c === HUMAN ? getPatternColors() : [],
      }));
    sessionStorage.setItem("tank.localPlayers", JSON.stringify(specs));
    startLocalGame(specs, localSettingsToOpts());
  });
}
