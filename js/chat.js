// ================================================================
// chat.js — in-lobby text chat + push-to-talk voice.
//
// TEXT: messages live at lobbies/{code}/chat/{pushId} as
//   { id, name, color, text, at }. Foul language is censored before
//   sending AND on display (belt and suspenders). Each line is drawn
//   in the sender's tank color, "[name]: message".
//
// VOICE: a small WebRTC mesh. Signaling rides Firebase under
//   lobbies/{code}/rtc/{fromId}/{toId} = { sdp | ice }. Push-to-talk
//   by default; the mic track is only enabled while the key is held
//   (or always, if the player chose "on"). Per-peer output gain and
//   mute are applied on the receiving side; blocked accounts are
//   dropped entirely (their text hidden, their audio never played).
//
// Voice/text SETTINGS persist to the account (via social) EXCEPT the
// per-player output gains, which are ephemeral per lobby.
// ================================================================

import { toast } from "./main.js";
import { ensureFirebase, lobbyInfo } from "./online.js";
import { getAccount, isBlocked, setBlocked } from "./social.js";
import { PALETTE } from "./palette.js";

/* ---------- persisted voice settings ---------- */

const VS_KEY = "tank.voice.v1";
const voice = {
  mode: "ptt",        // "on" | "off" | "ptt"
  inGain: 1,
  outGain: 1,
  inputId: "",
  outputId: "",
};
try {
  const raw = JSON.parse(localStorage.getItem(VS_KEY));
  if (raw) Object.assign(voice, raw);
} catch (e) { /* defaults */ }

export function getVoiceSettings() { return { ...voice }; }
export function setVoiceSetting(k, v) {
  if (!(k in voice)) return;
  voice[k] = v;
  try { localStorage.setItem(VS_KEY, JSON.stringify(voice)); } catch (e) {}
  // Mirror the account-backed ones to the cloud through social.
  saveVoiceToCloud();
  if (k === "inGain" && micGainNode) micGainNode.gain.value = v;
  if (k === "outGain") for (const pc of Object.values(peers)) if (pc._gain) pc._gain.gain.value = v * (pc._userGain ?? 1);
  if (k === "mode") applyMicEnabled();
}

let saveVoiceToCloud = () => {}; // set in init, once social is ready

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
      color: window.__myLobbyColor ?? "slate",
      text: censor(raw).slice(0, 240),
      at: Date.now(),
    });
  } catch (e) { toast("Message didn't send."); }
}

function appendLine(msg) {
  const log = document.getElementById("chat-log");
  if (!log) return;
  if (msg.id && isBlocked(msg.id)) return; // blocked → hidden
  const line = document.createElement("div");
  line.className = "chat-line";
  const col = PALETTE[msg.color] ?? "#eef1f6";
  line.innerHTML = `<span style="color:${col}">[${escapeHtml(msg.name)}]:</span> ${escapeHtml(censor(msg.text ?? ""))}`;
  log.appendChild(line);
  while (log.children.length > 60) log.removeChild(log.firstChild);
  log.scrollTop = log.scrollHeight;
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

/* ---------- voice (WebRTC mesh) ---------- */

let localStream = null;
let micGainNode = null;
let micDest = null;
let audioCtx = null;
const peers = {};       // toId → RTCPeerConnection (with _gain, _userGain, _el)
let rtcUnsub = null;
let myVoiceId = null;
let voiceCode = null;

const RTC_CONFIG = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };

async function ensureMic() {
  if (localStream) return true;
  if (voice.mode === "off") return false;
  try {
    const constraints = {
      audio: voice.inputId ? { deviceId: { exact: voice.inputId } } : true,
      video: false,
    };
    const raw = await navigator.mediaDevices.getUserMedia(constraints);
    // Route through a gain node so the input slider works.
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const srcNode = audioCtx.createMediaStreamSource(raw);
    micGainNode = audioCtx.createGain();
    micGainNode.gain.value = voice.inGain;
    micDest = audioCtx.createMediaStreamDestination();
    srcNode.connect(micGainNode).connect(micDest);
    localStream = micDest.stream;
    localStream._raw = raw;
    applyMicEnabled();
    return true;
  } catch (e) {
    toast("Mic unavailable — check permissions.");
    return false;
  }
}

function applyMicEnabled() {
  if (!localStream) return;
  const on = voice.mode === "on" || (voice.mode === "ptt" && pttHeld);
  for (const tr of localStream.getAudioTracks()) tr.enabled = on;
  const dot = document.getElementById("ptt-indicator");
  if (dot) dot.classList.toggle("live", on && voice.mode !== "off");
}

let pttHeld = false;
export function setPtt(held) {
  pttHeld = held;
  applyMicEnabled();
}

function makePeer(toId, initiator) {
  if (peers[toId]) return peers[toId];
  const pc = new RTCPeerConnection(RTC_CONFIG);
  pc._userGain = 1;
  peers[toId] = pc;

  if (localStream) for (const tr of localStream.getAudioTracks()) pc.addTrack(tr, localStream);

  pc.onicecandidate = (e) => {
    if (e.candidate && voiceCode) {
      ensureFirebase().then((f) =>
        f.push(f.ref(f.db, `lobbies/${voiceCode}/rtc/${myVoiceId}/${toId}/ice`), e.candidate.toJSON?.() ?? e.candidate)
      ).catch(() => {});
    }
  };

  pc.ontrack = (e) => {
    // Play remote audio through a per-peer gain we can tweak/mute.
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const el = new Audio();
    el.srcObject = e.streams[0];
    el.autoplay = true;
    // Gain via WebAudio for the output slider + per-player control.
    try {
      const src = audioCtx.createMediaStreamSource(e.streams[0]);
      const g = audioCtx.createGain();
      g.gain.value = voice.outGain * (pc._userGain ?? 1);
      src.connect(g).connect(audioCtx.destination);
      pc._gain = g;
      el.muted = true; // WebAudio path handles sound; element just keeps the stream alive
    } catch (err) {
      el.muted = false; // fallback: element plays directly
    }
    pc._el = el;
  };

  if (initiator) {
    pc.onnegotiationneeded = async () => {
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        const f = await ensureFirebase();
        await f.set(f.ref(f.db, `lobbies/${voiceCode}/rtc/${myVoiceId}/${toId}/sdp`), {
          type: offer.type, sdp: offer.sdp,
        });
      } catch (e) {}
    };
  }
  return pc;
}

async function handleSignal(fromId, data) {
  if (!data) return;
  const acc = getAccount();
  // Never connect audio to a blocked account.
  if (fromId && isBlocked(fromId)) return;
  const pc = makePeer(fromId, false);
  const f = await ensureFirebase();
  try {
    if (data.sdp) {
      const desc = data.sdp;
      if (desc.type === "offer") {
        await pc.setRemoteDescription(desc);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        await f.set(f.ref(f.db, `lobbies/${voiceCode}/rtc/${myVoiceId}/${fromId}/sdp`), {
          type: answer.type, sdp: answer.sdp,
        });
      } else if (desc.type === "answer") {
        await pc.setRemoteDescription(desc);
      }
    }
    if (data.ice) {
      for (const cand of Object.values(data.ice)) {
        try { await pc.addIceCandidate(cand); } catch (e) {}
      }
    }
  } catch (e) {}
}

// Set a peer's output gain (0..2) and mute state, keyed by account.
export function setPeerGain(peerId, gain) {
  const pc = peers[peerId];
  if (pc) { pc._userGain = gain; if (pc._gain) pc._gain.gain.value = voice.outGain * gain; }
}
export function setPeerMuted(peerId, muted) {
  const pc = peers[peerId];
  if (pc) { pc._userGain = muted ? 0 : (pc._userGain || 1); if (pc._gain) pc._gain.gain.value = muted ? 0 : voice.outGain * (pc._userGain || 1); }
}

// Start voice for a lobby: mesh-connect to every other human id.
export async function startVoice(code, myId, peerIds) {
  voiceCode = code;
  myVoiceId = myId;
  if (voice.mode !== "off") await ensureMic();

  ensureFirebase().then((f) => {
    // Listen for signals addressed to me.
    rtcUnsub = f.onValue(f.ref(f.db, `lobbies/${code}/rtc`), (snap) => {
      const all = snap.val() ?? {};
      for (const [fromId, box] of Object.entries(all)) {
        if (fromId === myId) continue;
        const mine = box?.[myId];
        if (mine) handleSignal(fromId, mine);
      }
    });
  });

  // Initiate to peers with a stable tiebreak (lower id calls higher).
  for (const pid of peerIds) {
    if (pid === myId) continue;
    if (isBlocked(pid)) continue;
    if (String(myId) < String(pid)) makePeer(pid, true);
  }
}

export function stopVoice() {
  if (rtcUnsub) { try { rtcUnsub(); } catch (e) {} rtcUnsub = null; }
  for (const [id, pc] of Object.entries(peers)) {
    try { pc.close(); } catch (e) {}
    if (pc._el) pc._el.srcObject = null;
    delete peers[id];
  }
  if (localStream?._raw) for (const tr of localStream._raw.getTracks()) tr.stop();
  localStream = null;
  micGainNode = null;
  voiceCode = null;
  // Clear my signaling subtree so stale offers don't linger.
  if (myVoiceId) {
    ensureFirebase().then((f) => f.remove(f.ref(f.db, `lobbies/${voiceCode}/rtc/${myVoiceId}`))).catch(() => {});
  }
}

/* ---------- device enumeration (for the settings dropdowns) ---------- */

export async function listDevices() {
  try {
    // A permission prompt is needed before labels populate.
    await navigator.mediaDevices.getUserMedia({ audio: true }).then((s) => s.getTracks().forEach((t) => t.stop())).catch(() => {});
    const devs = await navigator.mediaDevices.enumerateDevices();
    return {
      inputs: devs.filter((d) => d.kind === "audioinput"),
      outputs: devs.filter((d) => d.kind === "audiooutput"),
    };
  } catch (e) { return { inputs: [], outputs: [] }; }
}

/* ---------- init ---------- */

export function initChat() {
  const send = document.getElementById("chat-send");
  const input = document.getElementById("chat-input");
  if (send) send.addEventListener("click", sendText);
  if (input) input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); sendText(); }
  });

  // Let social wire cloud-persistence for voice settings.
  saveVoiceToCloud = () => {
    import("./social.js").then((s) => s.saveVoicePrefs?.({
      mode: voice.mode, inGain: voice.inGain, outGain: voice.outGain,
    })).catch(() => {});
  };
}

// Called by social after login to restore cloud voice prefs.
export function applyCloudVoice(prefs) {
  if (!prefs) return;
  for (const k of ["mode", "inGain", "outGain"]) {
    if (prefs[k] != null) voice[k] = prefs[k];
  }
  try { localStorage.setItem(VS_KEY, JSON.stringify(voice)); } catch (e) {}
}
