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

import { toast, tankSVG, showScreen, onEnter, onLeave, paintVar } from "./main.js";
import { SKINS, DEFAULT_SKIN, PATTERNS, DEFAULT_PATTERN, patternColors, isEliteSkin } from "./skins.js";

// Season reset marker. Any account whose stored wipeVersion is lower
// gets its ratings, currency and purchases cleared exactly once on its
// next sign-in. Raise this number to run a fresh wipe in future.
const WIPE_VERSION = 2;
// Everyone restarts the ladder from here.
const WIPE_ELO = 500;
import { ensureFirebase, joinLobby, lobbyInfo } from "./online.js";
import { sfx } from "./audio.js";

const LS_NAME = "tank.account.v1";
const LS_DND = "tank.dnd.v1";
const LS_NOREQ = "tank.noreq.v1";
// ---- dev accounts ----------------------------------------------
// A short, fixed roster. Membership is decided by the address on the
// FIREBASE AUTH record — not by anything in the database or on this
// device — so no other account can inherit these powers by editing a
// profile. Everyone not on this list is completely unaffected: every
// dev branch below is behind isDev(), which is false for them.
// DEV ACCESS REMOVED. There is no dev roster any more and no account
// can hold dev powers — the tools panel and the free Elo/tag adjusters
// are unreachable. Kept as a stub returning false so every caller keeps
// working and nothing can quietly re-enable it.
function isDevEmail() {
  return false;
}

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

// The account-settings modal: change username, reset password, log
// out, or close. Opened by tapping the profile chip.
function openAccountPanel() {
  if (!account) return;
  const modal = document.getElementById("account-modal");
  if (!modal) return;
  document.getElementById("acct-who").textContent = account.name;
  const nameInput = document.getElementById("acct-newname");
  nameInput.value = account.name;
  const msg = document.getElementById("acct-msg");
  msg.textContent = "";
  modal.hidden = false;

  // Dev tools: hidden entirely unless this account is on the roster,
  // so a normal player never sees (or can reach) any of it.
  const devWrap = document.getElementById("acct-dev");
  const paintDevElo = () => {
    const a = document.getElementById("dev-elo1");
    const b = document.getElementById("dev-elo2");
    const tg = document.getElementById("dev-tags");
    if (a) a.textContent = devElo("1v1") ?? "—";
    if (b) b.textContent = devElo("2v2") ?? "—";
    if (tg) tg.textContent = devTags();
  };
  if (devWrap) {
    devWrap.hidden = !isDev();
    if (isDev()) paintDevElo();
  }
  const onDevElo = async (e) => {
    const eloBtn = e.target.closest("[data-dev-elo]");
    const tagBtn = e.target.closest("[data-dev-tags]");
    if ((!eloBtn && !tagBtn) || !isDev()) return;
    const btn = eloBtn ?? tagBtn;
    btn.disabled = true;
    try {
      if (eloBtn) {
        await devAdjustElo(eloBtn.dataset.devElo, +eloBtn.dataset.delta);
        msg.textContent = "Elo updated.";
      } else {
        await devAdjustTags(+tagBtn.dataset.delta);
        msg.textContent = "Tags updated.";
      }
      paintDevElo();
      msg.style.color = "#4bd08a";
    } catch (err) {
      msg.style.color = "#ff6a4d";
      msg.textContent = err?.message ?? "Couldn't apply that change.";
    } finally {
      btn.disabled = false;
    }
  };
  devWrap?.addEventListener("click", onDevElo);

  const close = () => { modal.hidden = true; cleanup(); };
  const onSave = async () => {
    msg.textContent = "";
    try {
      await changeUsername(nameInput.value);
      msg.style.color = "#4bd08a";
      msg.textContent = "Username updated.";
      document.getElementById("acct-who").textContent = account.name;
    } catch (e) {
      msg.style.color = "#ff6a4d";
      msg.textContent = e?.message ?? "Couldn't change that.";
    }
  };
  const onReset = async () => {
    msg.textContent = "";
    try {
      const a = await ensureAuth();
      // The signed-in user's OWN auth email is authoritative — with
      // Firebase's email-enumeration protection, a reset to any other
      // address just resolves silently without sending. Fall back to
      // the stored profile email only if the SDK hasn't surfaced one.
      let email = a.auth.currentUser?.email ?? null;
      if (!email) {
        const f = await ensureFirebase();
        email = (await f.get(f.ref(f.db, `users/${account.key}/email`))).val();
      }
      if (!email) throw new Error("No email on file — sign in with your email once first.");
      await a.sendReset(a.auth, email);
      msg.style.color = "#4bd08a";
      msg.textContent = `Reset email sent to ${email} — check spam too.`;
    } catch (e) {
      msg.style.color = "#ff6a4d";
      msg.textContent = e?.message ?? "Couldn't send the reset email.";
    }
  };
  const onLogout = () => { close(); logout(); };

  const saveBtn = document.getElementById("acct-save");
  const resetBtn = document.getElementById("acct-reset");
  const logoutBtn = document.getElementById("acct-logout");
  const closeBtn = document.getElementById("acct-close");
  const closeX = document.getElementById("acct-x");
  const delBtn = document.getElementById("acct-delete");
  const delWrap = document.getElementById("acct-delete-confirm");
  const delGo = document.getElementById("acct-delete-go");
  const delCancel = document.getElementById("acct-delete-cancel");
  const passEl = document.getElementById("acct-pass");

  // Deleting is a two-step: the first press only ARMS it (revealing
  // what's about to be destroyed), and nothing happens until the
  // password confirms it.
  // Always reopen in the un-armed state.
  if (delWrap) delWrap.hidden = true;
  if (delBtn) delBtn.hidden = false;
  if (delGo) delGo.disabled = false;
  if (passEl) passEl.value = "";
  const onDelArm = () => {
    delWrap.hidden = false;
    delBtn.hidden = true;
    msg.textContent = "";
    passEl.focus();
  };
  const onDelCancel = () => {
    delWrap.hidden = true;
    delBtn.hidden = false;
    passEl.value = "";
  };
  const onDelGo = async () => {
    msg.textContent = "";
    delGo.disabled = true;
    const gone = account.name;
    try {
      await deleteAccount(passEl.value);
      close();
      toast(`Account "${gone}" deleted — everything's gone for good.`, 6000);
      showScreen("screen-title");
    } catch (e) {
      msg.style.color = "#ff6a4d";
      msg.textContent = authErrorText(e);
      delGo.disabled = false;
    }
  };

  saveBtn.addEventListener("click", onSave);
  resetBtn.addEventListener("click", onReset);
  logoutBtn.addEventListener("click", onLogout);
  closeBtn.addEventListener("click", close);
  closeX?.addEventListener("click", close);
  // Tapping the dark backdrop (outside the card) also closes it.
  const onBackdrop = (e) => { if (e.target === modal) close(); };
  modal.addEventListener("click", onBackdrop);
  delBtn?.addEventListener("click", onDelArm);
  delCancel?.addEventListener("click", onDelCancel);
  delGo?.addEventListener("click", onDelGo);
  function cleanup() {
    devWrap?.removeEventListener("click", onDevElo);
    saveBtn.removeEventListener("click", onSave);
    resetBtn.removeEventListener("click", onReset);
    logoutBtn.removeEventListener("click", onLogout);
    closeBtn.removeEventListener("click", close);
    closeX?.removeEventListener("click", close);
    modal.removeEventListener("click", onBackdrop);
    delBtn?.removeEventListener("click", onDelArm);
    delCancel?.removeEventListener("click", onDelCancel);
    delGo?.removeEventListener("click", onDelGo);
    if (passEl) passEl.value = ""; // never leave a password sitting in the DOM
  }
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
    sendVerify: m.sendEmailVerification,
    sendReset: m.sendPasswordResetEmail,
    deleteUser: m.deleteUser,
    reauth: m.reauthenticateWithCredential,
    emailCred: m.EmailAuthProvider,
  };
  return auth;
}

function authErrorText(e) {
  const c = e?.code ?? "";
  if (c.includes("invalid-credential") || c.includes("wrong-password") || c.includes("user-not-found")) {
    return "Wrong email or password.";
  }
  if (c.includes("requires-recent-login")) {
    return "For safety this needs a fresh sign-in — log out, log back in, then try again.";
  }
  if (c.includes("too-many-requests")) return "Too many attempts — wait a minute, then try again.";
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
async function adoptProfile(uid, wantName = null, email = null) {
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
      [`names/${key}`]: key, // username registry (key == keyOf(name) here)
    });
  }

  // Keep the account's email on file so "sign in with username" can
  // resolve it (back-fills quietly for accounts made before this).
  if (email) {
    f.set(f.ref(f.db, `users/${key}/email`), String(email).toLowerCase()).catch(() => {});
  }

  let prof = (await f.get(f.ref(f.db, `users/${key}`))).val() ?? {};

  // ---- ONE-TIME WIPE ----------------------------------------------
  // A single clean slate: every rating cleared, every tag spent, every
  // bought paint and pattern removed. Each account applies this once,
  // the first time it signs in after the update, and is stamped so it
  // never happens again. Bump WIPE_VERSION to run another one later.
  if ((prof.wipeVersion ?? 0) < WIPE_VERSION) {
    try {
      await f.update(f.ref(f.db, `users/${key}`), {
        elo1: WIPE_ELO,
        elo2v2: WIPE_ELO,
        tags: 0,
        owned: null,
        ownedPatterns: null,
        color: DEFAULT_SKIN,
        pattern: DEFAULT_PATTERN,
        patColors: null,
        dev: null,            // strip any stored dev marker too
        wipeVersion: WIPE_VERSION,
      });
      prof = {
        ...prof,
        elo1: WIPE_ELO, elo2v2: WIPE_ELO, tags: 0,
        owned: null, ownedPatterns: null,
        color: DEFAULT_SKIN, pattern: DEFAULT_PATTERN, patColors: null,
        dev: null,
        wipeVersion: WIPE_VERSION,
      };
      // Also clear the locally cached leaderboard standing so Ruby's
      // gate re-evaluates against the fresh ladder.
      try { localStorage.removeItem("tank.boardPos.v1"); } catch { /* ignore */ }
    } catch { /* rules blocked it — try again next sign-in */ }
  }

  account = {
    key, name: prof.name ?? key, uid,
    // Set from the auth email only; never read back from the profile.
    dev: isDevEmail(email ?? auth?.auth?.currentUser?.email),
    // Shop state travels with the account: paint you've equipped, the
    // tags you've earned, and everything you own.
    skin: SKINS[prof.color] && !SKINS[prof.color].reserved ? prof.color : DEFAULT_SKIN,
    tags: Math.max(0, prof.tags ?? 0),
    owned: { ...(prof.owned ?? {}), [DEFAULT_SKIN]: true },
    // Patterns: which two-tone design is equipped, the two colours it
    // uses, and everything owned. Solid (no pattern) is always owned.
    pattern: PATTERNS[prof.pattern] ? prof.pattern : DEFAULT_PATTERN,
    patColors: Array.isArray(prof.patColors) ? prof.patColors.slice(0, 2) : [],
    ownedPatterns: { ...(prof.ownedPatterns ?? {}), [DEFAULT_PATTERN]: true },
    elo1: prof.elo1 ?? null,
    elo2v2: prof.elo2v2 ?? null,
  };
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

// Resolve a sign-in identifier: an email passes through; a username
// resolves through the name registry (names/{nameKey} → accountKey),
// falling back to the legacy direct lookup for old accounts.
async function resolveEmail(identifier) {
  const id = (identifier ?? "").trim();
  if (!id) throw new Error("Enter your email or username.");
  if (id.includes("@")) return id;
  const f = await ensureFirebase();
  const acctKey = (await f.get(f.ref(f.db, `names/${keyOf(id)}`))).val() ?? keyOf(id);
  const email = (await f.get(f.ref(f.db, `users/${acctKey}/email`))).val();
  if (!email) {
    throw new Error("No email on file for that username yet — sign in with your email once.");
  }
  return email;
}

// Change the account's DISPLAY name. The underlying account key never
// moves (friends, ratings, and history stay intact); we just update
// the shown name, register the new name for username sign-in, and fix
// the leaderboard mirrors.
export async function changeUsername(newName) {
  if (!account) throw new Error("Log in first.");
  const name = (newName ?? "").trim();
  if (!validName(name)) throw new Error("Usernames are 3–16 letters, numbers, or _.");
  if (name === account.name) throw new Error("That's already your username.");
  const f = await ensureFirebase();
  const nameKey = keyOf(name);
  // Free unless it's already an alias pointing back at me.
  const owner = (await f.get(f.ref(f.db, `names/${nameKey}`))).val();
  const userAtKey = (await f.get(f.ref(f.db, `users/${nameKey}/uid`))).val();
  if ((owner && owner !== account.key) || (userAtKey && userAtKey !== account.uid)) {
    throw new Error("That username is taken.");
  }
  const updates = {
    [`users/${account.key}/name`]: name,
    [`names/${nameKey}`]: account.key,
    [`leaderboard/elo1/${account.key}/name`]: name,
    [`leaderboard/elo2v2/${account.key}/name`]: name,
  };
  await f.update(f.ref(f.db), updates);
  account = { ...account, name };
  refreshLoginButton();
}

export async function doSignIn(identifier, pass) {
  const a = await ensureAuth();
  const email = await resolveEmail(identifier);
  const cred = await a.signIn(a.auth, email, pass);
  return adoptProfile(cred.user.uid, null, cred.user.email);
}

export async function doCreate(email, pass, name) {
  if (!validName(name)) throw new Error("Usernames are 3–16 letters, numbers, or _.");
  const a = await ensureAuth();
  // Check the username BEFORE creating the auth user — no orphans.
  const f = await ensureFirebase();
  const owner = (await f.get(f.ref(f.db, `users/${keyOf(name)}/uid`))).val();
  if (owner) throw new Error("That username is taken.");
  const cred = await a.signUp(a.auth, email.trim(), pass);
  // Fire off the verification email (best-effort — a send hiccup must
  // not block the freshly-created account from being used).
  try {
    await a.sendVerify(cred.user);
    toast("Account made — a verification email is on its way.", 6000);
  } catch (e) { /* they can resend later; account still works */ }
  return adoptProfile(cred.user.uid, name, cred.user.email);
}

// Send a password-reset email for an existing account.
export async function doPasswordReset(identifier) {
  const a = await ensureAuth();
  // Prefer the authoritative signed-in email; otherwise resolve the
  // typed identifier (email passes through, username → stored email).
  const email = a.auth.currentUser?.email ?? await resolveEmail(identifier);
  await a.sendReset(a.auth, email);
  return email;
}

// Permanently delete the signed-in account: the profile and all its
// data, the username registration(s), the public leaderboard entries,
// friends' links back to you, and finally the sign-in itself.
//
// The password is required for two reasons: it proves it's really you
// before something irreversible happens, and Firebase refuses to
// delete a user whose session isn't fresh — reauthenticating here is
// what makes the delete go through on a days-old session.
//
// Order matters. The data is wiped BEFORE the auth user, while we're
// still authenticated; deleting the login first could strand the data
// with no way to reach it — and with the username still claimed.
export async function deleteAccount(password) {
  if (!account) throw new Error("You're not signed in.");
  const a = await ensureAuth();
  const user = a.auth.currentUser;
  if (!user) throw new Error("Session expired — sign in again, then delete.");
  if (!password) throw new Error("Enter your password to confirm.");

  // 1. Prove identity (also refreshes the login recency Firebase wants).
  const cred = a.emailCred.credential(user.email, password);
  await a.reauth(user, cred);

  const f = await ensureFirebase();
  const key = account.key;
  const uid = account.uid ?? user.uid;

  // 2. Step out of anything live so no lobby/team is left holding a
  //    seat for a player who no longer exists.
  try {
    const duoSnap = await f.get(f.ref(f.db, "duos"));
    const duos = duoSnap.val() ?? {};
    for (const [code, d] of Object.entries(duos)) {
      if (!d?.members?.[key]) continue;
      // Leader leaving dissolves the team; otherwise just free my seat.
      if (d.leader === key) await f.remove(f.ref(f.db, `duos/${code}`));
      else await f.remove(f.ref(f.db, `duos/${code}/members/${key}`));
    }
  } catch (e) { /* best-effort */ }

  // 3. Gather every remaining path that mentions me.
  const updates = {};
  updates[`users/${key}`] = null;              // profile, elo, records, invites…
  updates[`uids/${uid}`] = null;               // the uid → account mapping
  updates[`leaderboard/elo1/${key}`] = null;   // public mirrors
  updates[`leaderboard/elo2v2/${key}`] = null;
  updates[`queue/1v1/${key}`] = null;          // any pending search
  updates[`queue/2v2/${key}`] = null;

  // Friends' links back to me — otherwise they'd keep a ghost in
  // their list forever.
  try {
    const fr = await f.get(f.ref(f.db, `users/${key}/friends`));
    for (const friendKey of Object.keys(fr.val() ?? {})) {
      updates[`users/${friendKey}/friends/${key}`] = null;
    }
  } catch (e) { /* best-effort */ }

  // Every username this account ever registered (renames leave the
  // old alias behind, so clear them all — the names are freed for
  // anyone else to take).
  try {
    const ns = await f.get(f.ref(f.db, "names"));
    for (const [nameKey, owner] of Object.entries(ns.val() ?? {})) {
      if (owner === key) updates[`names/${nameKey}`] = null;
    }
  } catch (e) { /* best-effort */ }

  // 4. Wipe the data, then remove the login itself.
  await f.update(f.ref(f.db), updates);
  await a.deleteUser(user);

  // 5. Forget them locally too (mirrors logout's device wipe).
  stopListening();
  account = null;
  localStorage.removeItem(LS_NAME);
  localStorage.removeItem(LS_DND);
  localStorage.removeItem(LS_NOREQ);
  localStorage.removeItem(LS_BLOCKS);
  localStorage.removeItem(LS_VOICE);
  blocks = {};
  sessionStorage.clear();
  refreshLoginButton();
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
    startHeartbeat();
  } catch (e) { /* offline play still works */ }
}

// Keep lastSeen fresh while the tab is active, so a friend's "last
// active" time reflects roughly when they were really last around
// (the onDisconnect leaves lastSeen at its most recent beat).
let heartbeatTimer = 0;
function startHeartbeat() {
  clearInterval(heartbeatTimer);
  const beat = () => {
    if (!account || document.hidden) return;
    ensureFirebase()
      .then((f) => f.update(f.ref(f.db, `users/${account.key}`), { lastSeen: f.serverTimestamp() }))
      .catch(() => {});
  };
  heartbeatTimer = setInterval(beat, 60000);
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

/* ---------- dev tools ---------- */

// Nudge one of MY OWN ratings by ±100. Dev-only, and it only ever
// writes this account's own rows — no other player is touched.
export async function devAdjustElo(mode, delta) {
  if (!account?.dev) throw new Error("Not a dev account.");
  const field = mode === "2v2" ? "elo2v2" : "elo1";
  const f = await ensureFirebase();
  const cur = (await f.get(f.ref(f.db, `users/${account.key}/${field}`))).val();
  const next = Math.max(0, Math.round((cur ?? 500) + delta));
  await f.update(f.ref(f.db), {
    [`users/${account.key}/${field}`]: next,
    // Keep the public mirror in step, or the leaderboard would lie.
    [`leaderboard/${field}/${account.key}`]: { name: account.name ?? account.key, elo: next },
  });
  account[field] = next;
  localStorage.setItem(LS_NAME, JSON.stringify(account));
  return next;
}

export function devElo(mode) {
  const field = mode === "2v2" ? "elo2v2" : "elo1";
  return account?.[field] ?? null;
}

// Nudge MY OWN tag balance by ±10. Dev-only, and it only ever writes
// this account's own row. Devs earn/spend tags like anyone else now;
// this is just a convenience to top up or drain the balance for testing.
export async function devAdjustTags(delta) {
  if (!account?.dev) throw new Error("Not a dev account.");
  const f = await ensureFirebase();
  const cur = (await f.get(f.ref(f.db, `users/${account.key}/tags`))).val();
  const next = Math.max(0, Math.round((cur ?? 0) + delta));
  await f.set(f.ref(f.db, `users/${account.key}/tags`), next);
  account.tags = next;
  localStorage.setItem(LS_NAME, JSON.stringify(account));
  return next;
}

export function devTags() {
  return account?.tags ?? 0;
}

/* ---------- the shop: tags, ownership, equipped paint ---------- */

// The paint this device wears. Signed out, that's always the default —
// paint is account property, earned and bought.
export function getSkin() {
  return account?.skin ?? DEFAULT_SKIN;
}

// The equipped pattern id (or "solid") and the two colours it paints
// with. Returned together so the renderer/roster can carry them.
export function getPattern() {
  return account?.pattern ?? DEFAULT_PATTERN;
}
export function getPatternColors() {
  return Array.isArray(account?.patColors) ? account.patColors.slice(0, 2) : [];
}
// A compact bundle the roster hands to the renderer: everything needed
// to paint this player's tank.
export function getLook() {
  return {
    color: getSkin(),
    pattern: getPattern(),
    patColors: getPatternColors(),
  };
}
export function ownsPattern(id) {
  if (id === DEFAULT_PATTERN) return true;
  return !!account?.ownedPatterns?.[id];
}
export function ownedPatterns() {
  return { ...(account?.ownedPatterns ?? {}), [DEFAULT_PATTERN]: true };
}

// Is the signed-in account on the dev roster? False for everyone else,
// which is what keeps every dev branch inert on normal accounts.
export function isDev() {
  return !!account?.dev;
}

export function getTags() {
  return account?.tags ?? 0;
}

export function ownsSkin(id) {
  if (id === DEFAULT_SKIN) return true;
  return !!account?.owned?.[id];
}

export function ownedSkins() {
  return { ...(account?.owned ?? {}), [DEFAULT_SKIN]: true };
}

// The rating the shop gates on: your BEST of the two ladders, so a
// rank you've reached in either mode unlocks its paint.
export function bestElo() {
  if (!account) return null;
  const a = account.elo1;
  const b = account.elo2v2;
  if (a == null && b == null) return null;
  return Math.max(a ?? -Infinity, b ?? -Infinity);
}

// Wear paint you already own.
export async function equipSkin(id) {
  if (!account) throw new Error("Log in to change your paint.");
  if (!SKINS[id] || SKINS[id].reserved) throw new Error("That paint doesn't exist.");
  if (!ownsSkin(id)) throw new Error("You don't own that paint yet.");
  account.skin = id;
  localStorage.setItem(LS_NAME, JSON.stringify(account));
  const f = await ensureFirebase();
  await f.set(f.ref(f.db, `users/${account.key}/color`), id);
}

// Buy paint. The rank gate and the price are both checked here, not
// just in the UI — the button being enabled is never the authority.
export async function buySkin(id, opts = {}) {
  if (!account) throw new Error("Log in to use the shop.");
  const skin = SKINS[id];
  if (!skin || skin.reserved) throw new Error("That paint doesn't exist.");
  if (ownsSkin(id)) throw new Error("You already own that.");
  // Elite paint (Ruby) is leaderboard-gated. The shop verifies standing
  // live and passes eliteOk; refuse any path that didn't, so a stale or
  // skipped check can't quietly sell it.
  if (isEliteSkin(id) && !opts.eliteOk) {
    throw new Error(`${skin.name} is for the world top 50 only.`);
  }
  const cost = skin.cost ?? 0;
  const f = await ensureFirebase();
  if (account.tags < cost) throw new Error(`Not enough tags — you need ${cost - account.tags} more.`);
  // Re-read the balance before spending: tags are earned on other
  // devices too, and the cached number can be stale.
  const live = (await f.get(f.ref(f.db, `users/${account.key}/tags`))).val() ?? 0;
  if (live < cost) {
    account.tags = Math.max(0, live);
    throw new Error(`Not enough tags — you need ${cost - live} more.`);
  }
  await f.update(f.ref(f.db), {
    [`users/${account.key}/tags`]: live - cost,
    [`users/${account.key}/owned/${id}`]: true,
  });
  account.tags = live - cost;
  account.owned = { ...(account.owned ?? {}), [id]: true };
  localStorage.setItem(LS_NAME, JSON.stringify(account));
  return account.tags;
}

// Equip a pattern you own, choosing the colours it paints with. A
// two-colour pattern needs two DIFFERENT owned colours; solid needs
// none. Colours are validated against what you actually own.
export async function equipPattern(id, colors = []) {
  if (!account) throw new Error("Log in to change your pattern.");
  const pat = PATTERNS[id];
  if (!pat) throw new Error("That pattern doesn't exist.");
  if (!ownsPattern(id)) throw new Error("You don't own that pattern yet.");
  const need = patternColors(id);
  let chosen = [];
  if (need >= 2) {
    chosen = (colors ?? []).slice(0, 2);
    if (chosen.length < 2) throw new Error("Pick two colours for this pattern.");
    if (chosen[0] === chosen[1]) throw new Error("Pick two DIFFERENT colours.");
    for (const c of chosen) {
      if (!ownsSkin(c)) throw new Error("You don't own one of those colours.");
    }
  }
  account.pattern = id;
  account.patColors = chosen;
  localStorage.setItem(LS_NAME, JSON.stringify(account));
  const f = await ensureFirebase();
  await f.update(f.ref(f.db), {
    [`users/${account.key}/pattern`]: id,
    [`users/${account.key}/patColors`]: chosen,
  });
}

// Buy a pattern. Rank gate + price checked here, not just in the UI.
export async function buyPattern(id) {
  if (!account) throw new Error("Log in to use the shop.");
  const pat = PATTERNS[id];
  if (!pat) throw new Error("That pattern doesn't exist.");
  if (ownsPattern(id)) throw new Error("You already own that.");
  const cost = pat.cost ?? 0;
  const f = await ensureFirebase();
  const live = (await f.get(f.ref(f.db, `users/${account.key}/tags`))).val() ?? 0;
  if (live < cost) {
    account.tags = Math.max(0, live);
    throw new Error(`Not enough tags — you need ${cost - live} more.`);
  }
  await f.update(f.ref(f.db), {
    [`users/${account.key}/tags`]: live - cost,
    [`users/${account.key}/ownedPatterns/${id}`]: true,
  });
  account.tags = live - cost;
  account.ownedPatterns = { ...(account.ownedPatterns ?? {}), [id]: true };
  localStorage.setItem(LS_NAME, JSON.stringify(account));
  return account.tags;
}

// Award tags for ranked kills. Called once per ranked match, with the
// number of enemy tanks this player destroyed.
export async function awardTags(kills) {
  const n = Math.max(0, Math.floor(kills ?? 0));
  if (!account || !n) return account?.tags ?? 0;
  try {
    const f = await ensureFirebase();
    const live = (await f.get(f.ref(f.db, `users/${account.key}/tags`))).val() ?? 0;
    const next = live + n;
    await f.set(f.ref(f.db, `users/${account.key}/tags`), next);
    account.tags = next;
    localStorage.setItem(LS_NAME, JSON.stringify(account));
    return next;
  } catch (e) {
    return account.tags;
  }
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
        if (data.kind === "duo") {
          // A 2v2 team invite — accepting seats you in their duo. The
          // invite is consumed either way so it can't re-fire later.
          const consume = () =>
            fb2.remove(fb2.ref(fb2.db, `users/${account.key}/invites/${from}`)).catch(() => {});
          showBanner(`${who} invited you to their 2v2 team`, "JOIN", async () => {
            consume();
            try {
              const m = await import("./ranked.js");
              await m.joinDuo(String(data.code));
              showScreen("screen-ranked");
              m.showRanked2v2?.();
            } catch (e) {
              toast(e?.message ?? "Couldn't join that team.");
            }
          }, consume);
          return;
        }
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

// A short "time since" for a past epoch-ms timestamp.
function relTime(ts) {
  if (!ts) return null;
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 45) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  const w = Math.floor(d / 7);
  if (w < 5) return `${w}w ago`;
  return "a while ago";
}

function statusLabel(p) {
  if (!p || p.status === "offline" || !p.status) {
    const seen = relTime(p?.lastSeen);
    return ["offline", seen ? `Last seen ${seen}` : "Offline"];
  }
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
        <li class="friend-row" style="${paintVar(p.color)}">
          ${tankSVG(p.color)}
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
        <li class="friend-row" style="${paintVar(p?.color)}">
          ${tankSVG(p?.color)}
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
      <li class="friend-row" style="${paintVar(p.color)}">
        ${tankSVG(p.color)}
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

/* ---------- shared invite helpers ---------- */

// Online, non-DND friends — for invite pickers (lobby and 2v2 duo).
export async function getInvitableFriends() {
  if (!account) return [];
  const f = await ensureFirebase();
  const fs = await f.get(f.ref(f.db, `users/${account.key}/friends`));
  const keys = Object.keys(fs.val() ?? {});
  const profiles = (await Promise.all(keys.map((k) => fetchProfile(f, k)))).filter(Boolean);
  return profiles.filter((p) => p.status && p.status !== "offline");
}

// Drop an invite in a friend's inbox. kind: undefined = lobby, "duo" =
// a 2v2 team seat. `code` is the lobby/duo code to join on accept.
export async function sendInvite(friendKey, code, kind = null) {
  if (!account) throw new Error("Log in first.");
  const f = await ensureFirebase();
  await f.set(f.ref(f.db, `users/${friendKey}/invites/${account.key}`), {
    code, at: Date.now(), ...(kind ? { kind } : {}),
  });
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
      <li class="friend-row" style="${paintVar(p.color)}">
        ${tankSVG(p.color)}
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
    if (saved?.key) {
      // Instant UI; auth confirms below. The cached copy is never
      // trusted for dev status — that's recomputed from the auth
      // email in adoptProfile, so editing this blob grants nothing.
      account = { ...saved, dev: false };
    }
  } catch (e) { /* fresh device */ }
  refreshLoginButton();

  // Restore the persisted session (Firebase keeps it on-device until
  // an explicit logout). Reconciles or clears the cached account.
  if (account) {
    ensureAuth()
      .then((a) => a.onAuthStateChanged(a.auth, (user) => {
        if (user) adoptProfile(user.uid, null, user.email).catch(() => {});
        else { // cached name but no session — require a fresh login
          account = null;
          localStorage.removeItem(LS_NAME);
          refreshLoginButton();
        }
      }))
      .catch(() => { if (account) goOnline(); }); // offline: keep the cache
  }

  document.getElementById("menu-login").addEventListener("click", () => {
    if (account) openAccountPanel();
    else showScreen("screen-login");
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
  siBtn.addEventListener("click", busyGuard(siBtn, () => doSignIn(val("login-ident"), val("login-pass"))));
  crBtn.addEventListener("click", busyGuard(crBtn, () => doCreate(val("signup-email"), val("signup-pass"), val("signup-name"))));
  const fgBtn = document.getElementById("login-forgot");
  if (fgBtn) fgBtn.addEventListener("click", async () => {
    fgBtn.disabled = true;
    try {
      const to = await doPasswordReset(val("login-ident"));
      toast(`Reset email sent to ${to} — check spam too.`, 6000);
    } catch (e) {
      toast(authErrorText(e), 5000);
    } finally {
      fgBtn.disabled = false;
    }
  });
  // Sign in / Create account tabs.
  const tabIn = document.getElementById("login-tab-in");
  const tabUp = document.getElementById("login-tab-up");
  const pickLoginTab = (up) => {
    tabIn?.classList.toggle("is-on", !up);
    tabUp?.classList.toggle("is-on", up);
    const fi = document.getElementById("login-form-in");
    const fu = document.getElementById("login-form-up");
    if (fi) fi.hidden = up;
    if (fu) fu.hidden = !up;
  };
  tabIn?.addEventListener("click", () => pickLoginTab(false));
  tabUp?.addEventListener("click", () => pickLoginTab(true));

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
