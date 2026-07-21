// ================================================================
// local.js — OFFLINE battle setup.
//
// Offline is couch multiplayer vs the AI. Seat 1 starts with a human so
// the screen is never empty; every other player joins by pressing THEIR
// OWN fire key (each seat shows which key that is), which seats them
// instantly — even taking over a bot. The per-seat chip is only for
// adding/cycling a bot (off → tiers → off), or "LEAVE" on a human seat.
// Paint isn't picked here: you wear whatever you bought and equipped in
// the SHOP, and bots take random primaries that avoid it. Impossible
// bots are locked to black.
// ================================================================

import { onEnter, onLeave, COLORS, tankSVG, paintVar } from "./main.js";
import { PALETTE } from "./palette.js";
import { freeBotSkin, BOT_SKINS } from "./skins.js";
import { startLocalGame, GEAR_CAP_LIMIT } from "./game.js";
import { AI_LEVELS } from "./ai.js";
import { WEAPON_TYPES, WEAPON_LABEL } from "./weapons.js";
import { getBinds, keyLabel } from "./settings.js";
import { sfx } from "./audio.js";

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

// ---- seats -------------------------------------------------------
// Local play is couch multiplayer: up to FOUR people on one keyboard,
// plus bots in any spare seat. Every seat is one of:
//   "off"  — empty
//   "human"— a local player (uses that seat's keybinds)
//   <tier> — a bot at that difficulty
// Seat 1 starts as a human so the screen is never empty.
const SEATS = COLORS;                    // red, green, blue, yellow
const seat = { red: "human", green: "off", blue: "off", yellow: "off" };

// Shop paint and patterns do NOT carry into local play — everyone picks
// a primary colour here, and no two tanks at the table may share one.
const PICKABLE = BOT_SKINS.slice();      // the seven primaries
const paint = { red: "red", green: "green", blue: "blue", yellow: "yellow" };

// Chip cycle: off → each bot tier → off … A player is NEVER in this
// cycle any more — humans take a seat by pressing their own fire key
// (see wireJoinKeys), so the chip is purely for seating/cycling bots.
const SEAT_CYCLE = ["off", ...AI_LEVELS];

function isActive(slot) { return seat[slot] !== "off"; }
function isHumanSeat(slot) { return seat[slot] === "human"; }
function isBotSeat(slot) { return isActive(slot) && !isHumanSeat(slot); }
function humanCount() { return SEATS.filter(isHumanSeat).length; }

function takenColors(except) {
  const s = new Set();
  for (const slot of SEATS) {
    if (slot !== except && isActive(slot)) s.add(paint[slot]);
  }
  return s;
}

// Every active seat must hold a colour nobody else is using.
// Impossible bots are locked to black (their signature).
function ensurePaint(slot) {
  if (!isActive(slot)) return;
  if (seat[slot] === "impossible") { paint[slot] = "black"; return; }
  const taken = takenColors(slot);
  if (!paint[slot] || paint[slot] === "black" || taken.has(paint[slot])) {
    paint[slot] = PICKABLE.find((c) => !taken.has(c)) ?? freeBotSkin(taken);
  }
}

function ensureAllPaint() {
  // Humans first so they keep their pick and bots move aside.
  for (const slot of SEATS) if (isHumanSeat(slot)) ensurePaint(slot);
  for (const slot of SEATS) if (isBotSeat(slot)) ensurePaint(slot);
}

// Advance a seat's colour to the next free primary (wrapping).
function cyclePaint(slot) {
  if (!isActive(slot) || seat[slot] === "impossible") return;
  const taken = takenColors(slot);
  const from = PICKABLE.indexOf(paint[slot]);
  for (let i = 1; i <= PICKABLE.length; i++) {
    const c = PICKABLE[(from + i + PICKABLE.length) % PICKABLE.length];
    if (!taken.has(c)) { paint[slot] = c; return; }
  }
}

/* ---------- render ---------- */

const KEY_HINT = {
  red: "WASD · Space/E/Shift",
  green: "Arrows · / · . · ,",
  blue: "IJKL · U/O/P",
  yellow: "Numpad 8456 · 0/7/9",
};

function seatLabel(slot) {
  if (isHumanSeat(slot)) return `Player ${SEATS.indexOf(slot) + 1}`;
  if (isBotSeat(slot)) {
    const n = SEATS.filter(isBotSeat).indexOf(slot) + 1;
    return `Bot ${n}`;
  }
  return `Seat ${SEATS.indexOf(slot) + 1}`;
}

function render() {
  const host = document.getElementById("local-slots");

  host.innerHTML = SEATS.map((slot) => {
    const mode = seat[slot];
    const col = paint[slot];
    const human = isHumanSeat(slot);
    const bot = isBotSeat(slot);

    const status = human ? "PLAYER" : bot ? "BOT" : "OPEN";
    // On an empty seat, tell this player exactly which key seats them.
    const fireKey = keyLabel(getBinds()?.[slot]?.shoot);
    const prompt = human
      ? KEY_HINT[slot]
      : bot
        ? "A bot drives this tank"
        : `Press ${fireKey} to join · or add a bot`;

    // The chip only ever manages a BOT now. On a human seat it becomes a
    // "leave" button (drops the player back to an open seat); the player
    // can always rejoin by tapping their fire key again.
    const chipText = human
      ? "LEAVE"
      : mode === "off" ? "+ BOT" : "BOT · " + mode.toUpperCase();

    // Colour swatch doubles as the picker (locked for Impossible).
    const locked = mode === "impossible";
    const swatch = isActive(slot)
      ? `<button class="seat-colour ${locked ? "is-locked" : ""}"
                 data-colour="${slot}" ${locked ? "disabled" : ""}
                 title="${locked ? "Impossible bots are always black" : "Change colour"}">
           <span class="seat-chip" style="background:${PALETTE[col] ?? "#888"}"></span>
         </button>`
      : "";

    return `
      <div class="slot ${human ? "joined" : ""} ${bot ? "botted" : ""}"
           style="${paintVar(col ?? "red")}" data-slot="${slot}">
        ${tankSVG(col ?? "red")}
        <span class="slot-name">${seatLabel(slot)}</span>
        <span class="slot-status">${status}</span>
        <span class="slot-prompt">${prompt}</span>
        <div class="seat-row">
          <button class="bot-chip" data-seat="${slot}">${chipText}</button>
          ${swatch}
        </div>
      </div>`;
  }).join("");

  // The chip cycles the seat's BOT: off → bot tiers → off. A human seat
  // isn't in the cycle, so the first tap on one drops the player (→ off)
  // and the next begins the bot tiers — indexOf("human") is -1, so the
  // very same "next" step lands on "off" with no special-casing.
  host.querySelectorAll("[data-seat]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const slot = btn.dataset.seat;
      seat[slot] = SEAT_CYCLE[(SEAT_CYCLE.indexOf(seat[slot]) + 1) % SEAT_CYCLE.length];
      paint[slot] = null;      // fresh coat for the new occupant
      ensureAllPaint();
      render();
    });
  });

  // The swatch cycles this seat's colour through the free primaries.
  host.querySelectorAll("[data-colour]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      cyclePaint(btn.dataset.colour);
      render();
    });
  });

  updateStart();
}

/* ---------- join by fire key ---------- */

// Couch play joins the arcade way: a player takes an open (or bot) seat
// by tapping THAT seat's own fire key. No cycling through bot tiers to
// reach "player" any more — the seat flips straight to a human.
function seatPlayer(slot) {
  if (seat[slot] === "human") return false; // already in
  seat[slot] = "human";
  paint[slot] = null;      // fresh coat for the new occupant
  ensureAllPaint();
  render();
  sfx.pickup?.();
  return true;
}

// True when the key event is landing in a real text field, so a rebind or
// a typed character never doubles as a join. Range sliders / checkboxes
// don't consume typed keys, so a fire key still seats a player while one
// of those happens to be focused.
function typingInField(e) {
  const el = e.target;
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") {
    const type = (el.type || "text").toLowerCase();
    return !["range", "checkbox", "radio", "button", "submit", "reset", "color"].includes(type);
  }
  return false;
}

function onLocalFireKey(e) {
  if (e.repeat || typingInField(e)) return;
  const binds = getBinds();
  for (const slot of SEATS) {
    if (binds?.[slot]?.shoot !== e.code) continue;
    // It's a bound fire key: swallow it (so Space can't scroll the page
    // or click a focused chip) whether or not it changes anything.
    e.preventDefault();
    seatPlayer(slot);
    return;
  }
}

function updateStart() {
  const humans = humanCount();
  const bots = SEATS.filter(isBotSeat).length;
  const total = humans + bots;
  const ok = humans >= 1 && total >= 2;
  document.getElementById("local-start").disabled = !ok;
  document.getElementById("local-hint").textContent =
    humans < 1
      ? "Seat at least one player."
      : total < 2
        ? "Add another player or a bot to battle."
        : `${humans} player${humans > 1 ? "s" : ""}` +
          (bots ? ` vs ${bots} bot${bots > 1 ? "s" : ""}.` : " — free-for-all.");
}

/* ---------- init ---------- */

export function initLocal() {
  onEnter("screen-local", () => {
    ensureAllPaint(); // keep every seat on a free primary
    render();
    renderLocalSettings();
    // Listen (capture phase) so a fire key seats its player before any
    // focused control can react to it.
    window.addEventListener("keydown", onLocalFireKey, true);
  });

  onLeave("screen-local", () => {
    window.removeEventListener("keydown", onLocalFireKey, true);
  });

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
    // Local play uses the primaries picked here — shop paint and
    // patterns are an online/profile thing and don't carry over, so
    // everyone at the table reads clearly and nobody clashes.
    const specs = SEATS
      .filter(isActive)
      .map((c) => ({
        slot: c,
        color: paint[c],
        bot: isHumanSeat(c) ? null : seat[c],
        pattern: "solid",
        patColors: [],
      }));
    sessionStorage.setItem("tank.localPlayers", JSON.stringify(specs));
    startLocalGame(specs, localSettingsToOpts());
  });
}
