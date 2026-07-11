// ═══════════════════════════════════════════════════════════
//  supabase-config.js — Global (no ES modules)
// ═══════════════════════════════════════════════════════════

const { createClient } = window.supabase;

const SUPABASE_URL  = "https://nzydnszrvckwvanvajza.supabase.co";
const SUPABASE_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im56eWRuc3pydmNrd3ZhbnZhanphIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODExNTExNzksImV4cCI6MjA5NjcyNzE3OX0.NFIbckcUjWQlHse8xrprqntXzlHF0XvPoeCTUNbAS34";

const supabaseClient = createClient(SUPABASE_URL, SUPABASE_ANON, {
  auth: {
    persistSession: true,
    storage: window.localStorage,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  }
});

// Expose on window so all scripts can access
window._supabaseClient = supabaseClient;

function getCurrentUser() {
  return supabaseClient.auth.getUser().then(({ data: { user } }) => user);
}

function onAuthChange(callback) {
  supabaseClient.auth.onAuthStateChange((_event, session) => {
    callback(session?.user ?? null);
  });
  supabaseClient.auth.getSession().then(({ data: { session } }) => {
    callback(session?.user ?? null);
  });
}

window.getCurrentUser = getCurrentUser;
window.onAuthChange   = onAuthChange;
