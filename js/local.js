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

import {
  onEnter, onLeave, COLORS, SLOT_NAMES, tankSVG,
} from "./main.js";
import { freeBotSkin } from "./skins.js";
import { getSkin } from "./social.js";
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
      <div class="slot p-${col} ${isHuman ? "joined" : ""} ${bot ? "botted" : ""}"
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
  });

  onLeave("screen-local", () => {});

  document.getElementById("local-start").addEventListener("click", () => {
    const specs = COLORS
      .filter((c) => active(c))
      .map((c) => ({ slot: c, color: paint[c], bot: c === HUMAN ? null : bots[c] }));
    sessionStorage.setItem("tank.localPlayers", JSON.stringify(specs));
    startLocalGame(specs);
  });
}
