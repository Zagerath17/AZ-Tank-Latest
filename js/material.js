// ================================================================
// material.js — the special paints: ONE colour, shaded with real PBR.
//
// WHAT WENT WRONG BEFORE
//
// The last version cut facets into the gemstones and brushed grain into
// the metals. Physically that's defensible, but at the size a tank is
// actually drawn — a couple of dozen pixels — that structure stops
// reading as a surface and starts reading as a PATTERN painted on the
// hull. Which is exactly the complaint.
//
// So there is no structure here at all. Each material is a single flat
// colour. Everything you see on it is lighting:
//
//   • a NORMAL for every pixel, from the hull's own signed distance
//     field — a domed casting, so the surface genuinely curves;
//   • a Cook-Torrance microfacet BRDF — GGX distribution, Smith
//     height-correlated masking, Schlick Fresnel;
//   • F0 taken from the paint itself, lifted to the reflectance a real
//     metal has, because a conductor's colour IS its specular and it
//     has no diffuse whatsoever;
//   • an environment sampled by the reflection vector, blurred by
//     roughness.
//
// What separates gold from silver is F0. What separates polished from
// satin is roughness. What separates a stone from a metal is that the
// stone is a dielectric and light travels through it. Nothing is
// decorated, tinted twice, or drawn on top.
//
// NOTHING IS ANIMATED. The light is fixed in WORLD space and rotated
// into the tank's frame, so a parked tank is perfectly still while a
// turning one sweeps its reflection exactly as real metal does. Every
// (material, orientation) is rasterised ONCE into a cached tile and
// then blitted, so painting a tank costs a single image draw.
// ================================================================

import { SUN } from "./scene.js";

// A material is described by physics alone.
//   metal  — a conductor has no diffuse; its colour lives in F0.
//   rough  — width of the specular lobe; 0 is a mirror.
//   ior    — for the transparent stones, which are not metals.
//   envMul — how strongly it picks up its surroundings.
//   dome   — how domed the casting is, which sets how far the
//            reflection sweeps across it as the tank turns.
const MATERIALS = {
  // F0 is the measured reflectance of the real metal, not the swatch
  // colour — that is what makes gold look like gold rather than a
  // yellow-painted mirror. Roughness separates them further: cast
  // bronze is satin, silver is a near-mirror, platinum is greyer and
  // softer than silver, gold sits between.
  bronze:   { metal: 1, rough: 0.34, envMul: 1.10, dome: 0.84, f0: [0.955, 0.638, 0.538] },
  silver:   { metal: 1, rough: 0.045, envMul: 1.70, dome: 0.88, f0: [0.972, 0.960, 0.915] },
  gold:     { metal: 1, rough: 0.13,  envMul: 1.55, dome: 0.86, f0: [1.000, 0.766, 0.336] },
  platinum: { metal: 1, rough: 0.23, envMul: 1.28, dome: 0.84, f0: [0.679, 0.642, 0.588] },
  // Every OTHER paint in the game. Not a conductor — pigment under a
  // clear coat — so it keeps a full diffuse response and only picks up
  // a soft sheen and a single sun highlight. Enough to sit in the same
  // light as the concrete and the brickwork without turning chrome.
  flat:     { metal: 0.30, rough: 0.34, envMul: 1.00, dome: 0.78, coat: 1 },
  // The stones are dielectrics: light enters, is absorbed on the way
  // through, and returns carrying the stone's own colour.
  diamond:  { metal: 0, rough: 0.02, ior: 2.42, envMul: 2.4, dome: 0.90,
              absorb: [0.05, 0.04, 0.02], body: 0.42 },
  ruby:     { metal: 0, rough: 0.05, ior: 1.77, envMul: 1.20, dome: 0.88,
              absorb: [0.05, 1.9, 1.5], body: 1.8 },
};

export const FINISHES = [...Object.keys(MATERIALS)];
// Everything is shaded now — a plain colour is just a rougher, mostly
// dielectric material. Anything unrecognised falls back to that.
export function isMaterial(finish) {
  return true;
}
function matOf(finish) { return MATERIALS[finish] || MATERIALS.flat; }

// The key light, in WORLD radians, plus its elevation. Fixed in the
// world: the tank turns under it.
// The light is no longer invented here. It is the arena's sun, the same
// one the concrete and the brickwork are shaded by — which is the whole
// reason these materials never looked like they were standing in the
// scene. Import it so there is exactly one light in the game.
const LIGHT_A = SUN.az;
const LIGHT_Z = Math.sin(SUN.el);
const LIGHT_I = SUN.intensity;

/* ---------- helpers ---------- */

const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
function norm3(v) {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}
const sat = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
// The BRDF is evaluated in LINEAR light; skipping this is the usual
// reason hand-tuned shading comes out chalky.
const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
// Linear -> sRGB, via a lookup table. This runs three times for every
// pixel of every baked tile, and Math.pow is expensive enough that the
// profile showed it as a measurable slice of raster time all on its own.
// 1024 entries is far finer than the 8-bit output can express.
const SRGB_N = 1024;
const SRGB_LUT = new Float32Array(SRGB_N + 1);
for (let i = 0; i <= SRGB_N; i++) {
  const c = i / SRGB_N;
  SRGB_LUT[i] = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}
const toSRGB = (c) => SRGB_LUT[(c <= 0 ? 0 : c >= 1 ? SRGB_N : (c * SRGB_N) | 0)];

function hexToLinear(hex) {
  const n = parseInt(String(hex).slice(1), 16) || 0;
  return [
    toLinear(((n >> 16) & 255) / 255),
    toLinear(((n >> 8) & 255) / 255),
    toLinear((n & 255) / 255),
  ];
}

/* ---------- the environment ---------- */

// A small procedural surrounding: ground below the horizon, sky above,
// a sun, and a soft band just above the horizon like a studio light.
// Deliberately NEUTRAL — a strongly coloured room multiplied by gold's
// F0 comes back olive, and the metal loses its own identity.
function sampleEnv(r, rough, out) {
  const up = r[2];
  const blur = rough * rough;
  const t = sat(up * 0.5 + 0.5);
  // The horizon sharpens as roughness falls: that hard sky/ground join
  // is what says "polished" rather than "grey paint".
  const edge = sat((t - 0.5) / Math.max(0.02, blur * 0.9 + 0.02) * 0.5 + 0.5);
  // What a tank in THIS arena actually stands in: open sky above, grey
  // concrete below, a crisp horizon between them. The contrast across
  // that join is what the eye reads as polish, and the colours match the
  // ground it is parked on so the reflection belongs to the scene.
  const skyR = SUN.sky[0] * (0.42 + 1.15 * t);
  const skyG = SUN.sky[1] * (0.42 + 1.15 * t);
  const skyB = SUN.sky[2] * (0.44 + 1.18 * t);
  const g = 0.05;
  const gr = g * SUN.bounce[0] * 6.0, gg = g * SUN.bounce[1] * 6.0, gb = g * SUN.bounce[2] * 5.6;
  out[0] = gr + (skyR - gr) * edge;
  out[1] = gg + (skyG - gg) * edge;
  out[2] = gb + (skyB - gb) * edge;

  // (A narrow Gaussian glow used to sit just above the horizon here. On a
  // near-flat hull it swept across the whole piece as the tank turned and
  // showed up as a hard white bar at certain angles. The sky/ground join
  // above already gives the horizon its definition, so the extra stripe
  // was doing nothing but that.)

  const lz = LIGHT_Z, lr = Math.sqrt(Math.max(0, 1 - lz * lz));
  const L = [Math.cos(LIGHT_A) * lr, Math.sin(LIGHT_A) * lr, lz];
  const d = sat(dot3(r, L));
  const tight = 1 / Math.max(0.006, blur * 0.7 + 0.006);
  const sun = Math.pow(d, tight) * (2.2 + 6 * (1 - rough));
  out[0] += sun * SUN.color[0]; out[1] += sun * SUN.color[1]; out[2] += sun * SUN.color[2];

  // A dim bounce from behind, so shadowed metal isn't dead black.
  const f = sat(-dot3(r, L)) * 0.10;
  out[0] += f * 0.5; out[1] += f * 0.55; out[2] += f * 0.7;
}

/* ---------- Cook-Torrance ---------- */

function D_GGX(NoH, a) {
  const a2 = a * a;
  const d = NoH * NoH * (a2 - 1) + 1;
  return a2 / (Math.PI * d * d + 1e-7);
}
function V_SmithGGX(NoV, NoL, a) {
  const a2 = a * a;
  const gv = NoL * Math.sqrt(NoV * NoV * (1 - a2) + a2);
  const gl = NoV * Math.sqrt(NoL * NoL * (1 - a2) + a2);
  return 0.5 / (gv + gl + 1e-7);
}
function F_Schlick(VoH, f0, out) {
  const f = Math.pow(1 - VoH, 5);
  out[0] = f0[0] + (1 - f0[0]) * f;
  out[1] = f0[1] + (1 - f0[1]) * f;
  out[2] = f0[2] + (1 - f0[2]) * f;
}

// Signed distance to a rounded box, negative inside: the hull's real
// silhouette, so the normals from it are the hull's real normals.
function sdRoundBox(px, py, hx, hy, r) {
  const qx = Math.abs(px) - hx + r;
  const qy = Math.abs(py) - hy + r;
  const ox = Math.max(qx, 0), oy = Math.max(qy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - r;
}

/* ---------- the tile renderer ---------- */

const BUCKETS = 48;                       // 7.5° apart: below what reads as stepping
const cache = new Map();
let cacheBytes = 0;
const CACHE_LIMIT = 24 * 1024 * 1024;

export function bucketOf(ang) {
  const n = ((ang % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
  return Math.round(n / (Math.PI * 2) * BUCKETS) % BUCKETS;
}

function renderTile(hex, finish, size, ang) {
  const M = matOf(finish);
  const cv = typeof OffscreenCanvas !== "undefined"
    ? new OffscreenCanvas(size, size)
    : document.createElement("canvas");
  cv.width = size; cv.height = size;
  const c2 = cv.getContext("2d");
  const img = c2.createImageData(size, size);
  const px = img.data;

  const base = hexToLinear(hex);
  const metalness = M.metal ?? 0;
  let f0;
  if (metalness > 0 && metalness < 1) {
    // A painted panel: pigment under a clear coat. Its F0 is the coat's
    // (about 4%), nudged toward the paint by the metallic flake in it.
    // Its colour still comes from DIFFUSE, which is what keeps a red
    // tank red instead of turning it into red chrome.
    f0 = [0, 1, 2].map((i) => sat(0.04 * (1 - metalness) + base[i] * metalness));
  } else if (M.f0) {
    // A measured conductor: its own reflectance spectrum, tinted a
    // little by the paint so the shop swatch still matches the tank.
    f0 = [0, 1, 2].map((i) => sat(M.f0[i] * 0.82 + base[i] * 0.18));
  } else if (metalness >= 1) {
    // A conductor's F0 IS its colour. This is the paint you bought,
    // lifted to the reflectance real metal has — same hue, physical
    // brightness — which is what keeps each material one recognisable
    // colour instead of drifting toward grey.
    // Normalising the hue to full saturation alone turns bronze into
    // traffic-cone orange: no real metal is that pure. Real conductors
    // reflect strongly in EVERY channel and merely favour some — gold's
    // measured F0 still returns a third of the blue that hits it. So
    // the paint's hue is carried at full strength and then pulled part
    // of the way toward a bright neutral, which lands bronze and gold
    // almost exactly on their measured values while leaving silver and
    // platinum untouched (they were already neutral).
    const mx = Math.max(base[0], base[1], base[2], 1e-3);
    const k = 0.32;                          // how metallic-neutral to go
    f0 = [0, 1, 2].map((i) => sat((base[i] / mx) * 0.97 * (1 - k) + 0.92 * k));
  } else {
    const r = (M.ior - 1) / (M.ior + 1);
    const v = r * r;
    f0 = [v, v, v];
  }

  const half = size * 0.5;
  const hx = size * 0.46, hy = size * 0.46, corner = size * 0.13;
  // The roll-off spans most of the piece, so the surface is a domed
  // casting and its normals vary everywhere. With a thin bevel the
  // middle is one flat plane sampling the environment identically at
  // every pixel, and the result is a coloured slab.
  const dome = size * 0.46 * (M.dome ?? 0.8);

  const V = [0, 0, 1];                      // top-down view
  const N = [0, 0, 1];                      // scratch, reused per pixel
  const lz = LIGHT_Z, lr = Math.sqrt(Math.max(0, 1 - lz * lz));
  // The light lives in the WORLD, so in the tile's own frame it sits at
  // (LIGHT_A − ang). This one line is what anchors the reflection.
  const la = LIGHT_A - ang;
  const L = [Math.cos(la) * lr, Math.sin(la) * lr, lz];

  const env = [0, 0, 0], F = [0, 0, 0], R = [0, 0, 0];
  const aRough = Math.max(0.015, M.rough);
  const alpha = aRough * aRough;
  const em = M.envMul ?? 1;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const o = (y * size + x) * 4;
      const lxp = x + 0.5 - half, lyp = y + 0.5 - half;

      const d = sdRoundBox(lxp, lyp, hx, hy, corner);
      if (d > 0.7) { px[o + 3] = 0; continue; }

      // --- normal: one smooth dome, no structure of any kind ---------
      const h = (tt) => {
        const k = sat((-tt) / dome);         // 0 at the edge, 1 inside
        return Math.sqrt(sat(1 - (1 - k) * (1 - k)));
      };
      const e = 0.8;
      const dx = h(sdRoundBox(lxp + e, lyp, hx, hy, corner)) - h(sdRoundBox(lxp - e, lyp, hx, hy, corner));
      const dy = h(sdRoundBox(lxp, lyp + e, hx, hy, corner)) - h(sdRoundBox(lxp, lyp - e, hx, hy, corner));
      const ns = dome * 0.55 / e;
      let nx = -dx * ns, ny = -dy * ns;

      // The edge roll-off above FLATTENS OUT once you are more than
      // `dome` from the rim — every pixel across the middle of the piece
      // ended up with the same normal (0,0,1), reflecting one single
      // direction of the room and coming back one flat colour. That is
      // the whole reason these read as matte no matter how good the BRDF
      // underneath is. A gentle curvature across the entire casting makes
      // the reflection sweep from sky to ground the way it does on a real
      // panel, which is what actually looks like metal.
      const ux = lxp / hx, uy = lyp / hy;          // -1..1 across the piece
      const CURVE = 1.85;
      nx += ux * CURVE;
      ny += uy * CURVE;

      // Fine brushed grain, so the reflection has something to break up
      // on. Rough finishes get more of it; a mirror gets almost none.
      const grainAmt = 0.05 + aRough * 0.55;
      const gph = lxp * 0.9 + lyp * 0.15;
      nx += Math.sin(gph) * 0.012 * grainAmt;
      ny += Math.cos(gph * 1.7) * 0.010 * grainAmt;

      // Inlined rather than norm3([...]) — that allocated two arrays for
      // every pixel of every tile, and with every paint in the game now
      // being shaded that was the single biggest cost in baking one.
      const ninv = 1 / Math.sqrt(nx * nx + ny * ny + 1);
      const Nx = nx * ninv, Ny = ny * ninv, Nz = ninv;
      N[0] = Nx; N[1] = Ny; N[2] = Nz;

      const NoV = sat(Nz);                       // V is (0,0,1)
      const NoL = Nx * L[0] + Ny * L[1] + Nz * L[2];

      // --- direct specular ------------------------------------------
      let rr = 0, gg = 0, bb = 0;
      if (NoL > 1e-4) {
        const H = norm3([L[0] + V[0], L[1] + V[1], L[2] + V[2]]);
        const NoH = sat(dot3(N, H));
        const VoH = sat(dot3(V, H));
        const spec = D_GGX(NoH, alpha) * V_SmithGGX(Math.max(NoV, 1e-4), NoL, alpha) * LIGHT_I * NoL;
        F_Schlick(VoH, f0, F);
        rr = spec * F[0]; gg = spec * F[1]; bb = spec * F[2];
      }

      // --- environment reflection ------------------------------------
      const NdV = Nz;                            // dot(N, (0,0,1))
      R[0] = 2 * NdV * Nx;
      R[1] = 2 * NdV * Ny;
      R[2] = 2 * NdV * Nz - 1;
      sampleEnv(R, aRough, env);
      F_Schlick(NoV, f0, F);                 // grazing pixels reflect more
      rr += env[0] * F[0] * em;
      gg += env[1] * F[1] * em;
      bb += env[2] * F[2] * em;

      // --- diffuse -------------------------------------------------
      // A conductor has none. Everything else does, and for the painted
      // colours it is the ENTIRE reason they look like their colour.
      // Without this every ordinary paint renders almost black, since
      // its 4% specular is all that would be left.
      if (metalness < 1) {
        const kd = 1 - metalness;
        const wrap = sat((NoL + 0.28) / 1.28);      // soft terminator
        const sunD = wrap * LIGHT_I * 0.30;
        // Ambient: sky from above, bounce off the concrete from below.
        const up = sat(N[2]);
        const ambR = SUN.sky[0] * 0.30 * up + SUN.bounce[0] * 0.22;
        const ambG = SUN.sky[1] * 0.30 * up + SUN.bounce[1] * 0.22;
        const ambB = SUN.sky[2] * 0.30 * up + SUN.bounce[2] * 0.22;
        rr += base[0] * kd * (sunD * SUN.color[0] + ambR);
        gg += base[1] * kd * (sunD * SUN.color[1] + ambG);
        bb += base[2] * kd * (sunD * SUN.color[2] + ambB);
      }

      // --- body (transparent stones only) ---------------------------
      if (M.absorb) {
        // Light that went into the stone, was absorbed along its path,
        // and came back out. Deeper parts read darker and more
        // saturated, which is all a gem's depth actually is.
        const depth = sat(1 - (-d) / (dome * 0.95));
        const path = 0.35 + depth * 1.5;
        const ab = M.absorb ?? [0.02, 0.02, 0.02];
        const thru = (0.22 + 0.78 * sat(NoL)) * (M.body ?? 1);
        rr += base[0] * thru * Math.exp(-ab[0] * path * 3) * 1.6;
        gg += base[1] * thru * Math.exp(-ab[1] * path * 3) * 1.6;
        bb += base[2] * thru * Math.exp(-ab[2] * path * 3) * 1.6;
      }

      // --- tonemap on LUMINANCE, then encode -------------------------
      // Compressing each channel separately squeezes a bright one harder
      // than a dim one, which drags every colour toward grey exactly
      // where a metal is brightest — that is why gold kept coming out
      // olive. Scaling all three by one luminance-derived factor keeps
      // the ratio between them, so the hue survives.
      const lum = 0.2126 * rr + 0.7152 * gg + 0.0722 * bb;
      if (lum > 1e-6) {
        const k = (lum / (1 + lum)) / lum;
        rr *= k; gg *= k; bb *= k;
        const bleach = sat((lum - 2.2) / 6);   // only blinding returns go white
        if (bleach > 0) {
          rr += (1 - rr) * bleach; gg += (1 - gg) * bleach; bb += (1 - bb) * bleach;
        }
      }
      px[o] = Math.round(toSRGB(sat(rr)) * 255);
      px[o + 1] = Math.round(toSRGB(sat(gg)) * 255);
      px[o + 2] = Math.round(toSRGB(sat(bb)) * 255);
      px[o + 3] = Math.round(sat(0.5 - d) * 255);   // antialias the silhouette
    }
  }
  c2.putImageData(img, 0, 0);
  return cv;
}

// How finely a material needs to be re-baked as the tank turns. A mirror
// sweeps its reflection fast and needs every step; a satin paint barely
// changes, so it can share far fewer tiles. This matters: EVERY paint is
// shaded now, and baking 48 orientations of all of them would hitch on
// the first frame of a full lobby for no visible gain.
function bucketsFor(finish) {
  const M = matOf(finish);
  if ((M.metal ?? 0) >= 1 || M.absorb) return BUCKETS;   // specials: full
  return 16;                             // painted: blended, so coarse is fine
}

// Fetch (or bake) one specific orientation.
function tileAt(hex, finish, sizePx, b, nb) {
  const size = Math.max(24, Math.min(256, 1 << Math.ceil(Math.log2(sizePx))));
  const key = `${finish}|${hex}|${size}|${b}/${nb}`;
  let tile = cache.get(key);
  if (tile) return tile;
  tile = renderTile(hex, finish, size, (b / nb) * Math.PI * 2);
  cacheBytes += size * size * 4;
  if (cacheBytes > CACHE_LIMIT) { cache.clear(); cacheBytes = size * size * 4; }
  cache.set(key, tile);
  return tile;
}

export function materialTile(hex, finish, sizePx, ang) {
  // Quantise the size so smooth zooming doesn't bake a fresh set every
  // frame; the blit scales the small difference away invisibly.
  const size = Math.max(24, Math.min(256, 1 << Math.ceil(Math.log2(sizePx))));
  const nb = bucketsFor(finish);
  const two = Math.PI * 2;
  const b = Math.round((((ang % two) + two) % two) / two * nb) % nb;
  const key = `${finish}|${hex}|${size}|${b}/${nb}`;
  let tile = cache.get(key);
  if (tile) return tile;
  tile = renderTile(hex, finish, size, (b / nb) * two);
  cacheBytes += size * size * 4;
  if (cacheBytes > CACHE_LIMIT) { cache.clear(); cacheBytes = size * size * 4; }
  cache.set(key, tile);
  return tile;
}

/* ---------- what the renderers call ---------- */

// Paint a material across the CURRENT CLIP, centred on the local
// origin. One drawImage: the whole per-frame cost.
// Bake every orientation a paint will need, up front.
//
// Tiles are baked on demand, which means the FIRST time a tank presents
// a new angle the game stops to shade a few thousand pixels. Spread over
// a round that is a series of small hitches exactly when tanks start
// turning — i.e. the moment the fighting starts. There is a three second
// countdown doing nothing but counting, so the work goes there instead.
export function prebakeCount(finish) {
  return isMaterial(finish) ? bucketsFor(finish) : 0;
}

// Bake exactly ONE orientation. Baking a whole paint in a single call
// takes long enough to stall a frame on its own, so the caller drains
// these a few at a time against a time budget — the work still finishes
// before the round starts, but nothing ever blocks.
export function prebakeStep(hex, finish, sizePx, i) {
  if (!isMaterial(finish)) return false;
  const nb = bucketsFor(finish);
  if (i < 0 || i >= nb) return false;
  tileAt(hex, finish, sizePx, i, nb);
  return true;
}

export function paintMaterial(ctx, hex, finish, R, ang = 0) {
  const want = R * 2.6;
  const nb = bucketsFor(finish);
  const two = Math.PI * 2;
  const f = ((((ang % two) + two) % two) / two) * nb;
  const b0 = Math.floor(f) % nb, b1 = (b0 + 1) % nb;
  const mix = f - Math.floor(f);
  const t0 = tileAt(hex, finish, want, b0, nb);
  if (!t0) return false;
  ctx.drawImage(t0, -want / 2, -want / 2, want, want);
  // CROSS-FADE into the next orientation. Snapping from one baked angle
  // to the next is what made the highlight jump around in steps like
  // stop-motion; blending the two nearest makes the reflection travel
  // continuously at whatever frame rate the game is running.
  if (mix > 0.02) {
    const t1 = tileAt(hex, finish, want, b1, nb);
    if (t1) {
      const a0 = ctx.globalAlpha;
      ctx.globalAlpha = a0 * mix;
      ctx.drawImage(t1, -want / 2, -want / 2, want, want);
      ctx.globalAlpha = a0;
    }
  }
  return true;
}

// A fill style, for callers that must fill arbitrary shapes (a pattern
// overlay whose second colour is a material).
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

// Kept so older call sites don't break: the shading is the material now,
// so there is nothing extra to draw afterwards.
export function materialDetail() { /* nothing: the tile is the material */ }

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
