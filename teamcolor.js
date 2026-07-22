// ================================================================
// teamcolor.js — 2v2 team paint: the host's colour dresses the whole
// team, the second seat wears it 20% darker, and if the enemy team's
// paint clashes with ours we recolour THEM on our own screen (they do
// the same to us). Import-free leaf module so anything can pull it in.
//
// Colours here are HEX strings ("#rrggbb"). The renderer keeps using
// skin/pattern IDs for the finish animation and pattern SHAPE; this
// module only decides the actual base + pattern HEXES a tank wears.
// ================================================================

/* ---------- hex ⇄ rgb ⇄ hsl ---------- */

function toRGB(hex) {
  const n = parseInt(String(hex ?? "#000000").slice(1), 16) || 0;
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
function toHex({ r, g, b }) {
  const c = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}
function rgbToHsl({ r, g, b }) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  let h = 0, s = 0; const l = (mx + mn) / 2;
  const d = mx - mn;
  if (d > 1e-6) {
    s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    if (mx === r) h = ((g - b) / d) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60; if (h < 0) h += 360;
  }
  return { h, s, l };
}
function hslToRgb({ h, s, l }) {
  h = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255 };
}

/* ---------- public colour ops ---------- */

// 20% darker (f = 0.2) by scaling RGB toward black — what "X% darker"
// means to most people, and stable for any hue.
export function darken(hex, f = 0.2) {
  const { r, g, b } = toRGB(hex);
  const k = 1 - f;
  return toHex({ r: r * k, g: g * k, b: b * k });
}

// Rotate hue by `deg`, preserving saturation/lightness.
export function hueRotate(hex, deg) {
  const hsl = rgbToHsl(toRGB(hex));
  hsl.h += deg;
  return toHex(hslToRgb(hsl));
}

// Straight RGB distance (0 … ~441). Cheap and good enough to tell
// "basically the same colour" from "clearly different".
export function colorDistance(a, b) {
  const x = toRGB(a), y = toRGB(b);
  return Math.hypot(x.r - y.r, x.g - y.g, x.b - y.b);
}

// Two paints "clash" if they're the same or nearly so.
const CLASH_DIST = 70;
export function colorsClash(a, b) {
  return colorDistance(a, b) < CLASH_DIST;
}

// A colour clearly different from `avoid` (and, ideally, from the rest
// of `avoidAll`). Tries a near-complement first; for near-greyscale
// paint (where hue rotation does nothing) it falls back to whichever
// vivid candidate sits farthest from everything to avoid.
const CONTRAST_CANDIDATES = [
  "#3f99f3", "#ff7a00", "#39ff14", "#d400ff",
  "#f5ff00", "#00d5ff", "#ff1745", "#ffffff",
];
export function contrastingHex(avoid, avoidAll = []) {
  const avoids = [avoid, ...avoidAll].filter(Boolean);
  const rot = hueRotate(avoid, 175);
  if (avoids.every((c) => colorDistance(rot, c) >= CLASH_DIST * 1.6)) return rot;
  let best = CONTRAST_CANDIDATES[0], bestScore = -1;
  for (const cand of CONTRAST_CANDIDATES) {
    const score = Math.min(...avoids.map((c) => colorDistance(cand, c)));
    if (score > bestScore) { bestScore = score; best = cand; }
  }
  return best;
}

/* ---------- the 2v2 team paint resolver ---------- */

// Input — one entry per player in the match:
//   { id, team: 0|1, leader: bool,
//     baseHex,               // the player's own base paint hex
//     patId: string|null,    // pattern id, or null/"solid"
//     patHexes: [h,h]|null }  // the pattern's two colours as hex
//
// Only each team's LEADER paint matters: teammates inherit it. myTeam
// anchors the clash check, so every client keeps ITS team's true colour
// and shifts only the other team when the two would look alike.
//
// Output — { [id]: { baseHex, patHexes: [h,h]|null } } — the HEXES each
// tank should actually wear on THIS client.
export function resolveTeamPaint(entries, myTeam = 0) {
  const leaders = {};
  for (const e of entries) {
    if (e.leader) leaders[e.team] = e;
  }
  // Fallback: if a team has no explicit leader flag, take its first
  // member as the leader so the team still gets a single colour.
  for (const e of entries) {
    if (leaders[e.team] == null) leaders[e.team] = e;
  }

  // A team's full colour set (base + pattern colours) as worn by its
  // leader — used for the clash comparison.
  const teamHexes = (lead) => {
    const set = [lead.baseHex];
    if (lead.patId && lead.patId !== "solid" && Array.isArray(lead.patHexes)) {
      set.push(...lead.patHexes.filter(Boolean));
    }
    return set.filter(Boolean);
  };

  // Decide a per-team hue shift for the ENEMY team(s) if they clash.
  const shift = {}; // team → degrees (0 = no change)
  const myLead = leaders[myTeam];
  if (myLead) {
    const mine = teamHexes(myLead);
    for (const [teamStr, lead] of Object.entries(leaders)) {
      const team = Number(teamStr);
      if (team === myTeam) { shift[team] = 0; continue; }
      const theirs = teamHexes(lead);
      const clash = theirs.some((t) => mine.some((m) => colorsClash(t, m)));
      if (!clash) { shift[team] = 0; continue; }
      // Recolour this enemy team. Pick a contrasting hue offset that
      // moves their leader's BASE well clear of all my colours, then
      // apply that same rotation to every colour they wear so their
      // own internal contrast (pattern, darker teammate) survives.
      const target = contrastingHex(lead.baseHex, mine);
      const from = rgbToHsl(toRGB(lead.baseHex)).h;
      const to = rgbToHsl(toRGB(target)).h;
      // If the source is greyscale, hue rotation won't help — mark with
      // a sentinel so we swap to the target colour outright below.
      const grey = rgbToHsl(toRGB(lead.baseHex)).s < 0.12;
      shift[team] = grey ? { grey: true, target } : (((to - from) % 360) + 360) % 360;
    }
  }

  const applyShift = (hex, team) => {
    const s = shift[team] ?? 0;
    if (s === 0) return hex;
    if (typeof s === "object" && s.grey) return s.target;
    return hueRotate(hex, s);
  };

  const out = {};
  for (const e of entries) {
    const lead = leaders[e.team] ?? e;
    // The team paint (leader's), shifted if this team is a recoloured
    // enemy — then darkened for the non-leader seat.
    let baseHex = applyShift(lead.baseHex, e.team);
    let patHexes = (lead.patId && lead.patId !== "solid" && Array.isArray(lead.patHexes))
      ? lead.patHexes.map((h) => applyShift(h, e.team))
      : null;
    if (!e.leader) {
      baseHex = darken(baseHex, 0.2);
      if (patHexes) patHexes = patHexes.map((h) => darken(h, 0.2));
    }
    out[e.id] = { baseHex, patHexes };
  }
  return out;
}
