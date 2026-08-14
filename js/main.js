// ================================================================
// main.js — screen router + shared helpers (colors, tank icon, toast)
// ================================================================

import { initSettings } from "./settings.js";
import { initShop } from "./shop.js";
import { initLocal } from "./local.js";
import { initOnline } from "./online.js";
import { initGame } from "./game.js";
import { sfx, startMusic } from "./audio.js";
import { initSocial, setStatus, getAccount } from "./social.js";
import { initDuel } from "./duel.js";
import { initChat } from "./chat.js";

// True while a match is running — screen hops (e.g. Settings mid-game)
// must not touch the soundtrack or presence.
let inMatch = false;
export function setInMatch(v) { inMatch = v; }
let settingsReturn = "screen-menu";

export {
  COLORS, SLOT_NAMES, PALETTE, COLOR_NAMES, freeColor,
} from "./palette.js";
// `export ... from` re-exports WITHOUT binding anything locally, so
// anything this module actually uses must be imported as well.
import { COLORS, PALETTE } from "./palette.js";
import { tankSpriteCanvas } from "./tanksprite.js";
import { DEFAULT_SKIN } from "./skins.js";

/* ---------- screen router ---------- */

const hooks = { enter: {}, leave: {} };
let activeScreen = "screen-menu";

// fn is called with the screen the player just left.
export function onEnter(id, fn) { (hooks.enter[id] ??= []).push(fn); }
export function onLeave(id, fn) { (hooks.leave[id] ??= []).push(fn); }

export function showScreen(id) {
  if (id === activeScreen) return;
  (hooks.leave[activeScreen] ?? []).forEach((fn) => fn());
  document.getElementById(activeScreen)?.classList.remove("is-active");

  const prevScreen = activeScreen;
  activeScreen = id;
  const el = document.getElementById(id);
  el.classList.add("is-active");
  // Enter hooks are told where the player came FROM, so a screen that
  // several places link to (the Shop) can send them back where they
  // were instead of always dropping them at the menu.
  (hooks.enter[id] ?? []).forEach((fn) => fn(prevScreen));
  el.querySelector("[data-autofocus]")?.focus();

  // The soundtrack follows the screen: menus get the title theme,
  // the lobby its own, and the game DJ (game.js) takes over in play.
  if (id === "screen-settings") settingsReturn = prevScreen ?? "screen-menu";

  if (!inMatch) {
    if (id === "screen-lobby") startMusic("lobby");
    else if (id !== "screen-game") startMusic("title");
  }

  // Presence roughly follows the screen (online.js reports lobby and
  // online rounds with more detail; local rounds count too). A quick
  // Settings hop mid-match doesn't change anything.
  if (!inMatch) {
    if (id === "screen-game") setStatus("round");
    else if (id !== "screen-lobby" && getAccount()) setStatus("online");
  }
}

/* ---------- toast ---------- */

let toastTimer = null;

export function toast(msg, ms = 3000) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), ms);
}

/* ---------- top-down tank icon (the recurring motif) ---------- */

// Blend a hex colour toward the dark base (matches the in-game shade).
function shade(hex, f) {
  const n = parseInt(String(hex ?? PALETTE[DEFAULT_SKIN]).slice(1), 16);
  const mix = (x, t) => Math.round(x + (t - x) * f);
  return `rgb(${mix((n >> 16) & 255, 16)}, ${mix((n >> 8) & 255, 19)}, ${mix(n & 255, 26)})`;
}

// The `--p` custom property for a paint id, as an inline style. The
// stylesheet only ships .p-<name> classes for the original handful of
// colours; the shop has forty, so callers set the variable directly.
export function paintVar(color) {
  return `--p:${PALETTE[color] ?? PALETTE[DEFAULT_SKIN]}`;
}

// A tank icon for a roster row, friend card, or invite list.
//
// `look` may be a plain colour id (the old signature) or the full
// { color, pattern, patColors } a player is actually wearing. It returns
// a PLACEHOLDER, because these are built inside template literals while
// the real sprite is a canvas — the observer below turns every
// placeholder into the same sprite the player drives, patterns and
// materials included. This used to draw a flat SVG that knew about a
// single hull colour only, so someone wearing Galaxy over Gold appeared
// in the lobby as a plain gold rectangle.
export function tankSVG(look) {
  const o = (look && typeof look === "object") ? look : { color: look };
  return `<span class="tank tank-icon" data-tank="${o.color ?? DEFAULT_SKIN}"
    data-tank-pat="${o.pattern ?? "solid"}"
    data-tank-pc="${Array.isArray(o.patColors) ? o.patColors.join(",") : ""}"
    aria-hidden="true"></span>`;
}

// Turn every placeholder inside `root` into a real sprite.
export function hydrateTankIcons(root, px = 34) {
  if (!root || !root.querySelectorAll) return;
  root.querySelectorAll(".tank-icon[data-tank]").forEach((el) => {
    if (el.__iconDone) return;
    el.__iconDone = true;
    const look = {
      color: el.dataset.tank,
      pattern: el.dataset.tankPat || "solid",
      patColors: el.dataset.tankPc ? el.dataset.tankPc.split(",") : [],
    };
    try {
      // Size the sprite to the box CSS actually gave it, rather than a
      // fixed 34 px. Everything here is a canvas, so a stylesheet change
      // alone could never make these bigger — the bitmap kept its own
      // hardcoded size and simply sat inside a larger element. Falling
      // back to `px` keeps every other icon exactly as it was.
      const box = el.getBoundingClientRect?.();
      const want = Math.round(Math.max(box?.width ?? 0, box?.height ?? 0)) || px;
      el.appendChild(tankSpriteCanvas(look, want, el.dataset.tank));
    } catch (e) {
      // Canvas unavailable: fall back to a flat swatch rather than a gap.
      el.style.background = PALETTE[look.color] ?? PALETTE[DEFAULT_SKIN];
    }
  });
}

// Hydrate automatically, wherever a placeholder appears.
//
// These icons are built inside template literals scattered across the
// social and lobby screens, so hooking every render site by hand would
// be tedious and easy to forget next time one is added. One observer on
// the document catches them all, including anything rendered later.
let iconObserver = null;
export function startTankIconHydration() {
  if (iconObserver || typeof MutationObserver === "undefined") return;
  const pass = () => hydrateTankIcons(document.body);
  iconObserver = new MutationObserver(() => {
    if (iconObserver.__queued) return;       // coalesce a render's worth
    iconObserver.__queued = true;
    queueMicrotask(() => { iconObserver.__queued = false; pass(); });
  });
  iconObserver.observe(document.body, { childList: true, subtree: true });
  pass();
}

// The old flat SVG, kept for anywhere a canvas can't be used.
export function tankSVGFlat(color) {
  const hull = PALETTE[color] ?? PALETTE[DEFAULT_SKIN];
  const light = shade(hull, -0.2);   // glacis (lighter)
  const dark = shade(hull, 0.34);    // engine deck (darker)
  const edge = shade(hull, 0.5);
  const chevron = shade(hull, -0.5);
  // Barrel + turret shades reuse the hull family.
  const barrel = shade(hull, 0.25);
  return `<svg class="tank" viewBox="0 0 48 48" aria-hidden="true">
    <!-- treads -->
    <rect x="4"  y="8" width="8" height="32" rx="3" fill="#2a303c"/>
    <rect x="36" y="8" width="8" height="32" rx="3" fill="#2a303c"/>
    <g stroke="#6b7488" stroke-width="1.6">
      <path d="M4 13h8 M4 19h8 M4 25h8 M4 31h8 M4 37h8"/>
      <path d="M36 13h8 M36 19h8 M36 25h8 M36 31h8 M36 37h8"/>
    </g>
    <!-- hull -->
    <rect x="10" y="9" width="28" height="30" rx="6" fill="${hull}"/>
    <!-- front glacis + nose chevron (top) -->
    <path d="M13 15 L35 15 L31 9 L17 9 Z" fill="${light}"/>
    <polyline points="17,13 24,9.5 31,13" fill="none" stroke="${edge}" stroke-width="1.4"/>
    <!-- rear engine deck + grille + exhausts (bottom) -->
    <rect x="14" y="31" width="20" height="8" rx="2" fill="${dark}"/>
    <g stroke="${chevron}" stroke-width="1.1">
      <path d="M17 33.5h14 M17 36h14"/>
    </g>
    <rect x="15" y="38" width="4" height="3" rx="1" fill="#3a3f4c"/>
    <rect x="29" y="38" width="4" height="3" rx="1" fill="#3a3f4c"/>
    <!-- Barrel and turret ride ON TOP of the hull, exactly as the game
         draws them: the barrel runs from the turret's centre out past
         the nose, and the turret ring caps its root. Drawing either of
         them before the hull buries the assembly. -->
    <rect x="21" y="1" width="6" height="24" rx="2.4" fill="${barrel}"/>
    <circle cx="24" cy="24" r="7.5" fill="${barrel}"/>
    <circle cx="24" cy="24" r="7.5" fill="none" stroke="${chevron}" stroke-width="1"/>
  </svg>`;
}

/* ---------- boot ---------- */

function wireNavigation() {
  // Any element with data-go="screen-id" navigates there.
  // Every button press ticks.
document.addEventListener("click", (e) => {
  if (e.target.closest("button, [role=button]")) sfx.click();
});

// Settings returns to WHEREVER it was opened from — including a game
// in progress (which keeps running underneath, unpaused).
document.getElementById("settings-back").addEventListener("click", () => {
  showScreen(settingsReturn);
});

// Long-press must never open the system callout / selection loupe.
document.addEventListener("contextmenu", (e) => e.preventDefault());

// Go truly fullscreen where the platform allows it (Android Chrome).
// iPhones can't fullscreen web pages — but Add to Home Screen runs
// the game standalone without the browser chrome.
let fsTried = false;
window.addEventListener("pointerdown", () => {
  if (fsTried || document.fullscreenElement) return;
  fsTried = true;
  document.documentElement.requestFullscreen?.({ navigationUI: "hide" })
    .then(() => screen.orientation?.lock?.("landscape").catch(() => {}))
    .catch(() => { screen.orientation?.lock?.("landscape").catch(() => {}); });
}, { once: false });

document.querySelectorAll("[data-go]").forEach((btn) => {
    btn.addEventListener("click", () => showScreen(btn.dataset.go));
  });

  // Esc acts as "back" on any screen that has a back button.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    document.querySelector(`#${activeScreen} .btn-back`)?.click();
  });
}

function renderMenuTanks() {
  document.getElementById("menu-tanks").innerHTML = COLORS.map(tankSVG).join("");
}

wireNavigation();
renderMenuTanks();
initSettings();
initShop();
initLocal();
initOnline();
initGame();
startTankIconHydration();
initSocial();
initDuel();
initChat();

// Push-to-talk: hold the bound key to open the mic (ignored when
// typing in a text field). Works on any screen during a lobby.
