// ================================================================
// Paste your Firebase web-app config here (README → "Firebase setup").
// Firebase → Project settings → Your apps → Web app → Config.
//
// Note: Firebase web API keys are public identifiers, not secrets —
// it's fine (and required) to commit this file. Access control is
// done with Realtime Database security rules, not by hiding the key.
// ================================================================

export const firebaseConfig = {
  apiKey: "PASTE_YOUR_API_KEY",
  authDomain: "your-project.firebaseapp.com",
  databaseURL: "https://your-project-default-rtdb.firebaseio.com",
  projectId: "your-project",
  storageBucket: "your-project.appspot.com",
  messagingSenderId: "000000000000",
  appId: "1:000000000000:web:0000000000000000000000",
};

// True once real values are pasted in — the Online screen checks this.
export const isConfigured =
  !firebaseConfig.apiKey.startsWith("PASTE") &&
  !firebaseConfig.databaseURL.includes("your-project");
