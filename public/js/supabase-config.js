// ═══════════════════════════════════════════════════════════
//  supabase-config.js
// ═══════════════════════════════════════════════════════════

const SUPABASE_URL  = "https://nzydnszrvckwvanvajza.supabase.co";
const SUPABASE_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im56eWRuc3pydmNrd3ZhbnZhanphIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODExNTExNzksImV4cCI6MjA5NjcyNzE3OX0.NFIbckcUjWQlHse8xrprqntXzlHF0XvPoeCTUNbAS34";

// The CDN exposes createClient on window.supabase
const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON, {
  auth: {
    persistSession: true,
    storage: window.localStorage,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  }
});

// Expose globally for all scripts
window._supabaseClient = supabaseClient;

window.getCurrentUser = function() {
  return supabaseClient.auth.getUser().then(function(r) { return r.data.user; });
};

window.onAuthChange = function(callback) {
  supabaseClient.auth.onAuthStateChange(function(_event, session) {
    callback(session ? session.user : null);
  });
  supabaseClient.auth.getSession().then(function(r) {
    callback(r.data.session ? r.data.session.user : null);
  });
};
