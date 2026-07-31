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
var _reportType = null;
var _reportId = null;
window.reportContent = function(type, id) {
  if (!window.currentUser) { window.showToast('Log in to report', 'error'); return; }
  _reportType = type;
  _reportId = id;
  var modal = document.getElementById('report-modal');
  var label = document.getElementById('report-target-label');
  if (label) label.textContent = 'Reporting ' + type;
  document.querySelectorAll('input[name="report-reason"]').forEach(function(r) { r.checked = false; });
  if (modal) modal.classList.remove('hidden');
};
window.closeReportModal = function() {
  var modal = document.getElementById('report-modal');
  if (modal) modal.classList.add('hidden');
  _reportType = null;
  _reportId = null;
};
window.submitReport = async function() {
  var selected = document.querySelector('input[name="report-reason"]:checked');
  if (!selected) { window.showToast('Please select a reason', 'error'); return; }
  var reason = selected.value;
  try {
    await window.supabase.from('reports').insert({ reported_by: window.currentUser.id, content_type: _reportType, content_id: _reportId, reason: reason, created_at: new Date().toISOString() });
    window.showToast('Report submitted ✅');
    window.closeReportModal();
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
    if (status === 'SUBSCRIBED') {
      featurePresenceChannel.track({ user_id: window.currentUser.id, username: window.currentUserDoc && window.currentUserDoc.username, online_at: new Date().toISOString() });
      // Update last_seen in users table
      window.supabase.from('users').update({ last_seen: new Date().toISOString() }).eq('uid', window.currentUser.id).then();
    }
  });
  // Also update last_seen periodically while user is active
  setInterval(function() {
    if (window.currentUser) {
      window.supabase.from('users').update({ last_seen: new Date().toISOString() }).eq('uid', window.currentUser.id).then();
    }
  }, 60000); // every minute
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

// ═══ POINTS DISPLAY ═══
window.updateNavPoints = function () {
  if (!window.currentUser) {
    var np = document.getElementById('nav-points');
    if (np) np.classList.add('hidden');
    return;
  }
  window.supabase.from('users').select('points').eq('uid', window.currentUser.id).single().then(function (res) {
    if (res.data) {
      var el = document.getElementById('nav-points-amount');
      if (el) el.textContent = res.data.points || 0;
      var np = document.getElementById('nav-points');
      if (np) np.classList.remove('hidden');
    }
  }).catch(function () {});
};

window.updateProfilePoints = function () {
  if (!window.currentUser) return;
  window.supabase.from('users').select('points').eq('uid', window.currentUser.id).single().then(function (res) {
    if (res.data) {
      var el = document.getElementById('profile-points-amount');
      if (el) el.textContent = res.data.points || 0;
    }
  }).catch(function () {});
};

// Hook into app.js onAuthChange by patching the navigate function
// to refresh points when user visits profile or tournament pages.
var origNavigate = window.navigate;
window.navigate = function (page) {
  if (origNavigate) origNavigate(page);
  if (page === 'profile') setTimeout(window.updateProfilePoints, 300);
  if (page === 'tournaments' || page === 'tournament-detail' || page === 'tournament-list') setTimeout(window.updateNavPoints, 300);
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
      if (window.currentUser) {
        initPresence();
        setTimeout(window.updateNavPoints, 500);
      }
      // Watch for auth changes
      window.onAuthChange(function(user) {
        if (user) {
          setTimeout(initPresence, 500);
          setTimeout(window.updateNavPoints, 1000);
        } else {
          var np = document.getElementById('nav-points');
          if (np) np.classList.add('hidden');
        }
      });
    });
  });
});

// ═══════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════
//  TOURNAMENT SYSTEM
// ═══════════════════════════════════════════════════════════

var _currentTournament = null;
var _currentTournamentFilter = 'all';

// ── TOURNAMENTS LIST ──
window.initTournamentsList = async function () {
  await loadTournaments();
};

window.switchTournamentFilter = async function (filter) {
  _currentTournamentFilter = filter;
  document.querySelectorAll('.tournament-filter').forEach(function (el) { el.classList.remove('tournament-filter-active'); });
  var btn = document.getElementById('tfilter-' + filter);
  if (btn) btn.classList.add('tournament-filter-active');
  await loadTournaments();
};

async function loadTournaments() {
  var container = document.getElementById('tournament-list');
  if (!container) return;
  container.innerHTML = '<div class="text-center text-mist py-12"><i data-lucide="loader" class="w-6 h-6 mx-auto animate-spin mb-2"></i>Loading tournaments...</div>';
  if (window.lucide) lucide.createIcons();

  try {
    var query = window.supabase.from('tournaments').select('*');
    if (_currentTournamentFilter !== 'all') {
      query = query.eq('status', _currentTournamentFilter);
    }
    query = query.order('created_at', { ascending: false }).limit(50);
    var { data, error } = await query;
    if (error) throw error;

    if (!data || !data.length) {
      container.innerHTML = '<div class="text-center py-12"><p class="text-mist text-sm">No tournaments found.</p><button onclick="openCreateTournamentModal()" class="btn-lime mt-4 px-5 py-2 text-sm">Create One</button></div>';
      return;
    }

    container.innerHTML = '';
    data.forEach(function (t) {
      var statusColors = { registration: 'bg-blue-500/20 text-blue-400', in_progress: 'bg-lime/20 text-lime', completed: 'bg-green-500/20 text-green-400', cancelled: 'bg-coral/20 text-coral' };
      var statusLabels = { registration: 'Open', in_progress: 'Live', completed: 'Finished', cancelled: 'Cancelled' };
      var sc = statusColors[t.status] || 'bg-mist/20 text-mist';
      var sl = statusLabels[t.status] || t.status;
      container.innerHTML += '<div class="tournament-card" onclick="openTournament(\'' + t.id + '\')">' +
        '<div class="flex items-start justify-between gap-4">' +
          '<div class="min-w-0 flex-1">' +
            '<h3 class="font-display text-xl text-ice truncate">' + window.escHtml(t.name) + '</h3>' +
            '<p class="text-mist text-sm mt-1">' + window.escHtml(t.game || 'DLS 25') + ' · ' + t.max_players + ' players max</p>' +
            (t.prize ? '<p class="text-lime text-sm mt-1">🏆 ' + window.escHtml(t.prize) + '</p>' : '') +
          '</div>' +
          '<div class="flex flex-col items-end gap-1 shrink-0">' +
            '<span class="inline-block px-3 py-0.5 rounded-full text-xs font-medium ' + sc + '">' + sl + '</span>' +
            (t.points_cost > 0 ? '<span class="text-lime text-xs font-medium">' + t.points_cost + ' pts</span>' : '<span class="text-mist text-xs">Free</span>') +
          '</div>' +
        '</div>' +
      '</div>';
    });
    if (window.lucide) lucide.createIcons();
  } catch (err) {
    container.innerHTML = '<p class="text-coral text-sm text-center py-12">Failed to load tournaments: ' + window.escHtml(err.message || '') + '</p>';
  }
}

// ── OPEN TOURNAMENT DETAIL ──
window.openTournament = function (tournamentId) {
  window._currentTournamentId = tournamentId;
  window.navigate('tournament-detail');
};

// ── TOURNAMENT DETAIL ──
window.initTournamentDetail = async function () {
  var tournamentId = window._currentTournamentId;
  if (!tournamentId) { window.navigate('tournaments'); return; }

  try {
    var { data: t, error } = await window.supabase.from('tournaments').select('*').eq('id', tournamentId).single();
    if (error || !t) { window.showToast('Tournament not found', 'error'); window.navigate('tournaments'); return; }
    _currentTournament = t;

    // Header
    document.getElementById('td-name').textContent = t.name;
    document.getElementById('td-game').textContent = t.game || 'DLS 25';
    document.getElementById('td-desc').textContent = t.description || '';
    document.getElementById('td-desc').classList.toggle('hidden', !t.description);
    document.getElementById('td-prize').textContent = t.prize ? '🏆 ' + t.prize : '';
    document.getElementById('td-fee').textContent = t.points_cost > 0 ? 'Entry fee: ' + t.points_cost + ' pts' : 'Free entry';

    var statusColors = { registration: 'bg-blue-500/20 text-blue-400', in_progress: 'bg-lime/20 text-lime', completed: 'bg-green-500/20 text-green-400', cancelled: 'bg-coral/20 text-coral' };
    var statusLabels = { registration: 'Registration Open', in_progress: 'In Progress', completed: 'Completed', cancelled: 'Cancelled' };
    var badge = document.getElementById('td-status-badge');
    badge.className = 'inline-block px-3 py-1 rounded-full text-xs font-medium ' + (statusColors[t.status] || '');
    badge.textContent = statusLabels[t.status] || t.status;

    // Creator info
    document.getElementById('td-created-by').querySelector('span').textContent = t.created_by === (window.currentUser ? window.currentUser.id : '') ? 'You' : 'Host';

    // Player count
    var { count } = await window.supabase.from('tournament_players').select('*', { count: 'exact', head: true }).eq('tournament_id', tournamentId).eq('status', 'approved');
    document.getElementById('td-players-count').innerHTML = '<i data-lucide="users" class="w-4 h-4 inline mr-1"></i> ' + (count || 0) + '/' + t.max_players + ' players';
    if (window.lucide) lucide.createIcons();

    // Winner takes all: pool = entry fee x approved players
    var poolPrize = (t.points_cost || 0) * (count || 0);
    if (poolPrize > 0) {
      document.getElementById('td-prize').textContent += (document.getElementById('td-prize').textContent ? ' · ' : '') + 'Winner takes all: ' + poolPrize + ' pts';
    }

    // Action buttons
    var isCreator = window.currentUser && t.created_by === window.currentUser.id;
    var joinBtn = document.getElementById('td-join-btn');
    var startBtn = document.getElementById('td-start-btn');
    var deleteBtn = document.getElementById('td-delete-btn');

    if (t.status === 'registration') {
      joinBtn.classList.remove('hidden');
      if (isCreator) {
        startBtn.classList.remove('hidden');
        deleteBtn.classList.remove('hidden');
        startBtn.textContent = count >= 2 ? 'Start Tournament' : 'Need at least 2 players';
        startBtn.disabled = count < 2;
        startBtn.className = count < 2 ? 'btn-ghost px-5 py-2 text-sm opacity-50' : 'btn-lime px-5 py-2 text-sm';
      } else {
        startBtn.classList.add('hidden');
        deleteBtn.classList.add('hidden');
      }
    } else {
      joinBtn.classList.add('hidden');
      startBtn.classList.add('hidden');
      if (isCreator && t.status === 'in_progress') {
        deleteBtn.classList.remove('hidden');
      } else {
        deleteBtn.classList.add('hidden');
      }
    }

    // Default tab
    switchTDTab('bracket');
  } catch (err) {
    window.showToast('Failed to load tournament details', 'error');
    window.navigate('tournaments');
  }
};

// ── TAB SWITCHING ──
window.switchTDTab = async function (tab) {
  document.querySelectorAll('.td-tab').forEach(function (el) { el.classList.remove('td-tab-active'); });
  var tabBtn = document.getElementById('tdtab-' + tab);
  if (tabBtn) tabBtn.classList.add('td-tab-active');

  var content = document.getElementById('td-content');
  if (!content) return;

  if (tab === 'bracket') await renderBracket();
  else if (tab === 'standings') await renderStandings();
  else if (tab === 'players') await renderPlayers();
  else if (tab === 'matches') await renderMatches();
};

// ── RENDER BRACKET ──
async function renderBracket() {
  var content = document.getElementById('td-content');
  if (!content || !_currentTournament) return;
  content.innerHTML = '<div class="text-center text-mist py-12"><i data-lucide="loader" class="w-6 h-6 mx-auto animate-spin mb-2"></i>Loading bracket...</div>';
  if (window.lucide) lucide.createIcons();

  try {
    var { data: matches, error } = await window.supabase
      .from('tournament_matches')
      .select('*')
      .eq('tournament_id', _currentTournament.id)
      .order('round', { ascending: true })
      .order('match_index', { ascending: true });

    if (error) throw error;

    if (!matches || !matches.length) {
      content.innerHTML = '<div class="text-center py-12"><p class="text-mist text-sm">Bracket not yet generated. The tournament host needs to start the tournament.</p></div>';
      return;
    }

    var maxRound = matches.reduce(function (m, r) { return Math.max(m, r.round); }, 0);
    var rounds = [];
    for (var i = 1; i <= maxRound; i++) rounds.push(i);

    var html = '<div class="overflow-x-auto pb-4">';
    html += '<div class="flex gap-6" style="min-width: ' + (rounds.length * 220) + 'px">';

    rounds.forEach(function (round) {
      var roundMatches = matches.filter(function (m) { return m.round === round; });
      var roundName = round === maxRound ? 'Final' : round === maxRound - 1 ? 'Semi-Finals' : round === maxRound - 2 ? 'Quarter-Finals' : 'Round ' + round;
      html += '<div class="flex-shrink-0" style="width: 200px">';
      html += '<h4 class="text-lime font-display text-sm mb-4 text-center">' + roundName + '</h4>';
      roundMatches.forEach(function (m) {
        var p1 = m.player1_name || 'TBD';
        var p2 = m.player2_name || 'TBD';
        var isBye = !m.player2_id && m.round === 1;
        var isCompleted = m.status === 'completed';

        html += '<div class="match-card mb-3 ' + (isBye ? 'opacity-50' : '') + '">';
        if (isBye) {
          html += '<p class="text-xs text-mist text-center">BYE</p>';
          html += '<p class="text-sm text-center text-ice font-medium">' + window.escHtml(p1) + '</p>';
          html += '<p class="text-xs text-mist text-center">advances automatically</p>';
        } else {
          html += '<div class="flex items-center justify-between gap-2">';
          html += '<div class="flex-1 text-right ' + (isCompleted && m.winner_id === m.player1_id ? 'match-winner' : isCompleted ? 'match-loser' : '') + '">';
          html += '<p class="text-sm font-medium truncate">' + window.escHtml(p1) + '</p></div>';
          html += '<div class="flex items-center gap-1">';
          html += '<span class="match-score ' + (isCompleted && m.winner_id === m.player1_id ? 'match-winner' : '') + '">' + (m.player1_score !== null ? m.player1_score : '-') + '</span>';
          html += '<span class="match-vs">:</span>';
          html += '<span class="match-score ' + (isCompleted && m.winner_id === m.player2_id ? 'match-winner' : '') + '">' + (m.player2_score !== null ? m.player2_score : '-') + '</span>';
          html += '</div>';
          html += '<div class="flex-1 text-left ' + (isCompleted && m.winner_id === m.player2_id ? 'match-winner' : isCompleted ? 'match-loser' : '') + '">';
          html += '<p class="text-sm font-medium truncate">' + window.escHtml(p2) + '</p></div>';
          html += '</div>';
        }
        html += '</div>';
      });
      html += '</div>';
    });

    html += '</div></div>';
    content.innerHTML = html;
    if (window.lucide) lucide.createIcons();
  } catch (err) {
    content.innerHTML = '<p class="text-coral text-sm text-center py-12">Failed to load bracket.</p>';
  }
}

// ── RENDER STANDINGS ──
async function renderStandings() {
  var content = document.getElementById('td-content');
  if (!content || !_currentTournament) return;

  try {
    var { data: matches, error } = await window.supabase
      .from('tournament_matches')
      .select('*')
      .eq('tournament_id', _currentTournament.id)
      .eq('status', 'completed');

    if (error) throw error;

    var stats = {};
    (matches || []).forEach(function (m) {
      if (m.player1_id) {
        if (!stats[m.player1_id]) stats[m.player1_id] = { username: m.player1_name, played: 0, won: 0, drew: 0, lost: 0, gf: 0, ga: 0, pts: 0 };
        stats[m.player1_id].played++;
        stats[m.player1_id].gf += (m.player1_score || 0);
        stats[m.player1_id].ga += (m.player2_score || 0);
        if (m.winner_id === m.player1_id) {
          stats[m.player1_id].won++; stats[m.player1_id].pts += 3;
        } else if (m.winner_id === m.player2_id) {
          stats[m.player1_id].lost++;
        } else {
          stats[m.player1_id].drew++; stats[m.player1_id].pts += 1;
        }
      }
      if (m.player2_id) {
        if (!stats[m.player2_id]) stats[m.player2_id] = { username: m.player2_name, played: 0, won: 0, drew: 0, lost: 0, gf: 0, ga: 0, pts: 0 };
        stats[m.player2_id].played++;
        stats[m.player2_id].gf += (m.player2_score || 0);
        stats[m.player2_id].ga += (m.player1_score || 0);
        if (m.winner_id === m.player2_id) {
          stats[m.player2_id].won++; stats[m.player2_id].pts += 3;
        } else if (m.winner_id === m.player1_id) {
          stats[m.player2_id].lost++;
        } else {
          stats[m.player2_id].drew++; stats[m.player2_id].pts += 1;
        }
      }
    });

    var sorted = Object.keys(stats).sort(function (a, b) {
      if (stats[b].pts !== stats[a].pts) return stats[b].pts - stats[a].pts;
      var gdA = stats[a].gf - stats[a].ga;
      var gdB = stats[b].gf - stats[b].ga;
      if (gdB !== gdA) return gdB - gdA;
      return stats[b].gf - stats[a].gf;
    });

    if (!sorted.length) {
      content.innerHTML = '<div class="text-center py-12"><p class="text-mist text-sm">No matches completed yet. Standings will appear here.</p></div>';
      return;
    }

    var html = '<div class="overflow-x-auto"><table class="w-full text-sm">';
    html += '<thead><tr class="border-b border-line text-mist text-left">';
    html += '<th class="py-3 px-3">#</th><th class="py-3 px-3">Player</th><th class="py-3 px-3 text-center">P</th><th class="py-3 px-3 text-center">W</th><th class="py-3 px-3 text-center">D</th><th class="py-3 px-3 text-center">L</th><th class="py-3 px-3 text-center">GF</th><th class="py-3 px-3 text-center">GA</th><th class="py-3 px-3 text-center">GD</th><th class="py-3 px-3 text-center text-lime">Pts</th>';
    html += '</tr></thead><tbody>';

    sorted.forEach(function (uid, i) {
      var s = stats[uid];
      var gd = s.gf - s.ga;
      var gdStr = gd > 0 ? '+' + gd : gd.toString();
      var highlight = window.currentUser && uid === window.currentUser.id ? 'bg-lime/5' : '';
      html += '<tr class="border-b border-line ' + highlight + '">';
      html += '<td class="py-3 px-3 font-bold text-mist">' + (i + 1) + '</td>';
      html += '<td class="py-3 px-3 text-ice font-medium">' + window.escHtml(s.username) + '</td>';
      html += '<td class="py-3 px-3 text-center">' + s.played + '</td>';
      html += '<td class="py-3 px-3 text-center text-green-400">' + s.won + '</td>';
      html += '<td class="py-3 px-3 text-center text-mist">' + s.drew + '</td>';
      html += '<td class="py-3 px-3 text-center text-coral">' + s.lost + '</td>';
      html += '<td class="py-3 px-3 text-center">' + s.gf + '</td>';
      html += '<td class="py-3 px-3 text-center">' + s.ga + '</td>';
      html += '<td class="py-3 px-3 text-center font-medium ' + (gd > 0 ? 'text-green-400' : gd < 0 ? 'text-coral' : '') + '">' + gdStr + '</td>';
      html += '<td class="py-3 px-3 text-center text-lime font-bold text-base">' + s.pts + '</td>';
      html += '</tr>';
    });

    html += '</tbody></table></div>';
    content.innerHTML = html;
    if (window.lucide) lucide.createIcons();
  } catch (err) {
    content.innerHTML = '<p class="text-coral text-sm text-center py-12">Failed to load standings.</p>';
  }
}

// ── RENDER PLAYERS ──
async function renderPlayers() {
  var content = document.getElementById('td-content');
  if (!content || !_currentTournament) return;
  content.innerHTML = '<div class="text-center text-mist py-12"><i data-lucide="loader" class="w-6 h-6 mx-auto animate-spin mb-2"></i>Loading players...</div>';
  if (window.lucide) lucide.createIcons();

  try {
    var { data: players, error } = await window.supabase
      .from('tournament_players')
      .select('*')
      .eq('tournament_id', _currentTournament.id)
      .order('joined_at', { ascending: true });

    if (error) throw error;

    if (!players || !players.length) {
      content.innerHTML = '<div class="text-center py-12"><p class="text-mist text-sm">No players yet.</p></div>';
      return;
    }

    var isCreator = window.currentUser && _currentTournament.created_by === window.currentUser.id;
    var isRegistration = _currentTournament.status === 'registration';
    var html = '<div class="space-y-3">';

    players.forEach(function (p) {
      var statusColors = { pending: 'text-yellow-400', approved: 'text-green-400', rejected: 'text-coral' };
      var avatarSrc = p.avatar || 'https://ui-avatars.com/api/?name=' + encodeURIComponent(p.username) + '&background=0f1f17&color=b5ff47&size=40';
      html += '<div class="flex items-center justify-between py-3 border-b border-line">';
      html += '<div class="flex items-center gap-3">';
      html += '<img src="' + window.escAttr(avatarSrc) + '" class="w-8 h-8 rounded-full object-cover" />';
      html += '<div><p class="text-ice text-sm font-medium">' + window.escHtml(p.username) + '</p>';
      html += '<p class="text-xs ' + (statusColors[p.status] || 'text-mist') + '">' + p.status + '</p>';
      if (p.team_name) html += '<p class="text-xs text-lime mt-0.5">Team: ' + window.escHtml(p.team_name) + '</p>';
      html += '</div></div>';
      if (isCreator && isRegistration && p.status === 'pending') {
        html += '<div class="flex gap-2">';
        html += '<button onclick="approvePlayer(\'' + p.id + '\')" class="text-green-400 text-xs hover:text-green-300 border border-green-400/30 px-3 py-1 rounded-full">Approve</button>';
        html += '<button onclick="rejectPlayer(\'' + p.id + '\')" class="text-coral text-xs hover:text-white border border-coral/30 px-3 py-1 rounded-full">Reject</button>';
        html += '</div>';
      }
      html += '</div>';
    });

    html += '</div>';
    content.innerHTML = html;
    if (window.lucide) lucide.createIcons();
  } catch (err) {
    content.innerHTML = '<p class="text-coral text-sm text-center py-12">Failed to load players.</p>';
  }
}

// ── RENDER MATCHES ──
async function renderMatches() {
  var content = document.getElementById('td-content');
  if (!content || !_currentTournament) return;
  content.innerHTML = '<div class="text-center text-mist py-12"><i data-lucide="loader" class="w-6 h-6 mx-auto animate-spin mb-2"></i>Loading matches...</div>';
  if (window.lucide) lucide.createIcons();

  try {
    var { data: matches, error } = await window.supabase
      .from('tournament_matches')
      .select('*')
      .eq('tournament_id', _currentTournament.id)
      .order('round', { ascending: true })
      .order('match_index', { ascending: true });

    if (error) throw error;

    if (!matches || !matches.length) {
      content.innerHTML = '<div class="text-center py-12"><p class="text-mist text-sm">No matches yet.</p></div>';
      return;
    }

    var isActivePlayer = false;
    var currentUserId = window.currentUser ? window.currentUser.id : '';
    var isCreator = _currentTournament && _currentTournament.created_by === currentUserId;
    var statusLabels = {
      pending: 'Pending',
      in_progress: 'In Progress',
      pending_confirmation: 'Awaiting Confirmation',
      completed: 'Completed'
    };
    var statusColors = {
      pending: 'text-mist',
      in_progress: 'text-lime',
      pending_confirmation: 'text-yellow-400',
      completed: 'text-green-400'
    };
    var html = '<div class="space-y-3">';

    matches.forEach(function (m) {
      var isBye = !m.player2_id && m.round === 1;
      var userInMatch = currentUserId && (m.player1_id === currentUserId || m.player2_id === currentUserId);
      if (userInMatch) isActivePlayer = true;

      html += '<div class="match-card">';
      html += '<div class="flex items-center justify-between mb-2">';
      html += '<span class="text-xs text-mist font-medium">Round ' + m.round + ' · Match ' + (m.match_index + 1) + '</span>';
      html += '<span class="text-xs ' + (statusColors[m.status] || 'text-mist') + '">' + (statusLabels[m.status] || m.status) + '</span>';
      html += '</div>';

      if (isBye) {
        html += '<p class="text-sm text-mist">BYE — ' + window.escHtml(m.player1_name || 'TBD') + ' advances</p>';
      } else {
        var p1 = m.player1_name || 'TBD';
        var p2 = m.player2_name || 'TBD';
        html += '<div class="flex items-center justify-between gap-4">';
        html += '<div class="flex-1 text-right ' + (m.status === 'completed' && m.winner_id === m.player1_id ? 'text-green-400 font-semibold' : '') + '">' + window.escHtml(p1) + '</div>';
        html += '<div class="flex items-center gap-2">';
        html += '<span class="text-lg font-bold font-display ' + (m.status === 'completed' && m.winner_id === m.player1_id ? 'text-green-400' : '') + '">' + (m.player1_score !== null ? m.player1_score : '-') + '</span>';
        html += '<span class="text-mist text-xs">:</span>';
        html += '<span class="text-lg font-bold font-display ' + (m.status === 'completed' && m.winner_id === m.player2_id ? 'text-green-400' : '') + '">' + (m.player2_score !== null ? m.player2_score : '-') + '</span>';
        html += '</div>';
        html += '<div class="flex-1 text-left ' + (m.status === 'completed' && m.winner_id === m.player2_id ? 'text-green-400 font-semibold' : '') + '">' + window.escHtml(p2) + '</div>';
        html += '</div>';

        if (m.status === 'completed' && m.winner_name) {
          html += '<p class="text-xs text-green-400 mt-2">Winner: ' + window.escHtml(m.winner_name) + '</p>';
        }

        if (m.status === 'pending_confirmation') {
          var submittedByMe = m.result_submitted_by === currentUserId;
          var canReview = isCreator || !!(window.currentUserDoc && window.currentUserDoc.is_admin);
          html += '<p class="text-xs text-yellow-400 mt-2">⏳ Result submitted — waiting for host/admin review</p>';
          if (m.screenshot_url) {
            html += '<a href="' + window.escAttr(m.screenshot_url) + '" target="_blank" rel="noopener" class="text-xs text-lime underline mt-1 inline-block">View score screenshot</a>';
          }
          if (canReview && !submittedByMe) {
            html += '<div class="mt-2"><button onclick="confirmMatchResult(\'' + m.id + '\')" class="btn-lime text-xs px-4 py-1.5">Confirm Result</button></div>';
          }
        }
      }

      if (userInMatch && (m.status === 'pending' || m.status === 'in_progress')) {
        html += '<button onclick="openSubmitResultModal(\'' + m.id + '\')" class="mt-3 btn-lime text-xs px-4 py-1.5">Submit Result</button>';
      }

      html += '</div>';
    });

    html += '</div>';

    if (!isActivePlayer && _currentTournament.status === 'in_progress') {
      html += '<p class="text-mist text-xs text-center mt-4">You are not a participant in this tournament. Matches are shown for reference.</p>';
    }

    content.innerHTML = html;
    if (window.lucide) lucide.createIcons();
  } catch (err) {
    content.innerHTML = '<p class="text-coral text-sm text-center py-12">Failed to load matches.</p>';
  }
}

// ── PLAYER APPROVAL ──
window.approvePlayer = async function (playerId) {
  try {
    await window.supabase.from('tournament_players').update({ status: 'approved' }).eq('id', playerId);
    window.showToast('Player approved ✅');
    renderPlayers();
  } catch (err) {
    window.showToast('Failed to approve', 'error');
  }
};

window.rejectPlayer = async function (playerId) {
  try {
    await window.supabase.from('tournament_players').update({ status: 'rejected' }).eq('id', playerId);
    window.showToast('Player rejected');
    renderPlayers();
  } catch (err) {
    window.showToast('Failed to reject', 'error');
  }
};

// ── JOIN TOURNAMENT ──
window.joinTournament = async function () {
  if (!window.currentUser) { window.showToast('Please log in first', 'error'); window.navigate('login'); return; }
  if (!_currentTournament) return;
  if (_currentTournament.created_by === window.currentUser.id) { window.showToast('You are the host', 'error'); return; }
  if (_currentTournament.status !== 'registration') { window.showToast('Registration is closed', 'error'); return; }

  var { data: existing } = await window.supabase
    .from('tournament_players')
    .select('id')
    .eq('tournament_id', _currentTournament.id)
    .eq('user_id', window.currentUser.id)
    .limit(1);

  if (existing && existing.length) {
    window.showToast('You already joined this tournament', 'error');
    return;
  }

  var { count } = await window.supabase
    .from('tournament_players')
    .select('*', { count: 'exact', head: true })
    .eq('tournament_id', _currentTournament.id)
    .eq('status', 'approved');

  if (count >= _currentTournament.max_players) {
    window.showToast('Tournament is full', 'error');
    return;
  }

  // Points check: if tournament has a points cost, verify user has enough
  var cost = _currentTournament.points_cost || 0;
  if (cost > 0) {
    var { data: userData } = await window.supabase
      .from('users')
      .select('points')
      .eq('uid', window.currentUser.id)
      .single();

    var userPoints = (userData && userData.points) || 0;
    if (userPoints < cost) {
      window.showToast('You need ' + cost + ' pts to join. You have ' + userPoints + '.', 'error');
      return;
    }
  }

  // Real DLS game team name is required — used to verify matches
  var teamName = (window.prompt('Enter your real DLS game team name (shown to opponents for match verification):') || '').trim();
  if (!teamName) { window.showToast('Your DLS team name is required to join', 'error'); return; }
  if (teamName.length > 40) { window.showToast('Team name too long (max 40 chars)', 'error'); return; }

  try {
    // Always auto-approve — no more payment modal
    var { error: insertError } = await window.supabase.from('tournament_players').insert({
      tournament_id: _currentTournament.id,
      user_id: window.currentUser.id,
      username: window.currentUserDoc?.username || 'Anonymous',
      avatar: window.currentUserDoc?.avatar || '',
      team_name: teamName,
      status: 'approved',
      joined_at: new Date().toISOString()
    });

    if (insertError) throw insertError;

    // Deduct entry fee AFTER a successful join, so a failed join never costs points.
    if (cost > 0) {
      var { error: deductError } = await window.supabase.rpc('decrement_points', { amount: cost });
      if (deductError) {
        await window.supabase.from('tournament_players').delete()
          .eq('tournament_id', _currentTournament.id)
          .eq('user_id', window.currentUser.id);
        window.showToast('Failed to deduct points', 'error');
        return;
      }
    }

    window.showToast('Joined tournament ✅');
    setTimeout(window.updateNavPoints, 300);
    initTournamentDetail();
  } catch (err) {
    window.showToast('Failed to join', 'error');
  }
};

// ── CREATE TOURNAMENT ──
window.openCreateTournamentModal = function () {
  if (!window.currentUser) { window.showToast('Please log in first', 'error'); window.navigate('login'); return; }
  document.getElementById('create-tournament-modal').classList.remove('hidden');
  if (window.lucide) lucide.createIcons();
};

window.closeCreateTournamentModal = function () {
  document.getElementById('create-tournament-modal').classList.add('hidden');
  document.getElementById('ct-error').classList.add('hidden');
};

window.handleCreateTournament = async function () {
  var name = document.getElementById('ct-name').value.trim();
  var desc = document.getElementById('ct-desc').value.trim();
  var game = document.getElementById('ct-game').value.trim();
  var maxPlayers = parseInt(document.getElementById('ct-max').value) || 16;
  var prize = document.getElementById('ct-prize').value.trim();
  var fee = parseFloat(document.getElementById('ct-fee').value) || 0;
  var pointsPrize = parseInt(document.getElementById('ct-points-prize').value) || 0;
  var errEl = document.getElementById('ct-error');

  if (!name) { errEl.textContent = 'Tournament name is required'; errEl.classList.remove('hidden'); return; }
  if (maxPlayers < 2) { errEl.textContent = 'Minimum 2 players required'; errEl.classList.remove('hidden'); return; }
  errEl.classList.add('hidden');

  try {
    var { data, error } = await window.supabase.from('tournaments').insert({
      name: name,
      description: desc,
      game: game || 'DLS 25',
      max_players: maxPlayers,
      prize: prize,
      points_cost: fee,
      points_prize: pointsPrize,
      status: 'registration',
      created_by: window.currentUser.id,
      created_at: new Date().toISOString()
    }).select().single();

    if (error) throw error;

    window.closeCreateTournamentModal();
    document.getElementById('ct-name').value = '';
    document.getElementById('ct-desc').value = '';
    document.getElementById('ct-prize').value = '';
    document.getElementById('ct-fee').value = '';
    document.getElementById('ct-points-prize').value = '';

    window.showToast('Tournament created! 🎉');
    window._currentTournamentId = data.id;
    window.navigate('tournament-detail');
  } catch (err) {
    errEl.textContent = 'Failed to create: ' + (err.message || 'unknown error');
    errEl.classList.remove('hidden');
  }
};

// ── START TOURNAMENT ──
window.startTournament = async function () {
  if (!_currentTournament || !window.currentUser) return;
  if (_currentTournament.created_by !== window.currentUser.id) { window.showToast('Only the host can start', 'error'); return; }

  var { data: players } = await window.supabase
    .from('tournament_players')
    .select('*')
    .eq('tournament_id', _currentTournament.id)
    .eq('status', 'approved');

  if (!players || players.length < 2) { window.showToast('Need at least 2 approved players', 'error'); return; }

  // Anti-cheat: everyone must register their real DLS team name first
  var missingTeam = players.filter(function (p) { return !(p.team_name || '').trim(); });
  if (missingTeam.length) {
    var names = missingTeam.map(function (p) { return p.username; }).slice(0, 3).join(', ');
    window.showToast('Can\'t start — missing DLS team name: ' + names + (missingTeam.length > 3 ? ' +' + (missingTeam.length - 3) : ''), 'error');
    return;
  }

  // Fisher-Yates shuffle for random seeding
  var shuffled = players.slice();
  for (var i = shuffled.length - 1; i > 0; i--) {
    var j = Math.floor(Math.random() * (i + 1));
    var tmp = shuffled[i]; shuffled[i] = shuffled[j]; shuffled[j] = tmp;
  }

  // Calculate rounds
  var numPlayers = shuffled.length;
  var numRounds = Math.ceil(Math.log2(numPlayers));
  var totalSlots = Math.pow(2, numRounds);
  var numByes = totalSlots - numPlayers;

  // Assign seeds
  shuffled.forEach(function (p, idx) {
    window.supabase.from('tournament_players').update({ seed: idx + 1 }).eq('id', p.id).then();
  });

  // Generate first round matches
  var numFirstRoundMatches = totalSlots / 2;
  var matches = [];

  var playerIdx = 0;
  for (var mi = 0; mi < numFirstRoundMatches; mi++) {
    var p1 = null, p2 = null;
    var isBye = false;

    if (playerIdx < numPlayers) {
      p1 = shuffled[playerIdx]; playerIdx++;
    }

    if (numByes > 0) {
      numByes--;
      isBye = true;
    } else if (playerIdx < numPlayers) {
      p2 = shuffled[playerIdx]; playerIdx++;
    }

    matches.push({
      tournament_id: _currentTournament.id,
      round: 1,
      match_index: mi,
      player1_id: p1 ? p1.user_id : null,
      player1_name: p1 ? p1.username : 'TBD',
      player2_id: p2 ? p2.user_id : null,
      player2_name: p2 ? p2.username : 'TBD',
      status: isBye ? 'completed' : 'pending'
    });

    if (isBye && p1) {
      matches[matches.length - 1].winner_id = p1.user_id;
      matches[matches.length - 1].winner_name = p1.username;
    }
  }

  try {
    var { error } = await window.supabase.from('tournament_matches').insert(matches);
    if (error) throw error;

    await window.supabase.from('tournaments').update({ status: 'in_progress', started_at: new Date().toISOString() }).eq('id', _currentTournament.id);

    _currentTournament.status = 'in_progress';
    window.showToast('Tournament started! ⚽');
    initTournamentDetail();
  } catch (err) {
    window.showToast('Failed to start tournament', 'error');
  }
};

// ── SUBMIT MATCH RESULT ──
var _pendingResultMatchId = null;

window.openSubmitResultModal = function (matchId) {
  if (!window.currentUser) { window.showToast('Please log in', 'error'); return; }
  _pendingResultMatchId = matchId;
  document.getElementById('submit-result-modal').classList.remove('hidden');
  document.getElementById('sr-error').classList.add('hidden');
  document.getElementById('sr-score1').value = '';
  document.getElementById('sr-score2').value = '';
  document.getElementById('sr-screenshot').value = '';
  document.getElementById('sr-screenshot-preview').classList.add('hidden');

  window.supabase.from('tournament_matches').select('*').eq('id', matchId).single().then(function (res) {
    var m = res.data;
    if (m) {
      document.getElementById('sr-info').textContent = m.player1_name + ' vs ' + m.player2_name;
      document.getElementById('sr-player1-label').textContent = m.player1_name + ' Score';
      document.getElementById('sr-player2-label').textContent = m.player2_name + ' Score';
    }
  }).catch(function () {
    document.getElementById('sr-info').textContent = 'Submit match result';
  });
};

window.closeSubmitResultModal = function () {
  document.getElementById('submit-result-modal').classList.add('hidden');
  _pendingResultMatchId = null;
};

window.previewResultScreenshot = function (e) {
  var file = e.target.files && e.target.files[0];
  var preview = document.getElementById('sr-screenshot-preview');
  if (!file || !preview) return;
  if (file.size > 5 * 1024 * 1024) { window.showToast('Screenshot too large (max 5MB)', 'error'); e.target.value = ''; return; }
  preview.src = URL.createObjectURL(file);
  preview.classList.remove('hidden');
};

window.uploadResultScreenshot = async function (file) {
  var ext = (file.name.split('.').pop() || 'jpg').toLowerCase();
  var path = 'evidence/' + window.currentUser.id + '/' + Date.now() + '.' + ext;
  var { error } = await window.supabase.storage.from('avatars').upload(path, file, { upsert: false });
  if (error) throw error;
  var { data } = window.supabase.storage.from('avatars').getPublicUrl(path);
  return data.publicUrl;
};

window.confirmMatchResult = async function (matchId) {
  if (!window.currentUser) { window.showToast('Please log in', 'error'); return; }

  var isHost = _currentTournament && _currentTournament.created_by === window.currentUser.id;
  var isAdmin = !!(window.currentUserDoc && window.currentUserDoc.is_admin);
  if (!isHost && !isAdmin) { window.showToast('Only the host or an admin can confirm results', 'error'); return; }

  var { error } = await window.supabase.rpc('confirm_match_result', { match_id: matchId });
  if (error) { window.showToast('Failed to confirm: ' + error.message, 'error'); return; }

  var { data: match } = await window.supabase.from('tournament_matches').select('tournament_id, round').eq('id', matchId).single();
  window.showToast('Result confirmed ✅');
  if (match) await advanceRoundIfComplete(match.tournament_id, match.round);
  initTournamentDetail();
};

window.handleSubmitResult = async function () {
  if (!_pendingResultMatchId || !window.currentUser) return;
  var score1 = parseInt(document.getElementById('sr-score1').value);
  var score2 = parseInt(document.getElementById('sr-score2').value);
  var errEl = document.getElementById('sr-error');
  var fileInput = document.getElementById('sr-screenshot');
  var file = fileInput && fileInput.files[0];

  if (isNaN(score1) || isNaN(score2)) {
    errEl.textContent = 'Enter valid scores for both players';
    errEl.classList.remove('hidden');
    return;
  }

  if (score1 === score2) {
    errEl.textContent = 'Tournament matches cannot end in a draw. Enter different scores.';
    errEl.classList.remove('hidden');
    return;
  }

  if (!file) {
    errEl.textContent = 'A score screenshot is required';
    errEl.classList.remove('hidden');
    return;
  }

  var winnerId, winnerName;
  try {
    var { data: match } = await window.supabase.from('tournament_matches').select('*').eq('id', _pendingResultMatchId).single();
    if (!match) { window.showToast('Match not found', 'error'); return; }
    if (match.status === 'pending_confirmation') {
      errEl.textContent = 'A result is already pending confirmation for this match';
      errEl.classList.remove('hidden');
      return;
    }

    var screenshotUrl = await window.uploadResultScreenshot(file);

    if (score1 > score2) {
      winnerId = match.player1_id;
      winnerName = match.player1_name;
    } else {
      winnerId = match.player2_id;
      winnerName = match.player2_name;
    }

    // AI verification: the edge function scans the screenshot and auto-locks
    // the match when it confirms the proposed winner with 80%+ confidence.
    var aiVerified = false;
    try {
      var aiResp = await window.supabase.functions.invoke('verify-match', {
        body: {
          matchId: _pendingResultMatchId,
          screenshotUrl: screenshotUrl,
          playerOneName: match.player1_name,
          playerTwoName: match.player2_name,
          proposedWinnerName: winnerName,
          player1Score: score1,
          player2Score: score2,
          winnerId: winnerId,
          winnerName: winnerName
        }
      });
      aiVerified = !!(aiResp && aiResp.data && aiResp.data.verified);
    } catch (e) {
      aiVerified = false;
    }

    if (aiVerified) {
      window.closeSubmitResultModal();
      window.showToast('Result verified by AI ✅');
      await advanceRoundIfComplete(match.tournament_id, match.round);
    } else {
      await window.supabase.from('tournament_matches').update({
        player1_score: score1,
        player2_score: score2,
        screenshot_url: screenshotUrl,
        proposed_winner_id: winnerId,
        proposed_winner_name: winnerName,
        result_submitted_by: window.currentUser.id,
        status: 'pending_confirmation'
      }).eq('id', _pendingResultMatchId);

      window.closeSubmitResultModal();
      window.showToast('Result submitted. Waiting for opponent confirmation ⏳');
    }
    initTournamentDetail();
  } catch (err) {
    errEl.textContent = 'Failed to submit result: ' + (err.message || 'unknown error');
    errEl.classList.remove('hidden');
  }
};

async function advanceRoundIfComplete(tournamentId, completedRound) {
  var { data: roundMatches } = await window.supabase
    .from('tournament_matches')
    .select('*')
    .eq('tournament_id', tournamentId)
    .eq('round', completedRound);

  var allDone = roundMatches.every(function (m) { return m.status === 'completed'; });
  if (!allDone) return;

  var { data: existingNext } = await window.supabase
    .from('tournament_matches')
    .select('id')
    .eq('tournament_id', tournamentId)
    .eq('round', completedRound + 1)
    .limit(1);

  if (existingNext && existingNext.length) return;

  var winners = roundMatches.map(function (m) { return { id: m.winner_id, name: m.winner_name }; }).filter(function (w) { return w.id; });

  if (winners.length <= 1) {
    var winner = winners[0];
    await window.supabase.from('tournaments').update({
      status: 'completed',
      ended_at: new Date().toISOString(),
      winner_id: winner ? winner.id : null,
      winner_name: winner ? winner.name : null
    }).eq('id', tournamentId);
    _currentTournament.status = 'completed';
    window.showToast('🏆 Tournament complete! Winner: ' + (winner ? winner.name : 'Unknown'));
    return;
  }

  var nextMatches = [];
  for (var i = 0; i < winners.length; i += 2) {
    var p1 = winners[i];
    var p2 = winners[i + 1] || null;
    nextMatches.push({
      tournament_id: tournamentId,
      round: completedRound + 1,
      match_index: Math.floor(i / 2),
      player1_id: p1.id,
      player1_name: p1.name,
      player2_id: p2 ? p2.id : null,
      player2_name: p2 ? p2.name : 'TBD',
      status: p2 ? 'pending' : 'completed',
      winner_id: p2 ? null : p1.id,
      winner_name: p2 ? null : p1.name
    });
  }

  var { error } = await window.supabase.from('tournament_matches').insert(nextMatches);
  if (error) console.error('Failed to create next round:', error);
}

// ── DELETE TOURNAMENT ──
window.deleteTournament = async function () {
  if (!_currentTournament || !window.currentUser) return;
  if (_currentTournament.created_by !== window.currentUser.id) { window.showToast('Only the host can delete', 'error'); return; }
  if (!await window.showConfirm('Delete "' + _currentTournament.name + '"? This will remove all matches and players.')) return;

  try {
    await window.supabase.from('tournaments').delete().eq('id', _currentTournament.id);
    window.showToast('Tournament deleted');
    window.navigate('tournaments');
  } catch (err) {
    window.showToast('Failed to delete', 'error');
  }
};


