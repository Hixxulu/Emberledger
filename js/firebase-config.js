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
  apiKey: "AIzaSyCmU-kTNMbEEm1Q6d5cr6bYxYfKbLbohPU",
  authDomain: "emberledger.firebaseapp.com",
  projectId: "emberledger",
  storageBucket: "emberledger.firebasestorage.app",
  messagingSenderId: "983957154368",
  appId: "1:983957154368:web:2ba2fa745d06377af30da5",
};

// Optional soft passcode gate for the party. Leave "" for an open
// link. This only deters casual visitors who stumble on the URL —
// real access control lives in the Firestore rules (see README).
export const APP_PASSCODE = "dorvus";
