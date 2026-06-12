// ═══════════════════════════════════════════════════════════
//  firebase-config.js
//  Replace the firebaseConfig object below with YOUR Firebase
//  project credentials from:
//  https://console.firebase.google.com → Project Settings → General
// ═══════════════════════════════════════════════════════════

import { initializeApp }                from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getAuth }                       from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { getFirestore }                  from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { getStorage }                    from "https://www.gstatic.com/firebasejs/10.12.0/firebase-storage.js";

// ▼▼▼ PASTE YOUR FIREBASE CONFIG HERE ▼▼▼
const firebaseConfig = {
  apiKey:            "YOUR_API_KEY",
  authDomain:        "YOUR_PROJECT.firebaseapp.com",
  projectId:         "YOUR_PROJECT_ID",
  storageBucket:     "YOUR_PROJECT.appspot.com",
  messagingSenderId: "YOUR_SENDER_ID",
  appId:             "YOUR_APP_ID"
};
// ▲▲▲ END OF FIREBASE CONFIG ▲▲▲

const app     = initializeApp(firebaseConfig);
const auth    = getAuth(app);
const db      = getFirestore(app);
const storage = getStorage(app);

// Export so app.js can import them
export { auth, db, storage };
