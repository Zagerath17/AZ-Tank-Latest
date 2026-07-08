// ================================================================
// Paste your Firebase web-app config here (README → "Firebase setup").
// Firebase → Project settings → Your apps → Web app → Config.
//
// Note: Firebase web API keys are public identifiers, not secrets —
// it's fine (and required) to commit this file. Access control is
// done with Realtime Database security rules, not by hiding the key.
// ================================================================

export const firebaseConfig = {
  apiKey: "AIzaSyCZ2e_i7gdMgkLjswaYlInCy9WfSHBxTKw",
  authDomain: "tank-brawl-49249.firebaseapp.com",
  databaseURL: "https://tank-brawl-49249-default-rtdb.firebaseio.com",
  projectId: "tank-brawl-49249",
  storageBucket: "tank-brawl-49249.firebasestorage.app",
  messagingSenderId: "1082574528247",
  appId: "1:1082574528247:web:69ac1b9f88f960170c7df2"
};

// True once real values are pasted in — the Online screen checks this.
export const isConfigured =
  !firebaseConfig.apiKey.startsWith("PASTE") &&
  !firebaseConfig.databaseURL.includes("your-project");
