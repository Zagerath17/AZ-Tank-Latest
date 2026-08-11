// ================================================================
// scene.js — the arena's ground, its walls, and the light that falls
// on all of it.
//
// There is ONE sun, defined here and exported, and everything in the
// game reads it: the shading baked into the concrete, the relief on the
// brickwork, the shadows the walls drop, and the specular on every tank
// material. That shared direction is what makes the scene hang together
// — a tank lit from the top-left standing on ground lit from the
// bottom-right reads as a sticker, however good the shader is.
//
// The floor is generated ONCE for the whole arena at its real size. It
// is not a tile: there is no repeat anywhere in it, because every crack,
// stain and tuft is placed independently across the full world from a
// seeded stream. Detail is sized against the TANK, not the screen — a
// tank is about 35 px across, so cracks are hairlines, aggregate is
// single pixels, and a clump of grass is a few px tall.
// ================================================================

// Where the light comes FROM. Elevation is high (it's the sun, roughly
// mid-morning) but not straight overhead, so surfaces still have a lit
// side and a shaded side to read form from.
export const SUN = {
  az: -2.30,                       // azimuth, radians
  el: 0.90,                        // elevation above the ground plane
  color: [1.00, 0.965, 0.905],     // slightly warm
  intensity: 3.1,
  sky: [0.42, 0.50, 0.62],         // cool bounce from the sky dome
  bounce: [0.30, 0.30, 0.29],      // dim grey bounce off the concrete
};

// Unit vector pointing at the sun (+z is up out of the arena).
export const SUN_DIR = (() => {
  const c = Math.cos(SUN.el);
  return [Math.cos(SUN.az) * c, Math.sin(SUN.az) * c, Math.sin(SUN.el)];
})();

// Which way a shadow falls on the ground, and how long, for something of
// unit height. Straight from the sun's elevation.
export const SHADOW = (() => {
  const len = 1 / Math.tan(SUN.el);
  return { dx: -Math.cos(SUN.az) * len, dy: -Math.sin(SUN.az) * len, len };
})();

/* ---------- deterministic noise ---------- */

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

// Value noise with smooth interpolation — used for the broad mottling in
// the concrete. Cheap, and good enough under a layer of grain.
function makeNoise(seed) {
  const P = new Uint8Array(512);
  const r = rng(seed);
  for (let i = 0; i < 256; i++) P[i] = (r() * 256) | 0;
  for (let i = 0; i < 256; i++) P[256 + i] = P[i];
  const fade = (t) => t * t * (3 - 2 * t);
  const at = (xi, yi) => P[(P[xi & 255] + (yi & 255)) & 511] / 255;
  return (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const u = fade(xf), v = fade(yf);
    const a = at(xi, yi), b = at(xi + 1, yi);
    const c = at(xi, yi + 1), d = at(xi + 1, yi + 1);
    return (a + (b - a) * u) + ((c + (d - c) * u) - (a + (b - a) * u)) * v;
  };
}

/* ---------- palette ---------- */
// The floor is a mid, slightly warm grey; the walls are markedly darker
// so the two never read as the same material at a glance.
const FLOOR = { r: 166, g: 166, b: 161 };
const WALL = { r: 96, g: 98, b: 101 };

/* ---------- the ground ---------- */

let cache = null;   // { key, floor, walls, w, h }

function newCanvas(w, h) {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.ceil(w));
  c.height = Math.max(1, Math.ceil(h));
  return c;
}

// Broad tonal variation: old concrete is poured in patches, stained, and
// worn unevenly. Rendered at a fraction of the resolution and scaled up,
// because none of this has any business being pixel-sharp.
function paintBase(g, w, h, seed) {
  const SCALE = 3;
  const bw = Math.max(2, Math.ceil(w / SCALE)), bh = Math.max(2, Math.ceil(h / SCALE));
  const tmp = newCanvas(bw, bh);
  const tg = tmp.getContext("2d");
  const img = tg.createImageData(bw, bh);
  const px = img.data;
  const n1 = makeNoise(seed), n2 = makeNoise(seed ^ 0x9e37), n3 = makeNoise(seed ^ 0x51ed);
  // Cell sizes are in WORLD px, so the look doesn't change with arena size.
  const s1 = SCALE / 210, s2 = SCALE / 62, s3 = SCALE / 17;
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      const broad = n1(x * s1, y * s1);
      const mid = n2(x * s2, y * s2);
      const fine = n3(x * s3, y * s3);
      // Mostly broad patches, with progressively less of the finer bands.
      let v = (broad - 0.5) * 26 + (mid - 0.5) * 15 + (fine - 0.5) * 8;
      // A few darker damp patches, so it isn't uniformly mottled.
      const damp = Math.max(0, broad - 0.66) * 3;
      v -= damp * 26;
      const o = (y * bw + x) * 4;
      px[o] = FLOOR.r + v;
      px[o + 1] = FLOOR.g + v;
      px[o + 2] = FLOOR.b + v * 0.92;
      px[o + 3] = 255;
    }
  }
  tg.putImageData(img, 0, 0);
  g.imageSmoothingEnabled = true;
  g.drawImage(tmp, 0, 0, w, h);
}

// Exposed aggregate: the little stones in the mix. One pixel each, lit
// on the sun side and shadowed opposite, which is what stops the floor
// reading as flat paper.
function paintAggregate(g, w, h, seed) {
  const r = rng(seed ^ 0x2f1a);
  const count = Math.floor((w * h) / 190);
  const lx = Math.sign(Math.cos(SUN.az)), ly = Math.sign(Math.sin(SUN.az));
  for (let i = 0; i < count; i++) {
    const x = r() * w, y = r() * h;
    const s = 0.6 + r() * 1.5;
    const tone = r();
    if (tone > 0.55) {
      g.fillStyle = `rgba(214,213,206,${0.10 + r() * 0.16})`;
      g.fillRect(x, y, s, s);
      g.fillStyle = `rgba(58,58,56,${0.07 + r() * 0.09})`;      // its own shadow
      g.fillRect(x - lx * s, y - ly * s, s * 0.8, s * 0.8);
    } else {
      g.fillStyle = `rgba(74,74,72,${0.06 + r() * 0.13})`;
      g.fillRect(x, y, s, s);
    }
  }
}

// A crack system: one main run that wanders across the slab, throwing off
// shorter branches. Drawn as a dark fissure with a lit lip on the sun
// side, so it reads as a groove rather than a pen line.
function crackRun(g, r, x, y, ang, len, width, depth, out) {
  const lipX = Math.cos(SUN.az) * 0.8, lipY = Math.sin(SUN.az) * 0.8;
  let cx = x, cy = y, a = ang;
  const pts = [{ x: cx, y: cy }];
  const steps = Math.max(3, Math.floor(len / 7));
  for (let i = 0; i < steps; i++) {
    a += (r() - 0.5) * 0.85;
    cx += Math.cos(a) * 7;
    cy += Math.sin(a) * 7;
    pts.push({ x: cx, y: cy });
  }
  const stroke = (dx, dy, style, wid) => {
    g.strokeStyle = style;
    g.lineWidth = wid;
    g.lineCap = "round";
    g.lineJoin = "round";
    g.beginPath();
    g.moveTo(pts[0].x + dx, pts[0].y + dy);
    for (let i = 1; i < pts.length; i++) g.lineTo(pts[i].x + dx, pts[i].y + dy);
    g.stroke();
  };
  // Lit lip first, then the dark fissure over it.
  stroke(lipX, lipY, `rgba(226,225,217,${0.16 * depth})`, width * 1.5);
  stroke(0, 0, `rgba(48,49,48,${0.34 + 0.30 * depth})`, width);
  stroke(0, 0, `rgba(26,27,26,${0.22 * depth})`, width * 0.45);
  out.push(...pts);

  if (len > 34 && r() < 0.85) {
    const bi = 1 + Math.floor(r() * (pts.length - 2));
    const b = pts[bi];
    crackRun(g, r, b.x, b.y, a + (r() < 0.5 ? 1 : -1) * (0.5 + r() * 0.7),
             len * (0.35 + r() * 0.3), Math.max(0.5, width * 0.62), depth * 0.8, out);
  }
}

// Weeds pushing up through a crack. Small — a few pixels — because a
// tank is only ~35 px wide and knee-high grass would look absurd.
function paintGrass(g, r, x, y, scale) {
  const blades = 3 + Math.floor(r() * 4);
  const hueBase = 96 + r() * 26;
  for (let i = 0; i < blades; i++) {
    const h = (2.6 + r() * 4.6) * scale;
    const lean = (r() - 0.5) * 1.5;
    const bx = x + (r() - 0.5) * 3.2 * scale;
    const by = y + (r() - 0.5) * 2.6 * scale;
    const light = 22 + r() * 20;
    g.strokeStyle = `hsla(${hueBase}, ${34 + r() * 22}%, ${light}%, ${0.55 + r() * 0.35})`;
    g.lineWidth = 0.7 + r() * 0.6;
    g.lineCap = "round";
    g.beginPath();
    g.moveTo(bx, by);
    g.quadraticCurveTo(bx + lean * h * 0.4, by - h * 0.6, bx + lean * h, by - h);
    g.stroke();
  }
  // A little moss at the base to seat it.
  g.fillStyle = `hsla(${hueBase - 6}, 30%, 20%, 0.30)`;
  g.beginPath();
  g.ellipse(x, y, 2.4 * scale, 1.5 * scale, 0, 0, Math.PI * 2);
  g.fill();
}

function buildFloor(w, h, seed) {
  const cv = newCanvas(w, h);
  const g = cv.getContext("2d");
  paintBase(g, w, h, seed);
  paintAggregate(g, w, h, seed);

  const r = rng(seed ^ 0x77ab);
  // Cracks scale with the ARENA, so a big map isn't sparser than a small
  // one — and every one is placed independently, so nothing repeats.
  const systems = Math.max(6, Math.floor((w * h) / 26000));
  const seams = [];
  for (let i = 0; i < systems; i++) {
    const x = r() * w, y = r() * h;
    crackRun(g, r, x, y, r() * Math.PI * 2, 40 + r() * 130,
             0.8 + r() * 1.1, 0.5 + r() * 0.5, seams);
  }
  // Old patch seams: long, straight, shallow.
  const seamCount = Math.max(2, Math.floor(w / 420));
  for (let i = 0; i < seamCount; i++) {
    const vertical = r() < 0.5;
    const p = r();
    g.strokeStyle = "rgba(60,61,60,0.20)";
    g.lineWidth = 1.1;
    g.beginPath();
    if (vertical) { g.moveTo(p * w, 0); g.lineTo(p * w + (r() - 0.5) * 30, h); }
    else { g.moveTo(0, p * h); g.lineTo(w, p * h + (r() - 0.5) * 30); }
    g.stroke();
  }

  // Greenery, mostly where water would sit: in the cracks.
  const tufts = Math.floor(seams.length * 0.20);
  for (let i = 0; i < tufts; i++) {
    const p = seams[Math.floor(r() * seams.length)];
    if (!p) continue;
    paintGrass(g, r, p.x + (r() - 0.5) * 4, p.y + (r() - 0.5) * 4, 0.8 + r() * 0.6);
  }
  // A scattering out in the open too, so it isn't only ever on a line.
  const strays = Math.floor((w * h) / 34000);
  for (let i = 0; i < strays; i++) {
    paintGrass(g, r, r() * w, r() * h, 0.55 + r() * 0.5);
  }

  // Broad dirt wash, low frequency, to break up any remaining evenness.
  const n = makeNoise(seed ^ 0x1234);
  for (let i = 0; i < Math.floor((w * h) / 9000); i++) {
    const x = r() * w, y = r() * h;
    const rad = 12 + n(x / 140, y / 140) * 46;
    const grd = g.createRadialGradient(x, y, 0, x, y, rad);
    const a = 0.05 + r() * 0.06;
    grd.addColorStop(0, `rgba(120,116,104,${a})`);
    grd.addColorStop(1, "rgba(120,116,104,0)");
    g.fillStyle = grd;
    g.beginPath();
    g.arc(x, y, rad, 0, Math.PI * 2);
    g.fill();
  }
  return cv;
}

/* ---------- the walls ---------- */

// Stone brick, lit by the same sun. Each slab is filled with courses of
// brick sized against the tank; the face catches the light on the sun
// side and falls into shade opposite, and the whole slab throws a soft
// shadow onto the concrete.
function buildWalls(w, h, rects, seed) {
  const cv = newCanvas(w, h);
  const g = cv.getContext("2d");
  const r = rng(seed ^ 0x5150);

  const BRICK_W = 21, COURSE = 9, MORTAR = 1.4;
  const lit = `rgba(214,216,219,`;
  const shade = `rgba(28,30,33,`;
  // Which edges face the light.
  const sx = Math.cos(SUN.az), sy = Math.sin(SUN.az);

  for (const rc of rects) {
    const { x, y, w: rw, h: rh } = rc;
    if (rw <= 0 || rh <= 0) continue;

    g.save();
    g.beginPath();
    g.rect(x, y, rw, rh);
    g.clip();

    g.fillStyle = `rgb(${WALL.r},${WALL.g},${WALL.b})`;
    g.fillRect(x, y, rw, rh);

    // Courses run along the slab's long axis.
    const horiz = rw >= rh;
    const along = horiz ? rw : rh;
    const across = horiz ? rh : rw;
    const courses = Math.max(1, Math.round(across / COURSE));
    const cH = across / courses;

    for (let c = 0; c < courses; c++) {
      const offset = (c % 2) * BRICK_W * 0.5;
      let p = -offset;
      while (p < along) {
        const bw = BRICK_W * (0.82 + r() * 0.36);
        const bx = horiz ? x + p : x + c * cH;
        const by = horiz ? y + c * cH : y + p;
        const bW = horiz ? bw : cH;
        const bH = horiz ? cH : bw;
        // Per-stone tone: no two the same.
        const t = (r() - 0.5) * 30;
        g.fillStyle = `rgb(${WALL.r + t},${WALL.g + t},${WALL.b + t})`;
        g.fillRect(bx + MORTAR * 0.5, by + MORTAR * 0.5,
                   Math.max(1, bW - MORTAR), Math.max(1, bH - MORTAR));
        // Bevel: the sun catches one pair of edges, the other two darken.
        g.fillStyle = lit + (0.16 + r() * 0.10) + ")";
        if (sx < 0) g.fillRect(bx + MORTAR * 0.5, by + MORTAR * 0.5, 1, Math.max(1, bH - MORTAR));
        else g.fillRect(bx + bW - MORTAR * 0.5 - 1, by + MORTAR * 0.5, 1, Math.max(1, bH - MORTAR));
        if (sy < 0) g.fillRect(bx + MORTAR * 0.5, by + MORTAR * 0.5, Math.max(1, bW - MORTAR), 1);
        else g.fillRect(bx + MORTAR * 0.5, by + bH - MORTAR * 0.5 - 1, Math.max(1, bW - MORTAR), 1);
        g.fillStyle = shade + (0.20 + r() * 0.12) + ")";
        if (sx < 0) g.fillRect(bx + bW - MORTAR * 0.5 - 1, by + MORTAR * 0.5, 1, Math.max(1, bH - MORTAR));
        else g.fillRect(bx + MORTAR * 0.5, by + MORTAR * 0.5, 1, Math.max(1, bH - MORTAR));
        // A chipped corner here and there.
        if (r() < 0.10) {
          g.fillStyle = shade + "0.22)";
          const cs = 1.5 + r() * 2;
          g.fillRect(bx + r() * Math.max(1, bW - cs), by + r() * Math.max(1, bH - cs), cs, cs);
        }
        p += bw;
      }
    }

    // The slab's own form: lit along the sun-facing edge, shaded opposite.
    const gx = sx < 0 ? x : x + rw, gy = sy < 0 ? y : y + rh;
    const grd = g.createLinearGradient(gx, gy, gx - sx * rw, gy - sy * rh);
    grd.addColorStop(0, "rgba(255,255,255,0.13)");
    grd.addColorStop(0.5, "rgba(255,255,255,0)");
    grd.addColorStop(1, "rgba(0,0,0,0.20)");
    g.fillStyle = grd;
    g.fillRect(x, y, rw, rh);
    g.restore();
  }
  return cv;
}

// Shadows the walls throw across the concrete. Drawn under the walls, in
// the direction the sun dictates, so the light has visible consequences.
function buildShadows(w, h, rects) {
  const cv = newCanvas(w, h);
  const g = cv.getContext("2d");
  const HEIGHT = 7;                       // how tall a wall reads
  const ox = SHADOW.dx * HEIGHT, oy = SHADOW.dy * HEIGHT;
  g.fillStyle = "rgba(24,26,28,0.30)";
  for (const rc of rects) g.fillRect(rc.x + ox, rc.y + oy, rc.w, rc.h);
  // A soft skirt so the edge isn't a hard cut.
  g.globalAlpha = 0.16;
  g.filter = "blur(2px)";
  for (const rc of rects) g.fillRect(rc.x + ox * 1.5 - 1, rc.y + oy * 1.5 - 1, rc.w + 2, rc.h + 2);
  g.filter = "none";
  g.globalAlpha = 1;
  return cv;
}

/* ---------- public ---------- */

// Build (or reuse) the arena art. Keyed on size, layout and seed, so it
// is generated once per round and simply blitted every frame after that.
export function buildScene(worldW, worldH, rects, seed) {
  const key = `${Math.round(worldW)}x${Math.round(worldH)}|${rects.length}|${seed}`;
  if (cache && cache.key === key) return cache;
  cache = {
    key,
    w: worldW, h: worldH,
    floor: buildFloor(worldW, worldH, seed >>> 0),
    walls: buildWalls(worldW, worldH, rects, seed >>> 0),
    shadow: buildShadows(worldW, worldH, rects),
  };
  return cache;
}

export function drawGround(ctx, scene) {
  if (!scene) return;
  ctx.drawImage(scene.floor, 0, 0);
}

export function drawWallLayer(ctx, scene) {
  if (!scene) return;
  ctx.drawImage(scene.shadow, 0, 0);
  ctx.drawImage(scene.walls, 0, 0);
}
