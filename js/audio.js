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
// Not a chiptune bleep-track: the harmony is carried by an FM ELECTRIC
// PIANO, the low end by a warm round BASS (triangle + sine sub, not a
// buzzy saw), and the movement by a PLUCKED STRING — all under a proper
// drum kit. Tracks are written as actual songs: real chord progressions
// (mostly the I–V–vi–IV / i–VI–III–VII families), singable melodies, and,
// for the title, a multi-section arrangement (intro → verse → chorus →
// outro) that plays through before it loops.
//
// Data model: each track is 32 steps = 4 bars of 4/4 (2 steps per beat).
// `bass`/`mel`/`arp` hold one frequency per step (0 = rest); `chords`
// holds an ARRAY of frequencies per step (a struck chord). Raw Hz:
//   C2 65.41  D2 73.42  E2 82.41  F2 87.31  G2 98.00  A2 110.00  Bb2 116.54
//   C3 130.81 E3 164.81 G3 196.00 A3 220.00 Bb3 233.08 B3 246.94 C#4 277.18
//   D4 293.66 E4 329.63 F4 349.23 F#4 369.99 G4 392.00 A4 440.00 Bb4 466.16
//   B4 493.88 C5 523.25 C#5 554.37 D5 587.33 E5 659.25 F5 698.46 G5 783.99
const C = {
  Cmaj: [261.63, 329.63, 392.00], Gmaj: [246.94, 293.66, 392.00],
  Amin: [220.00, 261.63, 329.63], Fmaj: [220.00, 261.63, 349.23],
  Emin: [246.94, 329.63, 392.00], Dmaj: [220.00, 293.66, 369.99],
  Dmin: [220.00, 293.66, 349.23], Bbmaj: [293.66, 349.23, 466.16],
  Gmin: [293.66, 392.00, 466.16], Amaj: [220.00, 277.18, 329.63],
};

const TRACKS = {
  // TITLE — a warm C-major song in four sections that play in order, then
  // loop. I–V–vi–IV, an electric-piano lead singing over it.
  title: [
    { bpm: 92, drums: "swell", section: "intro",
      chords: [C.Cmaj,0,0,0,0,0,0,0, C.Gmaj,0,0,0,0,0,0,0, C.Amin,0,0,0,0,0,0,0, C.Fmaj,0,0,0,0,0,0,0],
      bass:   [65.41,0,0,0,0,0,0,0, 98,0,0,0,0,0,0,0, 110,0,0,0,0,0,0,0, 87.31,0,0,0,0,0,0,0],
      mel:    [0,0,0,0,0,0,0,0, 0,0,0,0,0,0,0,0, 0,0,0,0,0,0,0,0, 0,0,0,0,0,0,329.63,392] },
    { bpm: 92, drums: "light", section: "verse",
      chords: [C.Cmaj,0,0,0,C.Cmaj,0,0,0, C.Gmaj,0,0,0,C.Gmaj,0,0,0, C.Amin,0,0,0,C.Amin,0,0,0, C.Fmaj,0,0,0,C.Fmaj,0,0,0],
      bass:   [65.41,0,0,0,98,0,0,0, 98,0,0,0,146.83,0,0,0, 110,0,0,0,164.81,0,0,0, 87.31,0,0,0,130.81,0,0,0],
      mel:    [329.63,0,392,0,0,0,523.25,0, 493.88,0,0,0,440,0,392,0, 329.63,0,0,0,392,0,440,0, 392,0,0,0,349.23,0,329.63,0] },
    { bpm: 92, drums: "full", section: "chorus",
      chords: [C.Amin,0,0,0,C.Amin,0,0,0, C.Fmaj,0,0,0,C.Fmaj,0,0,0, C.Cmaj,0,0,0,C.Cmaj,0,0,0, C.Gmaj,0,0,0,C.Gmaj,0,0,0],
      bass:   [110,0,0,0,164.81,0,0,0, 87.31,0,0,0,130.81,0,0,0, 65.41,0,0,0,98,0,0,0, 98,0,0,0,146.83,0,0,0],
      mel:    [440,0,523.25,0,659.25,0,587.33,523.25, 523.25,0,440,0,349.23,0,440,523.25, 392,0,523.25,0,659.25,0,587.33,0, 587.33,0,493.88,0,392,0,493.88,587.33],
      arp:    [220,329.63,440,329.63,261.63,329.63,440,329.63, 174.61,261.63,349.23,261.63,220,261.63,349.23,261.63, 261.63,392,329.63,392,261.63,329.63,392,329.63, 196,293.66,392,293.66,246.94,293.66,392,293.66] },
    { bpm: 92, drums: "swell", section: "outro",
      chords: [C.Cmaj,0,0,0,0,0,0,0, C.Gmaj,0,0,0,0,0,0,0, C.Fmaj,0,0,0,0,0,0,0, C.Cmaj,0,0,0,0,0,0,0],
      bass:   [65.41,0,0,0,0,0,0,0, 98,0,0,0,0,0,0,0, 87.31,0,0,0,0,0,0,0, 65.41,0,0,0,0,0,0,0],
      mel:    [392,0,0,0,329.63,0,0,0, 293.66,0,0,0,246.94,0,0,0, 261.63,0,0,0,220,0,0,0, 261.63,0,0,0,0,0,0,0] },
  ],
  // LOBBY — calm anticipation: broken-chord electric piano over a slow
  // Am–F–C–G, soft heartbeat underneath.
  lobby: [
    { bpm: 84, drums: "swell",
      chords: [C.Amin,0,0,0,0,0,0,0, C.Fmaj,0,0,0,0,0,0,0, C.Cmaj,0,0,0,0,0,0,0, C.Gmaj,0,0,0,0,0,0,0],
      bass:   [110,0,0,0,0,0,0,0, 87.31,0,0,0,0,0,0,0, 65.41,0,0,0,0,0,0,0, 98,0,0,0,0,0,0,0],
      mel:    [220,0,261.63,0,329.63,0,440,0, 220,0,261.63,0,349.23,0,440,0, 196,0,261.63,0,329.63,0,392,0, 196,0,246.94,0,293.66,0,392,0] },
  ],
  // GAME — driving combat, but still real music: minor progressions, a
  // bass groove, electric-piano stabs, a plucked counter-line, full kit.
  game: [
    { bpm: 128, drums: "full", // A minor: i–VI–III–VII
      chords: [C.Amin,0,0,C.Amin,0,0,0,0, C.Fmaj,0,0,C.Fmaj,0,0,0,0, C.Cmaj,0,0,C.Cmaj,0,0,0,0, C.Gmaj,0,0,C.Gmaj,0,0,0,0],
      bass:   [110,0,110,110,0,110,0,110, 87.31,0,87.31,87.31,0,87.31,0,87.31, 65.41,0,65.41,65.41,0,65.41,0,98, 98,0,98,98,0,98,0,98],
      mel:    [440,0,0,523.25,0,493.88,0,440, 523.25,0,440,0,0,349.23,0,392, 659.25,0,0,587.33,0,523.25,0,392, 587.33,0,493.88,0,0,392,0,0],
      arp:    [220,329.63,440,329.63,261.63,329.63,440,329.63, 174.61,261.63,349.23,261.63,220,261.63,349.23,261.63, 261.63,392,329.63,392,261.63,329.63,392,329.63, 196,293.66,392,293.66,246.94,293.66,392,293.66] },
    { bpm: 140, drums: "full", // E minor: i–VI–III–VII, frantic
      chords: [C.Emin,0,0,C.Emin,0,0,0,0, C.Cmaj,0,0,C.Cmaj,0,0,0,0, C.Gmaj,0,0,C.Gmaj,0,0,0,0, C.Dmaj,0,0,C.Dmaj,0,0,0,0],
      bass:   [82.41,0,82.41,82.41,0,82.41,0,82.41, 65.41,0,65.41,65.41,0,65.41,0,65.41, 98,0,98,98,0,98,0,98, 73.42,0,73.42,73.42,0,73.42,0,73.42],
      mel:    [493.88,0,659.25,0,587.33,0,493.88,0, 523.25,0,392,0,329.63,0,392,0, 587.33,0,493.88,0,392,0,493.88,0, 440,0,587.33,0,369.99,0,440,0],
      arp:    [329.63,493.88,392,493.88,329.63,392,493.88,392, 261.63,392,329.63,392,261.63,329.63,392,329.63, 196,293.66,246.94,293.66,196,246.94,293.66,246.94, 293.66,440,369.99,440,293.66,369.99,440,369.99] },
    { bpm: 118, drums: "light", // D minor: stalking menace i–VI–iv–V
      chords: [C.Dmin,0,0,0,0,0,0,0, C.Bbmaj,0,0,0,0,0,0,0, C.Gmin,0,0,0,0,0,0,0, C.Amaj,0,0,0,0,0,0,0],
      bass:   [73.42,0,0,0,73.42,0,0,0, 116.54,0,0,0,116.54,0,0,0, 98,0,0,0,98,0,0,0, 110,0,0,0,110,0,0,0],
      mel:    [440,0,0,0,349.23,0,440,0, 587.33,0,0,0,466.16,0,0,0, 392,0,0,0,466.16,0,587.33,0, 554.37,0,0,0,440,0,0,0],
      arp:    [220,0,293.66,0,349.23,0,293.66,0, 233.08,0,293.66,0,349.23,0,293.66,0, 196,0,233.08,0,293.66,0,233.08,0, 220,0,277.18,0,329.63,0,277.18,0] },
  ],
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

function scheduleStep(step, when) {
  const tr = TRACKS[music.mode][music.trackIdx];
  const STEP = 60 / tr.bpm / 2;
  const bar = step % 32;
  const pos = bar % 8; // position within the current bar (0..7 = 8th notes)

  // Harmony — electric-piano chords (an array of notes), left to ring.
  const ch = tr.chords ? tr.chords[step % tr.chords.length] : 0;
  if (ch) for (const n of ch) if (n) mKeys(when, n, STEP * 6, 0.04, 1, 2.0);
  // Melody — a singing electric-piano lead.
  const m = tr.mel ? tr.mel[step % tr.mel.length] : 0;
  if (m) mKeys(when, m, STEP * 3.4, 0.1, 1, 2.6);
  // Bass — warm and round.
  const b = tr.bass ? tr.bass[step % tr.bass.length] : 0;
  if (b) mBass(when, b, STEP * 1.5);
  // Counter-line — plucked string.
  const a = tr.arp ? tr.arp[step % tr.arp.length] : 0;
  if (a) mPluck(when, a, STEP * 0.95, 0.048);

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
  }
}

export function startMusic(mode = "game") {
  if (!ensure()) return;
  if (!TRACKS[mode]) mode = "game";
  if (music) {
    if (music.mode === mode) return;
    // Swap themes in place: new pattern from the top of the bar.
    music.mode = mode;
    music.trackIdx = mode === "title" ? 0 : Math.floor(Math.random() * TRACKS[mode].length);
    music.step = 0;
    music.loops = 0;
    return;
  }
  try {
    const gain = ctx.createGain();
    gain.gain.value = 0.55;
    gain.connect(musicBus);
    music = {
      gain, timer: 0, nextAt: 0, step: 0, loops: 0,
      mode, trackIdx: mode === "title" ? 0 : Math.floor(Math.random() * TRACKS[mode].length),
    };
    music.timer = setInterval(() => {
      if (!ready() || !music) return;
      if (!music.nextAt) music.nextAt = ctx.currentTime + 0.1;
      while (music.nextAt < ctx.currentTime + 0.35) {
        const tr = TRACKS[music.mode][music.trackIdx];
        scheduleStep(music.step, music.nextAt);
        music.nextAt += 60 / tr.bpm / 2;
        music.step += 1;
        if (music.step >= tr.bass.length) {
          music.step = 0;
          music.loops += 1;
          const pool = TRACKS[music.mode];
          if (music.mode === "title") {
            // Walk the song's sections in order, then loop — a real
            // arrangement, not one bar on repeat.
            music.trackIdx = (music.trackIdx + 1) % pool.length;
          } else if (pool.length > 1 && music.loops >= 3) {
            // In-game: shuffle to a DIFFERENT track every few loops.
            music.loops = 0;
            let next = music.trackIdx;
            while (next === music.trackIdx) next = Math.floor(Math.random() * pool.length);
            music.trackIdx = next;
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
