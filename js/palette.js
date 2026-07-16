// ================================================================
// palette.js — control slots and the colour lookup the renderer uses.
//
// The paint CATALOGUE (what exists, what it costs, what rank it
// needs) lives in skins.js; this module just exposes it in the shape
// the rest of the game already expects. skins.js imports nothing, so
// there's no cycle to worry about.
// ================================================================

import { SKINS, DEFAULT_SKIN, freeBotSkin } from "./skins.js";

// The four CONTROL SLOTS (keybind seats). Slots are not colours.
export const COLORS = ["red", "green", "blue", "yellow"];
export const SLOT_NAMES = { red: "Player 1", green: "Player 2", blue: "Player 3", yellow: "Player 4" };

// id → hex, for the renderer.
export const PALETTE = Object.fromEntries(
  Object.entries(SKINS).map(([id, s]) => [id, s.hex]),
);

// id → display name.
export const COLOR_NAMES = Object.fromEntries(
  Object.entries(SKINS).map(([id, s]) => [id, s.name]),
);

// Nobody "picks" paint any more — it's bought in the shop and worn
// everywhere. Bots take a random primary that no player is wearing.
export function freeColor(taken) {
  return freeBotSkin(taken instanceof Set ? taken : new Set(taken ?? []));
}

export { DEFAULT_SKIN };
