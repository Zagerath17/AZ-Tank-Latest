// ================================================================
// settings.js — adjustable keybinds for the 4 local players.
// Stored in localStorage as KeyboardEvent.code values (layout-safe).
// Other modules read them with getBinds().
// ================================================================

import { onEnter, onLeave, toast, COLORS, SLOT_NAMES, tankSVG } from "./main.js";
import { getAudioLevels, setAudioLevel, sfx } from "./audio.js";
import { getDnd, setDnd, getNoRequests, setNoRequests } from "./social.js";

const STORE_KEY = "tank.keybinds.v1";

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
  };
  if (!tabs.audio[0]) return;
  const show = (which) => {
    for (const [name, [tab, panel]] of Object.entries(tabs)) {
      const on = name === which;
      panel.hidden = !on;
      tab.classList.toggle("is-on", on);
    }
  };
  tabs.controls[0].addEventListener("click", () => show("controls"));
  tabs.audio[0].addEventListener("click", () => show("audio"));

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

}

export function initSettings() {
  initAudioPanel();
  onEnter("screen-settings", () => {
    render();
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
