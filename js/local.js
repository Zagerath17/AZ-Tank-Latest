// ================================================================
// local.js — local battle setup.
//
// Humans join by pressing their SHOOT key (or tapping the card).
// Each slot is a CONTROL SEAT (Player 1–4); the tank's paint is
// picked separately from the swatch strip. No two tanks can wear
// the same color. Impossible bots are locked to black.
// ================================================================

import {
  onEnter, onLeave, COLORS, SLOT_NAMES, COLOR_NAMES,
  PICKABLE, freeColor, tankSVG,
} from "./main.js";
import { getBinds, keyLabel } from "./settings.js";
import { setLastColor } from "./social.js";
import { startLocalGame } from "./game.js";
import { AI_LEVELS } from "./ai.js";

const joined = new Set(); // slots with a human in the seat
const bots = { red: null, green: null, blue: null, yellow: null };
const paint = { red: "red", green: "green", blue: "blue", yellow: "yellow" };
const BOT_CYCLE = [null, ...AI_LEVELS];

function active(slot) {
  return joined.has(slot) || !!bots[slot];
}

function takenColors(except) {
  const s = new Set();
  for (const slot of COLORS) {
    if (slot !== except && active(slot)) s.add(paint[slot]);
  }
  return s;
}

// Give a slot a legal color: keep its current pick if free, else the
// classic slot color, else something random that nobody wears.
function ensurePaint(slot) {
  if (bots[slot] === "impossible") { paint[slot] = "black"; return; }
  const taken = takenColors(slot);
  if (paint[slot] === "black" || taken.has(paint[slot])) {
    paint[slot] = !taken.has(slot) ? slot : freeColor(taken);
  }
}

/* ---------- render ---------- */

function render() {
  const binds = getBinds();
  const host = document.getElementById("local-slots");

  host.innerHTML = COLORS.map((slot) => {
    const isIn = joined.has(slot);
    const bot = bots[slot];
    const shoot = binds[slot].shoot;
    const col = paint[slot];

    const status = isIn ? "READY" : bot ? "BOT" : "OPEN";
    const prompt = isIn
      ? "Tap to leave"
      : bot
        ? "A bot drives this tank"
        : shoot
          ? `Press <b>${keyLabel(shoot)}</b><br>or tap to join`
          : "No shoot key set —<br>tap to join";

    // Paint strip: only for occupied seats. Impossible = locked black.
    let swatches = "";
    if (isIn || bot) {
      if (bot === "impossible") {
        swatches = `<div class="swatches"><span class="swatch-lock">LOCKED · BLACK</span></div>`;
      } else {
        const taken = takenColors(slot);
        swatches = `<div class="swatches">` + PICKABLE.map((c) => `
          <button class="swatch p-${c} ${c === col ? "sel" : ""}"
                  data-paint="${slot}" data-color="${c}"
                  ${taken.has(c) ? "disabled" : ""}
                  aria-label="${COLOR_NAMES[c]}"></button>`).join("") + `</div>`;
      }
    }

    return `
      <div class="slot p-${col} ${isIn ? "joined" : ""} ${bot ? "botted" : ""}"
           data-slot="${slot}" role="button" tabindex="0">
        ${tankSVG(col)}
        <span class="slot-name">${SLOT_NAMES[slot]}</span>
        <span class="slot-status">${status}</span>
        <span class="slot-prompt">${prompt}</span>
        <button class="bot-chip" data-bot="${slot}">
          ${bot ? "BOT · " + bot.toUpperCase() : "+ ADD BOT"}
        </button>
        ${swatches}
      </div>`;
  }).join("");

  // Bot chip cycles difficulty (and bumps any human off that seat).
  host.querySelectorAll(".bot-chip").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const slot = btn.dataset.bot;
      const wasBot = !!bots[slot];
      bots[slot] = BOT_CYCLE[(BOT_CYCLE.indexOf(bots[slot]) + 1) % BOT_CYCLE.length];
      if (bots[slot]) joined.delete(slot);
      if (bots[slot] && !wasBot) {
        // Fresh bot: grab a random color nobody's wearing.
        paint[slot] = freeColor(takenColors(slot));
      }
      ensurePaint(slot);
      render();
    });
  });

  // Swatch tap repaints the tank (unless someone else wears it).
  host.querySelectorAll(".swatch").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const slot = btn.dataset.paint;
      const c = btn.dataset.color;
      if (takenColors(slot).has(c)) return;
      paint[slot] = c;
      render();
    });
  });

  // Card tap toggles a human on that seat (and clears any bot).
  host.querySelectorAll(".slot").forEach((el) => {
    el.addEventListener("click", () => toggleHuman(el.dataset.slot));
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter") toggleHuman(el.dataset.slot);
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

function toggleHuman(slot) {
  if (joined.has(slot)) {
    joined.delete(slot);
  } else {
    joined.add(slot);
    bots[slot] = null;
    ensurePaint(slot);
  }
  render();
}

function onKeydown(e) {
  const binds = getBinds();
  for (const slot of COLORS) {
    if (binds[slot].shoot === e.code) {
      e.preventDefault();
      if (!joined.has(slot)) {
        joined.add(slot);
        bots[slot] = null;
        ensurePaint(slot);
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
      .map((c) => ({ slot: c, color: paint[c], bot: joined.has(c) ? null : bots[c] }));
    sessionStorage.setItem("tank.localPlayers", JSON.stringify(specs));
    // Remember the first human's paint on their account.
    const firstHuman = specs.find((s) => !s.bot);
    if (firstHuman) setLastColor(firstHuman.color);
    startLocalGame(specs);
  });
}
