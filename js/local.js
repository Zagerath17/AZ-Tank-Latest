// ================================================================
// local.js — OFFLINE battle setup.
//
// Offline is strictly YOU vs the AI. Seat 1 is always the human
// player (WASD to drive, mouse to aim, left-click to fire); the
// other three seats can each hold a bot of a chosen difficulty.
// Each tank's paint is picked from the swatch strip; no two tanks
// may wear the same color. Impossible bots are locked to black.
// ================================================================

import {
  onEnter, onLeave, COLORS, SLOT_NAMES, COLOR_NAMES,
  PICKABLE, freeColor, tankSVG,
} from "./main.js";
import { setLastColor } from "./social.js";
import { startLocalGame } from "./game.js";
import { AI_LEVELS } from "./ai.js";

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

    // Paint strip: for the human always, and for any occupied bot seat.
    // Impossible bots are locked to black.
    let swatches = "";
    if (isHuman || bot) {
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

    // The human seat has no bot chip; bot seats cycle difficulty.
    const chip = isHuman
      ? ""
      : `<button class="bot-chip" data-bot="${slot}">
          ${bot ? "BOT · " + bot.toUpperCase() : "+ ADD BOT"}
        </button>`;

    return `
      <div class="slot p-${col} ${isHuman ? "joined" : ""} ${bot ? "botted" : ""}"
           data-slot="${slot}">
        ${tankSVG(col)}
        <span class="slot-name">${isHuman ? "You" : SLOT_NAMES[slot]}</span>
        <span class="slot-status">${status}</span>
        <span class="slot-prompt">${prompt}</span>
        ${chip}
        ${swatches}
      </div>`;
  }).join("");

  // Bot chip cycles difficulty (only on the three bot seats).
  host.querySelectorAll(".bot-chip").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const slot = btn.dataset.bot;
      const wasBot = !!bots[slot];
      bots[slot] = BOT_CYCLE[(BOT_CYCLE.indexOf(bots[slot]) + 1) % BOT_CYCLE.length];
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
    ensurePaint(HUMAN);
    render();
  });

  onLeave("screen-local", () => {});

  document.getElementById("local-start").addEventListener("click", () => {
    const specs = COLORS
      .filter((c) => active(c))
      .map((c) => ({ slot: c, color: paint[c], bot: c === HUMAN ? null : bots[c] }));
    sessionStorage.setItem("tank.localPlayers", JSON.stringify(specs));
    // Remember the human's paint on their account.
    setLastColor(paint[HUMAN]);
    startLocalGame(specs);
  });
}
