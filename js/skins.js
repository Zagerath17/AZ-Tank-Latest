// ================================================================
// skins.js — the paint catalogue and the shop's economy.
//
// Import-free ON PURPOSE (same reason as palette.js): this is a leaf
// module, so anything may import it without risking a cycle.
//
// Paint is bought once with tags (skull coins, one per kill) and worn
// everywhere. Nothing is gated behind a rating any more — what gates a
// colour is the colour BEFORE it. Every shade is the next step along
// its own hue:
//
//   red → dark red → light red → pastel red → neon red
//
// Red is yours from the start, so dark red is open immediately; blue
// has to be bought before dark blue is, and so on down each hue. A
// SPECIAL (the materials) unlocks once you own every colour in its
// family, and Ruby — the last thing in the shop — once you own every
// other colour in the game.
// ================================================================

// The families, weakest first. Position in this list IS the
// progression: a colour's prerequisite is the same hue one family back.
export const FAMILY_ORDER = ["base", "dark", "light", "pastel", "neon", "mono"];

export const FAMILY_LABEL = {
  base: "Primaries",
  dark: "Dark",
  light: "Light",
  pastel: "Pastel",
  neon: "Neon",
  mono: "Greyscale",
};

// The same families as an adjective, for sentences like "Own every
// primary colour" — FAMILY_LABEL is a shelf heading and reads wrong
// dropped mid-sentence.
const FAMILY_ADJ = {
  base: "primary",
  dark: "dark",
  light: "light",
  pastel: "pastel",
  neon: "neon",
  mono: "greyscale",
};

// The paint you start with, free, forever.
export const DEFAULT_SKIN = "red";

// Reserved: the Impossible AI's black. Never sold, never picked.
export const RESERVED_SKIN = "black";

export const SKINS = {
  // ---- the default: everyone starts here, costs nothing ----
  red: { name: "Red", hex: "#ff5147", cost: 0, finish: "flat", fam: "base", hue: "red" },

  // ---- three more FREE primaries, each distinct from every other
  // paint in the game: they fill the gaps plain ROYGBIV leaves (lime
  // between yellow/green, cyan between green/blue, pink between
  // violet/red), so a full table can always be handed clash-free
  // colours. Being free they're owned from the start, which is why
  // Bronze only ever asks for the six you actually have to buy. ----
  lime: { name: "Lime", hex: "#88e01a", cost: 0, finish: "flat", fam: "base", hue: "lime" },
  cyan: { name: "Cyan", hex: "#10c2b8", cost: 0, finish: "flat", fam: "base", hue: "cyan" },
  pink: { name: "Pink", hex: "#ff2e96", cost: 0, finish: "flat", fam: "base", hue: "pink" },

  // ---- Primary ROYGBIV — 10 tags each, open from the start ----
  orange: { name: "Orange", hex: "#f3993f", cost: 10, finish: "flat", fam: "base", hue: "orange" },
  yellow: { name: "Yellow", hex: "#f3d53f", cost: 10, finish: "flat", fam: "base", hue: "yellow" },
  green: { name: "Green", hex: "#3ff35d", cost: 10, finish: "flat", fam: "base", hue: "green" },
  blue: { name: "Blue", hex: "#3f99f3", cost: 10, finish: "flat", fam: "base", hue: "blue" },
  indigo: { name: "Indigo", hex: "#5d3ff3", cost: 10, finish: "flat", fam: "base", hue: "indigo" },
  violet: { name: "Violet", hex: "#b73ff3", cost: 10, finish: "flat", fam: "base", hue: "violet" },

  // ---- Dark ROYGBIV — 20 tags each, needs the primary of that hue ----
  darkRed: { name: "Dark Red", hex: "#951818", cost: 20, finish: "flat", fam: "dark", hue: "red" },
  darkOrange: { name: "Dark Orange", hex: "#955718", cost: 20, finish: "flat", fam: "dark", hue: "orange" },
  darkYellow: { name: "Dark Yellow", hex: "#958018", cost: 20, finish: "flat", fam: "dark", hue: "yellow" },
  darkGreen: { name: "Dark Green", hex: "#18952d", cost: 20, finish: "flat", fam: "dark", hue: "green" },
  darkBlue: { name: "Dark Blue", hex: "#185795", cost: 20, finish: "flat", fam: "dark", hue: "blue" },
  darkIndigo: { name: "Dark Indigo", hex: "#2d1895", cost: 20, finish: "flat", fam: "dark", hue: "indigo" },
  darkViolet: { name: "Dark Violet", hex: "#6c1895", cost: 20, finish: "flat", fam: "dark", hue: "violet" },

  // ---- Light ROYGBIV — 30 tags each, needs the dark of that hue ----
  lightRed: { name: "Light Red", hex: "#f97171", cost: 30, finish: "flat", fam: "light", hue: "red" },
  lightOrange: { name: "Light Orange", hex: "#f9b571", cost: 30, finish: "flat", fam: "light", hue: "orange" },
  lightYellow: { name: "Light Yellow", hex: "#f9e271", cost: 30, finish: "flat", fam: "light", hue: "yellow" },
  lightGreen: { name: "Light Green", hex: "#71f988", cost: 30, finish: "flat", fam: "light", hue: "green" },
  lightBlue: { name: "Light Blue", hex: "#71b5f9", cost: 30, finish: "flat", fam: "light", hue: "blue" },
  lightIndigo: { name: "Light Indigo", hex: "#8871f9", cost: 30, finish: "flat", fam: "light", hue: "indigo" },
  lightViolet: { name: "Light Violet", hex: "#cc71f9", cost: 30, finish: "flat", fam: "light", hue: "violet" },

  // ---- Pastel ROYGBIV — 40 tags each, needs the light of that hue ----
  pastelRed: { name: "Pastel Red", hex: "#e3b0b0", cost: 40, finish: "flat", fam: "pastel", hue: "red" },
  pastelOrange: { name: "Pastel Orange", hex: "#e3c9b0", cost: 40, finish: "flat", fam: "pastel", hue: "orange" },
  pastelYellow: { name: "Pastel Yellow", hex: "#e3dbb0", cost: 40, finish: "flat", fam: "pastel", hue: "yellow" },
  pastelGreen: { name: "Pastel Green", hex: "#b0e3b8", cost: 40, finish: "flat", fam: "pastel", hue: "green" },
  pastelBlue: { name: "Pastel Blue", hex: "#b0c9e3", cost: 40, finish: "flat", fam: "pastel", hue: "blue" },
  pastelIndigo: { name: "Pastel Indigo", hex: "#b8b0e3", cost: 40, finish: "flat", fam: "pastel", hue: "indigo" },
  pastelViolet: { name: "Pastel Violet", hex: "#d2b0e3", cost: 40, finish: "flat", fam: "pastel", hue: "violet" },

  // ---- Neon ROYGBIV — 50 tags each, needs the pastel of that hue ----
  neonRed: { name: "Neon Red", hex: "#ff1745", cost: 50, finish: "flat", fam: "neon", hue: "red" },
  neonOrange: { name: "Neon Orange", hex: "#ff7a00", cost: 50, finish: "flat", fam: "neon", hue: "orange" },
  neonYellow: { name: "Neon Yellow", hex: "#f5ff00", cost: 50, finish: "flat", fam: "neon", hue: "yellow" },
  neonGreen: { name: "Neon Green", hex: "#39ff14", cost: 50, finish: "flat", fam: "neon", hue: "green" },
  neonBlue: { name: "Neon Blue", hex: "#00d5ff", cost: 50, finish: "flat", fam: "neon", hue: "blue" },
  neonIndigo: { name: "Neon Indigo", hex: "#4400ff", cost: 50, finish: "flat", fam: "neon", hue: "indigo" },
  neonViolet: { name: "Neon Violet", hex: "#d400ff", cost: 50, finish: "flat", fam: "neon", hue: "violet" },

  // ---- Greyscale — 60 tags each, needs the neon of that hue ---------
  // A seven-step ramp from white to near-black. It sits at the end of
  // the colour chain and is what Ruby is earned from, so each entry
  // still hangs off a hue: the chain is unbroken, the shelf just isn't
  // coloured any more.
  //
  // Neither end is taken to its absolute limit on purpose. The arena
  // floor is pure #ffffff, so a #ffffff tank would vanish into it, and
  // the Impossible bot's reserved paint is a near-black — a player in
  // true black would be mistaken for one. Chalk and Onyx are as far as
  // the ramp can go and still leave a tank you can see and identify.
  monoChalk: { name: "Chalk", hex: "#f4f6f8", cost: 60, finish: "flat", fam: "mono", hue: "red" },
  monoBone: { name: "Bone", hex: "#d2d6da", cost: 60, finish: "flat", fam: "mono", hue: "orange" },
  monoAsh: { name: "Ash", hex: "#aeb3b8", cost: 60, finish: "flat", fam: "mono", hue: "yellow" },
  monoGrey: { name: "Grey", hex: "#8a8f95", cost: 60, finish: "flat", fam: "mono", hue: "green" },
  monoSlate: { name: "Slate", hex: "#666b71", cost: 60, finish: "flat", fam: "mono", hue: "blue" },
  monoCharcoal: { name: "Charcoal", hex: "#43474d", cost: 60, finish: "flat", fam: "mono", hue: "indigo" },
  monoOnyx: { name: "Onyx", hex: "#2b2f36", cost: 60, finish: "flat", fam: "mono", hue: "violet" },

  // ---- THE MATERIALS ------------------------------------------------
  // One per family, unlocked by completing that family. These aren't
  // colours with an effect painted on top — the tank is MADE of the
  // stuff, and the renderer shades each one the way the real material
  // behaves under a fixed light (see material.js). `special` names the
  // family that opens it.
  bronze: {
    name: "Bronze", hex: "#cd7f32", cost: 50,
    finish: "bronze", fam: "material", special: "base",
  },
  silver: {
    name: "Silver", hex: "#c4c9ce", cost: 100,
    finish: "silver", fam: "material", special: "dark",
  },
  gold: {
    name: "Gold", hex: "#d4af37", cost: 150,
    finish: "gold", fam: "material", special: "light",
  },
  platinum: {
    name: "Platinum", hex: "#d3d7da", cost: 200,
    finish: "platinum", fam: "material", special: "pastel",
  },
  diamond: {
    name: "Diamond", hex: "#dff1fb", cost: 250,
    finish: "diamond", fam: "material", special: "neon",
  },

  // ---- RUBY: the reward for finishing the greyscale shelf, which is
  // itself the end of every hue's chain — so it still sits at the very
  // bottom of the shop, just earned the same way as the other five
  // rather than by a rule of its own.
  ruby: {
    name: "Ruby", hex: "#b0132b", cost: 500,
    finish: "ruby", fam: "material", special: "mono",
  },

  // ---- reserved: the Impossible bot's paint, not for sale ----
  // The Impossible bot's paint, never sold. Pushed darker now that the
  // greyscale shelf ends in Onyx: at #20242e the two were within a
  // dozen values of each other and a player in Onyx read as an
  // Impossible bot at a glance. This keeps the bot the darkest thing on
  // the field, which is the point of it.
  black: { name: "Black", hex: "#101219", cost: 0, finish: "flat", fam: "reserved", reserved: true },
};

// Everything the shop lists, in catalogue order.
export const SHOP_SKINS = Object.keys(SKINS).filter((id) => !SKINS[id].reserved);

// Bots take a randomized PRIMARY colour — never a material, never a
// tinted variant, and (see freeBotSkin) never a colour a player wears.
export const BOT_SKINS = SHOP_SKINS.filter((id) => SKINS[id].fam === "base");

// Free paint: no price, so it's owned from the moment you have an
// account. Red plus the three extra primaries.
export function isFreeSkin(id) {
  const s = SKINS[id];
  return !!s && !s.reserved && (s.cost ?? 0) === 0;
}

export function isMaterialSkin(id) {
  return (SKINS[id] ?? {}).fam === "material";
}

export function skinHex(id) {
  return (SKINS[id] ?? SKINS[DEFAULT_SKIN]).hex;
}

export function skinFinish(id) {
  return (SKINS[id] ?? SKINS[DEFAULT_SKIN]).finish ?? "flat";
}

/* ---------- the unlock chain ---------- */

// The single colour that must be owned before `id` can be bought: the
// same hue, one family back. Null for the primaries (nothing comes
// before them) and for the materials (they use requirements() instead).
export function prereqOf(id) {
  const s = SKINS[id];
  if (!s || s.reserved || s.special) return null;
  const at = FAMILY_ORDER.indexOf(s.fam);
  if (at <= 0) return null;
  const prevFam = FAMILY_ORDER[at - 1];
  return SHOP_SKINS.find((k) => SKINS[k].fam === prevFam && SKINS[k].hue === s.hue) ?? null;
}

// Every colour in a family, in catalogue order.
export function familyMembers(fam) {
  return SHOP_SKINS.filter((id) => SKINS[id].fam === fam);
}

// The full list of colours `id` needs behind it. One entry for an
// ordinary shade; a whole family for a material; everything else in the
// shop for Ruby.
export function requirements(id) {
  const s = SKINS[id];
  if (!s || s.reserved) return [];
  if (s.special === "all") return SHOP_SKINS.filter((k) => k !== id);
  if (s.special) return familyMembers(s.special);
  const p = prereqOf(id);
  return p ? [p] : [];
}

// Is `id` buyable, given a predicate that says what's already owned?
export function skinUnlocked(id, owns) {
  return requirements(id).every((k) => owns(k));
}

// A short, human explanation of what's still missing — the shop puts
// this on a locked tile so the next step is never a mystery.
export function lockReason(id, owns) {
  const s = SKINS[id];
  if (!s) return "";
  const missing = requirements(id).filter((k) => !owns(k));
  if (!missing.length) return "";
  if (s.special === "all") return `Own everything else (${missing.length} to go)`;
  if (s.special) return `Own every ${FAMILY_ADJ[s.special] ?? s.special} colour`;
  return `Buy ${SKINS[missing[0]].name} first`;
}

// A random primary colour that nobody at the table is wearing.
export function freeBotSkin(taken) {
  const pool = BOT_SKINS.filter((id) => !taken.has(id));
  const from = pool.length ? pool : BOT_SKINS;
  return from[Math.floor(Math.random() * from.length)];
}

/* ---------- PATTERNS ---------- */
// A pattern is a two-tone design painted over the tank using TWO
// colours the player already owns. Patterns are pure economy: no gates,
// no prerequisites — if you can afford it, it's yours. The renderer
// (drawTank) knows how to draw each id; this catalogue is just the
// price list plus metadata.
export const PATTERNS = {
  solid: { name: "Solid", cost: 0, colors: 1 },
  // --- cheap: one idea, cleanly executed ----------------------------
  twoTone: { name: "Two Tone", cost: 30, colors: 2 },
  checker: { name: "Checker", cost: 35, colors: 2 },
  stripes: { name: "Racing Stripes", cost: 40, colors: 2 },
  splotchy: { name: "Splotchy", cost: 45, colors: 2 },
  hazard: { name: "Hazard", cost: 50, colors: 2 },
  chevron: { name: "Chevron", cost: 55, colors: 2 },
  // --- mid: real motifs with structure to them ----------------------
  camo: { name: "Camo", cost: 65, colors: 2 },
  plaid: { name: "Plaid", cost: 70, colors: 2 },
  hexScale: { name: "Hex Scale", cost: 75, colors: 2 },
  splatter: { name: "Splatter", cost: 80, colors: 2 },
  tiger: { name: "Tiger", cost: 85, colors: 2 },
  modernCamo: { name: "Digital Camo", cost: 90, colors: 2 },
  carbon: { name: "Carbon Fibre", cost: 95, colors: 2 },
  scales: { name: "Scales", cost: 100, colors: 2 },
  // --- dear: layered, fiddly, or alive ------------------------------
  flames: { name: "Flames", cost: 105, colors: 2 },
  circuit: { name: "Circuit", cost: 110, colors: 2 },
  topo: { name: "Topographic", cost: 115, colors: 2 },
  shatter: { name: "Shatter", cost: 125, colors: 2 },
  lightning: { name: "Lightning", cost: 140, colors: 2 },
  galaxy: { name: "Galaxy", cost: 150, colors: 2 },
  aurora: { name: "Aurora", cost: 165, colors: 2 },
};

export const DEFAULT_PATTERN = "solid";

// Everything the shop lists, cheapest first — with no gates, price IS
// the order of progression.
export const SHOP_PATTERNS = Object.keys(PATTERNS)
  .sort((a, b) => (PATTERNS[a].cost ?? 0) - (PATTERNS[b].cost ?? 0));

export function patternColors(id) {
  return (PATTERNS[id] ?? PATTERNS[DEFAULT_PATTERN]).colors ?? 1;
}
