// ================================================================
// tanksprite.js — an animated, canvas-drawn tank that matches EXACTLY
// what you drive in-game: the metallic/reflective/shiny paint finishes
// AND the two-tone patterns, both animated. Used everywhere a tank
// preview appears outside the arena — the shop, the head-to-head card,
// the in-game scoreboard, and the results screen — so a gold tank
// shimmers gold in all of them, not just on the battlefield.
//
// The drawing here mirrors drawTank() in game.js. It's a separate copy
// (parameterised by a passed-in ctx) rather than a shared import
// because game.js's versions are bound to the arena canvas; keeping a
// self-contained renderer avoids entangling the two canvases.
// ================================================================

import { PALETTE } from "./palette.js";
import { skinFinish } from "./skins.js";

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

/* ---------- animated paint finish (mirrors game.js hullPaint) ---------- */

function hullPaint(ctx, color, R, now, hexOv) {
  const hex = hexOv ?? HULL[color] ?? HULL.red;
  const finish = skinFinish(color);
  if (finish === "flat") return hex;

  const drift = Math.sin(now / 5200 * Math.PI * 2);
  const off = drift * R * 1.1;
  const g = ctx.createLinearGradient(-R + off, -R * 1.2, R + off, R * 1.2);
  const lit = (f) => mix(hex, "#ffffff", f);
  const dim = (f) => mix(hex, "#0b0d12", f);

  if (finish === "metallic") {
    g.addColorStop(0.00, dim(0.55)); g.addColorStop(0.12, lit(0.55));
    g.addColorStop(0.20, dim(0.42)); g.addColorStop(0.34, lit(0.85));
    g.addColorStop(0.42, hex); g.addColorStop(0.55, dim(0.55));
    g.addColorStop(0.66, lit(0.70)); g.addColorStop(0.78, dim(0.36));
    g.addColorStop(0.90, lit(0.50)); g.addColorStop(1.00, dim(0.58));
  } else if (finish === "reflective") {
    g.addColorStop(0.00, dim(0.70)); g.addColorStop(0.38, dim(0.52));
    g.addColorStop(0.44, lit(0.65)); g.addColorStop(0.48, "#ffffff");
    g.addColorStop(0.52, "#ffffff"); g.addColorStop(0.56, lit(0.55));
    g.addColorStop(0.60, dim(0.42)); g.addColorStop(0.82, dim(0.30));
    g.addColorStop(1.00, dim(0.66));
  } else if (finish === "shiny") {
    g.addColorStop(0.00, dim(0.50)); g.addColorStop(0.24, hex);
    g.addColorStop(0.42, lit(0.85)); g.addColorStop(0.49, "#ffffff");
    g.addColorStop(0.53, "#fffef7"); g.addColorStop(0.60, lit(0.75));
    g.addColorStop(0.78, hex); g.addColorStop(1.00, dim(0.52));
  } else if (finish === "ruby") {
    // RUBY — top-50 exclusive. Cut gemstone: deep crimson body, sharp
    // facet edges, three fire-glints, and an inner fire that pulses on
    // its own slow cycle. (Mirrors game.js hullPaint.)
    const fire = 0.5 + 0.5 * Math.sin(now / 900);
    const hot = mix(hex, "#ffd9a0", 0.30 + 0.28 * fire);
    const deep = mix(hex, "#3a0010", 0.55);
    g.addColorStop(0.00, deep); g.addColorStop(0.09, lit(0.28));
    g.addColorStop(0.15, dim(0.62)); g.addColorStop(0.19, "#ffffff");
    g.addColorStop(0.24, hot); g.addColorStop(0.33, deep);
    g.addColorStop(0.40, lit(0.50)); g.addColorStop(0.47, "#fff2f5");
    g.addColorStop(0.52, hot); g.addColorStop(0.60, hex);
    g.addColorStop(0.66, dim(0.58)); g.addColorStop(0.71, "#ffffff");
    g.addColorStop(0.77, lit(0.38)); g.addColorStop(0.87, deep);
    g.addColorStop(1.00, lit(0.20 + 0.20 * fire));
  } else { // shinyReflective — diamond
    g.addColorStop(0.00, dim(0.55)); g.addColorStop(0.14, lit(0.55));
    g.addColorStop(0.22, dim(0.50)); g.addColorStop(0.26, "#ffffff");
    g.addColorStop(0.30, lit(0.30)); g.addColorStop(0.42, hex);
    g.addColorStop(0.50, "#eaf7ff"); g.addColorStop(0.56, lit(0.45));
    g.addColorStop(0.64, dim(0.48)); g.addColorStop(0.68, "#ffffff");
    g.addColorStop(0.74, lit(0.35)); g.addColorStop(0.88, dim(0.42));
    g.addColorStop(1.00, lit(0.25));
  }
  return g;
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

function drawPattern(ctx, id, col, R, now, seedId, hexOv) {
  const paint = hullPaint(ctx, col, R, now, hexOv);
  const colHex = hexOv ?? HULL[col] ?? HULL.red;
  ctx.fillStyle = paint;
  ctx.strokeStyle = paint;
  const W = R * 1.8, H = R * 1.16;
  const L = -R * 0.9, T = -R * 0.58;

  if (id === "twoTone") {
    ctx.fillRect(L, T, W * 0.5, H);

  } else if (id === "splotchy") {
    const rng = patRng(seedId + "splotch");
    for (let i = 0; i < 7; i++) {
      const bx = L + rng() * W, by = T + rng() * H, br = R * (0.16 + rng() * 0.22);
      ctx.beginPath(); ctx.arc(bx, by, br, 0, Math.PI * 2); ctx.fill();
    }

  } else if (id === "camo") {
    const rng = patRng(seedId + "camo");
    for (let i = 0; i < 5; i++) {
      const cx = L + rng() * W, cy = T + rng() * H;
      ctx.beginPath();
      const lobes = 5 + Math.floor(rng() * 3);
      for (let k = 0; k <= lobes; k++) {
        const ang = (k / lobes) * Math.PI * 2;
        const rad = R * (0.2 + rng() * 0.22);
        const px = cx + Math.cos(ang) * rad, py = cy + Math.sin(ang) * rad * 0.8;
        if (k === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.closePath(); ctx.fill();
    }

  } else if (id === "modernCamo") {
    const rng = patRng(seedId + "modern");
    const cols = 7, rows = 5, cw = W / cols, ch = H / rows;
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++)
        if (rng() < 0.4) ctx.fillRect(L + c * cw, T + r * ch, cw + 0.5, ch + 0.5);

  } else if (id === "lightning") {
    const rng = patRng(seedId + "bolt2");
    const pts = []; const segs = 7;
    let y = T + H * (0.35 + 0.3 * rng());
    for (let s = 0; s <= segs; s++) {
      const x = L + (W * s) / segs; pts.push([x, y]);
      y += (rng() - 0.5) * H * 0.7;
      y = Math.max(T + H * 0.12, Math.min(T + H * 0.88, y));
    }
    const forks = [];
    for (let s = 2; s < segs - 1; s++) {
      if (rng() < 0.5) {
        const [bx, by] = pts[s];
        const fx = bx + W * (0.10 + rng() * 0.12);
        const fy = by + (rng() < 0.5 ? -1 : 1) * H * (0.18 + rng() * 0.16);
        forks.push([[bx, by], [fx, Math.max(T + H * 0.06, Math.min(T + H * 0.94, fy))]]);
      }
    }
    const drawBolt = (w, alpha) => {
      ctx.globalAlpha = alpha; ctx.lineWidth = w; ctx.lineJoin = "round"; ctx.lineCap = "round";
      ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
      for (const [a, b] of forks) { ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); }
      ctx.stroke();
    };
    const breathe = 0.75 + 0.25 * Math.sin(now / 380);
    ctx.strokeStyle = paint;
    drawBolt(Math.max(4, R * 0.34), 0.30 * breathe);
    drawBolt(Math.max(2.5, R * 0.18), 0.65 * breathe);
    ctx.strokeStyle = "#ffffff";
    drawBolt(Math.max(1.2, R * 0.07), 0.9 * breathe);
    ctx.globalAlpha = 1;

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
    const rng = patRng(seedId + "flame");
    ctx.save(); ctx.beginPath(); ctx.rect(L, T, W, H); ctx.clip(); ctx.fillStyle = paint;
    const tongues = 5;
    for (let i = 0; i < tongues; i++) {
      const y0 = T + H * ((i + 0.5) / tongues);
      const reach = W * (0.35 + rng() * 0.4);
      const hh = H * (0.10 + rng() * 0.06);
      ctx.beginPath();
      ctx.moveTo(L, y0 - hh);
      ctx.quadraticCurveTo(L + reach * 0.5, y0 - hh * 2.2, L + reach, y0);
      ctx.quadraticCurveTo(L + reach * 0.5, y0 + hh * 2.2, L, y0 + hh);
      ctx.closePath(); ctx.fill();
    }
    ctx.restore();

  } else if (id === "circuit") {
    const rng = patRng(seedId + "circ");
    ctx.save(); ctx.beginPath(); ctx.rect(L, T, W, H); ctx.clip();
    ctx.strokeStyle = paint; ctx.fillStyle = paint;
    ctx.lineWidth = Math.max(1, R * 0.05); ctx.lineCap = "round"; ctx.lineJoin = "round";
    for (let i = 0; i < 6; i++) {
      let x = L + rng() * W, y = T + rng() * H;
      ctx.beginPath(); ctx.moveTo(x, y);
      const legs = 2 + Math.floor(rng() * 3);
      for (let k = 0; k < legs; k++) {
        if (rng() < 0.5) x += (rng() - 0.5) * W * 0.5; else y += (rng() - 0.5) * H * 0.6;
        x = Math.max(L, Math.min(L + W, x)); y = Math.max(T, Math.min(T + H, y));
        ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.beginPath(); ctx.arc(x, y, R * 0.06, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();

  } else if (id === "tiger") {
    const rng = patRng(seedId + "tiger");
    ctx.save(); ctx.beginPath(); ctx.rect(L, T, W, H); ctx.clip(); ctx.fillStyle = paint;
    const stripes = 7;
    for (let i = 0; i < stripes; i++) {
      const x = L + W * ((i + 0.5) / stripes) + (rng() - 0.5) * W * 0.06;
      const topW = R * (0.05 + rng() * 0.05), botW = R * (0.02 + rng() * 0.03);
      const bend = (rng() - 0.5) * R * 0.5;
      ctx.beginPath();
      ctx.moveTo(x - topW, T);
      ctx.quadraticCurveTo(x + bend - botW, T + H * 0.5, x - botW, T + H);
      ctx.lineTo(x + botW, T + H);
      ctx.quadraticCurveTo(x + bend + botW, T + H * 0.5, x + topW, T);
      ctx.closePath(); ctx.fill();
    }
    ctx.restore();

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
  // 2v2 team paint: the lobby may hand us explicit HEXES that override
  // the skin's own colours (so a clashing enemy team is recoloured on
  // our screen). Same contract as the arena renderer: colorHex is the
  // solid/base override, patHex = [base, overlay] for a pattern.
  const patOv = Array.isArray(look?.patHex) ? look.patHex : null;
  const baseHexOv = pat ? (patOv ? patOv[0] : undefined) : (look?.colorHex || undefined);
  const overlayHexOv = pat && patOv ? patOv[1] : undefined;
  const bodyHex = baseHexOv ?? HULL[bodyColor] ?? HULL.red;
  const hull = look?.colorHex ?? HULL[color] ?? HULL.red;

  ctx.save();
  // The game draws with the barrel along +x; a preview reads best with
  // the barrel UP, so rotate −90°.
  ctx.rotate(-Math.PI / 2);

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

  // Hull base + pattern overlay.
  ctx.fillStyle = hullPaint(ctx, bodyColor, R, now, baseHexOv);
  rr(-R * 0.9, -R * 0.58, R * 1.8, R * 1.16, R * 0.24);
  if (pat && pc[0] && pc[1]) {
    ctx.save();
    ctx.beginPath(); rrPath(ctx, -R * 0.9, -R * 0.58, R * 1.8, R * 1.16, R * 0.24); ctx.clip();
    drawPattern(ctx, pat, pc[1], R, now, seed, overlayHexOv);
    ctx.restore();
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
  ctx.fillStyle = hullPaint(ctx, bodyColor, R, now, baseHexOv);
  ctx.fillRect(-R * 1.2, -R * 1.2, R * 2.4, R * 2.4);
  if (pat && pc[0] && pc[1]) drawPattern(ctx, pat, pc[1], R, now, seed, overlayHexOv);
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

// Create an animated <canvas> tank sprite. `look` = { color, pattern,
// patColors }. `px` is the CSS size in pixels. It self-animates while
// attached to the DOM and stops when removed.
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
  // Paint once immediately so it's never blank before the first frame.
  paintCanvas(c, performance.now());
  // Register for animation on the next microtask (once it's in the DOM).
  const start = () => {
    live.add(c);
    if (!rafOn) { rafOn = true; requestAnimationFrame(tick); }
  };
  queueMicrotask(start);
  return c;
}

// Update a sprite canvas in place (e.g. the shop preview when the
// player picks new colours) without recreating it.
export function updateTankSprite(canvas, look, seed) {
  if (!canvas) return;
  canvas.__look = look ?? canvas.__look;
  if (seed != null) canvas.__seed = String(seed);
  if (!live.has(canvas)) { live.add(canvas); if (!rafOn) { rafOn = true; requestAnimationFrame(tick); } }
}

/* ---------- animated finish swatch (for the shop colour chips) ---------- */

function paintSwatch(c, now) {
  const ctx = c.__ctx, dpr = c.__dpr, size = c.__size;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, size, size);
  ctx.save();
  ctx.translate(size / 2, size / 2);
  // A rounded-square chip filled with the animated finish for this paint.
  const R = size * 0.5;
  ctx.beginPath();
  rrPath(ctx, -R * 0.9, -R * 0.9, R * 1.8, R * 1.8, R * 0.42);
  ctx.fillStyle = hullPaint(ctx, c.__color, R, now);
  ctx.fill();
  ctx.restore();
}

// A small animated chip showing a paint's finish (metal shimmer). For
// flat paints this is a static fill — no rAF needed.
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
  paintSwatch(c, performance.now());
  // Only animate metals; flat paints never change.
  if (skinFinish(colorId) !== "flat") {
    c.__isSwatch = true;
    queueMicrotask(() => {
      liveSwatch.add(c);
      if (!swatchRaf) { swatchRaf = true; requestAnimationFrame(tickSwatch); }
    });
  }
  return c;
}

const liveSwatch = new Set();
let swatchRaf = false;
function tickSwatch() {
  const now = performance.now();
  for (const c of [...liveSwatch]) {
    if (!c.isConnected) { liveSwatch.delete(c); continue; }
    paintSwatch(c, now);
  }
  if (liveSwatch.size) requestAnimationFrame(tickSwatch);
  else swatchRaf = false;
}
