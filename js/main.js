// ================================================================
// main.js — screen router + shared helpers (colors, tank icon, toast)
// ================================================================

import { initSettings } from "./settings.js";
import { initLocal } from "./local.js";
import { initOnline } from "./online.js";
import { initGame } from "./game.js";
import { sfx, startMusic } from "./audio.js";
import { initSocial, setStatus, getAccount } from "./social.js";
import { initRanked } from "./ranked.js";
import { initChat, setPtt } from "./chat.js";
import { getPttKey } from "./settings.js";

// True while a match is running — screen hops (e.g. Settings mid-game)
// must not touch the soundtrack or presence.
let inMatch = false;
export function setInMatch(v) { inMatch = v; }
let settingsReturn = "screen-menu";

export {
  COLORS, SLOT_NAMES, PALETTE, PICKABLE, COLOR_NAMES, freeColor,
} from "./palette.js";
import { COLORS } from "./palette.js"; // used below for the menu row

/* ---------- screen router ---------- */

const hooks = { enter: {}, leave: {} };
let activeScreen = "screen-menu";

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
  (hooks.enter[id] ?? []).forEach((fn) => fn());
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

export function tankSVG(color) {
  return `<svg class="tank p-${color}" viewBox="0 0 48 48" aria-hidden="true">
    <rect class="tread"  x="5"    y="10" width="8"  height="30" rx="3"/>
    <rect class="tread"  x="35"   y="10" width="8"  height="30" rx="3"/>
    <rect class="barrel" x="20.5" y="1"  width="7"  height="16" rx="2.6"/>
    <rect class="hull"   x="11"   y="12" width="26" height="26" rx="6"/>
    <circle class="turret" cx="24" cy="27" r="7.5"/>
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
initLocal();
initOnline();
initGame();
initSocial();
initRanked();
initChat();

// Push-to-talk: hold the bound key to open the mic (ignored when
// typing in a text field). Works on any screen during a lobby.
window.addEventListener("keydown", (e) => {
  if (e.code === getPttKey() && !e.repeat) {
    const el = document.activeElement;
    if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) return;
    setPtt(true);
  }
});
window.addEventListener("keyup", (e) => {
  if (e.code === getPttKey()) setPtt(false);
});
