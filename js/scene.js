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
  az: -2.42,                       // azimuth, radians
  // Low enough to throw a real shadow. At this elevation anything one
  // unit tall lays a shadow about 1.5 units long, off to the side —
  // which is what gives the arena depth instead of looking lit from a
  // camera flash.
  el: 0.58,                        // elevation above the ground plane
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

// A canvas that is `d` device pixels per WORLD pixel. The returned
// context is pre-scaled, so every draw below stays in world units and
// simply lands on more pixels — a 1 px crack is still 1 world px wide,
// it is just no longer smeared across two screen pixels.
function newCanvas(w, h, d = 1) {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.ceil(w * d));
  c.height = Math.max(1, Math.ceil(h * d));
  const g = c.getContext("2d");
  g.scale(d, d);
  c.__wu = { w, h, d };          // world-unit size, for drawImage
  return c;
}

// Broad tonal variation: old concrete is poured in patches, stained, and
// worn unevenly. Rendered at a fraction of the resolution and scaled up,
// because none of this has any business being pixel-sharp.
function paintBase(g, w, h, seed, d = 1) {
  const SCALE = 3 / Math.min(2, d);
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

function buildFloor(w, h, seed, pad = 0, rects = [], d = 1, maze = null, cell = 96) {
  const cv = newCanvas(w, h, d);
  const g = cv.getContext("2d");
  paintBase(g, w, h, seed, d);
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
  paintOldTracks(g, w, h, seed ^ 0x33cd, pad, rects, maze, cell);
  return cv;
}

// Faint tread marks worn into the concrete: everything that has driven
// here before. Laid all over the arena but never THROUGH a wall — a
// track that crosses masonry instantly reads as wallpaper.
function segBlocked(rects, x1, y1, x2, y2) {
  for (const rc of rects) {
    // cheap: sample the segment against the slab
    for (let t = 0; t <= 1; t += 0.25) {
      const x = x1 + (x2 - x1) * t, y = y1 + (y2 - y1) * t;
      if (x > rc.x - 6 && x < rc.x + rc.w + 6 && y > rc.y - 6 && y < rc.y + rc.h + 6) return true;
    }
  }
  return false;
}

function paintOldTracks(g, w, h, seed, pad, rects, maze, cell) {
  if (!maze || !maze.H || !maze.V || !cell) return;
  const r = rng(seed);
  const HALF = 10.7, WIDTH = 7.3, PITCH = 5.9;   // a real tank's tread spacing
  const { cols, rows } = maze;

  // Tracks are ROUTED down the maze's open passages rather than fired
  // off in a straight line and cut short when they meet stone. Walking
  // the passage graph means a trail only ever appears where a tank could
  // actually have driven, and it never runs up to a wall and stops dead
  // against it.
  const open = (c, rw, dir) => {
    if (dir === 0) return rw > 0 && !maze.H[rw][c];              // north
    if (dir === 1) return rw < rows - 1 && !maze.H[rw + 1][c];   // south
    if (dir === 2) return c > 0 && !maze.V[rw][c];               // west
    return c < cols - 1 && !maze.V[rw][c + 1];                   // east
  };
  const inside = (c, rw) =>
    c >= 0 && c < cols && rw >= 0 && rw < rows && (!maze.inside || maze.inside[rw][c]);
  const DC = [0, 0, -1, 1], DR = [-1, 1, 0, 0];

  // Scale with the MAZE, not the pixel area: a bigger map has more
  // corridors, so it wants proportionally more history on the floor.
  const openCells = cols * rows;
  const runs = Math.max(10, Math.round(openCells * 1.1));

  g.save();
  g.lineCap = "butt";
  for (let i = 0; i < runs; i++) {
    let c = (r() * cols) | 0, rw = (r() * rows) | 0;
    if (!inside(c, rw)) continue;
    const hops = 2 + ((r() * 7) | 0);
    // Cell centres, in canvas coordinates.
    const way = [[(c + 0.5) * cell + pad, (rw + 0.5) * cell + pad]];
    let last = -1;
    for (let hnum = 0; hnum < hops; hnum++) {
      const opts = [];
      for (let d = 0; d < 4; d++) {
        if (d === last) continue;                   // don't double back
        if (!open(c, rw, d)) continue;
        if (!inside(c + DC[d], rw + DR[d])) continue;
        opts.push(d);
      }
      if (!opts.length) break;
      const d = opts[(r() * opts.length) | 0];
      c += DC[d]; rw += DR[d];
      last = d ^ 1;                                  // the way back
      way.push([(c + 0.5) * cell + pad, (rw + 0.5) * cell + pad]);
    }
    if (way.length < 2) continue;

    const fade = 0.045 + r() * 0.08;
    const bandL = [], bandR = [], cleats = [];
    // Walk the route as a smooth curve so turns through a junction arc
    // the way a tank would take them, instead of hinging at right angles.
    let px = way[0][0], py = way[0][1];
    let ang = Math.atan2(way[1][1] - py, way[1][0] - px);
    // How far short of a junction to start swinging onto the next leg.
    //
    // The trail used to drive at each cell CENTRE and only give up on it
    // once it was within a tread pitch. A tank cannot pivot on a point,
    // so by the time the turn began the corner had passed and the arc
    // swung wide — straight through the masonry on the outside of the
    // bend, which is what you can see running into the walls. Releasing
    // the waypoint early lets the curve start before the junction and
    // finish inside it, which is how the corner is actually taken.
    const LOOK = cell * 0.45;
    let hitStone = false;
    for (let k = 1; k < way.length && !hitStone; k++) {
      const [tx, ty] = way[k];
      const last = k === way.length - 1;
      let guard = 0;
      // The final waypoint is driven all the way onto; the rest are let
      // go of a lookahead early so the turn is already under way.
      const release = last ? PITCH : LOOK;
      while (Math.hypot(tx - px, ty - py) > release && guard++ < 400) {
        const want = Math.atan2(ty - py, tx - px);
        let da = ((want - ang + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
        ang += Math.max(-0.16, Math.min(0.16, da));   // a real turning circle
        const nx = px + Math.cos(ang) * PITCH, ny = py + Math.sin(ang) * PITCH;
        const ox = -Math.sin(ang), oy = Math.cos(ang);
        // Last line of defence: if the hull centre has still wandered
        // into stone, abandon the run rather than paint a track through
        // a wall. Cheap, and it cannot be defeated by a tuning mistake.
        let solid = false;
        for (const rc of rects) {
          if (nx > rc.x + pad - 1 && nx < rc.x + pad + rc.w + 1 &&
              ny > rc.y + pad - 1 && ny < rc.y + pad + rc.h + 1) { solid = true; break; }
        }
        if (solid) { hitStone = true; break; }
        // Collected, not stroked here. Stroking every step separately
        // meant four canvas strokes per 6 px of track, which is most of
        // what made a round take a moment to start.
        bandL.push([nx + ox * HALF * -1, ny + oy * HALF * -1]);
        bandR.push([nx + ox * HALF, ny + oy * HALF]);
        cleats.push([nx, ny, ox, oy]);
        px = nx; py = ny;
      }
    }
    // Two strokes for the bands and one for every cleat on this run.
    g.lineWidth = WIDTH;
    g.strokeStyle = `rgba(96,96,94,${fade})`;
    for (const band of [bandL, bandR]) {
      if (band.length < 2) continue;
      g.beginPath();
      g.moveTo(band[0][0], band[0][1]);
      for (let k = 1; k < band.length; k++) g.lineTo(band[k][0], band[k][1]);
      g.stroke();
    }
    g.lineWidth = 1.6;
    g.strokeStyle = `rgba(70,70,68,${fade * 1.5})`;
    g.beginPath();
    for (const [cx2, cy2, ox2, oy2] of cleats) {
      for (const side of [-1, 1]) {
        const bx = cx2 + ox2 * HALF * side, by = cy2 + oy2 * HALF * side;
        g.moveTo(bx - ox2 * (WIDTH / 2), by - oy2 * (WIDTH / 2));
        g.lineTo(bx + ox2 * (WIDTH / 2), by + oy2 * (WIDTH / 2));
      }
    }
    g.stroke();
  }
  g.restore();
}

/* ---------- the walls ---------- */

// Stone brick, lit by the same sun. Each slab is filled with courses of
// brick sized against the tank; the face catches the light on the sun
// side and falls into shade opposite, and the whole slab throws a soft
// shadow onto the concrete.
function buildWalls(w, h, rects, seed, d = 1) {
  const cv = newCanvas(w, h, d);
  const g = cv.getContext("2d");
  const r = rng(seed ^ 0x5150);

  // Real stone: courses of differing height, stones of differing length
  // within each course, and every face inset by its own small amount so
  // no two edges line up. The old version used one fixed brick size on a
  // regular half-offset grid, which is precisely what made it read as
  // moulded plastic rather than masonry.
  const MORTAR_C = "rgb(74,74,72)";
  const sx = Math.cos(SUN.az), sy = Math.sin(SUN.az);

  for (const rc of rects) {
    const { x, y, w: rw, h: rh } = rc;
    if (rw <= 0 || rh <= 0) continue;

    g.save();
    // Clipped to the WHOLE wall network, not to this one slab. Slabs
    // overlap at every joint, and clipping each to its own rectangle cut
    // every stone off dead straight at the seam — which is why wall ends
    // looked sliced. Against the union, a stone laid near a junction runs
    // on into the wall it meets.
    g.beginPath();
    for (const o of rects) g.rect(o.x, o.y, o.w, o.h);
    g.clip();

    // Mortar bed first; the stones are then set into it.
    g.fillStyle = MORTAR_C;
    g.fillRect(x, y, rw, rh);

    const horiz = rw >= rh;
    const along = horiz ? rw : rh;
    const across = horiz ? rh : rw;
    // Courses vary in height around a target, so the bedding lines
    // wander instead of ruling the wall into a grid.
    const target = 10;
    const courses = Math.max(1, Math.round(across / target));
    const heights = [];
    let acc = 0;
    for (let c = 0; c < courses; c++) {
      const hgt = (across / courses) * (0.78 + r() * 0.44);
      heights.push(hgt); acc += hgt;
    }
    for (let c = 0; c < courses; c++) heights[c] *= across / acc;

    let cOff = 0;
    for (let c = 0; c < courses; c++) {
      const cH = heights[c];
      let p = -r() * 20;                       // each course starts differently
      while (p < along) {
        const bw = 13 + r() * 20;              // stones are all different lengths
        // Every face pulls back from the mortar by its own amount.
        const i1 = 0.7 + r() * 0.9, i2 = 0.7 + r() * 0.9;
        const i3 = 0.6 + r() * 0.7, i4 = 0.6 + r() * 0.7;
        const bx = horiz ? x + p : x + cOff;
        const by = horiz ? y + cOff : y + p;
        const bW = horiz ? bw : cH;
        const bH = horiz ? cH : bw;
        const fx = bx + i1, fy = by + i3;
        const fw = Math.max(1, bW - i1 - i2), fh = Math.max(1, bH - i3 - i4);

        const t = (r() - 0.5) * 34;
        g.fillStyle = `rgb(${WALL.r + t},${WALL.g + t},${WALL.b + t})`;
        g.fillRect(fx, fy, fw, fh);

        // Grain within the stone, so a face isn't a flat swatch.
        const specks = 2 + ((r() * 4) | 0);
        for (let k = 0; k < specks; k++) {
          const st = r() < 0.5 ? 255 : 0;
          g.fillStyle = `rgba(${st},${st},${st},${0.04 + r() * 0.07})`;
          g.fillRect(fx + r() * fw, fy + r() * fh, 1 + r() * 2.2, 1 + r() * 1.6);
        }
        // Lit and shaded arrises, following the sun.
        g.fillStyle = `rgba(216,218,220,${0.14 + r() * 0.12})`;
        if (sx < 0) g.fillRect(fx, fy, 1, fh); else g.fillRect(fx + fw - 1, fy, 1, fh);
        if (sy < 0) g.fillRect(fx, fy, fw, 1); else g.fillRect(fx, fy + fh - 1, fw, 1);
        g.fillStyle = `rgba(20,21,23,${0.22 + r() * 0.14})`;
        if (sx < 0) g.fillRect(fx + fw - 1, fy, 1, fh); else g.fillRect(fx, fy, 1, fh);
        if (sy < 0) g.fillRect(fx, fy + fh - 1, fw, 1); else g.fillRect(fx, fy, fw, 1);
        // Weathering: a knocked-off corner now and then.
        if (r() < 0.16) {
          g.fillStyle = "rgba(74,74,72,0.55)";
          const cs = 1.6 + r() * 2.6;
          const cxp = r() < 0.5 ? fx : fx + fw - cs;
          const cyp = r() < 0.5 ? fy : fy + fh - cs;
          g.beginPath();
          g.moveTo(cxp, cyp); g.lineTo(cxp + cs, cyp); g.lineTo(cxp, cyp + cs);
          g.closePath(); g.fill();
        }
        p += bw;
      }
      cOff += cH;
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

  // ---- CHAMFER ------------------------------------------------------
  // A cast slab has a broken edge, not a razor one. The bevel is taken
  // from the silhouette of the whole network rather than from each
  // rectangle, so it runs round the OUTSIDE of the masonry and never
  // appears along an internal joint where two walls meet — which would
  // just be the sliced look again in a different colour.
  //
  // Built by subtraction: the union, minus the union shifted, leaves the
  // band of pixels along one side. Shifted away from the sun it gives
  // the lit arris; shifted toward it, the shaded one.
  const BEV = 2.2;
  const lx = -sx, ly = -sy;                     // toward the sun, on screen
  const band = newCanvas(w, h, d);
  const bg = band.getContext("2d");
  const bu = band.__wu ?? { w: band.width, h: band.height };
  const paintUnion = (cx, ctxx, dx, dy, style) => {
    ctxx.fillStyle = style;
    for (const o of rects) ctxx.fillRect(o.x + dx, o.y + dy, o.w, o.h);
  };
  for (const [dx, dy, style, alpha] of [
    [lx * BEV, ly * BEV, "rgba(228,230,232,1)", 0.30],   // lit edge
    [-lx * BEV, -ly * BEV, "rgba(16,17,19,1)", 0.34],    // shaded edge
  ]) {
    bg.setTransform(1, 0, 0, 1, 0, 0);
    bg.clearRect(0, 0, bu.w, bu.h);
    bg.globalCompositeOperation = "source-over";
    paintUnion(band, bg, 0, 0, style);
    bg.globalCompositeOperation = "destination-out";
    paintUnion(band, bg, dx, dy, "#000");
    bg.globalCompositeOperation = "source-over";
    g.globalAlpha = alpha;
    g.drawImage(band, 0, 0, bu.w, bu.h);
  }
  g.globalAlpha = 1;
  return cv;
}

// Shadows the walls throw across the concrete. Drawn under the walls, in
// the direction the sun dictates, so the light has visible consequences.
function buildShadows(w, h, rects, pad, d = 1) {
  const cv = newCanvas(w + pad * 2, h + pad * 2, d);
  const g = cv.getContext("2d");
  const HEIGHT = 20;                             // walls stand well above a tank
  const ox = SHADOW.dx * HEIGHT, oy = SHADOW.dy * HEIGHT;

  // Built as a UNION, then laid down once.
  //
  // Wall rects deliberately overlap at every joint so the masonry has no
  // gaps. Painting a translucent shadow per rect therefore stacked two
  // and three deep wherever walls met, and those junctions came out
  // markedly darker than the runs between them — a grid of dark patches
  // that the eye reads immediately as a bug. Filling every shape at full
  // opacity on a scratch layer and compositing THAT once means overlap
  // costs nothing: a shadow is a shadow, however many walls agree on it.
  const scratch = newCanvas(w + pad * 2, h + pad * 2, d);
  const sg = scratch.getContext("2d");
  sg.translate(pad, pad);

  // A shadow is the wall SWEPT along the light — the box itself, the box
  // displaced, and the volume joining them. Drawing only the displaced
  // copy leaves a floating rectangle with a gap where wall meets ground.
  sg.fillStyle = "#000";
  for (const rc of rects) {
    const { x, y, w: rw, h: rh } = rc;
    const pts = [
      [x, y], [x + rw, y], [x + rw, y + rh], [x, y + rh],
      [x + ox, y + oy], [x + rw + ox, y + oy],
      [x + rw + ox, y + rh + oy], [x + ox, y + rh + oy],
    ];
    const hull = convexHull(pts);
    sg.beginPath();
    sg.moveTo(hull[0][0], hull[0][1]);
    for (let i = 1; i < hull.length; i++) sg.lineTo(hull[i][0], hull[i][1]);
    sg.closePath();
    sg.fill();
  }
  const su = scratch.__wu ?? { w: scratch.width, h: scratch.height };
  g.globalAlpha = 0.34;
  g.drawImage(scratch, 0, 0, su.w, su.h);

  // Contact shading: darkest right where wall meets floor, so it looks
  // seated rather than floating. Same treatment — one pass, one union.
  sg.setTransform(1, 0, 0, 1, 0, 0);
  sg.clearRect(0, 0, su.w, su.h);
  sg.translate(pad, pad);
  for (const rc of rects) sg.fillRect(rc.x + ox * 0.16, rc.y + oy * 0.16, rc.w, rc.h);
  g.globalAlpha = 0.26;
  g.drawImage(scratch, 0, 0, su.w, su.h);
  g.globalAlpha = 1;

  return { cv, pad };
}

// Andrew's monotone chain — small and exact, which matters because the
// hull IS the shadow's outline.
function convexHull(pts) {
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  lower.pop(); upper.pop();
  return lower.concat(upper);
}

/* ---------- public ---------- */

// Build (or reuse) the arena art. Keyed on size, layout and seed, so it
// is generated once per round and simply blitted every frame after that.
export function buildScene(worldW, worldH, rects, seed, viewScale = 1, maze = null, cell = 96) {
  // Bake at the density the arena is actually SHOWN at, so the concrete,
  // the brickwork and the worn tracks are as sharp as the tanks standing
  // on them. Baking at world size and letting the canvas magnify it is
  // what left all of the fine detail soft.
  // Round UP to the next half step: rounding to nearest can land below
  // what the display actually needs and leave the detail soft, which is
  // the whole thing being fixed here.
  let d = Math.max(1, Math.min(2, Math.ceil(viewScale * 2) / 2));
  // Enough surround to cover the letterbox on any sensible aspect; the
  // flat backstop underneath catches anything beyond it.
  const pad = Math.round(Math.max(worldW, worldH) * 0.30);
  const fw = worldW + pad * 2, fh = worldH + pad * 2;
  // Guard rail: a big arena at full density is a lot of memory, so drop
  // back a step rather than allocate something absurd.
  // Keep the whole set inside a sane memory budget — a big arena at full
  // density is a lot of bitmap, and dropping half a step costs far less
  // than the allocation would.
  const BUDGET = 11e6;
  while (d > 1 && fw * fh * d * d > BUDGET) d -= 0.5;

  const key = `${Math.round(worldW)}x${Math.round(worldH)}|${rects.length}|${seed}|${d}`;
  if (cache && cache.key === key) return cache;
  cache = {
    key,
    w: worldW, h: worldH, pad, density: d,
    floor: buildFloor(fw, fh, seed >>> 0, pad, rects, d, maze, cell),
    walls: buildWalls(worldW, worldH, rects, seed >>> 0, d),
    shadow: buildShadows(worldW, worldH, rects, pad, 1),   // soft edges: density buys nothing
  };
  return cache;
}

const wu = (cv) => cv.__wu ?? { w: cv.width, h: cv.height };

export function drawGround(ctx, scene) {
  if (!scene) return;
  const u = wu(scene.floor);
  ctx.drawImage(scene.floor, -scene.pad, -scene.pad, u.w, u.h);
}

export function drawWallLayer(ctx, scene) {
  if (!scene) return;
  const sh = wu(scene.shadow.cv);
  ctx.drawImage(scene.shadow.cv, -scene.shadow.pad, -scene.shadow.pad, sh.w, sh.h);
  const wl = wu(scene.walls);
  ctx.drawImage(scene.walls, 0, 0, wl.w, wl.h);
}
