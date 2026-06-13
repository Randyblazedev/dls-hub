// ═══════════════════════════════════════════════════════════
//  supabase-config.js
//  Replace the placeholders below with YOUR Supabase
//  project credentials from:
//  https://app.supabase.com → Project Settings → API
//
//  Required HTML script tag (add BEFORE the module scripts):
//  <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
//
//  Required Supabase tables (create via SQL editor or dashboard):
//    users, posts, comments, chat_messages, dms, dm_messages
// ═══════════════════════════════════════════════════════════

const { createClient } = window.supabase;

// ▼▼▼ PASTE YOUR SUPABASE CREDENTIALS HERE ▼▼▼
const SUPABASE_URL  = "https://nzydnszrvckwvanvajza.supabase.co";       // e.g. https://xyzcompany.supabase.co
const SUPABASE_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im56eWRuc3pydmNrd3ZhbnZhanphIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODExNTExNzksImV4cCI6MjA5NjcyNzE3OX0.NFIbckcUjWQlHse8xrprqntXzlHF0XvPoeCTUNbAS34";   // anon/public key from Settings → API
// ▲▲▲ END OF SUPABASE CREDENTIALS ▲▲▲

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON, {
  auth: {
    persistSession: true,
    storage: window.localStorage,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  }
});

// ── Auth Helpers ─────────────────────────────────────────

/** Returns the currently signed-in Supabase user (or null) */
async function getCurrentUser() {
  const { data: { user } } = await supabase.auth.getUser();
  return user;
}

/** Subscribe to auth state changes. Callback receives (user | null). */
function onAuthChange(callback) {
  supabase.auth.onAuthStateChange((_event, session) => {
    callback(session?.user ?? null);
  });

  // Also fire once immediately with current state
  supabase.auth.getSession().then(({ data: { session } }) => {
    callback(session?.user ?? null);
  });
}

export { supabase, getCurrentUser, onAuthChange };
