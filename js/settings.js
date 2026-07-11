// ================================================================
// settings.js — adjustable keybinds for the 4 local players.
// Stored in localStorage as KeyboardEvent.code values (layout-safe).
// Other modules read them with getBinds().
// ================================================================

import { onEnter, onLeave, toast, COLORS, SLOT_NAMES, tankSVG } from "./main.js";
import { getAudioLevels, setAudioLevel, sfx } from "./audio.js";
import { getDnd, setDnd, getNoRequests, setNoRequests } from "./social.js";
import { getVoiceSettings, setVoiceSetting, listDevices, setPeerGain, setPeerMuted } from "./chat.js";
import { lobbyPeers } from "./online.js";
import { isBlocked, setBlocked } from "./social.js";

const STORE_KEY = "tank.keybinds.v1";
const PTT_KEY = "tank.ptt.v1";

export function getPttKey() {
  return localStorage.getItem(PTT_KEY) || "KeyV";
}
function setPttKey(code) {
  localStorage.setItem(PTT_KEY, code);
}

const ACTIONS = [
  ["up", "Forward"],
  ["down", "Reverse"],
  ["left", "Turn left"],
  ["right", "Turn right"],
  ["shoot", "Shoot"],
];

const DEFAULTS = {
  red:    { up: "KeyW",    down: "KeyS",      left: "KeyA",      right: "KeyD",       shoot: "Space" },
  green:  { up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight", shoot: "Enter" },
  blue:   { up: "KeyI",    down: "KeyK",      left: "KeyJ",      right: "KeyL",       shoot: "KeyO"  },
  yellow: { up: "KeyT",    down: "KeyG",      left: "KeyF",      right: "KeyH",       shoot: "KeyY"  },
};

let binds = load();
let capturing = null; // { color, action, btn }

/* ---------- storage ---------- */

function load() {
  const out = structuredClone(DEFAULTS);
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY));
    if (raw) {
      for (const color of COLORS) {
        for (const [action] of ACTIONS) {
          const v = raw?.[color]?.[action];
          if (typeof v === "string" || v === null) out[color][action] = v;
        }
      }
    }
  } catch { /* corrupted storage → defaults */ }
  return out;
}

function save() {
  localStorage.setItem(STORE_KEY, JSON.stringify(binds));
}

/* ---------- public API ---------- */

export function getBinds() {
  return binds;
}

// Turns a KeyboardEvent.code into a short label ("KeyA" → "A", "ArrowUp" → "↑").
export function keyLabel(code) {
  if (code == null) return "···";
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  if (code.startsWith("Numpad")) return "NUM " + code.slice(6);
  const map = {
    Space: "SPACE", Enter: "ENTER", Tab: "TAB", Backspace: "BKSP", CapsLock: "CAPS",
    ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→",
    ShiftLeft: "L SHIFT", ShiftRight: "R SHIFT",
    ControlLeft: "L CTRL", ControlRight: "R CTRL",
    AltLeft: "L ALT", AltRight: "R ALT",
    Semicolon: ";", Quote: "'", Comma: ",", Period: ".", Slash: "/",
    Backslash: "\\", BracketLeft: "[", BracketRight: "]",
    Minus: "-", Equal: "=", Backquote: "`",
  };
  return map[code] ?? code.toUpperCase();
}

/* ---------- render ---------- */

function render() {
  const host = document.getElementById("binds");
  host.innerHTML = COLORS.map((color) => `
    <section class="panel bind-panel p-${color}">
      <header class="bind-head">
        ${tankSVG(color)}
        <h3>${SLOT_NAMES[color]}</h3>
      </header>
      <div class="bind-rows">
        ${ACTIONS.map(([action, label]) => `
          <div class="bind-row">
            <span class="bind-label">${label}</span>
            <button class="keycap ${binds[color][action] == null ? "unbound" : ""}"
                    data-color="${color}" data-action="${action}">
              ${keyLabel(binds[color][action])}
            </button>
          </div>`).join("")}
      </div>
    </section>`).join("");

  host.querySelectorAll(".keycap").forEach((btn) => {
    btn.addEventListener("click", () => startCapture(btn));
  });
}

/* ---------- rebinding ---------- */

function startCapture(btn) {
  cancelCapture();
  capturing = { color: btn.dataset.color, action: btn.dataset.action, btn };
  btn.classList.add("listening");
  btn.textContent = "PRESS KEY";
}

function cancelCapture() {
  if (!capturing) return;
  const { color, action, btn } = capturing;
  btn.classList.remove("listening");
  btn.textContent = keyLabel(binds[color][action]);
  capturing = null;
}

function onKeydown(e) {
  if (!capturing) return;
  e.preventDefault();
  e.stopPropagation();

  if (e.code === "Escape") {
    cancelCapture();
    return;
  }

  const { color, action } = capturing;

  // A key can only belong to one slot — steal it if it's taken elsewhere.
  for (const c of COLORS) {
    for (const [a] of ACTIONS) {
      if (binds[c][a] === e.code && !(c === color && a === action)) {
        binds[c][a] = null;
        toast(`${keyLabel(e.code)} was taken from ${SLOT_NAMES[c]} — give that slot a new key.`);
      }
    }
  }

  binds[color][action] = e.code;
  save();
  capturing = null;
  render();
}

/* ---------- init ---------- */

function initAudioPanel() {
  const tabs = {
    controls: [document.getElementById("tab-controls"), document.getElementById("panel-controls")],
    audio: [document.getElementById("tab-audio"), document.getElementById("panel-audio")],
    voice: [document.getElementById("tab-voice"), document.getElementById("panel-voice")],
  };
  if (!tabs.audio[0]) return;
  const show = (which) => {
    for (const [name, [tab, panel]] of Object.entries(tabs)) {
      const on = name === which;
      panel.hidden = !on;
      tab.classList.toggle("is-on", on);
    }
    if (which === "voice") populateVoiceDevices();
  };
  tabs.controls[0].addEventListener("click", () => show("controls"));
  tabs.audio[0].addEventListener("click", () => show("audio"));
  tabs.voice[0].addEventListener("click", () => show("voice"));

  let previewAt = 0;
  const wire = (kind) => {
    const input = document.getElementById(`vol-${kind}`);
    const val = document.getElementById(`vol-${kind}-val`);
    input.value = Math.round(getAudioLevels()[kind] * 100);
    val.textContent = `${input.value}%`;
    input.addEventListener("input", () => {
      setAudioLevel(kind, input.value / 100);
      val.textContent = `${input.value}%`;
      // A little test pop so the level can be judged by ear.
      if (kind !== "music" && performance.now() > previewAt) {
        previewAt = performance.now() + 170;
        sfx.fire();
      }
    });
  };
  wire("master");
  wire("music");
  wire("sfx");

  // Do Not Disturb: friend requests and lobby join requests won't
  // come through while it's on.
  const dnd = document.getElementById("dnd-toggle");
  if (dnd) {
    const bell = document.getElementById("dnd-bell");
    const paint = () => { if (bell) bell.textContent = dnd.checked ? "🔕" : "🔔"; };
    dnd.checked = getDnd();
    paint();
    dnd.addEventListener("change", () => { setDnd(dnd.checked); paint(); });
  }

  // Block friend requests entirely (independent of DND).
  const noreq = document.getElementById("noreq-toggle");
  if (noreq) {
    noreq.checked = getNoRequests();
    noreq.addEventListener("change", () => setNoRequests(noreq.checked));
  }

  // ---- Voice settings ----
  const vs = getVoiceSettings();
  const mode = document.getElementById("voice-mode");
  if (mode) {
    mode.value = vs.mode;
    mode.addEventListener("change", () => setVoiceSetting("mode", mode.value));
  }
  const wireGain = (id, key) => {
    const input = document.getElementById(id);
    const val = document.getElementById(`${id}-val`);
    if (!input) return;
    input.value = Math.round((getVoiceSettings()[key] ?? 1) * 100);
    if (val) val.textContent = `${input.value}%`;
    input.addEventListener("input", () => {
      setVoiceSetting(key, input.value / 100);
      if (val) val.textContent = `${input.value}%`;
    });
  };
  wireGain("voice-ingain", "inGain");
  wireGain("voice-outgain", "outGain");

  const inSel = document.getElementById("voice-input");
  const outSel = document.getElementById("voice-output");
  if (inSel) inSel.addEventListener("change", () => setVoiceSetting("inputId", inSel.value));
  if (outSel) outSel.addEventListener("change", () => setVoiceSetting("outputId", outSel.value));

  // Push-to-talk keybind (lives with the Online keybinds).
  const pttBtn = document.getElementById("bind-ptt");
  if (pttBtn) {
    pttBtn.textContent = keyLabel(getPttKey());
    pttBtn.addEventListener("click", () => {
      pttBtn.textContent = "…";
      const grab = (e) => {
        e.preventDefault();
        if (e.code !== "Escape") setPttKey(e.code);
        pttBtn.textContent = keyLabel(getPttKey());
        window.removeEventListener("keydown", grab, true);
      };
      window.addEventListener("keydown", grab, true);
    });
  }
}

let devicesLoaded = false;
async function populateVoiceDevices() {
  if (devicesLoaded) return;
  devicesLoaded = true;
  const { inputs, outputs } = await listDevices();
  const vs = getVoiceSettings();
  const fill = (sel, devs, cur) => {
    if (!sel) return;
    for (const d of devs) {
      const opt = document.createElement("option");
      opt.value = d.deviceId;
      opt.textContent = d.label || "Microphone/Speaker";
      if (d.deviceId === cur) opt.selected = true;
      sel.appendChild(opt);
    }
  };
  fill(document.getElementById("voice-input"), inputs, vs.inputId);
  fill(document.getElementById("voice-output"), outputs, vs.outputId);
}

function renderPlayerMixer() {
  const wrap = document.getElementById("player-mixer");
  const list = document.getElementById("player-mixer-list");
  if (!wrap || !list) return;
  const peers = lobbyPeers();
  if (!peers.length) { wrap.hidden = true; return; }
  wrap.hidden = false;
  list.innerHTML = peers.map((p) => `
    <li class="mixer-row p-${p.color}">
      <span class="mixer-name">${p.name}</span>
      <input type="range" class="mixer-gain" data-peer="${p.id}" min="0" max="200" step="1" value="100"
             aria-label="${p.name} volume">
      <button class="btn btn-small mixer-mute" data-peer="${p.id}">Mute</button>
      <button class="btn btn-small mixer-block" data-key="${p.ukey ?? ""}" data-peer="${p.id}"
              ${p.ukey ? "" : "disabled"}>${p.ukey && isBlocked(p.ukey) ? "Blocked" : "Block"}</button>
    </li>`).join("");

  list.querySelectorAll(".mixer-gain").forEach((r) => {
    r.addEventListener("input", () => setPeerGain(r.dataset.peer, r.value / 100));
  });
  list.querySelectorAll(".mixer-mute").forEach((b) => {
    b.addEventListener("click", () => {
      const on = b.textContent === "Mute";
      b.textContent = on ? "Unmute" : "Mute";
      b.classList.toggle("is-on", on);
      setPeerMuted(b.dataset.peer, on);
    });
  });
  list.querySelectorAll(".mixer-block").forEach((b) => {
    b.addEventListener("click", () => {
      const key = b.dataset.key;
      if (!key) return;
      const now = !isBlocked(key);
      setBlocked(key, now);
      b.textContent = now ? "Blocked" : "Block";
      b.classList.toggle("is-on", now);
      if (now) setPeerMuted(b.dataset.peer, true);
    });
  });
}

export function initSettings() {
  initAudioPanel();
  onEnter("screen-settings", () => {
    render();
    renderPlayerMixer();
    // Capture phase so a rebind press never leaks to other listeners.
    window.addEventListener("keydown", onKeydown, true);
  });

  onLeave("screen-settings", () => {
    cancelCapture();
    window.removeEventListener("keydown", onKeydown, true);
  });

  document.getElementById("binds-reset").addEventListener("click", () => {
    binds = structuredClone(DEFAULTS);
    save();
    render();
    toast("Controls reset to defaults.");
  });
}
