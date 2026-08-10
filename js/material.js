// ================================================================
// material.js — the special paints, rendered as actual MATERIALS.
//
// The old premium finishes were animated: a highlight scrolled across
// the hull on a timer, which read as "shiny gimmick" rather than as
// metal or stone. Nothing here moves. A material is defined by how it
// responds to a FIXED light, and that response is baked into the shape
// of the hull, so a gold tank looks like gold whether it's parked or
// flat out.
//
// Two halves, both drawn in the tank's LOCAL frame (origin at the hull
// centre, barrel along +x):
//
//   materialFill()   — the body shading. A value ramp across the hull's
//                      short axis with the diffuse falloff, specular
//                      width and shadow tint that the real material has.
//   materialDetail() — the structure light needs to catch: brushed
//                      striations on worked metal, a horizon on a
//                      mirror, cut facets on the gemstones. Static
//                      geometry, drawn inside whatever clip the caller
//                      has already set (hull or turret).
//
// Both take an explicit ctx, so the arena canvas (game.js) and the
// preview canvases (tanksprite.js) share one implementation instead of
// keeping two copies in sync.
// ================================================================

/* ---------- colour helpers ---------- */

function rgb(hex) {
  const n = parseInt(String(hex).slice(1), 16) || 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function css(r, g, b, a = 1) {
  return a >= 1
    ? `rgb(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)})`
    : `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${a})`;
}
// Blend `hex` toward a target colour by f (0..1).
function toward(hex, target, f) {
  const a = rgb(hex), b = rgb(target);
  const t = Math.max(0, Math.min(1, f));
  return css(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t);
}
const lit = (hex, f) => toward(hex, "#ffffff", f);
const dim = (hex, f) => toward(hex, "#0a0c11", f);

/* ---------- which finishes exist ---------- */

// Every finish id the renderer knows. `flat` is the plain paints; the
// rest are the specials, named for the material they are.
export const FINISHES = ["flat", "bronze", "silver", "gold", "platinum", "diamond", "ruby"];

export function isMaterial(finish) {
  return !!finish && finish !== "flat" && FINISHES.includes(finish);
}

/* ---------- the fill ---------- */

// The lighting axis. Fixed in the tank's own frame, raking across the
// hull's SHORT axis (local y) with a slight forward tilt, so the body
// reads as a rounded, top-lit solid. No time term: nothing scrolls.
function axis(ctx, R) {
  return ctx.createLinearGradient(-R * 0.45, -R * 1.12, R * 0.45, R * 1.12);
}

// The body shading for a material. Returns a fillStyle (a gradient for
// the specials, the plain hex for flat paint).
export function materialFill(ctx, hex, finish, R) {
  if (!isMaterial(finish)) return hex;
  const g = axis(ctx, R);

  switch (finish) {
    // BRONZE — cast, worked metal. Warm and comparatively matte: a
    // broad diffuse shoulder, one soft specular, and an oxidised
    // brown-green sink in the shadow rather than a neutral black.
    case "bronze":
      g.addColorStop(0.00, toward(hex, "#25180c", 0.72));
      g.addColorStop(0.16, toward(hex, "#3b2712", 0.42));
      g.addColorStop(0.34, hex);
      g.addColorStop(0.46, lit(hex, 0.44));
      g.addColorStop(0.53, lit(hex, 0.62));   // soft, wide highlight
      g.addColorStop(0.62, lit(hex, 0.30));
      g.addColorStop(0.78, hex);
      g.addColorStop(0.90, toward(hex, "#2f1d0e", 0.48));
      g.addColorStop(1.00, toward(hex, "#1c1208", 0.70));
      break;

    // SILVER — a mirror. Almost no diffuse of its own: what you see is
    // the environment, so the ramp is a dark ground meeting a bright
    // sky at a hard horizon, with the reflected highlight ON that line.
    case "silver":
      g.addColorStop(0.00, dim(hex, 0.74));
      g.addColorStop(0.30, dim(hex, 0.60));
      g.addColorStop(0.43, dim(hex, 0.46));
      g.addColorStop(0.455, lit(hex, 0.72));  // horizon, hard edge
      g.addColorStop(0.50, "#ffffff");
      g.addColorStop(0.545, lit(hex, 0.60));
      g.addColorStop(0.57, dim(hex, 0.20));
      g.addColorStop(0.74, hex);
      g.addColorStop(0.90, dim(hex, 0.38));
      g.addColorStop(1.00, dim(hex, 0.62));
      break;

    // GOLD — high gloss over a strongly coloured body. The specular is
    // broad and warm-white, and even the shadow keeps its saturation
    // (gold never goes grey), which is most of what sells it.
    case "gold":
      g.addColorStop(0.00, toward(hex, "#3a2600", 0.62));
      g.addColorStop(0.18, toward(hex, "#6b4a05", 0.34));
      g.addColorStop(0.33, hex);
      g.addColorStop(0.44, lit(hex, 0.55));
      g.addColorStop(0.50, "#fff6d8");        // the bloom
      g.addColorStop(0.56, lit(hex, 0.48));
      g.addColorStop(0.70, hex);
      g.addColorStop(0.86, toward(hex, "#5a3d04", 0.42));
      g.addColorStop(1.00, toward(hex, "#2c1d00", 0.64));
      break;

    // PLATINUM — satin, not mirror. Cool and pale with a LOW contrast
    // ramp and a highlight that's wide and restrained; the material
    // reads by its lack of drama next to silver.
    case "platinum":
      g.addColorStop(0.00, dim(hex, 0.50));
      g.addColorStop(0.22, dim(hex, 0.30));
      g.addColorStop(0.40, hex);
      g.addColorStop(0.50, lit(hex, 0.40));   // broad satin sheen
      g.addColorStop(0.62, lit(hex, 0.16));
      g.addColorStop(0.80, dim(hex, 0.22));
      g.addColorStop(1.00, dim(hex, 0.46));
      break;

    // DIAMOND — nearly colourless, so the body is mostly the light that
    // has been through it: a dark core (total internal reflection) with
    // very bright edges, plus a cool tint. The facets in the detail pass
    // are what actually make it a stone.
    case "diamond":
      g.addColorStop(0.00, lit(hex, 0.55));
      g.addColorStop(0.10, toward(hex, "#5c7a8c", 0.55));
      g.addColorStop(0.26, toward(hex, "#26333d", 0.62));   // dark core
      g.addColorStop(0.40, toward(hex, "#3f5666", 0.40));
      g.addColorStop(0.50, "#ffffff");                       // table glint
      g.addColorStop(0.60, toward(hex, "#3f5666", 0.36));
      g.addColorStop(0.74, toward(hex, "#26333d", 0.58));
      g.addColorStop(0.90, toward(hex, "#6d8ea3", 0.45));
      g.addColorStop(1.00, lit(hex, 0.48));
      break;

    // RUBY — a cut, transparent stone. Deep and dark at the girdle,
    // bright across the table, with the warm internal glow a corundum
    // gets from light bouncing inside it. Static: the old version
    // pulsed, which is not a thing rubies do.
    case "ruby": {
      const deep = toward(hex, "#2a0008", 0.66);
      const fire = toward(hex, "#ff9a5a", 0.42);
      g.addColorStop(0.00, deep);
      g.addColorStop(0.12, toward(hex, "#5c0016", 0.45));
      g.addColorStop(0.26, hex);
      g.addColorStop(0.36, deep);              // pavilion shadow
      g.addColorStop(0.45, fire);              // internal glow
      g.addColorStop(0.50, "#fff0f2");         // table
      g.addColorStop(0.56, fire);
      g.addColorStop(0.66, hex);
      g.addColorStop(0.80, deep);
      g.addColorStop(0.92, toward(hex, "#7a0020", 0.40));
      g.addColorStop(1.00, deep);
      break;
    }

    default:
      return hex;
  }
  return g;
}

/* ---------- the detail pass ---------- */

// A fixed pseudo-random sequence. Every tank wearing gold is wearing
// the SAME gold, so the structure is seeded from a constant rather than
// from the tank — a material isn't per-object.
function seq(seed) {
  let a = (seed ^ 0x9e3779b9) >>> 0;
  return () => {
    a ^= a << 13; a >>>= 0;
    a ^= a >> 17;
    a ^= a << 5; a >>>= 0;
    return a / 4294967296;
  };
}

// Straight brushed striations along the hull's long axis — how worked
// metal is actually finished, and the reason brushed metal has a
// direction to it.
function brush(ctx, R, lines, alpha, colour) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = colour;
  ctx.lineWidth = Math.max(0.5, R * 0.018);
  const rnd = seq(0x51ed270b);
  ctx.beginPath();
  for (let i = 0; i < lines; i++) {
    const y = -R * 0.62 + (i / (lines - 1)) * R * 1.24 + (rnd() - 0.5) * R * 0.02;
    ctx.moveTo(-R * 1.0, y);
    ctx.lineTo(R * 1.0, y);
  }
  ctx.stroke();
  ctx.restore();
}

// A brilliant-cut facet field: wedges radiating from a central table,
// each a flat plane catching the light differently. This is what makes
// a gemstone read as cut rather than as a coloured blob.
function facets(ctx, R, spec) {
  const { crown, pavilion, glint, table, tints = [], n = 11 } = spec;
  const rnd = seq(0x2f9e77b1);
  ctx.save();

  // Pavilion + crown wedges around the girdle.
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * Math.PI * 2;
    const a1 = ((i + 1) / n) * Math.PI * 2;
    const rOut = R * (1.05 + rnd() * 0.25);
    const rIn = R * (0.26 + rnd() * 0.12);
    ctx.beginPath();
    ctx.moveTo(Math.cos(a0) * rIn, Math.sin(a0) * rIn * 0.7);
    ctx.lineTo(Math.cos(a0) * rOut, Math.sin(a0) * rOut * 0.7);
    ctx.lineTo(Math.cos(a1) * rOut, Math.sin(a1) * rOut * 0.7);
    ctx.lineTo(Math.cos(a1) * rIn, Math.sin(a1) * rIn * 0.7);
    ctx.closePath();
    // Alternate bright/dark planes, with the odd tinted one where the
    // stone is splitting the light.
    const t = rnd();
    let fill;
    if (tints.length && t > 0.80) fill = tints[i % tints.length];
    else fill = i % 2 ? crown : pavilion;
    ctx.fillStyle = fill;
    ctx.globalAlpha = 0.30 + rnd() * 0.34;
    ctx.fill();
    // Facet edge: the hard line between two planes.
    ctx.globalAlpha = 0.36;
    ctx.strokeStyle = glint;
    ctx.lineWidth = Math.max(0.6, R * 0.014);
    ctx.stroke();
  }

  // The table — the big flat top face, brightest plane on the stone.
  ctx.globalAlpha = 0.55;
  ctx.fillStyle = table;
  ctx.beginPath();
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2 + 0.3;
    const r = R * (0.30 + (i % 2 ? 0.05 : 0));
    const x = Math.cos(a) * r, y = Math.sin(a) * r * 0.7;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fill();
  ctx.globalAlpha = 0.5;
  ctx.strokeStyle = glint;
  ctx.stroke();

  ctx.restore();
}

// Draw the material's structure. The caller has already clipped to the
// piece being painted (hull or turret) and filled it with materialFill.
export function materialDetail(ctx, hex, finish, R) {
  if (!isMaterial(finish)) return;

  switch (finish) {
    case "bronze":
      // Coarse cast grain — bronze is worked, not polished.
      brush(ctx, R, 9, 0.16, "#2a1a0a");
      brush(ctx, R, 5, 0.10, lit(hex, 0.6));
      break;

    case "silver": {
      // A mirror shows the world: a second, fainter horizon below the
      // main one reads as the floor reflected back.
      ctx.save();
      ctx.globalAlpha = 0.30;
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = Math.max(0.8, R * 0.03);
      ctx.beginPath();
      ctx.moveTo(-R, R * 0.30); ctx.lineTo(R, R * 0.30);
      ctx.stroke();
      ctx.globalAlpha = 0.22;
      ctx.strokeStyle = "#0b0f16";
      ctx.beginPath();
      ctx.moveTo(-R, R * 0.38); ctx.lineTo(R, R * 0.38);
      ctx.stroke();
      ctx.restore();
      break;
    }

    case "gold":
      // Polished: no grain at all, just a soft secondary sheen where
      // the light wraps around the far side.
      ctx.save();
      ctx.globalAlpha = 0.28;
      ctx.fillStyle = lit(hex, 0.7);
      ctx.beginPath();
      ctx.ellipse(-R * 0.15, -R * 0.42, R * 0.75, R * 0.10, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      break;

    case "platinum":
      // Fine, dense satin brushing — tighter and cooler than bronze.
      brush(ctx, R, 15, 0.13, "#ffffff");
      brush(ctx, R, 15, 0.10, "#1b2028");
      break;

    case "diamond":
      facets(ctx, R, {
        crown: "#ffffff",
        pavilion: "#1d2a33",
        glint: "#ffffff",
        table: "#eaf9ff",
        // Dispersion: a diamond splits white light, so a few planes
        // come back tinted.
        tints: ["#9ad8ff", "#ffd8f0", "#fff0b0", "#b9ffe4"],
        n: 13,
      });
      break;

    case "ruby":
      facets(ctx, R, {
        crown: toward(hex, "#ffd0c0", 0.55),
        pavilion: "#2a0008",
        glint: "#fff2f4",
        table: toward(hex, "#ffffff", 0.45),
        tints: ["#ff8a5c", "#ff4d6d"],
        n: 11,
      });
      break;
  }
}

// Convenience for previews and chips: fill + detail on a rounded chip,
// centred on the current origin.
export function paintMaterialChip(ctx, hex, finish, R) {
  const path = () => {
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(-R * 0.9, -R * 0.9, R * 1.8, R * 1.8, R * 0.42);
    else ctx.rect(-R * 0.9, -R * 0.9, R * 1.8, R * 1.8);
  };
  path();
  ctx.fillStyle = materialFill(ctx, hex, finish, R);
  ctx.fill();
  if (!isMaterial(finish)) return;
  ctx.save();
  path();
  ctx.clip();
  materialDetail(ctx, hex, finish, R);
  ctx.restore();
}
