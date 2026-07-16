// ═══════════════════════════════════════════════════════════
//  DLS Hub Features v2 — New feature logic
//  SQL tables needed (run in Supabase SQL Editor):
//  See comments in this file
// ═══════════════════════════════════════════════════════════

/*
-- Run these in Supabase SQL Editor:
CREATE TABLE IF NOT EXISTS squads (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY, user_id text NOT NULL, username text,
  name text NOT NULL, formation text DEFAULT '4-4-2', players text, description text,
  image_url text, created_at timestamptz DEFAULT now()
);
ALTER TABLE squads ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public read" ON squads FOR SELECT USING (true);
CREATE POLICY "Auth insert" ON squads FOR INSERT WITH CHECK (auth.role() = 'authenticated');

CREATE TABLE IF NOT EXISTS prediction_matches (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY, team_a text NOT NULL, team_b text NOT NULL,
  match_date timestamptz, deadline timestamptz, score_a int, score_b int,
  resolved boolean DEFAULT false, created_by text, created_at timestamptz DEFAULT now()
);
ALTER TABLE prediction_matches ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public read" ON prediction_matches FOR SELECT USING (true);
CREATE POLICY "Auth insert" ON prediction_matches FOR INSERT WITH CHECK (auth.role() = 'authenticated');

CREATE TABLE IF NOT EXISTS predictions (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY, match_id uuid REFERENCES prediction_matches(id),
  user_id text NOT NULL, username text, score_a int NOT NULL, score_b int NOT NULL,
  points int DEFAULT 0, created_at timestamptz DEFAULT now(), UNIQUE(match_id, user_id)
);
ALTER TABLE predictions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public read" ON predictions FOR SELECT USING (true);
CREATE POLICY "Auth insert" ON predictions FOR INSERT WITH CHECK (auth.role() = 'authenticated');

CREATE TABLE IF NOT EXISTS potw_nominations (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY, player_name text NOT NULL, team text,
  rating numeric, reason text, user_id text NOT NULL, username text,
  votes_up int DEFAULT 0, votes_down int DEFAULT 0, week text NOT NULL, created_at timestamptz DEFAULT now()
);
ALTER TABLE potw_nominations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public read" ON potw_nominations FOR SELECT USING (true);
CREATE POLICY "Auth insert" ON potw_nominations FOR INSERT WITH CHECK (auth.role() = 'authenticated');

CREATE TABLE IF NOT EXISTS reports (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY, reported_by text NOT NULL, content_type text NOT NULL,
  content_id text NOT NULL, reason text NOT NULL, status text DEFAULT 'pending', created_at timestamptz DEFAULT now()
);
ALTER TABLE reports ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Auth insert" ON reports FOR INSERT WITH CHECK (auth.role() = 'authenticated');
CREATE POLICY "Auth read" ON reports FOR SELECT USING (auth.role() = 'authenticated');

ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS imageurl text;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS reactions jsonb DEFAULT '{}';
*/

const ADMIN_EMAILS = ['asonganyirandy143@gmail.com']; // fallback only; real gate is DB is_admin + RLS
function isAdmin() { return !!(window.currentUserDoc && window.currentUserDoc.is_admin); }

// Chat image functions (sendChatMessage is now in app.js with image support)
window.previewChatImage = function(e) {
  var file = e.target.files[0]; if (!file) return;
  window._pendingChatImage = file;
  var reader = new FileReader();
  reader.onload = function(ev) { document.getElementById('chat-preview-img').src = ev.target.result; document.getElementById('chat-image-preview').classList.remove('hidden'); };
  reader.readAsDataURL(file);
};
window.removeChatImage = function() {
  window._pendingChatImage = null;
  if (document.getElementById('chat-image-input')) document.getElementById('chat-image-input').value = '';
  if (document.getElementById('chat-image-preview')) document.getElementById('chat-image-preview').classList.add('hidden');
};

// Themed confirm modal
window.showConfirm = function(msg) {
  return new Promise(function(resolve) {
    var modal = document.getElementById('confirm-modal');
    var msgEl = document.getElementById('confirm-msg');
    var okBtn = document.getElementById('confirm-ok');
    var cancelBtn = document.getElementById('confirm-cancel');
    if (!modal) { resolve(confirm(msg)); return; }
    msgEl.textContent = msg;
    modal.classList.remove('hidden');
    function cleanup(result) {
      modal.classList.add('hidden');
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      resolve(result);
    }
    function onOk() { cleanup(true); }
    function onCancel() { cleanup(false); }
    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
  });
};

// ═══ PUBLIC PROFILES ═══
let publicProfileData = null;
window.viewPublicProfile = async function(userId) {
  if (!window.currentUser) { window.navigate('login'); return; }
  try {
    const { data: user } = await window.supabase.from('users').select('*').eq('uid', userId).single();
    if (!user) { window.showToast('User not found', 'error'); return; }
    publicProfileData = user;
    document.getElementById('pub-avatar').src = user.avatar || 'https://ui-avatars.com/api/?name=' + encodeURIComponent(user.username) + '&background=0f1f17&color=b5ff47';
    document.getElementById('pub-username').textContent = user.username;
    document.getElementById('pub-team').textContent = user.team ? '⚽ ' + user.team : '';
    document.getElementById('pub-bio').textContent = user.bio || '';
    document.getElementById('pub-joined').textContent = user.joinedat ? 'Joined ' + window.timeAgo(new Date(user.joinedat)) : '';
    const { count } = await window.supabase.from('posts').select('*', { count: 'exact', head: true }).eq('authorid', userId);
    document.getElementById('pub-postcount').textContent = (count || 0) + ' posts';
    const container = document.getElementById('pub-posts'); container.innerHTML = '';
    const { data: posts } = await window.supabase.from('posts').select('*').eq('authorid', userId).order('created_at', { ascending: false }).limit(20);
    if (!posts || !posts.length) container.innerHTML = '<p class="text-mist text-sm">No posts yet.</p>';
    else { posts.forEach(p => { container.innerHTML += window.buildPostCard(p.id, p, true); }); lucide.createIcons(); }
    window.navigate('profile-public');
  } catch (err) { window.showToast('Failed to load profile', 'error'); }
};
window.dmFromPublicProfile = function() { if (publicProfileData) window.openDMFromPost(publicProfileData.uid, publicProfileData.username); };

// ═══ CLICKABLE USERNAMES ═══
function makeUsernamesClickable() {
  document.querySelectorAll('.comment-item .text-lime.text-xs.font-medium').forEach(el => {
    if (el.dataset.clickable) return; el.dataset.clickable = '1'; el.style.cursor = 'pointer';
    el.onclick = async () => { const { data } = await window.supabase.from('users').select('uid').eq('username', el.textContent.trim()).single(); if (data) viewPublicProfile(data.uid); };
  });
}
setInterval(makeUsernamesClickable, 2000);

// ═══ SHARE POST LINK ═══
window.sharePost = function(postId) {
  const url = window.location.origin + window.location.pathname + '?post=' + postId;
  navigator.clipboard.writeText(url).then(() => window.showToast('Link copied! 📋')).catch(() => window.showToast('Failed to copy', 'error'));
};
(function checkPostUrl() {
  const params = new URLSearchParams(window.location.search);
  const postId = params.get('post');
  if (postId) { setTimeout(() => { window.navigate('feed'); setTimeout(() => { const el = document.getElementById('post-' + postId); if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.classList.add('ring-2', 'ring-lime'); } }, 500); }, 500); }
})();

// ═══ EMOJI REACTIONS ═══
const REACTION_EMOJIS = ['🔥', '⚽', '💯', '👏', '❤️'];
window.toggleReaction = async function(postId, emoji) {
  if (!window.currentUser) { window.showToast('Log in to react', 'error'); return; }
  try {
    const { data: post } = await window.supabase.from('posts').select('reactions').eq('id', postId).single();
    let reactions = (post && post.reactions) || {};
    if (!reactions[emoji]) reactions[emoji] = [];
    if (reactions[emoji].includes(window.currentUser.id)) reactions[emoji] = reactions[emoji].filter(id => id !== window.currentUser.id);
    else reactions[emoji].push(window.currentUser.id);
    await window.supabase.from('posts').update({ reactions }).eq('id', postId);
    var c = document.getElementById('reactions-' + postId);
    if (c) renderReactions(c, postId, reactions);
  } catch (_) {}
};
function renderReactions(container, postId, reactions) {
  container.innerHTML = REACTION_EMOJIS.map(function(emoji) {
    var users = (reactions && reactions[emoji]) || []; var count = users.length;
    var active = window.currentUser && users.includes(window.currentUser.id);
    var cls = active ? 'bg-lime/20 text-lime border border-lime/40' : 'bg-turf border border-line text-mist hover:border-lime/30';
    return '<button data-action="toggle-reaction" data-post-id="' + window.escAttr(postId) + '" data-emoji="' + window.escAttr(emoji) + '" class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs transition ' + cls + '"><span>' + emoji + '</span>' + (count ? '<span>' + count + '</span>' : '') + '</button>';
  }).join('');
}
document.addEventListener('click', function(e) {
  var btn = e.target.closest('[data-action="toggle-reaction"]');
  if (btn) window.toggleReaction(btn.dataset.postId, btn.dataset.emoji);
});

// ═══ REPORT ═══
window.reportContent = async function(type, id) {
  if (!window.currentUser) { window.showToast('Log in to report', 'error'); return; }
  var reasons = ['Spam', 'Harassment', 'Inappropriate', 'Other'];
  var reason = prompt('Report reason:\n' + reasons.map(function(r,i) { return (i+1) + '. ' + r; }).join('\n') + '\nEnter 1-4:');
  if (!reason || reason < 1 || reason > 4) return;
  try {
    await window.supabase.from('reports').insert({ reported_by: window.currentUser.id, content_type: type, content_id: id, reason: reasons[reason - 1], created_at: new Date().toISOString() });
    window.showToast('Report submitted ✅');
  } catch (_) { window.showToast('Failed to report', 'error'); }
};

// ═══ ONLINE PRESENCE ═══
var featurePresenceChannel = null;
window.onlineUserIds = new Set(); // exposed globally for leaderboard/feed blue dots

function initPresence() {
  if (!window.currentUser || featurePresenceChannel) return;
  featurePresenceChannel = window.supabase.channel('online-users', { config: { presence: { key: window.currentUser.id } } });
  featurePresenceChannel.on('presence', { event: 'sync' }, function() {
    var state = featurePresenceChannel.presenceState();
    // Update global online set
    window.onlineUserIds = new Set(
      Object.values(state).flatMap(function(arr) {
        return arr.map(function(p) { return p.user_id; });
      })
    );
    var count = window.onlineUserIds.size;
    var el = document.getElementById('online-count');
    var num = document.getElementById('online-num');
    var others = count - 1;
    if (el && num) { num.textContent = others < 0 ? 0 : others; el.classList.toggle('hidden', others < 1); }
    // Refresh blue dots on leaderboard if it's currently visible
    if (document.getElementById('leaderboard-body')) updateLeaderboardDots();
  });
  featurePresenceChannel.subscribe(function(status) {
    if (status === 'SUBSCRIBED') featurePresenceChannel.track({ user_id: window.currentUser.id, username: window.currentUserDoc && window.currentUserDoc.username, online_at: new Date().toISOString() });
  });
}

function updateLeaderboardDots() {
  document.querySelectorAll('.lb-online-dot').forEach(function(dot) {
    var uid = dot.dataset.uid;
    dot.classList.toggle('hidden', !window.onlineUserIds.has(uid));
  });
}

// FIX: previously nothing ever untracked/removed the channel on sign-out,
// so (a) signed-out users kept showing as "online" until the tab closed, and
// (b) initPresence()'s guard blocked ever re-creating the channel for the
// next person who logged into the same tab.
window.cleanupPresence = function () {
  if (featurePresenceChannel) {
    featurePresenceChannel.untrack();
    window.supabase.removeChannel(featurePresenceChannel);
    featurePresenceChannel = null;
  }
  var el = document.getElementById('online-count');
  if (el) el.classList.add('hidden');
};

// ═══ ADMIN ═══
async function initAdmin() {
  var ac = document.getElementById('admin-content');
  if (!ac) return;
  if (!isAdmin()) { ac.innerHTML = '<p class="text-coral text-center py-12">Access denied. Admin only.</p>'; return; }
  try {
    var r1 = await window.supabase.from('public_profiles').select('*', { count: 'exact', head: true });
    var r2 = await window.supabase.from('posts').select('*', { count: 'exact', head: true });
    var r3 = await window.supabase.from('chat_messages').select('*', { count: 'exact', head: true });
    var r4 = await window.supabase.from('reports').select('*').order('created_at', { ascending: false }).limit(20);
    var stats = document.getElementById('admin-stats');
    if (stats) {
      var items = [{ l: 'Users', v: r1.count||0, i: 'users' }, { l: 'Posts', v: r2.count||0, i: 'file-text' }, { l: 'Messages', v: r3.count||0, i: 'message-square' }, { l: 'Reports', v: (r4.data||[]).length, i: 'flag' }];
      stats.innerHTML = items.map(function(s) { return '<div class="bg-turf border border-line rounded-xl p-4 text-center"><i data-lucide="' + s.i + '" class="w-6 h-6 mx-auto text-lime mb-2"></i><p class="text-ice font-display text-2xl">' + s.v + '</p><p class="text-mist text-xs">' + s.l + '</p></div>'; }).join('');
    }
    var rl = document.getElementById('admin-reports');
    if (rl) {
      var reports = r4.data || [];
      // SECURITY: report_id/content_id/content_type/reason are all rendered
      // as escAttr() data-* values, never concatenated into onclick JS strings.
      rl.innerHTML = reports.length ? reports.map(function(r) {
        return '<div class="flex items-center justify-between py-3 border-b border-line"><div><p class="text-ice text-sm">' + window.escHtml(r.reason) + ' on ' + window.escHtml(r.content_type) + '</p><p class="text-mist text-xs">' + window.escHtml(r.content_id) + ' · ' + window.timeAgo(new Date(r.created_at)) + '</p></div><button data-action="dismiss-report" data-report-id="' + window.escAttr(r.id) + '" class="text-mist text-xs hover:text-coral">Dismiss</button></div>';
      }).join('') : '<p class="text-mist text-sm">No reports.</p>';
    }

    // All posts (admin can see and delete any post's full text)
    var pl = document.getElementById('admin-posts');
    if (pl) {
      var pr = await window.supabase.from('posts').select('*').order('created_at', { ascending: false }).limit(50);
      var posts = pr.data || [];
      pl.innerHTML = posts.length ? posts.map(function(p) {
        return '<div class="flex items-start justify-between gap-3 py-2 border-b border-line"><div class="min-w-0"><p class="text-lime text-xs font-medium">' + window.escHtml(p.authorname) + '</p><p class="text-ice text-sm break-words">' + window.escHtml(p.content || '') + '</p></div><button data-action="admin-delete-post" data-post-id="' + window.escAttr(p.id) + '" class="text-coral text-xs hover:text-white shrink-0"><i data-lucide="trash-2" class="w-3.5 h-3.5"></i></button></div>';
      }).join('') : '<p class="text-mist text-sm">No posts.</p>';
    }

    // Recent chat messages (admin can see and delete any message's full text)
    var ml = document.getElementById('admin-messages');
    if (ml) {
      var mr = await window.supabase.from('chat_messages').select('*').order('created_at', { ascending: false }).limit(50);
      var msgs = mr.data || [];
      ml.innerHTML = msgs.length ? msgs.map(function(m) {
        return '<div class="flex items-start justify-between gap-3 py-2 border-b border-line"><div class="min-w-0"><p class="text-lime text-xs font-medium">' + window.escHtml(m.authorname) + '</p><p class="text-ice text-sm break-words">' + window.escHtml(m.content || '') + '</p></div><button data-action="admin-delete-chat" data-msg-id="' + window.escAttr(m.id) + '" class="text-coral text-xs hover:text-white shrink-0"><i data-lucide="trash-2" class="w-3.5 h-3.5"></i></button></div>';
      }).join('') : '<p class="text-mist text-sm">No messages.</p>';
    }

    // Users: ban/unban and remove — username/uid go through data-* attrs only,
    // NEVER concatenated into an onclick="..." string (that was the XSS hole:
    // a malicious username could break out of the attribute and execute as JS
    // the moment an admin viewed this panel).
    var ul = document.getElementById('admin-users');
    if (ul) {
      var ur = await window.supabase.from('users').select('uid, username, email, banned, is_admin').order('joinedat', { ascending: false }).limit(100);
      var users = ur.data || [];
      ul.innerHTML = users.length ? users.map(function(u) {
        var meTag = u.is_admin ? ' <span class="text-lime text-xs">(admin)</span>' : '';
        var bannedTag = u.banned ? ' <span class="text-coral text-xs">(banned)</span>' : '';
        var banBtn = u.is_admin ? '' : (u.banned
          ? '<button data-action="admin-unban" data-uid="' + window.escAttr(u.uid) + '" class="text-lime text-xs hover:underline mr-3">Unban</button>'
          : '<button data-action="admin-ban" data-uid="' + window.escAttr(u.uid) + '" class="text-mist text-xs hover:text-coral mr-3">Ban</button>');
        var removeBtn = u.is_admin ? '' : '<button data-action="admin-remove" data-uid="' + window.escAttr(u.uid) + '" data-username="' + window.escAttr(u.username) + '" class="text-coral text-xs hover:text-white">Remove</button>';
        return '<div class="flex items-center justify-between py-2.5 border-b border-line"><div class="min-w-0"><p class="text-ice text-sm">' + window.escHtml(u.username) + meTag + bannedTag + '</p><p class="text-mist text-xs truncate">' + window.escHtml(u.email || '') + '</p></div><div class="shrink-0">' + banBtn + removeBtn + '</div></div>';
      }).join('') : '<p class="text-mist text-sm">No users.</p>';
    }

    lucide.createIcons();
  } catch (err) { console.error('ADMIN LOAD ERROR:', err); }
}

// Single delegated click listener for the whole admin panel — reads
// data-action + data-* values (never re-parsed as JS, unlike onclick
// string concatenation) and dispatches to the right handler.
document.addEventListener('click', function(e) {
  var btn = e.target.closest('[data-action]');
  if (!btn || !document.getElementById('admin-content')?.contains(btn)) return;
  var action = btn.dataset.action;
  if (action === 'dismiss-report')     window.dismissReport(btn.dataset.reportId);
  if (action === 'admin-delete-post')  window.adminDeletePost(btn.dataset.postId);
  if (action === 'admin-delete-chat')  window.adminDeleteChatMessage(btn.dataset.msgId);
  if (action === 'admin-ban')          window.adminBanUser(btn.dataset.uid);
  if (action === 'admin-unban')        window.adminUnbanUser(btn.dataset.uid);
  if (action === 'admin-remove')       window.adminRemoveUser(btn.dataset.uid, btn.dataset.username);
});

window.dismissReport = async function(id) { await window.supabase.from('reports').delete().eq('id', id); window.showToast('Dismissed'); initAdmin(); };

window.adminDeletePost = async function(id) {
  if (!isAdmin()) return;
  if (!await window.showConfirm('Delete this post?')) return;
  var { error } = await window.supabase.from('posts').delete().eq('id', id);
  if (error) { window.showToast('Failed to delete', 'error'); return; }
  window.showToast('Post deleted'); initAdmin();
};

window.adminDeleteChatMessage = async function(id) {
  if (!isAdmin()) return;
  if (!await window.showConfirm('Delete this message?')) return;
  var { error } = await window.supabase.from('chat_messages').delete().eq('id', id);
  if (error) { window.showToast('Failed to delete', 'error'); return; }
  window.showToast('Message deleted'); initAdmin();
};

window.adminBanUser = async function(uid) {
  if (!isAdmin()) return;
  if (!await window.showConfirm('Ban this user? They will be signed out and unable to post, comment, or chat.')) return;
  var { error } = await window.supabase.from('users').update({ banned: true }).eq('uid', uid);
  if (error) { window.showToast('Failed to ban', 'error'); return; }
  // Kick them out immediately (don't wait for their next login attempt)
  if (window.broadcastBanEvent) window.broadcastBanEvent(uid);
  // Refresh the visible Managers count right away
  if (window.loadHomeStats) window.loadHomeStats();
  window.showToast('User banned'); initAdmin();
};

window.adminUnbanUser = async function(uid) {
  if (!isAdmin()) return;
  var { error } = await window.supabase.from('users').update({ banned: false }).eq('uid', uid);
  if (error) { window.showToast('Failed to unban', 'error'); return; }
  if (window.loadHomeStats) window.loadHomeStats();
  window.showToast('User unbanned'); initAdmin();
};

// Removes a user's content site-wide and bans them so they can't return
// and immediately repost. NOTE: this cannot delete their actual login
// account — Supabase only allows that via the service_role key (server-side
// only, e.g. an Edge Function), never from the browser's anon/authenticated
// key, by design. To fully delete the account, use the Supabase dashboard:
// Authentication → Users → Delete.
window.adminRemoveUser = async function(uid, username) {
  if (!isAdmin()) return;
  if (!await window.showConfirm('Remove ' + username + '? This deletes all their posts, comments, chat messages, and DMs, and bans the account. This does not delete their login — do that from the Supabase dashboard if needed.')) return;
  try {
    await window.supabase.from('posts').delete().eq('authorid', uid);
    await window.supabase.from('comments').delete().eq('authorid', uid);
    await window.supabase.from('chat_messages').delete().eq('authorid', uid);
    await window.supabase.from('dm_messages').delete().eq('senderid', uid);
    await window.supabase.from('users').update({ banned: true }).eq('uid', uid);
    // Kick them out immediately and refresh the count
    if (window.broadcastBanEvent) window.broadcastBanEvent(uid);
    if (window.loadHomeStats) window.loadHomeStats();
    window.showToast('User removed and banned');
    initAdmin();
  } catch (err) {
    window.showToast('Failed to fully remove user', 'error');
  }
};

// ═══ BOOTSTRAP ═══
// Wait for app.js module to load (defer < module timing)
function waitForAppReady(cb) {
  if (window.onAuthChange && window.supabase) { cb(); return; }
  var tries = 0;
  var check = setInterval(function() {
    tries++;
    if ((window.onAuthChange && window.supabase) || tries > 100) { clearInterval(check); cb(); }
  }, 100);
}
function waitForUser(cb, tries) {
  tries = tries || 0;
  if (window.currentUser) { cb(); return; }
  if (tries > 50) { cb(); return; }
  setTimeout(function() { waitForUser(cb, tries + 1); }, 200);
}
document.addEventListener('DOMContentLoaded', function() {
  waitForAppReady(function() {
    waitForUser(function() {
      // Init presence if already logged in
      if (window.currentUser) initPresence();
      // Watch for auth changes
      window.onAuthChange(function(user) {
        if (user) setTimeout(initPresence, 500);
      });
    });
  });
});

// ═══════════════════════════════════════════════════════════
//  ⚔️ Challenges System (Supabase Points + Credit)
//  Users bet 1-5 points. AI determines winner. Debts tracked.
// ═══════════════════════════════════════════════════════════

let challs = [];
let challSSData = null;
let challActiveId = null;
let challUserPoints = 0;

async function loadChalls() {
  // Try Supabase first, fallback to localStorage
  if (window._supabaseClient) {
    try {
      const { data, error } = await window._supabaseClient
        .from('challenges')
        .select('*')
        .order('created_at', { ascending: false });
      if (!error && data) challs = data;
    } catch { /* fallback to localStorage */ }
  }
  renderChalls();
  loadUserPoints();
}

async function loadUserPoints() {
  const user = window.currentUser;
  if (!user || !window._supabaseClient) { challUserPoints = 5; return; }
  try {
    const { data } = await window._supabaseClient
      .from('users')
      .select('points')
      .eq('username', user.username || user.email)
      .single();
    challUserPoints = data?.points ?? 0;
    document.getElementById('chall-my-points').textContent = challUserPoints;
  } catch { challUserPoints = 5; }
}

async function saveChalls() {
  // Challenges saved to Supabase automatically via direct inserts
}

async function renderChalls() {
  const list = document.getElementById('chall-list');
  if (!list) return;
  const sorted = [...challs].sort((a,b) => b.created - a.created);
  document.getElementById('chall-active').textContent = challs.filter(c => c.status==='pending'||c.status==='playing').length;
  document.getElementById('chall-completed').textContent = challs.filter(c => c.status==='done').length;
  document.getElementById('chall-total').textContent = challs.reduce((s,c) => s+c.bet, 0);
  if (!sorted.length) { list.innerHTML = '<div class="text-center py-12 text-mist"><p class="text-3xl mb-2">⚔️</p><p>No challenges yet</p></div>'; return; }
  list.innerHTML = sorted.map(c => {
    const ago = Math.floor((Date.now()-c.created)/3600000);
    const timeStr = ago < 1 ? 'Just now' : ago < 24 ? ago+'h ago' : Math.floor(ago/24)+'d ago';
    const labels = { pending:'🔓 Pending', playing:'⏳ Playing', submitted:'📸 Submitted', done:'✅ Done' };
    const colors = { pending:'lime', playing:'yellow-400', submitted:'blue-400', done:'purple-400' };
    let act = '';
    if (c.status === 'pending') act = `<button class="btn-lime text-xs px-3 py-1" onclick="acceptChall('${c.id}')">Accept</button>`;
    else if (c.status === 'playing') act = `<button class="btn-ghost text-xs px-3 py-1" onclick="openChSS('${c.id}')">📸 Submit Result</button>`;
    else if (c.status === 'submitted') act = `<button class="btn-lime text-xs px-3 py-1" onclick="confirmChall('${c.id}')">✅ Confirm</button>`;
    return `<div class="bg-turf border border-line rounded-xl p-4 mb-2 hover:border-lime/20 transition">
      <div class="flex items-center justify-between gap-3">
        <div class="font-bold text-ice text-sm">${c.team1} <span class="text-mist font-normal">vs</span> ${c.team2}</div>
        <div class="text-yellow-400 font-extrabold text-sm">🪙 ${c.bet} pt${c.bet>1?'s':''}</div>
      </div>
      <div class="flex items-center gap-3 mt-2 text-xs text-mist flex-wrap">
        <span class="text-${colors[c.status]} font-semibold">${labels[c.status]||c.status}</span>
        <span>🕐 ${timeStr}</span>
        ${c.winner ? '<span>🏆 '+c.winner+'</span>' : ''}
        ${c.gameCode ? '<span>🔑 '+c.gameCode+'</span>' : ''}
        ${c.submittedBy ? '<span>📸 by '+c.submittedBy+'</span>' : ''}
        ${c.confirmedBy ? '<span>✅ by '+c.confirmedBy+'</span>' : ''}
        <span class="flex-1"></span>${act}
      </div>
    </div>`;
  }).join('');
}

function openChallengeModal() {
  document.getElementById('chall-modal').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}
function closeChallengeModal() {
  document.getElementById('chall-modal').classList.add('hidden');
  document.body.style.overflow = '';
}

function createChallenge() {
  const t1 = document.getElementById('ch-myteam').value.trim();
  const bet = parseInt(document.getElementById('ch-bet').value);
  const rules = document.getElementById('ch-rules').value.trim();
  if (!t1 || bet < 1 || bet > 5) { alert('Enter your team name. Bet between 1-5 points.'); return; }
  const creator = prompt('Enter your name/username:');
  if (!creator || !creator.trim()) return;
  challs.push({ id:'ch-'+Date.now().toString(36), team1:t1, team2:'TBD', bet, rules, status:'pending', created:Date.now(), winner:null, verifiedBy:null, createdBy: creator.trim() });
  saveChalls(); closeChallengeModal(); renderChalls();
  document.getElementById('ch-myteam').value=''; document.getElementById('ch-bet').value='3'; document.getElementById('ch-rules').value='';
}

// Accept: opponent confirms the challenge
function acceptChall(id) {
  const c = challs.find(x => x.id === id);
  if (!c) return;
  const acceptor = prompt('Enter your name/username:');
  if (!acceptor || !acceptor.trim()) return;
  if (c.createdBy && c.createdBy.toLowerCase() === acceptor.trim().toLowerCase()) {
    alert('You cannot accept your own challenge!');
    return;
  }
  const theirTeam = prompt('Enter YOUR exact DLS team name:');
  if (!theirTeam || !theirTeam.trim()) return;
  
  // Game code: the acceptor creates/enters a match code
  const gameCode = prompt('Create a game code for this match (share with opponent):', Math.random().toString(36).slice(2,8).toUpperCase());
  if (!gameCode || !gameCode.trim()) return;
  
  c.status = 'playing';
  c.team2 = theirTeam.trim();
  c.acceptedBy = acceptor.trim();
  c.gameCode = gameCode.trim().toUpperCase();
  saveChalls(); renderChalls();
  
  // In-app notification
  showToast('⚔️ Challenge accepted! Game code: ' + c.gameCode);
  
  // Try sending push notification if supported
  notifyChallengeAccepted(c);
}

// Request notification permission & send push
async function notifyChallengeAccepted(c) {
  if (!('Notification' in window)) return;
  const perm = await Notification.requestPermission();
  if (perm === 'granted') {
    new Notification('⚔️ Challenge Accepted!', {
      body: c.acceptedBy + ' accepted your challenge! Game code: ' + c.gameCode,
      icon: '/public/icons/icon-192.png',
      tag: 'challenge-' + c.id
    });
  }
}

// Request notification permission on first visit
if ('Notification' in window && Notification.permission === 'default') {
  setTimeout(() => Notification.requestPermission(), 5000);
}

// Submit result: one player uploads screenshot + declares winner
function openChSS(id) {
  challActiveId = id;
  challSSData = null;
  document.getElementById('ch-ss-preview').style.display = 'none';
  document.getElementById('ch-ss-input').value = '';
  document.getElementById('chall-ss-modal').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}
function closeSSModal() {
  document.getElementById('chall-ss-modal').classList.add('hidden');
  document.body.style.overflow = '';
}
function previewChSS(e) {
  const f = e.target.files[0];
  if (!f) return;
  const r = new FileReader();
  r.onload = ev => { challSSData = ev.target.result; document.getElementById('ch-ss-img').src = challSSData; document.getElementById('ch-ss-preview').style.display = 'block'; };
  r.readAsDataURL(f);
}

// AI Vision is now part of submitChResult() below

async function submitChResult() {
  if (!challActiveId || !challSSData) { alert('Upload a screenshot first!'); return; }
  const c = challs.find(x => x.id === challActiveId);
  if (!c) return;

  // Auto-analyze with AI to make final decision
  const btn = document.getElementById('submit-final-btn');
  btn.disabled = true;
  btn.textContent = '🤖 AI Deciding...';

  try {
    const AI_URL = 'https://keith-switching-meaning-calculate.trycloudflare.com/api/vision/analyze';
    const res = await fetch(AI_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        image: challSSData, 
        prompt: 'This is a Dream League Soccer match result screen. The two teams playing are: ' + c.team1 + ' vs ' + c.team2 + '. Look carefully at the screen and tell me: which team won? Return ONLY a JSON with keys: winner, loser, homeScore, awayScore.'
      })
    });
    const data = await res.json();

    if (data.winner) {
      // Case-insensitive match: compare AI winner against both team names
      const aiWinner = data.winner.trim();
      const matchT1 = c.team1 && c.team1.toLowerCase() === aiWinner.toLowerCase();
      const matchT2 = c.team2 && c.team2.toLowerCase() === aiWinner.toLowerCase();
      
      if (!matchT1 && !matchT2) {
        // AI returned a name that doesn't match either team
        alert('AI detected "' + aiWinner + '" as winner, but it doesn\'t match ' + c.team1 + ' or ' + c.team2 + '. Enter manually.');
        const manual = prompt('Enter the WINNING team name (as shown on screen):');
        if (manual && manual.trim()) {
          c.status = 'done';
          c.winner = manual.trim();
          c.score = (data.homeScore || '?') + '-' + (data.awayScore || '?');
          c.verifiedBy = 'AI';
          saveChalls(); closeSSModal(); renderChalls();
        }
      } else {
        c.status = 'done';
        // Use the EXACT name from the challenge (preserving the user's casing)
        c.winner = matchT1 ? c.team1 : c.team2;
        c.score = (data.homeScore || '?') + '-' + (data.awayScore || '?');
        c.verifiedBy = 'AI';
        saveChalls();
        closeSSModal();
        renderChalls();
        alert('🏆 ' + c.winner + ' wins! Points assigned.');
      }
    } else {
      // AI couldn't read it - manual fallback
      const manual = prompt('AI could not read result. Enter the WINNING team name manually:');
      if (manual && manual.trim()) {
        c.status = 'done';
        c.winner = manual.trim();
        c.verifiedBy = 'Manual';
        saveChalls();
        closeSSModal();
        renderChalls();
      }
    }
  } catch (e) {
    // AI offline - manual fallback
    const manual = prompt('AI offline. Enter the WINNING team name manually:');
    if (manual && manual.trim()) {
      c.status = 'done';
      c.winner = manual.trim();
      c.verifiedBy = 'Manual';
      saveChalls();
      closeSSModal();
      renderChalls();
    }
  }

  btn.disabled = false;
  btn.textContent = '🏆 Submit & Auto-Verify';
}

// Confirm: other player agrees with the result
function confirmChall(id) {
  const c = challs.find(x => x.id === id);
  if (!c) return;
  const name = prompt('Enter your name to confirm:');
  if (!name || !name.trim()) return;
  c.status = 'done';
  c.confirmedBy = name.trim();
  saveChalls(); renderChalls();
}

document.addEventListener('DOMContentLoaded', () => {
  if (document.getElementById('chall-list')) loadChalls();
});
