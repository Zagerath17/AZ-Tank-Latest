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
  C2: 65.41, D2: 73.42, E2: 82.41, F2: 87.31, G2: 98.00, A2: 110.00, Bb2: 116.54, B2: 123.47,
  C3: 130.81, D3: 146.83, E3: 164.81, F3: 174.61, G3: 196.00, A3: 220.00, Bb3: 233.08, B3: 246.94,
  C4: 261.63, Cs4: 277.18, D4: 293.66, E4: 329.63, F4: 349.23, Fs4: 369.99, G4: 392.00,
  Gs4: 415.30, A4: 440.00, Bb4: 466.16, B4: 493.88,
  C5: 523.25, Cs5: 554.37, D5: 587.33, E5: 659.25, F5: 698.46, Fs5: 739.99, G5: 783.99,
  A5: 880.00, B5: 987.77,
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
};

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
    if (style === "waltz") {
      // 3/4: root on the downbeat, chord on beats two and three.
      bass[at] = c.r;
      chords[at + 2] = c.n; chords[at + 4] = c.n;
      arp[at + 1] = n1; arp[at + 3] = n2; arp[at + 5] = n3;
    } else if (style === "pad") {
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
function phrase(line, max = 8) {
  const n = line.length;
  const out = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    if (!line[i]) continue;
    let k = 1;
    while (k < n && !line[(i + k) % n]) k++;
    out[i] = Math.max(0.9, Math.min(max, k * 0.92));
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

// ---- "Moonlit Waltz" — 3/4 folk waltz in D minor: nylon GUITAR on beats
// two and three, FLUTE singing the tune, brushes. Eight-bar sections.
const MW = {
  A: [CH.Dmin, CH.Bbmaj, CH.Fmaj, CH.Cmaj, CH.Dmin, CH.Gmin, CH.Amaj, CH.Dmin],
  B: [CH.Dmin, CH.Gmin, CH.Cmaj, CH.Fmaj, CH.Bbmaj, CH.Gmin, CH.Amaj, CH.Amaj],
  C: [CH.Fmaj, CH.Cmaj, CH.Dmin, CH.Bbmaj, CH.Fmaj, CH.Gmin, CH.Amaj, CH.Dmin],
};
const mw1 = [N.A4,0,N.D5,0,N.C5,0,  N.Bb4,0,N.A4,0,N.F4,0,  N.A4,0,N.C5,0,N.A4,0,  N.G4,0,N.E4,0,N.G4,0,
             N.F4,0,N.A4,0,N.D5,0,  N.Bb4,0,N.A4,0,N.G4,0,  N.Cs5,0,N.A4,0,N.E4,0,  N.D5,0,0,0,0,0];
const mw2 = [N.D5,0,N.F5,0,N.E5,0,  N.D5,0,N.Bb4,0,N.G4,0,  N.E4,0,N.G4,0,N.C5,0,  N.A4,0,N.F4,0,N.A4,0,
             N.D5,0,N.Bb4,0,N.F4,0,  N.G4,0,N.Bb4,0,N.D5,0,  N.Cs5,0,N.E5,0,N.A4,0,  N.A4,0,0,0,0,0];
const mw3 = [N.C5,0,N.A4,0,N.F4,0,  N.E4,0,N.G4,0,N.E4,0,  N.F4,0,N.A4,0,N.D5,0,  N.F4,0,N.D5,0,N.Bb4,0,
             N.A4,0,N.C5,0,N.F5,0,  N.D5,0,N.Bb4,0,N.G4,0,  N.A4,0,N.Cs5,0,N.E5,0,  N.D5,0,0,0,0,0];
const mw4 = [N.A4,0,0,0,N.D5,0,  0,0,0,0,0,0,  N.F4,0,0,0,N.A4,0,  0,0,0,0,0,0,
             N.D5,0,0,0,N.C5,0,  0,0,0,0,0,0,  N.A4,0,0,0,0,0,  N.D5,0,0,0,0,0];
const songWaltz = [
  { prog: MW.A, mel: null, section: "intro" },
  { prog: MW.A, mel: mw1,  section: "verse" },
  { prog: MW.B, mel: mw2,  section: "turn" },
  { prog: MW.C, mel: mw3,  section: "lift" },
  { prog: MW.A, mel: mw1,  section: "verse2" },
  { prog: MW.B, mel: mw2,  section: "turn2" },
  { prog: MW.C, mel: mw3,  section: "lift2" },
  { prog: MW.A, mel: mw4,  section: "outro" },
].map((s) => sect({
  ...s, song: "waltz", bpm: 108, meter: 6, style: "waltz", drums: "waltz", sus: 2.4,
  voice: { chord: "guitar", lead: "flute", arp: "guitar" },
  vel: { chord: 0.055, lead: 0.075, arp: 0.035 },
}));

// ---- "Sunrise Hymn" — slow drumless chorale in F: ORGAN pads, BELLS.
const SH = { A: [CH.Fmaj, CH.Bbmaj, CH.Dmin, CH.Cmaj], B: [CH.Bbmaj, CH.Fmaj, CH.Gmin, CH.Cmaj],
             C: [CH.Fmaj, CH.Cmaj, CH.Dmin, CH.Bbmaj], D: [CH.Gmin, CH.Cmaj, CH.Fmaj, CH.Fmaj] };
const sh1 = [N.F4,0,0,0,N.A4,0,0,0,  N.Bb4,0,0,0,N.A4,0,0,0,  N.F4,0,0,0,N.D5,0,0,0,  N.C5,0,0,0,0,0,0,0];
const sh2 = [N.Bb4,0,0,0,N.D5,0,0,0,  N.C5,0,0,0,N.A4,0,0,0,  N.Bb4,0,0,0,N.G4,0,0,0,  N.C5,0,0,0,0,0,0,0];
const sh3 = [N.A4,0,0,0,N.C5,0,0,0,  N.G4,0,0,0,N.E4,0,0,0,  N.F4,0,0,0,N.A4,0,0,0,  N.D5,0,0,0,N.C5,0,0,0];
const sh4 = [N.D5,0,0,0,N.Bb4,0,0,0,  N.C5,0,0,0,N.G4,0,0,0,  N.A4,0,0,0,N.F4,0,0,0,  N.F4,0,0,0,0,0,0,0];
const sh5 = [N.C5,0,0,0,0,0,0,0,  N.A4,0,0,0,0,0,0,0,  N.F4,0,0,0,0,0,0,0,  N.F4,0,0,0,0,0,0,0];
const songHymn = [
  { prog: SH.A, mel: null, drums: "none",  section: "intro" },
  { prog: SH.A, mel: sh1,  drums: "none",  section: "verse" },
  { prog: SH.B, mel: sh2,  drums: "swell", section: "rise" },
  { prog: SH.C, mel: sh3,  drums: "swell", section: "verse2" },
  { prog: SH.D, mel: sh4,  drums: "swell", section: "turn" },
  { prog: SH.A, mel: sh1,  drums: "swell", section: "verse3" },
  { prog: SH.C, mel: sh3,  drums: "none",  section: "descent" },
  { prog: SH.D, mel: sh5,  drums: "none",  section: "outro" },
].map((s) => sect({
  ...s, song: "hymn", bpm: 76, style: "pad", sus: 7.5,
  voice: { chord: "organ", lead: "bell" }, vel: { chord: 0.03, lead: 0.055 },
}));

// ====================== LOBBY SONGS ======================

// ---- "Still Water" — the original calm A-minor piece, now full length.
const SW = { A: [CH.Amin, CH.Fmaj, CH.Cmaj, CH.Gmaj], B: [CH.Amin, CH.Dmin, CH.Fmaj, CH.Gmaj],
             C: [CH.Fmaj, CH.Cmaj, CH.Gmaj, CH.Amin], D: [CH.Dmin, CH.Amin, CH.Fmaj, CH.Gmaj] };
const sw1 = [N.A4,0,0,0,N.C5,0,N.E5,0,  N.F4,0,0,0,N.A4,0,N.C5,0,  N.G4,0,0,0,N.E4,0,N.G4,0,  N.D5,0,0,0,N.B4,0,N.G4,0];
const sw2 = [N.E5,0,0,0,N.C5,0,N.A4,0,  N.D5,0,0,0,N.F4,0,N.A4,0,  N.C5,0,0,0,N.A4,0,N.F4,0,  N.B4,0,0,0,N.D5,0,0,0];
const sw3 = [N.A4,0,N.C5,0,N.F5,0,0,0,  N.E5,0,0,0,N.C5,0,N.G4,0,  N.D5,0,N.B4,0,N.G4,0,N.B4,0,  N.A4,0,0,0,N.E4,0,0,0];
const sw4 = [N.D5,0,0,0,N.A4,0,0,0,  N.C5,0,0,0,N.E4,0,0,0,  N.F4,0,0,0,N.A4,0,0,0,  N.G4,0,0,0,0,0,0,0];
const sw5 = [N.E4,0,0,0,N.A4,0,0,0,  N.C5,0,0,0,N.A4,0,0,0,  N.G4,0,0,0,N.E4,0,0,0,  N.A4,0,0,0,0,0,0,0];
const songStillWater = [
  { prog: SW.A, mel: null, section: "intro" },
  { prog: SW.A, mel: sw1,  section: "verse" },
  { prog: SW.B, mel: sw2,  section: "verse2" },
  { prog: SW.C, mel: sw3,  section: "lift" },
  { prog: SW.A, mel: sw1,  section: "verse3" },
  { prog: SW.D, mel: sw4,  section: "bridge" },
  { prog: SW.B, mel: sw2,  section: "verse4" },
  { prog: SW.C, mel: sw3,  section: "lift2" },
  { prog: SW.A, mel: sw5,  section: "outro" },
].map((s) => sect({
  ...s, song: "stillwater", bpm: 84, style: "flow", drums: "swell", sus: 3.8,
  vel: { chord: 0.035, lead: 0.075, arp: 0.04 },
}));

// ---- "Quiet Hours" — G major, BELLS over electric piano with a plucked
// counter-line. Same instruments already used elsewhere, new colour.
const QH = { A: [CH.Gmaj, CH.Emin, CH.Cmaj, CH.Dmaj], B: [CH.Emin, CH.Cmaj, CH.Gmaj, CH.Dmaj],
             C: [CH.Cmaj, CH.Dmaj, CH.Emin, CH.Emin], D: [CH.Cmaj, CH.Gmaj, CH.Amin, CH.Dmaj] };
const qh1 = [N.D5,0,0,0,N.B4,0,0,0,  N.E5,0,0,0,N.B4,0,0,0,  N.C5,0,0,0,N.E5,0,0,0,  N.D5,0,0,0,N.Fs5,0,0,0];
const qh2 = [N.B4,0,0,0,N.G4,0,0,0,  N.C5,0,0,0,N.G4,0,0,0,  N.B4,0,0,0,N.D5,0,0,0,  N.A4,0,0,0,N.Fs4,0,0,0];
const qh3 = [N.G4,0,0,0,N.C5,0,0,0,  N.A4,0,0,0,N.D5,0,0,0,  N.G5,0,0,0,N.E5,0,0,0,  N.B4,0,0,0,0,0,0,0];
const qh4 = [N.E5,0,0,0,N.D5,0,0,0,  N.B4,0,0,0,N.G4,0,0,0,  N.A4,0,0,0,N.C5,0,0,0,  N.D5,0,0,0,0,0,0,0];
const qh5 = [N.G4,0,0,0,N.B4,0,0,0,  N.D5,0,0,0,N.B4,0,0,0,  N.G4,0,0,0,0,0,0,0,  N.G4,0,0,0,0,0,0,0];
const songQuietHours = [
  { prog: QH.A, mel: null, section: "intro" },
  { prog: QH.A, mel: qh1,  section: "verse" },
  { prog: QH.B, mel: qh2,  section: "verse2" },
  { prog: QH.C, mel: qh3,  section: "lift" },
  { prog: QH.D, mel: qh4,  section: "turn" },
  { prog: QH.A, mel: qh1,  section: "verse3" },
  { prog: QH.B, mel: qh2,  section: "verse4" },
  { prog: QH.A, mel: qh5,  section: "outro" },
].map((s) => sect({
  ...s, song: "quiethours", bpm: 80, style: "flow", drums: "swell", sus: 3.8,
  voice: { chord: "keys", lead: "bell", arp: "pluck" },
  vel: { chord: 0.035, lead: 0.055, arp: 0.04 },
}));

// ---- "Long Watch" — D minor, FLUTE over ORGAN pads. Slow and patient.
const LW = { A: [CH.Dmin, CH.Bbmaj, CH.Fmaj, CH.Cmaj], B: [CH.Dmin, CH.Gmin, CH.Bbmaj, CH.Amaj],
             C: [CH.Fmaj, CH.Cmaj, CH.Dmin, CH.Bbmaj], D: [CH.Gmin, CH.Amaj, CH.Dmin, CH.Dmin] };
const lw1 = [N.D5,0,0,0,0,0,N.A4,0,  N.F4,0,0,0,0,0,N.D5,0,  N.C5,0,0,0,0,0,N.A4,0,  N.G4,0,0,0,0,0,N.E4,0];
const lw2 = [N.F4,0,0,0,N.A4,0,0,0,  N.Bb4,0,0,0,0,0,N.G4,0,  N.D5,0,0,0,0,0,N.F5,0,  N.E5,0,0,0,N.Cs5,0,0,0];
const lw3 = [N.A4,0,0,0,N.C5,0,0,0,  N.G4,0,0,0,N.E4,0,0,0,  N.D5,0,0,0,N.F5,0,0,0,  N.D5,0,0,0,0,0,0,0];
const lw4 = [N.Bb4,0,0,0,N.D5,0,0,0,  N.Cs5,0,0,0,N.E5,0,0,0,  N.A4,0,0,0,N.F4,0,0,0,  N.D5,0,0,0,0,0,0,0];
const lw5 = [N.A4,0,0,0,0,0,0,0,  N.F4,0,0,0,0,0,0,0,  N.D5,0,0,0,0,0,0,0,  N.D5,0,0,0,0,0,0,0];
const songLongWatch = [
  { prog: LW.A, mel: null, section: "intro" },
  { prog: LW.A, mel: lw1,  section: "verse" },
  { prog: LW.B, mel: lw2,  section: "turn" },
  { prog: LW.C, mel: lw3,  section: "verse2" },
  { prog: LW.D, mel: lw4,  section: "lift" },
  { prog: LW.A, mel: lw1,  section: "verse3" },
  { prog: LW.C, mel: lw3,  section: "descent" },
  { prog: LW.A, mel: lw5,  section: "outro" },
].map((s) => sect({
  ...s, song: "longwatch", bpm: 72, style: "pad", drums: "none", sus: 7.5,
  voice: { chord: "organ", lead: "flute" }, vel: { chord: 0.03, lead: 0.07 },
}));

// ====================== IN-ROUND SONGS ======================
// Same instruments as always in a round: electric piano, warm bass and
// the plucked counter-line. Eight-bar sections.

// ---- "Iron Heart" — A minor, i–VI–III–VII.
const IH = {
  A: [CH.Amin, CH.Amin, CH.Fmaj, CH.Fmaj, CH.Cmaj, CH.Cmaj, CH.Gmaj, CH.Gmaj],
  B: [CH.Amin, CH.Fmaj, CH.Cmaj, CH.Gmaj, CH.Amin, CH.Fmaj, CH.Gmaj, CH.Gmaj],
  C: [CH.Dmin, CH.Dmin, CH.Amin, CH.Amin, CH.Fmaj, CH.Fmaj, CH.Gmaj, CH.Gmaj],
};
const ih1 = [N.A4,0,0,N.C5,0,0,N.E5,0,  N.D5,0,N.C5,0,0,0,N.A4,0,  N.F4,0,0,N.A4,0,0,N.C5,0,  N.A4,0,0,0,N.F4,0,0,0];
const ih2 = [N.G4,0,0,N.C5,0,0,N.E5,0,  N.D5,0,N.C5,0,0,0,N.G4,0,  N.B4,0,0,N.D5,0,0,N.G5,0,  N.D5,0,0,0,N.B4,0,0,0];
const ih3 = [N.E5,0,N.D5,0,N.C5,0,N.A4,0,  N.C5,0,N.A4,0,N.F4,0,N.A4,0,  N.G4,0,N.E4,0,N.C5,0,N.E5,0,  N.D5,0,N.B4,0,N.G4,0,N.B4,0];
const ih4 = [N.A4,0,N.C5,0,N.E5,0,N.A5,0,  N.G5,0,N.E5,0,N.C5,0,N.A4,0,  N.B4,0,N.D5,0,N.G5,0,N.D5,0,  N.G4,0,0,0,0,0,0,0];
const ih5 = [N.D5,0,0,N.F5,0,0,N.A5,0,  N.F5,0,N.D5,0,0,0,N.A4,0,  N.C5,0,0,N.E5,0,0,N.A5,0,  N.E5,0,N.C5,0,0,0,N.A4,0];
const ih6 = [N.F4,0,0,N.A4,0,0,N.C5,0,  N.A4,0,N.F4,0,0,0,N.C5,0,  N.B4,0,0,N.D5,0,0,N.G5,0,  N.D5,0,0,0,N.B4,0,0,0];
const songIronHeart = [
  { prog: IH.A, mel: seq(ih1, ih2), drums: "full",  section: "a" },
  { prog: IH.B, mel: seq(ih3, ih4), drums: "full",  section: "b" },
  { prog: IH.A, mel: seq(ih1, ih2), drums: "light", section: "a2" },
  { prog: IH.C, mel: seq(ih5, ih6), drums: "full",  section: "c" },
  { prog: IH.B, mel: seq(ih3, ih4), drums: "full",  section: "b2" },
  { prog: IH.A, mel: seq(ih1, ih2), drums: "full",  section: "a3" },
  { prog: IH.C, mel: seq(ih5, ih6), drums: "full",  section: "outro" },
].map((s) => sect({ ...s, song: "ironheart", bpm: 128, style: "drive", sus: 2.8 }));

// ---- "Frontline" — E minor, faster and more frantic.
const FR = {
  A: [CH.Emin, CH.Emin, CH.Cmaj, CH.Cmaj, CH.Gmaj, CH.Gmaj, CH.Dmaj, CH.Dmaj],
  B: [CH.Emin, CH.Cmaj, CH.Gmaj, CH.Dmaj, CH.Emin, CH.Cmaj, CH.Dmaj, CH.Dmaj],
  C: [CH.Amin, CH.Amin, CH.Emin, CH.Emin, CH.Cmaj, CH.Cmaj, CH.Bmin, CH.Bmin],
};
const fr1 = [N.B4,0,0,N.E5,0,0,N.G5,0,  N.Fs5,0,N.E5,0,0,0,N.B4,0,  N.C5,0,0,N.E5,0,0,N.G5,0,  N.E5,0,0,0,N.C5,0,0,0];
const fr2 = [N.G4,0,0,N.B4,0,0,N.D5,0,  N.B4,0,N.G4,0,0,0,N.D5,0,  N.A4,0,0,N.D5,0,0,N.Fs5,0,  N.D5,0,0,0,N.A4,0,0,0];
const fr3 = [N.E5,0,N.Fs5,0,N.G5,0,N.B5,0,  N.A5,0,N.G5,0,N.E5,0,N.D5,0,  N.C5,0,N.E5,0,N.G5,0,N.E5,0,  N.B4,0,N.D5,0,N.Fs5,0,N.A4,0];
const fr4 = [N.E5,0,0,0,N.B4,0,0,0,  N.G4,0,N.B4,0,N.E5,0,N.B4,0,  N.Fs5,0,0,0,N.D5,0,0,0,  N.A4,0,0,0,0,0,0,0];
const fr5 = [N.A4,0,0,N.C5,0,0,N.E5,0,  N.C5,0,N.A4,0,0,0,N.E4,0,  N.B4,0,0,N.E5,0,0,N.G5,0,  N.E5,0,N.B4,0,0,0,N.G4,0];
const fr6 = [N.C5,0,0,N.E5,0,0,N.G5,0,  N.E5,0,N.C5,0,0,0,N.G4,0,  N.Fs5,0,0,N.D5,0,0,N.B4,0,  N.Fs4,0,0,0,N.B4,0,0,0];
const songFrontline = [
  { prog: FR.A, mel: seq(fr1, fr2), drums: "full",  section: "a" },
  { prog: FR.B, mel: seq(fr3, fr4), drums: "full",  section: "b" },
  { prog: FR.A, mel: seq(fr1, fr2), drums: "light", section: "a2" },
  { prog: FR.C, mel: seq(fr5, fr6), drums: "full",  section: "c" },
  { prog: FR.B, mel: seq(fr3, fr4), drums: "full",  section: "b2" },
  { prog: FR.A, mel: seq(fr1, fr2), drums: "full",  section: "a3" },
  { prog: FR.C, mel: seq(fr5, fr6), drums: "full",  section: "outro" },
].map((s) => sect({ ...s, song: "frontline", bpm: 140, style: "drive", sus: 2.8 }));

// ---- "Stalker" — D minor, a slower stalking menace.
const ST = {
  A: [CH.Dmin, CH.Dmin, CH.Bbmaj, CH.Bbmaj, CH.Gmin, CH.Gmin, CH.Amaj, CH.Amaj],
  B: [CH.Dmin, CH.Bbmaj, CH.Fmaj, CH.Cmaj, CH.Dmin, CH.Gmin, CH.Amaj, CH.Amaj],
  C: [CH.Fmaj, CH.Fmaj, CH.Cmaj, CH.Cmaj, CH.Dmin, CH.Dmin, CH.Amaj, CH.Amaj],
};
const st1 = [N.D5,0,0,N.F5,0,0,N.A5,0,  N.F5,0,N.D5,0,0,0,N.A4,0,  N.D5,0,0,N.F5,0,0,N.Bb4,0,  N.D5,0,0,0,N.Bb4,0,0,0];
const st2 = [N.G4,0,0,N.Bb4,0,0,N.D5,0,  N.Bb4,0,N.G4,0,0,0,N.D5,0,  N.Cs5,0,0,N.E5,0,0,N.A4,0,  N.Cs5,0,0,0,N.A4,0,0,0];
const st3 = [N.A4,0,0,N.D5,0,0,N.F5,0,  N.E5,0,N.D5,0,0,0,N.A4,0,  N.C5,0,0,N.F5,0,0,N.A5,0,  N.G5,0,N.F5,0,0,0,N.C5,0];
const st4 = [N.D5,0,0,N.A4,0,0,N.F4,0,  N.Bb4,0,N.D5,0,0,0,N.G4,0,  N.Cs5,0,0,N.A4,0,0,N.E5,0,  N.A4,0,0,0,0,0,0,0];
const st5 = [N.C5,0,0,N.A4,0,0,N.F4,0,  N.A4,0,N.C5,0,0,0,N.F5,0,  N.E5,0,0,N.C5,0,0,N.G4,0,  N.C5,0,0,0,N.E5,0,0,0];
const st6 = [N.F4,0,0,N.A4,0,0,N.D5,0,  N.A4,0,N.F4,0,0,0,N.D5,0,  N.Cs5,0,0,N.E5,0,0,N.A5,0,  N.E5,0,0,0,N.Cs5,0,0,0];
const songStalker = [
  { prog: ST.A, mel: seq(st1, st2), drums: "light", section: "a" },
  { prog: ST.B, mel: seq(st3, st4), drums: "full",  section: "b" },
  { prog: ST.A, mel: seq(st1, st2), drums: "light", section: "a2" },
  { prog: ST.C, mel: seq(st5, st6), drums: "full",  section: "c" },
  { prog: ST.B, mel: seq(st3, st4), drums: "full",  section: "b2" },
  { prog: ST.A, mel: seq(st1, st2), drums: "light", section: "outro" },
].map((s) => sect({ ...s, song: "stalker", bpm: 118, style: "drive", sus: 2.8 }));

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

// Weight of each eighth in a 4/4 bar. Beat one hardest, beat three next,
// the "ands" lightest — an even velocity across a bar is the giveaway
// that nobody is holding the sticks.
const ACCENT = [1, 0.6, 0.82, 0.66, 0.94, 0.6, 0.82, 0.7];

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
  // Bass — warm and round.
  const b = tr.bass ? tr.bass[step % tr.bass.length] : 0;
  if (b) mBass(when, b, STEP * (tr.bassDur ?? 1.5), vel.bass ?? 0.2);
  // Counter-line. `groove` leans on the strong eighths and eases off the
  // weak ones, which is the difference between a part being played and a
  // part being clocked out.
  const a = tr.arp ? tr.arp[step % tr.arp.length] : 0;
  if (a) {
    const av = (vel.arp ?? 0.048) * (tr.groove ? ACCENT[pos % 8] : 1);
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
    if (pos === 0) drumKick(when, 0.6);             // a soft heartbeat on each downbeat
  } else if (kit === "waltz") {
    // ONE-two-three: kick on the downbeat, brushes on 2 and 3.
    if (pos === 0) drumKick(when, 0.62);
    if (pos === 2 || pos === 4) drumBrush(when, pos === 2 ? 0.9 : 0.75);
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
