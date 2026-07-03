// ============================================================
// Firebase web app config — paste yours here.
//
// Get it from: Firebase console > Project settings > General >
// "Your apps" > Web app > SDK setup and configuration (Config).
// This snippet is safe to embed client-side; access control is
// enforced by Firestore security rules, not by hiding this.
//
// Until you paste a real config, the app runs in "device-only"
// mode: everything works, but data saves to this browser only
// and does not sync between devices.
// ============================================================
export const firebaseConfig = {
  apiKey: "PASTE_API_KEY",
  authDomain: "PASTE_PROJECT_ID.firebaseapp.com",
  projectId: "PASTE_PROJECT_ID",
  storageBucket: "PASTE_PROJECT_ID.appspot.com",
  messagingSenderId: "PASTE_SENDER_ID",
  appId: "PASTE_APP_ID",
};

// Optional soft passcode gate for the party. Leave "" for an open
// link. This only deters casual visitors who stumble on the URL —
// real access control lives in the Firestore rules (see README).
export const APP_PASSCODE = "";
