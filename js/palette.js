// ================================================================
// palette.js — colors, slots, and names. Deliberately import-free:
// game.js and main.js import each other, and module-level constants
// must live OUTSIDE that cycle or they hit the temporal dead zone.
// ================================================================

// The four CONTROL SLOTS (keybind seats). Slots are not colors any
// more — every tank picks its paint separately.
export const COLORS = ["red", "green", "blue", "yellow"];
export const SLOT_NAMES = { red: "Player 1", green: "Player 2", blue: "Player 3", yellow: "Player 4" };

// The full paint shop. "black" exists but is reserved: it belongs to
// the Impossible AI and can never be picked by anyone else.
export const PALETTE = {
  red: "#ff5147", green: "#46d160", blue: "#47a3ff", yellow: "#ffc531",
  orange: "#f5820b", purple: "#9a5ce6", pink: "#f26fb1", cyan: "#22c3e6",
  lime: "#a3d21c", teal: "#16a985", magenta: "#cf3fd1", brown: "#a4713a",
  slate: "#7e8ba3", mint: "#4fdca4", crimson: "#c2183c", navy: "#3550c2",
  black: "#20242e",
};
export const PICKABLE = Object.keys(PALETTE).filter((c) => c !== "black");
export const COLOR_NAMES = {
  red: "Red", green: "Green", blue: "Blue", yellow: "Yellow",
  orange: "Orange", purple: "Purple", pink: "Pink", cyan: "Cyan",
  lime: "Lime", teal: "Teal", magenta: "Magenta", brown: "Brown",
  slate: "Slate", mint: "Mint", crimson: "Crimson", navy: "Navy",
  black: "Black",
};

// Pick a random color that nobody at the table is using.
export function freeColor(taken, allowBlack = false) {
  const pool = (allowBlack ? Object.keys(PALETTE) : PICKABLE).filter((c) => !taken.has(c));
  return pool[Math.floor(Math.random() * pool.length)] ?? "slate";
}
