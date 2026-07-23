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

// ELITE paint isn't rank-gated — it's LEADERBOARD-gated. This label is
// deliberately NOT in TIER_ORDER, so tierUnlocked() fails it closed and
// the only way to unlock it is the explicit top-50 check.
export const ELITE_TIER = "Top 50";
export const TOP50_CUTOFF = 50;

// The paint you start with, free, forever.
export const DEFAULT_SKIN = "red";

// Reserved: the Impossible AI's black. Never sold, never picked.
export const RESERVED_SKIN = "black";

export const SKINS = {
  // ---- the default: everyone starts here, costs nothing ----
  red: { name: "Red", hex: "#ff5147", tier: null, cost: 0, finish: "flat", fam: "base" },

  // ---- three more FREE defaults, each distinct from every other paint
  // in the game: they fill the gaps plain ROYGBIV leaves (lime between
  // yellow/green, cyan between green/blue, pink between violet/red), so a
  // full table can always be handed clash-free colours. ----
  lime: { name: "Lime", hex: "#88e01a", tier: null, cost: 0, finish: "flat", fam: "base" },
  cyan: { name: "Cyan", hex: "#10c2b8", tier: null, cost: 0, finish: "flat", fam: "base" },
  pink: { name: "Pink", hex: "#ff2e96", tier: null, cost: 0, finish: "flat", fam: "base" },

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

  // ---- Neon ROYGBIV — Diamond rank, 50 tags each ----
  neonRed: { name: "Neon Red", hex: "#ff1745", tier: "Diamond", cost: 50, finish: "flat", fam: "neon" },
  neonOrange: { name: "Neon Orange", hex: "#ff7a00", tier: "Diamond", cost: 50, finish: "flat", fam: "neon" },
  neonYellow: { name: "Neon Yellow", hex: "#f5ff00", tier: "Diamond", cost: 50, finish: "flat", fam: "neon" },
  neonGreen: { name: "Neon Green", hex: "#39ff14", tier: "Diamond", cost: 50, finish: "flat", fam: "neon" },
  neonBlue: { name: "Neon Blue", hex: "#00d5ff", tier: "Diamond", cost: 50, finish: "flat", fam: "neon" },
  neonIndigo: { name: "Neon Indigo", hex: "#4400ff", tier: "Diamond", cost: 50, finish: "flat", fam: "neon" },
  neonViolet: { name: "Neon Violet", hex: "#d400ff", tier: "Diamond", cost: 50, finish: "flat", fam: "neon" },

  // ---- the metals: one showpiece finish per rank ----
  copper: { name: "Copper", hex: "#b87333", tier: "Copper", cost: 50, finish: "metallic", fam: "metal" },
  silver: { name: "Silver", hex: "#aab4c4", tier: "Silver", cost: 100, finish: "reflective", fam: "metal" },
  gold: { name: "Gold", hex: "#ffcf40", tier: "Gold", cost: 150, finish: "shiny", fam: "metal" },
  platinum: { name: "Platinum", hex: "#9fe6d4", tier: "Platinum", cost: 200, finish: "metallic", fam: "metal" },
  diamond: { name: "Diamond", hex: "#a8ecff", tier: "Diamond", cost: 250, finish: "shinyReflective", fam: "metal" },

  // ---- ELITE: not a rank at all. Ruby is only sold to players sitting
  // in the world top 50, and it's the only paint whose lock can close
  // again — drop off the board and you keep what you bought, but the
  // shop stops selling it. Its finish is the richest in the game.
  ruby: {
    name: "Ruby", hex: "#e0115f", tier: ELITE_TIER, cost: 500,
    finish: "ruby", fam: "elite", elite: true,
  },

  // ---- reserved: the Impossible bot's paint, not for sale ----
  black: { name: "Black", hex: "#20242e", tier: null, cost: 0, finish: "flat", fam: "reserved", reserved: true },
};

// ---- PATTERNS ----------------------------------------------------
// A pattern is a two-tone design painted over the tank using TWO
// colours the player already owns. Like paint, each is gated behind a
// rank and a price. The renderer (drawTank) knows how to draw each id;
// this catalogue is just the economy + metadata.
export const PATTERNS = {
  solid: { name: "Solid", tier: null, cost: 0, colors: 1 },
  splotchy: { name: "Splotchy", tier: "Silver", cost: 40, colors: 2 },
  twoTone: { name: "Two Tone", tier: "Silver", cost: 40, colors: 2 },
  stripes: { name: "Racing Stripes", tier: "Silver", cost: 45, colors: 2 },
  camo: { name: "Camo", tier: "Gold", cost: 60, colors: 2 },
  hexScale: { name: "Hex Scale", tier: "Gold", cost: 65, colors: 2 },
  flames: { name: "Flames", tier: "Gold", cost: 70, colors: 2 },
  modernCamo: { name: "Modern Camo", tier: "Platinum", cost: 80, colors: 2 },
  circuit: { name: "Circuit", tier: "Platinum", cost: 85, colors: 2 },
  tiger: { name: "Tiger", tier: "Platinum", cost: 90, colors: 2 },
  lightning: { name: "Lightning", tier: "Diamond", cost: 100, colors: 2 },
  galaxy: { name: "Galaxy", tier: "Diamond", cost: 120, colors: 2 },
};

export const DEFAULT_PATTERN = "solid";

// Everything the shop lists, in catalogue order.
export const SHOP_PATTERNS = Object.keys(PATTERNS);

export function patternColors(id) {
  return (PATTERNS[id] ?? PATTERNS[DEFAULT_PATTERN]).colors ?? 1;
}


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

export function skinFinish(id) {
  return (SKINS[id] ?? SKINS[DEFAULT_SKIN]).finish ?? "flat";
}

// Is `tier` reached by someone whose current rank is `rankName`?
// NOTE: elite paint (Ruby) uses a tier that isn't in TIER_ORDER, so it
// always fails here — that's deliberate. Use isEliteSkin() + the
// caller's top-50 check to unlock it.
export function tierUnlocked(tier, rankName) {
  if (!tier) return true; // the default
  const need = TIER_ORDER.indexOf(tier);
  const have = TIER_ORDER.indexOf(rankName);
  return need >= 0 && have >= need;
}

// Leaderboard-gated paint (currently just Ruby).
export function isEliteSkin(id) {
  return !!(SKINS[id] ?? {}).elite;
}

// A random primary colour that nobody at the table is wearing.
export function freeBotSkin(taken) {
  const pool = BOT_SKINS.filter((id) => !taken.has(id));
  const from = pool.length ? pool : BOT_SKINS;
  return from[Math.floor(Math.random() * from.length)];
}
