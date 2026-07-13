// ================================================================
// social.js — accounts, friends, and invitations.
//
// Accounts are USERNAME-ONLY for now (no password — that arrives
// later with real Firebase auth). Claiming a name writes a profile
// under users/{name} in the Realtime Database:
//
//   users/{key}: {
//     name, color,            // display name + last tank paint
//     status, lobby, lastSeen // "online"|"offline"|"lobby"|"round"
//     dnd,                    // Do Not Disturb
//     friends:  { otherKey: true },
//     requests: { fromKey: ts },          // incoming friend requests
//     joinreqs: { fromKey: ts },          // "let me into your lobby"
//     invites:  { fromKey: {code, at} },  // "join my lobby"
//   }
//
// Notifications surface as a drop-down banner that works on every
// screen, including mid-game.
// ================================================================

import { toast, tankSVG, showScreen, onEnter, onLeave } from "./main.js";
import { ensureFirebase, joinLobby, lobbyInfo } from "./online.js";
import { sfx } from "./audio.js";

const LS_NAME = "tank.account.v1";
const LS_DND = "tank.dnd.v1";
const LS_NOREQ = "tank.noreq.v1";
const LS_BLOCKS = "tank.blocks.v1";
const LS_VOICE = "tank.voice.v1";

let blocks = {}; // key → true, mirrored to the account
try { blocks = JSON.parse(localStorage.getItem(LS_BLOCKS)) || {}; } catch (e) { blocks = {}; }

let account = null; // { key, name, uid }
let auth = null;    // { auth, signIn, signUp, signOut } — lazy Firebase Auth
let unsubs = [];
const bannerQueue = [];
let bannerBusy = false;

/* ---------- account basics ---------- */

export function getAccount() {
  return account;
}

export function getDnd() {
  return localStorage.getItem(LS_DND) === "1";
}

export function getNoRequests() {
  return localStorage.getItem(LS_NOREQ) === "1";
}

// ---- blocking: hides a player's text until unblocked ----
export function isBlocked(key) {
  return !!blocks[key];
}
export function setBlocked(key, on) {
  if (on) blocks[key] = true; else delete blocks[key];
  try { localStorage.setItem(LS_BLOCKS, JSON.stringify(blocks)); } catch (e) {}
  if (account) {
    ensureFirebase()
      .then((f) => f.set(f.ref(f.db, `users/${account.key}/blocks`), blocks))
      .catch(() => {});
  }
}
export function getBlocks() { return { ...blocks }; }


export function setNoRequests(on) {
  localStorage.setItem(LS_NOREQ, on ? "1" : "0");
  if (account) {
    ensureFirebase()
      .then((f) => f.set(f.ref(f.db, `users/${account.key}/noRequests`), !!on))
      .catch(() => {});
  }
}

function keyOf(name) {
  return name.trim().toLowerCase();
}

function validName(name) {
  return /^[a-z0-9_]{3,16}$/i.test(name.trim());
}

/* ---------- Firebase Auth (email + password) ---------- */

async function ensureAuth() {
  if (auth) return auth;
  const f = await ensureFirebase();
  const m = await import(`${f.base}/firebase-auth.js`).catch(() => {
    throw new Error("Couldn't load the sign-in service — check your connection.");
  });
  auth = {
    auth: m.getAuth(f.app), // persists the session on this device
    signIn: m.signInWithEmailAndPassword,
    signUp: m.createUserWithEmailAndPassword,
    signOut: m.signOut,
    onAuthStateChanged: m.onAuthStateChanged,
  };
  return auth;
}

function authErrorText(e) {
  const c = e?.code ?? "";
  if (c.includes("invalid-credential") || c.includes("wrong-password") || c.includes("user-not-found")) {
    return "Wrong email or password.";
  }
  if (c.includes("email-already-in-use")) return "That email already has an account — sign in instead.";
  if (c.includes("invalid-email")) return "That doesn't look like an email address.";
  if (c.includes("weak-password")) return "Password needs at least 6 characters.";
  if (c.includes("operation-not-allowed") || c.includes("configuration-not-found")) {
    return "Firebase Authentication isn't set up yet — console → Build → Authentication → Get started, then enable Email/Password (see README).";
  }
  if (/permission/i.test(e?.message ?? "")) {
    return "Database rules block accounts — add the users rule in Firebase (see README).";
  }
  return e?.message ?? "Sign-in failed.";
}

// After auth succeeds, connect the uid to its username profile.
async function adoptProfile(uid, wantName = null) {
  const f = await ensureFirebase();
  let key = (await f.get(f.ref(f.db, `uids/${uid}`))).val();

  if (!key) {
    // Brand-new account: claim the requested username.
    if (!wantName) throw new Error("Pick a username for your new account.");
    key = keyOf(wantName);
    const owner = (await f.get(f.ref(f.db, `users/${key}/uid`))).val();
    if (owner && owner !== uid) throw new Error("That username is taken.");
    await f.update(f.ref(f.db), {
      [`users/${key}/name`]: wantName.trim(),
      [`users/${key}/uid`]: uid,
      [`users/${key}/createdAt`]: Date.now(),
      [`uids/${uid}`]: key,
    });
  }

  const prof = (await f.get(f.ref(f.db, `users/${key}`))).val() ?? {};
  account = { key, name: prof.name ?? key, uid };
  localStorage.setItem(LS_NAME, JSON.stringify(account));
  // Their cloud-saved preferences come back with them.
  if (typeof prof.dnd === "boolean") localStorage.setItem(LS_DND, prof.dnd ? "1" : "0");
  if (typeof prof.noRequests === "boolean") localStorage.setItem(LS_NOREQ, prof.noRequests ? "1" : "0");
  if (prof.blocks && typeof prof.blocks === "object") {
    blocks = prof.blocks;
    try { localStorage.setItem(LS_BLOCKS, JSON.stringify(blocks)); } catch (e) {}
  }
  await goOnline();
  refreshLoginButton();
  return account;
}

export async function doSignIn(email, pass) {
  const a = await ensureAuth();
  const cred = await a.signIn(a.auth, email.trim(), pass);
  return adoptProfile(cred.user.uid);
}

export async function doCreate(email, pass, name) {
  if (!validName(name)) throw new Error("Usernames are 3–16 letters, numbers, or _.");
  const a = await ensureAuth();
  // Check the username BEFORE creating the auth user — no orphans.
  const f = await ensureFirebase();
  const owner = (await f.get(f.ref(f.db, `users/${keyOf(name)}/uid`))).val();
  if (owner) throw new Error("That username is taken.");
  const cred = await a.signUp(a.auth, email.trim(), pass);
  return adoptProfile(cred.user.uid, name);
}

export async function logout() {
  // Best-effort remote sign-off; the LOCAL wipe happens regardless.
  try {
    setStatus("offline");
    const a = await ensureAuth();
    await a.signOut(a.auth);
  } catch (e) { /* offline — the local wipe still applies */ }
  stopListening();
  account = null;
  // Their data leaves the device: identity, notification prefs, and
  // session leftovers. (Cloud copy stays — it returns on next login.)
  localStorage.removeItem(LS_NAME);
  localStorage.removeItem(LS_DND);
  localStorage.removeItem(LS_NOREQ);
  localStorage.removeItem(LS_BLOCKS);
  localStorage.removeItem(LS_VOICE);
  blocks = {};
  sessionStorage.clear();
  refreshLoginButton();
  toast("Logged out — this device forgot you.");
}

function refreshLoginButton() {
  const btn = document.getElementById("menu-login");
  if (btn) btn.textContent = account ? `👤 ${account.name}` : "👤 LOG IN";
}

/* ---------- presence ---------- */

async function goOnline() {
  if (!account) return;
  try {
    const f = await ensureFirebase();
    const meRef = f.ref(f.db, `users/${account.key}`);
    await f.update(meRef, {
      status: "online",
      lobby: null,
      dnd: getDnd(),
      noRequests: getNoRequests(),
      lastSeen: f.serverTimestamp(),
    });
    f.onDisconnect(f.ref(f.db, `users/${account.key}/status`)).set("offline");
    f.onDisconnect(f.ref(f.db, `users/${account.key}/lobby`)).set(null);
    startListening();
  } catch (e) { /* offline play still works */ }
}

// "online" | "lobby" | "round" (lobbyCode only matters for "lobby")
export function setStatus(status, lobbyCode = null) {
  if (!account) return;
  ensureFirebase()
    .then((f) => f.update(f.ref(f.db, `users/${account.key}`), {
      status,
      lobby: status === "lobby" ? lobbyCode : null,
      lastSeen: f.serverTimestamp(),
    }))
    .catch(() => {});
}

export function setLastColor(color) {
  if (!account || !color) return;
  ensureFirebase()
    .then((f) => f.set(f.ref(f.db, `users/${account.key}/color`), color))
    .catch(() => {});
}

export function setDnd(on) {
  localStorage.setItem(LS_DND, on ? "1" : "0");
  if (account) {
    ensureFirebase()
      .then((f) => f.set(f.ref(f.db, `users/${account.key}/dnd`), !!on))
      .catch(() => {});
  }
}

/* ---------- notification banner ---------- */

function showBanner(text, yesLabel, onYes, onNo) {
  bannerQueue.push({ text, yesLabel, onYes, onNo });
  pumpBanner();
}

function pumpBanner() {
  if (bannerBusy || !bannerQueue.length) return;
  bannerBusy = true;
  const { text, yesLabel, onYes, onNo } = bannerQueue.shift();
  const el = document.getElementById("notice");
  document.getElementById("notice-text").textContent = text;
  const yes = document.getElementById("notice-yes");
  const no = document.getElementById("notice-no");
  yes.textContent = yesLabel;
  el.hidden = false;
  el.classList.add("show");
  sfx.gearSpawn();

  const done = () => {
    el.classList.remove("show");
    setTimeout(() => { el.hidden = true; bannerBusy = false; pumpBanner(); }, 250);
    yes.onclick = no.onclick = null;
    clearTimeout(timer);
  };
  yes.onclick = () => { done(); onYes?.(); };
  no.onclick = () => { done(); onNo?.(); };
  const timer = setTimeout(done, 14000); // banners don't nag forever
}

/* ---------- live listeners: requests, join asks, invites ---------- */

const seen = { requests: new Set(), joinreqs: new Set(), invites: new Set() };

function startListening() {
  stopListening();
  ensureFirebase().then((f) => {
    const listen = (node, handler) => {
      const un = f.onValue(f.ref(f.db, `users/${account.key}/${node}`), (snap) => {
        const val = snap.val() ?? {};
        for (const [from, data] of Object.entries(val)) {
          const tag = `${node}:${from}:${data?.at ?? data}`;
          if (seen[node].has(tag)) continue;
          seen[node].add(tag);
          handler(from, data, f);
        }
      });
      unsubs.push(un);
    };

    listen("requests", (from, _d, fb2) => {
      if (getDnd() || getNoRequests()) return; // silent — the tab still lists them
      fb2.get(fb2.ref(fb2.db, `users/${from}/name`)).then((s) => {
        const who = s.val() ?? from;
        showBanner(`${who} wants to be your friend`, "ACCEPT", () => {
          fb2.update(fb2.ref(fb2.db), {
            [`users/${account.key}/friends/${from}`]: true,
            [`users/${from}/friends/${account.key}`]: true,
            [`users/${account.key}/requests/${from}`]: null,
          }).catch(() => {});
          toast(`You and ${who} are friends now.`);
        }, () => {
          fb2.remove(fb2.ref(fb2.db, `users/${account.key}/requests/${from}`)).catch(() => {});
        });
      });
    });

    listen("joinreqs", (from, _d, fb2) => {
      if (getDnd()) return; // join requests don't come through on DND
      const info = lobbyInfo();
      fb2.remove(fb2.ref(fb2.db, `users/${account.key}/joinreqs/${from}`)).catch(() => {});
      if (!info) return; // not in a lobby any more — nothing to offer
      fb2.get(fb2.ref(fb2.db, `users/${from}/name`)).then((s) => {
        const who = s.val() ?? from;
        // Accept walks them STRAIGHT into the lobby — no second
        // handshake on their side.
        showBanner(`${who} wants to join your lobby`, "ACCEPT", () => {
          if (!lobbyInfo()) { toast("You're not in a lobby any more."); return; }
          if (lobbyInfo().players >= 4) { toast("Your lobby is full."); return; }
          fb2.set(fb2.ref(fb2.db, `users/${from}/invites/${account.key}`), {
            code: lobbyInfo().code,
            at: Date.now(),
            auto: true, // they asked — accepting means they're IN
          }).catch(() => {});
        });
      });
    });

    listen("invites", (from, data, fb2) => {
      fb2.remove(fb2.ref(fb2.db, `users/${account.key}/invites/${from}`)).catch(() => {});
      if (!data?.code) return;
      if (data.auto) {
        // This is the answer to OUR join request — straight in.
        joinLobby(String(data.code))
          .then(() => toast("They accepted — you're in!"))
          .catch((e) => toast(e?.message ?? "Couldn't join that lobby."));
        return;
      }
      fb2.get(fb2.ref(fb2.db, `users/${from}/name`)).then((s) => {
        const who = s.val() ?? from;
        showBanner(`${who} invited you to lobby ${data.code}`, "JOIN", async () => {
          try {
            await joinLobby(String(data.code));
          } catch (e) {
            toast(e?.message ?? "Couldn't join that lobby.");
          }
        });
      });
    });
  }).catch(() => {});
}

function stopListening() {
  for (const un of unsubs) { try { un(); } catch (e) {} }
  unsubs = [];
}

/* ---------- the Social screen ---------- */

async function fetchProfile(f, key) {
  const s = await f.get(f.ref(f.db, `users/${key}`));
  return s.exists() ? { key, ...s.val() } : null;
}

function statusLabel(p) {
  if (!p || p.status === "offline" || !p.status) return ["offline", "Offline"];
  if (p.status === "round") return ["round", "In a round"];
  if (p.status === "lobby") return ["lobby", "In a lobby"];
  return ["online", "Online"];
}

async function renderFriends() {
  const host = document.getElementById("friends-list");
  if (!account) {
    host.innerHTML = `<li class="hint">Log in from the title screen to make friends.</li>`;
    return;
  }
  host.innerHTML = `<li class="hint">Loading…</li>`;
  try {
    const f = await ensureFirebase();
    const fs = await f.get(f.ref(f.db, `users/${account.key}/friends`));
    const keys = Object.keys(fs.val() ?? {});
    if (!keys.length) {
      host.innerHTML = `<li class="hint">No friends yet — try the ADD FRIENDS tab.</li>`;
      return;
    }
    const profiles = await Promise.all(keys.map((k) => fetchProfile(f, k)));
    host.innerHTML = profiles.filter(Boolean).map((p) => {
      const [cls, label] = statusLabel(p);
      const canAsk = cls === "lobby" && !p.dnd;
      const why = p.dnd ? " · Do Not Disturb" : "";
      return `
        <li class="friend-row p-${p.color ?? "slate"}">
          ${tankSVG(p.color ?? "slate")}
          <span class="friend-name">${p.name ?? p.key}
            <em class="status status-${cls}">● ${label}${why}</em></span>
          <button class="btn btn-small" data-ask="${p.key}" ${canAsk ? "" : "disabled"}>
            ASK TO JOIN
          </button>
        </li>`;
    }).join("");

    host.querySelectorAll("[data-ask]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        try {
          const f2 = await ensureFirebase();
          await f2.set(f2.ref(f2.db, `users/${btn.dataset.ask}/joinreqs/${account.key}`), Date.now());
          toast("Asked to join — waiting on them.");
        } catch (e) { toast("Couldn't send the request."); }
      });
    });
  } catch (e) {
    host.innerHTML = `<li class="hint">Couldn't load friends — check your connection.</li>`;
  }
}

async function renderRequests() {
  const host = document.getElementById("requests-list");
  if (!account) {
    host.innerHTML = `<li class="hint">Log in from the title screen first.</li>`;
    return;
  }
  host.innerHTML = `<li class="hint">Loading…</li>`;
  try {
    const f = await ensureFirebase();
    const rs = await f.get(f.ref(f.db, `users/${account.key}/requests`));
    const keys = Object.keys(rs.val() ?? {});
    if (!keys.length) {
      host.innerHTML = `<li class="hint">No pending requests.</li>`;
      return;
    }
    const profiles = await Promise.all(keys.map((k) => fetchProfile(f, k)));
    host.innerHTML = profiles.map((p, i) => {
      const key = keys[i];
      const name = p?.name ?? key;
      return `
        <li class="friend-row p-${p?.color ?? "slate"}">
          ${tankSVG(p?.color ?? "slate")}
          <span class="friend-name">${name}</span>
          <button class="btn btn-small" data-req-yes="${key}">ACCEPT</button>
          <button class="btn btn-small" data-req-no="${key}">DECLINE</button>
        </li>`;
    }).join("");

    host.querySelectorAll("[data-req-yes]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const from = btn.dataset.reqYes;
        try {
          const f2 = await ensureFirebase();
          await f2.update(f2.ref(f2.db), {
            [`users/${account.key}/friends/${from}`]: true,
            [`users/${from}/friends/${account.key}`]: true,
            [`users/${account.key}/requests/${from}`]: null,
          });
          toast("Friend added.");
        } catch (e) { toast("Couldn't accept — connection?"); }
        renderRequests();
      });
    });
    host.querySelectorAll("[data-req-no]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        try {
          const f2 = await ensureFirebase();
          await f2.remove(f2.ref(f2.db, `users/${account.key}/requests/${btn.dataset.reqNo}`));
        } catch (e) {}
        renderRequests();
      });
    });
  } catch (e) {
    host.innerHTML = `<li class="hint">Couldn't load requests — check your connection.</li>`;
  }
}

async function searchPlayer() {
  const q = document.getElementById("friend-search").value;
  const out = document.getElementById("friend-results");
  if (!validName(q)) { out.innerHTML = `<li class="hint">Type an exact username (3–16 chars).</li>`; return; }
  if (!account) { out.innerHTML = `<li class="hint">Log in first (title screen).</li>`; return; }
  out.innerHTML = `<li class="hint">Searching…</li>`;
  try {
    const f = await ensureFirebase();
    const key = keyOf(q);
    const p = await fetchProfile(f, key);
    if (!p) { out.innerHTML = `<li class="hint">No player named "${q}".</li>`; return; }
    if (key === account.key) { out.innerHTML = `<li class="hint">That's you.</li>`; return; }
    const already = (await f.get(f.ref(f.db, `users/${account.key}/friends/${key}`))).exists();
    const blocked = (p.dnd || p.noRequests) && !already;
    const blockLabel = p.noRequests ? "REQUESTS OFF" : "DO NOT DISTURB";
    out.innerHTML = `
      <li class="friend-row p-${p.color ?? "slate"}">
        ${tankSVG(p.color ?? "slate")}
        <span class="friend-name">${p.name}</span>
        <button class="btn btn-small" id="friend-add-btn" ${already || blocked ? "disabled" : ""}>
          ${already ? "FRIENDS ✓" : blocked ? blockLabel : "ADD FRIEND"}
        </button>
      </li>`;
    document.getElementById("friend-add-btn")?.addEventListener("click", async () => {
      try {
        await f.set(f.ref(f.db, `users/${key}/requests/${account.key}`), Date.now());
        toast(`Friend request sent to ${p.name}.`);
        document.getElementById("friend-add-btn").disabled = true;
      } catch (e) { toast("Couldn't send the request."); }
    });
  } catch (e) {
    out.innerHTML = `<li class="hint">Search failed — check your connection.</li>`;
  }
}

/* ---------- host's in-lobby invite panel ---------- */

export async function toggleInvitePanel() {
  const panel = document.getElementById("lobby-social-list");
  if (!panel.hidden) { panel.hidden = true; return; }
  const info = lobbyInfo();
  if (!account || !info) return;
  panel.hidden = false;
  panel.innerHTML = `<li class="hint">Loading friends…</li>`;
  try {
    const f = await ensureFirebase();
    const fs = await f.get(f.ref(f.db, `users/${account.key}/friends`));
    const keys = Object.keys(fs.val() ?? {});
    const profiles = (await Promise.all(keys.map((k) => fetchProfile(f, k)))).filter(Boolean);
    const invitable = profiles.filter((p) => p.status && p.status !== "offline" && p.lobby !== info.code);
    if (!invitable.length) {
      panel.innerHTML = `<li class="hint">No friends online right now.</li>`;
      return;
    }
    const room = info.players < 4;
    panel.innerHTML = invitable.map((p) => `
      <li class="friend-row p-${p.color ?? "slate"}">
        ${tankSVG(p.color ?? "slate")}
        <span class="friend-name">${p.name}</span>
        <button class="btn btn-small" data-invite="${p.key}" ${room && !p.dnd ? "" : "disabled"}>
          ${!room ? "LOBBY FULL" : p.dnd ? "DND" : "INVITE"}
        </button>
      </li>`).join("");
    panel.querySelectorAll("[data-invite]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        try {
          const f2 = await ensureFirebase();
          await f2.set(f2.ref(f2.db, `users/${btn.dataset.invite}/invites/${account.key}`), {
            code: lobbyInfo()?.code,
            at: Date.now(),
          });
          toast("Invite sent.");
          btn.disabled = true;
        } catch (e) { toast("Couldn't send the invite."); }
      });
    });
  } catch (e) {
    panel.innerHTML = `<li class="hint">Couldn't load friends.</li>`;
  }
}

/* ---------- init ---------- */

export function initSocial() {
  try {
    const saved = JSON.parse(localStorage.getItem(LS_NAME));
    if (saved?.key) account = saved; // instant UI; auth confirms below
  } catch (e) { /* fresh device */ }
  refreshLoginButton();

  // Restore the persisted session (Firebase keeps it on-device until
  // an explicit logout). Reconciles or clears the cached account.
  if (account) {
    ensureAuth()
      .then((a) => a.onAuthStateChanged(a.auth, (user) => {
        if (user) adoptProfile(user.uid).catch(() => {});
        else { // cached name but no session — require a fresh login
          account = null;
          localStorage.removeItem(LS_NAME);
          refreshLoginButton();
        }
      }))
      .catch(() => { if (account) goOnline(); }); // offline: keep the cache
  }

  document.getElementById("menu-login").addEventListener("click", () => {
    if (account) {
      if (window.confirm(`Log out ${account.name}? This device will forget your data.`)) logout();
    } else {
      showScreen("screen-login");
    }
  });

  // The login form.
  const val = (id) => document.getElementById(id).value;
  const busyGuard = (btn, fn) => async () => {
    btn.disabled = true;
    try {
      await fn();
      showScreen("screen-menu");
      toast(`Signed in as ${account.name}.`);
    } catch (e) {
      toast(authErrorText(e), 5000);
    } finally {
      btn.disabled = false;
    }
  };
  const siBtn = document.getElementById("login-signin");
  const crBtn = document.getElementById("login-create");
  siBtn.addEventListener("click", busyGuard(siBtn, () => doSignIn(val("login-email"), val("login-pass"))));
  crBtn.addEventListener("click", busyGuard(crBtn, () => doCreate(val("login-email"), val("login-pass"), val("login-name"))));

  // Social screen tabs: Friends | Requests | Add Friends
  const tabs = {
    friends: [document.getElementById("tab-friends"), document.getElementById("panel-friends")],
    requests: [document.getElementById("tab-requests"), document.getElementById("panel-requests")],
    add: [document.getElementById("tab-addfriends"), document.getElementById("panel-addfriends")],
  };
  const show = (which) => {
    for (const [name, [tab, panel]] of Object.entries(tabs)) {
      const on = name === which;
      panel.hidden = !on;
      tab.classList.toggle("is-on", on);
    }
    if (which === "friends") renderFriends();
    if (which === "requests") renderRequests();
  };
  tabs.friends[0].addEventListener("click", () => show("friends"));
  tabs.requests[0].addEventListener("click", () => show("requests"));
  tabs.add[0].addEventListener("click", () => show("add"));
  document.getElementById("friend-search-btn").addEventListener("click", searchPlayer);
  document.getElementById("friend-search").addEventListener("keydown", (e) => {
    if (e.key === "Enter") searchPlayer();
  });

  // Entering the social screen refreshes the friends list — and it
  // stays LIVE, re-polling every 10 seconds while you're looking.
  let liveTimer = 0;
  onEnter("screen-social", () => {
    show("friends");
    liveTimer = setInterval(() => {
      if (!document.getElementById("panel-friends").hidden) renderFriends();
    }, 10000);
  });
  onLeave("screen-social", () => clearInterval(liveTimer));
}
