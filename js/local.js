// ================================================================
// local.js — local battle setup.
// Players join by pressing their SHOOT key (or tapping the card
// on phones). Start unlocks at 2+ tanks.
// ================================================================

import { onEnter, onLeave, COLORS, COLOR_NAMES, tankSVG } from "./main.js";
import { getBinds, keyLabel } from "./settings.js";
import { startLocalGame } from "./game.js";

const joined = new Set();

/* ---------- render ---------- */

function render() {
  const binds = getBinds();
  const host = document.getElementById("local-slots");

  host.innerHTML = COLORS.map((color) => {
    const isIn = joined.has(color);
    const shoot = binds[color].shoot;
    const prompt = isIn
      ? "Tap to leave"
      : shoot
        ? `Press <b>${keyLabel(shoot)}</b><br>or tap to join`
        : "No shoot key set —<br>tap to join";

    return `
      <button class="slot p-${color} ${isIn ? "joined" : ""}" data-color="${color}">
        ${tankSVG(color)}
        <span class="slot-name">${COLOR_NAMES[color]}</span>
        <span class="slot-status">${isIn ? "READY" : "OPEN"}</span>
        <span class="slot-prompt">${prompt}</span>
      </button>`;
  }).join("");

  host.querySelectorAll(".slot").forEach((el) => {
    el.addEventListener("click", () => toggle(el.dataset.color));
  });

  document.getElementById("local-start").disabled = joined.size < 2;
  document.getElementById("local-hint").textContent =
    joined.size < 2
      ? "At least 2 tanks are needed to start."
      : `${joined.size} tanks ready.`;
}

/* ---------- joining ---------- */

function toggle(color) {
  joined.has(color) ? joined.delete(color) : joined.add(color);
  render();
}

function onKeydown(e) {
  const binds = getBinds();
  for (const color of COLORS) {
    if (binds[color].shoot === e.code) {
      e.preventDefault(); // Space/Enter would otherwise scroll or click
      if (!joined.has(color)) {
        joined.add(color);
        render();
      }
      return;
    }
  }
}

/* ---------- init ---------- */

export function initLocal() {
  onEnter("screen-local", () => {
    render();
    window.addEventListener("keydown", onKeydown);
  });

  onLeave("screen-local", () => {
    window.removeEventListener("keydown", onKeydown);
  });

  document.getElementById("local-start").addEventListener("click", () => {
    sessionStorage.setItem("tank.localPlayers", JSON.stringify([...joined]));
    startLocalGame([...joined]);
  });
}
