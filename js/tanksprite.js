// ================================================================
// tanksprite.js — a canvas-drawn tank that matches EXACTLY what you
// drive in-game: the material paints AND the two-tone patterns. Used
// everywhere a tank preview appears outside the arena — the shop, the
// head-to-head card, the in-game scoreboard, and the results screen —
// so a gold tank is the same gold in all of them.
//
// PAINT DOESN'T MOVE. The materials are shaded statically (material.js
// is shared with the arena renderer, so there is only one definition of
// what gold looks like). Only the two ANIMATED patterns — lightning and
// galaxy — need a frame loop, and a sprite that wears neither is drawn
// once and left alone.
//
// The tank geometry here mirrors drawTank() in game.js: a separate copy
// (parameterised by a passed-in ctx) rather than a shared import,
// because game.js's version is bound to the arena canvas.
// ================================================================

import { PALETTE } from "./palette.js";
import { skinFinish } from "./skins.js";
import { materialFill, paintMaterial, isMaterial, paintMaterialChip } from "./material.js";

// The only patterns whose look changes over time. Everything else —
// paint included — is static, so a preview of it never needs a frame.
const ANIMATED_PATTERNS = new Set(["lightning", "galaxy", "aurora"]);

const HULL = PALETTE;

/* ---------- colour helpers ---------- */

function shade(hex, f) {
  const n = parseInt(hex.slice(1), 16);
  const m = (x, target) => Math.round(x + (target - x) * f);
  return `rgb(${m((n >> 16) & 255, 16)}, ${m((n >> 8) & 255, 19)}, ${m(n & 255, 26)})`;
}
function mix(hexA, hexB, f) {
  const a = parseInt(hexA.slice(1), 16);
  const b = parseInt(hexB.slice(1), 16);
  const t = Math.max(0, Math.min(1, f));
  const r = Math.round(((a >> 16) & 255) + (((b >> 16) & 255) - ((a >> 16) & 255)) * t);
  const g = Math.round(((a >> 8) & 255) + (((b >> 8) & 255) - ((a >> 8) & 255)) * t);
  const c = Math.round((a & 255) + ((b & 255) - (a & 255)) * t);
  return `rgb(${r}, ${g}, ${c})`;
}
function paintHexToRGBA(hex, alpha) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/* ---------- paint (shared with the arena via material.js) ---------- */

// The fill for a paint id: a plain hex for ordinary colours, or the
// material's static shading for a special. `now` is gone on purpose —
// nothing about a colour depends on the clock any more.
function hullPaint(ctx, color, R, hexOv, ang = 0) {
  const hex = hexOv ?? HULL[color] ?? HULL.red;
  return materialFill(ctx, hex, skinFinish(color), R, ang);
}

// The material's structure (brushing, horizon, facets), drawn inside
// whatever clip the caller has already set.
// One drawImage of a pre-shaded material tile.
function hullMaterial(ctx, color, R, hexOv, ang = 0) {
  const hex = hexOv ?? HULL[color] ?? HULL.red;
  return paintMaterial(ctx, hex, skinFinish(color), R, ang);
}

/* ---------- pattern helpers (mirror game.js) ---------- */

function rrPath(ctx, x, y, w, h, r) {
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
  else ctx.rect(x, y, w, h);
}
function patRng(seed) {
  let a = 0;
  for (let i = 0; i < String(seed).length; i++) a = (a * 31 + String(seed).charCodeAt(i)) | 0;
  a = (a ^ 0x9e3779b9) >>> 0;
  return () => {
    a ^= a << 13; a >>>= 0; a ^= a >> 17; a ^= a << 5; a >>>= 0;
    return a / 4294967296;
  };
}

function drawPattern(ctx, id, col, R, now, seedId, hexOv, ang = 0) {
  const paint = hullPaint(ctx, col, R, hexOv, ang);
  const colHex = hexOv ?? HULL[col] ?? HULL.red;
  ctx.fillStyle = paint;
  ctx.strokeStyle = paint;
  const W = R * 1.8, H = R * 1.16;
  const L = -R * 0.9, T = -R * 0.58;
  // Patterns must cover the WHOLE tank, not just the hull rectangle.
  // This same routine paints the barrel as well, and clipping a pattern
  // to the hull box left the outer half of the barrel bare — a plain
  // stripe down the gun that catches the eye every time the tank turns.
  // The caller has already clipped to whichever piece it is painting,
  // so covering the entire footprint is both correct and simpler.
  const CL = -R * 1.35, CT = -R * 1.35, CW = R * 2.7, CH = R * 2.7;

  if (id === "twoTone") {
    ctx.fillRect(L, T, W * 0.5, H);

  } else if (id === "splotchy") {
    // Organic blotches: several overlapping lobed shapes rather than
    // plain circles, so it reads as spilled paint instead of polka dots.
    const rng = patRng(seedId + "splotch");
    for (let i = 0; i < 20; i++) {
      const bx = CL + rng() * CW, by = CT + rng() * CH;
      const br = R * (0.13 + rng() * 0.18);
      ctx.beginPath();
      const lobes = 9;
      for (let k = 0; k <= lobes; k++) {
        const a2 = (k / lobes) * Math.PI * 2;
        const rad = br * (0.7 + rng() * 0.6);
        const px = bx + Math.cos(a2) * rad, py = by + Math.sin(a2) * rad;
        if (k === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fill();
    }

  } else if (id === "camo") {
    // Proper woodland camo: big irregular interlocking patches with
    // ragged edges, dense enough to actually break up the silhouette.
    // The old version dropped three lonely blobs on a bare hull, which
    // is not camouflage — it is spots.
    const rng = patRng(seedId + "camo");
    for (let i = 0; i < 22; i++) {
      const bx = CL + rng() * CW, by = CT + rng() * CH;
      const rx = R * (0.20 + rng() * 0.30), ry = R * (0.16 + rng() * 0.26);
      ctx.beginPath();
      const n = 10;
      for (let k = 0; k <= n; k++) {
        const a2 = (k / n) * Math.PI * 2;
        const j = 0.62 + rng() * 0.72;                 // ragged edge
        const px = bx + Math.cos(a2) * rx * j;
        const py = by + Math.sin(a2) * ry * j;
        if (k === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fill();
    }

  } else if (id === "modernCamo") {
    // Digital camo: a pixel grid, filled in clusters so the blocks form
    // connected shapes rather than random confetti.
    const rng = patRng(seedId + "digi");
    const px2 = R * 0.20;
    const cols = Math.ceil(CW / px2), rows = Math.ceil(CH / px2);
    const grid = new Uint8Array(cols * rows);
    for (let s2 = 0; s2 < 34; s2++) {
      let c = Math.floor(rng() * cols), r2 = Math.floor(rng() * rows);
      const runLen = 4 + Math.floor(rng() * 9);
      for (let k = 0; k < runLen; k++) {                // a random walk
        if (c >= 0 && c < cols && r2 >= 0 && r2 < rows) grid[r2 * cols + c] = 1;
        if (rng() < 0.5) c += rng() < 0.5 ? 1 : -1; else r2 += rng() < 0.5 ? 1 : -1;
      }
    }
    for (let r2 = 0; r2 < rows; r2++) {
      for (let c = 0; c < cols; c++) {
        if (grid[r2 * cols + c]) ctx.fillRect(CL + c * px2, CT + r2 * px2, px2 + 0.5, px2 + 0.5);
      }
    }

  } else if (id === "lightning") {
    // A forked bolt: a jagged main channel with shorter branches, drawn
    // in the CHOSEN colour (the old one washed out to near-white, which
    // is why it looked grey whatever you picked). It flickers, which is
    // most of why it costs what it does.
    const rng = patRng(seedId + "bolt");
    const flick = 0.72 + 0.28 * Math.abs(Math.sin(now / 90));
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    const bolt = (x0, y0, x1, y1, w2, depth) => {
      const segs = 6;
      const pts = [];
      for (let i = 0; i <= segs; i++) {
        const u = i / segs;
        const jx = (i === 0 || i === segs) ? 0 : (rng() - 0.5) * R * 0.38;
        const jy = (i === 0 || i === segs) ? 0 : (rng() - 0.5) * R * 0.30;
        pts.push([x0 + (x1 - x0) * u + jx, y0 + (y1 - y0) * u + jy]);
      }
      ctx.globalAlpha = flick;
      ctx.lineWidth = w2;
      ctx.beginPath();
      pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
      ctx.stroke();
      if (depth > 0) {
        for (let b = 0; b < 2; b++) {
          const at = pts[1 + Math.floor(rng() * (pts.length - 2))];
          bolt(at[0], at[1],
               at[0] + (rng() - 0.5) * R * 1.1, at[1] + (rng() - 0.5) * R * 1.1,
               w2 * 0.5, depth - 1);
        }
      }
      ctx.globalAlpha = 1;
    };
    bolt(CL + R * 0.15, CT + R * 0.2, CL + CW - R * 0.15, CT + CH - R * 0.2, R * 0.13, 1);
    bolt(CL + R * 0.2, CT + CH - R * 0.25, CL + CW - R * 0.2, CT + R * 0.25, R * 0.10, 1);

  } else if (id === "stripes") {
    ctx.save(); ctx.beginPath(); ctx.rect(L, T, W, H); ctx.clip();
    ctx.lineWidth = R * 0.34; ctx.lineCap = "butt"; ctx.strokeStyle = paint;
    for (const off of [-0.18, 0.14]) {
      ctx.beginPath();
      ctx.moveTo(L + W * (0.30 + off), T - R * 0.3);
      ctx.lineTo(L + W * (0.62 + off), T + H + R * 0.3);
      ctx.stroke();
    }
    ctx.restore();

  } else if (id === "hexScale") {
    const s = R * 0.26, hw = s * Math.sqrt(3) / 2;
    ctx.save(); ctx.beginPath(); ctx.rect(L, T, W, H); ctx.clip();
    ctx.lineWidth = Math.max(1, R * 0.04); ctx.strokeStyle = shade(colHex, 0.4); ctx.fillStyle = paint;
    let row = 0;
    for (let cy = T; cy < T + H + s; cy += s * 1.5, row++) {
      const xoff = row % 2 ? hw : 0;
      for (let cx = L - hw; cx < L + W + hw * 2; cx += hw * 2) {
        const x = cx + xoff, y = cy;
        ctx.beginPath();
        for (let k = 0; k < 6; k++) {
          const a = Math.PI / 180 * (60 * k - 90);
          const px = x + Math.cos(a) * s, py = y + Math.sin(a) * s;
          if (k === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        }
        ctx.closePath(); ctx.fill(); ctx.stroke();
      }
    }
    ctx.restore();

  } else if (id === "flames") {
    // Hot-rod flames: licks streaming BACK from the nose, each a long
    // tapering tongue with a curled tip. The old one filled the rear of
    // the hull with a single jagged mass, which read as damage rather
    // than as fire.
    const rng = patRng(seedId + "flame");
    for (let i = 0; i < 7; i++) {
      const y0 = CT + CH * (0.08 + (i / 6) * 0.84) + (rng() - 0.5) * R * 0.1;
      const len = R * (0.75 + rng() * 1.15);
      const thick = R * (0.10 + rng() * 0.13);
      const x0 = R * 1.15;                       // start at the nose
      const curl = (rng() - 0.5) * R * 0.5;
      ctx.beginPath();
      ctx.moveTo(x0, y0 - thick);
      ctx.quadraticCurveTo(x0 - len * 0.45, y0 - thick * 1.5,
                           x0 - len, y0 + curl);
      ctx.quadraticCurveTo(x0 - len * 0.4, y0 + thick * 1.4, x0, y0 + thick);
      ctx.closePath();
      ctx.fill();
    }

  } else if (id === "circuit") {
    // A board trace layout: rails running the length of the hull with
    // right-angled branches off them, junction pads where they meet and
    // vias dotted along. Previously a handful of stray lines floating in
    // space, which looked unfinished rather than technical.
    const rng = patRng(seedId + "circ");
    ctx.lineWidth = Math.max(1, R * 0.055);
    ctx.lineCap = "square";
    const rails = 4;
    for (let i = 0; i < rails; i++) {
      const y = CT + CH * ((i + 0.6) / (rails + 0.2));
      ctx.beginPath(); ctx.moveTo(CL + R * 0.1, y); ctx.lineTo(CL + CW - R * 0.1, y); ctx.stroke();
      const branches = 2 + Math.floor(rng() * 3);
      for (let b = 0; b < branches; b++) {
        const x = CL + R * 0.25 + rng() * (CW - R * 0.5);
        const dy = (rng() < 0.5 ? -1 : 1) * R * (0.16 + rng() * 0.24);
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x, y + dy);
        ctx.lineTo(x + (rng() < 0.5 ? -1 : 1) * R * (0.12 + rng() * 0.2), y + dy);
        ctx.stroke();
        ctx.beginPath(); ctx.arc(x, y, R * 0.055, 0, Math.PI * 2); ctx.fill();
      }
    }
    for (let v = 0; v < 9; v++) {
      const x = CL + rng() * CW, y = CT + rng() * CH;
      ctx.beginPath(); ctx.arc(x, y, R * 0.045, 0, Math.PI * 2); ctx.fill();
    }

  } else if (id === "tiger") {
    // Real tiger striping: tapered bars running ACROSS the hull, each
    // pinched to a point at one end and some of them forked. Straight
    // even bands were just Racing Stripes wearing a different hat.
    const rng = patRng(seedId + "tiger");
    const stripe = (yc, w2, lean, len, flip) => {
      ctx.beginPath();
      ctx.moveTo(-len * flip, yc - w2);
      ctx.quadraticCurveTo(lean * 0.3, yc - w2 * 1.25, len * flip, yc - w2 * 0.12);
      ctx.quadraticCurveTo(lean * 0.3, yc + w2 * 1.25, -len * flip, yc + w2);
      ctx.closePath();
      ctx.fill();
    };
    for (let i = 0; i < 11; i++) {
      const yc = CT + CH * ((i + 0.5) / 11) + (rng() - 0.5) * R * 0.08;
      const w2 = R * (0.055 + rng() * 0.075);
      const len = R * (0.55 + rng() * 0.75);
      stripe(yc, w2, (rng() - 0.5) * R, len, i % 2 ? 1 : -1);
      if (rng() < 0.30) stripe(yc + w2 * 2.4, w2 * 0.55, 0, len * 0.55, i % 2 ? 1 : -1);
    }

  } else if (id === "galaxy") {
    const rng = patRng(seedId + "galaxy");
    ctx.save(); ctx.beginPath(); ctx.rect(L, T, W, H); ctx.clip();
    const cx = L + W * 0.5, cy = T + H * 0.5;
    const neb = ctx.createRadialGradient(cx, cy, R * 0.05, cx, cy, R * 0.95);
    neb.addColorStop(0, mix(colHex, "#ffffff", 0.5));
    neb.addColorStop(0.4, paintHexToRGBA(colHex, 0.85));
    neb.addColorStop(1, paintHexToRGBA(colHex, 0.12));
    ctx.fillStyle = neb; ctx.fillRect(L, T, W, H);
    ctx.strokeStyle = mix(colHex, "#ffffff", 0.55);
    ctx.lineWidth = Math.max(1, R * 0.05); ctx.globalAlpha = 0.5;
    for (let arm = 0; arm < 2; arm++) {
      ctx.beginPath();
      for (let t2 = 0; t2 < 1; t2 += 0.05) {
        const ang = arm * Math.PI + t2 * Math.PI * 2.2, rad = t2 * R * 0.7;
        const px = cx + Math.cos(ang) * rad, py = cy + Math.sin(ang) * rad * 0.7;
        if (t2 === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * 0.2);
    core.addColorStop(0, "#ffffff"); core.addColorStop(1, paintHexToRGBA(colHex, 0));
    ctx.fillStyle = core; ctx.beginPath(); ctx.arc(cx, cy, R * 0.2, 0, Math.PI * 2); ctx.fill();
    for (let i = 0; i < 16; i++) {
      const sx = L + rng() * W, sy = T + rng() * H, ph = rng() * Math.PI * 2;
      const tw = 0.4 + 0.6 * Math.abs(Math.sin(now / 520 + ph));
      ctx.globalAlpha = tw; ctx.fillStyle = "#ffffff";
      const sr = R * (0.02 + rng() * 0.03);
      ctx.beginPath(); ctx.arc(sx, sy, sr, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
    ctx.restore();

  } else if (id === "checker") {
    // Hard geometric squares. The simplest of the new set and priced
    // that way — bold at a glance, nothing clever going on.
    const cols = 6, rows = 4;
    const cw = W / cols, ch = H / rows;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if ((r + c) % 2 === 0) ctx.fillRect(L + c * cw, T + r * ch, cw + 0.5, ch + 0.5);
      }
    }

  } else if (id === "hazard") {
    // Industrial caution barring: heavy diagonals with a clean band at
    // each end. No clip — the bars run the full length of the barrel too.
    const step = R * 0.42;
    for (let x = CL - CH; x < CL + CW + CH; x += step * 2) {
      ctx.beginPath();
      ctx.moveTo(x, CT); ctx.lineTo(x + step, CT);
      ctx.lineTo(x + step + CH, CT + CH); ctx.lineTo(x + CH, CT + CH);
      ctx.closePath(); ctx.fill();
    }
    ctx.fillRect(CL, T, CW, H * 0.14);
    ctx.fillRect(CL, T + H * 0.86, CW, H * 0.14);

  } else if (id === "chevron") {
    // Nested arrowheads pointing down the barrel, so the tank reads as
    // aimed even standing still.
    ctx.lineWidth = R * 0.15;
    ctx.lineJoin = "miter";
    for (let i = 0; i < 8; i++) {
      const x = CL + R * 0.1 + i * R * 0.34;
      ctx.beginPath();
      ctx.moveTo(x, CT + CH * 0.08);
      ctx.lineTo(x + R * 0.30, CT + CH * 0.5);
      ctx.lineTo(x, CT + CH * 0.92);
      ctx.stroke();
    }

  } else if (id === "plaid") {
    // Woven tartan: bands both ways with a thin companion line, and the
    // crossings doubling up the way real cloth does.
    ctx.globalAlpha = 0.5;
    for (let i = 0; i < 7; i++) {
      const x = CL + (i + 0.5) * (CW / 7);
      ctx.fillRect(x - R * 0.13, CT, R * 0.26, CH);
      ctx.fillRect(x - R * 0.30, CT, R * 0.05, CH);
    }
    for (let i = 0; i < 7; i++) {
      const y = CT + (i + 0.5) * (CH / 7);
      ctx.fillRect(CL, y - R * 0.13, CW, R * 0.26);
      ctx.fillRect(CL, y - R * 0.30, CW, R * 0.05);
    }
    ctx.globalAlpha = 1;

  } else if (id === "splatter") {
    // Thrown paint: hard-edged blots with droplet trails flung off them.
    const rng = patRng(seedId + "splat");
    for (let i = 0; i < 15; i++) {
      const bx = CL + rng() * CW, by = CT + rng() * CH;
      const br = R * (0.10 + rng() * 0.14);
      ctx.beginPath();
      const lobes = 9;
      for (let k = 0; k <= lobes; k++) {
        const a2 = (k / lobes) * Math.PI * 2;
        const rad = br * (0.6 + rng() * 0.8);
        const px = bx + Math.cos(a2) * rad, py = by + Math.sin(a2) * rad;
        if (k === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.closePath(); ctx.fill();
      const dir = rng() * Math.PI * 2;
      for (let d = 1; d <= 5; d++) {
        const dd = br * (1.25 + d * 0.62);
        ctx.beginPath();
        ctx.arc(bx + Math.cos(dir) * dd, by + Math.sin(dir) * dd,
                Math.max(0.6, br * (0.32 - d * 0.05)), 0, Math.PI * 2);
        ctx.fill();
      }
    }

  } else if (id === "carbon") {
    // Carbon twill: a proper 2×2 basket weave. Every cell is filled —
    // each holds a pair of tows, and the pair alternates direction from
    // cell to cell, which is what makes a weave look woven. The old
    // version skipped every other cell and left bare gaps.
    const cell2 = R * 0.26;
    const cols2 = Math.ceil(CW / cell2), rows2 = Math.ceil(CH / cell2);
    for (let r2 = 0; r2 < rows2; r2++) {
      for (let c = 0; c < cols2; c++) {
        const x = CL + c * cell2, y = CT + r2 * cell2;
        const flip = (c + r2) % 2 === 0;
        ctx.globalAlpha = flip ? 0.85 : 0.5;
        if (flip) {
          ctx.fillRect(x, y, cell2 * 0.96, cell2 * 0.46);
          ctx.fillRect(x, y + cell2 * 0.5, cell2 * 0.96, cell2 * 0.46);
        } else {
          ctx.fillRect(x, y, cell2 * 0.46, cell2 * 0.96);
          ctx.fillRect(x + cell2 * 0.5, y, cell2 * 0.46, cell2 * 0.96);
        }
      }
    }
    ctx.globalAlpha = 1;

  } else if (id === "scales") {
    // Overlapping reptile scales, offset row to row so each tucks under
    // the one ahead.
    const sw = R * 0.34, sh = R * 0.28;
    let row = 0;
    for (let y = CT - sh; y < CT + CH + sh; y += sh * 0.6, row++) {
      const off = (row % 2) * sw * 0.5;
      for (let x = CL - sw; x < CL + CW + sw; x += sw) {
        ctx.beginPath();
        ctx.moveTo(x + off, y);
        ctx.quadraticCurveTo(x + off + sw * 0.5, y + sh * 1.35, x + off + sw, y);
        ctx.closePath();
        ctx.globalAlpha = 0.4 + (row % 2) * 0.22;
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;

  } else if (id === "topo") {
    // Survey contours: nested rings around a couple of peaks, each ring
    // a fixed height step.
    ctx.lineWidth = Math.max(0.8, R * 0.045);
    const peaks = [
      { x: CL + CW * 0.32, y: CT + CH * 0.40 },
      { x: CL + CW * 0.70, y: CT + CH * 0.62 },
    ];
    for (const pk of peaks) {
      for (let k = 1; k <= 9; k++) {
        const rad = k * R * 0.17;
        ctx.beginPath();
        const steps = 24;
        for (let i2 = 0; i2 <= steps; i2++) {
          const a2 = (i2 / steps) * Math.PI * 2;
          const wob = 1 + Math.sin(a2 * 3 + k) * 0.13 + Math.sin(a2 * 5 - k * 2) * 0.07;
          const px = pk.x + Math.cos(a2) * rad * wob * 1.25;
          const py = pk.y + Math.sin(a2) * rad * wob;
          if (i2 === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        }
        ctx.closePath();
        ctx.stroke();
      }
    }

  } else if (id === "shatter") {
    // Cracked glass: shards radiating from an impact point with the
    // fracture lines drawn over them.
    const rng = patRng(seedId + "shatter");
    const hx2 = 0, hy2 = 0;
    const n = 13;
    const rad = [];
    for (let i = 0; i <= n; i++) rad.push(R * (0.9 + rng() * 1.7));
    for (let i = 0; i < n; i++) {
      if (i % 2) continue;
      const a0 = (i / n) * Math.PI * 2, a1 = ((i + 1) / n) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(hx2, hy2);
      ctx.lineTo(hx2 + Math.cos(a0) * rad[i], hy2 + Math.sin(a0) * rad[i]);
      ctx.lineTo(hx2 + Math.cos(a1) * rad[i + 1], hy2 + Math.sin(a1) * rad[i + 1]);
      ctx.closePath();
      ctx.globalAlpha = 0.5;
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    ctx.lineWidth = Math.max(0.8, R * 0.05);
    for (let i = 0; i < n; i++) {
      const a0 = (i / n) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(hx2, hy2);
      ctx.lineTo(hx2 + Math.cos(a0) * rad[i], hy2 + Math.sin(a0) * rad[i]);
      ctx.stroke();
    }
    for (let ring = 1; ring <= 3; ring++) {
      ctx.beginPath();
      for (let i = 0; i <= n; i++) {
        const a0 = ((i % n) / n) * Math.PI * 2;
        const rr2 = rad[i % n] * (0.3 + ring * 0.24);
        const px = hx2 + Math.cos(a0) * rr2, py = hy2 + Math.sin(a0) * rr2;
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.closePath(); ctx.stroke();
    }

  } else if (id === "aurora") {
    // The most expensive thing on the shelf, so it has to earn it:
    // layered curtains of light, each fading out along its own length
    // as well as top and bottom, drifting slowly, with a scatter of
    // stars behind them. The old one was a single flat swathe of colour
    // — which is precisely why it looked like it belonged near the
    // bottom of the price list.
    const rng = patRng(seedId + "aur");
    const drift = now / 2600;
    for (let st = 0; st < 14; st++) {
      const sx = CL + rng() * CW, sy = CT + rng() * CH;
      ctx.globalAlpha = 0.25 + rng() * 0.5;
      ctx.beginPath();
      ctx.arc(sx, sy, R * (0.018 + rng() * 0.030), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    for (let b = 0; b < 6; b++) {
      const phase = rng() * Math.PI * 2 + drift * (0.5 + rng());
      const amp = CH * (0.10 + rng() * 0.15);
      const yBase = CT + CH * (0.16 + rng() * 0.68);
      const thick = R * (0.10 + rng() * 0.18);
      const g2 = ctx.createLinearGradient(0, yBase - amp - thick * 2, 0, yBase + amp + thick * 2);
      g2.addColorStop(0.00, paintHexToRGBA(colHex, 0));
      g2.addColorStop(0.42, paintHexToRGBA(colHex, 0.95));
      g2.addColorStop(0.58, paintHexToRGBA(colHex, 0.95));
      g2.addColorStop(1.00, paintHexToRGBA(colHex, 0));
      ctx.fillStyle = g2;
      ctx.beginPath();
      const steps = 20;
      for (let i2 = 0; i2 <= steps; i2++) {
        const x = CL + (i2 / steps) * CW;
        const y = yBase + Math.sin(phase + (i2 / steps) * Math.PI * 2.4) * amp;
        const t2 = thick * (0.35 + Math.sin((i2 / steps) * Math.PI) * 0.85);
        if (i2 === 0) ctx.moveTo(x, y - t2); else ctx.lineTo(x, y - t2);
      }
      for (let i2 = steps; i2 >= 0; i2--) {
        const x = CL + (i2 / steps) * CW;
        const y = yBase + Math.sin(phase + (i2 / steps) * Math.PI * 2.4) * amp;
        const t2 = thick * (0.35 + Math.sin((i2 / steps) * Math.PI) * 0.85);
        ctx.lineTo(x, y + t2);
      }
      ctx.closePath();
      ctx.fill();
    }
    ctx.fillStyle = paint;

  }
}

/* ---------- the sprite ---------- */

// Draw a top-down tank centred at the current origin, barrel pointing
// UP (−y), sized so it fits in a box of side ~2.4·R. `look` is
// { color, pattern, patColors }. `seed` keeps a pattern's randomness
// stable per sprite.
function drawSpriteTank(ctx, look, R, now, seed) {
  const color = look?.color ?? "red";
  const pat = look?.pattern && look.pattern !== "solid" ? look.pattern : null;
  const pc = Array.isArray(look?.patColors) ? look.patColors : [];
  const bodyColor = pat && pc[0] ? pc[0] : color;
  // A caller may hand us explicit HEXES that override the skin's own
  // colours. Same contract as the arena renderer: colorHex is the
  // solid/base override, patHex = [base, overlay] for a pattern.
  const patOv = Array.isArray(look?.patHex) ? look.patHex : null;
  const baseHexOv = pat ? (patOv ? patOv[0] : undefined) : (look?.colorHex || undefined);
  const overlayHexOv = pat && patOv ? patOv[1] : undefined;
  const bodyHex = baseHexOv ?? HULL[bodyColor] ?? HULL.red;
  const hull = look?.colorHex ?? HULL[color] ?? HULL.red;

  ctx.save();
  // The game draws with the barrel along +x; a preview reads best with
  // the barrel UP, so rotate −90°. That rotation is this sprite's WORLD
  // angle, and the material has to be told about it — the reflection is
  // anchored to the world, so a preview that didn't pass it would light
  // the tank from a different side than the arena does.
  const ang = -Math.PI / 2;
  ctx.rotate(ang);

  // Treads.
  ctx.fillStyle = "#2a303c";
  const rr = (x, y, w, h, r) => { ctx.beginPath(); rrPath(ctx, x, y, w, h, r); ctx.fill(); };
  rr(-R * 0.95, -R * 0.83, R * 1.9, R * 0.42, R * 0.15);
  rr(-R * 0.95, R * 0.41, R * 1.9, R * 0.42, R * 0.15);
  ctx.strokeStyle = "#6b7488";
  ctx.lineWidth = Math.max(2, R * 0.12);
  const linkGap = R * 0.34;
  ctx.beginPath();
  for (const [y0, y1] of [[-R * 0.8, -R * 0.44], [R * 0.44, R * 0.8]]) {
    for (let x = -R * 0.88; x <= R * 0.88; x += linkGap) { ctx.moveTo(x, y0); ctx.lineTo(x, y1); }
  }
  ctx.stroke();

  // Hull base + material structure + pattern overlay.
  const bodyIsMaterial = isMaterial(skinFinish(bodyColor));
  if (bodyIsMaterial || (pat && pc[0] && pc[1])) {
    ctx.save();
    ctx.beginPath(); rrPath(ctx, -R * 0.9, -R * 0.58, R * 1.8, R * 1.16, R * 0.24); ctx.clip();
    if (bodyIsMaterial) hullMaterial(ctx, bodyColor, R, baseHexOv, ang);
    else { ctx.fillStyle = hullPaint(ctx, bodyColor, R, baseHexOv, ang); ctx.fillRect(-R*1.2,-R*1.2,R*2.4,R*2.4); }
    if (pat && pc[0] && pc[1]) drawPattern(ctx, pat, pc[1], R, now, seed, overlayHexOv, ang);
    ctx.restore();
  } else {
    ctx.fillStyle = hullPaint(ctx, bodyColor, R, baseHexOv, ang);
    rr(-R * 0.9, -R * 0.58, R * 1.8, R * 1.16, R * 0.24);
  }

  // Nose chevron etch.
  ctx.strokeStyle = shade(bodyHex, 0.42);
  ctx.lineWidth = Math.max(1.5, R * 0.06);
  ctx.globalAlpha = 0.5;
  ctx.beginPath();
  ctx.moveTo(R * 0.52, -R * 0.3); ctx.lineTo(R * 0.82, 0); ctx.lineTo(R * 0.52, R * 0.3);
  ctx.stroke();
  ctx.globalAlpha = 1;

  // Rear grille etch + exhausts.
  ctx.strokeStyle = shade(bodyHex, 0.55);
  ctx.lineWidth = Math.max(1, R * 0.05);
  ctx.globalAlpha = 0.55;
  ctx.beginPath();
  for (let i = -2; i <= 2; i++) { ctx.moveTo(-R * 0.84, i * R * 0.16); ctx.lineTo(-R * 0.58, i * R * 0.16); }
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.fillStyle = "#3a3f4c";
  rr(-R * 1.0, -R * 0.36, R * 0.14, R * 0.16, R * 0.05);
  rr(-R * 1.0, R * 0.2, R * 0.14, R * 0.16, R * 0.05);

  // ---- One-piece tank turret (matches the arena) ----
  // A rounded cast housing with a barrel, traced as one closed path.
  const bL = R * 1.15, bW = R * 0.30;
  const HW = R * 0.46, xBack = -R * 0.42, xFront = R * 0.36, rc = R * 0.16;
  const outline = (g) => {
    const hw = HW + g, bw = bW + g, bl2 = bL + g, xf = xFront, xb = xBack - g, r = rc;
    ctx.beginPath();
    ctx.moveTo(xf, -hw);
    ctx.lineTo(xf, -bw);
    ctx.lineTo(bl2, -bw);
    ctx.lineTo(bl2, bw);
    ctx.lineTo(xf, bw);
    ctx.lineTo(xf, hw);
    ctx.lineTo(xb + r, hw);
    ctx.quadraticCurveTo(xb - r * 0.2, hw - r * 0.2, xb - r * 0.2, hw - r);
    ctx.lineTo(xb - r * 0.2, -hw + r);
    ctx.quadraticCurveTo(xb - r * 0.2, -hw + r * 0.2, xb + r, -hw);
    ctx.closePath();
  };
  ctx.fillStyle = "rgba(16,20,28,0.92)";
  outline(Math.max(1.5, R * 0.085));
  ctx.fill();
  ctx.save();
  outline(0);
  ctx.clip();
  if (isMaterial(skinFinish(bodyColor))) hullMaterial(ctx, bodyColor, R, baseHexOv, ang);
  else { ctx.fillStyle = hullPaint(ctx, bodyColor, R, baseHexOv, ang); ctx.fillRect(-R*1.2,-R*1.2,R*2.4,R*2.4); }
  if (pat && pc[0] && pc[1]) drawPattern(ctx, pat, pc[1], R, now, seed, overlayHexOv, ang);
  const bev = ctx.createLinearGradient(0, -R * 0.55, 0, R * 0.55);
  bev.addColorStop(0, "rgba(255,255,255,0.26)");
  bev.addColorStop(0.5, "rgba(255,255,255,0)");
  bev.addColorStop(1, "rgba(0,0,0,0.28)");
  ctx.fillStyle = bev;
  ctx.fillRect(-R * 1.2, -R * 1.2, R * 2.4, R * 2.4);
  ctx.fillStyle = "rgba(0,0,0,0.42)";
  ctx.beginPath();
  ctx.ellipse(bL - bW * 0.30, 0, bW * 0.30, bW * 0.6, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  ctx.restore();
}

/* ---------- live sprite canvases ---------- */

// Every mounted sprite canvas, ticked from ONE shared rAF loop so a
// screen full of previews costs a single animation frame.
const live = new Set();
let rafOn = false;

function tick() {
  const now = performance.now();
  for (const c of [...live]) {
    if (!c.isConnected) { live.delete(c); continue; } // auto-cleanup
    paintCanvas(c, now);
  }
  if (live.size) requestAnimationFrame(tick);
  else rafOn = false;
}

function paintCanvas(c, now) {
  const ctx = c.__ctx;
  const dpr = c.__dpr;
  const size = c.__size;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, size, size);
  ctx.save();
  ctx.translate(size / 2, size / 2);
  drawSpriteTank(ctx, c.__look, c.__R, now, c.__seed);
  ctx.restore();
}

// Create a <canvas> tank sprite. `look` = { color, pattern, patColors }.
// `px` is the CSS size in pixels. Paint is static, so the sprite only
// joins the frame loop when it wears one of the two animated patterns;
// otherwise it is drawn once and costs nothing thereafter.
export function tankSpriteCanvas(look, px = 44, seed = "s") {
  const c = document.createElement("canvas");
  c.className = "tank tank-canvas";
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  c.width = Math.round(px * dpr);
  c.height = Math.round(px * dpr);
  c.style.width = px + "px";
  c.style.height = px + "px";
  c.__ctx = c.getContext("2d");
  c.__dpr = dpr;
  c.__size = px;
  c.__R = px * 0.34;         // tank radius within the box
  c.__look = look ?? { color: "red" };
  c.__seed = String(seed);
  paintCanvas(c, performance.now());
  // Nothing about the paint moves, so only an animated PATTERN earns a
  // frame loop. A shop full of gold and ruby tanks now sits perfectly
  // still, which is the point.
  if (ANIMATED_PATTERNS.has(c.__look?.pattern)) {
    queueMicrotask(() => {
      live.add(c);
      if (!rafOn) { rafOn = true; requestAnimationFrame(tick); }
    });
  }
  return c;
}

/* ---------- finish swatch (for the shop colour chips) ---------- */

function paintSwatch(c) {
  const ctx = c.__ctx, dpr = c.__dpr, size = c.__size;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, size, size);
  ctx.save();
  ctx.translate(size / 2, size / 2);
  // The same fill and structure the tank itself will wear, on a chip.
  paintMaterialChip(ctx, HULL[c.__color] ?? HULL.red, skinFinish(c.__color), size * 0.5);
  ctx.restore();
}

// A small chip showing a paint's material. Drawn once and never
// touched again — no rAF anywhere in the shop.
export function finishSwatchCanvas(colorId, px = 40) {
  const c = document.createElement("canvas");
  c.className = "shop-chip shop-chip-canvas";
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  c.width = Math.round(px * dpr);
  c.height = Math.round(px * dpr);
  c.style.width = px + "px";
  c.style.height = px + "px";
  c.__ctx = c.getContext("2d");
  c.__dpr = dpr;
  c.__size = px;
  c.__color = colorId;
  paintSwatch(c);
  return c;
}
