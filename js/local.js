// ================================================================
// local.js — local battle setup.
//
// Humans join by pressing their SHOOT key (or tapping the card).
// Each open slot also has a bot chip: tap it to cycle
// off → Easy → Medium → Hard → off. Start needs at least 2 tanks
// total and at least 1 human — so you can play solo vs bots.
// ================================================================

import { onEnter, onLeave, COLORS, COLOR_NAMES, tankSVG } from "./main.js";
import { getBinds, keyLabel } from "./settings.js";
import { startLocalGame } from "./game.js";
import { AI_LEVELS } from "./ai.js";

const joined = new Set(); // human colors
const bots = { red: null, green: null, blue: null, yellow: null };
const BOT_CYCLE = [null, ...AI_LEVELS];

/* ---------- render ---------- */

function render() {
  const binds = getBinds();
  const host = document.getElementById("local-slots");

  host.innerHTML = COLORS.map((color) => {
    const isIn = joined.has(color);
    const bot = bots[color];
    const shoot = binds[color].shoot;

    const status = isIn ? "READY" : bot ? "BOT" : "OPEN";
    const prompt = isIn
      ? "Tap to leave"
      : bot
        ? "A bot drives this tank"
        : shoot
          ? `Press <b>${keyLabel(shoot)}</b><br>or tap to join`
          : "No shoot key set —<br>tap to join";

    return `
      <div class="slot p-${color} ${isIn ? "joined" : ""} ${bot ? "botted" : ""}"
           data-color="${color}" role="button" tabindex="0">
        ${tankSVG(color)}
        <span class="slot-name">${COLOR_NAMES[color]}</span>
        <span class="slot-status">${status}</span>
        <span class="slot-prompt">${prompt}</span>
        <button class="bot-chip" data-bot="${color}">
          ${bot ? "BOT · " + bot.toUpperCase() : "+ ADD BOT"}
        </button>
      </div>`;
  }).join("");

  // Bot chip cycles difficulty (and bumps any human off that slot).
  host.querySelectorAll(".bot-chip").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const color = btn.dataset.bot;
      bots[color] = BOT_CYCLE[(BOT_CYCLE.indexOf(bots[color]) + 1) % BOT_CYCLE.length];
      if (bots[color]) joined.delete(color);
      render();
    });
  });

  // Card tap toggles a human on that slot (and clears any bot).
  host.querySelectorAll(".slot").forEach((el) => {
    el.addEventListener("click", () => toggleHuman(el.dataset.color));
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter") toggleHuman(el.dataset.color);
    });
  });

  updateStart();
}

function updateStart() {
  const humans = joined.size;
  const total = humans + COLORS.filter((c) => bots[c]).length;

  document.getElementById("local-start").disabled = !(humans >= 1 && total >= 2);
  document.getElementById("local-hint").textContent =
    total < 2
      ? "Add at least 2 tanks — join yourself, and add bots to fill out the field."
      : humans < 1
        ? "At least 1 human is needed (bots won't fight for your honor alone)."
        : `${total} tanks ready${humans === 1 && total > 1 ? " — you vs the bots" : ""}.`;
}

/* ---------- joining ---------- */

function toggleHuman(color) {
  if (joined.has(color)) {
    joined.delete(color);
  } else {
    joined.add(color);
    bots[color] = null;
  }
  render();
}

function onKeydown(e) {
  const binds = getBinds();
  for (const color of COLORS) {
    if (binds[color].shoot === e.code) {
      e.preventDefault();
      if (!joined.has(color)) {
        joined.add(color);
        bots[color] = null;
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
    const specs = COLORS
      .filter((c) => joined.has(c) || bots[c])
      .map((c) => ({ color: c, bot: joined.has(c) ? null : bots[c] }));
    sessionStorage.setItem("tank.localPlayers", JSON.stringify(specs));
    startLocalGame(specs);
  });
}
