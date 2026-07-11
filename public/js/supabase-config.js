// supabase-config.js — plain script, no ES modules
const { createClient } = window.supabase;

const SUPABASE_URL  = "https://nzydnszrvckwvanvajza.supabase.co";
const SUPABASE_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im56eWRuc3pydmNrd3ZhbnZhanphIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODExNTExNzksImV4cCI6MjA5NjcyNzE3OX0.NFIbckcUjWQlHse8xrprqntXzlHF0XvPoeCTUNbAS34";

const _supabase = createClient(SUPABASE_URL, SUPABASE_ANON, {
  auth: {
    persistSession: true,
    storage: window.localStorage,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  }
});

window._supabaseClient = _supabase;

window.onAuthChange = function(callback) {
  _supabase.auth.onAuthStateChange(function(_event, session) {
    callback(session ? session.user : null);
  });
  _supabase.auth.getSession().then(function(r) {
    callback(r.data.session ? r.data.session.user : null);
  });
};
