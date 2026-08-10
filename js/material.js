// ================================================================
// material.js — the special paints, shaded with real PBR.
//
// WHAT CHANGED, AND WHY IT HAD TO
//
// Every previous attempt approximated a material with canvas gradients:
// a ramp for the body, a radial blob for the highlight, some strokes
// for structure. That is imitation. A gradient has no idea where the
// surface is pointing, so it cannot know that an edge should catch the
// light differently from the middle, and the eye reads the result as a
// pattern painted onto a flat shape — because that is exactly what it
// is.
//
// This module instead shades PER PIXEL from an actual surface:
//
//   1. NORMALS. The hull is a rounded box, so its shape is described by
//      a signed distance field. The SDF gives a height field (flat on
//      top, falling away over a bevel at the rim), and the gradient of
//      that height field is the surface normal N at every pixel. This
//      is real geometry — the bevel is a bevel, not a stroke that looks
//      like one.
//
//   2. A BRDF. Cook-Torrance, the standard microfacet model:
//
//          f = D(h) · G(l,v) · F(v,h)  /  (4 (N·L)(N·V))
//
//      with GGX/Trowbridge-Reitz for the normal distribution D, Smith
//      height-correlated masking for G, and Schlick's approximation for
//      the Fresnel term F. Roughness controls the width of the specular
//      lobe; metalness decides whether the surface has any diffuse at
//      all. These are the same equations a 3D engine uses.
//
//   3. ENERGY-CORRECT METALS. A conductor has NO diffuse component —
//      all of its colour lives in F0, the specular reflectance at
//      normal incidence. That single fact is why gold's highlight is
//      gold and why a metal's shadow stays saturated instead of going
//      grey. Dielectrics and gems get F0 ≈ 0.04–0.17 plus a diffuse or
//      transmission term.
//
//   4. AN ENVIRONMENT. Metal is mostly a mirror, so what it shows is
//      its surroundings. The reflection vector R = reflect(-V, N) is
//      looked up in a small procedural environment — sky above the
//      horizon, ground below, a sun disc — and blurred according to
//      roughness. The hard horizon line on polished silver is not drawn
//      anywhere in this file: it emerges because a mirror curving over
//      an edge sweeps its reflection past the horizon.
//
// COST, AND WHY THIS IS THE FAST PATH
//
// Per-pixel PBR every frame would be absurd. It never runs per frame:
// every (material, orientation) is rasterised ONCE into a small tile
// and cached, then drawn as a single image. Painting a tank went from
// ~110 canvas operations to one, so the gem finishes — previously the
// most expensive things on screen by a wide margin — are now among the
// cheapest. Nothing is animated: a tile depends on orientation, never
// on the clock, so a parked tank is perfectly still and a turning one
// sweeps its reflection exactly as real metal does.
// ================================================================

/* ---------- what a material IS, in PBR terms ---------- */

// baseColor is taken from the skin's hex. Everything else is the
// physical description: how rough the surface is, whether it's a
// conductor, and what light does inside it if it isn't.
// `f0` is the measured specular reflectance at normal incidence, in
// LINEAR light — the real physical constant for each metal, not the
// skin's hex. A conductor reflects 50–100% of what hits it, so feeding
// the BRDF a dim sRGB swatch instead is why gold came out olive and
// silver came out flat grey. The hex only tints these.
const MATERIALS = {
  bronze: {
    metal: 1, rough: 0.34, aniso: 0.30,
    f0: [0.955, 0.615, 0.360],          // bronze/copper alloy
    envMul: 1.05, dome: 0.72,
  },
  silver: {
    metal: 1, rough: 0.055, aniso: 0,
    f0: [0.972, 0.960, 0.915],          // the most reflective metal there is
    envMul: 1.3, dome: 0.74,
  },
  gold: {
    metal: 1, rough: 0.14, aniso: 0,
    f0: [1.000, 0.766, 0.336],          // the classic measured value
    envMul: 1.22, dome: 0.70,
  },
  platinum: {
    metal: 1, rough: 0.30, aniso: 0.60, // satin: brushed, so anisotropic
    f0: [0.679, 0.642, 0.588],
    envMul: 1.0, dome: 0.72,
  },
  diamond: {
    metal: 0, rough: 0.012, ior: 2.42, gem: true,
    // A brilliant is colourless: almost everything you see is returned
    // light, so it needs a big environment gain and almost no body, or
    // it sits there looking like a grey pebble.
    disperse: 0.7, envMul: 3.2, dome: 1.0, facets: 17, facetTilt: 2.4,
    absorb: [0.02, 0.015, 0.008], body: 0.10,
  },
  ruby: {
    metal: 0, rough: 0.04, ior: 1.77, gem: true,
    disperse: 0.18, envMul: 1.2, dome: 1.0, facets: 13, facetTilt: 1.6,
    absorb: [0.05, 2.6, 2.0], body: 1.5, // corundum: soaks green and blue hard
  },
};

export const FINISHES = ["flat", ...Object.keys(MATERIALS)];
export function isMaterial(finish) {
  return !!finish && finish !== "flat" && !!MATERIALS[finish];
}

// The key light, in WORLD radians, and its elevation. Fixed in the
// world: the tank turns under it, which is what makes the reflection
// sweep across the hull instead of riding along with it.
const LIGHT_A = -2.2;
const LIGHT_Z = 0.62;          // how high the key sits (0 = horizon)
const LIGHT_I = 2.5;           // intensity

/* ---------- small vector helpers ---------- */

const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
function norm3(v) {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}
const sat = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
// Linear ↔ sRGB. The BRDF is evaluated in LINEAR light; skipping this
// is the usual reason hand-tuned shading looks chalky.
const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const toSRGB = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

function hexToLinear(hex) {
  const n = parseInt(String(hex).slice(1), 16) || 0;
  return [
    toLinear(((n >> 16) & 255) / 255),
    toLinear(((n >> 8) & 255) / 255),
    toLinear((n & 255) / 255),
  ];
}

/* ---------- the environment ---------- */

// A tiny procedural surrounding: ground below the horizon, sky above,
// and a sun. Sampled by the reflection vector. `rough` blurs the
// lookup, which is what separates a mirror from a satin finish.
function sampleEnv(r, rough, out) {
  const up = r[2];                       // +z is toward the viewer/sky
  const blur = rough * rough;
  // Sky: a cool gradient that brightens toward the zenith.
  const t = sat(up * 0.5 + 0.5);
  // Sharpen the horizon as roughness falls — a polished surface shows
  // a hard line where sky meets ground, a rough one smears it out.
  const edge = sat((t - 0.5) / Math.max(0.02, blur * 0.9 + 0.02) * 0.5 + 0.5);
  // Deliberately NEUTRAL, like a studio softbox rather than open sky.
  // A strongly blue environment multiplied by gold's F0 (which kills
  // blue) comes back olive — the metal loses its own identity to the
  // room. Keeping the surroundings near-grey lets each metal's measured
  // reflectance decide its colour, which is exactly how a product shot
  // of gold is lit.
  const skyR = 0.34 + 0.62 * t, skyG = 0.35 + 0.63 * t, skyB = 0.38 + 0.64 * t;
  const gndR = 0.030, gndG = 0.028, gndB = 0.026;
  out[0] = gndR + (skyR - gndR) * edge;
  out[1] = gndG + (skyG - gndG) * edge;
  out[2] = gndB + (skyB - gndB) * edge;

  // A bright band just above the horizon. Real rooms have one (the
  // window, the ceiling edge) and it is what gives polished metal its
  // characteristic light streak wrapping around a curve.
  const band = Math.exp(-Math.pow((up - 0.10) / (0.14 + blur * 0.5), 2)) * (0.34 - rough * 0.18);
  out[0] += band; out[1] += band; out[2] += band * 1.03;

  // The sun: a bright disc, widened by roughness. This is the
  // environment's specular highlight and it lands wherever the surface
  // happens to point at it.
  const lz = LIGHT_Z, lr = Math.sqrt(Math.max(0, 1 - lz * lz));
  const L = [Math.cos(LIGHT_A) * lr, Math.sin(LIGHT_A) * lr, lz];
  const d = sat(dot3(r, L));
  const tight = 1 / Math.max(0.006, blur * 0.7 + 0.006);
  const sun = Math.pow(d, tight) * (2.2 + 6 * (1 - rough));
  out[0] += sun * 1.0; out[1] += sun * 0.97; out[2] += sun * 0.9;

  // A dim fill from the opposite side so shadowed metal isn't dead
  // black — real rooms bounce light around.
  const f = sat(-dot3(r, L)) * 0.10;
  out[0] += f * 0.5; out[1] += f * 0.55; out[2] += f * 0.7;
}

/* ---------- Cook-Torrance ---------- */

// GGX / Trowbridge-Reitz normal distribution.
function D_GGX(NoH, a) {
  const a2 = a * a;
  const d = NoH * NoH * (a2 - 1) + 1;
  return a2 / (Math.PI * d * d + 1e-7);
}
// Smith height-correlated visibility (the G term, already divided by
// the 4(N·L)(N·V) denominator).
function V_SmithGGX(NoV, NoL, a) {
  const a2 = a * a;
  const gv = NoL * Math.sqrt(NoV * NoV * (1 - a2) + a2);
  const gl = NoV * Math.sqrt(NoL * NoL * (1 - a2) + a2);
  return 0.5 / (gv + gl + 1e-7);
}
// Schlick's Fresnel.
function F_Schlick(VoH, f0, out) {
  const f = Math.pow(1 - VoH, 5);
  out[0] = f0[0] + (1 - f0[0]) * f;
  out[1] = f0[1] + (1 - f0[1]) * f;
  out[2] = f0[2] + (1 - f0[2]) * f;
}

/* ---------- the surface ---------- */

// Signed distance to a rounded box, negative inside. This is the hull's
// actual silhouette, so the normals derived from it are the hull's
// actual normals.
function sdRoundBox(px, py, hx, hy, r) {
  const qx = Math.abs(px) - hx + r;
  const qy = Math.abs(py) - hy + r;
  const ox = Math.max(qx, 0), oy = Math.max(qy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - r;
}

// A fixed pseudo-random sequence, so every tank wearing a material
// wears the SAME one — structure belongs to the material, not the tank.
function seq(seed) {
  let a = (seed ^ 0x9e3779b9) >>> 0;
  return () => {
    a ^= a << 13; a >>>= 0;
    a ^= a >> 17;
    a ^= a << 5; a >>>= 0;
    return a / 4294967296;
  };
}

// A gem is CUT, so its surface is a set of flat planes rather than a
// smooth bevel. Each facet gets its own constant normal, tilted away
// from the table by an amount that grows toward the girdle — which is
// what makes the stone scintillate as it turns.
function facetNormal(px, py, hx, hy, n, rnd, tiltMul) {
  const a = Math.atan2(py / hy, px / hx);
  const rr = Math.min(1, Math.hypot(px / hx, py / hy));
  // Two rings of facets, offset from each other like a brilliant cut,
  // plus the flat table on top. Neighbouring planes have to differ
  // sharply or the stone reads as frosted glass instead of cut.
  const ring = rr < 0.62 ? 0 : 1;
  const nn = ring ? n : Math.max(6, n - 5);
  const off = ring ? 0.5 : 0;
  const idx = Math.floor(((a + Math.PI) / (Math.PI * 2)) * nn + off) % nn;
  const mid = ((idx + 0.5 - off) / nn) * Math.PI * 2 - Math.PI;
  const tilt = (rr < 0.30 ? 0.06 : (ring ? 0.55 + rr * 0.95 : 0.26 + rr * 0.5)) * (tiltMul ?? 1);
  const j = rnd(idx + ring * 17) * 0.30 - 0.15;
  return norm3([Math.cos(mid) * (tilt + j), Math.sin(mid) * (tilt + j), 1]);
}

/* ---------- the tile renderer ---------- */

// How many orientations to bake. The reflection sweeps as the tank
// turns; 48 steps is 7.5° apart, below what reads as stepping.
const BUCKETS = 48;
const cache = new Map();
let cacheBytes = 0;
const CACHE_LIMIT = 24 * 1024 * 1024;    // plenty for every skin in play

export function bucketOf(ang) {
  const n = ((ang % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
  return Math.round(n / (Math.PI * 2) * BUCKETS) % BUCKETS;
}

// Rasterise one (material, size, orientation) into an RGBA tile.
function renderTile(hex, finish, size, ang) {
  const M = MATERIALS[finish];
  const cv = typeof OffscreenCanvas !== "undefined"
    ? new OffscreenCanvas(size, size)
    : document.createElement("canvas");
  cv.width = size; cv.height = size;
  const c2 = cv.getContext("2d");
  const img = c2.createImageData(size, size);
  const px = img.data;

  const base = hexToLinear(hex);
  // METALS put all of their colour in F0 and have no diffuse at all.
  // The measured constant sets the level; the skin's hex nudges the hue
  // so the shop swatch and the tank still agree.
  let f0;
  if (M.metal) {
    const bl = Math.max(1e-3, (base[0] + base[1] + base[2]) / 3);
    f0 = [0, 1, 2].map((i) => {
      const tint = base[i] / bl;                    // hue only, level removed
      return sat(M.f0[i] * (0.72 + 0.28 * tint));
    });
  } else {
    const r = (M.ior - 1) / (M.ior + 1);
    const v = r * r;
    f0 = [v, v, v];
  }

  const half = size * 0.5;
  // The hull footprint inside the tile, in pixels.
  const hx = size * 0.46, hy = size * 0.46, corner = size * 0.13;
  // The roll-off spans nearly the whole piece rather than a thin lip,
  // so the surface is a domed casting and its normals vary EVERYWHERE.
  // With a thin bevel the middle is one flat plane, every pixel of it
  // samples the environment identically, and the result is a coloured
  // slab — which is what a gradient would have given us anyway.
  const dome = size * 0.46 * (M.dome ?? 0.92);

  const V = [0, 0, 1];                       // top-down view
  const lz = LIGHT_Z, lr = Math.sqrt(Math.max(0, 1 - lz * lz));
  // The light lives in the WORLD, so in the tile's own frame it sits at
  // (LIGHT_A − ang). This one line is what anchors the reflection.
  const la = LIGHT_A - ang;
  const L = [Math.cos(la) * lr, Math.sin(la) * lr, lz];
  const NoL_min = 1e-4;

  const rndTable = new Float64Array(64);
  { const r = seq(0x9e3779b9); for (let i = 0; i < 64; i++) rndTable[i] = r(); }
  const rnd = (i) => rndTable[i & 63];

  const env = [0, 0, 0], F = [0, 0, 0], R = [0, 0, 0];
  const aRough = Math.max(0.015, M.rough);
  const alpha = aRough * aRough;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const o = (y * size + x) * 4;
      const lxp = x + 0.5 - half, lyp = y + 0.5 - half;

      const d = sdRoundBox(lxp, lyp, hx, hy, corner);
      if (d > 0.7) { px[o + 3] = 0; continue; }     // outside the piece

      // --- normal ---------------------------------------------------
      let N;
      if (M.gem) {
        N = facetNormal(lxp, lyp, hx, hy, M.facets, rnd, M.facetTilt);
      } else {
        // Height field: flat on top, rolling off over the bevel at the
        // rim. Its gradient IS the normal.
        // Quarter-circle dome: height 0 at the silhouette, rising to 1
        // at the apex. Its gradient is steepest at the rim, so edges
        // turn to face outward and catch the horizon — real Fresnel
        // behaviour, from real geometry.
        const h = (t) => {
          const k = sat((-t) / dome);            // 0 at the edge, 1 inside
          return Math.sqrt(sat(1 - (1 - k) * (1 - k)));
        };
        const e = 0.8;
        const dx = h(sdRoundBox(lxp + e, lyp, hx, hy, corner)) - h(sdRoundBox(lxp - e, lyp, hx, hy, corner));
        const dy = h(sdRoundBox(lxp, lyp + e, hx, hy, corner)) - h(sdRoundBox(lxp, lyp - e, hx, hy, corner));
        const s = dome * 0.55 / e;
        N = norm3([-dx * s, -dy * s, 1]);
        // Anisotropy: brushed metal is grooved along the hull's long
        // axis, so the normal is perturbed across it. This is why
        // brushed steel smears its highlight into a streak.
        if (M.aniso) {
          const g = Math.sin(lyp * 2.4) * 0.5 + Math.sin(lyp * 7.1) * 0.22;
          N = norm3([N[0], N[1] + g * M.aniso * 0.12, N[2]]);
        }
      }

      const NoV = sat(dot3(N, V));
      const NoL = dot3(N, L);
      // --- direct specular -----------------------------------------
      let sr = 0, sg = 0, sb = 0;
      if (NoL > NoL_min) {
        const H = norm3([L[0] + V[0], L[1] + V[1], L[2] + V[2]]);
        const NoH = sat(dot3(N, H));
        const VoH = sat(dot3(V, H));
        const Dv = D_GGX(NoH, alpha);
        const Vv = V_SmithGGX(Math.max(NoV, 1e-4), NoL, alpha);
        F_Schlick(VoH, f0, F);
        const spec = Dv * Vv * LIGHT_I * NoL;
        sr = spec * F[0]; sg = spec * F[1]; sb = spec * F[2];
      }

      // --- environment reflection -----------------------------------
      // R = reflect(-V, N). For a metal this IS the surface's colour;
      // for a gem it's the glassy sheen on top of the body.
      const NdV = dot3(N, V);
      R[0] = 2 * NdV * N[0] - V[0];
      R[1] = 2 * NdV * N[1] - V[1];
      R[2] = 2 * NdV * N[2] - V[2];
      sampleEnv(R, aRough, env);
      // Fresnel at the viewing angle: grazing pixels reflect much more.
      F_Schlick(NoV, f0, F);
      const em = M.envMul ?? 1;
      let rr2 = sr + env[0] * F[0] * em;
      let gg2 = sg + env[1] * F[1] * em;
      let bb2 = sb + env[2] * F[2] * em;

      // --- body ------------------------------------------------------
      if (!M.metal) {
        if (M.gem) {
          // A transparent stone: light enters, bounces around inside,
          // and comes back coloured by how far it travelled. Deeper
          // parts of the stone look darker and more saturated — the
          // reason a ruby has a glowing heart and a dark girdle.
          const depth = sat(1 - (-d) / (dome * 0.95));
          const path = 0.35 + depth * 1.5;
          const ab = M.absorb ?? [0.02, 0.02, 0.02];
          const tr = Math.exp(-ab[0] * path * 3);
          const tg = Math.exp(-ab[1] * path * 3);
          const tb = Math.exp(-ab[2] * path * 3);
          // Light that made it through, tinted by the stone.
          // How much light actually makes it back out. A cut stone is
          // mostly DARK with a few blinding returns; a uniformly bright
          // one just looks like frosted plastic.
          const thru = (0.18 + 0.82 * sat(NoL)) * (M.body ?? 1);
          rr2 += base[0] * thru * tr * 1.6;
          gg2 += base[1] * thru * tg * 1.6;
          bb2 += base[2] * thru * tb * 1.6;
          // Dispersion: the stone splits white light, so the very
          // edges fringe. Diamond does this far more than ruby.
          if (M.disperse) {
            // Confined to grazing angles — the rim and the facet
            // junctions — because that is where a stone's path length
            // differs enough between wavelengths to separate them.
            const graze = Math.pow(1 - NoV, 6);
            const fr = graze * M.disperse * 3.0;
            rr2 += fr; gg2 += fr * 0.30; bb2 += fr * 0.05;
            const fb = graze * M.disperse * 1.6;
            bb2 += fb; gg2 += fb * 0.5;
          }
        } else {
          const kd = 1 - F[0];
          const diff = sat(NoL) * LIGHT_I * 0.22;
          rr2 += base[0] * diff * kd;
          gg2 += base[1] * diff * kd;
          bb2 += base[2] * diff * kd;
        }
      }

      // --- tonemap + encode -----------------------------------------
      // Tonemapped on LUMINANCE, not per channel. Compressing each
      // channel separately squeezes a bright one harder than a dim one,
      // so it pulls every colour toward grey exactly where a metal is
      // brightest — which is why gold kept coming out olive. Scaling
      // all three by one luminance-derived factor keeps the ratio
      // between them, so the hue survives. Only genuinely blinding
      // returns are then allowed to bleach toward white, which is what
      // real highlights do.
      const lum = 0.2126 * rr2 + 0.7152 * gg2 + 0.0722 * bb2;
      if (lum > 1e-6) {
        const k = (lum / (1 + lum)) / lum;
        rr2 *= k; gg2 *= k; bb2 *= k;
        const bleach = sat((lum - 2.2) / 6);
        if (bleach > 0) {
          rr2 += (1 - rr2) * bleach; gg2 += (1 - gg2) * bleach; bb2 += (1 - bb2) * bleach;
        }
      }
      px[o] = Math.round(toSRGB(sat(rr2)) * 255);
      px[o + 1] = Math.round(toSRGB(sat(gg2)) * 255);
      px[o + 2] = Math.round(toSRGB(sat(bb2)) * 255);
      // Antialias the silhouette against the SDF.
      px[o + 3] = Math.round(sat(0.5 - d) * 255);
    }
  }
  c2.putImageData(img, 0, 0);
  return cv;
}

// Fetch (or bake) the tile for a material at an orientation. Tiles are
// keyed by size so a zoomed-in arena and a shop chip don't fight over
// one resolution.
export function materialTile(hex, finish, sizePx, ang) {
  if (!isMaterial(finish)) return null;
  // Quantise the size so smooth zooming doesn't bake a new set each
  // frame; the blit scales the small difference away invisibly.
  const size = Math.max(24, Math.min(256, 1 << Math.ceil(Math.log2(sizePx))));
  const b = bucketOf(ang);
  const key = `${finish}|${hex}|${size}|${b}`;
  let tile = cache.get(key);
  if (tile) return tile;
  tile = renderTile(hex, finish, size, (b / BUCKETS) * Math.PI * 2);
  cacheBytes += size * size * 4;
  if (cacheBytes > CACHE_LIMIT) { cache.clear(); cacheBytes = size * size * 4; }
  cache.set(key, tile);
  return tile;
}

/* ---------- what the renderers call ---------- */

// Paint a material across the CURRENT CLIP, centred on the local
// origin. One drawImage: this is the whole per-frame cost.
export function paintMaterial(ctx, hex, finish, R, ang = 0) {
  const want = R * 2.6;
  const tile = materialTile(hex, finish, want, ang);
  if (!tile) return false;
  ctx.drawImage(tile, -want / 2, -want / 2, want, want);
  return true;
}

// A fill style for a material, for callers that must fill arbitrary
// shapes (pattern overlays). Falls back to the flat hex if patterns
// with transforms aren't available.
export function materialFill(ctx, hex, finish, R, ang = 0) {
  if (!isMaterial(finish)) return hex;
  const want = R * 2.6;
  const tile = materialTile(hex, finish, want, ang);
  if (!tile) return hex;
  try {
    const p = ctx.createPattern(tile, "no-repeat");
    const M = typeof DOMMatrix !== "undefined" ? new DOMMatrix() : null;
    if (p && p.setTransform && M) {
      p.setTransform(M.translate(-want / 2, -want / 2).scale(want / tile.width));
      return p;
    }
  } catch (e) { /* fall through to a flat fill */ }
  return hex;
}

// Kept so older call sites don't break: the structure is part of the
// shading now, so there is nothing extra to draw afterwards.
export function materialDetail() { /* folded into the tile */ }

// A shop chip: the material on a rounded tile, at a fixed presentation
// angle chosen so the highlight falls across it.
export function paintMaterialChip(ctx, hex, finish, R, ang = 0.55) {
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(-R * 0.9, -R * 0.9, R * 1.8, R * 1.8, R * 0.42);
  else ctx.rect(-R * 0.9, -R * 0.9, R * 1.8, R * 1.8);
  if (!isMaterial(finish)) { ctx.fillStyle = hex; ctx.fill(); return; }
  ctx.save();
  ctx.clip();
  paintMaterial(ctx, hex, finish, R * 1.05, ang);
  ctx.restore();
}
