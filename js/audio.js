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
let sfxBus = null;   // all effects + engine
let musicBus = null; // the chiptune loop
let engine = null;   // { gain, osc1, osc2 }
let music = null;    // { timer, step, nextAt, gain }
const lastPlay = {}; // per-sound rate limiting

// User mix levels (0..1 each), persisted per device.
const LEVELS_KEY = "tank.audio.v1";
const levels = { master: 1, music: 1, sfx: 1 };
try {
  const raw = JSON.parse(localStorage.getItem(LEVELS_KEY));
  for (const k of ["master", "music", "sfx"]) {
    if (typeof raw?.[k] === "number") levels[k] = Math.min(1, Math.max(0, raw[k]));
  }
} catch (e) { /* fresh device */ }

const MASTER_BASE = 1.2;

export function getAudioLevels() {
  return { ...levels };
}

export function setAudioLevel(kind, v) {
  if (!(kind in levels)) return;
  levels[kind] = Math.min(1, Math.max(0, v));
  try { localStorage.setItem(LEVELS_KEY, JSON.stringify(levels)); } catch (e) {}
  if (!ctx) return;
  const t = ctx.currentTime;
  try {
    if (kind === "master") master.gain.setTargetAtTime(MASTER_BASE * levels.master, t, 0.03);
    if (kind === "music") musicBus.gain.setTargetAtTime(levels.music, t, 0.03);
    if (kind === "sfx") sfxBus.gain.setTargetAtTime(levels.sfx, t, 0.03);
  } catch (e) {}
}

function ensure() {
  if (ctx) return ctx;
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    // latencyHint "interactive" asks the OS for its smallest output
    // buffer — sounds land on the frame they're triggered.
    try { ctx = new AC({ latencyHint: "interactive" }); }
    catch (e) { ctx = new AC(); }
    master = ctx.createGain();
    master.gain.value = MASTER_BASE * levels.master;
    master.connect(ctx.destination);
    sfxBus = ctx.createGain();
    sfxBus.gain.value = levels.sfx;
    sfxBus.connect(master);
    musicBus = ctx.createGain();
    musicBus.gain.value = levels.music;
    musicBus.connect(master);
    getNoise(); // pre-build the noise buffer — no first-shot hiccup
  } catch (e) {
    ctx = null;
  }
  return ctx;
}

// Browsers keep the context suspended until a user gesture — and
// iOS is extra picky: it wants the resume AND a real source started
// synchronously inside the gesture, and by default it routes
// WebAudio through the ringer channel (silent if the mute switch is
// on). navigator.audioSession fixes the routing on modern iOS.
function unlock() {
  const c = ensure();
  if (!c) return;
  try {
    if (navigator.audioSession && navigator.audioSession.type !== "playback") {
      navigator.audioSession.type = "playback"; // media channel, ignores mute switch
    }
  } catch (e) {}
  if (c.state === "suspended") c.resume().catch(() => {});
  try {
    // A one-sample silent kick, started inside the gesture handler —
    // the classic iOS unlock.
    const b = c.createBuffer(1, 1, 22050);
    const s = c.createBufferSource();
    s.buffer = b;
    s.connect(c.destination);
    s.start(0);
  } catch (e) {}
}
// The game goes quiet when its tab is in the background, and picks
// back up the moment it's visible again.
document.addEventListener("visibilitychange", () => {
  if (!ctx) return;
  try {
    if (document.hidden) ctx.suspend();
    else ctx.resume();
  } catch (e) {}
});

window.addEventListener("pointerdown", unlock);
window.addEventListener("keydown", unlock);
window.addEventListener("touchstart", unlock, { passive: true });
window.addEventListener("touchend", unlock, { passive: true });

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
  o.connect(g).connect(sfxBus);
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
  src.connect(f).connect(g).connect(sfxBus);
  src.start(t);
  src.stop(t + dur + 0.02);
}

/* ---------- the sound set ---------- */

export const sfx = {
  // Basic cannon: a real tank barrel — a sharp cracking transient, a
  // punchy low-mid body, and a short boom tail. Not an arcade "pop."
  fire() {
    if (!ready() || limited("fire", 45)) return;
    try {
      whoosh("highpass", 5000, 1500, 0.03, 0.16);       // muzzle crack
      blip("square", 260, 60, 0.11, 0.2);               // barrel body
      blip("sine", 150, 46, 0.16, 0.22, 0.004);         // low thump
      whoosh("lowpass", 900, 120, 0.14, 0.1, 0.01, 0.7); // boom tail
    } catch (e) {}
  },

  // Machine-gun ball: light and quiet — a small snappy tick.
  mini() {
    if (!ready() || limited("mini", 34)) return;
    try {
      blip("square", 470, 240, 0.035, 0.055);
      whoosh("highpass", 4200, 2000, 0.02, 0.03);
    } catch (e) {}
  },

  // Ricochet off a wall: bright little tick.
  bounce() {
    if (!ready() || limited("bounce", 55)) return;
    try {
      blip("triangle", 1150, 700, 0.035, 0.06);
    } catch (e) {}
  },

  // Generic non-lethal hit (zone burn, fallback): a short metallic thunk.
  hit() {
    if (!ready() || limited("hit", 55)) return;
    try {
      blip("triangle", 1750, 620, 0.06, 0.09);
      blip("square", 240, 95, 0.07, 0.11);
      whoosh("highpass", 3800, 1400, 0.035, 0.06);
      blip("sine", 95, 55, 0.09, 0.07, 0.005);
    } catch (e) {}
  },

  // A ballistic round striking armour: a hard metallic CLANG — bright
  // ringing transient, a dense body knock, and a noise spatter. Reads
  // as a projectile hitting metal.
  hitMetal() {
    if (!ready() || limited("hitMetal", 40)) return;
    try {
      blip("square", 2600, 1500, 0.03, 0.12);           // strike transient
      blip("triangle", 1400, 780, 0.11, 0.13);          // ringing plate
      blip("triangle", 2050, 1180, 0.09, 0.07, 0.004);  // overtone
      whoosh("highpass", 5200, 2200, 0.05, 0.11);        // metal spatter
      blip("sine", 120, 70, 0.08, 0.08, 0.004);          // body knock
    } catch (e) {}
  },

  // Laser searing through armour: a bright zap biting into a hollow
  // metallic resonance with a sizzling tail — "blasting through metal."
  hitLaser() {
    if (!ready() || limited("hitLaser", 60)) return;
    try {
      blip("sawtooth", 2400, 300, 0.14, 0.13);           // the burn-through
      whoosh("bandpass", 3200, 700, 0.16, 0.1, 0, 6);    // molten sizzle
      blip("triangle", 1500, 900, 0.12, 0.09, 0.005);    // metal ring
      blip("sine", 90, 48, 0.18, 0.12, 0.005);           // deep scorch
    } catch (e) {}
  },

  // A tank going up: sharp crack, roaring noise sweep, deep sub thump,
  // and a metal-debris ring tail.
  explosion() {
    if (!ready() || limited("explosion", 150)) return;
    try {
      whoosh("highpass", 5200, 900, 0.09, 0.22);        // the crack
      whoosh("lowpass", 2600, 90, 0.85, 0.4, 0.01, 0.6); // the roar
      blip("sine", 105, 30, 0.6, 0.4, 0.01);            // sub thump
      blip("triangle", 1250, 320, 0.28, 0.07, 0.09);    // debris ring
      blip("square", 68, 34, 0.4, 0.16, 0.05);          // aftershock
    } catch (e) {}
  },

  // Tank explosion: noise crunch sweeping down + a sub thump.
  boom(vol = 1) {
    if (!ready() || limited("boom", 90)) return;
    try {
      whoosh("lowpass", 1400, 130, 0.5, 0.3 * vol, 0, 0.7);
      blip("sine", 130, 42, 0.35, 0.28 * vol);
    } catch (e) {}
  },

  // Multi-kill fanfare. `n` is the streak length (2 = double kill),
  // and the flourish escalates with it: the chord climbs a step per
  // kill, gains an extra voice, and gets brighter — so a Septa Kill
  // sounds unmistakably bigger than a Double.
  multiKill(n = 2) {
    if (!ready() || limited("multiKill", 140)) return;
    try {
      const step = Math.min(n, 7) - 2;              // 0..5
      const root = 392 * Math.pow(2, step / 12);    // G4, up a semitone per tier
      const vol = 0.085 + 0.012 * step;
      // Rising triad, one note per 70 ms.
      blip("triangle", root, root + 2, 0.13, vol, 0);
      blip("triangle", root * 1.26, root * 1.26 + 2, 0.13, vol, 0.07);
      blip("triangle", root * 1.5, root * 1.5 + 2, 0.18, vol, 0.14);
      // Higher streaks add an octave sparkle on top.
      if (n >= 4) blip("sine", root * 2, root * 2 + 2, 0.2, vol * 0.7, 0.2);
      if (n >= 6) blip("sine", root * 3, root * 3 + 2, 0.22, vol * 0.6, 0.26);
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

  // Laser: a searing zap riding a deep, powerful growl — heavier and
  // lower than before, with real sub weight behind the beam.
  laser() {
    if (!ready() || limited("laser", 120)) return;
    try {
      blip("sawtooth", 1700, 110, 0.34, 0.2);            // the beam
      whoosh("bandpass", 3400, 600, 0.3, 0.12, 0, 4);    // searing edge
      whoosh("lowpass", 340, 45, 0.7, 0.34, 0, 0.9);     // the deep growl
      blip("sine", 54, 26, 0.7, 0.28);                   // sub rumble
    } catch (e) {}
  },

  // Sniper: a sharp, high crack with a quick tail — a rifle report.
  snipe() {
    if (!ready() || limited("snipe", 80)) return;
    try {
      blip("square", 3200, 500, 0.05, 0.16);
      blip("sawtooth", 900, 120, 0.12, 0.12);
      blip("sine", 140, 60, 0.18, 0.14);
    } catch (e) {}
  },

  // Phase activate: an airy, ghostly shimmer.
  phase() {
    if (!ready() || limited("phase", 150)) return;
    try {
      blip("sine", 300, 900, 0.3, 0.1);
      blip("triangle", 1200, 400, 0.25, 0.06, 0.03);
    } catch (e) {}
  },

  // Wall placed: a solid brick thud.
  wallup() {
    if (!ready() || limited("wallup", 100)) return;
    try {
      blip("square", 180, 70, 0.12, 0.16);
      blip("triangle", 90, 50, 0.18, 0.12);
    } catch (e) {}
  },

  // Wall destroyed: a short crumble.
  wallbreak() {
    if (!ready() || limited("wallbreak", 100)) return;
    try {
      blip("sawtooth", 300, 60, 0.2, 0.14);
      blip("square", 140, 40, 0.14, 0.1, 0.04);
    } catch (e) {}
  },

  // Speed boost activate: a bright rising sweep.
  boost() {
    if (!ready() || limited("boost", 150)) return;
    try {
      blip("triangle", 400, 1600, 0.22, 0.14);
      blip("square", 800, 2000, 0.14, 0.08, 0.04);
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

  // Big cannon: the basic tank barrel, but DEEPER and LOUDER — a
  // heavy cracking report with a big low boom. `vol` lets the mortar
  // borrow it a touch quieter.
  cannon(vol = 1) {
    if (!ready() || limited("cannon", 150)) return;
    try {
      whoosh("highpass", 4200, 1100, 0.04, 0.2 * vol);        // heavy crack
      blip("square", 170, 42, 0.16, 0.32 * vol);              // barrel body
      blip("sine", 96, 30, 0.34, 0.42 * vol, 0.005);          // deep boom
      whoosh("lowpass", 620, 80, 0.26, 0.16 * vol, 0.01, 0.7); // boom tail
    } catch (e) {}
  },

  // Shrapnel burst: the classic staccato crackle — a thump, then a
  // ragged run of little pops as the fragments scatter.
  shrap() {
    if (!ready() || limited("shrap", 150)) return;
    try {
      // The shell detonating — a real explosive punch first.
      whoosh("highpass", 5000, 700, 0.06, 0.24);        // blast crack
      whoosh("lowpass", 1800, 90, 0.4, 0.3, 0, 0.6);    // explosive roar
      blip("sine", 110, 34, 0.4, 0.34, 0.005);          // deep concussion
      // Then the fragments scattering.
      whoosh("highpass", 900, 2400, 0.3, 0.1, 0.03, 1.2);
      const pops = 10;
      for (let i = 0; i < pops; i++) {
        const when = 0.05 + i * 0.045 + Math.random() * 0.03;
        const f = 480 + Math.random() * 700;
        blip("square", f, f * 0.55, 0.045, 0.08, when);
      }
    } catch (e) {}
  },

  // Round countdown: three low ticks, then a bright GO.
  count(n) {
    if (!ready()) return;
    try {
      if (n > 0) blip("square", 392, 392, 0.14, 0.16);
      else {
        blip("square", 784, 784, 0.2, 0.22);
        blip("square", 988, 988, 0.14, 0.3, 0.05);
      }
    } catch (e) {}
  },

  // Menu button press: a soft, satisfying tick.
  click() {
    if (!ready() || limited("click", 60)) return;
    try {
      blip("triangle", 700, 520, 0.05, 0.07);
    } catch (e) {}
  },

  // Machine-gun spin-DOWN: a falling whir as the barrel gives up.
  winddown() {
    if (!ready() || limited("winddown", 300)) return;
    try {
      blip("sawtooth", 380, 80, 0.4, 0.05);
    } catch (e) {}
  },

  // Rocket proximity beeper — a flat, urgent tick.
  beep(freq = 1150, dur = 0.05) {
    if (!ready() || limited("beep", 28)) return;
    try {
      blip("square", freq, freq - 2, dur, 0.075);
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
// active: match is live. localMoving: a tank YOU drive is moving.
// enemyMoving: some other tank is moving (heard at 30% weight). The
// whole engine bed is then 20% louder than the old baseline.
export function setEngine(active, localMoving, enemyMoving) {
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
      f.connect(g).connect(sfxBus);
      o1.start();
      o2.start();
      engine = { gain: g, o1, o2 };
    }
    const t = ctx.currentTime;
    const LOUD = 1.2; // everything 20% louder than the old levels
    // Contributions: your engine full, enemy engines at 30% weight.
    // Engines run ONLY while a tank is actually moving — no phantom
    // always-on idle bed. Nobody driving → the sound fades to silence.
    const localRev = localMoving ? 0.05 : 0;
    const enemyRev = enemyMoving ? 0.05 * 0.3 : 0;
    const anyMoving = localMoving || enemyMoving;
    const target = !active ? 0 : (localRev + enemyRev) * LOUD;
    const freq = anyMoving ? 72 : 52;
    engine.gain.gain.setTargetAtTime(target, t, 0.12);
    engine.o1.frequency.setTargetAtTime(freq, t, 0.18);
    engine.o2.frequency.setTargetAtTime(freq / 2, t, 0.18);
  } catch (e) {}
}

// A sustained flamethrower ROAR — one shared voice for the whole arena,
// driven once per frame by "is anyone breathing fire" (mirrors setEngine).
// Looping noise split into a low body (lowpass) and an airy hiss
// (bandpass); a slow LFO wobbles the low cutoff so it gutters like real
// fire. The flicker rides the FILTER, never the output gain, so "off" is
// truly silent — and it's routed through sfxBus, so it obeys the SFX /
// master mix and mute like every other sound. Gain glides to its target,
// so starting and stopping are click-free.
let flame = null; // { gain, src, lfo }
export function setFlame(active) {
  if (!ready()) return;
  try {
    if (!flame) {
      const src = ctx.createBufferSource();
      src.buffer = getNoise();
      src.loop = true;
      const low = ctx.createBiquadFilter();
      low.type = "lowpass"; low.frequency.value = 820; low.Q.value = 0.8;
      const band = ctx.createBiquadFilter();
      band.type = "bandpass"; band.frequency.value = 1700; band.Q.value = 0.7;
      const bandGain = ctx.createGain(); bandGain.gain.value = 0.4;
      const g = ctx.createGain();
      g.gain.value = 0; // the master envelope — 0 here is genuinely silent
      const lfo = ctx.createOscillator();
      lfo.type = "sine"; lfo.frequency.value = 9;
      const lfoDepth = ctx.createGain(); lfoDepth.gain.value = 170; // Hz of cutoff wobble
      lfo.connect(lfoDepth).connect(low.frequency);
      src.connect(low).connect(g);
      src.connect(band); band.connect(bandGain).connect(g);
      g.connect(sfxBus);
      src.start();
      lfo.start();
      flame = { gain: g, src, lfo };
    }
    const t = ctx.currentTime;
    flame.gain.gain.setTargetAtTime(active ? 0.19 : 0, t, active ? 0.03 : 0.08);
  } catch (e) {}
}

/* ---------- music: a real, played score ---------- */
// Every song here is a full arrangement, not a loop: each one is a run of
// distinct SECTIONS (intro, verses, choruses, a bridge, an outro) that
// play through in order before the mode moves to a different song. Nothing
// repeats a single bar for minutes on end, and every song runs past 1:30.
//
// To keep that much music readable, a section is written as a CHORD
// PROGRESSION (one chord per bar) plus a melody line. The backing —
// chord voicings, bass, counter-line — is generated from the progression
// by `sect()` according to a named style, so a ninety-second song is a
// handful of lines instead of thousands of hand-typed numbers.

// Note table (Hz).
const N = {
  A1: 55.00, Bb1: 58.27, B1: 61.74,
  C2: 65.41, Cs2: 69.30, D2: 73.42, Eb2: 77.78, E2: 82.41, F2: 87.31, Fs2: 92.50, G2: 98.00, A2: 110.00, Bb2: 116.54, B2: 123.47,
  C3: 130.81, Cs3: 138.59, D3: 146.83, Eb3: 155.56, E3: 164.81, F3: 174.61, Fs3: 185.00, G3: 196.00, A3: 220.00, Bb3: 233.08, B3: 246.94,
  C4: 261.63, Cs4: 277.18, D4: 293.66, Eb4: 311.13, E4: 329.63, F4: 349.23, Fs4: 369.99, G4: 392.00,
  Gs4: 415.30, A4: 440.00, Bb4: 466.16, B4: 493.88,
  C5: 523.25, Cs5: 554.37, D5: 587.33, Eb5: 622.25, E5: 659.25, F5: 698.46, Fs5: 739.99, G5: 783.99,
  A5: 880.00, Bb5: 932.33, B5: 987.77,
};

// Chords: the notes that sound, plus the root the bass walks on.
const CH = {
  Cmaj:  { n: [N.C4, N.E4, N.G4],   r: N.C2 },
  Gmaj:  { n: [N.B3, N.D4, N.G4],   r: N.G2 },
  Amin:  { n: [N.A3, N.C4, N.E4],   r: N.A2 },
  Fmaj:  { n: [N.A3, N.C4, N.F4],   r: N.F2 },
  Emin:  { n: [N.B3, N.E4, N.G4],   r: N.E2 },
  Dmin:  { n: [N.A3, N.D4, N.F4],   r: N.D2 },
  Dmaj:  { n: [N.A3, N.D4, N.Fs4],  r: N.D2 },
  Bbmaj: { n: [N.D4, N.F4, N.Bb4],  r: N.Bb2 },
  Gmin:  { n: [N.D4, N.G4, N.Bb4],  r: N.G2 },
  Amaj:  { n: [N.A3, N.Cs4, N.E4],  r: N.A2 },
  Bmin:  { n: [N.B3, N.D4, N.Fs4],  r: N.B2 },

  // Extended voicings — sevenths, ninths, and one inversion. A triad is
  // fine for a battle theme, but the title music needs colours a triad
  // can't give it: the 9th that keeps a C chord from sounding finished,
  // the sus that leans on the dominant instead of resolving it. Note that
  // Fmaj9 and Am7 are the SAME four notes over different roots, which is
  // why F moving to Am here doesn't sound like the chord changed so much
  // as the floor did.
  Cmaj7: { n: [N.E4, N.G4, N.B4],         r: N.C2 },
  Cmaj9: { n: [N.E4, N.G4, N.B4, N.D5],   r: N.C2 },
  Fmaj9: { n: [N.A3, N.C4, N.E4, N.G4],   r: N.F2 },
  Am7:   { n: [N.A3, N.C4, N.E4, N.G4],   r: N.A2 },
  Dm7:   { n: [N.A3, N.C4, N.D4, N.F4],   r: N.D2 },
  Em7:   { n: [N.G3, N.B3, N.D4, N.E4],   r: N.E2 },
  G7:    { n: [N.B3, N.D4, N.F4],         r: N.G2 },
  Gsus4: { n: [N.C4, N.D4, N.G4],         r: N.G2 },
  "G/B": { n: [N.B3, N.D4, N.G4],         r: N.B2 },  // G with B in the bass
  Dadd9: { n: [N.A3, N.D4, N.E4, N.Fs4],  r: N.D2 },
  Gadd9: { n: [N.B3, N.D4, N.G4, N.A4],   r: N.G2 },
  Bmin7: { n: [N.B3, N.D4, N.Fs4, N.A4],  r: N.B2 },

  // D minor's own colours, for the waltz. A7 is the real dominant — a
  // plain A major triad can't fall to D the way one with the G on top
  // does — and Em7♭5 is the half-diminished ii that only exists in a
  // minor key. Bbmaj7 is voiced as a D minor triad over B♭, which is why
  // the waltz can slide between the two without the harmony lurching.
  A7:     { n: [N.A3, N.Cs4, N.G4],        r: N.A2 },
  Gm7:    { n: [N.D4, N.F4, N.G4, N.Bb4],  r: N.G2 },
  Bbmaj7: { n: [N.D4, N.F4, N.A4],         r: N.Bb2 },
  Em7b5:  { n: [N.G3, N.Bb3, N.D4, N.E4],  r: N.E2 },
  Fmaj7:  { n: [N.A3, N.C4, N.E4],         r: N.F2 },
  Dmadd9: { n: [N.A3, N.D4, N.E4, N.F4],   r: N.D2 },

  // F major's own, for the hymn. The two sevenths are the chords that
  // actually pull — C7 to F is the "amen" the whole piece walks toward,
  // D7 belongs to G minor and not to F at all, which is why borrowing it
  // lifts. The last three are borrowed from F MINOR: B♭m and D♭ over an F
  // that never moves are how a hymn puts a cloud across the sun without
  // changing key. Fwide is the final chord, spread over two octaves the
  // way an organist opens the stops for the last bar.
  C7:     { n: [N.E4, N.G4, N.Bb4],        r: N.C2 },
  D7:     { n: [N.A3, N.C4, N.Fs4],        r: N.D2 },
  Csus4:  { n: [N.C4, N.F4, N.G4],         r: N.C2 },
  Fmin:   { n: [N.C4, N.F4, N.Gs4],        r: N.F2 },
  Bbmin:  { n: [N.Cs4, N.F4, N.Bb4],       r: N.Bb2 },
  Dbmaj:  { n: [N.F4, N.Gs4, N.Cs5],       r: N.Cs2 },
  Fwide:  { n: [N.F3, N.A3, N.C4, N.F4],   r: N.F2 },

  // Open, unresolved chords for the lobby. A minor with the 9th in it
  // never sounds like it has finished, and a suspension has no third at
  // all to tell you whether it's happy or sad — which is what you want
  // from music that has to sit under a screen without ever arriving.
  Amadd9: { n: [N.A3, N.B3, N.C4, N.E4],   r: N.A2 },
  Dsus2:  { n: [N.A3, N.D4, N.E4],         r: N.D2 },
  Esus4:  { n: [N.A3, N.B3, N.E4],         r: N.E2 },

  // Two more for G major at night. Dsus4 is the dominant with its third
  // taken out, so it points home without insisting; E♭ is a long way from
  // G and shares only the note G with it, which is why dropping onto it
  // feels like the floor going and the ceiling staying.
  Dsus4:  { n: [N.A3, N.D4, N.G4],         r: N.D2 },
  Ebmaj:  { n: [N.G3, N.Bb3, N.Eb4],       r: N.Eb2 },

  // A bare fifth — no third at all, so it is neither major nor minor and
  // settles nothing. The last chord of a piece about not being relieved.
  Dopen:  { n: [N.D4, N.A4, N.D5],         r: N.D2 },

  // For the combat floor. E MAJOR is the dominant A minor doesn't own —
  // the G♯ in it is borrowed from the harmonic minor and it pulls home
  // twice as hard as a plain E minor. The other two are bare fifths with
  // the third left out, which is what a power chord is: nothing in the
  // middle to argue with whatever the tune is doing on top.
  Emaj:   { n: [N.B3, N.E4, N.Gs4],        r: N.E2 },
  Aopen:  { n: [N.A3, N.E4, N.A4],         r: N.A2 },
  Eopen:  { n: [N.B3, N.E4, N.B4],         r: N.E2 },

  // B MAJOR — E minor's borrowed dominant, and the D♯ in it is a
  // semitone under the tonic, which is the hardest pull in music.
  Bmaj:   { n: [N.B3, N.Eb4, N.Fs4],       r: N.B2 },

  // A DIMINISHED chord: stacked minor thirds, no root worth the name,
  // and every note of it a semitone from somewhere it wants to go. Over a
  // C♯ it is the chord that leans on D minor from underneath.
  Csdim:  { n: [N.E4, N.G4, N.Bb4],        r: N.Cs2 },
};

// The same chord with a different note in the bass. A chorale is really
// two melodies — the tune on top and the bass underneath — with the
// harmony filled in between, and inversions are what let the bass line
// go where it wants to instead of hopping from root to root.
const inv = (c, r) => ({ n: c.n, r });

const seq = (...parts) => parts.flat();

// Build one section from a chord-per-bar progression. `style` decides how
// the backing is played; the melody is passed in.
function sect(o) {
  const meter = o.meter ?? 8;
  const style = o.style ?? "flow";
  const steps = o.prog.length * meter;
  const chords = new Array(steps).fill(0);
  const bass = new Array(steps).fill(0);
  const arp = new Array(steps).fill(0);
  o.prog.forEach((c, bar) => {
    const at = bar * meter;
    const [n1, n2, n3] = c.n;
    const fifth = c.r * 1.5; // a perfect fifth above the root
    if (style === "pad") {
      // One held chord per bar — hymn/organ writing.
      bass[at] = c.r;
      chords[at] = c.n;
    } else if (style === "drive") {
      // Combat: a pushing bass and a running counter-line.
      bass[at] = c.r; bass[at + 2] = c.r; bass[at + 3] = c.r;
      bass[at + 5] = c.r; bass[at + 6] = fifth;
      chords[at] = c.n; chords[at + 3] = c.n;
      arp[at] = n1; arp[at + 1] = n2; arp[at + 2] = n3; arp[at + 3] = n2;
      arp[at + 4] = n1; arp[at + 5] = n2; arp[at + 6] = n3; arp[at + 7] = n2;
    } else {
      // "flow" — gentle common time, chord on each half bar.
      bass[at] = c.r; bass[at + 4] = c.r; bass[at + 6] = fifth;
      chords[at] = c.n; chords[at + 4] = c.n;
      arp[at] = n1; arp[at + 2] = n2; arp[at + 4] = n3; arp[at + 6] = n2;
    }
  });
  const mel = o.mel ?? new Array(steps).fill(0);
  return { ...o, meter, chords, bass, arp, mel };
}

// How hard each eighth of a bar is played. Beat one hardest, the "ands"
// lightest — an even velocity across a bar is the giveaway that nobody is
// holding the sticks. A waltz leans differently from common time: its
// third beat lifts towards the next downbeat instead of sitting back.
const ACCENT = [1, 0.6, 0.82, 0.66, 0.94, 0.6, 0.82, 0.7];   // 4/4
const ACCENT3 = [1, 0.55, 0.78, 0.6, 0.86, 0.62];            // 3/4

// ====================== TITLE / MENU SONGS ======================

// ---- "First Light" — the title theme, and the one track here that gets
// a full ARRANGEMENT rather than a loop. C major, 92 BPM, sixty-four bars,
// about two minutes fifty: a bell dawn; an eight-bar theme; that theme
// rewritten with a flute holding long notes under it; a pre-chorus that
// climbs an octave; a chorus with brass beneath the tune; a nylon-guitar
// bridge over organ; a flute interlude that quietly tilts the harmony
// toward D; the final chorus A WHOLE TONE HIGHER; and a coda that walks
// D–G–C back home for the bells to finish on. No melodic phrase in the
// piece is ever played twice.
//
// Three things do most of the work:
//
//   1. Sevenths and ninths instead of bare triads, plus one inversion
//      (G/B) so the bass FALLS C–B–A–F under the theme instead of hopping
//      root to root.
//
//   2. `flSect` — a per-BAR accompaniment writer. `sect()` stamps the same
//      eight steps of backing into every bar of every section, and that,
//      far more than any melody, is what makes generated music wear out:
//      you hear the loop, not the tune. Here the comping figure moves with
//      the bar — the counter-line changes shape each bar, the bass walks
//      chromatically into the next chord, and at the end of a chorus
//      phrase the COMING chord is pushed an eighth-note early.
//
//   3. `phrase()` — real note lengths. Every other track holds every
//      melody note for a fixed 3.4 steps, which is why they smear; here a
//      note lasts exactly until the next one, so runs come out crisp and
//      the last note of a line is allowed to ring.

// Fold a chord tone down into the bass register — within an octave above
// the root, which is where a bass player would actually put it.
const fold = (f, r) => { while (f > r * 1.9) f /= 2; while (f < r * 0.95) f *= 2; return f; };
// A chromatic approach note: a semitone under the chord we're walking to,
// or over it if we're coming down. 2^(±1/12).
const approach = (from, to) => (to > from ? to * 0.9439 : to * 1.0595);

// Give every note in a line the time until the next note starts, in steps
// (slightly short, so repeated notes re-articulate instead of merging).
// `gap` sets how short: 0.92 for a piano or a guitar, nearer 1 for the
// organ and flute lines of a chorale, which want to be legato.
function phrase(line, max = 8, gap = 0.92) {
  const n = line.length;
  const out = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    if (!line[i]) continue;
    let k = 1;
    while (k < n && !line[(i + k) % n]) k++;
    out[i] = Math.max(0.9, Math.min(max, k * gap));
  }
  return out;
}

// Build a First Light section. Same idea as `sect()`, but the backing is
// written bar by bar and `fig` chooses the comping pattern.
function flSect(o) {
  const meter = 8;
  const bars = o.prog.length;
  const steps = bars * meter;
  const chords = new Array(steps).fill(0);
  const bass = new Array(steps).fill(0);
  const arp = new Array(steps).fill(0);
  let early = false; // set by the previous bar when it pushed its chord in

  o.prog.forEach((c, bar) => {
    const at = bar * meter;
    const next = o.prog[bar + 1] || null;
    const last = bar === bars - 1;
    const t = c.n;
    const n1 = t[0], n2 = t[1], n3 = t[2], n4 = t[3] ?? t[0] * 2;
    const r = c.r;
    const bt = t.map((f) => fold(f, r));   // chord tones down in the bass
    const app = next ? approach(r, next.r) : 0;
    const pushed = early;
    early = false;

    if (o.fig === "dawn") {
      // Barely there: one long root, one held pad, and a bell rolling up
      // the chord — the other way round every second bar.
      bass[at] = r;
      if (bar % 2 === 1) bass[at + 4] = bt[1];
      chords[at] = t;
      if (bar % 2 === 0) { arp[at + 1] = n2; arp[at + 4] = n3; arp[at + 6] = n4; }
      else { arp[at + 2] = n4; arp[at + 5] = n2; }

    } else if (o.fig === "amble") {
      // Unhurried common time. The chord answers off the beat (the "&" of
      // three), and the counter-line runs one of FOUR shapes depending on
      // where we are in the phrase, so the backing never repeats until the
      // fifth bar — by which point the harmony has moved anyway.
      bass[at] = r;
      if (bar % 2 === 0) { bass[at + 4] = bt[1]; bass[at + 6] = bt[0]; }
      else { bass[at + 3] = r; bass[at + 4] = bt[1]; }
      if (!pushed) chords[at] = t;
      chords[at + 5] = t;
      if (bar % 4 === 3 && !last) chords[at + 3] = t;
      const p = bar % 4;
      if (p === 0) { arp[at] = n1; arp[at + 2] = n2; arp[at + 4] = n3; arp[at + 6] = n2; }
      else if (p === 1) { arp[at + 1] = n2; arp[at + 3] = n3; arp[at + 5] = n4; arp[at + 7] = n2; }
      else if (p === 2) { arp[at] = n4; arp[at + 2] = n3; arp[at + 4] = n2; arp[at + 6] = n3; }
      else { arp[at] = n1; arp[at + 3] = n3; arp[at + 5] = n2; arp[at + 7] = n3; }
      if (app && bar % 2 === 1) bass[at + 7] = app;   // walk into the next chord

    } else if (o.fig === "push") {
      // 3 + 3 + 2. The bar leans forward, which is what a pre-chorus is
      // for, and the counter-line climbs an octave into the downbeat.
      bass[at] = r; bass[at + 3] = r; bass[at + 6] = bt[1];
      chords[at] = t; chords[at + 3] = t; chords[at + 6] = t;
      const up = [n1, n2, n3, n4, n1 * 2, n2 * 2, n3 * 2, n4 * 2];
      for (let i = 0; i < 8; i++) arp[at + i] = last ? up[i] : up[(i + bar * 3) % 8];
      if (app) bass[at + 7] = app;

    } else if (o.fig === "open") {
      // The chorus. Root on one and three, a fifth under the turnaround,
      // and at the end of each four-bar phrase the NEXT chord arrives an
      // eighth early — the single most "played by people" thing in here.
      // The bar it lands in then skips its own downbeat, so it reads as a
      // push and not as a stutter.
      bass[at] = r; bass[at + 4] = r;
      if (bar % 2 === 1) bass[at + 6] = bt[1];
      if (app && bar % 4 === 1) bass[at + 7] = app;
      if (!pushed) chords[at] = t;
      chords[at + 4] = t;
      if (next && bar % 4 === 3) { chords[at + 7] = next.n; early = true; }
      // Running eighths up on top, out of the way of the chord and the
      // tune on the strong beats. Notes are lifted an octave only if they
      // sit low, which wraps the line into one register instead of letting
      // it climb out of the mix.
      const line = [n1, n2, n3, n4, n3, n2, n1, n2].map((f) => (f > 460 ? f : f * 2));
      for (const i of [1, 2, 3, 5, 6, 7]) arp[at + i] = line[(i + bar) % 8];

    } else if (o.fig === "pulse") {
      // Bridge: organ holds the bar, the guitar answers on every offbeat.
      // Nothing else in the game sits on the "and" like this.
      bass[at] = r;
      bass[at + 4] = bt[1];
      chords[at] = t;
      if (bar % 2 === 0) { arp[at + 1] = n2; arp[at + 3] = n3; arp[at + 5] = n4; arp[at + 7] = n3; }
      else { arp[at + 1] = n4; arp[at + 3] = n3; arp[at + 5] = n2; arp[at + 7] = n3; }
      if (bar % 4 === 3) arp[at + 6] = n1 * 2;

    } else {
      // "float" — the interlude. One root, one chord, two plucks. Room for
      // the flute to breathe.
      bass[at] = r;
      chords[at] = t;
      arp[at + 2] = n3; arp[at + 5] = n4;
      if (bar % 2 === 1) arp[at + 6] = n2 * 2;
    }
  });

  const mel = o.mel ?? new Array(steps).fill(0);
  const out = { ...o, meter, chords, bass, arp, mel, melDur: phrase(mel, o.ring ?? 8) };
  if (o.mel2) out.mel2Dur = phrase(o.mel2, o.ring2 ?? 8);
  return out;
}

// --- the tunes. Eight steps to a bar; each line is commented with the
// chord it sings over. Nothing below is reused anywhere else in the song.

// Dawn: six notes, spread thin — G–C–D–E–D–C, the seed of the theme.
const flDawn = [
  /* Cmaj9 */ 0,0,0,0,            N.G4,0,0,0,
  /* Fmaj9 */ N.C5,0,0,0,         0,0,N.D5,0,
  /* Am7   */ N.E5,0,0,0,         0,0,0,0,
  /* Gsus4 */ 0,0,N.D5,0,         N.C5,0,0,0,
];

// The theme. Four bars that rise and answer, four that walk back down.
const flTheme = [
  /* Cmaj9 */ N.G4,0,0,0,         N.C5,0,N.D5,0,
  /* G/B   */ N.E5,0,0,N.D5,      N.C5,0,N.B4,0,
  /* Am7   */ N.A4,0,0,0,         N.C5,0,N.E5,0,
  /* Fmaj9 */ N.D5,0,0,N.C5,      N.A4,0,0,0,
  /* Cmaj7 */ N.G4,0,N.A4,0,      N.B4,0,N.C5,0,
  /* Fmaj9 */ N.D5,0,N.C5,0,      N.A4,0,0,0,
  /* Dm7   */ N.F4,0,N.A4,0,      N.D5,0,0,0,
  /* Gsus4 */ N.C5,0,N.B4,0,      N.A4,0,N.G4,0,
];

// The theme restated — same shape, different notes, pitched higher, with
// the flute below holding one long tone per bar.
const flTheme2 = [
  /* Fmaj9 */ N.A4,N.C5,N.F5,0,   0,0,N.E5,0,
  /* Cmaj7 */ N.E5,0,0,N.D5,      N.C5,0,0,0,
  /* Dm7   */ N.D5,0,N.F5,0,      N.E5,0,N.D5,0,
  /* G7    */ N.B4,0,0,0,         N.D5,0,N.F5,0,
  /* Em7   */ N.E5,0,0,N.D5,      N.B4,0,0,0,
  /* Am7   */ N.C5,0,N.B4,0,      N.A4,0,0,0,
  /* Fmaj9 */ N.F4,N.A4,N.C5,0,   N.E5,0,N.G5,0,
  /* Gsus4 */ N.F5,0,N.E5,0,      N.D5,0,0,0,
];
const flTheme2Alt = [
  N.F4,0,0,0, 0,0,0,0,   N.G4,0,0,0, 0,0,0,0,
  N.A4,0,0,0, 0,0,0,0,   N.G4,0,0,0, 0,0,N.B4,0,
  N.G4,0,0,0, 0,0,0,0,   N.E4,0,0,0, 0,0,0,0,
  N.A4,0,0,0, 0,0,N.C5,0, N.G4,0,0,0, 0,0,0,0,
];

// Pre-chorus: a four-bar ladder, A4 to A5, with brass swelling behind it.
const flLift = [
  /* Am7   */ N.A4,0,N.B4,0,      N.C5,0,0,0,
  /* Fmaj9 */ N.C5,0,N.D5,0,      N.E5,0,0,0,
  /* Cmaj7 */ N.E5,0,N.F5,0,      N.G5,0,0,0,
  /* Gsus4 */ N.A5,0,0,N.G5,      N.E5,0,0,0,
];
const flLiftAlt = [
  N.E4,0,0,0, 0,0,0,0,   N.F4,0,0,0, 0,0,0,0,
  N.G4,0,0,0, 0,0,0,0,   N.G4,0,0,0, N.D5,0,0,0,
];

// Chorus. The hook is bars one and two; bars five and six answer it from
// higher up rather than repeating it.
const flChorus = [
  /* Cmaj7 */ N.E5,0,N.G5,0,      N.A5,0,N.G5,0,
  /* Gmaj  */ N.D5,0,0,0,         N.B4,0,N.D5,0,
  /* Am7   */ N.C5,0,N.E5,0,      N.A5,0,0,0,
  /* Fmaj9 */ N.G5,0,0,N.E5,      N.C5,0,0,0,
  /* Cmaj9 */ N.E5,0,N.G5,0,      N.B5,0,N.A5,0,
  /* Gmaj  */ N.G5,0,0,N.Fs5,     N.D5,0,0,0,
  /* Fmaj9 */ N.E5,0,N.D5,0,      N.C5,0,N.A4,0,
  /* Gmaj  */ N.D5,0,0,0,         N.C5,0,0,0,
];
const flChorusAlt = [
  N.C5,0,0,0, N.E5,0,0,0,   N.B4,0,0,0, N.G4,0,0,0,
  N.A4,0,0,0, N.C5,0,0,0,   N.C5,0,0,0, N.A4,0,0,0,
  N.C5,0,0,0, N.E5,0,0,0,   N.B4,0,0,0, N.D5,0,0,0,
  N.A4,0,0,0, N.F4,0,0,0,   N.B4,0,0,0, N.D5,0,0,0,
];

// Bridge: low, close, conversational. The Bb in bar seven is borrowed
// from C minor and is the one moment of shade in the piece.
const flBridge = [
  /* Am7   */ N.A4,0,N.C5,N.B4,   N.A4,0,0,0,
  /* Em7   */ N.G4,0,N.B4,0,      N.E4,0,0,0,
  /* Fmaj9 */ N.F4,0,N.A4,0,      N.C5,0,N.A4,0,
  /* Cmaj7 */ N.G4,0,0,0,         N.E4,0,0,0,
  /* Dm7   */ N.D5,N.C5,N.A4,0,   N.F4,0,0,0,
  /* Gsus4 */ N.G4,0,N.A4,0,      N.B4,0,N.C5,0,
  /* Bbmaj */ N.D5,0,0,0,         N.F5,0,0,0,
  /* Fmaj9 */ N.E5,0,N.D5,0,      N.C5,0,0,0,
];

// Interlude: flute alone. The C# in the last bar is the door to D major.
const flInter = [
  /* Dm7  */ N.A4,0,N.D5,0,       N.F5,0,0,0,
  /* Gmaj */ N.E5,0,N.D5,0,       N.B4,0,0,0,
  /* Em7  */ N.G4,0,N.B4,0,       N.E5,0,0,0,
  /* Amaj */ N.Cs5,0,0,0,         N.E5,0,0,0,
];

// Four bars of new key, gathering itself: D, Bm, G, and an A that wants
// D badly (the G natural on top of it makes it an A7).
const flRebuild = [
  /* Dadd9 */ N.A4,0,N.D5,0,      N.Fs5,0,0,0,
  /* Bmin7 */ N.Fs5,0,N.E5,0,     N.D5,0,0,0,
  /* Gadd9 */ N.B4,0,N.D5,0,      N.G5,0,0,0,
  /* Amaj  */ N.A5,0,0,N.G5,      N.Fs5,0,0,0,
];
const flRebuildAlt = [
  N.D4,0,0,0, 0,0,0,0,   N.Fs4,0,0,0, 0,0,0,0,
  N.G4,0,0,0, 0,0,0,0,   N.A4,0,0,0, N.Cs5,0,0,0,
];

// The last chorus, a whole tone up, bells doubling the tune. Bar eight
// hangs a D over the A and lets it fall to C# — a 4–3 suspension, the
// oldest trick there is for making an ending feel earned.
const flChorusD = [
  /* Dadd9 */ N.Fs5,0,N.A5,0,     N.B5,0,N.A5,0,
  /* Amaj  */ N.E5,0,0,0,         N.Cs5,0,N.E5,0,
  /* Bmin7 */ N.D5,0,N.Fs5,0,     N.B5,0,0,0,
  /* Gadd9 */ N.A5,0,0,N.Fs5,     N.D5,0,0,0,
  /* Dadd9 */ N.A5,0,N.Fs5,0,     N.B5,0,N.A5,0,
  /* Bmin7 */ N.B5,0,N.A5,0,      N.Fs5,0,0,0,
  /* Gadd9 */ N.G5,0,N.E5,0,      N.D5,0,N.B4,0,
  /* Amaj  */ N.D5,0,0,0,         N.Cs5,0,0,0,
];
const flChorusDAlt = [
  N.Fs5,0,0,0, 0,0,0,0,   0,0,0,0, N.Cs5,0,0,0,
  N.D5,0,0,0, 0,0,0,0,    N.A5,0,0,0, 0,0,0,0,
  N.A5,0,0,0, 0,0,0,0,    N.B5,0,0,0, 0,0,0,0,
  N.G5,0,0,0, 0,0,0,0,    N.D5,0,0,0, N.Cs5,0,0,0,
];

// Coda: D to G to C, three descending fifths, and we're home. Bar three
// is the opening bell figure again, played by the piano this time.
const flCoda = [
  /* Dmaj  */ N.Fs5,0,N.E5,0,     N.D5,0,0,0,
  /* Gmaj  */ N.D5,0,N.B4,0,      N.G4,0,0,0,
  /* Cmaj9 */ N.G4,0,0,0,         N.C5,0,N.E5,0,
  /* Fmaj9 */ N.D5,0,0,0,         N.C5,0,0,0,
];
const flCodaAlt = [
  N.A4,0,0,0, 0,0,0,0,   N.B4,0,0,0, 0,0,0,0,
  N.E4,0,0,0, 0,0,0,0,   N.A4,0,0,0, 0,0,0,0,
];

// Outro: the dawn figure inverted — G, C, E, G, going up into the light
// instead of settling. One note a bar, and the last one just rings.
const flOutro = [
  /* Cmaj9 */ N.G4,0,0,0, 0,0,0,0,
  /* Am7   */ N.C5,0,0,0, 0,0,0,0,
  /* Fmaj9 */ N.E5,0,0,0, 0,0,0,0,
  /* Cmaj9 */ N.G5,0,0,0, 0,0,0,0,
];

const songFirstLight = [
  // Bells over an organ pad, no kit at all.
  { section: "dawn", fig: "dawn", prog: [CH.Cmaj9, CH.Fmaj9, CH.Am7, CH.Gsus4], mel: flDawn,
    drums: "none", sus: 7.8, bassDur: 3.6, arpDur: 4,
    voice: { chord: "organ", lead: "bell", arp: "bell" },
    vel: { chord: 0.026, lead: 0.05, arp: 0.026, bass: 0.14 } },

  // The theme: electric piano, brushes, and that falling C–B–A–F bass.
  { section: "theme", fig: "amble", groove: true,
    prog: [CH.Cmaj9, CH["G/B"], CH.Am7, CH.Fmaj9, CH.Cmaj7, CH.Fmaj9, CH.Dm7, CH.Gsus4],
    mel: flTheme, drums: "brush", sus: 3.2,
    vel: { chord: 0.04, lead: 0.1, arp: 0.038, bass: 0.19 } },

  // Said again, differently, with a flute underneath.
  { section: "theme2", fig: "amble", groove: true,
    prog: [CH.Fmaj9, CH.Cmaj7, CH.Dm7, CH.G7, CH.Em7, CH.Am7, CH.Fmaj9, CH.Gsus4],
    mel: flTheme2, mel2: flTheme2Alt, drums: "brush", sus: 3.2,
    voice: { lead2: "flute" },
    vel: { chord: 0.036, lead: 0.1, arp: 0.038, bass: 0.19, lead2: 0.05 } },

  // Pre-chorus. Everything tilts forward.
  { section: "lift", fig: "push", groove: true,
    prog: [CH.Am7, CH.Fmaj9, CH.Cmaj7, CH.Gsus4],
    mel: flLift, mel2: flLiftAlt, drums: "push", sus: 2.4,
    voice: { lead2: "brass" },
    vel: { chord: 0.042, lead: 0.105, arp: 0.034, bass: 0.2, lead2: 0.05 } },

  // Chorus.
  { section: "chorus", fig: "open", groove: true,
    prog: [CH.Cmaj7, CH.Gmaj, CH.Am7, CH.Fmaj9, CH.Cmaj9, CH.Gmaj, CH.Fmaj9, CH.Gmaj],
    mel: flChorus, mel2: flChorusAlt, drums: "anthem", sus: 3.4, ring2: 2.8,
    voice: { lead2: "brass" },
    vel: { chord: 0.038, lead: 0.112, arp: 0.026, bass: 0.185, lead2: 0.044 } },

  // Bridge: guitar over organ, brushes pulled right back.
  { section: "bridge", fig: "pulse", groove: true,
    prog: [CH.Am7, CH.Em7, CH.Fmaj9, CH.Cmaj7, CH.Dm7, CH.Gsus4, CH.Bbmaj, CH.Fmaj9],
    mel: flBridge, drums: "brush", drumV: 0.62, sus: 8, bassDur: 2.2,
    voice: { chord: "organ", lead: "guitar", arp: "guitar" },
    vel: { chord: 0.026, lead: 0.075, arp: 0.03, bass: 0.16 } },

  // Interlude: flute, and the harmony starts leaving C major.
  { section: "interlude", fig: "float",
    prog: [CH.Dm7, CH.Gmaj, CH.Em7, CH.Amaj],
    mel: flInter, drums: "swell", sus: 5.5, bassDur: 2.6,
    voice: { lead: "flute" },
    vel: { chord: 0.032, lead: 0.08, arp: 0.028, bass: 0.15 } },

  // The gear change.
  { section: "rebuild", fig: "push", groove: true,
    prog: [CH.Dadd9, CH.Bmin7, CH.Gadd9, CH.Amaj],
    mel: flRebuild, mel2: flRebuildAlt, drums: "push", sus: 2.4,
    voice: { lead2: "brass" },
    vel: { chord: 0.04, lead: 0.108, arp: 0.032, bass: 0.19, lead2: 0.05 } },

  // Last chorus, up a tone, bells on the tune.
  { section: "chorusD", fig: "open", groove: true,
    prog: [CH.Dadd9, CH.Amaj, CH.Bmin7, CH.Gadd9, CH.Dadd9, CH.Bmin7, CH.Gadd9, CH.Amaj],
    mel: flChorusD, mel2: flChorusDAlt, drums: "anthem", sus: 3.4,
    voice: { lead2: "bell" },
    vel: { chord: 0.038, lead: 0.112, arp: 0.026, bass: 0.185, lead2: 0.032 } },

  // Coda: back to C.
  { section: "coda", fig: "amble", groove: true,
    prog: [CH.Dmaj, CH.Gmaj, CH.Cmaj9, CH.Fmaj9],
    mel: flCoda, mel2: flCodaAlt, drums: "brush", drumV: 0.7, sus: 3.6,
    voice: { lead2: "flute" },
    vel: { chord: 0.038, lead: 0.092, arp: 0.03, bass: 0.17, lead2: 0.045 } },

  // Bells, and out.
  { section: "outro", fig: "dawn", prog: [CH.Cmaj9, CH.Am7, CH.Fmaj9, CH.Cmaj9], mel: flOutro,
    drums: "none", sus: 7.8, bassDur: 3.6, arpDur: 4,
    voice: { chord: "organ", lead: "bell", arp: "bell" },
    vel: { chord: 0.024, lead: 0.048, arp: 0.024, bass: 0.13 } },
].map((s) => flSect({ ...s, song: "firstlight", bpm: 92 }));

// ---- "Moonlit Waltz" — D minor, 3/4, eighty-four bars, about two and a
// half minutes. Built like an actual waltz rather than a loop in triple
// time: a bell-and-organ moonrise; the waltz theme on the flute over
// nylon guitar; an answering strain with an electric-piano inner voice; a
// hemiola strain where the bar-lines stop agreeing with the beat; a
// lament over a bass that walks down D–C♯–C–B♭–A into the cellar; a TRIO
// in B♭ major played by a music box; the trio again with the flute
// singing it and the bells answering; a four-bar climb; the grand return
// with a brass section under it; the climax back in hemiola; a wind-down
// through the circle of fifths; and four slow bars that end on a PICARDY
// THIRD — the D major chord that the whole piece has been in minor for.
//
// What it does that the old version didn't:
//
//   1. TEMPO MOVES. `bpm` is read per section, so the piece breathes:
//      100 for the moonrise, 112 for the waltz proper, 104 for the trio,
//      116 when it returns, and 88 for the last four bars — a real
//      rallentando, not a fade.
//
//   2. `mwSect` writes the accompaniment BAR BY BAR. The old style put
//      root-chord-chord in all sixty-four bars; there are eight figures
//      here, and each one changes as the bar count moves — the bass takes
//      a walking bar every fourth, the "sway" figure lets the third beat
//      arrive an eighth late, and the hemiola figure regroups two 3/4
//      bars into three 2/4 ones, which is the oldest trick in the waltz
//      book and the one that makes a listener sit up.
//
//   3. Every strain is new material. Nothing is stated twice.

// Build a Moonlit Waltz section. Same idea as `flSect`, in three.
// Six steps to a bar: beats land on 0, 2 and 4, the "ands" on 1, 3 and 5.
function mwSect(o) {
  const meter = 6;
  const bars = o.prog.length;
  const steps = bars * meter;
  const chords = new Array(steps).fill(0);
  const bass = new Array(steps).fill(0);
  const arp = new Array(steps).fill(0);

  o.prog.forEach((c, bar) => {
    const at = bar * meter;
    const next = o.prog[bar + 1] || null;
    const t = c.n;
    const n1 = t[0], n2 = t[1], n3 = t[2], n4 = t[3] ?? t[0] * 2;
    const r = c.r;
    const bt = t.map((f) => fold(f, r));
    const app = next ? approach(r, next.r) : 0;

    if (o.fig === "moon") {
      // Moonrise and ending: one root, one held chord, a bell rolling up
      // the harmony and back down the next bar.
      bass[at] = r;
      chords[at] = t;
      if (bar % 2 === 0) { arp[at + 1] = n2; arp[at + 3] = n3; arp[at + 5] = n4; }
      else { arp[at + 2] = n4; arp[at + 4] = n2; }

    } else if (o.fig === "landler") {
      // The folk waltz: root, chord, chord. Every fourth bar the bass
      // stops sitting and WALKS — root, third, then a chromatic step into
      // the next bar's root — and the guitar's little answering notes run
      // one of four shapes, so the oom-pah-pah never comes round twice
      // the same inside a phrase.
      bass[at] = r;
      if (bar % 2 === 1) bass[at + 4] = bt[1];
      chords[at + 2] = t;
      if (bar % 4 === 3) {
        bass[at + 2] = bt[1];
        if (app) bass[at + 4] = app;
      } else {
        chords[at + 4] = t;
      }
      const p = bar % 4;
      if (p === 0) arp[at + 5] = n3;
      else if (p === 1) { arp[at + 3] = n2; arp[at + 5] = n4; }
      else if (p === 2) { arp[at + 1] = n3; arp[at + 5] = n2; }
      else { arp[at + 1] = n2; arp[at + 3] = n3; arp[at + 5] = n4; }

    } else if (o.fig === "sway") {
      // A hesitation waltz. Every second bar the third beat arrives an
      // eighth LATE while the bass moves an eighth EARLY, so the bar
      // leans and catches itself. Played straight it's a metronome;
      // played like this it's a dance.
      bass[at] = r;
      chords[at + 2] = t;
      if (bar % 2 === 0) { chords[at + 4] = t; bass[at + 4] = bt[1]; arp[at + 1] = n3; arp[at + 5] = n2; }
      else { chords[at + 5] = t; bass[at + 3] = bt[1]; arp[at + 1] = n4; arp[at + 3] = n2; }

    } else if (o.fig === "hemiola") {
      // Two bars of 3/4 regrouped as three bars of 2/4: the accents fall
      // on beats 1 and 3 of the first bar and beat 2 of the second, and
      // for those two bars the waltz simply isn't in three any more.
      if (bar % 2 === 0) {
        bass[at] = r; chords[at] = t;
        bass[at + 4] = bt[1]; chords[at + 4] = t;
        arp[at + 3] = n2;
      } else {
        bass[at + 2] = r; chords[at + 2] = t;
        arp[at + 1] = n3;
        arp[at + 5] = n4;
      }

    } else if (o.fig === "lament") {
      // No oom-pah at all: one long bass note per bar under a held organ
      // chord, so the ear follows the bass walking down and nothing else.
      // The guitar rolls up the chord, then back down as the bass sinks.
      bass[at] = r;
      chords[at] = t;
      if (bar % 2 === 0) { arp[at + 1] = n1; arp[at + 3] = n2; arp[at + 5] = n3; }
      else { arp[at + 1] = n4; arp[at + 3] = n3; arp[at + 5] = n2; }

    } else if (o.fig === "box") {
      // A music box. The bell runs a six-note cylinder up and down the
      // chord for the whole bar, and the pattern is rotated two notes
      // every bar, which is exactly how a real cylinder — pinned once and
      // turning against a bar line — never quite lines up the same way.
      bass[at] = r;
      chords[at] = t;
      const cyl = [n1, n2, n3, n4, n3, n2];
      for (let i = 0; i < meter; i++) arp[at + i] = cyl[(i + bar * 2) % meter];

    } else if (o.fig === "climb") {
      // The four bars that haul it back to D minor: the bass hammers all
      // three beats instead of one, which in a waltz reads as pure
      // impatience, and the guitar climbs an octave as it goes.
      bass[at] = r; bass[at + 2] = r; bass[at + 4] = r;
      chords[at] = t; chords[at + 2] = t; chords[at + 4] = t;
      const up = [n1, n2, n3, n4, n3, n4];
      const lift = bar >= bars - 2 ? 2 : 1;
      for (const i of [1, 3, 5]) arp[at + i] = up[(i + bar) % meter] * lift;
      if (app) bass[at + 5] = app;

    } else {
      // "ball" — the grand return. Weight on the downbeat of each phrase,
      // a fuller bass with a pickup under the turnaround, and the guitar
      // running the offbeats all the way through.
      bass[at] = r;
      if (bar % 4 === 0) chords[at] = t;
      chords[at + 2] = t; chords[at + 4] = t;
      bass[at + 4] = bt[1];
      if (bar % 2 === 1) bass[at + 3] = bt[0];
      if (app && bar % 4 === 3) bass[at + 5] = app;
      const line = [n1, n2, n3, n4, n3, n2];
      for (const i of [1, 3, 5]) arp[at + i] = line[(i + bar) % meter];
    }
  });

  const mel = o.mel ?? new Array(steps).fill(0);
  const out = { ...o, meter, chords, bass, arp, mel, melDur: phrase(mel, o.ring ?? 6) };
  if (o.mel2) out.mel2Dur = phrase(o.mel2, o.ring2 ?? 6);
  return out;
}

// The lament bass. Same two chord shapes, dropped a step at a time —
// D, C♯, C, B♭, A — until the floor is an octave below where the waltz
// started. The chords above it don't move; only the ground does.
const LAM = [
  { n: CH.Dmin.n, r: N.D2 },
  { n: CH.Amaj.n, r: N.Cs2 },
  { n: CH.Dmin.n, r: N.C2 },
  { n: CH.Bbmaj.n, r: N.Bb1 },
  { n: CH.Amaj.n, r: N.A1 },
];

// --- the strains. Six steps to a bar, written three beats to a line.

// Moonrise: four notes from the flute, nothing else but bells.
const mwRise = [
  /* Dmadd9 */ 0,0,       0,0,       0,0,
  /* Bbmaj7 */ 0,0,       0,0,       N.D5,0,
  /* Gm7    */ N.F5,0,    0,0,       N.D5,0,
  /* A7     */ N.Cs5,0,   0,0,       0,0,
];

// The waltz theme. Rises to a G in bar three, answers itself, and lands.
const mwTheme = [
  /* Dmin   */ N.A4,0,    N.D5,0,    0,N.C5,
  /* Bbmaj7 */ N.Bb4,0,   N.D5,0,    N.F5,0,
  /* Gm7    */ N.G5,0,    0,N.F5,    N.E5,0,
  /* A7     */ N.D5,0,    N.Cs5,0,   N.E5,0,
  /* Dmin   */ N.D5,0,    N.A4,0,    0,N.C5,
  /* Gm7    */ N.Bb4,0,   N.G4,0,    N.Bb4,0,
  /* A7     */ N.Cs5,0,   0,0,       N.E5,0,
  /* Dmin   */ N.D5,0,    0,0,       0,0,
];

// The answering strain: starts on the highest note yet and falls, which
// is the opposite of what the theme did, and goes to the relative major
// on the way past.
const mwTheme2 = [
  /* Dmin   */ N.A5,0,    0,0,       N.G5,N.F5,
  /* Bbmaj7 */ N.D5,0,    N.F5,0,    N.Bb4,0,
  /* Fmaj7  */ N.A4,0,    N.C5,0,    N.F5,0,
  /* Cmaj   */ N.E5,0,    0,N.D5,    N.C5,0,
  /* Bbmaj7 */ N.D5,0,    N.F5,0,    N.A5,0,
  /* Gm7    */ N.G5,0,    N.F5,0,    N.D5,0,
  /* A7     */ N.G5,0,    N.F5,N.E5, N.Cs5,0,
  /* Dmin   */ N.D5,0,    0,0,       N.A4,0,
];
const mwTheme2Alt = [   // electric piano, one held note a bar, moving inside
  N.D4,0, 0,0, 0,0,      N.F4,0, 0,0, 0,0,
  N.E4,0, 0,0, 0,0,      N.E4,0, 0,0, N.G4,0,
  N.F4,0, 0,0, 0,0,      N.G4,0, 0,0, N.Bb4,0,
  N.A4,0, 0,0, 0,0,      N.F4,0, 0,0, N.D4,0,
];

// The hemiola strain. Bars one to four sing in two while the waltz keeps
// trying to be in three; bars five to eight give in and resolve it.
const mwTurn = [
  /* Gm7    */ N.Bb4,0,   0,0,       N.D5,0,
  /* A7     */ 0,0,       N.E5,0,    0,0,
  /* Dmin   */ N.F5,0,    0,0,       N.A5,0,
  /* Bbmaj7 */ 0,0,       N.G5,0,    0,0,
  /* Gm7    */ N.F5,0,    N.E5,0,    N.D5,0,
  /* Em7b5  */ N.Bb4,0,   N.D5,0,    N.E5,0,
  /* A7     */ N.Cs5,0,   N.E5,0,    N.G5,0,
  /* A7     */ N.A5,0,    0,0,       0,0,
];

// Over the descending bass. The tune climbs while the ground sinks.
const mwLament = [
  /* Dm     */ N.A4,0,    0,0,       N.D5,0,
  /* A/C#   */ N.E5,0,    0,0,       0,0,
  /* Dm/C   */ N.F5,0,    0,N.E5,    N.D5,0,
  /* B♭     */ N.D5,0,    N.C5,0,    N.Bb4,0,
  /* A      */ N.A4,0,    0,0,       N.Cs5,0,
  /* Gm7    */ N.D5,0,    N.F5,0,    N.G5,0,
  /* A7     */ N.A5,0,    0,N.G5,    N.F5,0,
  /* Dmin   */ N.E5,0,    N.D5,0,    0,0,
];

// The trio, in B♭ major — the waltz's warm relative — on a music box.
const mwTrio = [
  /* Bbmaj7 */ N.D5,0,    0,0,       N.F5,0,
  /* Fmaj   */ N.A5,0,    0,N.G5,    N.F5,0,
  /* Gm7    */ N.G5,0,    0,0,       N.D5,0,
  /* Dmin   */ N.F5,0,    N.E5,0,    N.D5,0,
  /* Bbmaj7 */ N.F5,0,    0,0,       N.D5,0,
  /* Cmaj   */ N.E5,0,    N.G5,0,    N.E5,0,
  /* Fmaj7  */ N.F5,0,    0,N.E5,    N.D5,0,
  /* Fmaj   */ N.C5,0,    0,0,       0,0,
];

// The trio again — flute singing it, bells answering in the gaps — and
// the A7 in the last bar is the door back to D minor.
const mwTrio2 = [
  /* Bbmaj7 */ N.F4,0,    N.Bb4,0,   N.D5,0,
  /* Gm7    */ N.D5,0,    0,N.C5,    N.Bb4,0,
  /* Fmaj   */ N.A4,0,    N.C5,0,    N.F5,0,
  /* Dmin   */ N.E5,0,    0,0,       N.D5,0,
  /* Gm7    */ N.Bb4,0,   N.D5,0,    N.G5,0,
  /* Cmaj   */ N.E5,0,    0,N.D5,    N.C5,0,
  /* Fmaj   */ N.F5,0,    N.E5,0,    N.C5,0,
  /* A7     */ N.Cs5,0,   0,0,       N.E5,0,
];
const mwTrio2Alt = [    // the bells, answering every second bar
  0,0, 0,0, 0,0,         0,0, N.G5,0, N.F5,0,
  0,0, 0,0, 0,0,         0,0, N.A5,0, N.F5,0,
  0,0, 0,0, 0,0,         0,0, N.G5,0, N.E5,0,
  0,0, 0,0, 0,0,         0,0, N.A5,0, N.G5,0,
];

// Four bars of climb, brass underneath, everything pointing at the A7.
const mwClimb = [
  /* Dmin */ N.D5,0,     N.F5,0,    N.A5,0,
  /* Gm7  */ N.Bb4,0,    N.D5,0,    N.G5,0,
  /* A7   */ N.Cs5,0,    N.E5,0,    N.G5,0,
  /* A7   */ N.A5,0,     0,0,       0,0,
];
const mwClimbAlt = [
  N.F4,0, 0,0, 0,0,      N.G4,0, 0,0, 0,0,
  N.A4,0, 0,0, 0,0,      N.Cs5,0, 0,0, N.E5,0,
];

// The grand return: the theme's ground, but the tune comes down from the
// top instead of climbing to it, and there's a horn section now.
const mwGrand = [
  /* Dmin   */ N.A5,0,    0,N.G5,    N.F5,0,
  /* Bbmaj7 */ N.D5,0,    N.F5,0,    N.A5,0,
  /* Gm7    */ N.G5,0,    N.F5,0,    N.D5,0,
  /* A7     */ N.Cs5,0,   0,0,       N.E5,0,
  /* Dmin   */ N.F5,0,    0,N.E5,    N.D5,0,
  /* Gm7    */ N.Bb4,0,   N.D5,0,    N.G5,0,
  /* A7     */ N.A5,0,    N.G5,0,    N.E5,0,
  /* Dmin   */ N.F5,0,    0,0,       N.D5,0,
];
const mwGrandAlt = [
  N.D4,0, 0,0, N.F4,0,   N.F4,0, 0,0, N.D4,0,
  N.Bb4,0, 0,0, N.G4,0,  N.A4,0, 0,0, N.Cs5,0,
  N.D4,0, 0,0, N.A4,0,   N.Bb4,0, 0,0, N.G4,0,
  N.A4,0, 0,0, N.G4,0,   N.F4,0, 0,0, N.D4,0,
];

// The climax — hemiola again, brass included this time, top B♭.
const mwGrand2 = [
  /* Dmin   */ N.A5,0,    0,0,       N.F5,0,
  /* Dmin   */ 0,0,       N.D5,0,    0,0,
  /* Bbmaj7 */ N.Bb5,0,   0,0,       N.A5,0,
  /* Bbmaj7 */ 0,0,       N.F5,0,    0,0,
  /* Gm7    */ N.G5,0,    N.F5,0,    N.D5,0,
  /* A7     */ N.E5,0,    N.Cs5,0,   N.A4,0,
  /* Dmin   */ N.D5,0,    N.F5,0,    N.A5,0,
  /* A7     */ N.G5,0,    0,0,       N.E5,0,
];
const mwGrand2Alt = [
  N.D4,0, 0,0, N.D4,0,   0,0, N.D4,0, 0,0,
  N.F4,0, 0,0, N.F4,0,   0,0, N.F4,0, 0,0,
  N.Bb4,0, 0,0, N.G4,0,  N.A4,0, 0,0, N.Cs5,0,
  N.D4,0, 0,0, N.F4,0,   N.A4,0, 0,0, N.G4,0,
];

// Down through the circle of fifths — D, G, C, F, B♭, E, A, D — losing
// a little height and a little light with every chord.
const mwFall = [
  /* Dmin   */ N.A5,0,    N.G5,N.F5, N.E5,0,
  /* Gm7    */ N.D5,0,    0,0,       N.Bb4,0,
  /* Cmaj   */ N.C5,0,    N.E5,0,    N.G5,0,
  /* Fmaj7  */ N.F5,0,    0,N.E5,    N.C5,0,
  /* Bbmaj7 */ N.D5,0,    0,0,       N.F5,0,
  /* Em7b5  */ N.E5,0,    N.D5,0,    N.Bb4,0,
  /* A7     */ N.A4,0,    N.Cs5,0,   N.E5,0,
  /* Dmin   */ N.D5,0,    0,0,       N.A4,0,
];
const mwFallAlt = [     // a bell shadow, one note every second bar
  0,0, 0,0, 0,0,         0,0, 0,0, N.D5,0,
  0,0, 0,0, 0,0,         0,0, 0,0, N.A4,0,
  0,0, 0,0, 0,0,         0,0, 0,0, N.G4,0,
  0,0, 0,0, 0,0,         0,0, 0,0, N.F4,0,
];

// Four slow bars, and the last chord is D MAJOR.
const mwLast = [
  /* Gm7  */ N.D5,0,     0,0,       N.Bb4,0,
  /* A7   */ N.Cs5,0,    0,0,       N.E5,0,
  /* Dmin */ N.D5,0,     0,0,       N.F5,0,
  /* Dmaj */ N.Fs5,0,    0,0,       0,0,
];

const songWaltz = [
  // Moonrise. Organ, bells, one flute phrase, no kit.
  { section: "moonrise", fig: "moon", bpm: 100,
    prog: [CH.Dmadd9, CH.Bbmaj7, CH.Gm7, CH.A7], mel: mwRise,
    drums: "none", sus: 6, bassDur: 4, arpDur: 3, ring: 5,
    voice: { chord: "organ", lead: "flute", arp: "bell" },
    vel: { chord: 0.026, lead: 0.06, arp: 0.03, bass: 0.13 } },

  // The waltz proper: flute over nylon guitar, brushes.
  { section: "waltz", fig: "landler", bpm: 112, groove: true, accent: ACCENT3,
    prog: [CH.Dmin, CH.Bbmaj7, CH.Gm7, CH.A7, CH.Dmin, CH.Gm7, CH.A7, CH.Dmin],
    mel: mwTheme, drums: "waltz", sus: 2.4, bassDur: 2,
    voice: { chord: "guitar", lead: "flute", arp: "guitar" },
    vel: { chord: 0.05, lead: 0.08, arp: 0.032, bass: 0.18 } },

  // The answer, with an electric piano moving inside the harmony.
  { section: "waltz2", fig: "sway", bpm: 112, groove: true, accent: ACCENT3,
    prog: [CH.Dmin, CH.Bbmaj7, CH.Fmaj7, CH.Cmaj, CH.Bbmaj7, CH.Gm7, CH.A7, CH.Dmin],
    mel: mwTheme2, mel2: mwTheme2Alt, drums: "sway", sus: 2.4, bassDur: 2, ring2: 5,
    voice: { chord: "guitar", lead: "flute", arp: "guitar", lead2: "keys" },
    vel: { chord: 0.048, lead: 0.08, arp: 0.03, bass: 0.18, lead2: 0.042 } },

  // Where the bar lines stop agreeing with the beat.
  { section: "turn", fig: "hemiola", bpm: 112, groove: true, accent: ACCENT3,
    prog: [CH.Gm7, CH.A7, CH.Dmin, CH.Bbmaj7, CH.Gm7, CH.Em7b5, CH.A7, CH.A7],
    mel: mwTurn, drums: "sway", sus: 2.8, bassDur: 2.2,
    voice: { chord: "keys", lead: "flute", arp: "pluck" },
    vel: { chord: 0.042, lead: 0.085, arp: 0.035, bass: 0.19 } },

  // The lament. Organ, and a bass falling into the cellar.
  { section: "lament", fig: "lament", bpm: 108, groove: true, accent: ACCENT3,
    prog: [LAM[0], LAM[1], LAM[2], LAM[3], LAM[4], CH.Gm7, CH.A7, CH.Dmin],
    mel: mwLament, drums: "waltz", drumV: 0.55, sus: 6, bassDur: 4.5,
    voice: { chord: "organ", lead: "flute", arp: "guitar" },
    vel: { chord: 0.028, lead: 0.082, arp: 0.03, bass: 0.17 } },

  // Trio, B♭ major, music box. No kit at all.
  { section: "trio", fig: "box", bpm: 104,
    prog: [CH.Bbmaj7, CH.Fmaj, CH.Gm7, CH.Dmin, CH.Bbmaj7, CH.Cmaj, CH.Fmaj7, CH.Fmaj],
    mel: mwTrio, drums: "none", sus: 6, bassDur: 4, arpDur: 2,
    voice: { chord: "organ", lead: "bell", arp: "bell" },
    vel: { chord: 0.024, lead: 0.055, arp: 0.028, bass: 0.14 } },

  // Trio, second time: the flute takes it and the bells answer.
  { section: "trio2", fig: "landler", bpm: 104, groove: true, accent: ACCENT3,
    prog: [CH.Bbmaj7, CH.Gm7, CH.Fmaj, CH.Dmin, CH.Gm7, CH.Cmaj, CH.Fmaj, CH.A7],
    mel: mwTrio2, mel2: mwTrio2Alt, drums: "waltz", drumV: 0.6, sus: 2.4, bassDur: 2,
    voice: { chord: "guitar", lead: "flute", arp: "guitar", lead2: "bell" },
    vel: { chord: 0.046, lead: 0.08, arp: 0.03, bass: 0.17, lead2: 0.04 } },

  // Four bars of impatience.
  { section: "climb", fig: "climb", bpm: 110, groove: true, accent: ACCENT3,
    prog: [CH.Dmin, CH.Gm7, CH.A7, CH.A7],
    mel: mwClimb, mel2: mwClimbAlt, drums: "ball", drumV: 0.85, sus: 2.2, bassDur: 1.6,
    voice: { chord: "guitar", lead: "flute", arp: "pluck", lead2: "brass" },
    vel: { chord: 0.05, lead: 0.085, arp: 0.034, bass: 0.19, lead2: 0.05 } },

  // The ballroom.
  { section: "grand", fig: "ball", bpm: 116, groove: true, accent: ACCENT3,
    prog: [CH.Dmin, CH.Bbmaj7, CH.Gm7, CH.A7, CH.Dmin, CH.Gm7, CH.A7, CH.Dmin],
    mel: mwGrand, mel2: mwGrandAlt, drums: "ball", sus: 2.4, bassDur: 1.8, ring2: 1.7,
    voice: { chord: "guitar", lead: "flute", arp: "guitar", lead2: "brass" },
    vel: { chord: 0.05, lead: 0.09, arp: 0.032, bass: 0.18, lead2: 0.046 } },

  // The climax: in two again, with the horns.
  { section: "grand2", fig: "hemiola", bpm: 116, groove: true, accent: ACCENT3,
    prog: [CH.Dmin, CH.Dmin, CH.Bbmaj7, CH.Bbmaj7, CH.Gm7, CH.A7, CH.Dmin, CH.A7],
    mel: mwGrand2, mel2: mwGrand2Alt, drums: "ball", sus: 3, bassDur: 2.2, ring2: 1.7,
    voice: { chord: "guitar", lead: "flute", arp: "guitar", lead2: "brass" },
    vel: { chord: 0.05, lead: 0.09, arp: 0.032, bass: 0.18, lead2: 0.046 } },

  // Winding down the circle of fifths.
  { section: "fall", fig: "sway", bpm: 104, groove: true, accent: ACCENT3,
    prog: [CH.Dmin, CH.Gm7, CH.Cmaj, CH.Fmaj7, CH.Bbmaj7, CH.Em7b5, CH.A7, CH.Dmin],
    mel: mwFall, mel2: mwFallAlt, drums: "sway", drumV: 0.8, sus: 2.4, bassDur: 2, ring2: 4,
    voice: { chord: "guitar", lead: "flute", arp: "guitar", lead2: "bell" },
    vel: { chord: 0.046, lead: 0.08, arp: 0.028, bass: 0.17, lead2: 0.035 } },

  // Slower, and out on the major third.
  { section: "last", fig: "moon", bpm: 88,
    prog: [CH.Gm7, CH.A7, CH.Dmin, CH.Dmaj], mel: mwLast,
    drums: "none", sus: 6, bassDur: 4.5, arpDur: 4, ring: 6,
    voice: { chord: "organ", lead: "bell", arp: "bell" },
    vel: { chord: 0.026, lead: 0.05, arp: 0.026, bass: 0.13 } },
].map((s) => mwSect({ ...s, song: "waltz" }));

// ---- "Sunrise Hymn" — F major, fifty-six bars, a bit over three
// minutes. Written as a chorale rather than a chord loop: a tune, a bass
// line that is its own melody, and inner voices that MOVE while the outer
// ones hold. That last part is the whole difference. The old version put
// one chord and one bass note in each of its thirty-two bars and left
// them there; nothing inside the harmony ever went anywhere, so however
// good the tune was, the piece sat still.
//
// The shape is a hymn as an organist would actually play one, and the
// registration opens up a stop at a time:
//
//   dawn     bells over a pedal, before anything else arrives
//   hymn     the tune, plainly harmonised — flute and organ, nothing else
//   verse2   the tune re-composed over a rising bass, chimes added
//   shadow   B♭ MINOR and D♭ borrowed from F minor, over an F that never
//            moves — the cloud, with the sun still behind it
//   rise     secondary dominants climbing in sequence; the trumpet enters
//   full     the big verse: tune on brass, flute counter above, timpani
//   descant  the last verse — tune inside on the electric piano, and a
//            DESCANT soaring over the top of it, which is the thing every
//            hymn saves for its final verse
//   amen     a plagal cadence over a tonic pedal, and the last cloud
//            (B♭ minor) clearing to F major
//
// The harmony is written as a chord PER HALF BAR, not per bar, so
// cadences can actually cadence; `shSect` takes either a single chord or
// a pair. And the bass gets inversions — the tune in the first verse is
// carried over a bass that walks F–D–B♭–C–D–B♭–G–C–F–E–D–G–A–B♭–C–F,
// which is a line you could sing on its own.

// Build a Sunrise Hymn section. Each entry of `prog` is one bar: either a
// chord, or a pair of chords for the two halves of the bar.
function shSect(o) {
  const meter = 8;
  const bars = o.prog.length;
  const steps = bars * meter;
  const chords = new Array(steps).fill(0);
  const bass = new Array(steps).fill(0);
  const arp = new Array(steps).fill(0);
  // A passing bass note taken from the chord. `fold` puts it within an
  // octave above the root, which is right until the root is already high
  // — an inversion on F3 would otherwise walk up to middle C, where it
  // stops sounding like a bass at all. Drop it back down if so.
  const walk = (f, r) => { let v = fold(f, r); while (v > 200) v /= 2; return v; };

  o.prog.forEach((entry, bar) => {
    const at = bar * meter;
    const pair = Array.isArray(entry) ? entry : [entry];
    const c1 = pair[0];
    const c2 = pair[1] ?? null;
    const t1 = c1.n, t2 = (c2 ?? c1).n;
    // The inner voice steps through the chord from a different place each
    // bar, which is how a tenor line stays interesting without ever
    // leaving the harmony.
    const i1 = (n) => t1[(bar + n) % t1.length];
    const i2 = (n) => t2[(bar + n) % t2.length];
    const nextC = (() => {
      const e = o.prog[bar + 1];
      if (!e) return null;
      return Array.isArray(e) ? e[0] : e;
    })();

    // Harmony and bass are the same in every figure: on the downbeat, and
    // again halfway through if the bar holds two chords.
    chords[at] = t1;
    bass[at] = c1.r;
    if (c2) { chords[at + 4] = t2; bass[at + 4] = c2.r; }

    if (o.fig === "pedal") {
      // Nothing but the chord and a bell, placed differently every bar so
      // four bars of one held harmony never tick like a clock.
      const p = bar % 3;
      if (p === 0) { arp[at + 2] = i1(1); arp[at + 5] = i1(2); }
      else if (p === 1) { arp[at + 3] = i1(2); arp[at + 6] = t1[0] * 2; }
      else { arp[at + 1] = i1(0); arp[at + 4] = i1(1); arp[at + 7] = i1(2); }

    } else if (o.fig === "chorale") {
      // Four parts. The tenor moves on beats two and four — the beats
      // where the chords are holding — so something is always in motion
      // even though the harmony changes only twice a bar.
      arp[at + 2] = i1(1);
      arp[at + 6] = i2(2);
      // and every second bar the bass steps chromatically into the next
      // chord instead of jumping to it.
      if (nextC && bar % 2 === 1) bass[at + 7] = approach(c2 ? c2.r : c1.r, nextC.r);

    } else if (o.fig === "chorale2") {
      // The same, with the inner voice in eighths: it passes THROUGH the
      // chord rather than just landing on it.
      arp[at + 2] = i1(1); arp[at + 3] = i1(2);
      arp[at + 6] = i2(2); arp[at + 7] = i2(0);
      if (c2) bass[at + 2] = walk(t1[1], c1.r);
      if (nextC && bar % 2 === 1) bass[at + 7] = approach(c2 ? c2.r : c1.r, nextC.r);

    } else if (o.fig === "shade") {
      // Almost still. One inner note per half bar, drifting downward.
      arp[at + 3] = i1(2);
      if (c2) arp[at + 7] = i2(1);
      else if (bar % 2 === 1) arp[at + 6] = i1(0);

    } else if (o.fig === "climb") {
      // The bass walks in quarters and the inner voice runs the offbeats,
      // so the section gathers itself without getting any louder.
      bass[at + 2] = walk(t1[1], c1.r);
      if (c2) bass[at + 6] = walk(t2[1], c2.r);
      arp[at + 1] = i1(0); arp[at + 3] = i1(1);
      arp[at + 5] = i2(1); arp[at + 7] = i2(2);

    } else if (o.fig === "full") {
      // Full organ: walking bass, running counterpoint underneath the
      // brass, and the chord re-articulated on the third beat so the big
      // verse has a pulse to sing against.
      bass[at + 2] = walk(t1[t1.length - 1], c1.r);
      if (c2) bass[at + 6] = walk(t2[t2.length - 1], c2.r);
      arp[at + 1] = i1(0); arp[at + 3] = i1(2);
      arp[at + 5] = i2(0); arp[at + 7] = i2(2);
      if (nextC && bar % 4 === 3) bass[at + 7] = approach(c2 ? c2.r : c1.r, nextC.r);

    } else {
      // "descant" — deliberately thin underneath. Two bell notes a bar and
      // nothing else, because the whole point of the section is the air
      // above the tune.
      arp[at + 2] = i1(2);
      arp[at + 6] = i2(1);
    }
  });

  const mel = o.mel ?? new Array(steps).fill(0);
  const out = { ...o, meter, chords, bass, arp, mel, melDur: phrase(mel, o.ring ?? 8, 0.97) };
  if (o.mel2) out.mel2Dur = phrase(o.mel2, o.ring2 ?? 8, 0.97);
  return out;
}

// --- the tune and its relations. Eight steps to a bar; quarter notes
// land on 0, 2, 4 and 6, which is already twice the motion the old
// version had.

// Before the sun: six bell notes, spread over four bars.
const shDawn = [
  /* F      */ 0,0,0,0,        N.F4,0,0,0,
  /* F/A    */ N.A4,0,0,0,     0,0,0,0,
  /* Bb     */ N.D5,0,0,0,     0,0,N.C5,0,
  /* Csus4  */ N.C5,0,0,0,     0,0,0,0,
];

// THE TUNE. Rises through the tonic triad, arches to a peak in bar five,
// and walks home. Everything else in the piece is related to it.
const shHymn = [
  /* F   Dm    */ N.F4,0,N.G4,0,    N.A4,0,0,0,
  /* Bb  F/C   */ N.Bb4,0,N.A4,0,   N.G4,0,N.F4,0,
  /* Dm  Bb    */ N.A4,0,0,0,       N.Bb4,0,N.C5,0,
  /* Gm  C     */ N.D5,0,0,0,       N.C5,0,0,0,
  /* F   C/E   */ N.F5,0,0,0,       N.E5,0,N.D5,0,
  /* Dm7 Gm    */ N.C5,0,N.D5,0,    N.Bb4,0,0,0,
  /* F/A Bb    */ N.A4,0,N.G4,0,    N.A4,0,N.Bb4,0,
  /* C7  F     */ N.G4,0,0,0,       N.F4,0,0,0,
];

// The tune's answer, over a bass that climbs where the first one fell.
const shVerse2 = [
  /* F   F/A   */ N.C5,0,N.D5,0,    N.C5,0,N.A4,0,
  /* Bb  C     */ N.Bb4,0,0,0,      N.C5,0,N.D5,0,
  /* Dm  C/E   */ N.F5,0,0,0,       N.E5,0,0,0,
  /* F   Bb    */ N.D5,0,N.C5,0,    N.D5,0,N.F5,0,
  /* Gm7 C     */ N.G5,0,0,0,       N.F5,0,N.E5,0,
  /* Am7 Dm    */ N.C5,0,N.E5,0,    N.D5,0,N.C5,0,
  /* Gm7 C7    */ N.Bb4,0,N.A4,0,   N.G4,0,0,0,
  /* F   F/C   */ N.A4,0,0,0,       N.F4,0,0,0,
];
const shVerse2Alt = [   // chimes, every second bar
  0,0,0,0, 0,0,0,0,      N.F5,0,0,0, 0,0,0,0,
  0,0,0,0, 0,0,0,0,      N.A5,0,0,0, 0,0,0,0,
  0,0,0,0, 0,0,0,0,      N.E5,0,0,0, 0,0,0,0,
  0,0,0,0, 0,0,0,0,      N.F5,0,0,0, 0,0,0,0,
];

// The cloud. B♭ minor and D♭ over an F that refuses to move, and in bar
// five the melody itself slides from D natural to D♭ and back.
const shShadow = [
  /* Dm        */ N.D5,0,0,0,       N.A4,0,0,0,
  /* Bbm       */ N.Bb4,0,0,0,      N.Cs5,0,0,0,
  /* F/A F     */ N.C5,0,0,0,       N.A4,0,0,0,
  /* Db        */ N.F5,0,0,0,       N.Cs5,0,0,0,
  /* Bb  Bbm   */ N.D5,0,0,0,       N.Cs5,0,0,0,
  /* F/C Gm7   */ N.C5,0,0,0,       N.Bb4,0,N.G4,0,
  /* C7        */ N.G4,0,N.A4,0,    N.Bb4,0,0,0,
  /* F   C/E   */ N.A4,0,0,0,       N.G4,0,0,0,
];
const shShadowAlt = [   // a tenor holding F while everything around it darkens
  N.F4,0,0,0, 0,0,0,0,   N.F4,0,0,0, 0,0,0,0,
  N.F4,0,0,0, 0,0,0,0,   N.F4,0,0,0, 0,0,0,0,
  N.F4,0,0,0, N.F4,0,0,0, N.A4,0,0,0, N.Bb4,0,0,0,
  N.G4,0,0,0, 0,0,0,0,   N.F4,0,0,0, N.E4,0,0,0,
];

// Three two-bar rungs, each a step higher than the last, with a D7 that
// doesn't belong to F major at all pulling it up the third time.
const shRise = [
  /* F   F/A   */ N.A4,0,N.C5,0,    N.F5,0,0,0,
  /* Bb  Bb/D  */ N.Bb4,0,0,0,      N.A4,0,N.G4,0,
  /* C   C/E   */ N.C5,0,N.E5,0,    N.G5,0,0,0,
  /* Dm  D7    */ N.F5,0,0,0,       N.E5,0,N.D5,0,
  /* Gm  Gm7   */ N.Bb4,0,N.D5,0,   N.G5,0,0,0,
  /* C   C7    */ N.A5,0,0,0,       N.G5,0,N.E5,0,
  /* F   F/A   */ N.F5,0,N.E5,0,    N.F5,0,N.A5,0,
  /* Bb  C7    */ N.G5,0,0,0,       N.F5,0,N.E5,0,
];
const shRiseAlt = [     // the trumpet, arriving in bar three
  0,0,0,0, 0,0,0,0,      0,0,0,0, 0,0,0,0,
  N.C4,0,0,0, 0,0,0,0,   N.D4,0,0,0, N.Fs4,0,0,0,
  N.G4,0,0,0, N.Bb4,0,0,0, N.C4,0,0,0, N.E4,0,0,0,
  N.F4,0,0,0, N.A4,0,0,0, N.Bb4,0,0,0, N.G4,0,0,0,
];

// The big verse: the tune on the brass, in the middle of the texture
// where a congregation would be.
const shFull = [
  /* F   F/A   */ N.F4,0,N.A4,0,    N.C5,0,0,0,
  /* Bb  F/C   */ N.D5,0,0,0,       N.C5,0,N.Bb4,0,
  /* Dm  Dm/A  */ N.A4,0,N.Bb4,0,   N.C5,0,N.D5,0,
  /* Gm7 C     */ N.Bb4,0,0,0,      N.C5,0,0,0,
  /* F   F/A   */ N.A4,0,N.C5,0,    N.F5,0,0,0,
  /* Bb  Gm7   */ N.D5,0,0,0,       N.Bb4,0,N.D5,0,
  /* C   C7    */ N.C5,0,N.Bb4,0,   N.A4,0,N.G4,0,
  /* F         */ N.F4,0,0,0,       0,0,0,0,
];
const shFullAlt = [     // flute, above the brass, moving where it holds
  N.C5,0,0,0, N.F5,0,0,0,   N.F5,0,N.E5,0, N.D5,0,0,0,
  N.F5,0,0,0, N.A5,0,0,0,   N.G5,0,0,0, N.E5,0,0,0,
  N.F5,0,0,0, N.A5,0,0,0,   N.Bb5,0,0,0, N.G5,0,0,0,
  N.E5,0,0,0, N.G5,0,0,0,   N.F5,0,0,0, 0,0,0,0,
];

// The last verse. The DESCANT — this line — is the one that goes up.
const shDescant = [
  /* F   Bb/F  */ N.F5,0,0,0,       N.G5,0,0,0,
  /* F   C/E   */ N.A5,0,0,0,       N.G5,0,N.F5,0,
  /* Dm  Gm7/Bb*/ N.D5,0,N.F5,0,    N.G5,0,0,0,
  /* C   C7    */ N.G5,0,0,0,       N.A5,0,N.G5,0,
  /* F   Dm/A  */ N.F5,0,0,0,       N.A5,0,0,0,
  /* Bb  F/C   */ N.Bb5,0,0,0,      N.A5,0,N.G5,0,
  /* Gm7 C7    */ N.F5,0,N.G5,0,    N.A5,0,N.Bb5,0,
  /* F         */ N.A5,0,0,0,       0,0,0,0,
];
const shDescantAlt = [  // and the tune underneath it, on the electric piano
  N.C5,0,0,0, N.Bb4,0,N.A4,0,   N.A4,0,N.G4,0, N.E4,0,N.G4,0,
  N.A4,0,0,0, N.Bb4,0,N.D5,0,   N.C5,0,0,0, N.Bb4,0,N.A4,0,
  N.F4,0,N.A4,0, N.C5,0,0,0,    N.D5,0,0,0, N.C5,0,N.Bb4,0,
  N.Bb4,0,N.A4,0, N.G4,0,0,0,   N.F4,0,0,0, 0,0,0,0,
];

// Amen. Four bars over one bass note, and the B♭ turns minor once more
// before it lets go.
const shAmen = [
  /* Bb/F      */ N.C5,0,0,0,       0,0,0,0,
  /* F         */ N.A4,0,0,0,       0,0,0,0,
  /* Bbm/F     */ N.Cs5,0,0,0,      0,0,0,0,
  /* Fwide     */ N.C5,0,0,0,       N.F5,0,0,0,
];

const songHymn = [
  // Before the sun.
  { section: "dawn", fig: "pedal", bpm: 66,
    prog: [CH.Fmaj, inv(CH.Fmaj, N.A2), CH.Bbmaj, inv(CH.Csus4, N.C3)],
    mel: shDawn, drums: "none", sus: 8.4, bassDur: 6, arpDur: 4.5,
    voice: { chord: "organ", lead: "bell", arp: "bell" },
    vel: { chord: 0.026, lead: 0.05, arp: 0.026, bass: 0.13 } },

  // The tune, plainly set: flute, organ, and one moving inner voice.
  { section: "hymn", fig: "chorale", bpm: 72,
    prog: [
      [CH.Fmaj, inv(CH.Dmin, N.D3)],
      [CH.Bbmaj, inv(CH.Fmaj, N.C3)],
      [inv(CH.Dmin, N.D3), CH.Bbmaj],
      [CH.Gmin, inv(CH.Cmaj, N.C3)],
      [inv(CH.Fmaj, N.F3), inv(CH.Cmaj, N.E3)],
      [inv(CH.Dm7, N.D3), CH.Gmin],
      [inv(CH.Fmaj, N.A2), CH.Bbmaj],
      [inv(CH.C7, N.C3), CH.Fmaj],
    ],
    mel: shHymn, drums: "none", sus: 4.4, bassDur: 3.4,
    voice: { chord: "organ", lead: "flute", arp: "guitar" },
    vel: { chord: 0.03, lead: 0.075, arp: 0.028, bass: 0.18 } },

  // Said again, differently, over a bass that climbs. Chimes added.
  { section: "verse2", fig: "chorale2", bpm: 74,
    prog: [
      [CH.Fmaj, inv(CH.Fmaj, N.A2)],
      [CH.Bbmaj, inv(CH.Cmaj, N.C3)],
      [inv(CH.Dmin, N.D3), inv(CH.Cmaj, N.E3)],
      [inv(CH.Fmaj, N.F3), CH.Bbmaj],
      [CH.Gm7, inv(CH.Cmaj, N.C3)],
      [CH.Am7, inv(CH.Dmin, N.D3)],
      [CH.Gm7, inv(CH.C7, N.C3)],
      [CH.Fmaj, inv(CH.Fmaj, N.C3)],
    ],
    mel: shVerse2, mel2: shVerse2Alt, drums: "swell", drumV: 0.5,
    sus: 4.4, bassDur: 3.2, ring2: 8,
    voice: { chord: "organ", lead: "flute", arp: "guitar", lead2: "bell" },
    vel: { chord: 0.03, lead: 0.078, arp: 0.03, bass: 0.18, lead2: 0.04 } },

  // The cloud.
  { section: "shadow", fig: "shade", bpm: 70,
    prog: [
      inv(CH.Dmin, N.D3),
      CH.Bbmin,
      [inv(CH.Fmaj, N.A2), CH.Fmaj],
      CH.Dbmaj,
      [CH.Bbmaj, CH.Bbmin],
      [inv(CH.Fmaj, N.C3), CH.Gm7],
      inv(CH.C7, N.C3),
      [CH.Fmaj, inv(CH.Cmaj, N.E3)],
    ],
    mel: shShadow, mel2: shShadowAlt, drums: "none", sus: 7.6, bassDur: 5,
    voice: { chord: "organ", lead: "flute", arp: "guitar", lead2: "guitar" },
    vel: { chord: 0.028, lead: 0.08, arp: 0.026, bass: 0.16, lead2: 0.034 } },

  // Climbing, in sequence, and the trumpet arrives.
  { section: "rise", fig: "climb", bpm: 78,
    prog: [
      [CH.Fmaj, inv(CH.Fmaj, N.A2)],
      [CH.Bbmaj, inv(CH.Bbmaj, N.D3)],
      [inv(CH.Cmaj, N.C3), inv(CH.Cmaj, N.E3)],
      [inv(CH.Dmin, N.D3), CH.D7],
      [CH.Gmin, CH.Gm7],
      [inv(CH.Cmaj, N.C3), CH.C7],
      [CH.Fmaj, inv(CH.Fmaj, N.A2)],
      [CH.Bbmaj, inv(CH.C7, N.C3)],
    ],
    mel: shRise, mel2: shRiseAlt, drums: "timp", drumV: 0.8,
    sus: 4.2, bassDur: 2.6, ring2: 8,
    voice: { chord: "organ", lead: "flute", arp: "guitar", lead2: "brass" },
    vel: { chord: 0.03, lead: 0.082, arp: 0.032, bass: 0.19, lead2: 0.05 } },

  // Full organ. The tune goes to the brass.
  { section: "full", fig: "full", bpm: 78,
    prog: [
      [CH.Fmaj, inv(CH.Fmaj, N.A2)],
      [CH.Bbmaj, inv(CH.Fmaj, N.C3)],
      [inv(CH.Dmin, N.D3), inv(CH.Dmin, N.A2)],
      [CH.Gm7, inv(CH.Cmaj, N.C3)],
      [CH.Fmaj, inv(CH.Fmaj, N.A2)],
      [CH.Bbmaj, CH.Gm7],
      [inv(CH.Cmaj, N.C3), inv(CH.C7, N.C3)],
      CH.Fmaj,
    ],
    mel: shFull, mel2: shFullAlt, drums: "timp",
    sus: 4.2, bassDur: 2.4, ring: 6, ring2: 8,
    voice: { chord: "organ", lead: "brass", arp: "guitar", lead2: "flute" },
    vel: { chord: 0.032, lead: 0.07, arp: 0.03, bass: 0.19, lead2: 0.06 } },

  // The last verse, with the descant over the top.
  { section: "descant", fig: "descant", bpm: 76,
    prog: [
      [CH.Fmaj, inv(CH.Bbmaj, N.F2)],
      [CH.Fmaj, inv(CH.Cmaj, N.E3)],
      [inv(CH.Dmin, N.D3), inv(CH.Gm7, N.Bb2)],
      [inv(CH.Cmaj, N.C3), inv(CH.C7, N.C3)],
      [CH.Fmaj, inv(CH.Dmin, N.A2)],
      [CH.Bbmaj, inv(CH.Fmaj, N.C3)],
      [CH.Gm7, inv(CH.C7, N.C3)],
      CH.Fmaj,
    ],
    mel: shDescant, mel2: shDescantAlt, drums: "timp", drumV: 0.55,
    sus: 4.6, bassDur: 3.4, ring2: 8,
    voice: { chord: "organ", lead: "flute", arp: "bell", lead2: "keys" },
    vel: { chord: 0.03, lead: 0.085, arp: 0.03, bass: 0.18, lead2: 0.05 } },

  // Amen.
  { section: "amen", fig: "pedal", bpm: 58,
    prog: [inv(CH.Bbmaj, N.F2), CH.Fmaj, inv(CH.Bbmin, N.F2), CH.Fwide],
    mel: shAmen, drums: "none", sus: 8.4, bassDur: 6, arpDur: 5, ring: 8,
    voice: { chord: "organ", lead: "bell", arp: "bell" },
    vel: { chord: 0.03, lead: 0.05, arp: 0.026, bass: 0.15 } },
].map((s) => shSect({ ...s, song: "hymn" }));

// ====================== LOBBY SONGS ======================

// ---- "Still Water" — A minor, 6/8, sixty-eight bars, about two and a
// half minutes. The lobby's other two tracks are both slow common time
// with a chord per bar, so this one goes somewhere else entirely: a
// compound, rocking metre — the metre every barcarolle ever written is
// in, because it's the one that sounds like a boat — and an accompaniment
// made of one continuous rippling arpeggio rather than struck chords.
//
// The thing that makes it work is `cell`. The ripple is a short loop of
// chord-tone indices that runs straight across the section WITHOUT
// resetting at the bar line. A five-note cell in a six-step bar comes
// back to the downbeat only every five bars, so the figure lands
// differently in every bar while the harmony changes underneath it — the
// same shape of light on the water, never falling the same way twice.
// The cell length is the composition: six or three for the still
// sections, five for the rippled ones, seven where it shimmers hardest,
// and NONE at all in "still", where the water goes to glass.
//
// The other idea in it is the pedal. For most of the theme the bass does
// not move at all while the harmony drifts above it — F/A, Dm/A, G/A over
// an A that never changes. That is what the title means: the surface goes
// somewhere, the depth doesn't. In "deep" the bass finally does move, and
// walks a full octave down, A–G–F–E–D–C–B–A, to 55 Hz.
//
// And "reflection" is the theme's tune turned upside down — every step it
// rose, the mirror falls, around A4 as the waterline. It has never been
// heard before as pitches, and it is the same melody.

// Build a Still Water section. Six steps to a bar, felt in two: the
// dotted beats are steps 0 and 3.
function swSect(o) {
  const meter = 6;
  const bars = o.prog.length;
  const steps = bars * meter;
  const chords = new Array(steps).fill(0);
  const bass = new Array(steps).fill(0);
  const arp = new Array(steps).fill(0);

  o.prog.forEach((c, bar) => {
    const at = bar * meter;
    const next = o.prog[bar + 1] || null;
    for (const s of o.chordAt ?? [0]) chords[at + s] = c.n;
    (o.bassAt ?? [0]).forEach((s, k) => {
      if (k === 0) { bass[at + s] = c.r; return; }
      // While the bass is holding one note across bars — the pedal — the
      // second beat REPEATS it rather than decorating it. Decorating a
      // pedal defeats the point of having one. Everywhere else the bass
      // rocks up to a chord tone, which is the barcarolle figure.
      const held = (bar > 0 && o.prog[bar - 1].r === c.r) || (next && next.r === c.r);
      bass[at + s] = held ? c.r : fold(c.n[1], c.r);
    });
    // At the end of a four-bar phrase the bass steps into the next chord
    // instead of jumping — the only place anything here is in a hurry.
    if (next && o.turn && bar % 4 === 3) bass[at + 5] = approach(c.r, next.r);
  });

  // The ripple. `cell` indexes into the sounding chord; an index past the
  // end of the voicing wraps round an octave higher, so [0,1,2,3,2] on a
  // triad is up-and-over-the-top and back.
  const cell = o.cell ?? [];
  if (cell.length) {
    const mask = o.rip ?? [1, 1, 1, 1, 1, 1];
    let k = 0;
    for (let s = 0; s < steps; s++) {
      if (!mask[s % meter]) continue;
      const t = o.prog[Math.floor(s / meter)].n;
      const idx = cell[k % cell.length];
      arp[s] = t[idx % t.length] * 2 ** Math.floor(idx / t.length);
      k++;
    }
  }

  const mel = o.mel ?? new Array(steps).fill(0);
  const out = { ...o, meter, chords, bass, arp, mel, melDur: phrase(mel, o.ring ?? 6, 0.96) };
  if (o.mel2) out.mel2Dur = phrase(o.mel2, o.ring2 ?? 6, 0.96);
  return out;
}

// Shorthands for the pedal chords — the harmony moving over a bass that
// stays where it is.
const onA = (c) => inv(c, N.A2);

// --- the lines. Six steps to a bar, written as two dotted beats.

// Surface: two bell notes in four bars, and the ripple.
const swSurface = [
  /* Am9  */ 0,0,0,       0,0,0,
  /* Am9  */ 0,0,0,       N.E5,0,0,
  /* F/A  */ N.C5,0,0,    0,0,0,
  /* Em/A */ 0,0,0,       0,0,0,
];

// THE THEME. Rises to a held C, reaches D, and falls back; the second
// phrase starts lower and goes higher.
const swTheme = [
  /* Am9  */ N.A4,0,0,    N.B4,0,0,
  /* F/A  */ N.C5,0,0,    0,0,0,
  /* Dm/A */ N.D5,0,0,    N.C5,0,0,
  /* G/A  */ N.B4,0,0,    0,0,N.A4,
  /* Fmaj9*/ N.G4,0,0,    N.A4,0,N.C5,
  /* Cmaj9*/ N.E5,0,0,    0,N.D5,0,
  /* Dm7  */ N.C5,0,0,    N.A4,0,0,
  /* Em   */ N.B4,0,0,    0,0,0,
];

// The answer, on the flute, over a harmony that drifts by fifths.
const swTheme2 = [
  /* Dm7  */ N.A4,0,N.C5, N.D5,0,0,
  /* G    */ N.B4,0,N.D5, N.G5,0,0,
  /* Cmaj9*/ N.E5,0,0,    N.D5,0,N.C5,
  /* Fmaj9*/ N.A4,0,0,    N.C5,0,0,
  /* Dm   */ N.D5,0,N.F5, N.E5,0,N.D5,
  /* Em   */ N.B4,0,0,    N.G4,0,0,
  /* F    */ N.A4,0,N.C5, N.F5,0,0,
  /* Em   */ N.E5,0,0,    0,0,0,
];
const swTheme2Alt = [    // electric piano, underneath
  N.F4,0,0, N.A4,0,0,    N.G4,0,0, N.B4,0,0,
  N.G4,0,0, N.E4,0,0,    N.F4,0,0, N.G4,0,0,
  N.A4,0,0, N.F4,0,0,    N.G4,0,0, N.E4,0,0,
  N.F4,0,0, N.A4,0,0,    N.G4,0,0, N.B4,0,0,
];

// Deep: the bass walks a full octave down and the tune sinks with it,
// while a bell keeps striking the surface far above.
const swDeep = [
  /* Am    */ N.E4,0,0,   N.A4,0,0,
  /* Am/G  */ N.G4,0,0,   N.E4,0,0,
  /* F     */ N.F4,0,0,   N.A4,0,0,
  /* Em    */ N.G4,0,0,   N.B4,0,0,
  /* Dm7   */ N.A4,0,0,   N.F4,0,0,
  /* C     */ N.E4,0,0,   N.G4,0,0,
  /* G/B   */ N.D4,0,0,   N.B3,0,0,
  /* Am    */ N.A3,0,0,   0,0,0,
];
const swDeepAlt = [      // the light on the surface, not sinking
  0,0,0, 0,0,0,          N.A5,0,0, 0,0,0,
  0,0,0, 0,0,0,          N.G5,0,0, 0,0,0,
  0,0,0, 0,0,0,          N.E5,0,0, 0,0,0,
  0,0,0, 0,0,0,          N.A5,0,0, 0,0,0,
];

// Light: A turns Dorian — the F♯ in the D major and the B minor is the
// whole colour of this section, and the ripple runs its longest cell.
const swLight = [
  /* Am9  */ N.E5,0,0,    0,0,0,
  /* D    */ N.Fs5,0,0,   N.E5,0,0,
  /* Am9  */ N.E5,0,0,    N.C5,0,0,
  /* Bm7  */ N.D5,0,0,    N.Fs5,0,0,
  /* Cmaj9*/ N.E5,0,0,    N.G5,0,0,
  /* Dsus2*/ N.A5,0,0,    0,0,N.G5,
  /* Em   */ N.G5,0,0,    N.E5,0,0,
  /* Am   */ N.C5,0,0,    N.A4,0,0,
];
const swLightAlt = [     // bells, on the even bars
  0,0,0, 0,0,0,          N.A5,0,0, 0,0,0,
  0,0,0, 0,0,0,          N.Fs5,0,0, 0,0,0,
  0,0,0, 0,0,0,          N.D5,0,0, 0,0,0,
  0,0,0, 0,0,0,          N.E5,0,0, 0,0,0,
];

// Current: the water actually moves. One long note and two eighths, bar
// after bar, which is the only rhythmic ostinato in the piece.
const swCurrent = [
  /* Am   */ N.A4,0,0,    N.C5,0,N.E5,
  /* G    */ N.D5,0,0,    N.B4,0,N.G4,
  /* Fmaj9*/ N.C5,0,0,    N.A4,0,N.F4,
  /* Cmaj9*/ N.E5,0,N.G5, 0,0,N.E5,
  /* Dm7  */ N.F5,0,0,    N.D5,0,N.A4,
  /* Am   */ N.C5,0,0,    N.E5,0,N.A5,
  /* Em   */ N.G5,0,0,    N.E5,0,N.B4,
  /* G    */ N.D5,0,0,    0,0,0,
];
const swCurrentAlt = [   // guitar, moving against it
  N.E4,0,0, 0,0,0,       N.G4,0,0, 0,0,0,
  N.A4,0,0, 0,0,0,       N.G4,0,0, 0,0,0,
  N.F4,0,0, 0,0,0,       N.E4,0,0, 0,0,0,
  N.B4,0,0, 0,0,0,       N.D5,0,0, 0,0,0,
];

// Crest.
const swCrest = [
  /* Fmaj9*/ N.A5,0,0,    N.G5,0,N.F5,
  /* G    */ N.G5,0,0,    N.D5,0,N.B4,
  /* Am   */ N.C5,0,N.E5, N.A5,0,0,
  /* Am   */ N.G5,0,0,    N.E5,0,0,
  /* Fmaj9*/ N.F5,0,0,    N.A5,0,N.G5,
  /* Cmaj9*/ N.E5,0,0,    N.D5,0,N.E5,
  /* Dm7  */ N.F5,0,0,    N.A5,0,0,
  /* Em   */ N.G5,0,0,    N.E5,0,0,
];
const swCrestAlt = [
  N.C5,0,0, 0,0,0,       0,0,0, 0,0,0,
  N.E5,0,0, 0,0,0,       0,0,0, 0,0,0,
  N.C5,0,0, 0,0,0,       0,0,0, 0,0,0,
  N.D5,0,0, 0,0,0,       0,0,0, 0,0,0,
];

// Still: no ripple at all. Four notes in ten seconds.
const swStill = [
  /* Am9   */ N.E5,0,0,   0,0,0,
  /* Fmaj9 */ N.C5,0,0,   0,0,0,
  /* Dsus2 */ N.D5,0,0,   0,0,0,
  /* Esus4 */ N.B4,0,0,   0,0,0,
];

// Reflection: a new bell line on the surface, and underneath it the
// THEME INVERTED — mirrored note for note around A4.
const swReflect = [
  /* Am9  */ N.E5,0,0,    0,0,0,
  /* Dm/A */ N.D5,0,0,    N.F5,0,0,
  /* F/A  */ N.E5,0,0,    N.C5,0,0,
  /* G/A  */ N.D5,0,0,    N.B4,0,0,
  /* G    */ N.D5,0,0,    N.G5,0,0,
  /* Cmaj9*/ N.E5,0,0,    N.G5,0,0,
  /* Dm7  */ N.F5,0,0,    N.D5,0,0,
  /* Em   */ N.E5,0,0,    0,0,0,
];
const swReflectAlt = [   // the theme, upside down
  N.A4,0,0, N.G4,0,0,    N.F4,0,0, 0,0,0,
  N.E4,0,0, N.F4,0,0,    N.G4,0,0, 0,0,N.A4,
  N.B4,0,0, N.A4,0,N.F4, N.D4,0,0, 0,N.E4,0,
  N.F4,0,0, N.A4,0,0,    N.G4,0,0, 0,0,0,
];

// Settle: back to the pedal, and down.
const swSettle = [
  /* Am9  */ N.E5,0,0,    0,0,0,
  /* F/A  */ N.C5,0,0,    0,0,0,
  /* Em/A */ N.B4,0,0,    0,0,0,
  /* Am9  */ N.A4,0,0,    0,0,0,
];

const songStillWater = [
  // Surface. A flute pad, a ripple that lines up exactly with the bar,
  // and nothing has happened yet.
  { section: "surface", bpm: 76, cell: [0, 1, 2, 3, 2, 1],
    prog: [CH.Amadd9, CH.Amadd9, onA(CH.Fmaj), onA(CH.Emin)],
    mel: swSurface, drums: "none", sus: 6, bassDur: 6, arpDur: 1.6,
    voice: { chord: "flute", lead: "bell", arp: "pluck" },
    vel: { chord: 0.026, lead: 0.05, arp: 0.026, bass: 0.14 } },

  // The theme, over a bass that never moves. Five-note cell — the first
  // ripple, and from here the accompaniment stops repeating.
  { section: "theme", bpm: 80, cell: [0, 1, 2, 3, 2], bassAt: [0, 3],
    prog: [CH.Amadd9, onA(CH.Fmaj), onA(CH.Dmin), onA(CH.Gmaj),
           CH.Fmaj9, CH.Cmaj9, CH.Dm7, CH.Emin],
    mel: swTheme, drums: "none", sus: 6, bassDur: 3.2, arpDur: 1.6,
    voice: { chord: "flute", lead: "bell", arp: "pluck" },
    vel: { chord: 0.026, lead: 0.055, arp: 0.028, bass: 0.16 } },

  // The answer: flute takes it, the ripple falls instead of rising.
  { section: "theme2", bpm: 80, cell: [4, 3, 2, 1, 0], bassAt: [0, 3], turn: true,
    prog: [CH.Dm7, CH.Gmaj, CH.Cmaj9, CH.Fmaj9, CH.Dmin, CH.Emin, CH.Fmaj, CH.Emin],
    mel: swTheme2, mel2: swTheme2Alt, drums: "none", sus: 6, bassDur: 3.2, arpDur: 1.6,
    voice: { chord: "organ", lead: "flute", arp: "pluck", lead2: "keys" },
    vel: { chord: 0.026, lead: 0.075, arp: 0.028, bass: 0.17, lead2: 0.038 } },

  // Deep. Three-note cell, thinned to every other step — the ripple
  // almost stops — and the bass walks an octave down to 55 Hz.
  { section: "deep", bpm: 74, cell: [0, 1, 2], rip: [1, 0, 1, 0, 1, 0],
    prog: [CH.Amin, inv(CH.Amin, N.G2), CH.Fmaj, CH.Emin,
           CH.Dm7, CH.Cmaj, inv(CH.Gmaj, N.B1), inv(CH.Amin, N.A1)],
    mel: swDeep, mel2: swDeepAlt, drums: "none", sus: 6.2, bassDur: 5.5, arpDur: 2.2, ring2: 6,
    voice: { chord: "organ", lead: "keys", arp: "guitar", lead2: "bell" },
    vel: { chord: 0.028, lead: 0.06, arp: 0.026, bass: 0.19, lead2: 0.038 } },

  // Light. A goes Dorian, and the cell is seven notes long — the widest
  // mismatch in the piece, so the shimmer never settles.
  { section: "light", bpm: 82, cell: [2, 3, 4, 5, 4, 3, 2], bassAt: [0, 3],
    prog: [CH.Amadd9, CH.Dmaj, CH.Amadd9, CH.Bmin7,
           CH.Cmaj9, CH.Dsus2, CH.Emin, CH.Amin],
    mel: swLight, mel2: swLightAlt, drums: "none", sus: 6, bassDur: 3.2, arpDur: 1.4, ring2: 6,
    voice: { chord: "keys", lead: "flute", arp: "pluck", lead2: "bell" },
    vel: { chord: 0.03, lead: 0.075, arp: 0.024, bass: 0.17, lead2: 0.034 } },

  // Current.
  { section: "current", bpm: 86, cell: [0, 1, 2, 3, 2], bassAt: [0, 3],
    chordAt: [0, 3], turn: true,
    prog: [CH.Amin, CH.Gmaj, CH.Fmaj9, CH.Cmaj9, CH.Dm7, CH.Amin, CH.Emin, CH.Gmaj],
    mel: swCurrent, mel2: swCurrentAlt, drums: "tide", sus: 3, bassDur: 2.6, arpDur: 1.4, ring2: 6,
    voice: { chord: "keys", lead: "flute", arp: "pluck", lead2: "guitar" },
    vel: { chord: 0.03, lead: 0.078, arp: 0.026, bass: 0.18, lead2: 0.034 } },

  // Crest. Four-note cell: for the only time in the piece the ripple
  // agrees with the bar, which is what makes this the solid part.
  { section: "crest", bpm: 84, cell: [0, 2, 4, 2], bassAt: [0, 3], chordAt: [0, 3],
    prog: [CH.Fmaj9, CH.Gmaj, CH.Amin, CH.Amin, CH.Fmaj9, CH.Cmaj9, CH.Dm7, CH.Emin],
    mel: swCrest, mel2: swCrestAlt, drums: "tide", sus: 3, bassDur: 2.6, arpDur: 1.5, ring2: 6,
    voice: { chord: "organ", lead: "flute", arp: "pluck", lead2: "bell" },
    vel: { chord: 0.028, lead: 0.08, arp: 0.026, bass: 0.18, lead2: 0.036 } },

  // Still. No cell — the water goes to glass.
  { section: "still", bpm: 70,
    prog: [CH.Amadd9, CH.Fmaj9, CH.Dsus2, CH.Esus4],
    mel: swStill, drums: "none", sus: 6.2, bassDur: 6, ring: 6,
    voice: { chord: "flute", lead: "bell", arp: "pluck" },
    vel: { chord: 0.026, lead: 0.05, bass: 0.15 } },

  // Reflection.
  { section: "reflection", bpm: 80, cell: [3, 2, 1, 0, 1], bassAt: [0, 3],
    prog: [CH.Amadd9, onA(CH.Dmin), onA(CH.Fmaj), onA(CH.Gmaj),
           CH.Gmaj, CH.Cmaj9, CH.Dm7, CH.Emin],
    mel: swReflect, mel2: swReflectAlt, drums: "none", sus: 6, bassDur: 3.2, arpDur: 1.6, ring2: 6,
    voice: { chord: "organ", lead: "bell", arp: "pluck", lead2: "keys" },
    vel: { chord: 0.026, lead: 0.055, arp: 0.026, bass: 0.16, lead2: 0.04 } },

  // Settle.
  { section: "settle", bpm: 72, cell: [0, 1, 2, 3], rip: [1, 0, 1, 0, 1, 0],
    prog: [CH.Amadd9, onA(CH.Fmaj), onA(CH.Emin), CH.Amadd9],
    mel: swSettle, drums: "none", sus: 6, bassDur: 6, arpDur: 2.4, ring: 6,
    voice: { chord: "flute", lead: "bell", arp: "pluck" },
    vel: { chord: 0.024, lead: 0.048, arp: 0.024, bass: 0.14 } },
].map((s) => swSect({ ...s, song: "stillwater" }));

// ---- "Quiet Hours" — G major, FIVE FOUR, forty-eight bars, about two
// forty-five. The lobby's other two tracks are a rippling 6/8 and a slow
// common-time organ piece, so this one takes the metre neither of them
// can: five beats to a bar, felt as three and then two. At this tempo it
// doesn't read as clever, it reads as a bar that takes slightly longer to
// come round than you expected — which is what the small hours are like.
//
// Three things it does that nothing else here does:
//
//   1. A CLOCK. A bell strikes the two group downbeats, steps 0 and 6 —
//      so the tick is uneven, three beats then two. It follows the
//      harmony rather than repeating a pitch, it REGROUPS to 0 and 4 when
//      the metre is felt as two-and-three in "window", it stops dead in
//      "3am", and it comes back winding down to one strike a bar at the
//      end. That thread is the piece's structure.
//
//   2. A CANON. In "echo" a second voice follows the tune one beat later
//      on a different instrument, so the two hocket together into one
//      line neither is playing. In "canon" the answer comes a WHOLE BAR
//      later, which only works if every bar of melody also fits the next
//      bar's chord — hence a progression that alternates Em7 and Gadd9
//      (three notes in common) and a tune built from G A B D E.
//
//   3. FINGERPICKING that doesn't come round. The thumb cycles three
//      patterns, the fingers cycle four; three against four means the
//      picking hand repeats only every twelve bars, which is longer than
//      any section in the piece.
//
// And at "3am" the harmony walks out of G major altogether — B♭, F, E♭ —
// and finds its way back through C. E♭ shares exactly one note with G
// major, and that note is G.

// A canon: the same line again, N steps later. Padded with silence rather
// than wrapped, so the answer starts empty and the leader's last phrase
// simply goes unanswered — which is how a canon ends.
const canon = (line, n) => [...new Array(n).fill(0), ...line.slice(0, -n)];

// Fingerpicking. Each entry is [step, chord-tone index]; an index past
// the end of the voicing wraps an octave up.
const QH_THUMB = [
  [[0, 0], [6, 1]],           // root, then the fifth under the second group
  [[0, 0], [6, 0]],           // root twice
  [[0, 0], [4, 1], [6, 0]],   // root, fifth, root
];
const QH_THUMB2 = [           // regrouped two-and-three
  [[0, 0], [4, 1]],
  [[0, 0], [4, 0], [8, 1]],
  [[0, 0], [2, 1], [4, 0]],
];
const QH_FINGERS = [
  [[1, 0], [3, 1], [5, 2], [7, 1], [9, 2]],
  [[1, 2], [3, 1], [5, 0], [7, 2], [9, 1]],
  [[1, 1], [2, 2], [5, 0], [7, 1], [8, 2]],
  [[1, 0], [3, 2], [5, 1], [7, 3], [9, 1]],
];

// Build a Quiet Hours section. Ten steps to a bar: beats on 0, 2, 4, 6, 8,
// grouped three and two.
function qhSect(o) {
  const meter = 10;
  const bars = o.prog.length;
  const steps = bars * meter;
  const chords = new Array(steps).fill(0);
  const bass = new Array(steps).fill(0);
  const arp = new Array(steps).fill(0);
  const tick = new Array(steps).fill(0);
  let ticked = false;

  o.prog.forEach((c, bar) => {
    const at = bar * meter;
    const t = c.n;
    const pick = (i) => t[i % t.length] * 2 ** Math.floor(i / t.length);
    const n1 = t[0], n2 = t[1], n3 = t[2];

    for (const s of o.chordAt ?? [0]) chords[at + s] = t;
    for (const s of o.tickAt ?? []) { tick[at + s] = n2 * 2; ticked = true; }

    if (o.fig === "clock") {
      // Guitar and a bell and nothing else.
      bass[at] = c.r;
      arp[at + 3] = n2; arp[at + 8] = n3;
      if (bar % 2 === 1) arp[at + 5] = pick(3);

    } else if (o.fig === "open") {
      // Wide and slow, for the bars that leave the key.
      bass[at] = c.r;
      arp[at + 3] = n3; arp[at + 7] = n2;
      if (bar % 2 === 1) arp[at + 9] = pick(3);

    } else if (o.fig === "weave") {
      // Deliberately thin: a canon is only audible if there's room for
      // both voices, so the accompaniment gets out of the way.
      bass[at] = c.r; bass[at + 6] = fold(t[1], c.r);
      arp[at + 5] = n3;
      if (bar % 2 === 0) arp[at + 9] = n2;

    } else if (o.fig === "full") {
      bass[at] = c.r; bass[at + 4] = fold(t[1], c.r); bass[at + 6] = c.r;
      for (const [s, i] of QH_FINGERS[bar % 4]) arp[at + s] = pick(i);
      arp[at + 4] = pick(bar % 2 ? 3 : 2);

    } else {
      // The picking. Thumb on a three-bar cycle, fingers on a four.
      const thumb = (o.fig === "pick2" ? QH_THUMB2 : QH_THUMB)[bar % 3];
      for (const [s, i] of thumb) bass[at + s] = i === 0 ? c.r : fold(t[1], c.r);
      for (const [s, i] of QH_FINGERS[bar % 4]) arp[at + s] = pick(i);
    }
  });

  const mel = o.mel ?? new Array(steps).fill(0);
  const out = { ...o, meter, chords, bass, arp, mel, melDur: phrase(mel, o.ring ?? 8, 0.94) };
  if (o.mel2) out.mel2Dur = phrase(o.mel2, o.ring2 ?? 8, 0.94);
  if (ticked) { out.mel3 = tick; out.mel3Dur = phrase(tick, 4, 0.94); }
  return out;
}

// --- the lines. Ten steps to a bar, written three beats then two.

// Late hour: no tune at all for four bars, and one guitar note at the end
// of the last one to lead the theme in.
const qhLate = [
  0,0, 0,0, 0,0,        0,0, 0,0,
  0,0, 0,0, 0,0,        0,0, 0,0,
  0,0, 0,0, 0,0,        0,0, 0,0,
  0,0, 0,0, 0,0,        0,0, N.D4,0,
];

// THE THEME, on the guitar.
const qhTheme = [
  /* Gadd9 */ N.G4,0, N.B4,0, N.D5,0,   0,0, N.B4,0,
  /* Em7   */ N.A4,0, 0,0, N.G4,0,      N.E4,0, 0,0,
  /* Cmaj9 */ N.G4,0, N.B4,0, N.E5,0,   0,0, N.D5,0,
  /* G/B   */ N.B4,0, 0,0, N.D5,0,      N.B4,0, N.A4,0,
  /* Am7   */ N.G4,0, N.E4,0, N.A4,0,   0,0, N.C5,0,
  /* Dsus4 */ N.D5,0, 0,0, N.A4,0,      0,0, 0,0,
];

// Echo: sparse on purpose. The answer one beat later fills every gap, and
// the two instruments together play a line neither of them plays.
const qhEcho = [
  /* Cmaj9 */ N.E5,0, 0,0, N.G5,0,      N.D5,0, 0,0,
  /* G/B   */ N.B4,0, 0,0, N.D5,0,      N.G4,0, 0,0,
  /* Am7   */ N.C5,0, 0,0, N.E5,0,      N.A4,0, 0,0,
  /* Em7   */ N.G4,0, 0,0, N.B4,0,      N.E5,0, 0,0,
  /* Cmaj9 */ N.D5,0, 0,0, N.B4,0,      N.G5,0, 0,0,
  /* Dsus4 */ N.A4,0, 0,0, N.D5,0,      0,0, 0,0,
];

// Window: the bar regroups as two and three, and the clock goes with it.
const qhWindow = [
  /* Em7   */ N.E5,0, N.D5,0,   N.B4,0, 0,0, N.G4,0,
  /* Am7   */ N.A4,0, N.C5,0,   N.E5,0, 0,0, N.D5,0,
  /* Cmaj9 */ N.C5,0, N.E5,0,   N.G5,0, 0,0, N.E5,0,
  /* Dsus4 */ N.D5,0, 0,0,      N.A4,0, N.G4,0, 0,0,
];

// 3am. No clock. The harmony leaves G major by the back door.
const qhThree = [
  /* G     */ N.G4,0, 0,0, N.D4,0,      N.G4,0, 0,0,
  /* Bb    */ N.F4,0, N.D4,0, 0,0,      N.Bb4,0, 0,0,
  /* F     */ N.C5,0, 0,0, N.A4,0,      0,0, N.F4,0,
  /* Eb    */ N.Bb4,0, 0,0, 0,0,        N.G4,0, N.Eb4,0,
  /* C     */ N.G4,0, N.C5,0, 0,0,      N.E4,0, 0,0,
  /* Dsus4 */ N.A4,0, 0,0, N.D5,0,      0,0, 0,0,
];
const qhThreeAlt = [    // one bell, every second bar
  0,0, 0,0, 0,0,        0,0, 0,0,
  N.D5,0, 0,0, 0,0,     0,0, 0,0,
  0,0, 0,0, 0,0,        0,0, 0,0,
  N.Bb4,0, 0,0, 0,0,    0,0, 0,0,
  0,0, 0,0, 0,0,        0,0, 0,0,
  N.D5,0, 0,0, 0,0,     0,0, 0,0,
];

// The canon proper. Every bar of this has to work over the NEXT bar's
// chord as well as its own, which is why it is built out of five notes.
const qhCanon = [
  /* Em7   */ N.B4,0, 0,0, N.D5,0,      N.E5,0, 0,0,
  /* Gadd9 */ N.D5,0, N.B4,0, 0,0,      N.A4,0, 0,0,
  /* Em7   */ N.G4,0, 0,0, N.B4,0,      N.D5,0, N.E5,0,
  /* Gadd9 */ N.D5,0, 0,0, N.A4,0,      0,0, N.G4,0,
  /* Cmaj9 */ N.G5,0, N.E5,0, 0,0,      N.B4,0, 0,0,
  /* Am7   */ N.A4,0, 0,0, N.C5,0,      N.E5,0, 0,0,
  /* Dsus4 */ N.D5,0, N.B4,0, 0,0,      N.A4,0, 0,0,
  /* Gadd9 */ N.G4,0, 0,0, N.B4,0,      0,0, 0,0,
];

// Warmth: the flute, the highest the piece goes, and a guitar underneath.
const qhWarm = [
  /* Cmaj9 */ N.G5,0, 0,0, N.E5,0,      N.D5,0, N.E5,0,
  /* D/F#  */ N.Fs5,0, 0,0, N.A5,0,     0,0, N.G5,0,
  /* Gadd9 */ N.B5,0, 0,0, N.A5,0,      N.G5,0, 0,0,
  /* Em7   */ N.E5,0, N.G5,0, 0,0,      N.B4,0, N.D5,0,
  /* Am7   */ N.C5,0, 0,0, N.E5,0,      N.A5,0, 0,0,
  /* Dsus4 */ N.G5,0, 0,0, N.D5,0,      N.A4,0, 0,0,
];
const qhWarmAlt = [
  /* Cmaj9 */ N.E4,0, 0,0, N.G4,0,      0,0, N.B4,0,
  /* D/F#  */ N.A4,0, 0,0, N.Fs4,0,     0,0, N.D4,0,
  /* Gadd9 */ N.G4,0, N.B4,0, 0,0,      N.D5,0, 0,0,
  /* Em7   */ N.B4,0, 0,0, N.G4,0,      0,0, N.E4,0,
  /* Am7   */ N.A4,0, 0,0, N.C5,0,      0,0, N.E5,0,
  /* Dsus4 */ N.D5,0, 0,0, N.A4,0,      N.G4,0, 0,0,
];

// Settle: the theme's opening three notes, backwards.
const qhSettle = [
  /* Gadd9 */ N.D5,0, N.B4,0, N.G4,0,   0,0, N.A4,0,
  /* Em7   */ N.B4,0, 0,0, N.G4,0,      0,0, N.E4,0,
  /* Cmaj9 */ N.G4,0, 0,0, N.E4,0,      N.D4,0, 0,0,
  /* G/B   */ N.G4,0, 0,0, 0,0,         N.D4,0, 0,0,
];

// Out. One bell a bar, and the clock down to a single strike.
const qhOut = [
  /* Cmaj9 */ N.E5,0, 0,0, 0,0,   0,0, 0,0,
  /* G/B   */ N.D5,0, 0,0, 0,0,   0,0, 0,0,
  /* Am7   */ N.C5,0, 0,0, 0,0,   0,0, 0,0,
  /* Gadd9 */ N.B4,0, 0,0, 0,0,   N.G4,0, 0,0,
];

const songQuietHours = [
  // No pad at all — a guitar, a bass note, and the clock.
  { section: "latehour", fig: "clock", bpm: 84, tickAt: [0, 6], chordAt: [],
    prog: [CH.Gadd9, CH.Em7, CH.Cmaj9, CH.Dsus4], mel: qhLate,
    drums: "none", bassDur: 6, arpDur: 2.4,
    voice: { lead: "guitar", arp: "guitar", lead3: "bell" },
    vel: { lead: 0.06, arp: 0.03, bass: 0.16, lead3: 0.03 } },

  // The theme, fingerpicked.
  { section: "theme", fig: "pick", bpm: 90, tickAt: [0, 6],
    prog: [CH.Gadd9, CH.Em7, CH.Cmaj9, CH["G/B"], CH.Am7, CH.Dsus4],
    mel: qhTheme, drums: "none", sus: 8, bassDur: 3, arpDur: 2,
    voice: { chord: "keys", lead: "guitar", arp: "guitar", lead3: "bell" },
    vel: { chord: 0.028, lead: 0.07, arp: 0.03, bass: 0.17, lead3: 0.03 } },

  // The answer one beat behind, on a different instrument.
  { section: "echo", fig: "pick", bpm: 90,
    prog: [CH.Cmaj9, CH["G/B"], CH.Am7, CH.Em7, CH.Cmaj9, CH.Dsus4],
    mel: qhEcho, mel2: canon(qhEcho, 2), drums: "swell", drumV: 0.5,
    sus: 8, bassDur: 3, arpDur: 2, ring2: 6,
    voice: { chord: "keys", lead: "bell", arp: "guitar", lead2: "keys" },
    vel: { chord: 0.026, lead: 0.055, arp: 0.028, bass: 0.17, lead2: 0.042 } },

  // The bar regroups two-and-three; so does the clock.
  { section: "window", fig: "pick2", bpm: 88, tickAt: [0, 4],
    prog: [CH.Em7, CH.Am7, CH.Cmaj9, CH.Dsus4],
    mel: qhWindow, drums: "swell", drumV: 0.5, sus: 8, bassDur: 3, arpDur: 2,
    voice: { chord: "keys", lead: "keys", arp: "guitar", lead3: "bell" },
    vel: { chord: 0.028, lead: 0.058, arp: 0.028, bass: 0.17, lead3: 0.03 } },

  // 3am: no clock, an organ, and a key that isn't G.
  { section: "threeam", fig: "open", bpm: 82,
    prog: [CH.Gmaj, CH.Bbmaj, CH.Fmaj, CH.Ebmaj, CH.Cmaj, CH.Dsus4],
    mel: qhThree, mel2: qhThreeAlt, drums: "none", sus: 9, bassDur: 7, arpDur: 3, ring2: 8,
    voice: { chord: "organ", lead: "guitar", arp: "pluck", lead2: "bell" },
    vel: { chord: 0.026, lead: 0.068, arp: 0.026, bass: 0.17, lead2: 0.034 } },

  // The canon: the answer a whole bar later.
  { section: "canon", fig: "weave", bpm: 92, tickAt: [0],
    prog: [CH.Em7, CH.Gadd9, CH.Em7, CH.Gadd9, CH.Cmaj9, CH.Am7, CH.Dsus4, CH.Gadd9],
    mel: qhCanon, mel2: canon(qhCanon, 10), drums: "hush", drumV: 0.7,
    sus: 8, bassDur: 3.4, arpDur: 2.4, ring2: 8,
    voice: { chord: "keys", lead: "bell", arp: "guitar", lead2: "guitar", lead3: "bell" },
    vel: { chord: 0.026, lead: 0.055, arp: 0.028, bass: 0.17, lead2: 0.045, lead3: 0.026 } },

  // The fullest it gets.
  { section: "warmth", fig: "full", bpm: 94,
    prog: [CH.Cmaj9, inv(CH.Dmaj, N.Fs2), CH.Gadd9, CH.Em7, CH.Am7, CH.Dsus4],
    mel: qhWarm, mel2: qhWarmAlt, drums: "hush", sus: 5, bassDur: 2.6, arpDur: 1.8, ring2: 6,
    voice: { chord: "keys", lead: "flute", arp: "guitar", lead2: "guitar" },
    vel: { chord: 0.03, lead: 0.075, arp: 0.028, bass: 0.18, lead2: 0.04 } },

  // Winding down.
  { section: "settle", fig: "pick", bpm: 86, tickAt: [0, 6],
    prog: [CH.Gadd9, CH.Em7, CH.Cmaj9, CH["G/B"]],
    mel: qhSettle, drums: "swell", drumV: 0.45, sus: 8, bassDur: 3, arpDur: 2,
    voice: { chord: "keys", lead: "guitar", arp: "guitar", lead3: "bell" },
    vel: { chord: 0.026, lead: 0.065, arp: 0.026, bass: 0.16, lead3: 0.028 } },

  // One strike a bar, and out.
  { section: "out", fig: "clock", bpm: 76, tickAt: [0], chordAt: [0],
    prog: [CH.Cmaj9, CH["G/B"], CH.Am7, CH.Gadd9], mel: qhOut,
    drums: "none", sus: 9, bassDur: 7, arpDur: 3, ring: 8,
    voice: { chord: "keys", lead: "bell", arp: "guitar", lead3: "bell" },
    vel: { chord: 0.024, lead: 0.05, arp: 0.024, bass: 0.15, lead3: 0.026 } },
].map((s) => qhSect({ ...s, song: "quiethours" }));

// ---- "Long Watch" — D minor, TWELVE EIGHT, forty bars, about two
// fifty. Every other track here is a tune with an accompaniment under it.
// This one is a PASSACAGLIA: an eight-note bass line, stated at the start
// on its own, and then ten pieces of music built on top of it. The ground
// keeps going; the hours change. That is what the title means and it is
// the one form in the book that says it without a word.
//
//   the ground:  D  A  B♭  F  |  G  F  E  A
//   its chords:  Dm Dm/A B♭ F |  Gm F  Em7♭5 A
//
// A ground that just loops twenty times would be exactly the repetition
// this was meant to fix, so the ground itself is the thing that varies:
//
//   ground     stated bare, the organ arriving halfway through
//   first      unchanged, with a flute over it and a horn answering
//   second     the same, faster, with an inner voice
//   third      THE GROUND MOVES — up two octaves into the tenor, played
//              by a guitar, while the bass holds a D pedal underneath
//   dark       same eight notes, reharmonised out of D minor: B♭ MINOR
//              and F MINOR, so the bass hasn't moved and everything else
//              has
//   turn       the ground BACKWARDS — A E F G | F B♭ A D
//   major      the ground in D MAJOR: B♭ becomes B, F becomes F♯, and the
//              horn call turns upside down and rises
//   height     the ground doubled by the brass an octave up, then two
//   dissolve   the ground losing its last two notes each bar
//   last       the first gesture only, twice as slow, ending on a bare
//              fifth with no third to tell you how it went
//
// Twelve-eight because nothing else here is in it, and because four slow
// beats of three is the gait of someone walking a wall all night.

// The ground, as chords — one per dotted beat, four to the bar.
const LW_GROUND = [
  [CH.Dmin, inv(CH.Dmin, N.A2), CH.Bbmaj, CH.Fmaj],
  [CH.Gmin, CH.Fmaj, CH.Em7b5, CH.Amaj],
];
// Same bass notes. Different key entirely.
const LW_DARK = [
  [CH.Dmin, inv(CH.Dmin, N.A2), CH.Bbmin, CH.Fmin],
  [CH.Gmin, CH.Fmin, CH.Em7b5, CH.Amaj],
];
// Backwards.
const LW_RETRO = [
  [CH.Amaj, CH.Em7b5, CH.Fmaj, CH.Gmin],
  [CH.Fmaj, CH.Bbmaj, inv(CH.Dmin, N.A2), CH.Dmin],
];
// And in the major, which moves two of the eight notes and nothing else.
const LW_MAJOR = [
  [CH.Dmaj, inv(CH.Dmaj, N.A2), CH.Bmin, inv(CH.Dmaj, N.Fs2)],
  [CH.Gmaj, inv(CH.Dmaj, N.Fs2), CH.Emin, CH.Amaj],
];
const twice = (g) => [...g, ...g];

// Build a Long Watch section. Twelve steps to a bar: four dotted beats of
// three eighths, landing on 0, 3, 6 and 9.
function lwSect(o) {
  const meter = 12;
  const bars = o.prog.length;
  const steps = bars * meter;
  const chords = new Array(steps).fill(0);
  const bass = new Array(steps).fill(0);
  const arp = new Array(steps).fill(0);

  o.prog.forEach((barOf, bar) => {
    const at = bar * meter;
    barOf.forEach((c, beat) => {
      const i = at + beat * 3;
      const t = c.n;
      // A chord tone, wrapping an octave up past the end of the voicing.
      const pick = (k) => t[k % t.length] * 2 ** Math.floor(k / t.length);

      // The ground. `mask` lets a variation drop beats; `pedal` holds one
      // note underneath instead, for the bar where the ground goes up top.
      if (o.pedal) { if (beat === 0 || beat === 2) bass[i] = o.pedal; }
      else if (!o.mask || o.mask[beat]) bass[i] = c.r;

      if (o.fig === "toll") {
        // Nothing but the ground, and the organ arriving in bar three.
        if (beat === 0 && (!o.late || bar >= o.late)) chords[i] = t;

      } else if (o.fig === "tenor") {
        // The ground itself, two octaves up, as a line you can follow.
        if (beat === 0) chords[i] = t;
        arp[i] = c.r * 4;
        arp[i + 2] = pick(bar + beat);

      } else if (o.fig === "veil") {
        if (beat === 0 || beat === 2) chords[i] = t;
        if (beat === 1 || beat === 3) arp[i + 2] = pick(bar + beat);

      } else if (o.fig === "choir") {
        // The pad re-struck on every beat — the only section that pulses.
        chords[i] = t;
        arp[i + 1] = pick(bar + beat);
        arp[i + 2] = pick(bar + beat + 2);

      } else if (o.fig === "run") {
        if (beat === 0 || beat === 2) chords[i] = t;
        arp[i + 1] = pick(bar + beat);
        arp[i + 2] = pick(bar + beat + 2);
        if (beat % 2 === 0) arp[i] = pick(bar + beat + 1);

      } else if (o.fig === "rock") {
        if (beat === 0) chords[i] = t;
        arp[i + 2] = pick(bar + beat);

      } else {
        // "lilt" — the compound gait: the beat, then two eighths leaning
        // into the next one.
        if (beat === 0 || beat === 2) chords[i] = t;
        arp[i + 1] = pick(bar + beat);
        arp[i + 2] = pick(bar + beat + 2);
      }
    });
  });

  const mel = o.mel ?? new Array(steps).fill(0);
  const out = { ...o, meter, chords, bass, arp, mel, melDur: phrase(mel, o.ring ?? 9, 0.97) };
  if (o.mel2) out.mel2Dur = phrase(o.mel2, o.ring2 ?? 9, 0.97);
  if (o.mel3) out.mel3Dur = phrase(o.mel3, o.ring3 ?? 6, 0.97);
  return out;
}

// --- the lines. Twelve steps to a bar, written four beats of three.

// The horn. A falling fourth, D to A, answering the ground's second bar —
// a signal from somewhere else on the wall. It comes back in every
// variation that has room for it, and in the major it turns over and
// rises instead.
const lwHorn = [
  0,0,0, 0,0,0, 0,0,0, 0,0,0,
  N.D5,0,0, N.A4,0,0, 0,0,0, 0,0,0,
  0,0,0, 0,0,0, 0,0,0, 0,0,0,
  N.D5,0,0, N.A4,0,0, 0,0,0, 0,0,0,
];
const lwHornUp = [      // the major variation: the same call, inverted
  0,0,0, 0,0,0, 0,0,0, 0,0,0,
  N.A4,0,0, N.D5,0,0, 0,0,0, 0,0,0,
  0,0,0, 0,0,0, 0,0,0, 0,0,0,
  N.A4,0,0, N.D5,0,0, N.Fs5,0,0, 0,0,0,
];

// First: the flute answers the horn rather than talking over it.
const lwFirst = [
  /* Dm  Dm/A B♭  F   */ N.D5,0,0, 0,0,0, N.F5,0,0, N.E5,0,0,
  /* Gm  F    Em7♭5 A  */ 0,0,0, 0,0,0, N.Bb4,0,0, N.A4,0,0,
  /* Dm  Dm/A B♭  F   */ N.A4,0,0, N.D5,0,0, N.F5,0,0, 0,0,0,
  /* Gm  F    Em7♭5 A  */ 0,0,0, 0,0,0, N.E5,0,0, N.Cs5,0,0,
];

// Second: the compound rhythm proper — long-short inside the beat.
const lwSecond = [
  N.F5,0,0, N.E5,0,N.D5, N.C5,0,0, N.D5,0,0,
  N.Bb4,0,0, N.A4,0,0, N.G4,0,0, N.Cs5,0,0,
  N.D5,0,0, N.F5,0,0, N.A5,0,0, N.G5,0,0,
  N.F5,0,N.E5, N.D5,0,0, N.Bb4,0,0, N.A4,0,0,
];
const lwSecondAlt = [    // an inner voice, one note every two beats
  N.A4,0,0, 0,0,0, N.D4,0,0, 0,0,0,
  N.G4,0,0, 0,0,0, N.E4,0,0, 0,0,0,
  N.F4,0,0, 0,0,0, N.D4,0,0, 0,0,0,
  N.Bb3,0,0, 0,0,0, N.G4,0,0, 0,0,0,
];

// Third: the ground has gone up into the middle of the texture, so the
// flute has the whole top to itself.
const lwThird = [
  N.A4,0,0, 0,0,0, N.D5,0,0, N.C5,0,0,
  N.D5,0,0, N.C5,0,0, N.Bb4,0,0, N.A4,0,0,
  N.F5,0,0, 0,0,0, N.D5,0,0, N.C5,0,0,
  N.Bb4,0,0, N.D5,0,0, N.Bb4,0,0, N.A4,0,0,
];

// Dark: where the A♭ and D♭ live.
const lwDark = [
  N.A4,0,0, 0,0,0, N.F4,0,0, N.Gs4,0,0,
  N.G4,0,0, N.F4,0,0, N.E4,0,0, N.Cs5,0,0,
  N.D5,0,0, 0,0,0, N.Cs5,0,0, N.C5,0,0,
  N.Bb4,0,0, N.Gs4,0,0, N.G4,0,0, N.A4,0,0,
];

// Turn: over the ground backwards.
const lwTurn = [
  N.E5,0,0, N.D5,0,0, N.C5,0,0, N.Bb4,0,0,
  N.A4,0,0, N.D5,0,0, N.F5,0,0, N.E5,0,0,
  N.Cs5,0,0, N.E5,0,0, N.A5,0,0, N.G5,0,0,
  N.F5,0,0, N.D5,0,0, N.A4,0,0, N.D5,0,0,
];

// Major.
const lwMajor = [
  N.Fs5,0,0, 0,0,0, N.D5,0,0, N.Fs5,0,0,
  N.G5,0,0, N.Fs5,0,0, N.E5,0,0, N.Cs5,0,0,
  N.A5,0,0, 0,0,0, N.Fs5,0,0, N.A5,0,0,
  N.B5,0,0, N.A5,0,0, N.G5,0,0, N.Fs5,0,0,
];

// Height: the top of the piece.
const lwHeight = [
  N.A5,0,0, N.G5,0,N.F5, N.D5,0,0, N.F5,0,0,
  N.Bb5,0,0, N.A5,0,0, N.G5,0,0, N.F5,0,0,
  N.D5,0,N.F5, N.A5,0,0, N.G5,0,0, N.F5,0,0,
  N.D5,0,0, N.C5,0,0, N.Bb4,0,0, N.A4,0,0,
];
const lwHeightAlt = [    // the brass, doubling the ground an octave up,
  N.D3,0,0, N.A3,0,0, N.Bb3,0,0, N.F3,0,0,   // and then two
  N.G3,0,0, N.F3,0,0, N.E3,0,0, N.A3,0,0,
  N.D4,0,0, N.A4,0,0, N.Bb4,0,0, N.F4,0,0,
  N.G4,0,0, N.F4,0,0, N.E4,0,0, N.A4,0,0,
];

// Dissolve: the ground is losing its last two notes.
const lwDissolve = [
  N.D5,0,0, N.C5,0,0, N.Bb4,0,0, 0,0,0,
  N.Bb4,0,0, 0,0,0, N.G4,0,0, 0,0,0,
  N.F5,0,0, 0,0,0, N.D5,0,0, N.C5,0,0,
  N.Bb4,0,0, 0,0,0, N.G4,0,0, 0,0,0,
];

// Last.
const lwLast = [
  N.D5,0,0, 0,0,0, N.F5,0,0, N.E5,0,0,
  N.D5,0,0, N.Cs5,0,0, N.D5,0,0, 0,0,0,
  0,0,0, 0,0,0, 0,0,0, 0,0,0,
  N.D5,0,0, 0,0,0, 0,0,0, 0,0,0,
];
const lwLastHorn = [
  0,0,0, 0,0,0, 0,0,0, 0,0,0,
  0,0,0, 0,0,0, 0,0,0, 0,0,0,
  N.A4,0,0, 0,0,0, N.D5,0,0, 0,0,0,
  0,0,0, 0,0,0, 0,0,0, 0,0,0,
];

const songLongWatch = [
  // The ground alone. The organ doesn't arrive until bar three.
  { section: "ground", fig: "toll", bpm: 76, late: 2, prog: twice(LW_GROUND),
    drums: "none", sus: 12, bassDur: 3.4,
    voice: { chord: "organ" }, vel: { chord: 0.028, bass: 0.19 } },

  // A flute above it, a horn answering from somewhere else.
  { section: "first", fig: "lilt", bpm: 84, prog: twice(LW_GROUND),
    mel: lwFirst, mel3: lwHorn, drums: "none", sus: 12, bassDur: 3.2, arpDur: 1.6,
    voice: { chord: "organ", lead: "flute", arp: "pluck", lead3: "brass" },
    vel: { chord: 0.026, lead: 0.075, arp: 0.024, bass: 0.18, lead3: 0.05 } },

  // Same ground, more motion, and a voice inside the harmony.
  { section: "second", fig: "rock", bpm: 88, prog: twice(LW_GROUND),
    mel: lwSecond, mel2: lwSecondAlt, drums: "none", sus: 12, bassDur: 3, arpDur: 2, ring2: 9,
    voice: { chord: "organ", lead: "flute", arp: "guitar", lead2: "keys" },
    vel: { chord: 0.026, lead: 0.078, arp: 0.028, bass: 0.18, lead2: 0.04 } },

  // The ground climbs into the middle of the texture; a D holds under it.
  { section: "third", fig: "tenor", bpm: 88, pedal: N.D2, prog: twice(LW_GROUND),
    mel: lwThird, mel3: lwHorn, drums: "none", sus: 12, bassDur: 6, arpDur: 2.6,
    voice: { chord: "organ", lead: "flute", arp: "guitar", lead3: "brass" },
    vel: { chord: 0.024, lead: 0.075, arp: 0.045, bass: 0.17, lead3: 0.045 } },

  // The bass hasn't moved. Everything above it has.
  { section: "dark", fig: "veil", bpm: 82, prog: twice(LW_DARK),
    mel: lwDark, drums: "none", sus: 12, bassDur: 4, arpDur: 2.4,
    voice: { chord: "organ", lead: "keys", arp: "guitar" },
    vel: { chord: 0.026, lead: 0.058, arp: 0.026, bass: 0.18 } },

  // Backwards.
  { section: "turn", fig: "lilt", bpm: 86, prog: twice(LW_RETRO),
    mel: lwTurn, drums: "none", sus: 12, bassDur: 3.2, arpDur: 1.6,
    voice: { chord: "organ", lead: "flute", arp: "pluck" },
    vel: { chord: 0.026, lead: 0.078, arp: 0.026, bass: 0.18 } },

  // In the major, and the horn call rises.
  { section: "major", fig: "choir", bpm: 90, prog: twice(LW_MAJOR),
    mel: lwMajor, mel3: lwHornUp, drums: "watch", drumV: 0.5,
    sus: 6, bassDur: 2.8, arpDur: 1.4, ring3: 6,
    voice: { chord: "organ", lead: "flute", arp: "bell", lead3: "brass" },
    vel: { chord: 0.028, lead: 0.08, arp: 0.03, bass: 0.18, lead3: 0.05 } },

  // The whole thing at once.
  { section: "height", fig: "run", bpm: 92, prog: twice(LW_GROUND),
    mel: lwHeight, mel2: lwHeightAlt, drums: "watch",
    sus: 6.2, bassDur: 2.6, arpDur: 1.2, ring2: 6,
    voice: { chord: "organ", lead: "flute", arp: "guitar", lead2: "brass" },
    vel: { chord: 0.028, lead: 0.082, arp: 0.026, bass: 0.19, lead2: 0.048 } },

  // Losing its footing.
  { section: "dissolve", fig: "veil", bpm: 82, mask: [1, 1, 0, 0], prog: twice(LW_GROUND),
    mel: lwDissolve, drums: "none", sus: 12, bassDur: 5, arpDur: 2.6,
    voice: { chord: "organ", lead: "flute", arp: "pluck" },
    vel: { chord: 0.024, lead: 0.07, arp: 0.024, bass: 0.17 } },

  // The first gesture, twice as slow, and a fifth with no third in it.
  { section: "last", fig: "toll", bpm: 70,
    prog: [LW_GROUND[0], [CH.Gmin, CH.Amaj, CH.Dopen, CH.Dopen],
           [CH.Dopen, CH.Dopen, CH.Dopen, CH.Dopen],
           [CH.Dopen, CH.Dopen, CH.Dopen, CH.Dopen]],
    mask: [1, 0, 1, 0], mel: lwLast, mel3: lwLastHorn,
    drums: "none", sus: 12, bassDur: 7, ring: 12,
    voice: { chord: "organ", lead: "flute", lead3: "brass" },
    vel: { chord: 0.028, lead: 0.068, bass: 0.17, lead3: 0.04 } },
].map((s) => lwSect({ ...s, song: "longwatch" }));

// ====================== IN-ROUND SONGS ======================
// Same instruments as always in a round: electric piano, warm bass and
// the plucked counter-line. Eight-bar sections.

// ---- "Iron Heart" — A minor, 4/4, eighty bars, about two and a half
// minutes. The six menu tracks are all tunes with an accompaniment
// underneath. Combat music isn't built that way and shouldn't be: it's
// built on a RIFF, and the riff is the thing that has to develop, because
// it's what the player hears for two minutes while trying to concentrate
// on something else.
//
// So the whole piece comes out of one figure —
//
//   A  A  ·  A  ·  B♭ ·  A
//
// — a chugging tonic with a B♭ leaning on it. That B♭ is the ♭2 of A
// PHRYGIAN, the darkest note available in the key, and it's the reason
// this doesn't sound like the other two combat tracks, which are both
// plain Aeolian. The riff then gets taken apart across the piece:
//
//   pulse    assembling itself a note at a time out of the kick
//   riff     complete, four different bars of it
//   theme    thinned so the brass has room
//   theme2   DISPLACED an eighth — every accent lands off the beat —
//            over an Andalusian descent, Am G F E
//   break    gone. Just the heartbeat and one line.
//   charge   relentless straight eighths
//   turn     up into C major, brighter, still the same shape
//   march    HALF TIME — two notes a bar, and the drums halve with it
//   hold     gone again, one bar of tension per chord
//   surge    scalar runs, every step filled
//   final    the original riff with an octave added on the fourth eighth
//   out      losing a note a bar until only the pulse is left
//
// And the kit is the title. The kick hits TWICE on the downbeat, an
// eighth apart — lub-dub — which at this tempo is about the interval of a
// real heartbeat. Nothing else in the game hits twice in a row like that.
//
// The riff sits in A3–E4 on the guitar, not down at A2 where it would be
// inaudible on a phone speaker, and the bass covers the octave below it.
// That's how a real mix is laid out and it's why this reads as loud
// without actually being loud.

// Build an Iron Heart section. The riff is hand-written per section and
// goes straight into the counter-line channel; the figure only has to
// decide what the bass and the chords do underneath it.
function ihSect(o) {
  const meter = 8;
  const bars = o.prog.length;
  const steps = bars * meter;
  const chords = new Array(steps).fill(0);
  const bass = new Array(steps).fill(0);
  const arp = new Array(steps).fill(0);
  if (o.riff) for (let i = 0; i < steps; i++) arp[i] = o.riff[i] ?? 0;

  o.prog.forEach((c, bar) => {
    const at = bar * meter;
    const r = c.r;
    const t = c.n;
    const fifth = fold(t[1], r);
    const last = bar === bars - 1;

    if (o.fig === "low") {
      // The build, and the way out: bass on the downbeat, one held chord.
      bass[at] = r;
      if (bar % 2 === 1) bass[at + 4] = fifth;
      chords[at] = t;

    } else if (o.fig === "hold") {
      // One chord a bar and nothing else moving. Tension by subtraction.
      bass[at] = r;
      chords[at] = t;
      if (bar % 2 === 1) bass[at + 6] = fifth;

    } else if (o.fig === "heavy") {
      // Half time. The bar is twice as long as it was a minute ago.
      bass[at] = r; bass[at + 1] = r; bass[at + 4] = r;
      chords[at] = t;
      if (bar % 2 === 1) chords[at + 4] = t;

    } else if (o.fig === "push") {
      // Everything forward: bass under nearly every eighth, chords
      // syncopated across the beat.
      bass[at] = r; bass[at + 1] = r; bass[at + 3] = r;
      bass[at + 4] = r; bass[at + 6] = fifth;
      chords[at] = t; chords[at + 3] = t;
      if (bar % 2 === 0) chords[at + 6] = t;

    } else if (o.fig === "stab") {
      // Chords OFF the beat only, so the riff owns the downbeats.
      bass[at] = r; bass[at + 1] = r; bass[at + 4] = r;
      chords[at + 1] = t; chords[at + 5] = t;
      if (last) chords[at + 7] = t;

    } else {
      // "drive" — the bass doubles the kick's two hits, which is what
      // welds the low end to the drums.
      bass[at] = r; bass[at + 1] = r; bass[at + 4] = r;
      if (bar % 2 === 1) bass[at + 6] = fifth;
      chords[at] = t; chords[at + 4] = t;
    }
  });

  const mel = o.mel ?? new Array(steps).fill(0);
  const out = { ...o, meter, chords, bass, arp, mel, melDur: phrase(mel, o.ring ?? 6) };
  if (o.mel2) out.mel2Dur = phrase(o.mel2, o.ring2 ?? 6);
  return out;
}

// --- the riffs. Eight steps to a bar.

// Assembling itself out of the kick drum.
const ihPulse = [
  0,0,0,0, 0,0,0,0,
  0,0,0,0, 0,0,0,N.A3,
  N.A3,N.A3,0,0, 0,0,0,0,
  N.A3,N.A3,0,N.A3, 0,0,0,0,
  N.A3,N.A3,0,N.A3, 0,N.Bb3,0,0,
  N.A3,N.A3,0,N.A3, 0,N.Bb3,0,N.A3,
  N.A3,N.A3,0,N.A3, 0,N.C4,0,N.Bb3,
  N.A3,N.A3,0,N.C4, 0,N.D4,0,N.E4,
];

// THE RIFF.
const ihRiff = [
  /* Am */ N.A3,N.A3,0,N.A3,   0,N.Bb3,0,N.A3,
  /* Am */ N.A3,N.A3,0,N.A3,   0,N.C4,0,N.Bb3,
  /* B♭ */ N.Bb3,N.Bb3,0,N.Bb3, 0,N.C4,0,N.D4,
  /* Am */ N.A3,N.A3,0,N.C4,   0,N.D4,0,N.E4,
  /* F  */ N.F3,N.F3,0,N.F3,   0,N.G3,0,N.A3,
  /* G  */ N.G3,N.G3,0,N.G3,   0,N.A3,0,N.B3,
  /* Am */ N.A3,N.A3,0,N.C4,   0,N.A3,0,N.G3,
  /* Am */ N.A3,0,N.A3,N.A3,   0,N.A3,N.Bb3,N.A3,
];

// Thinned, so the brass has somewhere to be.
const ihThin = [
  N.A3,N.A3,0,0, 0,N.A3,0,0,
  N.A3,N.A3,0,0, 0,N.Bb3,0,0,
  N.Bb3,N.Bb3,0,0, 0,N.C4,0,0,
  N.A3,N.A3,0,N.A3, 0,N.C4,0,N.E4,
  N.F3,N.F3,0,0, 0,N.G3,0,0,
  N.G3,N.G3,0,0, 0,N.B3,0,0,
  N.A3,N.A3,0,N.C4, 0,N.A3,0,0,
  N.A3,0,N.A3,N.A3, 0,N.A3,N.Bb3,N.A3,
];

// Displaced an eighth: nothing lands where you expect it.
const ihShift = [
  0,N.A3,N.A3,0, N.A3,0,N.C4,0,
  0,N.G3,N.G3,0, N.G3,0,N.B3,0,
  0,N.F3,N.F3,0, N.F3,0,N.A3,0,
  0,N.E3,N.E3,0, N.E3,0,N.B3,0,
  0,N.A3,N.A3,0, N.A3,0,N.C4,N.D4,
  0,N.G3,N.G3,0, N.G3,0,N.B3,N.C4,
  0,N.F3,N.F3,0, N.F3,0,N.A3,N.Bb3,
  N.E3,N.E3,N.E3,0, N.E3,0,N.B3,N.E4,
];

// Straight eighths, no gaps.
const ihCharge = [
  N.A3,N.A3,N.C4,N.A3, N.E4,N.A3,N.C4,N.A3,
  N.A3,N.A3,N.C4,N.A3, N.E4,N.A3,N.Bb3,N.A3,
  N.F3,N.F3,N.A3,N.F3, N.C4,N.F3,N.A3,N.F3,
  N.G3,N.G3,N.B3,N.G3, N.D4,N.G3,N.B3,N.D4,
  N.A3,N.A3,N.C4,N.A3, N.E4,N.A3,N.C4,N.E4,
  N.Bb3,N.Bb3,N.D4,N.Bb3, N.F4,N.Bb3,N.D4,N.Bb3,
  N.F3,N.F3,N.A3,N.F3, N.C4,N.F3,N.A3,N.C4,
  N.E3,N.E3,N.B3,N.E3, N.E4,N.B3,N.E3,N.B3,
];

// The same shape, up in C major.
const ihTurn = [
  N.C4,N.C4,0,N.C4, 0,N.E4,0,N.G3,
  N.G3,N.G3,0,N.G3, 0,N.B3,0,N.D4,
  N.A3,N.A3,0,N.A3, 0,N.C4,0,N.E4,
  N.F3,N.F3,0,N.F3, 0,N.A3,0,N.C4,
  N.C4,N.C4,0,N.E4, 0,N.G4,0,N.E4,
  N.G3,N.G3,0,N.B3, 0,N.D4,0,N.B3,
  N.D4,N.D4,0,N.F4, 0,N.A3,0,N.D4,
  N.E3,N.E3,N.E3,0, N.E3,0,N.B3,N.E4,
];

// Half time.
const ihMarch = [
  N.A3,N.A3,0,0, N.A3,0,0,0,
  N.A3,N.A3,0,0, N.C4,0,0,0,
  N.F3,N.F3,0,0, N.F3,0,0,0,
  N.F3,N.F3,0,0, N.A3,0,0,0,
  N.Bb3,N.Bb3,0,0, N.Bb3,0,0,0,
  N.Bb3,N.Bb3,0,0, N.D4,0,0,0,
  N.E3,N.E3,0,0, N.E3,0,0,0,
  N.E3,N.E3,0,0, N.B3,0,N.E4,0,
];

// Runs instead of arpeggios.
const ihSurge = [
  N.A3,N.B3,N.C4,N.D4, N.E4,N.D4,N.C4,N.B3,
  N.A3,N.B3,N.C4,N.E4, N.A4,N.E4,N.C4,N.B3,
  N.Bb3,N.C4,N.D4,N.F4, N.Bb4,N.F4,N.D4,N.C4,
  N.Bb3,N.A3,N.G3,N.F3, N.Bb3,N.D4,N.F4,N.D4,
  N.F3,N.G3,N.A3,N.C4, N.F4,N.C4,N.A3,N.G3,
  N.G3,N.A3,N.B3,N.D4, N.G4,N.D4,N.B3,N.A3,
  N.A3,N.C4,N.E4,N.A4, N.E4,N.C4,N.A3,N.G3,
  N.E3,N.B3,N.E4,N.B3, N.E4,N.Gs4,N.B4,N.Gs4,
];

// The riff again, with an octave opened up on the fourth eighth.
const ihFinal = [
  N.A3,N.A3,0,N.A3, N.E4,N.Bb3,0,N.A3,
  N.A3,N.A3,0,N.A3, N.E4,N.C4,0,N.Bb3,
  N.Bb3,N.Bb3,0,N.Bb3, N.F4,N.C4,0,N.D4,
  N.A3,N.A3,0,N.C4, N.E4,N.D4,0,N.E4,
  N.F3,N.F3,0,N.F3, N.C4,N.G3,0,N.A3,
  N.G3,N.G3,0,N.G3, N.D4,N.A3,0,N.B3,
  N.A3,N.A3,0,N.C4, N.E4,N.A3,0,N.G3,
  N.A3,N.A3,N.A3,N.A3, N.C4,N.D4,N.E4,N.A4,
];

// Losing a note a bar.
const ihOut = [
  N.A3,N.A3,0,N.A3, 0,N.Bb3,0,N.A3,
  N.Bb3,N.Bb3,0,N.Bb3, 0,0,0,0,
  N.A3,N.A3,0,0, 0,0,0,0,
  N.A3,0,0,0, 0,0,0,0,
];

// --- the lines above them.

const ihTheme = [
  /* Am */ N.A4,0,0,0,   N.C5,0,N.E5,0,
  /* Am */ N.D5,0,0,0,   N.C5,0,N.A4,0,
  /* B♭ */ N.Bb4,0,0,0,  N.D5,0,N.F5,0,
  /* Am */ N.E5,0,0,0,   0,0,N.C5,0,
  /* F  */ N.F5,0,0,0,   N.E5,0,N.C5,0,
  /* G  */ N.D5,0,0,0,   N.B4,0,N.D5,0,
  /* Am */ N.C5,0,N.E5,0, N.A5,0,0,0,
  /* Am */ N.G5,0,0,0,   N.E5,0,0,0,
];

const ihTheme2 = [
  /* Am */ N.E5,0,0,0,   N.A5,0,0,0,
  /* G  */ N.G5,0,0,0,   N.D5,0,N.B4,0,
  /* F  */ N.C5,0,N.A4,0, N.F5,0,0,0,
  /* E  */ N.E5,0,0,0,   N.Gs4,0,N.B4,0,
  /* Am */ N.A5,0,0,0,   N.E5,0,N.C5,0,
  /* G  */ N.D5,0,N.B4,0, N.G4,0,N.B4,0,
  /* F  */ N.C5,0,0,0,   N.F5,0,N.E5,0,
  /* E  */ N.B4,0,N.Gs4,0, N.E5,0,0,0,
];

const ihBreak = [
  N.A4,0,0,0, 0,0,0,0,
  N.C5,0,0,0, 0,0,0,0,
  N.D5,0,0,0, N.F5,0,0,0,
  N.E5,0,0,0, 0,0,0,0,
];

const ihChargeMel = [
  /* Am */ N.A5,0,0,0,   N.G5,0,N.E5,0,
  /* Am */ N.C5,0,N.E5,0, N.A5,0,0,0,
  /* F  */ N.F5,0,0,0,   N.E5,0,N.C5,0,
  /* G  */ N.D5,0,N.B4,0, N.D5,0,N.G5,0,
  /* Am */ N.A5,0,0,0,   N.E5,0,N.C5,0,
  /* B♭ */ N.D5,0,N.F5,0, N.Bb5,0,0,0,
  /* F  */ N.A5,0,0,0,   N.F5,0,N.C5,0,
  /* E  */ N.E5,0,0,0,   N.Gs4,0,N.B4,0,
];
const ihChargeAlt = [
  N.E4,0,0,0, N.A4,0,0,0,
  N.E4,0,0,0, N.C5,0,0,0,
  N.A4,0,0,0, N.F4,0,0,0,
  N.G4,0,0,0, N.B4,0,0,0,
  N.A4,0,0,0, N.E4,0,0,0,
  N.Bb4,0,0,0, N.F4,0,0,0,
  N.C5,0,0,0, N.A4,0,0,0,
  N.B4,0,0,0, N.Gs4,0,0,0,
];

const ihTurnMel = [
  /* C  */ N.G5,0,0,0,   N.E5,0,N.G5,0,
  /* G  */ N.D5,0,0,0,   N.B4,0,N.D5,0,
  /* Am */ N.C5,0,N.E5,0, N.A5,0,0,0,
  /* F  */ N.G5,0,0,0,   N.F5,0,N.C5,0,
  /* C  */ N.E5,0,N.G5,0, N.A5,0,N.G5,0,
  /* G  */ N.B5,0,0,0,   N.A5,0,N.G5,0,
  /* Dm */ N.F5,0,0,0,   N.D5,0,N.A5,0,
  /* E  */ N.E5,0,0,0,   N.B4,0,N.Gs4,0,
];

const ihMarchMel = [
  N.A4,0,0,0, 0,0,0,0,
  N.C5,0,0,0, N.E5,0,0,0,
  N.F5,0,0,0, 0,0,0,0,
  N.E5,0,0,0, N.C5,0,0,0,
  N.D5,0,0,0, 0,0,0,0,
  N.F5,0,0,0, N.D5,0,0,0,
  N.E5,0,0,0, 0,0,0,0,
  N.B4,0,0,0, N.Gs4,0,0,0,
];

const ihHold = [
  N.C5,0,0,0, 0,0,0,0,
  N.D5,0,0,0, 0,0,0,0,
  N.E5,0,0,0, 0,0,0,0,
  N.Gs4,0,0,0, N.B4,0,0,0,
];

const ihSurgeMel = [
  N.E5,0,N.A5,0, 0,0,N.G5,0,
  N.E5,0,N.C5,0, N.A4,0,0,0,
  N.D5,0,N.F5,0, N.Bb5,0,0,0,
  N.A5,0,N.F5,0, N.D5,0,0,0,
  N.C5,0,N.F5,0, N.A5,0,0,0,
  N.B4,0,N.D5,0, N.G5,0,N.B4,0,
  N.C5,0,N.E5,0, N.A5,0,N.E5,0,
  N.B4,0,N.Gs4,0, N.E5,0,0,0,
];

const ihFinalMel = [
  N.A5,0,0,0,   N.E5,0,N.C5,0,
  N.D5,0,N.C5,0, N.A4,0,N.C5,0,
  N.Bb4,0,N.D5,0, N.F5,0,N.Bb5,0,
  N.A5,0,0,0,   N.E5,0,N.C5,0,
  N.F5,0,N.A5,0, N.G5,0,N.F5,0,
  N.D5,0,N.G5,0, N.B4,0,N.D5,0,
  N.C5,0,N.E5,0, N.A5,0,0,0,
  N.E5,0,0,0,   N.A4,0,0,0,
];
const ihFinalAlt = [
  N.A4,0,0,0, N.E4,0,0,0,
  N.C5,0,0,0, N.A4,0,0,0,
  N.D5,0,0,0, N.Bb4,0,0,0,
  N.C5,0,0,0, N.E5,0,0,0,
  N.C5,0,0,0, N.A4,0,0,0,
  N.B4,0,0,0, N.G4,0,0,0,
  N.A4,0,0,0, N.C5,0,0,0,
  N.A4,0,0,0, 0,0,0,0,
];

const ihOutMel = [
  N.A5,0,0,0, 0,0,0,0,
  N.F5,0,0,0, 0,0,0,0,
  N.E5,0,0,0, 0,0,0,0,
  N.A4,0,0,0, 0,0,0,0,
];

const songIronHeart = [
  // The kick, a pedal, and the riff putting itself together.
  { section: "pulse", fig: "low", bpm: 126, riff: ihPulse,
    prog: [CH.Amin, CH.Amin, CH.Amin, CH.Amin, CH.Amin, CH.Amin, CH.Bbmaj, CH.Amin],
    drums: "heartbeat", sus: 8, bassDur: 4, arpDur: 1.4,
    voice: { chord: "organ", arp: "guitar" },
    vel: { chord: 0.026, arp: 0.042, bass: 0.19 } },

  // The riff, whole.
  { section: "riff", fig: "drive", bpm: 132, riff: ihRiff,
    prog: [CH.Aopen, CH.Amin, CH.Bbmaj, CH.Amin, CH.Fmaj, CH.Gmaj, CH.Amin, CH.Aopen],
    drums: "heart", sus: 2.6, bassDur: 0.9, arpDur: 1.2,
    voice: { chord: "organ", arp: "guitar" },
    vel: { chord: 0.028, arp: 0.05, bass: 0.2 } },

  // Brass over the top.
  { section: "theme", fig: "drive", bpm: 132, riff: ihThin,
    prog: [CH.Amin, CH.Amin, CH.Bbmaj, CH.Amin, CH.Fmaj, CH.Gmaj, CH.Amin, CH.Amin],
    mel: ihTheme, drums: "heart", sus: 2.6, bassDur: 0.9, arpDur: 1.2,
    voice: { chord: "organ", lead: "brass", arp: "guitar" },
    vel: { chord: 0.026, lead: 0.075, arp: 0.046, bass: 0.2 } },

  // Everything an eighth late, over the descent.
  { section: "theme2", fig: "stab", bpm: 132, riff: ihShift,
    prog: [CH.Amin, CH.Gmaj, CH.Fmaj, CH.Emaj, CH.Amin, CH.Gmaj, CH.Fmaj, CH.Emaj],
    mel: ihTheme2, drums: "heart", sus: 1.8, bassDur: 0.9, arpDur: 1.2,
    voice: { chord: "keys", lead: "brass", arp: "guitar" },
    vel: { chord: 0.034, lead: 0.075, arp: 0.046, bass: 0.2 } },

  // Nothing but the heartbeat.
  { section: "break", fig: "hold", bpm: 132,
    prog: [CH.Amin, CH.Amin, CH.Bbmaj, CH.Emaj],
    mel: ihBreak, drums: "heartbeat", drumV: 0.85, sus: 8, bassDur: 4, ring: 8,
    voice: { chord: "organ", lead: "brass" },
    vel: { chord: 0.028, lead: 0.07, bass: 0.19 } },

  // Straight eighths, and a counter-line underneath the brass.
  { section: "charge", fig: "push", bpm: 136, riff: ihCharge,
    prog: [CH.Aopen, CH.Amin, CH.Fmaj, CH.Gmaj, CH.Amin, CH.Bbmaj, CH.Fmaj, CH.Emaj],
    mel: ihChargeMel, mel2: ihChargeAlt, drums: "heart", sus: 1.8, bassDur: 0.85, arpDur: 1,
    voice: { chord: "keys", lead: "brass", arp: "guitar", lead2: "keys" },
    vel: { chord: 0.03, lead: 0.078, arp: 0.044, bass: 0.2, lead2: 0.042 } },

  // Up into the major, with the same shape underneath it.
  { section: "turn", fig: "drive", bpm: 136, riff: ihTurn,
    prog: [CH.Cmaj, CH.Gmaj, CH.Amin, CH.Fmaj, CH.Cmaj, CH.Gmaj, CH.Dmin, CH.Emaj],
    mel: ihTurnMel, drums: "heart", sus: 2.6, bassDur: 0.9, arpDur: 1.2,
    voice: { chord: "keys", lead: "brass", arp: "guitar" },
    vel: { chord: 0.032, lead: 0.08, arp: 0.044, bass: 0.2 } },

  // Half time. Twice the weight, half the speed.
  { section: "march", fig: "heavy", bpm: 120, riff: ihMarch,
    prog: [CH.Amin, CH.Amin, CH.Fmaj, CH.Fmaj, CH.Bbmaj, CH.Bbmaj, CH.Eopen, CH.Emaj],
    mel: ihMarchMel, drums: "halftime", sus: 5, bassDur: 1.6, arpDur: 2.4, ring: 8,
    voice: { chord: "organ", lead: "brass", arp: "guitar" },
    vel: { chord: 0.03, lead: 0.08, arp: 0.05, bass: 0.2 } },

  // One chord a bar, and a leading tone left hanging.
  { section: "hold", fig: "hold", bpm: 128,
    prog: [CH.Fmaj, CH.Gmaj, CH.Amin, CH.Emaj],
    mel: ihHold, drums: "heartbeat", drumV: 0.9, sus: 8, bassDur: 4, ring: 8,
    voice: { chord: "organ", lead: "brass" },
    vel: { chord: 0.028, lead: 0.072, bass: 0.19 } },

  // Runs.
  { section: "surge", fig: "push", bpm: 140, riff: ihSurge,
    prog: [CH.Aopen, CH.Amin, CH.Bbmaj, CH.Bbmaj, CH.Fmaj, CH.Gmaj, CH.Amin, CH.Emaj],
    mel: ihSurgeMel, drums: "heart", sus: 1.8, bassDur: 0.85, arpDur: 0.9,
    voice: { chord: "keys", lead: "keys", arp: "guitar" },
    vel: { chord: 0.03, lead: 0.088, arp: 0.04, bass: 0.2 } },

  // The riff as it started, with the roof taken off.
  { section: "final", fig: "push", bpm: 140, riff: ihFinal,
    prog: [CH.Amin, CH.Amin, CH.Bbmaj, CH.Amin, CH.Fmaj, CH.Gmaj, CH.Amin, CH.Aopen],
    mel: ihFinalMel, mel2: ihFinalAlt, drums: "heart", sus: 2.2, bassDur: 0.9, arpDur: 1.1,
    voice: { chord: "organ", lead: "brass", arp: "guitar", lead2: "keys" },
    vel: { chord: 0.03, lead: 0.082, arp: 0.048, bass: 0.2, lead2: 0.04 } },

  // Down to the pulse.
  { section: "out", fig: "low", bpm: 130, riff: ihOut,
    prog: [CH.Amin, CH.Bbmaj, CH.Amin, CH.Aopen],
    mel: ihOutMel, drums: "heartbeat", drumV: 0.7, sus: 8, bassDur: 4, arpDur: 1.6, ring: 8,
    voice: { chord: "organ", lead: "brass", arp: "guitar" },
    vel: { chord: 0.026, lead: 0.065, arp: 0.038, bass: 0.18 } },
].map((s) => ihSect({ ...s, song: "ironheart" }));

// ---- "Frontline" — E minor, SEVEN EIGHT, a hundred and eight bars,
// about two and a half minutes. Iron Heart is the other combat track and
// it's a steady four with a heartbeat under it, so this one goes the
// other way: a bar with a beat missing from it, grouped two-two-THREE, at
// a hundred and fifty. It never settles, which is the point — you can't
// get comfortable in seven, and that's exactly the right feeling for the
// track that plays when the line is moving.
//
// The bar itself is the material:
//
//   advance   the riff, two-two-three, twelve bars of it
//   theme     the lead over a pumping backing
//   shift     REGROUPED — three-two-two. Same seven beats, and every
//             accent has moved. The kit moves with it.
//   siege     slow and heavy, and the harmony finds a B♭: the TRITONE
//             from E, the most unstable note there is
//   hold      FOUR FOUR. The limp stops, the kick goes four-on-the-floor,
//             and for eight bars the line holds.
//   push      back into seven, straight eighths, everything at once
//   fall      one long descent, eight bars from the top to the bottom
//   rally     four four again, faster than anything else in the game
//   last      the riff with the octave doubled and the siren back over it
//   out       losing a note a bar
//
// The other thread is the SIREN: a two-note bell figure a fifth apart
// that follows the harmony instead of repeating a pitch. It opens the
// track, it's gone through the middle, and it comes back over the last
// charge.
//
// Harmonically it leans on chords A minor doesn't have — B MAJOR, whose
// D♯ sits a semitone under the tonic, and F major, the ♭II. Iron Heart is
// Phrygian off a ♭2; this is the same idea from a different angle, so the
// two tracks don't sound like each other in the pool.

// Build a Frontline section. `meter` is 7 unless a section says
// otherwise — two of them say otherwise.
function frSect(o) {
  const meter = o.meter ?? 7;
  const bars = o.prog.length;
  const steps = bars * meter;
  const chords = new Array(steps).fill(0);
  const bass = new Array(steps).fill(0);
  const arp = new Array(steps).fill(0);
  if (o.riff) for (let i = 0; i < steps; i++) arp[i] = o.riff[i] ?? 0;

  o.prog.forEach((c, bar) => {
    const at = bar * meter;
    const r = c.r;
    const t = c.n;
    const fifth = fold(t[1], r);

    // The group heads: where the bar leans. Seven can be counted three
    // ways and the piece uses two of them.
    const heads = o.heads ?? (meter === 7 ? [0, 2, 4] : [0, 2, 4, 6]);

    if (o.fig === "low") {
      bass[at] = r;
      chords[at] = t;
      if (bar % 2 === 1) bass[at + heads[1]] = fifth;

    } else if (o.fig === "grind") {
      // Two hits a bar and a long chord. Weight instead of speed.
      bass[at] = r;
      bass[at + heads[2]] = r;
      chords[at] = t;

    } else if (o.fig === "four") {
      // The four-four sections: on the floor.
      for (const s of heads) bass[at + s] = s === 0 ? r : (s === 4 ? r : fifth);
      chords[at] = t; chords[at + 4] = t;

    } else if (o.fig === "race") {
      bass[at] = r; bass[at + 2] = r; bass[at + 4] = r; bass[at + 6] = r;
      bass[at + 7] = fifth;
      chords[at] = t; chords[at + 3] = t; chords[at + 6] = t;

    } else {
      // "seven" — bass on every group head, chords on the first and last.
      for (const s of heads) bass[at + s] = s === 0 ? r : r;
      if (bar % 2 === 1) bass[at + meter - 1] = fifth;
      chords[at] = t;
      chords[at + heads[heads.length - 1]] = t;
    }

    // A generated backing for the sections that put the tune first: a
    // chord tone on each off-step, rotated a place every bar.
    if (o.pump) {
      for (let i = 0; i < meter; i++) {
        if (heads.includes(i)) continue;
        arp[at + i] = t[(bar + i) % t.length];
      }
    }
  });

  const mel = o.mel ?? new Array(steps).fill(0);
  const out = { ...o, meter, chords, bass, arp, mel, melDur: phrase(mel, o.ring ?? 5) };
  if (o.mel2) out.mel2Dur = phrase(o.mel2, o.ring2 ?? 5);
  if (o.mel3) out.mel3Dur = phrase(o.mel3, o.ring3 ?? 3);
  return out;
}

// --- the riffs. Seven steps to a bar unless marked.

// THE RIFF. Two-two-three: the notes land on 0, 2 and 4, and the last
// group of three is where it runs.
const frRiff = [
  /* Em */ N.E3,0,N.E3,0, N.E3,N.G3,N.B3,
  /* Em */ N.E3,0,N.E3,0, N.D3,N.C3,N.B2,
  /* C  */ N.C3,0,N.C3,0, N.C3,N.E3,N.G3,
  /* Bm */ N.B2,0,N.B2,0, N.D3,N.Fs3,N.B3,
  /* Am */ N.A3,0,N.A3,0, N.A3,N.C4,N.E4,
  /* G  */ N.G3,0,N.G3,0, N.G3,N.B3,N.D4,
  /* F  */ N.F3,0,N.F3,0, N.F3,N.A3,N.C4,
  /* B  */ N.B2,0,N.B2,0, N.Eb3,N.Fs3,N.B3,
  /* Em */ N.E3,0,N.E3,0, N.E3,N.Fs3,N.G3,
  /* C  */ N.C3,0,N.E3,0, N.G3,N.E3,N.C3,
  /* Am */ N.A3,0,N.C4,0, N.E4,N.C4,N.A3,
  /* B  */ N.B2,N.B2,N.B2,0, N.Eb3,N.Fs3,N.B3,
];

// Regrouped three-two-two: the same seven, leaning somewhere else.
const frShift = [
  /* Em */ N.E3,0,0, N.E3,0, N.G3,N.B3,
  /* G  */ N.G3,0,0, N.G3,0, N.B3,N.D4,
  /* Am */ N.A3,0,0, N.A3,0, N.C4,N.E4,
  /* B  */ N.B2,0,0, N.B2,0, N.Eb3,N.Fs3,
  /* Em */ N.E3,0,0, N.E3,0, N.B3,N.G3,
  /* C  */ N.C3,0,0, N.C3,0, N.G3,N.E3,
  /* F  */ N.F3,0,0, N.F3,0, N.C4,N.A3,
  /* B  */ N.B2,0,0, N.Eb3,0, N.Fs3,N.B3,
];

// Siege: two notes a bar, and a B♭ where the E ought to be.
const frSiege = [
  /* Em */ N.E3,0,0,0, N.E3,0,0,
  /* Em */ N.E3,0,0,0, N.G3,0,0,
  /* F  */ N.F3,0,0,0, N.F3,0,0,
  /* F  */ N.F3,0,0,0, N.A3,0,0,
  /* Em */ N.E3,0,0,0, N.E3,0,N.D3,
  /* Em */ N.E3,0,0,0, N.B3,0,N.G3,
  /* B♭ */ N.Bb2,0,0,0, N.Bb2,0,0,
  /* B♭ */ N.Bb2,0,0,0, N.D3,0,N.F3,
  /* Am */ N.A3,0,0,0, N.A3,0,0,
  /* Am */ N.A3,0,0,0, N.C4,0,N.E4,
  /* B  */ N.B2,0,0,0, N.B2,0,0,
  /* B  */ N.B2,0,0,0, N.Eb3,0,N.Fs3,
];

// Four four. Eight steps a bar for eight bars.
const frHold = [
  N.E3,0,N.E3,0, N.E3,0,N.E3,0,
  N.E3,0,N.E3,0, N.E3,N.G3,N.B3,N.D4,
  N.C3,0,N.C3,0, N.C3,0,N.C3,0,
  N.D3,0,N.D3,0, N.D3,N.Fs3,N.A3,N.C4,
  N.E3,0,N.E3,N.G3, N.E3,0,N.B3,0,
  N.C3,0,N.C3,0, N.E3,0,N.G3,0,
  N.A3,0,N.A3,0, N.C4,0,N.E4,0,
  N.B2,0,N.B2,0, N.Eb3,0,N.Fs3,N.B3,
];

// Push: straight sevens, no gaps.
const frPush = [
  /* Em */ N.E3,N.E3,N.G3,N.E3, N.B3,N.G3,N.E3,
  /* Em */ N.E3,N.E3,N.G3,N.E3, N.B3,N.D4,N.B3,
  /* C  */ N.C3,N.C3,N.E3,N.C3, N.G3,N.E3,N.C3,
  /* D  */ N.D3,N.D3,N.Fs3,N.D3, N.A3,N.Fs3,N.D3,
  /* Em */ N.E3,N.E3,N.G3,N.B3, N.E4,N.B3,N.G3,
  /* Am */ N.A3,N.A3,N.C4,N.A3, N.E4,N.C4,N.A3,
  /* F  */ N.F3,N.F3,N.A3,N.F3, N.C4,N.A3,N.F3,
  /* B  */ N.B2,N.B2,N.Eb3,N.Fs3, N.B3,N.Fs3,N.Eb3,
  /* Em */ N.E3,N.E3,N.B3,N.E3, N.G3,N.B3,N.E4,
  /* G  */ N.G3,N.G3,N.D4,N.G3, N.B3,N.D4,N.G3,
  /* Am */ N.A3,N.A3,N.E4,N.A3, N.C4,N.E4,N.A3,
  /* B  */ N.B2,N.B2,N.Fs3,N.B3, N.Eb4,N.Fs3,N.B2,
];

// Fall: eight bars, one continuous descent.
const frFall = [
  /* Em */ N.E4,0,N.D4,0, N.B3,0,N.G3,
  /* D  */ N.D4,0,N.C4,0, N.A3,0,N.Fs3,
  /* C  */ N.C4,0,N.B3,0, N.G3,0,N.E3,
  /* B  */ N.B3,0,N.Fs3,0, N.Eb3,0,N.B2,
  /* Am */ N.A3,0,N.G3,0, N.E3,0,N.C3,
  /* G  */ N.G3,0,N.Fs3,0, N.D3,0,N.B2,
  /* F  */ N.F3,0,N.E3,0, N.C3,0,N.A2,
  /* B  */ N.B2,0,0,0, N.Fs3,0,N.B3,
];

// Rally: four four, and the fastest thing in the game.
const frRally = [
  N.E3,N.E3,N.B3,N.E3, N.G3,N.E3,N.B3,N.G3,
  N.G3,N.G3,N.D4,N.G3, N.B3,N.G3,N.D4,N.B3,
  N.A3,N.A3,N.E4,N.A3, N.C4,N.A3,N.E4,N.C4,
  N.B2,N.B2,N.Fs3,N.B2, N.Eb3,N.B2,N.Fs3,N.Eb3,
  N.E3,N.E3,N.G3,N.B3, N.E4,N.B3,N.G3,N.E3,
  N.C3,N.C3,N.E3,N.G3, N.C4,N.G3,N.E3,N.C3,
  N.F3,N.F3,N.A3,N.C4, N.F4,N.C4,N.A3,N.F3,
  N.B2,N.Fs3,N.B3,N.Eb4, N.Fs4,N.Eb4,N.B3,N.Fs3,
];

// Last: the riff with the octave opened up on every other step.
const frLast = [
  N.E3,N.B3,N.E3,N.B3, N.E3,N.G3,N.B3,
  N.E3,N.B3,N.E3,N.B3, N.D4,N.C4,N.B3,
  N.C3,N.G3,N.C3,N.G3, N.C4,N.E3,N.G3,
  N.B2,N.Fs3,N.B2,N.Fs3, N.D3,N.Fs3,N.B3,
  N.A3,N.E4,N.A3,N.E4, N.A3,N.C4,N.E4,
  N.G3,N.D4,N.G3,N.D4, N.G3,N.B3,N.D4,
  N.F3,N.C4,N.F3,N.C4, N.F3,N.A3,N.C4,
  N.B2,N.Fs3,N.B2,N.Fs3, N.Eb3,N.Fs3,N.B3,
  N.E3,N.B3,N.E4,N.B3, N.E3,N.Fs3,N.G3,
  N.C3,N.G3,N.C4,N.G3, N.E3,N.G3,N.C4,
  N.A3,N.E4,N.A3,N.E4, N.C4,N.E4,N.A4,
  N.B2,N.B2,N.Fs3,N.B3, N.Eb4,N.Fs4,N.B4,
];

// Out.
const frOut = [
  N.E3,0,N.E3,0, N.E3,N.G3,N.B3,
  N.E3,0,N.E3,0, N.E3,0,0,
  N.C3,0,N.C3,0, 0,0,0,
  N.A3,0,N.A3,0, 0,0,0,
  N.E3,0,N.E3,0, 0,0,0,
  N.F3,0,0,0, 0,0,0,
  N.B2,0,0,0, 0,0,0,
  N.E3,0,0,0, 0,0,0,
];

// --- the lines.

// THE SIREN. Two notes a fifth apart, following the harmony.
const frSiren = [
  /* Em */ N.E5,0,N.B5,0, N.E5,0,N.B5,
  /* Em */ N.B5,0,N.E5,0, N.B5,0,0,
  /* Em */ 0,0,0,0, 0,0,0,
  /* Em */ 0,0,0,0, 0,0,N.E5,
  /* F  */ N.F5,0,N.C5,0, N.F5,0,N.C5,
  /* F  */ N.C5,0,N.F5,0, N.C5,0,0,
  /* B  */ N.Fs5,0,N.B4,0, N.Fs5,0,N.B4,
  /* B  */ N.B4,0,N.Fs5,0, N.Eb5,0,N.Fs5,
];
const frSirenBack = [    // the same call, once more, under the last charge
  N.E5,0,0,0, N.B5,0,0,
  0,0,0,0, 0,0,0,
  0,0,0,0, 0,0,0,
  0,0,0,0, 0,0,0,
  N.E5,0,0,0, N.B5,0,0,
  0,0,0,0, 0,0,0,
  0,0,0,0, 0,0,0,
  0,0,0,0, 0,0,0,
  N.E5,0,0,0, N.B5,0,0,
  0,0,0,0, 0,0,0,
  0,0,0,0, 0,0,0,
  N.Fs5,0,0,0, N.B5,0,0,
];

const frTheme = [
  /* Em */ N.B4,0,N.E5,0, N.G5,0,N.Fs5,
  /* Em */ N.E5,0,0,0, N.D5,N.B4,0,
  /* C  */ N.C5,0,N.E5,0, N.G5,0,0,
  /* Bm */ N.Fs5,0,N.D5,0, N.B4,0,0,
  /* Am */ N.A4,0,N.C5,0, N.E5,0,N.A5,
  /* G  */ N.G5,0,N.D5,0, N.B4,0,0,
  /* F  */ N.C5,0,N.A4,0, N.F5,0,N.E5,
  /* B  */ N.Fs5,0,N.Eb5,0, N.B4,0,0,
  /* Em */ N.E5,0,N.G5,0, N.B5,0,N.A5,
  /* C  */ N.G5,0,N.E5,0, N.C5,0,0,
  /* F  */ N.A5,0,N.F5,0, N.C5,0,N.A4,
  /* B  */ N.B4,0,N.Eb5,0, N.Fs5,0,0,
];

const frShiftMel = [
  N.B4,0,0, N.E5,0, N.G5,0,
  N.D5,0,0, N.B4,0, N.G4,0,
  N.C5,0,0, N.E5,0, N.A5,0,
  N.Fs5,0,0, N.Eb5,0, N.B4,0,
  N.E5,0,0, N.G5,0, N.B5,0,
  N.G5,0,0, N.E5,0, N.C5,0,
  N.A4,0,0, N.C5,0, N.F5,0,
  N.Eb5,0,0, N.Fs5,0, N.B5,0,
];

const frSiegeMel = [
  N.E5,0,0,0, N.D5,0,0,
  N.B4,0,0,0, 0,0,0,
  N.C5,0,0,0, N.A4,0,0,
  N.F5,0,0,0, 0,0,0,
  N.E5,0,0,0, N.G5,0,0,
  N.Fs5,0,0,0, N.E5,0,0,
  N.F5,0,0,0, N.D5,0,0,
  N.Bb4,0,0,0, N.D5,0,N.F5,
  N.A4,0,0,0, N.C5,0,0,
  N.E5,0,0,0, N.A5,0,0,
  N.Fs5,0,0,0, N.Eb5,0,0,
  N.B4,0,0,0, N.Fs5,0,N.B5,
];

const frHoldMel = [
  N.B4,0,0,0, N.E5,0,0,0,
  N.G5,0,0,0, N.Fs5,0,N.E5,0,
  N.G5,0,0,0, N.E5,0,N.C5,0,
  N.D5,0,N.Fs5,0, N.A5,0,0,0,
  N.B5,0,0,0, N.G5,0,N.E5,0,
  N.G5,0,N.E5,0, N.C5,0,N.G4,0,
  N.A4,0,N.C5,0, N.E5,0,N.A5,0,
  N.Fs5,0,0,0, N.Eb5,0,N.B4,0,
];

const frPushMel = [
  N.E5,0,N.G5,0, N.B5,0,N.A5,
  N.G5,0,N.Fs5,0, N.E5,0,N.D5,
  N.C5,0,N.E5,0, N.G5,0,N.E5,
  N.D5,0,N.Fs5,0, N.A5,0,0,
  N.B4,0,N.E5,0, N.G5,0,N.B5,
  N.A5,0,N.E5,0, N.C5,0,N.A4,
  N.F5,0,N.C5,0, N.A4,0,N.F5,
  N.Fs5,0,N.Eb5,0, N.B4,0,N.Fs5,
  N.E5,0,N.B4,0, N.E5,0,N.G5,
  N.D5,0,N.B4,0, N.G4,0,N.D5,
  N.C5,0,N.E5,0, N.A5,0,N.E5,
  N.Eb5,0,N.Fs5,0, N.B5,0,0,
];
const frPushAlt = [
  N.E4,0,0,0, N.B4,0,0,
  N.B4,0,0,0, N.G4,0,0,
  N.G4,0,0,0, N.E4,0,0,
  N.A4,0,0,0, N.Fs4,0,0,
  N.E4,0,0,0, N.B4,0,0,
  N.C5,0,0,0, N.A4,0,0,
  N.A4,0,0,0, N.F4,0,0,
  N.B4,0,0,0, N.Fs4,0,0,
  N.E4,0,0,0, N.G4,0,0,
  N.D5,0,0,0, N.B4,0,0,
  N.E4,0,0,0, N.A4,0,0,
  N.Fs4,0,0,0, N.B4,0,0,
];

const frFallMel = [
  N.B5,0,N.A5,0, N.G5,0,N.Fs5,
  N.E5,0,N.D5,0, N.C5,0,N.A4,
  N.G5,0,N.E5,0, N.C5,0,N.G4,
  N.Fs5,0,N.Eb5,0, N.B4,0,0,
  N.E5,0,N.C5,0, N.A4,0,N.E4,
  N.D5,0,N.B4,0, N.G4,0,N.D4,
  N.C5,0,N.A4,0, N.F4,0,N.C4,
  N.B4,0,0,0, N.Fs4,0,N.B4,
];

const frRallyMel = [
  N.E5,0,N.G5,0, N.B5,0,N.G5,0,
  N.D5,0,N.B4,0, N.G5,0,N.D5,0,
  N.C5,0,N.E5,0, N.A5,0,N.E5,0,
  N.B4,0,N.Eb5,0, N.Fs5,0,N.B5,0,
  N.E5,0,N.B4,0, N.G5,0,N.E5,0,
  N.C5,0,N.G5,0, N.E5,0,N.C5,0,
  N.F5,0,N.C5,0, N.A5,0,N.F5,0,
  N.Fs5,0,N.B5,0, N.Eb5,0,N.Fs5,0,
];

const frLastMel = [
  N.B5,0,N.G5,0, N.E5,0,N.B4,
  N.E5,0,N.Fs5,0, N.G5,0,N.B5,
  N.G5,0,N.E5,0, N.C5,0,N.G5,
  N.Fs5,0,N.D5,0, N.B4,0,N.Fs5,
  N.A5,0,N.E5,0, N.C5,0,N.A4,
  N.B4,0,N.D5,0, N.G5,0,N.B5,
  N.A5,0,N.F5,0, N.C5,0,N.A5,
  N.B5,0,N.Fs5,0, N.Eb5,0,N.B4,
  N.E5,0,N.G5,0, N.B5,0,N.E5,
  N.G5,0,N.C5,0, N.E5,0,N.G5,
  N.A5,0,N.E5,0, N.C5,0,N.A5,
  N.Fs5,0,N.Eb5,0, N.B5,0,0,
];

const frOutMel = [
  N.E5,0,0,0, N.B4,0,0,
  N.G4,0,0,0, 0,0,0,
  N.E5,0,0,0, 0,0,0,
  N.C5,0,0,0, 0,0,0,
  N.B4,0,0,0, 0,0,0,
  N.A4,0,0,0, 0,0,0,
  N.Fs4,0,0,0, 0,0,0,
  N.E4,0,0,0, 0,0,0,
];

const songFrontline = [
  // The siren, and a bass coming up underneath it.
  { section: "alarm", fig: "low", bpm: 144,
    prog: [CH.Emin, CH.Emin, CH.Emin, CH.Emin, CH.Fmaj, CH.Fmaj, CH.Bmaj, CH.Bmaj],
    mel: frSiren, drums: "swell", sus: 7, bassDur: 4, ring: 4,
    voice: { chord: "organ", lead: "bell" },
    vel: { chord: 0.028, lead: 0.042, bass: 0.19 } },

  // The riff.
  { section: "advance", fig: "seven", bpm: 152, riff: frRiff,
    prog: [CH.Emin, CH.Emin, CH.Cmaj, CH.Bmin, CH.Amin, CH.Gmaj,
           CH.Fmaj, CH.Bmaj, CH.Emin, CH.Cmaj, CH.Amin, CH.Bmaj],
    drums: "seven", sus: 1.8, bassDur: 0.9, arpDur: 1,
    voice: { chord: "keys", arp: "guitar" },
    vel: { chord: 0.03, arp: 0.05, bass: 0.2 } },

  // The tune, over a backing that rotates a place every bar.
  { section: "theme", fig: "seven", bpm: 152, pump: true,
    prog: [CH.Emin, CH.Emin, CH.Cmaj, CH.Bmin, CH.Amin, CH.Gmaj,
           CH.Fmaj, CH.Bmaj, CH.Emin, CH.Cmaj, CH.Fmaj, CH.Bmaj],
    mel: frTheme, drums: "seven", sus: 1.8, bassDur: 0.9, arpDur: 0.9,
    voice: { chord: "keys", lead: "pluck", arp: "guitar" },
    vel: { chord: 0.03, lead: 0.08, arp: 0.036, bass: 0.2 } },

  // Same seven beats. Every accent has moved.
  { section: "shift", fig: "seven", heads: [0, 3, 5], bpm: 152, riff: frShift,
    prog: [CH.Emin, CH.Gmaj, CH.Amin, CH.Bmaj, CH.Emin, CH.Cmaj, CH.Fmaj, CH.Bmaj],
    mel: frShiftMel, drums: "seven3", sus: 1.8, bassDur: 0.9, arpDur: 1,
    voice: { chord: "keys", lead: "pluck", arp: "guitar" },
    vel: { chord: 0.03, lead: 0.08, arp: 0.046, bass: 0.2 } },

  // Heavy, and a B♭ a tritone from home.
  { section: "siege", fig: "grind", bpm: 148, riff: frSiege,
    prog: [CH.Emin, CH.Emin, CH.Fmaj, CH.Fmaj, CH.Emin, CH.Emin,
           CH.Bbmaj, CH.Bbmaj, CH.Amin, CH.Amin, CH.Bmaj, CH.Bmaj],
    mel: frSiegeMel, drums: "siege", sus: 5, bassDur: 2, arpDur: 2.4, ring: 6,
    voice: { chord: "organ", lead: "brass", arp: "guitar" },
    vel: { chord: 0.03, lead: 0.08, arp: 0.05, bass: 0.2 } },

  // Four four. The limp stops.
  { section: "hold", fig: "four", meter: 8, bpm: 152, riff: frHold,
    prog: [CH.Emin, CH.Emin, CH.Cmaj, CH.Dmaj, CH.Emin, CH.Cmaj, CH.Amin, CH.Bmaj],
    mel: frHoldMel, drums: "line", sus: 2.6, bassDur: 0.9, arpDur: 1, ring: 6,
    voice: { chord: "keys", lead: "brass", arp: "guitar" },
    vel: { chord: 0.032, lead: 0.082, arp: 0.046, bass: 0.2 } },

  // Back into seven, with everything at once.
  { section: "push", fig: "seven", bpm: 156, riff: frPush,
    prog: [CH.Emin, CH.Emin, CH.Cmaj, CH.Dmaj, CH.Emin, CH.Amin,
           CH.Fmaj, CH.Bmaj, CH.Emin, CH.Gmaj, CH.Amin, CH.Bmaj],
    mel: frPushMel, mel2: frPushAlt, drums: "seven", sus: 1.6, bassDur: 0.85, arpDur: 0.85,
    voice: { chord: "keys", lead: "pluck", arp: "guitar", lead2: "brass" },
    vel: { chord: 0.03, lead: 0.082, arp: 0.042, bass: 0.2, lead2: 0.046 } },

  // One long way down.
  { section: "fall", fig: "seven", bpm: 152, riff: frFall,
    prog: [CH.Emin, CH.Dmaj, CH.Cmaj, CH.Bmaj, CH.Amin, CH.Gmaj, CH.Fmaj, CH.Bmaj],
    mel: frFallMel, drums: "seven", drumV: 0.8, sus: 2.2, bassDur: 1, arpDur: 1.1,
    voice: { chord: "organ", lead: "pluck", arp: "guitar" },
    vel: { chord: 0.028, lead: 0.078, arp: 0.044, bass: 0.19 } },

  // The fastest thing in the game.
  { section: "rally", fig: "race", meter: 8, bpm: 160, riff: frRally,
    prog: [CH.Emin, CH.Gmaj, CH.Amin, CH.Bmaj, CH.Emin, CH.Cmaj, CH.Fmaj, CH.Bmaj],
    mel: frRallyMel, drums: "race", sus: 1.6, bassDur: 0.8, arpDur: 0.8,
    voice: { chord: "keys", lead: "pluck", arp: "guitar" },
    vel: { chord: 0.032, lead: 0.085, arp: 0.04, bass: 0.2 } },

  // The last charge, with the siren over it.
  { section: "last", fig: "seven", bpm: 156, riff: frLast,
    prog: [CH.Emin, CH.Emin, CH.Cmaj, CH.Bmin, CH.Amin, CH.Gmaj,
           CH.Fmaj, CH.Bmaj, CH.Emin, CH.Cmaj, CH.Amin, CH.Bmaj],
    mel: frLastMel, mel3: frSirenBack, drums: "seven", sus: 1.8, bassDur: 0.9, arpDur: 0.85,
    voice: { chord: "keys", lead: "pluck", arp: "guitar", lead3: "bell" },
    vel: { chord: 0.032, lead: 0.085, arp: 0.046, bass: 0.2, lead3: 0.04 } },

  // Out.
  { section: "out", fig: "low", bpm: 148, riff: frOut,
    prog: [CH.Emin, CH.Emin, CH.Cmaj, CH.Amin, CH.Emin, CH.Fmaj, CH.Bmaj, CH.Emin],
    mel: frOutMel, drums: "swell", drumV: 0.7, sus: 7, bassDur: 4, arpDur: 1.6, ring: 6,
    voice: { chord: "organ", lead: "bell", arp: "guitar" },
    vel: { chord: 0.026, lead: 0.05, arp: 0.036, bass: 0.18 } },
].map((s) => frSect({ ...s, song: "frontline" }));

// ---- "Stalker" — D minor, NINE EIGHT, seventy-two bars, about two
// forty. The pool already has two dense combat tracks: Iron Heart is a
// steady four that never lets up, Frontline is a seven that never
// settles. Both are full. So this one is mostly EMPTY — the tension is in
// what isn't playing — and the two ideas in it are both about distance.
//
//   1. THE SONAR. Two bell notes, high, and the interval between them
//      CLOSES as the piece goes on:
//
//        distant/track   D–A    a fifth
//        nearer/circle   D–G    a fourth
//        closer/pounce   D–F    a minor third
//        lost            D–A    a fifth again — it lost you
//        close           D–E    a whole tone
//        strike          D–E♭   a SEMITONE
//        after           widening back out as it goes away
//
//      The ping rate speeds up with it. Nothing else in the piece needs
//      to say what's happening; that does it on its own.
//
//      The lower of the two notes is always D — the tonic — and it does
//      NOT follow the harmony underneath it. That's deliberate: a tonic
//      held in the top voice against chords that move away from it is an
//      inverted pedal, and the grinding it causes over the diminished
//      chords is the whole reason to do it. It's a signal, not a part.
//
//   2. NINE EIGHT, grouped two-two-two-THREE. Frontline's seven sounds
//      like a bar with a beat missing; this sounds like a bar with one
//      too many — almost a four, and then it doesn't stop when you expect
//      it to. "pounce" regroups to three-three-three for eight bars and
//      the limp turns into a gallop.
//
// The harmony creeps by semitone rather than moving by fifths. E♭ major
// is the NEAPOLITAN — the chord a semitone above the tonic, which is the
// oldest sound in music for something being too close — and "circle"
// walks the bass up D, E♭, E, F while the tune walks up with it.

// Build a Stalker section. Nine steps to a bar, leaning on 0, 2, 4 and 6
// unless the section says three-three-three.
function stSect(o) {
  const meter = 9;
  const bars = o.prog.length;
  const steps = bars * meter;
  const chords = new Array(steps).fill(0);
  const bass = new Array(steps).fill(0);
  const arp = new Array(steps).fill(0);
  if (o.riff) for (let i = 0; i < steps; i++) arp[i] = o.riff[i] ?? 0;
  const heads = o.heads ?? [0, 2, 4, 6];

  o.prog.forEach((c, bar) => {
    const at = bar * meter;
    const r = c.r;
    const t = c.n;
    const fifth = fold(t[1], r);

    if (o.fig === "drone") {
      // One note. One chord. A lot of nothing.
      bass[at] = r;
      chords[at] = t;

    } else if (o.fig === "creep") {
      bass[at] = r;
      bass[at + 6] = r;
      chords[at] = t;
      if (bar % 2 === 1) bass[at + 4] = fifth;

    } else if (o.fig === "circle") {
      bass[at] = r; bass[at + 4] = r; bass[at + 6] = fifth;
      chords[at] = t; chords[at + 4] = t;

    } else if (o.fig === "roll") {
      // Three-three-three.
      bass[at] = r; bass[at + 3] = r; bass[at + 6] = r;
      if (bar % 2 === 1) bass[at + 8] = fifth;
      chords[at] = t; chords[at + 6] = t;

    } else if (o.fig === "strike") {
      for (const s of heads) bass[at + s] = r;
      bass[at + 8] = fifth;
      chords[at] = t; chords[at + 4] = t; chords[at + 6] = t;

    } else {
      // "press" — closing.
      bass[at] = r; bass[at + 2] = r; bass[at + 4] = r; bass[at + 6] = r;
      chords[at] = t; chords[at + 6] = t;
      if (bar % 2 === 1) chords[at + 4] = t;
    }
  });

  const mel = o.mel ?? new Array(steps).fill(0);
  const out = { ...o, meter, chords, bass, arp, mel, melDur: phrase(mel, o.ring ?? 6) };
  if (o.mel2) out.mel2Dur = phrase(o.mel2, o.ring2 ?? 6);
  if (o.mel3) out.mel3Dur = phrase(o.mel3, o.ring3 ?? 4);
  return out;
}

// --- THE SONAR. Two notes, and the gap between them shutting.

const stPing5 = [        // a fifth, one ping a bar, and a bar of silence
  N.D5,0,0,0, N.A5,0,0,0,0,
  0,0,0,0, 0,0,0,0,0,
  N.D5,0,0,0, N.A5,0,0,0,0,
  0,0,0,0, 0,0,0,0,0,
];
const stPing5b = [       // the same, through eight bars
  N.D5,0,0,0, N.A5,0,0,0,0,
  0,0,0,0, 0,0,0,0,0,
  N.D5,0,0,0, N.A5,0,0,0,0,
  0,0,0,0, 0,0,0,0,0,
  N.D5,0,0,0, N.A5,0,0,0,0,
  0,0,0,0, 0,0,0,0,0,
  N.D5,0,0,0, N.A5,0,0,0,0,
  0,0,0,0, 0,0,0,N.A5,0,
];
const stPing4 = [        // a fourth, every bar
  N.D5,0,0,0, N.G5,0,0,0,0,
  N.D5,0,0,0, N.G5,0,0,0,0,
  N.D5,0,0,0, N.G5,0,0,0,0,
  N.D5,0,0,0, N.G5,0,0,0,0,
  N.D5,0,0,0, N.G5,0,0,0,0,
  N.D5,0,0,0, N.G5,0,0,0,0,
  N.D5,0,0,0, N.G5,0,0,0,0,
  N.D5,0,0,N.G5, N.D5,0,0,N.G5,0,
];
const stPing3 = [        // a minor third, twice a bar
  N.D5,0,N.F5,0, N.D5,0,N.F5,0,0,
  N.D5,0,N.F5,0, N.D5,0,N.F5,0,0,
  N.D5,0,N.F5,0, N.D5,0,N.F5,0,0,
  N.D5,0,N.F5,0, N.D5,0,N.F5,N.D5,N.F5,
  N.D5,0,N.F5,0, N.D5,0,N.F5,0,0,
  N.D5,0,N.F5,0, N.D5,0,N.F5,0,0,
  N.D5,0,N.F5,0, N.D5,0,N.F5,0,0,
  N.D5,0,N.F5,0, N.D5,N.F5,N.D5,N.F5,N.D5,
];
const stPingLost = [     // wide again. It doesn't know where you are.
  N.D5,0,0,0, 0,0,0,0,0,
  0,0,0,0, N.A5,0,0,0,0,
  0,0,0,0, 0,0,0,0,0,
  N.D5,0,0,0, 0,0,0,0,0,
];
const stPing2 = [        // a whole tone
  N.D5,0,N.E5,0, N.D5,0,N.E5,0,0,
  N.D5,0,N.E5,0, N.D5,0,N.E5,0,0,
  N.D5,0,N.E5,0, N.D5,0,N.E5,0,0,
  N.D5,0,N.E5,0, N.D5,N.E5,N.D5,N.E5,0,
  N.D5,0,N.E5,0, N.D5,0,N.E5,0,0,
  N.D5,0,N.E5,0, N.D5,0,N.E5,0,0,
  N.D5,N.E5,N.D5,N.E5, N.D5,0,N.E5,0,0,
  N.D5,N.E5,N.D5,N.E5, N.D5,N.E5,N.D5,N.E5,N.D5,
];
const stPing1 = [        // a semitone
  N.D5,N.Eb5,N.D5,N.Eb5, N.D5,0,N.Eb5,0,0,
  N.D5,N.Eb5,N.D5,N.Eb5, N.D5,0,N.Eb5,0,0,
  N.D5,N.Eb5,N.D5,N.Eb5, N.D5,N.Eb5,N.D5,N.Eb5,0,
  N.D5,N.Eb5,N.D5,N.Eb5, N.D5,0,N.Eb5,0,0,
  N.D5,N.Eb5,N.D5,N.Eb5, N.D5,0,N.Eb5,0,0,
  N.D5,N.Eb5,N.D5,N.Eb5, N.D5,N.Eb5,N.D5,N.Eb5,0,
  N.D5,N.Eb5,N.D5,N.Eb5, N.D5,0,N.Eb5,0,0,
  N.D5,N.Eb5,N.D5,N.Eb5, N.D5,N.Eb5,N.D5,N.Eb5,N.D5,
];
const stPingGone = [     // opening back out: a third, a fourth, a fifth
  N.D5,0,N.F5,0, N.D5,0,0,0,0,
  N.D5,0,0,0, N.G5,0,0,0,0,
  0,0,0,0, 0,0,0,0,0,
  N.D5,0,0,0, N.A5,0,0,0,0,
];

// --- the riffs. Nine steps a bar: two, two, two, THREE.

const stDistant = [
  0,0, 0,0, 0,0, 0,0,0,
  0,0, 0,0, 0,0, N.D3,0,0,
  0,0, 0,0, N.Eb3,0, N.D3,0,0,
  N.D3,0, 0,0, N.Eb3,0, N.D3,0,0,
];

const stTrack = [
  /* Dm */ N.D3,0, N.D3,0, N.Eb3,0, N.D3,0,0,
  /* Dm */ N.D3,0, N.D3,0, N.C3,0, N.Bb2,0,N.A2,
  /* E♭ */ N.Eb3,0, N.Eb3,0, N.D3,0, N.Eb3,0,0,
  /* A7 */ N.A2,0, N.A2,0, N.Cs3,0, N.E3,0,N.G3,
  /* Dm */ N.D3,0, N.F3,0, N.D3,0, N.A2,0,0,
  /* B♭ */ N.Bb2,0, N.D3,0, N.Bb2,0, N.F3,0,N.D3,
  /* Gm */ N.G2,0, N.Bb2,0, N.G2,0, N.D3,0,0,
  /* A7 */ N.A2,0, N.Cs3,0, N.E3,0, N.G3,0,N.E3,
];

const stNearer = [
  N.D3,0, N.A2,0, N.D3,0, N.Eb3,N.D3,0,
  N.Eb3,0, N.Bb2,0, N.Eb3,0, N.D3,0,0,
  N.D3,0, N.A2,0, N.D3,0, N.F3,N.E3,N.D3,
  N.C3,0, N.G2,0, N.C3,0, N.E3,0,0,
  N.Bb2,0, N.F3,0, N.Bb2,0, N.D3,0,N.F3,
  N.A2,0, N.E3,0, N.A2,0, N.Cs3,0,0,
  N.D3,0, N.F3,0, N.A2,0, N.D3,0,N.F3,
  N.D3,0, N.D3,0, N.Eb3,0, N.E3,N.F3,0,
];

const stCircle = [
  N.D3,0, N.D3,0, N.D3,0, N.F3,0,N.A2,
  N.Eb3,0, N.Eb3,0, N.Eb3,0, N.G3,0,N.Bb2,
  N.E3,0, N.E3,0, N.E3,0, N.G3,0,N.Bb2,
  N.F3,0, N.F3,0, N.F3,0, N.A3,0,N.C3,
  N.G2,0, N.G2,0, N.Bb2,0, N.D3,0,N.G3,
  N.F3,0, N.F3,0, N.A3,0, N.C4,0,N.F3,
  N.Eb3,0, N.Eb3,0, N.G3,0, N.Bb3,0,N.Eb3,
  N.A2,0, N.A2,0, N.Cs3,0, N.E3,N.G3,N.A3,
];

const stCloser = [
  N.D3,N.D3, N.A2,0, N.D3,0, N.F3,N.E3,N.D3,
  N.Cs3,N.Cs3, N.G2,0, N.Cs3,0, N.E3,0,N.Bb2,
  N.D3,N.D3, N.A2,0, N.D3,0, N.F3,0,N.A3,
  N.Eb3,N.Eb3, N.Bb2,0, N.Eb3,0, N.G3,0,N.Bb3,
  N.D3,N.D3, N.F3,0, N.A3,0, N.D4,0,N.A3,
  N.Bb2,N.Bb2, N.F3,0, N.Bb2,0, N.Cs3,0,N.F3,
  N.A2,N.A2, N.E3,0, N.A2,0, N.Cs3,0,N.G3,
  N.A2,N.A2, N.Cs3,0, N.E3,0, N.G3,0,N.A3,
];

const stPounce = [       // three-three-three
  N.D3,N.A3,N.D4, N.A3,N.D3,N.A2, N.D3,N.F3,N.A3,
  N.D3,N.F3,N.A3, N.D4,N.A3,N.F3, N.D3,N.A2,N.F3,
  N.G2,N.D3,N.G3, N.Bb3,N.G3,N.D3, N.G2,N.Bb2,N.D3,
  N.G2,N.Bb2,N.D3, N.G3,N.D3,N.Bb2, N.G2,N.D3,N.G3,
  N.Bb2,N.F3,N.Bb3, N.D4,N.Bb3,N.F3, N.Bb2,N.D3,N.F3,
  N.A2,N.E3,N.A3, N.Cs4,N.A3,N.E3, N.A2,N.Cs3,N.E3,
  N.D3,N.A3,N.D4, N.F4,N.D4,N.A3, N.D3,N.F3,N.A3,
  N.A2,N.Cs3,N.E3, N.G3,N.E3,N.Cs3, N.A2,N.E3,N.A3,
];

const stLost = [
  N.D3,0, 0,0, 0,0, 0,0,0,
  0,0, 0,0, N.Eb3,0, 0,0,0,
  0,0, N.A2,0, 0,0, N.D3,0,0,
  0,0, 0,0, 0,0, N.E3,0,0,
];

const stClose = [
  N.D3,0, N.D3,N.D3, N.Eb3,0, N.D3,0,0,
  N.D3,0, N.D3,N.D3, N.Eb3,0, N.F3,0,N.Eb3,
  N.Eb3,0, N.Eb3,N.Eb3, N.D3,0, N.Eb3,0,0,
  N.Eb3,0, N.Eb3,N.Eb3, N.G3,0, N.Bb3,0,N.G3,
  N.Bb2,0, N.Bb2,N.Bb2, N.D3,0, N.F3,0,N.D3,
  N.Cs3,0, N.Cs3,N.Cs3, N.E3,0, N.G3,0,N.Bb3,
  N.A2,0, N.A2,N.A2, N.Cs3,0, N.E3,0,N.G3,
  N.A2,N.A2, N.A2,N.A2, N.Cs3,N.E3, N.G3,N.A3,N.Cs4,
];

const stStrike = [
  N.D3,N.D3, N.D4,N.D3, N.A3,N.D3, N.F3,N.A3,N.D4,
  N.Eb3,N.Eb3, N.Eb4,N.Eb3, N.Bb3,N.Eb3, N.G3,N.Bb3,N.Eb4,
  N.D3,N.D3, N.D4,N.D3, N.A3,N.D3, N.F3,N.E3,N.D3,
  N.Cs3,N.Cs3, N.Bb3,N.Cs3, N.G3,N.Cs3, N.E3,N.G3,N.Bb3,
  N.Bb2,N.Bb2, N.Bb3,N.Bb2, N.F3,N.Bb2, N.D3,N.F3,N.Bb3,
  N.G2,N.G2, N.G3,N.G2, N.D3,N.G2, N.Bb2,N.D3,N.G3,
  N.A2,N.A2, N.A3,N.A2, N.E3,N.A2, N.Cs3,N.E3,N.G3,
  N.D3,N.D3, N.D4,N.A3, N.F3,N.D3, N.A2,N.D3,N.F3,
];

const stAfter = [
  N.D3,0, N.D3,0, N.Eb3,0, N.D3,0,0,
  N.Eb3,0, 0,0, N.D3,0, 0,0,0,
  N.Cs3,0, 0,0, 0,0, 0,0,0,
  N.D3,0, 0,0, 0,0, 0,0,0,
];

// --- the lines.

const stNearerMel = [    // flute, high and alone
  N.A5,0, 0,0, 0,0, N.F5,0,0,
  N.G5,0, 0,0, 0,0, N.Eb5,0,0,
  N.F5,0, 0,0, N.E5,0, N.D5,0,0,
  N.E5,0, 0,0, 0,0, N.G5,0,0,
  N.F5,0, 0,0, N.D5,0, N.Bb4,0,0,
  N.Cs5,0, 0,0, N.E5,0, N.G5,0,0,
  N.A5,0, 0,0, N.F5,0, N.D5,0,0,
  N.E5,0, 0,0, N.F5,0, 0,0,0,
];

const stCircleMel = [    // it climbs with the bass — D, E♭, E, F, G
  N.D5,0, 0,0, N.F5,0, 0,0,0,
  N.Eb5,0, 0,0, N.G5,0, 0,0,0,
  N.E5,0, 0,0, N.G5,0, 0,0,0,
  N.F5,0, 0,0, N.A5,0, 0,0,0,
  N.G5,0, 0,0, N.Bb5,0, 0,0,0,
  N.F5,0, 0,0, N.A5,0, N.C5,0,0,
  N.Eb5,0, 0,0, N.G5,0, N.Bb4,0,0,
  N.Cs5,0, 0,0, N.E5,0, N.G5,N.A5,0,
];

const stCloserMel = [    // brass
  N.D5,0, N.F5,0, N.A5,0, 0,0,0,
  N.Bb4,0, N.G5,0, N.E5,0, N.Cs5,0,0,
  N.D5,0, N.A5,0, N.F5,0, N.D5,0,0,
  N.Eb5,0, N.G5,0, N.Bb5,0, 0,0,0,
  N.A5,0, N.F5,0, N.D5,0, N.A4,0,0,
  N.Bb4,0, N.Cs5,0, N.F5,0, N.Bb5,0,0,
  N.A5,0, N.G5,0, N.E5,0, N.Cs5,0,0,
  N.E5,0, N.Cs5,0, N.A4,0, 0,0,0,
];

const stPounceMel = [
  N.D5,0,0, N.F5,0,0, N.A5,0,0,
  N.A5,0,0, N.G5,0,0, N.F5,0,0,
  N.G5,0,0, N.D5,0,0, N.Bb4,0,0,
  N.D5,0,0, N.F5,0,0, N.G5,0,0,
  N.Bb5,0,0, N.A5,0,0, N.F5,0,0,
  N.G5,0,0, N.E5,0,0, N.Cs5,0,0,
  N.D5,0,0, N.A5,0,0, N.F5,0,0,
  N.E5,0,0, N.Cs5,0,0, N.A4,0,0,
];

const stLostMel = [       // four notes in ten seconds
  N.A5,0, 0,0, 0,0, 0,0,0,
  0,0, 0,0, N.Eb5,0, 0,0,0,
  0,0, N.D5,0, 0,0, 0,0,0,
  0,0, 0,0, 0,0, N.Bb4,0,0,
];

const stCloseMel = [
  N.D5,0, 0,0, N.D5,0, N.F5,0,0,
  N.F5,0, 0,0, N.E5,0, N.D5,0,0,
  N.Eb5,0, 0,0, N.Eb5,0, N.G5,0,0,
  N.G5,0, 0,0, N.F5,0, N.Eb5,0,0,
  N.F5,0, 0,0, N.Bb5,0, N.A5,0,0,
  N.G5,0, 0,0, N.Bb5,0, N.G5,0,0,
  N.A5,0, 0,0, N.G5,0, N.E5,0,0,
  N.Cs5,0, N.E5,0, N.G5,0, N.A5,0,0,
];

const stStrikeMel = [
  N.A5,0, N.F5,0, N.D5,0, N.A5,0,0,
  N.Bb5,0, N.G5,0, N.Eb5,0, N.Bb5,0,0,
  N.A5,0, N.D5,0, N.F5,0, N.A5,0,0,
  N.Bb5,0, N.G5,0, N.E5,0, N.Cs5,0,0,
  N.D5,0, N.F5,0, N.Bb5,0, N.A5,0,0,
  N.G5,0, N.D5,0, N.Bb4,0, N.G5,0,0,
  N.A5,0, N.G5,0, N.E5,0, N.Cs5,0,0,
  N.D5,0, N.F5,0, N.A5,0, N.D5,0,0,
];
const stStrikeAlt = [
  N.D4,0, 0,0, N.A4,0, 0,0,0,
  N.Eb4,0, 0,0, N.Bb4,0, 0,0,0,
  N.D4,0, 0,0, N.A4,0, 0,0,0,
  N.E4,0, 0,0, N.Bb4,0, 0,0,0,
  N.F4,0, 0,0, N.D4,0, 0,0,0,
  N.G4,0, 0,0, N.Bb4,0, 0,0,0,
  N.E4,0, 0,0, N.Cs4,0, 0,0,0,
  N.D4,0, 0,0, N.A4,0, 0,0,0,
];

const stAfterMel = [
  N.F5,0, 0,0, N.D5,0, 0,0,0,
  N.Eb5,0, 0,0, 0,0, 0,0,0,
  N.Cs5,0, 0,0, 0,0, 0,0,0,
  N.D5,0, 0,0, 0,0, 0,0,0,
];

const songStalker = [
  // Something is out there and that is all you know.
  { section: "distant", fig: "drone", bpm: 104, riff: stDistant,
    prog: [CH.Dmin, CH.Dmin, CH.Ebmaj, CH.Dmin],
    mel3: stPing5, drums: "none", sus: 9, bassDur: 8, arpDur: 3, ring3: 5,
    voice: { chord: "organ", arp: "guitar", lead3: "bell" },
    vel: { chord: 0.026, arp: 0.04, bass: 0.2, lead3: 0.045 } },

  // It has a gait.
  { section: "track", fig: "creep", bpm: 112, riff: stTrack,
    prog: [CH.Dmin, CH.Dmin, CH.Ebmaj, CH.A7, CH.Dmin, CH.Bbmaj, CH.Gmin, CH.A7],
    mel3: stPing5b, drums: "stalk", drumV: 0.8, sus: 6, bassDur: 3, arpDur: 1.6, ring3: 5,
    voice: { chord: "organ", arp: "guitar", lead3: "bell" },
    vel: { chord: 0.026, arp: 0.046, bass: 0.2, lead3: 0.045 } },

  // A fourth now, and something thin and high above it.
  { section: "nearer", fig: "creep", bpm: 112, riff: stNearer,
    prog: [CH.Dmin, CH.Ebmaj, CH.Dmin, CH.Cmaj, CH.Bbmaj, CH.A7, CH.Dmin, CH.Dmin],
    mel: stNearerMel, mel3: stPing4, drums: "stalk", sus: 6, bassDur: 3, arpDur: 1.6, ring3: 4,
    voice: { chord: "organ", lead: "flute", arp: "guitar", lead3: "bell" },
    vel: { chord: 0.026, lead: 0.07, arp: 0.046, bass: 0.2, lead3: 0.042 } },

  // Circling: the bass walks D, E♭, E, F and the tune walks with it.
  { section: "circle", fig: "circle", bpm: 118, riff: stCircle,
    prog: [CH.Dmin, CH.Ebmaj, CH.Em7b5, CH.Fmaj, CH.Gmin, CH.Fmaj, CH.Ebmaj, CH.A7],
    mel: stCircleMel, mel3: stPing4, drums: "stalk", sus: 4, bassDur: 2, arpDur: 1.4, ring3: 4,
    voice: { chord: "keys", lead: "pluck", arp: "guitar", lead3: "bell" },
    vel: { chord: 0.03, lead: 0.06, arp: 0.046, bass: 0.2, lead3: 0.042 } },

  // A minor third, and the brass arrives.
  { section: "closer", fig: "press", bpm: 118, riff: stCloser,
    prog: [CH.Dmin, CH.Csdim, CH.Dmin, CH.Ebmaj, CH.Dmin, CH.Bbmin, CH.A7, CH.A7],
    mel: stCloserMel, mel3: stPing3, drums: "prowl", sus: 3, bassDur: 1.2, arpDur: 1.1, ring3: 3,
    voice: { chord: "keys", lead: "brass", arp: "guitar", lead3: "bell" },
    vel: { chord: 0.03, lead: 0.078, arp: 0.046, bass: 0.2, lead3: 0.04 } },

  // Three-three-three. The limp becomes a gallop.
  { section: "pounce", fig: "roll", heads: [0, 3, 6], bpm: 126, riff: stPounce,
    prog: [CH.Dmin, CH.Dmin, CH.Gmin, CH.Gmin, CH.Bbmaj, CH.A7, CH.Dmin, CH.A7],
    mel: stPounceMel, mel3: stPing3, drums: "nine3", sus: 2.6, bassDur: 1, arpDur: 0.9, ring3: 3,
    voice: { chord: "keys", lead: "brass", arp: "guitar", lead3: "bell" },
    vel: { chord: 0.03, lead: 0.082, arp: 0.044, bass: 0.2, lead3: 0.04 } },

  // It loses you. The interval opens back out, and almost nothing plays.
  { section: "lost", fig: "drone", bpm: 110, riff: stLost,
    prog: [CH.Dmin, CH.Ebmaj, CH.Dmin, CH.Em7b5],
    mel: stLostMel, mel3: stPingLost, drums: "none", sus: 9, bassDur: 8, arpDur: 3,
    ring: 8, ring3: 6,
    voice: { chord: "organ", lead: "flute", arp: "guitar", lead3: "bell" },
    vel: { chord: 0.024, lead: 0.065, arp: 0.038, bass: 0.19, lead3: 0.04 } },

  // A whole tone.
  { section: "close", fig: "press", bpm: 122, riff: stClose,
    prog: [CH.Dmin, CH.Dmin, CH.Ebmaj, CH.Ebmaj, CH.Bbmaj, CH.Csdim, CH.A7, CH.A7],
    mel: stCloseMel, mel3: stPing2, drums: "prowl", sus: 3, bassDur: 1.2, arpDur: 1.1, ring3: 2.6,
    voice: { chord: "keys", lead: "brass", arp: "guitar", lead3: "bell" },
    vel: { chord: 0.03, lead: 0.08, arp: 0.046, bass: 0.2, lead3: 0.038 } },

  // A semitone.
  { section: "strike", fig: "strike", bpm: 128, riff: stStrike,
    prog: [CH.Dmin, CH.Ebmaj, CH.Dmin, CH.Csdim, CH.Bbmaj, CH.Gmin, CH.A7, CH.Dmin],
    mel: stStrikeMel, mel2: stStrikeAlt, mel3: stPing1,
    drums: "prowl", sus: 2.6, bassDur: 1, arpDur: 0.9, ring2: 4, ring3: 2,
    voice: { chord: "keys", lead: "brass", arp: "guitar", lead2: "pluck", lead3: "bell" },
    vel: { chord: 0.032, lead: 0.085, arp: 0.048, bass: 0.2, lead2: 0.04, lead3: 0.036 } },

  // Going away. Not gone.
  { section: "after", fig: "drone", bpm: 104, riff: stAfter,
    prog: [CH.Dmin, CH.Ebmaj, CH.Csdim, CH.Dmin],
    mel: stAfterMel, mel3: stPingGone, drums: "none", sus: 9, bassDur: 8, arpDur: 2.6,
    ring: 8, ring3: 5,
    voice: { chord: "organ", lead: "flute", arp: "guitar", lead3: "bell" },
    vel: { chord: 0.026, lead: 0.06, arp: 0.038, bass: 0.19, lead3: 0.042 } },
].map((s) => stSect({ ...s, song: "stalker" }));

const TRACKS = {
  title: [...songFirstLight, ...songWaltz, ...songHymn],
  lobby: [...songStillWater, ...songQuietHours, ...songLongWatch],
  game:  [...songIronHeart, ...songFrontline, ...songStalker],
};

// --- instrument voices (all routed to music.gain) ---

// FM electric piano / tine: a sine carrier shaped by a sine modulator
// whose index decays, giving a struck-key attack that settles into a
// warm, harmonic tone. The harmonic heart of every track.
function mKeys(when, freq, dur, vel, ratio = 1, index = 2.2) {
  const car = ctx.createOscillator(); car.type = "sine"; car.frequency.value = freq;
  const mod = ctx.createOscillator(); mod.type = "sine"; mod.frequency.value = freq * ratio;
  const md = ctx.createGain();
  md.gain.setValueAtTime(freq * index, when);
  md.gain.exponentialRampToValueAtTime(Math.max(1, freq * index * 0.04), when + dur * 0.55);
  mod.connect(md).connect(car.frequency);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, when);
  g.gain.exponentialRampToValueAtTime(vel, when + 0.006);
  g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
  car.connect(g).connect(music.gain);
  mod.start(when); car.start(when);
  mod.stop(when + dur + 0.05); car.stop(when + dur + 0.05);
}

// Warm round bass: a triangle with a sine sub through a gentle lowpass —
// full and woody, not a buzzy saw.
function mBass(when, freq, dur, vel = 0.2) {
  const o = ctx.createOscillator(); o.type = "triangle"; o.frequency.value = freq;
  const sub = ctx.createOscillator(); sub.type = "sine"; sub.frequency.value = freq;
  const sg = ctx.createGain(); sg.gain.value = 0.7;
  const f = ctx.createBiquadFilter(); f.type = "lowpass"; f.Q.value = 0.7;
  f.frequency.setValueAtTime(Math.min(1400, freq * 5 + 200), when);
  f.frequency.exponentialRampToValueAtTime(Math.max(140, freq * 2.2), when + dur * 0.8);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, when);
  g.gain.exponentialRampToValueAtTime(vel, when + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
  o.connect(f); sub.connect(sg).connect(f); f.connect(g).connect(music.gain);
  o.start(when); sub.start(when);
  o.stop(when + dur + 0.03); sub.stop(when + dur + 0.03);
}

// Plucked string: a bright saw snapped through a fast-closing lowpass so
// it reads like a guitar/harp pluck. Carries the arps and counter-lines.
function mPluck(when, freq, dur, vel = 0.05) {
  const o = ctx.createOscillator(); o.type = "sawtooth"; o.frequency.value = freq;
  const f = ctx.createBiquadFilter(); f.type = "lowpass"; f.Q.value = 1.4;
  f.frequency.setValueAtTime(Math.min(7500, freq * 7), when);
  f.frequency.exponentialRampToValueAtTime(Math.max(220, freq * 1.6), when + dur * 0.5);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, when);
  g.gain.exponentialRampToValueAtTime(vel, when + 0.004);
  g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
  o.connect(f).connect(g).connect(music.gain);
  o.start(when); o.stop(when + dur + 0.03);
}

// DRAWBAR ORGAN: additive sine partials (the classic 1/2/3/4 drawbars)
// with a slow swell and a gentle rotary-speaker wobble. Sustains, so it
// holds a hymn's pads where the electric piano would decay away.
function mOrgan(when, freq, dur, vel = 0.05) {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, when);
  g.gain.exponentialRampToValueAtTime(vel, when + 0.09);       // soft swell in
  g.gain.setValueAtTime(vel, when + Math.max(0.1, dur - 0.18));
  g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
  const vib = ctx.createOscillator(); vib.type = "sine"; vib.frequency.value = 5.6;
  const vibD = ctx.createGain(); vibD.gain.value = 2.2;         // Hz of rotary wobble
  vib.connect(vibD);                    // ONCE — connecting inside the
                                        // partial loop below stacked four
                                        // parallel paths and quadrupled
                                        // the wobble depth.
  const parts = [[1, 1], [2, 0.5], [3, 0.28], [4, 0.16]];
  const oscs = [];
  for (const [mult, lvl] of parts) {
    const o = ctx.createOscillator(); o.type = "sine"; o.frequency.value = freq * mult;
    const lg = ctx.createGain(); lg.gain.value = lvl;
    vibD.connect(o.frequency);
    o.connect(lg).connect(g);
    o.start(when); o.stop(when + dur + 0.05);
    oscs.push(o);
  }
  vib.start(when); vib.stop(when + dur + 0.05);
  g.connect(music.gain);
}

// FLUTE / whistle: a mostly-pure sine with a breath of noise on top and
// a delayed vibrato, so a held note blooms rather than sitting static.
function mFlute(when, freq, dur, vel = 0.07) {
  const o = ctx.createOscillator(); o.type = "sine"; o.frequency.value = freq;
  const o2 = ctx.createOscillator(); o2.type = "triangle"; o2.frequency.value = freq * 2;
  const o2g = ctx.createGain(); o2g.gain.value = 0.08;          // faint octave shimmer
  const vib = ctx.createOscillator(); vib.type = "sine"; vib.frequency.value = 5.2;
  const vibD = ctx.createGain();
  vibD.gain.setValueAtTime(0.0001, when);                        // vibrato fades IN
  vibD.gain.exponentialRampToValueAtTime(Math.max(0.5, freq * 0.008), when + dur * 0.7);
  vib.connect(vibD).connect(o.frequency);
  const air = ctx.createBufferSource(); air.buffer = getNoise(); air.loop = true;
  const airF = ctx.createBiquadFilter(); airF.type = "bandpass";
  airF.frequency.value = Math.min(6000, freq * 3); airF.Q.value = 0.8;
  const airG = ctx.createGain(); airG.gain.value = vel * 0.16;   // breath
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, when);
  g.gain.exponentialRampToValueAtTime(vel, when + 0.07);         // soft attack
  g.gain.setValueAtTime(vel, when + Math.max(0.08, dur - 0.14));
  g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
  o.connect(g); o2.connect(o2g).connect(g);
  air.connect(airF).connect(airG).connect(g);
  g.connect(music.gain);
  o.start(when); o2.start(when); vib.start(when); air.start(when);
  const end = when + dur + 0.05;
  o.stop(end); o2.stop(end); vib.stop(end); air.stop(end);
}

// ACOUSTIC/TWANG GUITAR. This used to be a true Karplus-Strong string: a
// noise burst fired into a delay line with ~0.96 feedback. That's a
// RESONATOR, and its output ran at unity gain (only the exciter was
// scaled by velocity), so a bar with sixteen overlapping notes stacked
// sixteen full-scale resonators — which clipped into a piercing,
// fire-alarm squeal. Rebuilt WITHOUT any feedback: a detuned saw pair
// plus a noise-burst "pick" through a fast-closing filter. Still reads
// as a plucked string, but it can never run away or self-oscillate.
function mGuitar(when, freq, dur, vel = 0.05, bright = 1) {
  const a = ctx.createOscillator(); a.type = "sawtooth"; a.frequency.value = freq;
  const b = ctx.createOscillator(); b.type = "triangle"; b.frequency.value = freq;
  b.detune.value = -6;                                    // a touch of string chorus
  const bg = ctx.createGain(); bg.gain.value = 0.6;
  const f = ctx.createBiquadFilter(); f.type = "lowpass"; f.Q.value = 1.1;
  f.frequency.setValueAtTime(Math.min(6000, freq * 6 * bright), when);
  f.frequency.exponentialRampToValueAtTime(Math.max(200, freq * 1.5), when + dur * 0.55);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, when);
  g.gain.exponentialRampToValueAtTime(vel, when + 0.005);  // the pick
  g.gain.exponentialRampToValueAtTime(0.0001, when + dur); // string decay
  // A whisper of pick noise at the very start, gone in 25 ms.
  const pick = ctx.createBufferSource(); pick.buffer = getNoise();
  const pf = ctx.createBiquadFilter(); pf.type = "bandpass";
  pf.frequency.value = Math.min(5000, freq * 4); pf.Q.value = 0.9;
  const pg = ctx.createGain();
  pg.gain.setValueAtTime(vel * 0.5, when);
  pg.gain.exponentialRampToValueAtTime(0.0001, when + 0.025);
  pick.connect(pf).connect(pg).connect(g);
  a.connect(f); b.connect(bg).connect(f); f.connect(g).connect(music.gain);
  a.start(when); b.start(when); pick.start(when);
  const end = when + dur + 0.03;
  a.stop(end); b.stop(end); pick.stop(when + 0.05);
}

// BELL / glockenspiel: FM with an INHARMONIC ratio, which is what makes
// metal sound like metal. Short strike, long shimmering tail.
function mBell(when, freq, dur, vel = 0.06) {
  const car = ctx.createOscillator(); car.type = "sine"; car.frequency.value = freq;
  const mod = ctx.createOscillator(); mod.type = "sine"; mod.frequency.value = freq * 1.41; // √2: inharmonic
  const md = ctx.createGain();
  md.gain.setValueAtTime(freq * 0.9, when); // was 1.6 — very wide inharmonic sidebands
  md.gain.exponentialRampToValueAtTime(Math.max(1, freq * 0.05), when + dur * 0.35);
  mod.connect(md).connect(car.frequency);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, when);
  g.gain.exponentialRampToValueAtTime(vel, when + 0.004);        // hard strike
  g.gain.exponentialRampToValueAtTime(0.0001, when + dur);        // long tail
  car.connect(g).connect(music.gain);
  car.start(when); mod.start(when);
  car.stop(when + dur + 0.05); mod.stop(when + dur + 0.05);
}

// BRASS section: two detuned saws behind a filter that snaps open and
// settles back — the "blat" that reads as a horn stab.
function mBrass(when, freq, dur, vel = 0.06) {
  const a = ctx.createOscillator(); a.type = "sawtooth"; a.frequency.value = freq;
  const b = ctx.createOscillator(); b.type = "sawtooth"; b.frequency.value = freq;
  b.detune.value = 8;                                            // section width
  const f = ctx.createBiquadFilter(); f.type = "lowpass"; f.Q.value = 1.0; // was 3.2 — a resonant peak that far up screamed
  f.frequency.setValueAtTime(Math.max(200, freq * 1.2), when);
  f.frequency.exponentialRampToValueAtTime(Math.min(3200, freq * 4), when + 0.05); // the blat, ceiling lowered
  f.frequency.exponentialRampToValueAtTime(Math.min(1900, freq * 2.4), when + dur * 0.7);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, when);
  g.gain.exponentialRampToValueAtTime(vel, when + 0.02);
  g.gain.setValueAtTime(vel, when + Math.max(0.03, dur - 0.1));
  g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
  a.connect(f); b.connect(f); f.connect(g).connect(music.gain);
  a.start(when); b.start(when);
  a.stop(when + dur + 0.03); b.stop(when + dur + 0.03);
}

// One dispatcher so a track can name its instruments.
function playVoice(name, when, freq, dur, vel) {
  switch (name) {
    case "organ":  return mOrgan(when, freq, dur, vel);
    case "flute":  return mFlute(when, freq, dur, vel);
    case "guitar": return mGuitar(when, freq, dur, vel);
    case "bell":   return mBell(when, freq, dur, vel);
    case "brass":  return mBrass(when, freq, dur, vel);
    case "pluck":  return mPluck(when, freq, dur, vel);
    case "bass":   return mBass(when, freq, dur, vel);
    default:       return mKeys(when, freq, dur, vel);
  }
}

// --- drum voices (v scales level so light/soft sections sit back) ---
function drumKick(when, v = 1) {
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = "sine";
  o.frequency.setValueAtTime(140, when);
  o.frequency.exponentialRampToValueAtTime(45, when + 0.11);
  g.gain.setValueAtTime(0.42 * v, when);
  g.gain.exponentialRampToValueAtTime(0.0001, when + 0.16);
  o.connect(g).connect(music.gain);
  o.start(when); o.stop(when + 0.18);
}
function drumSnare(when, v = 1) {
  const src = ctx.createBufferSource();
  src.buffer = getNoise();
  const bp = ctx.createBiquadFilter();
  bp.type = "bandpass"; bp.frequency.value = 1900; bp.Q.value = 0.8;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.2 * v, when);
  g.gain.exponentialRampToValueAtTime(0.0001, when + 0.14);
  src.connect(bp).connect(g).connect(music.gain);
  src.start(when); src.stop(when + 0.16);
  const o = ctx.createOscillator(); // a little tonal body
  const g2 = ctx.createGain();
  o.type = "triangle"; o.frequency.setValueAtTime(210, when);
  o.frequency.exponentialRampToValueAtTime(150, when + 0.09);
  g2.gain.setValueAtTime(0.1 * v, when);
  g2.gain.exponentialRampToValueAtTime(0.0001, when + 0.1);
  o.connect(g2).connect(music.gain);
  o.start(when); o.stop(when + 0.12);
}
function drumHat(when, open, v = 1) {
  const src = ctx.createBufferSource();
  src.buffer = getNoise();
  const hp = ctx.createBiquadFilter();
  hp.type = "highpass"; hp.frequency.value = 8500;
  const g = ctx.createGain();
  const dur = open ? 0.09 : 0.032;
  g.gain.setValueAtTime((open ? 0.05 : 0.045) * v, when);
  g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
  src.connect(hp).connect(g).connect(music.gain);
  src.start(when); src.stop(when + dur + 0.02);
}
// A wire BRUSH on the snare head: darker and longer than a stick hit, so
// the waltz breathes instead of cracking.
function drumBrush(when, v = 1) {
  const src = ctx.createBufferSource();
  src.buffer = getNoise();
  const lp = ctx.createBiquadFilter();
  lp.type = "lowpass"; lp.frequency.value = 2600; lp.Q.value = 0.5;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.055 * v, when);
  g.gain.exponentialRampToValueAtTime(0.0001, when + 0.17);
  src.connect(lp).connect(g).connect(music.gain);
  src.start(when); src.stop(when + 0.2);
}
// A marching TOM for the march's rolls and pickups.
function drumTom(when, freq = 150, v = 1) {
  const o = ctx.createOscillator();
  o.type = "triangle";
  o.frequency.setValueAtTime(freq, when);
  o.frequency.exponentialRampToValueAtTime(freq * 0.62, when + 0.13);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.16 * v, when);
  g.gain.exponentialRampToValueAtTime(0.0001, when + 0.16);
  o.connect(g).connect(music.gain);
  o.start(when); o.stop(when + 0.18);
}

function scheduleStep(step, when) {
  const tr = TRACKS[music.mode][music.trackIdx];
  const STEP = 60 / tr.bpm / 2;
  // Steps per BAR: 8 for common time (4 beats × 2), 6 for a 3/4 waltz
  // (3 beats × 2). Everything rhythmic keys off this, so a track can
  // change metre without touching the scheduler.
  const meter = tr.meter ?? 8;
  const pos = step % meter;
  // Where we are in the SECTION, not just the bar — so a kit can put a
  // fill in the last bar and a figure can know it's the turnaround.
  const total = tr.bass ? tr.bass.length : 0;
  const bar = Math.floor(step / meter);
  const fill = total > meter && step >= total - meter;
  const dv = tr.drumV ?? 1;                        // per-section kit level
  // Which instrument plays what, and how hard. Defaults reproduce the
  // original electric-piano trio exactly, so older tracks are untouched.
  const V = tr.voice ?? {};
  const vel = tr.vel ?? {};
  const chordVoice = V.chord ?? "keys";
  const leadVoice = V.lead ?? "keys";
  const arpVoice = V.arp ?? "pluck";

  // Harmony — a struck/held chord, left to ring under everything.
  const ch = tr.chords ? tr.chords[step % tr.chords.length] : 0;
  if (ch) {
    const dur = STEP * (tr.sus ?? 6);
    const v = vel.chord ?? 0.04;
    for (const n of ch) if (n) playVoice(chordVoice, when, n, dur, v);
  }
  // Melody — the line that sings. If the track supplied `melDur` (see
  // `phrase()`), every note lasts until the next one instead of a flat
  // 3.4 steps: quick runs come out crisp, held notes actually hold.
  const m = tr.mel ? tr.mel[step % tr.mel.length] : 0;
  if (m) {
    const d = tr.melDur ? tr.melDur[step % tr.melDur.length] : (tr.lead ?? 3.4);
    playVoice(leadVoice, when, m, STEP * d, vel.lead ?? 0.1);
  }
  // A SECOND melodic line — counter-melody, harmony, or a doubling in a
  // different timbre. Only tracks that define `mel2` have one, so every
  // existing song is untouched.
  const m2 = tr.mel2 ? tr.mel2[step % tr.mel2.length] : 0;
  if (m2) {
    const d = tr.mel2Dur ? tr.mel2Dur[step % tr.mel2Dur.length] : (tr.lead ?? 3.4);
    playVoice(V.lead2 ?? leadVoice, when, m2, STEP * d, vel.lead2 ?? 0.05);
  }
  // A THIRD line. Two melodies and a bass is already a full texture, but
  // a canon needs its answer AND whatever was going on underneath both.
  const m3 = tr.mel3 ? tr.mel3[step % tr.mel3.length] : 0;
  if (m3) {
    const d = tr.mel3Dur ? tr.mel3Dur[step % tr.mel3Dur.length] : (tr.lead ?? 3.4);
    playVoice(V.lead3 ?? leadVoice, when, m3, STEP * d, vel.lead3 ?? 0.04);
  }
  // Bass — warm and round.
  const b = tr.bass ? tr.bass[step % tr.bass.length] : 0;
  if (b) mBass(when, b, STEP * (tr.bassDur ?? 1.5), vel.bass ?? 0.2);
  // Counter-line. `groove` leans on the strong eighths and eases off the
  // weak ones, which is the difference between a part being played and a
  // part being clocked out.
  const a = tr.arp ? tr.arp[step % tr.arp.length] : 0;
  if (a) {
    const acc = tr.accent ?? ACCENT;
    const av = (vel.arp ?? 0.048) * (tr.groove ? acc[pos % acc.length] : 1);
    playVoice(arpVoice, when, a, STEP * (tr.arpDur ?? 0.95), av);
  }

  // Drums.
  const kit = tr.drums ?? "none";
  if (kit === "full") {
    if (pos === 0 || pos === 4) drumKick(when);   // beats 1 & 3
    if (pos === 2 || pos === 6) drumSnare(when);   // backbeat 2 & 4
    drumHat(when, pos === 7);                       // steady 8ths, open on the & of 4
  } else if (kit === "light") {
    if (pos === 0) drumKick(when, 0.8);
    if (pos === 4) drumSnare(when, 0.55);
    if (pos % 2 === 0) drumHat(when, false, 0.7);   // hats on the beats
  } else if (kit === "swell") {
    if (pos === 0) drumKick(when, 0.6 * dv);         // a soft heartbeat on each downbeat
  } else if (kit === "timp") {
    // Not a kit so much as a pair of TIMPANI, tuned to F and C, under a
    // church-soft kick. A hymn doesn't want a backbeat; it wants the
    // floor to move when the harmony does.
    if (pos === 0) drumKick(when, 0.5 * dv);
    if (pos === 0 && bar % 2 === 0) drumTom(when, 87, 0.8 * dv);   // F
    if (pos === 4 && bar % 4 === 3) drumTom(when, 131, 0.55 * dv); // C
    if (fill && pos >= 4) drumTom(when, pos % 2 ? 98 : 87, 0.5 * dv);
  } else if (kit === "waltz") {
    // ONE-two-three: kick on the downbeat, brushes on 2 and 3.
    if (pos === 0) drumKick(when, 0.62 * dv);
    if (pos === 2 || pos === 4) drumBrush(when, (pos === 2 ? 0.9 : 0.75) * dv);
  } else if (kit === "sway") {
    // The same waltz, softer and looser: hats breathing on the "ands" and
    // a ghost kick before the third beat every second bar.
    if (pos === 0) drumKick(when, 0.72 * dv);
    if (pos === 3 && bar % 2 === 1) drumKick(when, 0.34 * dv);
    if (pos === 2) drumBrush(when, 0.6 * dv);
    if (pos === 4) drumBrush(when, 0.88 * dv);
    if (pos % 2 === 1) drumHat(when, false, 0.24 * dv);
    if (fill && pos >= 3) drumTom(when, 200 - (pos - 3) * 26, 0.5 * dv);
  } else if (kit === "watch") {
    // Twelve-eight: a step on the first and third beats, and a low drum
    // tuned to D — the tonic — every second bar. Not a groove, a gait.
    if (pos === 0) drumKick(when, 0.5 * dv);
    if (pos === 6) drumKick(when, 0.34 * dv);
    if (pos === 0 && bar % 2 === 1) drumTom(when, 73, 0.5 * dv);
  } else if (kit === "hush") {
    // For five-four: a kick on the downbeat and a brush where the bar
    // splits, three beats in. Just enough to hear where the group falls.
    if (pos === 0) drumKick(when, 0.45 * dv);
    if (pos === 6) drumBrush(when, 0.3 * dv);
  } else if (kit === "tide") {
    // 6/8, barely there: a soft kick on the downbeat and a brush on the
    // second dotted beat. The rocking of the boat, and nothing else.
    if (pos === 0) drumKick(when, 0.5 * dv);
    if (pos === 3) drumBrush(when, 0.4 * dv);
    if (fill && pos === 5) drumBrush(when, 0.55 * dv);
  } else if (kit === "ball") {
    // Ballroom: sticks instead of brushes, a hat on every beat, and a tom
    // pickup at the end of each four-bar phrase.
    if (pos === 0) drumKick(when, dv);
    if (pos === 2) drumSnare(when, 0.6 * dv);
    if (pos === 4) drumSnare(when, 0.88 * dv);
    if (pos % 2 === 0) drumHat(when, pos === 4 && bar % 2 === 1, 0.7 * dv);
    if (pos === 5 && bar % 4 === 3) drumTom(when, 170, 0.6 * dv);
    if (fill) {
      if (pos === 2 || pos === 4) drumTom(when, pos === 2 ? 200 : 150, 0.85 * dv);
      if (pos === 3 || pos === 5) drumSnare(when, 0.5 * dv);
    }
  } else if (kit === "stalk") {
    // 9/8 as two-two-two-THREE: almost a four, and then it doesn't stop
    // when you expect it to. Sparse, because the track is mostly space.
    if (pos === 0) drumKick(when, dv);
    if (pos === 4) drumSnare(when, 0.85 * dv);
    if (pos === 6) drumKick(when, 0.7 * dv);
    if (pos % 2 === 0 && pos < 8) drumHat(when, pos === 6, 0.45 * dv);
    if (fill && pos >= 6) drumTom(when, 190 - (pos - 6) * 28, 0.7 * dv);
  } else if (kit === "prowl") {
    // The same nine with the gaps filled in.
    if (pos === 0) drumKick(when, dv);
    if (pos === 3) drumKick(when, 0.5 * dv);
    if (pos === 4) drumSnare(when, 0.95 * dv);
    if (pos === 6) drumKick(when, 0.8 * dv);
    if (pos === 8) drumSnare(when, 0.5 * dv);
    drumHat(when, pos === 8, (pos % 2 === 0 ? 0.8 : 0.5) * dv);
    if (fill && pos >= 5) drumTom(when, 200 - (pos - 5) * 22, 0.85 * dv);
  } else if (kit === "nine3") {
    // Regrouped three-three-three, and for eight bars it rolls.
    if (pos === 0 || pos === 6) drumKick(when, (pos === 0 ? 1 : 0.85) * dv);
    if (pos === 3) drumSnare(when, dv);
    if (pos === 8) drumSnare(when, 0.5 * dv);
    drumHat(when, pos === 8, (pos % 3 === 0 ? 0.85 : 0.5) * dv);
    if (fill && pos >= 5) drumTom(when, 210 - (pos - 5) * 24, 0.9 * dv);
  } else if (kit === "seven") {
    // 7/8 in two-two-THREE. A bar that's a beat short has to sound
    // deliberate or it sounds like a mistake: a kick on each group head,
    // the snare on the second, and the long group pushes into the next bar.
    if (pos === 0) drumKick(when, dv);
    if (pos === 4) drumKick(when, 0.85 * dv);
    if (pos === 2) drumSnare(when, 0.9 * dv);
    if (pos === 6) drumSnare(when, 0.5 * dv);
    drumHat(when, pos === 6, (pos % 2 === 0 ? 0.85 : 0.5) * dv);
    if (fill && pos >= 4) drumTom(when, 200 - (pos - 4) * 30, 0.8 * dv);
  } else if (kit === "seven3") {
    // The same seven beats regrouped THREE-two-two, and the kit has to
    // move with the riff or the two of them are in different bars.
    if (pos === 0) drumKick(when, dv);
    if (pos === 5) drumKick(when, 0.8 * dv);
    if (pos === 3) drumSnare(when, 0.9 * dv);
    drumHat(when, pos === 6, (pos === 0 || pos === 3 || pos === 5 ? 0.85 : 0.5) * dv);
    if (fill && pos >= 3) drumTom(when, 200 - (pos - 3) * 24, 0.8 * dv);
  } else if (kit === "siege") {
    // One kick, one snare, and a long way between them.
    if (pos === 0) drumKick(when, dv);
    if (pos === 4) drumSnare(when, dv);
    if (pos === 0 || pos === 2 || pos === 4) drumHat(when, pos === 4, 0.6 * dv);
    if (fill && pos >= 4) drumTom(when, 190 - (pos - 4) * 26, 0.9 * dv);
  } else if (kit === "line") {
    // Four on the floor: the bar stops limping and plants itself.
    if (pos % 2 === 0) drumKick(when, (pos === 0 ? 1 : 0.8) * dv);
    if (pos === 2 || pos === 6) drumSnare(when, 0.95 * dv);
    drumHat(when, pos === 7, (pos % 2 === 1 ? 0.7 : 0.4) * dv);
    if (fill && pos >= 4) drumTom(when, 210 - (pos - 4) * 26, 0.85 * dv);
  } else if (kit === "race") {
    if (pos % 2 === 0) drumKick(when, (pos === 0 ? 1 : 0.75) * dv);
    if (pos === 2 || pos === 6) drumSnare(when, dv);
    if (pos === 5) drumSnare(when, 0.45 * dv);
    drumHat(when, false, (pos % 2 === 0 ? 0.9 : 0.6) * dv);
    if (fill && pos >= 4) drumTom(when, 220 - (pos - 4) * 28, 0.9 * dv);
  } else if (kit === "heartbeat") {
    // The doubled kick on its own — lub-dub, an eighth apart, which at
    // combat tempo is about the interval of a real heart.
    if (pos === 0) drumKick(when, 0.9 * dv);
    if (pos === 1) drumKick(when, 0.5 * dv);
    if (pos === 4) drumKick(when, 0.7 * dv);
    if (pos % 2 === 0) drumHat(when, false, 0.35 * dv);
  } else if (kit === "heart") {
    // The same heart with a kit around it.
    if (pos === 0) drumKick(when, dv);
    if (pos === 1) drumKick(when, 0.55 * dv);
    if (pos === 4) drumKick(when, 0.85 * dv);
    if (pos === 5 && bar % 2 === 1) drumKick(when, 0.5 * dv);
    if (pos === 2 || pos === 6) drumSnare(when, 0.9 * dv);
    drumHat(when, pos === 7, (pos % 2 === 0 ? 0.9 : 0.55) * dv);
    if (fill && pos >= 4) drumTom(when, 210 - (pos - 4) * 26, 0.8 * dv);
  } else if (kit === "halftime") {
    // Backbeat on three instead of two and four: the bar feels twice as
    // long without the tempo changing much.
    if (pos === 0) drumKick(when, dv);
    if (pos === 1) drumKick(when, 0.5 * dv);
    if (pos === 4) drumSnare(when, dv);
    if (pos % 2 === 0) drumHat(when, pos === 6, 0.7 * dv);
    if (fill && pos >= 5) drumTom(when, 200 - (pos - 5) * 30, 0.85 * dv);
  } else if (kit === "march") {
    // Marching band: kick on 1 and 3, a crisp snare backbeat with the
    // ghosted double that gives a march its roll, and toms for the
    // pickup into the next bar. No hats — bands don't have them.
    if (pos === 0 || pos === 4) drumKick(when, 1);
    if (pos === 2 || pos === 6) drumSnare(when, 0.85);
    if (pos === 3 || pos === 7) drumSnare(when, 0.3);   // ghost roll
    if (pos === 7) drumTom(when, 165, 0.7);              // pickup
  } else if (kit === "brush") {
    // Title-theme kit. A soft kick, wire brushes on the backbeat, hats
    // whispering the offbeats, and a push on the "&" of three every
    // second bar so it breathes instead of marching.
    if (pos === 0) drumKick(when, 0.7 * dv);
    if (pos === 5 && bar % 2 === 1) drumKick(when, 0.42 * dv);
    if (pos === 2) drumBrush(when, 0.6 * dv);
    if (pos === 6) drumBrush(when, 0.9 * dv);
    if (pos % 2 === 1) drumHat(when, false, 0.3 * dv);
    if (fill && pos >= 5) drumTom(when, 190 - (pos - 5) * 28, 0.5 * dv);
  } else if (kit === "push") {
    // 3 + 3 + 2 — the bar leans forward, which is what a pre-chorus is
    // for. The last bar hands over with a tom roll.
    if (pos === 0 || pos === 3 || pos === 6) drumKick(when, (pos === 0 ? 0.95 : 0.66) * dv);
    if (pos === 2 || pos === 6) drumSnare(when, 0.7 * dv);
    if (pos % 2 === 1) drumHat(when, pos === 7, 0.5 * dv);
    if (fill && pos >= 4) drumTom(when, 210 - (pos - 4) * 24, 0.65 * dv);
  } else if (kit === "anthem") {
    // The chorus kit: everything the full kit does, plus an open hat to
    // open the section, a kick anticipating the bar line every second
    // bar, and a proper fill on the way out.
    if (step === 0) drumHat(when, true, 1.2 * dv);
    if (pos === 0 || pos === 4) drumKick(when, dv);
    if (pos === 7 && bar % 2 === 1) drumKick(when, 0.6 * dv);
    if (pos === 2 || pos === 6) drumSnare(when, 0.92 * dv);
    drumHat(when, pos === 7, (pos % 2 === 0 ? 0.95 : 0.6) * dv);
    if (fill) {
      if (pos === 4 || pos === 6) drumTom(when, pos === 4 ? 200 : 160, 0.8 * dv);
      if (pos === 5 || pos === 7) drumSnare(when, 0.55 * dv);
    }
  } else if (kit === "shuffle") {
    // Swung: the offbeat lands late (on the third 16th), which is the
    // whole feel. Approximated by putting the hat on 1 and 3 of each
    // beat-pair and leaning the snare hard on the backbeat.
    if (pos === 0 || pos === 3 || pos === 4) drumKick(when, pos === 3 ? 0.55 : 0.95);
    if (pos === 2 || pos === 6) drumSnare(when, 0.9);
    if (pos % 2 === 1) drumHat(when, pos === 7, 0.8);    // swung offbeat hats
  }
}

// Where a mode begins: a random SONG, started at its first section so a
// song is never joined halfway through its arrangement.
function startIdx(mode) {
  const pool = TRACKS[mode] ?? [];
  if (!pool.length) return 0;
  const songs = [...new Set(pool.map((t) => t.song ?? 0))];
  const pick = songs[Math.floor(Math.random() * songs.length)];
  const i = pool.findIndex((t) => (t.song ?? 0) === pick);
  return i < 0 ? 0 : i;
}

export function startMusic(mode = "game") {
  if (!ensure()) return;
  if (!TRACKS[mode]) mode = "game";
  if (music) {
    if (music.mode === mode) return;
    // Swap themes in place: new pattern from the top of the bar.
    music.mode = mode;
    music.trackIdx = startIdx(mode);
    music.step = 0;
    music.loops = 0;
    return;
  }
  try {
    const gain = ctx.createGain();
    gain.gain.value = 0.55;
    // SAFETY LIMITER. Music is many independent voices summing freely; a
    // busy bar could previously stack into clipping, which is what turns
    // a chord into a piercing squeal. This catches any such peak before
    // it reaches the bus, so no arrangement can ever shriek again.
    const lim = ctx.createDynamicsCompressor();
    lim.threshold.value = -14;
    lim.knee.value = 6;
    lim.ratio.value = 12;
    lim.attack.value = 0.004;
    lim.release.value = 0.18;
    // ...and roll off the very top, where "alarm" lives.
    const tame = ctx.createBiquadFilter();
    tame.type = "lowpass";
    tame.frequency.value = 7000;
    tame.Q.value = 0.5;
    gain.connect(lim).connect(tame).connect(musicBus);
    music = {
      gain, timer: 0, nextAt: 0, step: 0, loops: 0,
      mode, trackIdx: startIdx(mode),
    };
    music.timer = setInterval(() => {
      if (!ready() || !music) return;
      if (!music.nextAt) music.nextAt = ctx.currentTime + 0.1;
      // CATCH-UP GUARD. setInterval is throttled hard when a tab is
      // backgrounded or the window is minimised (very common on desktop),
      // and the AudioContext clock keeps running. Without this, the loop
      // below would try to "catch up" the whole missed stretch at once:
      // every step whose time is already in the PAST fires the instant
      // it's scheduled, so a few seconds away = hundreds of notes landing
      // simultaneously — a wall of sound that clips into a piercing
      // squeal. If we've fallen behind, just resume from NOW instead.
      if (music.nextAt < ctx.currentTime) music.nextAt = ctx.currentTime + 0.05;
      // Belt and braces: never schedule more than a sensible burst in one
      // tick, whatever the clock says.
      let guard = 0;
      while (music.nextAt < ctx.currentTime + 0.35 && guard++ < 24) {
        const tr = TRACKS[music.mode][music.trackIdx];
        scheduleStep(music.step, music.nextAt);
        music.nextAt += 60 / tr.bpm / 2;
        music.step += 1;
        if (music.step >= tr.bass.length) {
          music.step = 0;
          music.loops += 1;
          const pool = TRACKS[music.mode];
          // EVERY mode now holds several SONGS, each split into sections.
          // Walk the current song's sections in order; when the last one
          // finishes, move to a DIFFERENT song and start it from the top.
          // A song therefore plays as a whole arrangement — intro through
          // outro — instead of one bar looping until you leave the screen.
          {
            const cur = pool[music.trackIdx] ?? {};
            const nextIdx = music.trackIdx + 1;
            if (nextIdx < pool.length && (pool[nextIdx].song ?? 0) === (cur.song ?? 0)) {
              music.trackIdx = nextIdx;          // next section, same song
            } else {
              const songs = [...new Set(pool.map((t) => t.song ?? 0))];
              let pick = cur.song ?? 0;
              if (songs.length > 1) {
                while (pick === (cur.song ?? 0)) pick = songs[Math.floor(Math.random() * songs.length)];
              }
              const i = pool.findIndex((t) => (t.song ?? 0) === pick);
              music.trackIdx = i < 0 ? 0 : i;
            }
            music.loops = 0;
          }
        }
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
  if (flame && ctx) {
    try { flame.gain.gain.setTargetAtTime(0, ctx.currentTime, 0.1); } catch (e) {}
  }
}
