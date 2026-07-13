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

  // Tank takes a non-lethal hit: a short metallic thunk.
  hit() {
    if (!ready() || limited("hit", 60)) return;
    try {
      blip("square", 320, 150, 0.05, 0.1);
      blip("triangle", 180, 90, 0.08, 0.08);
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

  // Laser: a searing zap over a deep lowpass growl — menacing.
  laser() {
    if (!ready() || limited("laser", 120)) return;
    try {
      blip("sawtooth", 2200, 160, 0.28, 0.16);
      whoosh("bandpass", 4200, 900, 0.24, 0.1, 0, 4);
      whoosh("lowpass", 420, 55, 0.55, 0.26, 0, 0.8); // the growl
      blip("sine", 68, 32, 0.55, 0.2);                // sub rumble
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

  // Big cannon: a deep, slow THOOMP.
  cannon() {
    if (!ready() || limited("cannon", 150)) return;
    try {
      blip("sine", 120, 38, 0.42, 0.3);
      whoosh("lowpass", 700, 90, 0.3, 0.16, 0, 0.8);
    } catch (e) {}
  },

  // Shrapnel burst: the classic staccato crackle — a thump, then a
  // ragged run of little pops as the fragments scatter.
  shrap() {
    if (!ready() || limited("shrap", 150)) return;
    try {
      blip("square", 210, 85, 0.16, 0.12); // the shell letting go
      whoosh("highpass", 900, 2400, 0.3, 0.12, 0, 1.2);
      const pops = 10;
      for (let i = 0; i < pops; i++) {
        const when = 0.03 + i * 0.045 + Math.random() * 0.03;
        const f = 480 + Math.random() * 700;
        blip("square", f, f * 0.55, 0.045, 0.085, when);
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

/* ---------- music: chiptune tracks per situation ---------- */
// Each track: 32 eighth-note steps of bass + sparse lead. Game mode
// shuffles its six tracks; title and lobby each keep their theme.

const TRACKS = {
  title: [
    { bpm: 88,
      bass: [55,0,0,0, 65.4,0,0,0, 49,0,0,0, 55,0,0,0, 43.7,0,0,0, 49,0,0,0, 55,0,0,0, 55,0,0,0],
      lead: [220,0,0,262, 0,0,330,0, 0,294,0,0, 262,0,0,0, 0,0,220,0, 0,196,0,220, 0,0,0,0, 0,0,0,0] },
  ],
  lobby: [
    { bpm: 100,
      bass: [65.4,0,65.4,0, 98,0,65.4,0, 87.3,0,87.3,0, 65.4,0,49,0, 65.4,0,65.4,0, 98,0,110,0, 87.3,0,98,0, 65.4,0,0,0],
      lead: [0,0,262,0, 0,330,0,0, 349,0,0,330, 0,0,262,0, 0,0,392,0, 0,330,0,262, 0,0,330,0, 0,0,0,0] },
  ],
  game: [
    { bpm: 105, // the original A-minor groove
      bass: [55,0,55,0, 65.4,0,49,0, 55,0,55,0, 41.2,0,49,0, 55,0,55,0, 65.4,0,73.4,0, 82.4,0,73.4,0, 65.4,0,49,0],
      lead: [0,0,0,0, 440,0,0,392, 0,0,330,0, 0,0,0,0, 0,0,523,0, 0,440,0,0, 392,0,330,0, 392,0,0,0] },
    { bpm: 112, // dorian runner
      bass: [73.4,0,73.4,73.4, 0,87.3,0,73.4, 98,0,98,0, 87.3,0,73.4,0, 73.4,0,73.4,73.4, 0,87.3,0,110, 0,98,0,87.3, 0,73.4,0,0],
      lead: [294,0,0,349, 0,0,440,0, 0,392,0,349, 0,294,0,0, 0,0,294,0, 349,0,440,0, 494,0,440,0, 392,0,0,0] },
    { bpm: 118, // driving minor
      bass: [82.4,82.4,0,82.4, 0,82.4,0,98, 0,82.4,82.4,0, 73.4,0,65.4,0, 82.4,82.4,0,82.4, 0,82.4,0,110, 0,98,0,82.4, 0,65.4,0,73.4],
      lead: [0,0,330,0, 0,0,0,392, 0,0,330,0, 294,0,0,0, 0,0,330,0, 415,0,392,0, 330,0,0,294, 0,330,0,0] },
    { bpm: 108, // syncopated strut
      bass: [49,0,0,49, 0,0,58.3,0, 0,49,0,0, 65.4,0,58.3,0, 49,0,0,49, 0,0,58.3,0, 0,73.4,0,0, 65.4,0,58.3,0],
      lead: [0,262,0,0, 294,0,0,233, 0,0,262,0, 0,0,0,0, 0,349,0,0, 330,0,294,0, 0,262,0,233, 0,0,262,0] },
    { bpm: 115, // tense creeper
      bass: [61.7,0,61.7,0, 61.7,0,65.4,0, 61.7,0,61.7,0, 58.3,0,55,0, 61.7,0,61.7,0, 61.7,0,65.4,0, 69.3,0,65.4,0, 61.7,0,0,0],
      lead: [0,0,0,247, 0,0,262,0, 0,0,0,0, 233,0,0,220, 0,0,0,247, 0,277,0,262, 0,0,247,0, 0,0,0,0] },
    { bpm: 110, // brighter romp
      bass: [65.4,0,65.4,0, 82.4,0,65.4,0, 87.3,0,87.3,0, 98,0,82.4,0, 65.4,0,65.4,0, 82.4,0,110,0, 98,0,87.3,0, 82.4,0,65.4,0],
      lead: [330,0,0,392, 0,0,523,0, 0,440,0,392, 0,330,0,0, 0,0,330,0, 392,0,440,0, 523,0,587,0, 523,0,0,0] },
  ],
};

function scheduleStep(step, when) {
  const tr = TRACKS[music.mode][music.trackIdx];
  const BASS = tr.bass;
  const LEAD = tr.lead;
  const STEP = 60 / tr.bpm / 2;
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
