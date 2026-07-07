// ================================================================
// main.js — screen router + shared helpers (colors, tank icon, toast)
// ================================================================

import { initSettings } from "./settings.js";
import { initLocal } from "./local.js";
import { initOnline } from "./online.js";
import { initGame } from "./game.js";

export const COLORS = ["red", "green", "blue", "yellow"];
export const COLOR_NAMES = { red: "Red", green: "Green", blue: "Blue", yellow: "Yellow" };

/* ---------- screen router ---------- */

const hooks = { enter: {}, leave: {} };
let activeScreen = "screen-menu";

export function onEnter(id, fn) { (hooks.enter[id] ??= []).push(fn); }
export function onLeave(id, fn) { (hooks.leave[id] ??= []).push(fn); }

export function showScreen(id) {
  if (id === activeScreen) return;
  (hooks.leave[activeScreen] ?? []).forEach((fn) => fn());
  document.getElementById(activeScreen)?.classList.remove("is-active");

  activeScreen = id;
  const el = document.getElementById(id);
  el.classList.add("is-active");
  (hooks.enter[id] ?? []).forEach((fn) => fn());
  el.querySelector("[data-autofocus]")?.focus();
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
    <rect class="barrel" x="21.5" y="1"  width="5"  height="16" rx="2"/>
    <rect class="hull"   x="11"   y="12" width="26" height="26" rx="6"/>
    <circle class="turret" cx="24" cy="27" r="7.5"/>
  </svg>`;
}

/* ---------- boot ---------- */

function wireNavigation() {
  // Any element with data-go="screen-id" navigates there.
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
