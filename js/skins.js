// ================================================================
// skins.js — the paint catalogue and the shop's economy.
//
// Import-free ON PURPOSE (same reason as palette.js): this is a leaf
// module, so anything may import it without risking a cycle.
//
// Paint is no longer picked per match — you buy it once in the SHOP
// with tags (skull coins, 1 per ranked kill) and wear it everywhere.
// Every colour past the default is gated behind a RANK as well as a
// price, so paint reads as a record of what you've actually done.
// ================================================================

// Rank gates, weakest first. A skin needs its tier REACHED to buy.
export const TIER_ORDER = ["Copper", "Silver", "Gold", "Platinum", "Diamond"];

// The paint you start with, free, forever.
export const DEFAULT_SKIN = "red";

// Reserved: the Impossible AI's black. Never sold, never picked.
export const RESERVED_SKIN = "black";

export const SKINS = {
  // ---- the default: everyone starts here, costs nothing ----
  red: { name: "Red", hex: "#ff5147", tier: null, cost: 0, finish: "flat", fam: "base" },

  // ---- Primary ROYGBIV — Copper rank, 10 tags each ----
  orange: { name: "Orange", hex: "#f3993f", tier: "Copper", cost: 10, finish: "flat", fam: "base" },
  yellow: { name: "Yellow", hex: "#f3d53f", tier: "Copper", cost: 10, finish: "flat", fam: "base" },
  green: { name: "Green", hex: "#3ff35d", tier: "Copper", cost: 10, finish: "flat", fam: "base" },
  blue: { name: "Blue", hex: "#3f99f3", tier: "Copper", cost: 10, finish: "flat", fam: "base" },
  indigo: { name: "Indigo", hex: "#5d3ff3", tier: "Copper", cost: 10, finish: "flat", fam: "base" },
  violet: { name: "Violet", hex: "#b73ff3", tier: "Copper", cost: 10, finish: "flat", fam: "base" },

  // ---- Dark ROYGBIV — Silver rank, 20 tags each ----
  darkRed: { name: "Dark Red", hex: "#951818", tier: "Silver", cost: 20, finish: "flat", fam: "dark" },
  darkOrange: { name: "Dark Orange", hex: "#955718", tier: "Silver", cost: 20, finish: "flat", fam: "dark" },
  darkYellow: { name: "Dark Yellow", hex: "#958018", tier: "Silver", cost: 20, finish: "flat", fam: "dark" },
  darkGreen: { name: "Dark Green", hex: "#18952d", tier: "Silver", cost: 20, finish: "flat", fam: "dark" },
  darkBlue: { name: "Dark Blue", hex: "#185795", tier: "Silver", cost: 20, finish: "flat", fam: "dark" },
  darkIndigo: { name: "Dark Indigo", hex: "#2d1895", tier: "Silver", cost: 20, finish: "flat", fam: "dark" },
  darkViolet: { name: "Dark Violet", hex: "#6c1895", tier: "Silver", cost: 20, finish: "flat", fam: "dark" },

  // ---- Light ROYGBIV — Gold rank, 30 tags each ----
  lightRed: { name: "Light Red", hex: "#f97171", tier: "Gold", cost: 30, finish: "flat", fam: "light" },
  lightOrange: { name: "Light Orange", hex: "#f9b571", tier: "Gold", cost: 30, finish: "flat", fam: "light" },
  lightYellow: { name: "Light Yellow", hex: "#f9e271", tier: "Gold", cost: 30, finish: "flat", fam: "light" },
  lightGreen: { name: "Light Green", hex: "#71f988", tier: "Gold", cost: 30, finish: "flat", fam: "light" },
  lightBlue: { name: "Light Blue", hex: "#71b5f9", tier: "Gold", cost: 30, finish: "flat", fam: "light" },
  lightIndigo: { name: "Light Indigo", hex: "#8871f9", tier: "Gold", cost: 30, finish: "flat", fam: "light" },
  lightViolet: { name: "Light Violet", hex: "#cc71f9", tier: "Gold", cost: 30, finish: "flat", fam: "light" },

  // ---- Pastel ROYGBIV — Platinum rank, 40 tags each ----
  pastelRed: { name: "Pastel Red", hex: "#e3b0b0", tier: "Platinum", cost: 40, finish: "flat", fam: "pastel" },
  pastelOrange: { name: "Pastel Orange", hex: "#e3c9b0", tier: "Platinum", cost: 40, finish: "flat", fam: "pastel" },
  pastelYellow: { name: "Pastel Yellow", hex: "#e3dbb0", tier: "Platinum", cost: 40, finish: "flat", fam: "pastel" },
  pastelGreen: { name: "Pastel Green", hex: "#b0e3b8", tier: "Platinum", cost: 40, finish: "flat", fam: "pastel" },
  pastelBlue: { name: "Pastel Blue", hex: "#b0c9e3", tier: "Platinum", cost: 40, finish: "flat", fam: "pastel" },
  pastelIndigo: { name: "Pastel Indigo", hex: "#b8b0e3", tier: "Platinum", cost: 40, finish: "flat", fam: "pastel" },
  pastelViolet: { name: "Pastel Violet", hex: "#d2b0e3", tier: "Platinum", cost: 40, finish: "flat", fam: "pastel" },

  // ---- Light Pastel ROYGBIV — Diamond rank, 50 tags each ----
  paleRed: { name: "Light Pastel Red", hex: "#ecd5d5", tier: "Diamond", cost: 50, finish: "flat", fam: "pale" },
  paleOrange: { name: "Light Pastel Orange", hex: "#ece0d5", tier: "Diamond", cost: 50, finish: "flat", fam: "pale" },
  paleYellow: { name: "Light Pastel Yellow", hex: "#ece8d5", tier: "Diamond", cost: 50, finish: "flat", fam: "pale" },
  paleGreen: { name: "Light Pastel Green", hex: "#d5ecd9", tier: "Diamond", cost: 50, finish: "flat", fam: "pale" },
  paleBlue: { name: "Light Pastel Blue", hex: "#d5e0ec", tier: "Diamond", cost: 50, finish: "flat", fam: "pale" },
  paleIndigo: { name: "Light Pastel Indigo", hex: "#d9d5ec", tier: "Diamond", cost: 50, finish: "flat", fam: "pale" },
  paleViolet: { name: "Light Pastel Violet", hex: "#e4d5ec", tier: "Diamond", cost: 50, finish: "flat", fam: "pale" },

  // ---- the metals: one showpiece finish per rank ----
  copper: { name: "Copper", hex: "#b87333", tier: "Copper", cost: 50, finish: "metallic", fam: "metal" },
  silver: { name: "Silver", hex: "#c8ced8", tier: "Silver", cost: 100, finish: "reflective", fam: "metal" },
  gold: { name: "Gold", hex: "#ffcf40", tier: "Gold", cost: 150, finish: "shiny", fam: "metal" },
  platinum: { name: "Platinum", hex: "#dfe4e8", tier: "Platinum", cost: 200, finish: "metallic", fam: "metal" },
  diamond: { name: "Diamond", hex: "#b9f2ff", tier: "Diamond", cost: 250, finish: "prismatic", fam: "metal" },

  // ---- reserved: the Impossible bot's paint, not for sale ----
  black: { name: "Black", hex: "#20242e", tier: null, cost: 0, finish: "flat", fam: "reserved", reserved: true },
};

// Bots take a randomized PRIMARY colour — never a metal, never a
// tinted variant, and (see freeBotSkin) never a colour a player wears.
export const BOT_SKINS = Object.keys(SKINS).filter(
  (id) => SKINS[id].fam === "base",
);

// Everything the shop lists, in catalogue order.
export const SHOP_SKINS = Object.keys(SKINS).filter((id) => !SKINS[id].reserved);

export function skinHex(id) {
  return (SKINS[id] ?? SKINS[DEFAULT_SKIN]).hex;
}

export function skinName(id) {
  return (SKINS[id] ?? SKINS[DEFAULT_SKIN]).name;
}

export function skinFinish(id) {
  return (SKINS[id] ?? SKINS[DEFAULT_SKIN]).finish ?? "flat";
}

// Is `tier` reached by someone whose current rank is `rankName`?
export function tierUnlocked(tier, rankName) {
  if (!tier) return true; // the default
  const need = TIER_ORDER.indexOf(tier);
  const have = TIER_ORDER.indexOf(rankName);
  return need >= 0 && have >= need;
}

// A random primary colour that nobody at the table is wearing.
export function freeBotSkin(taken) {
  const pool = BOT_SKINS.filter((id) => !taken.has(id));
  const from = pool.length ? pool : BOT_SKINS;
  return from[Math.floor(Math.random() * from.length)];
}
