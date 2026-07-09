// ================================================================
// audio.js — the whole soundscape, synthesized live with WebAudio.
// No asset files: every sound is a little oscillator/noise recipe
// tuned to the retro-arcade character of the original AZ Tank —
// poppy fires, ticky ricochets, crunchy booms, chirpy pickups.
//
// Everything is defensive: if audio is unavailable (old browser,
// headless, autoplay-blocked), every call is a silent no-op. Audio
// unlocks itself on the first user gesture.
// ================================================================

let ctx = null;
let master = null;
let engine = null;   // { gain, osc1, osc2 }
let music = null;    // { timer, step, nextAt, gain }
const lastPlay = {}; // per-sound rate limiting

function ensure() {
  if (ctx) return ctx;
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.6;
    master.connect(ctx.destination);
  } catch (e) {
    ctx = null;
  }
  return ctx;
}

// Browsers keep the context suspended until a user gesture.
function unlock() {
  const c = ensure();
  if (c && c.state === "suspended") c.resume().catch(() => {});
}
window.addEventListener("pointerdown", unlock);
window.addEventListener("keydown", unlock);
window.addEventListener("touchstart", unlock, { passive: true });

function ready() {
  return ensure() && ctx.state === "running";
}

function limited(name, ms) {
  const now = performance.now();
  if (lastPlay[name] && now - lastPlay[name] < ms) return true;
  lastPlay[name] = now;
  return false;
}

/* ---------- tiny synth building blocks ---------- */

// One oscillator with a pitch glide and a fast decay envelope.
function blip(type, f0, f1, dur, peak, when = 0) {
  const t = ctx.currentTime + when;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(f0, t);
  o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
  g.gain.setValueAtTime(peak, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(master);
  o.start(t);
  o.stop(t + dur + 0.02);
}

let noiseBuf = null;
function getNoise() {
  if (noiseBuf) return noiseBuf;
  const len = ctx.sampleRate * 1;
  noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = noiseBuf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  return noiseBuf;
}

// White noise through a gliding filter with a decay envelope.
function whoosh(filterType, f0, f1, dur, peak, when = 0, q = 1) {
  const t = ctx.currentTime + when;
  const src = ctx.createBufferSource();
  src.buffer = getNoise();
  src.loop = true;
  const f = ctx.createBiquadFilter();
  f.type = filterType;
  f.Q.value = q;
  f.frequency.setValueAtTime(f0, t);
  f.frequency.exponentialRampToValueAtTime(Math.max(30, f1), t + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(peak, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(f).connect(g).connect(master);
  src.start(t);
  src.stop(t + dur + 0.02);
}

/* ---------- the sound set ---------- */

export const sfx = {
  // Standard cannon "pop": short square drop plus a click of noise.
  fire() {
    if (!ready() || limited("fire", 45)) return;
    try {
      blip("square", 340, 130, 0.09, 0.14);
      whoosh("highpass", 1600, 900, 0.04, 0.05);
    } catch (e) {}
  },

  // Machine-gun ball: smaller, snappier pop.
  mini() {
    if (!ready() || limited("mini", 34)) return;
    try {
      blip("square", 430, 210, 0.05, 0.09);
    } catch (e) {}
  },

  // Ricochet off a wall: bright little tick.
  bounce() {
    if (!ready() || limited("bounce", 55)) return;
    try {
      blip("triangle", 1150, 700, 0.035, 0.06);
    } catch (e) {}
  },

  // Tank explosion: noise crunch sweeping down + a sub thump.
  boom() {
    if (!ready() || limited("boom", 90)) return;
    try {
      whoosh("lowpass", 1400, 130, 0.5, 0.3, 0, 0.7);
      blip("sine", 130, 42, 0.35, 0.28);
    } catch (e) {}
  },

  // A weapon crate materializing: two ascending chimes.
  gearSpawn() {
    if (!ready() || limited("gearSpawn", 120)) return;
    try {
      blip("sine", 660, 662, 0.09, 0.08);
      blip("sine", 990, 992, 0.1, 0.08, 0.09);
    } catch (e) {}
  },

  // Grabbing a crate: quick rising arpeggio.
  pickup() {
    if (!ready() || limited("pickup", 120)) return;
    try {
      blip("square", 523, 525, 0.06, 0.07);
      blip("square", 659, 661, 0.06, 0.07, 0.06);
      blip("square", 784, 786, 0.09, 0.08, 0.12);
    } catch (e) {}
  },

  // Laser: a searing zap — saw dive with a sizzle on top.
  laser() {
    if (!ready() || limited("laser", 120)) return;
    try {
      blip("sawtooth", 2200, 160, 0.28, 0.16);
      whoosh("bandpass", 4200, 900, 0.24, 0.1, 0, 4);
    } catch (e) {}
  },

  // Machine-gun wind-up: a rising whir matching the 0.5 s spin-up.
  windup() {
    if (!ready() || limited("windup", 300)) return;
    try {
      blip("sawtooth", 90, 420, 0.5, 0.06);
      whoosh("bandpass", 300, 1200, 0.5, 0.045, 0, 3);
    } catch (e) {}
  },

  // Rocket launch: breathy whoosh climbing away.
  rocket() {
    if (!ready() || limited("rocket", 150)) return;
    try {
      whoosh("bandpass", 240, 1600, 0.42, 0.16, 0, 1.6);
      blip("sine", 100, 260, 0.3, 0.07);
    } catch (e) {}
  },

  // Big cannon: a deep, slow THOOMP.
  cannon() {
    if (!ready() || limited("cannon", 150)) return;
    try {
      blip("sine", 120, 38, 0.42, 0.3);
      whoosh("lowpass", 700, 90, 0.3, 0.16, 0, 0.8);
    } catch (e) {}
  },

  // Shrapnel burst: a fizzing crackle.
  shrap() {
    if (!ready() || limited("shrap", 150)) return;
    try {
      whoosh("highpass", 900, 2600, 0.34, 0.16, 0, 1.2);
      blip("square", 200, 90, 0.14, 0.1);
    } catch (e) {}
  },

  // Round over: a small three-note sting.
  roundEnd() {
    if (!ready() || limited("roundEnd", 600)) return;
    try {
      blip("triangle", 523, 525, 0.12, 0.09);
      blip("triangle", 392, 394, 0.12, 0.09, 0.12);
      blip("triangle", 659, 661, 0.24, 0.1, 0.24);
    } catch (e) {}
  },
};

/* ---------- faint tank engine ---------- */

// A quiet two-oscillator rumble through a lowpass. Idles softly the
// whole match; revs (louder, higher) while a local tank is driving.
export function setEngine(active, moving) {
  if (!ready()) return;
  try {
    if (!engine) {
      const g = ctx.createGain();
      g.gain.value = 0;
      const f = ctx.createBiquadFilter();
      f.type = "lowpass";
      f.frequency.value = 170;
      const o1 = ctx.createOscillator();
      o1.type = "sawtooth";
      o1.frequency.value = 52;
      const o2 = ctx.createOscillator();
      o2.type = "square";
      o2.frequency.value = 26;
      const g2 = ctx.createGain();
      g2.gain.value = 0.5;
      o1.connect(f);
      o2.connect(g2).connect(f);
      f.connect(g).connect(master);
      o1.start();
      o2.start();
      engine = { gain: g, o1, o2 };
    }
    const t = ctx.currentTime;
    const target = !active ? 0 : moving ? 0.05 : 0.018;
    const freq = moving ? 72 : 52;
    engine.gain.gain.setTargetAtTime(target, t, 0.12);
    engine.o1.frequency.setTargetAtTime(freq, t, 0.18);
    engine.o2.frequency.setTargetAtTime(freq / 2, t, 0.18);
  } catch (e) {}
}

/* ---------- music: a quiet 8-bar chiptune loop ---------- */

const STEP = 60 / 105 / 2; // eighth notes at 105 BPM
// A minor groove: 32 eighth-note steps of bass, sparse lead on top.
const BASS = [
  55, 0, 55, 0, 65.4, 0, 49, 0, 55, 0, 55, 0, 41.2, 0, 49, 0,
  55, 0, 55, 0, 65.4, 0, 73.4, 0, 82.4, 0, 73.4, 0, 65.4, 0, 49, 0,
];
const LEAD = [
  0, 0, 0, 0, 440, 0, 0, 392, 0, 0, 330, 0, 0, 0, 0, 0,
  0, 0, 523, 0, 0, 440, 0, 0, 392, 0, 330, 0, 392, 0, 0, 0,
];

function scheduleStep(step, when) {
  const b = BASS[step % BASS.length];
  if (b) {
    const t = when;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = "square";
    o.frequency.value = b;
    g.gain.setValueAtTime(0.035, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + STEP * 0.9);
    o.connect(g).connect(music.gain);
    o.start(t);
    o.stop(t + STEP);
  }
  const l = LEAD[step % LEAD.length];
  if (l) {
    const t = when;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = "triangle";
    o.frequency.value = l;
    g.gain.setValueAtTime(0.05, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + STEP * 1.7);
    o.connect(g).connect(music.gain);
    o.start(t);
    o.stop(t + STEP * 1.8);
  }
  // Off-beat hat tick, very quiet.
  if (step % 4 === 2) {
    const src = ctx.createBufferSource();
    src.buffer = getNoise();
    const f = ctx.createBiquadFilter();
    f.type = "highpass";
    f.frequency.value = 6000;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.02, when);
    g.gain.exponentialRampToValueAtTime(0.0001, when + 0.05);
    src.connect(f).connect(g).connect(music.gain);
    src.start(when);
    src.stop(when + 0.06);
  }
}

export function startMusic() {
  if (!ensure()) return;
  if (music) return;
  try {
    const gain = ctx.createGain();
    gain.gain.value = 0.55;
    gain.connect(master);
    music = { gain, step: 0, nextAt: 0, timer: 0 };
    music.timer = setInterval(() => {
      if (!ready()) return;
      if (!music.nextAt) music.nextAt = ctx.currentTime + 0.1;
      // Schedule everything due in the next 0.35 s.
      while (music.nextAt < ctx.currentTime + 0.35) {
        scheduleStep(music.step, music.nextAt);
        music.step = (music.step + 1) % BASS.length;
        music.nextAt += STEP;
      }
    }, 110);
  } catch (e) {
    music = null;
  }
}

export function stopMusic() {
  if (!music) return;
  clearInterval(music.timer);
  try {
    music.gain.gain.setTargetAtTime(0, ctx.currentTime, 0.15);
    const g = music.gain;
    setTimeout(() => { try { g.disconnect(); } catch (e) {} }, 800);
  } catch (e) {}
  music = null;
}

// Full shutdown when a game ends.
export function stopAll() {
  stopMusic();
  if (engine && ctx) {
    try { engine.gain.gain.setTargetAtTime(0, ctx.currentTime, 0.1); } catch (e) {}
  }
}
