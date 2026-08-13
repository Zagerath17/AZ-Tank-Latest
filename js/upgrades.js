// ================================================================
// upgrades.js — the tech tree, and the levelling that pays for it.
//
// Import-free ON PURPOSE, like palette.js and skins.js: this is a leaf
// module, so anything may import it without risking a cycle.
//
// Two separate currencies, deliberately:
//
//   TAGS  (skulls) buy paint. Earned per kill, spent in the shop.
//   SKILL POINTS buy upgrades. Earned by LEVELLING, capped at 10.
//
// Keeping them apart means a player can't grind cosmetics into combat
// advantage, and the 10-point ceiling means the tree is about choosing
// a build rather than eventually owning everything. There are 41 ranks
// on offer and only 10 points, so every allocation costs something.
//
// XP comes from 1v1 only: 10 per kill, 25 for a match win. Level 1 is
// 100 XP and each level after costs 50% more. Levels 1–10 each pay a
// skill point; past that levelling is pure prestige, to level 100.
// ================================================================

export const MAX_SKILL_POINTS = 10;
export const MAX_LEVEL = 100;
export const RESET_COST = 25;          // tags, to wipe your allocation

export const XP_PER_KILL = 10;
export const XP_PER_WIN = 25;
const XP_BASE = 100;                   // to reach level 1
const XP_GROWTH = 1.5;                 // each level costs 50% more

// What the NEXT level costs, given the level you're on now.
export function xpForLevel(level) {
  if (level >= MAX_LEVEL) return Infinity;
  return Math.round(XP_BASE * Math.pow(XP_GROWTH, level));
}

// Total XP → { level, into, need }. `into` is progress inside the
// current level, `need` is what that level costs — which is all the
// results screen needs to draw a bar.
export function levelFromXp(totalXp) {
  let level = 0;
  let left = Math.max(0, totalXp || 0);
  while (level < MAX_LEVEL) {
    const need = xpForLevel(level);
    if (left < need) return { level, into: left, need };
    left -= need;
    level++;
  }
  return { level: MAX_LEVEL, into: 0, need: Infinity };
}

// Points earned: one per level, for the first ten only.
export function pointsForLevel(level) {
  return Math.max(0, Math.min(MAX_SKILL_POINTS, level));
}

/* ---------------- the tree ---------------- */
//
// Every node: an id, a label, how many ranks it has, and `per` — what
// ONE rank is worth. The game reads the totals through the helpers at
// the bottom, so nothing outside this file needs to know the shape.
//
// Groups are ordered the way the shop lists them: the tank itself
// first, then guns, then the ability items.

export const UPGRADE_TREE = [
  {
    id: "tank", name: "Tank",
    nodes: [
      { id: "hp",      name: "Max Health",  ranks: 2, per: 1,    fmt: (v) => `+${v} max HP` },
      { id: "speed",   name: "Speed",       ranks: 2, per: 0.05, fmt: (v) => `+${Math.round(v * 100)}% speed` },
      { id: "regen",   name: "Regeneration", ranks: 2, per: 1,   fmt: (v) => `+${v} HP every 17 s` },
      { id: "armour",  name: "Starting Armour", ranks: 2, per: 1, fmt: (v) => `+${v} armour at round start` },
    ],
  },
  {
    id: "basic", name: "Base Cannon",
    nodes: [
      { id: "dmg", name: "Damage",   ranks: 2, per: 1, fmt: (v) => `+${v} damage` },
      { id: "mag", name: "Max Ammo", ranks: 1, per: 1, fmt: (v) => `+${v} round in the magazine` },
    ],
  },
  {
    id: "cannon", name: "Big Cannon",
    nodes: [
      { id: "shrapnel",   name: "Fractals",       ranks: 2, per: 5,    fmt: (v) => `+${v} fractals` },
      { id: "speed",      name: "Shell Speed",    ranks: 1, per: 0.15, fmt: (v) => `+${Math.round(v * 100)}% shell speed` },
      { id: "size",       name: "Shell Size",     ranks: 2, per: 0.05, fmt: (v) => `+${Math.round(v * 100)}% shell size` },
      { id: "shrapSpeed", name: "Fractal Speed",  ranks: 2, per: 0.10, fmt: (v) => `+${Math.round(v * 100)}% fractal speed` },
    ],
  },
  {
    id: "laser", name: "Laser",
    nodes: [
      { id: "bounce",  name: "Extra Bounce",   ranks: 2, per: 1, fmt: (v) => `+${v} bounce` },
      { id: "falloff", name: "Sustained Power", ranks: 1, per: 1, fmt: (v) => `damage holds for ${v} extra bounce` },
      { id: "guide",   name: "Guide Distance",  ranks: 2, per: 1, fmt: (v) => `+${v} bounce shown on the aim line` },
    ],
  },
  {
    id: "sniper", name: "Sniper",
    nodes: [
      { id: "speed", name: "Slug Speed", ranks: 2, per: 0.05, fmt: (v) => `+${Math.round(v * 100)}% slug speed` },
      { id: "dmg",   name: "Damage",     ranks: 1, per: 1,    fmt: (v) => `+${v} damage` },
      { id: "range", name: "Range",      ranks: 1, per: 1,    fmt: (v) => `+${v} cell of range` },
    ],
  },
  {
    id: "mg", name: "Machine Gun",
    nodes: [
      { id: "ammo", name: "Ammunition", ranks: 2, per: 5,    fmt: (v) => `+${v} rounds` },
      { id: "rate", name: "Fire Rate",  ranks: 2, per: 0.05, fmt: (v) => `+${Math.round(v * 100)}% fire rate` },
    ],
  },
  {
    id: "mortar", name: "Mortar",
    nodes: [
      { id: "speed", name: "Shell Speed", ranks: 2, per: 0.10, fmt: (v) => `+${Math.round(v * 100)}% shell speed` },
      { id: "dmg",   name: "Blast Damage", ranks: 1, per: 1,   fmt: (v) => `+${v} damage in every zone` },
    ],
  },
  {
    id: "flame", name: "Flamethrower",
    nodes: [
      { id: "burn", name: "Burn Duration",  ranks: 2, per: 1, fmt: (v) => `+${v} s of burn` },
      { id: "fuel", name: "Flame Duration", ranks: 2, per: 1, fmt: (v) => `+${v} s of fuel` },
    ],
  },
  {
    id: "rocket", name: "Homing Rocket",
    nodes: [
      { id: "speed",    name: "Speed",    ranks: 1, per: 0.05, fmt: (v) => `+${Math.round(v * 100)}% speed` },
      { id: "duration", name: "Duration", ranks: 2, per: 0.05, fmt: (v) => `+${Math.round(v * 100)}% flight time` },
      { id: "dmg",      name: "Damage",   ranks: 1, per: 1,    fmt: (v) => `+${v} damage` },
    ],
  },
  {
    id: "boost", name: "Speed Boost",
    nodes: [
      { id: "duration", name: "Duration", ranks: 2, per: 0.10, fmt: (v) => `+${Math.round(v * 100)}% duration` },
      { id: "speed",    name: "Top Speed", ranks: 2, per: 0.05, fmt: (v) => `+${Math.round(v * 100)}% boosted speed` },
    ],
  },
  {
    id: "phase", name: "Phase",
    nodes: [
      { id: "uses",     name: "Extra Use", ranks: 1, per: 1,    fmt: (v) => `+${v} use before it's spent` },
      // Phase blocks your own gun while it runs, so a SHORTER phase is
      // the upgrade: you slip through and are shooting again sooner.
      { id: "duration", name: "Shorter Phase", ranks: 2, per: 0.10, fmt: (v) => `−${Math.round(v * 100)}% phase time` },
    ],
  },
  {
    id: "wall", name: "Wall",
    nodes: [
      { id: "duration", name: "Duration",   ranks: 2, per: 0.10, fmt: (v) => `+${Math.round(v * 100)}% duration` },
      { id: "hp",       name: "Max Health", ranks: 2, per: 2,    fmt: (v) => `+${v} wall HP` },
    ],
  },
  {
    id: "armour", name: "Armour",
    nodes: [
      { id: "max",      name: "Max Armour",   ranks: 2, per: 1,    fmt: (v) => `+${v} max armour` },
      { id: "regen",    name: "Regeneration", ranks: 1, per: 1,    fmt: (v) => `+${v} armour every 34 s` },
      { id: "duration", name: "Duration",     ranks: 1, per: 0.10, fmt: (v) => `+${Math.round(v * 100)}% duration` },
    ],
  },
  {
    id: "mud", name: "Mud Pit",
    nodes: [
      { id: "duration", name: "Duration",  ranks: 2, per: 0.10, fmt: (v) => `+${Math.round(v * 100)}% duration` },
      { id: "slow",     name: "Slow Effect", ranks: 2, per: 0.07, fmt: (v) => `+${Math.round(v * 100)}% slow` },
    ],
  },
];

// Flat lookup: "tank.hp" → the node.
const INDEX = new Map();
for (const g of UPGRADE_TREE) {
  for (const n of g.nodes) INDEX.set(`${g.id}.${n.id}`, { ...n, group: g.id, groupName: g.name });
}

export function nodeAt(key) { return INDEX.get(key) ?? null; }
export function allKeys() { return [...INDEX.keys()]; }

export const TOTAL_RANKS = [...INDEX.values()].reduce((s, n) => s + n.ranks, 0);

/* ---------------- reading an allocation ---------------- */

// An allocation is a plain object: { "tank.hp": 2, "laser.bounce": 1 }.
// Everything below is tolerant of junk, because it arrives from storage
// and from other players over the network.

export function ranksIn(alloc, key) {
  const n = INDEX.get(key);
  if (!n) return 0;
  const v = Math.floor(Number(alloc?.[key]) || 0);
  return Math.max(0, Math.min(n.ranks, v));
}

// The total bonus a key is worth: ranks × per-rank value.
export function bonus(alloc, key) {
  const n = INDEX.get(key);
  if (!n) return 0;
  return ranksIn(alloc, key) * n.per;
}

export function pointsSpent(alloc) {
  let t = 0;
  for (const key of INDEX.keys()) t += ranksIn(alloc, key);
  return t;
}

export function pointsLeft(alloc, level) {
  return Math.max(0, pointsForLevel(level) - pointsSpent(alloc));
}

// Can one more rank go into this node right now?
export function canRank(alloc, key, level) {
  const n = INDEX.get(key);
  if (!n) return false;
  if (ranksIn(alloc, key) >= n.ranks) return false;
  return pointsLeft(alloc, level) > 0;
}

// Drop anything unrecognised or over its cap, and — if the allocation
// somehow exceeds what the player has earned — pare it back rather than
// letting it through. Called on every allocation that arrives from
// storage or from the network, so a tampered profile can't grant a
// build nobody could have earned.
export function sanitize(alloc, level) {
  const out = {};
  let budget = pointsForLevel(level);
  for (const [key, n] of INDEX) {
    const want = Math.max(0, Math.min(n.ranks, Math.floor(Number(alloc?.[key]) || 0)));
    const take = Math.min(want, budget);
    if (take > 0) { out[key] = take; budget -= take; }
  }
  return out;
}

// A short human summary of a build, for the head-to-head card:
// [{ label: "Tank · Max Health", ranks: 2, text: "+2 max HP" }, …]
export function describe(alloc) {
  const out = [];
  for (const [key, n] of INDEX) {
    const r = ranksIn(alloc, key);
    if (!r) continue;
    out.push({
      key,
      label: `${n.groupName} · ${n.name}`,
      short: n.name,
      group: n.groupName,
      ranks: r,
      text: n.fmt(r * n.per),
    });
  }
  return out;
}

/* ---------------- what the game asks for ---------------- */

// One object of multipliers and flat adds, built once when a tank
// spawns. Everything downstream reads THIS rather than poking at the
// tree, so the game never has to know how the tree is shaped — and a
// match with upgrades switched off just gets the neutral set below.
export function statsFrom(alloc) {
  const b = (k) => bonus(alloc, k);
  return {
    // tank
    hp: b("tank.hp"),
    speed: 1 + b("tank.speed"),
    regen: b("tank.regen"),
    startArmour: b("tank.armour"),
    // guns
    basicDmg: b("basic.dmg"),
    basicMag: b("basic.mag"),
    cannonShrapnel: b("cannon.shrapnel"),
    cannonSpeed: 1 + b("cannon.speed"),
    cannonSize: 1 + b("cannon.size"),
    shrapSpeed: 1 + b("cannon.shrapSpeed"),
    laserBounce: b("laser.bounce"),
    laserFalloff: b("laser.falloff"),
    laserGuide: b("laser.guide"),
    sniperSpeed: 1 + b("sniper.speed"),
    sniperDmg: b("sniper.dmg"),
    sniperRange: b("sniper.range"),
    mgAmmo: b("mg.ammo"),
    mgRate: 1 + b("mg.rate"),
    mortarSpeed: 1 + b("mortar.speed"),
    mortarDmg: b("mortar.dmg"),
    flameBurn: b("flame.burn"),
    flameFuel: b("flame.fuel"),
    rocketSpeed: 1 + b("rocket.speed"),
    rocketDuration: 1 + b("rocket.duration"),
    rocketDmg: b("rocket.dmg"),
    // abilities
    boostDuration: 1 + b("boost.duration"),
    boostSpeed: 1 + b("boost.speed"),
    phaseUses: b("phase.uses"),
    phaseDuration: 1 - b("phase.duration"),
    wallDuration: 1 + b("wall.duration"),
    wallHp: b("wall.hp"),
    armourMax: b("armour.max"),
    armourRegen: b("armour.regen"),
    armourDuration: 1 + b("armour.duration"),
    mudDuration: 1 + b("mud.duration"),
    mudSlow: b("mud.slow"),
  };
}

// The neutral set: what every tank gets when upgrades are off (local
// play, and custom lobbies with the toggle disabled).
export const NO_STATS = statsFrom({});
