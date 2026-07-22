// ================================================================
// chat.js — in-lobby text chat.
//
// Messages live at lobbies/{code}/chat/{pushId} as
//   { id, name, color, text, at }. Foul language is censored before
//   sending AND on display (belt and suspenders). Each line is drawn
//   in the sender's CURRENT tank color, "[name]: message" — if a player
//   recolors, every one of their lines (past and present) updates live.
// ================================================================

import { toast } from "./main.js";
import { DEFAULT_SKIN } from "./skins.js";
import { ensureFirebase, lobbyInfo } from "./online.js";
import { getAccount, isBlocked } from "./social.js";
import { PALETTE } from "./palette.js";

/* ---------- profanity filter ---------- */

// A compact list; matched as whole-ish words, leetspeak-normalized.
const BAD = [
  "fuck", "shit", "bitch", "asshole", "bastard", "cunt", "dick",
  "piss", "slut", "whore", "nigger", "faggot", "retard", "damn",
];
const LEET = {
  "@": "a", "4": "a", "3": "e", "1": "i", "!": "i", "|": "i",
  "0": "o", "$": "s", "5": "s", "7": "t", "+": "t", "(": "c",
};
// Words where a substring match is SAFE (unambiguous slurs); the rest
// only match as a whole normalized token to dodge the Scunthorpe trap.
const SUBSTRING_OK = new Set(["nigger", "faggot", "cunt", "fuck", "shit", "bitch"]);

export function censor(text) {
  return text.split(/(\s+)/).map((w) => {
    let norm = w.toLowerCase()
      .replace(/[@43110!|$57+(]/g, (c) => LEET[c] ?? c)
      .replace(/[^a-z]/g, "")
      .replace(/(.)\1+/g, "$1"); // fuuuck → fuck (collapse repeats)
    for (const bad of BAD) {
      const hit = SUBSTRING_OK.has(bad) ? norm.includes(bad) : norm === bad;
      if (hit) {
        return w.length <= 1 ? w : w[0] + "*".repeat(Math.max(1, w.replace(/\s/g, "").length - 1));
      }
    }
    return w;
  }).join("");
}

/* ---------- text chat ---------- */

let chatUnsub = null;
const seenChat = new Set();
// The live color of each player id, refreshed from every lobby snapshot
// (see updateChatColors). Chat lines re-derive their color from this so
// recoloring updates old messages too.
const liveColors = {};

async function sendText() {
  const input = document.getElementById("chat-input");
  const raw = (input.value ?? "").trim();
  if (!raw) return;
  input.value = "";
  const info = lobbyInfo();
  const acc = getAccount();
  if (!info) return;
  try {
    const f = await ensureFirebase();
    const key = f.push(f.ref(f.db, `lobbies/${info.code}/chat`)).key;
    await f.set(f.ref(f.db, `lobbies/${info.code}/chat/${key}`), {
      id: acc?.key ?? "guest",
      name: acc?.name ?? "Guest",
      color: window.__myLobbyColor ?? DEFAULT_SKIN,
      text: censor(raw).slice(0, 240),
      at: Date.now(),
    });
  } catch (e) { toast("Message didn't send."); }
}

// The color to paint a line: the sender's CURRENT color if we know it,
// else the color the message was sent with.
function colorForLine(msg) {
  const key = liveColors[msg.id] ?? msg.color;
  return PALETTE[key] ?? "#eef1f6";
}

function appendLine(msg) {
  const log = document.getElementById("chat-log");
  if (!log) return;
  if (msg.id && isBlocked(msg.id)) return; // blocked → hidden
  const line = document.createElement("div");
  line.className = "chat-line";
  line.dataset.senderId = msg.id ?? "";
  line.dataset.fallbackColor = msg.color ?? DEFAULT_SKIN;
  line.innerHTML =
    `<span class="chat-who" style="color:${colorForLine(msg)}">[${escapeHtml(msg.name)}]:</span> ` +
    `${escapeHtml(censor(msg.text ?? ""))}`;
  log.appendChild(line);
  while (log.children.length > 60) log.removeChild(log.firstChild);
  log.scrollTop = log.scrollHeight;
}

// Refresh every rendered line to its sender's current color. Called by
// the lobby whenever a player snapshot arrives (colors may have changed).
export function updateChatColors(colorsById) {
  if (colorsById) {
    for (const k of Object.keys(liveColors)) delete liveColors[k];
    Object.assign(liveColors, colorsById);
  }
  const log = document.getElementById("chat-log");
  if (!log) return;
  for (const line of log.children) {
    const who = line.querySelector(".chat-who");
    if (!who) continue;
    const id = line.dataset.senderId;
    const key = liveColors[id] ?? line.dataset.fallbackColor;
    who.style.color = PALETTE[key] ?? "#eef1f6";
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

export function startChat(code, myColor) {
  window.__myLobbyColor = myColor;
  stopChat();
  const log = document.getElementById("chat-log");
  if (log) log.innerHTML = "";
  seenChat.clear();
  ensureFirebase().then((f) => {
    chatUnsub = f.onValue(f.ref(f.db, `lobbies/${code}/chat`), (snap) => {
      const val = snap.val() ?? {};
      const entries = Object.entries(val).sort((a, b) => (a[1].at ?? 0) - (b[1].at ?? 0));
      for (const [k, m] of entries) {
        if (seenChat.has(k)) continue;
        seenChat.add(k);
        appendLine(m);
      }
    });
  });
}

export function stopChat() {
  if (chatUnsub) { try { chatUnsub(); } catch (e) {} chatUnsub = null; }
}

/* ---------- init ---------- */

export function initChat() {
  const send = document.getElementById("chat-send");
  const input = document.getElementById("chat-input");
  if (send) send.addEventListener("click", sendText);
  if (input) input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); sendText(); }
  });
}
