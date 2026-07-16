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

/* ---------- music: a serious, driving score ---------- */
// A step sequencer, but voiced for weight: a filtered synth bass with
// a sub octave, a detuned saw lead, an optional fast arp for tension,
// and a real drum kit (kick / snare / hats). Every track is minor-key.
// The title carries the main HOOK — a four-bar anthem — and the combat
// tracks echo its tonality so the whole score feels of a piece.
//
// Notes are raw Hz. Reference (A-minor / A-phrygian palette):
//   A1 55  C2 65.4  D2 73.4  E2 82.4  F2 87.3  G2 98
//   A2 110 C3 130.8 D3 146.8 E3 164.8 F3 174.6 G3 196 A3 220 B3 246.9
//   C4 261.6 D4 293.7 E4 329.6 F4 349.2 G4 392 A4 440 B4 493.9
//   C5 523.3 D5 587.3 E5 659.3 F5 698.5 G5 784

const TRACKS = {
  // Slow, ominous anthem — the iconic hook. Sparse, heavy, memorable.
  title: [
    { bpm: 82, drums: "swell",
      // Root descent Am – F – G – Em, a big cinematic loop.
      bass: [55,0,0,0, 55,0,55,0, 43.65,0,0,0, 43.65,0,43.65,0, 49,0,0,0, 49,0,49,0, 41.2,0,0,0, 41.2,0,55,0],
      sub:  [55,0,0,0, 0,0,0,0, 43.65,0,0,0, 0,0,0,0, 49,0,0,0, 0,0,0,0, 41.2,0,0,0, 0,0,0,0],
      // The HOOK: a rising call that falls and resolves.
      lead: [440,0,0,523.3, 659.3,0,587.3,0, 523.3,0,0,493.9, 440,0,0,0, 349.2,0,440,0, 523.3,0,493.9,0, 329.6,0,0,0, 440,0,0,0] },
  ],
  // Tense anticipation — a steady pulse that coils, ready to break.
  lobby: [
    { bpm: 96, drums: "light",
      bass: [110,0,110,0, 110,0,110,0, 87.3,0,87.3,0, 98,0,98,0, 110,0,110,0, 110,0,130.8,0, 87.3,0,98,0, 82.4,0,82.4,0],
      lead: [0,0,329.6,0, 0,0,440,0, 0,349.2,0,329.6, 0,0,0,0, 0,0,392,0, 0,440,0,493.9, 0,0,440,0, 0,0,0,0] },
  ],
  // Driving combat — relentless, aggressive, minor. Full kit + arps.
  game: [
    { bpm: 140, drums: "full", // phrygian charge
      bass: [110,0,110,110, 0,110,0,110, 87.3,0,87.3,0, 110,0,110,116.5, 110,0,110,110, 0,110,0,130.8, 116.5,0,110,0, 87.3,0,82.4,0],
      lead: [440,0,0,523.3, 0,0,466.2,0, 0,440,0,349.2, 0,329.6,0,0, 440,0,0,523.3, 0,587.3,0,466.2, 0,440,0,0, 349.2,0,0,0],
      arp:  [220,261.6,329.6,261.6, 220,261.6,329.6,349.2, 174.6,220,261.6,220, 220,261.6,329.6,261.6, 220,261.6,329.6,261.6, 220,261.6,392,329.6, 233,293.7,349.2,293.7, 174.6,220,261.6,329.6] },
    { bpm: 132, drums: "full", // driving minor
      bass: [82.4,82.4,0,82.4, 0,82.4,0,98, 0,82.4,82.4,0, 73.4,0,65.4,0, 82.4,82.4,0,82.4, 0,82.4,0,110, 0,98,0,82.4, 0,65.4,0,73.4],
      lead: [329.6,0,0,392, 0,0,0,493.9, 0,0,392,0, 293.7,0,0,0, 329.6,0,0,392, 493.9,0,440,0, 392,0,0,293.7, 0,329.6,0,0],
      arp:  [164.8,196,246.9,196, 164.8,196,246.9,293.7, 130.8,164.8,196,164.8, 146.8,196,261.6,196, 164.8,196,246.9,196, 220,246.9,329.6,246.9, 196,246.9,392,246.9, 146.8,196,246.9,293.7] },
    { bpm: 150, drums: "full", // frantic runner
      bass: [73.4,73.4,73.4,0, 87.3,0,73.4,0, 98,0,98,98, 87.3,0,73.4,0, 73.4,73.4,73.4,0, 87.3,0,110,0, 98,98,0,87.3, 0,73.4,0,65.4],
      lead: [587.3,0,523.3,0, 440,0,0,349.2, 0,392,0,440, 0,0,0,0, 587.3,0,659.3,0, 587.3,0,523.3,0, 493.9,0,440,0, 392,0,0,0],
      arp:  [293.7,349.2,440,349.2, 293.7,349.2,440,523.3, 349.2,440,523.3,440, 293.7,349.2,440,349.2, 293.7,349.2,440,349.2, 293.7,392,493.9,392, 246.9,329.6,392,329.6, 293.7,349.2,440,523.3] },
    { bpm: 126, drums: "full", // stalking menace
      bass: [65.4,0,0,65.4, 0,0,73.4,0, 0,65.4,0,0, 82.4,0,73.4,0, 65.4,0,0,65.4, 0,0,73.4,0, 87.3,0,82.4,0, 73.4,0,65.4,0],
      lead: [0,0,261.6,0, 293.7,0,0,246.9, 0,0,261.6,0, 0,0,0,0, 0,0,329.6,0, 349.2,0,293.7,0, 0,261.6,0,246.9, 261.6,0,0,0],
      arp:  [130.8,164.8,196,164.8, 146.8,174.6,220,174.6, 130.8,164.8,196,164.8, 164.8,196,246.9,196, 130.8,164.8,196,164.8, 174.6,220,261.6,220, 164.8,196,246.9,196, 146.8,174.6,220,261.6] },
  ],
};

// --- drum voices ---
function drumKick(when) {
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = "sine";
  o.frequency.setValueAtTime(140, when);
  o.frequency.exponentialRampToValueAtTime(45, when + 0.11);
  g.gain.setValueAtTime(0.42, when);
  g.gain.exponentialRampToValueAtTime(0.0001, when + 0.16);
  o.connect(g).connect(music.gain);
  o.start(when); o.stop(when + 0.18);
}
function drumSnare(when) {
  const src = ctx.createBufferSource();
  src.buffer = getNoise();
  const bp = ctx.createBiquadFilter();
  bp.type = "bandpass"; bp.frequency.value = 1900; bp.Q.value = 0.8;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.2, when);
  g.gain.exponentialRampToValueAtTime(0.0001, when + 0.14);
  src.connect(bp).connect(g).connect(music.gain);
  src.start(when); src.stop(when + 0.16);
  const o = ctx.createOscillator(); // a little tonal body
  const g2 = ctx.createGain();
  o.type = "triangle"; o.frequency.setValueAtTime(210, when);
  o.frequency.exponentialRampToValueAtTime(150, when + 0.09);
  g2.gain.setValueAtTime(0.1, when);
  g2.gain.exponentialRampToValueAtTime(0.0001, when + 0.1);
  o.connect(g2).connect(music.gain);
  o.start(when); o.stop(when + 0.12);
}
function drumHat(when, open) {
  const src = ctx.createBufferSource();
  src.buffer = getNoise();
  const hp = ctx.createBiquadFilter();
  hp.type = "highpass"; hp.frequency.value = 8500;
  const g = ctx.createGain();
  const dur = open ? 0.09 : 0.032;
  g.gain.setValueAtTime(open ? 0.05 : 0.045, when);
  g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
  src.connect(hp).connect(g).connect(music.gain);
  src.start(when); src.stop(when + dur + 0.02);
}

function scheduleStep(step, when) {
  const tr = TRACKS[music.mode][music.trackIdx];
  const STEP = 60 / tr.bpm / 2;
  const bar = step % 32;

  // Bass — filtered saw with a punchy decay.
  const b = tr.bass?.[step % tr.bass.length];
  if (b) {
    const o = ctx.createOscillator();
    const f = ctx.createBiquadFilter();
    const g = ctx.createGain();
    o.type = "sawtooth";
    o.frequency.value = b;
    f.type = "lowpass";
    f.frequency.setValueAtTime(Math.min(2200, b * 6 + 260), when);
    f.frequency.exponentialRampToValueAtTime(Math.max(120, b * 2), when + STEP);
    f.Q.value = 3;
    g.gain.setValueAtTime(0.13, when);
    g.gain.exponentialRampToValueAtTime(0.0001, when + STEP * 0.95);
    o.connect(f).connect(g).connect(music.gain);
    o.start(when); o.stop(when + STEP);
  }
  // Sub octave for weight (title's explicit sub, else derived).
  const subN = tr.sub?.[step % (tr.sub?.length ?? 1)] ?? (b ? b / 2 : 0);
  if (subN) {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = "sine";
    o.frequency.value = subN < 40 ? subN * 2 : subN; // keep it audible
    g.gain.setValueAtTime(0.12, when);
    g.gain.exponentialRampToValueAtTime(0.0001, when + STEP * 1.3);
    o.connect(g).connect(music.gain);
    o.start(when); o.stop(when + STEP * 1.4);
  }
  // Lead — two slightly detuned saws through a lowpass: a big, serious
  // voice with a longer release so the melody sings.
  const l = tr.lead?.[step % tr.lead.length];
  if (l) {
    const f = ctx.createBiquadFilter();
    f.type = "lowpass"; f.frequency.value = 2600; f.Q.value = 1.2;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.075, when);
    g.gain.exponentialRampToValueAtTime(0.0001, when + STEP * 2.4);
    f.connect(g).connect(music.gain);
    for (const det of [-6, 7]) {
      const o = ctx.createOscillator();
      o.type = "sawtooth";
      o.frequency.value = l;
      o.detune.value = det;
      o.connect(f);
      o.start(when); o.stop(when + STEP * 2.5);
    }
  }
  // Arp — a fast, quiet ostinato that drives the combat tracks.
  const a = tr.arp?.[step % tr.arp.length];
  if (a) {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = "square";
    o.frequency.value = a;
    g.gain.setValueAtTime(0.032, when);
    g.gain.exponentialRampToValueAtTime(0.0001, when + STEP * 0.8);
    o.connect(g).connect(music.gain);
    o.start(when); o.stop(when + STEP);
  }

  // Drums.
  const kit = tr.drums ?? "none";
  if (kit === "full") {
    if (bar % 8 === 0 || bar % 8 === 6) drumKick(when);       // 1 and the "and" of 4
    if (bar % 8 === 4) drumSnare(when);                        // backbeat
    if (bar % 2 === 0) drumHat(when, bar % 8 === 4);           // steady 8ths
  } else if (kit === "light") {
    if (bar % 8 === 0) drumKick(when);
    if (bar % 4 === 2) drumHat(when, false);
  } else if (kit === "swell") {
    // Title: just a deep heartbeat on the downbeat of each bar.
    if (bar % 8 === 0) drumKick(when);
  }
}

export function startMusic(mode = "game") {
  if (!ensure()) return;
  if (!TRACKS[mode]) mode = "game";
  if (music) {
    if (music.mode === mode) return;
    // Swap themes in place: new pattern from the top of the bar.
    music.mode = mode;
    music.trackIdx = Math.floor(Math.random() * TRACKS[mode].length);
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
      mode, trackIdx: Math.floor(Math.random() * TRACKS[mode].length),
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
          // In-game: shuffle to a DIFFERENT track every few loops.
          const pool = TRACKS[music.mode];
          if (pool.length > 1 && music.loops >= 3) {
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
}
