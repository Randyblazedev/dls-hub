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

const ADMIN_EMAILS = ['asonganyirandy143@gmail.com'];
function isAdmin() { return window.currentUser && ADMIN_EMAILS.includes(window.currentUser.email); }

// ═══ CHAT IMAGES ═══
let pendingChatImage = null;
window.previewChatImage = function(e) {
  const file = e.target.files[0]; if (!file) return;
  pendingChatImage = file;
  const reader = new FileReader();
  reader.onload = ev => { document.getElementById('chat-preview-img').src = ev.target.result; document.getElementById('chat-image-preview').classList.remove('hidden'); };
  reader.readAsDataURL(file);
};
window.removeChatImage = function() {
  pendingChatImage = null; document.getElementById('chat-image-input').value = '';
  document.getElementById('chat-image-preview').classList.add('hidden');
};
async function uploadChatImage(file) {
  const ext = file.name.split('.').pop();
  const path = 'chat-images/' + window.currentUser.id + '/' + Date.now() + '.' + ext;
  const { error } = await supabase.storage.from('avatars').upload(path, file);
  if (error) throw error;
  return supabase.storage.from('avatars').getPublicUrl(path).data.publicUrl;
}

// ═══ PUBLIC PROFILES ═══
let publicProfileData = null;
window.viewPublicProfile = async function(userId) {
  if (!window.currentUser) { navigate('login'); return; }
  try {
    const { data: user } = await supabase.from('users').select('*').eq('uid', userId).single();
    if (!user) { showToast('User not found', 'error'); return; }
    publicProfileData = user;
    document.getElementById('pub-avatar').src = user.avatar || 'https://ui-avatars.com/api/?name=' + encodeURIComponent(user.username) + '&background=0f1f17&color=b5ff47';
    document.getElementById('pub-username').textContent = user.username;
    document.getElementById('pub-team').textContent = user.team ? '⚽ ' + user.team : '';
    document.getElementById('pub-bio').textContent = user.bio || '';
    document.getElementById('pub-joined').textContent = user.joinedat ? 'Joined ' + timeAgo(new Date(user.joinedat)) : '';
    const { count } = await supabase.from('posts').select('*', { count: 'exact', head: true }).eq('authorid', userId);
    document.getElementById('pub-postcount').textContent = (count || 0) + ' posts';
    const container = document.getElementById('pub-posts'); container.innerHTML = '';
    const { data: posts } = await supabase.from('posts').select('*').eq('authorid', userId).order('created_at', { ascending: false }).limit(20);
    if (!posts || !posts.length) container.innerHTML = '<p class="text-mist text-sm">No posts yet.</p>';
    else { posts.forEach(p => { container.innerHTML += buildPostCard(p.id, p, true); }); lucide.createIcons(); }
    navigate('profile-public');
  } catch (err) { showToast('Failed to load profile', 'error'); }
};
window.dmFromPublicProfile = function() { if (publicProfileData) openDMFromPost(publicProfileData.uid, publicProfileData.username); };

// ═══ CLICKABLE USERNAMES ═══
function makeUsernamesClickable() {
  document.querySelectorAll('.comment-item .text-lime.text-xs.font-medium').forEach(el => {
    if (el.dataset.clickable) return; el.dataset.clickable = '1'; el.style.cursor = 'pointer';
    el.onclick = async () => { const { data } = await supabase.from('users').select('uid').eq('username', el.textContent.trim()).single(); if (data) viewPublicProfile(data.uid); };
  });
}
setInterval(makeUsernamesClickable, 2000);

// ═══ SHARE POST LINK ═══
window.sharePost = function(postId) {
  const url = window.location.origin + window.location.pathname + '?post=' + postId;
  navigator.clipboard.writeText(url).then(() => showToast('Link copied! 📋')).catch(() => showToast('Failed to copy', 'error'));
};
(function checkPostUrl() {
  const params = new URLSearchParams(window.location.search);
  const postId = params.get('post');
  if (postId) { setTimeout(() => { navigate('feed'); setTimeout(() => { const el = document.getElementById('post-' + postId); if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.classList.add('ring-2', 'ring-lime'); } }, 500); }, 500); }
})();

// ═══ EMOJI REACTIONS ═══
const REACTION_EMOJIS = ['🔥', '⚽', '💯', '👏', '❤️'];
window.toggleReaction = async function(postId, emoji) {
  if (!window.currentUser) { showToast('Log in to react', 'error'); return; }
  try {
    const { data: post } = await supabase.from('posts').select('reactions').eq('id', postId).single();
    let reactions = (post && post.reactions) || {};
    if (!reactions[emoji]) reactions[emoji] = [];
    if (reactions[emoji].includes(window.currentUser.id)) reactions[emoji] = reactions[emoji].filter(id => id !== window.currentUser.id);
    else reactions[emoji].push(window.currentUser.id);
    await supabase.from('posts').update({ reactions }).eq('id', postId);
    var c = document.getElementById('reactions-' + postId);
    if (c) renderReactions(c, postId, reactions);
  } catch (_) {}
};
function renderReactions(container, postId, reactions) {
  container.innerHTML = REACTION_EMOJIS.map(function(emoji) {
    var users = (reactions && reactions[emoji]) || []; var count = users.length;
    var active = window.currentUser && users.includes(window.currentUser.id);
    var cls = active ? 'bg-lime/20 text-lime border border-lime/40' : 'bg-turf border border-line text-mist hover:border-lime/30';
    return '<button onclick="toggleReaction(\'' + postId + '\',\'' + emoji + '\')" class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs transition ' + cls + '"><span>' + emoji + '</span>' + (count ? '<span>' + count + '</span>' : '') + '</button>';
  }).join('');
}

// ═══ REPORT ═══
window.reportContent = async function(type, id) {
  if (!window.currentUser) { showToast('Log in to report', 'error'); return; }
  var reasons = ['Spam', 'Harassment', 'Inappropriate', 'Other'];
  var reason = prompt('Report reason:\n' + reasons.map(function(r,i) { return (i+1) + '. ' + r; }).join('\n') + '\nEnter 1-4:');
  if (!reason || reason < 1 || reason > 4) return;
  try {
    await supabase.from('reports').insert({ reported_by: window.currentUser.id, content_type: type, content_id: id, reason: reasons[reason - 1], created_at: new Date().toISOString() });
    showToast('Report submitted ✅');
  } catch (_) { showToast('Failed to report', 'error'); }
};

// ═══ SQUADS ═══
var pendingSquadImage = null;
window.previewSquadImage = function(e) {
  var file = e.target.files[0]; if (!file) return; pendingSquadImage = file;
  var r = new FileReader(); r.onload = function(ev) { document.getElementById('squad-preview-img').src = ev.target.result; document.getElementById('squad-image-preview').classList.remove('hidden'); };
  r.readAsDataURL(file);
};
window.removeSquadImage = function() { pendingSquadImage = null; document.getElementById('squad-image-input').value = ''; document.getElementById('squad-image-preview').classList.add('hidden'); };
window.createSquad = async function() {
  var name = document.getElementById('squad-name').value.trim();
  var formation = document.getElementById('squad-formation').value;
  var players = document.getElementById('squad-players').value.trim();
  var desc = document.getElementById('squad-desc').value.trim();
  if (!name) { showToast('Enter a squad name', 'error'); return; }
  try {
    var imageUrl = '';
    if (pendingSquadImage) {
      var ext = pendingSquadImage.name.split('.').pop();
      var path = 'squads/' + window.currentUser.id + '/' + Date.now() + '.' + ext;
      await supabase.storage.from('avatars').upload(path, pendingSquadImage);
      imageUrl = supabase.storage.from('avatars').getPublicUrl(path).data.publicUrl;
      removeSquadImage();
    }
    await supabase.from('squads').insert({ user_id: window.currentUser.id, username: (window.currentUserDoc && window.currentUserDoc.username) || 'Anon', name: name, formation: formation, players: players, description: desc, image_url: imageUrl || null, created_at: new Date().toISOString() });
    document.getElementById('squad-name').value = '';
    document.getElementById('squad-players').value = '';
    document.getElementById('squad-desc').value = '';
    showToast('Squad shared! ⚽'); initSquads();
  } catch (_) { showToast('Failed', 'error'); }
};
async function initSquads() {
  var grid = document.getElementById('squads-grid'); if (!grid) return;
  grid.innerHTML = '<p class="text-mist text-sm">Loading...</p>';
  try {
    var result = await supabase.from('squads').select('*').order('created_at', { ascending: false }).limit(30);
    var data = result.data;
    if (!data || !data.length) { grid.innerHTML = '<p class="text-mist text-sm">No squads yet.</p>'; return; }
    grid.innerHTML = data.map(function(s) { return '<div class="post-card"><div class="flex items-center gap-3 mb-3"><img src="https://ui-avatars.com/api/?name=' + encodeURIComponent(s.username||'U') + '&background=0f1f17&color=b5ff47" class="w-8 h-8 rounded-full" /><div><p class="text-ice text-sm font-medium">' + escHtml(s.username) + '</p><p class="text-mist text-xs">' + timeAgo(new Date(s.created_at)) + '</p></div></div><h3 class="font-display text-xl text-lime mb-1">' + escHtml(s.name) + '</h3><p class="text-mist text-xs mb-2">Formation: ' + escHtml(s.formation) + '</p>' + (s.image_url ? '<img src="' + s.image_url + '" class="w-full max-h-60 object-cover rounded-lg mb-3" />' : '') + '<pre class="text-ice text-xs whitespace-pre-wrap mb-2 bg-pitch/50 p-3 rounded-lg">' + escHtml(s.players || '') + '</pre>' + (s.description ? '<p class="text-mist text-xs">' + escHtml(s.description) + '</p>' : '') + '</div>'; }).join('');
  } catch (_) { grid.innerHTML = '<p class="text-coral text-xs">Failed to load.</p>'; }
}

// ═══ PREDICTIONS ═══
window.createPredictionMatch = async function() {
  var teamA = document.getElementById('pred-team-a').value.trim();
  var teamB = document.getElementById('pred-team-b').value.trim();
  var matchDate = document.getElementById('pred-match-date').value;
  var deadline = document.getElementById('pred-deadline').value;
  if (!teamA || !teamB) { showToast('Enter both teams', 'error'); return; }
  try {
    await supabase.from('prediction_matches').insert({ team_a: teamA, team_b: teamB, match_date: matchDate || null, deadline: deadline || null, created_by: window.currentUser.id, created_at: new Date().toISOString() });
    document.getElementById('pred-team-a').value = '';
    document.getElementById('pred-team-b').value = '';
    showToast('Match created! 🎯'); initPredictions();
  } catch (_) { showToast('Failed', 'error'); }
};
window.submitPrediction = async function(matchId) {
  var a = parseInt(document.getElementById('pred-a-' + matchId).value);
  var b = parseInt(document.getElementById('pred-b-' + matchId).value);
  if (isNaN(a) || isNaN(b)) { showToast('Enter valid scores', 'error'); return; }
  try {
    await supabase.from('predictions').insert({ match_id: matchId, user_id: window.currentUser.id, username: (window.currentUserDoc && window.currentUserDoc.username) || 'Anon', score_a: a, score_b: b, created_at: new Date().toISOString() });
    showToast('Predicted! 🎯'); initPredictions();
  } catch (_) { showToast('Already predicted', 'error'); }
};
async function initPredictions() {
  var c = document.getElementById('pred-matches'); if (!c) return;
  if (isAdmin()) { var af = document.getElementById('pred-admin-form'); if (af) af.classList.remove('hidden'); }
  c.innerHTML = '<p class="text-mist text-sm">Loading...</p>';
  try {
    var result = await supabase.from('prediction_matches').select('*').order('created_at', { ascending: false }).limit(20);
    var matches = result.data;
    if (!matches || !matches.length) { c.innerHTML = '<p class="text-mist text-sm">No matches yet.</p>'; return; }
    var html = '';
    for (var i = 0; i < matches.length; i++) {
      var m = matches[i];
      var pr = await supabase.from('predictions').select('*').eq('match_id', m.id);
      var preds = pr.data || [];
      var myPred = null;
      for (var j = 0; j < preds.length; j++) { if (preds[j].user_id === (window.currentUser && window.currentUser.id)) { myPred = preds[j]; break; } }
      var closed = m.deadline && new Date(m.deadline) < new Date();
      html += '<div class="post-card"><div class="flex items-center justify-between mb-3"><h3 class="font-display text-xl text-lime">' + escHtml(m.team_a) + ' vs ' + escHtml(m.team_b) + '</h3>' + (m.resolved ? '<span class="text-xs px-2 py-1 rounded-full bg-lime/20 text-lime">' + m.score_a + ' - ' + m.score_b + '</span>' : '') + '</div><p class="text-mist text-xs mb-3">' + preds.length + ' predictions' + (m.deadline ? ' · Deadline: ' + new Date(m.deadline).toLocaleString() : '') + '</p>';
      if (m.resolved) { /* show result */ }
      else if (myPred) { html += '<p class="text-mist text-xs">Your pick: ' + myPred.score_a + ' - ' + myPred.score_b + '</p>'; }
      else if (closed) { html += '<p class="text-coral text-xs">Deadline passed</p>'; }
      else { html += '<div class="flex items-center gap-2"><input id="pred-a-' + m.id + '" type="number" class="form-input w-16 py-1 text-center text-sm" placeholder="0" min="0" /><span class="text-mist">-</span><input id="pred-b-' + m.id + '" type="number" class="form-input w-16 py-1 text-center text-sm" placeholder="0" min="0" /><button onclick="submitPrediction(\'' + m.id + '\')" class="btn-lime px-4 py-1 text-sm">Predict</button></div>'; }
      html += '</div>';
    }
    c.innerHTML = html;
  } catch (_) { c.innerHTML = '<p class="text-coral text-xs">Failed.</p>'; }
}

// ═══ POTW ═══
function getCurrentWeek() { var d = new Date(); return d.getFullYear() + '-W' + String(Math.ceil(d.getDate() / 7)).padStart(2, '0'); }
window.nominatePOTW = async function() {
  var name = document.getElementById('potw-player-name').value.trim();
  var team = document.getElementById('potw-player-team').value.trim();
  var rating = parseInt(document.getElementById('potw-rating').value);
  var reason = document.getElementById('potw-reason').value.trim();
  if (!name) { showToast('Enter player name', 'error'); return; }
  try {
    await supabase.from('potw_nominations').insert({ player_name: name, team: team, rating: rating || null, reason: reason, user_id: window.currentUser.id, username: (window.currentUserDoc && window.currentUserDoc.username) || 'Anon', week: getCurrentWeek(), created_at: new Date().toISOString() });
    document.getElementById('potw-player-name').value = '';
    document.getElementById('potw-reason').value = '';
    showToast('Nominated! 🏆'); initPOTW();
  } catch (_) { showToast('Failed', 'error'); }
};
window.votePOTW = async function(nomId, direction) {
  try {
    var field = direction === 'up' ? 'votes_up' : 'votes_down';
    var result = await supabase.from('potw_nominations').select(field).eq('id', nomId).single();
    var data = result.data;
    var obj = {}; obj[field] = (data[field] || 0) + 1;
    await supabase.from('potw_nominations').update(obj).eq('id', nomId);
    initPOTW();
  } catch (_) {}
};
async function initPOTW() {
  var c = document.getElementById('potw-nominations'); if (!c) return;
  c.innerHTML = '<p class="text-mist text-sm">Loading...</p>';
  try {
    var result = await supabase.from('potw_nominations').select('*').eq('week', getCurrentWeek()).order('votes_up', { ascending: false });
    var data = result.data;
    if (!data || !data.length) { c.innerHTML = '<p class="text-mist text-sm">No nominations this week.</p>'; return; }
    c.innerHTML = data.map(function(n) {
      return '<div class="post-card flex items-center gap-4"><div class="text-center"><button onclick="votePOTW(\'' + n.id + "','up')\" class=\"text-lg hover:scale-125 transition\">👍</button><p class=\"text-lime font-display text-xl\">" + (n.votes_up || 0) + '</p></div><div class="flex-1 min-w-0"><h4 class=\"text-ice font-medium">' + escHtml(n.player_name) + '</h4><p class=\"text-mist text-xs\">' + escHtml(n.team || '') + (n.rating ? ' ⭐ ' + n.rating : '') + '</p>' + (n.reason ? '<p class=\"text-mist text-xs mt-1">' + escHtml(n.reason) + '</p>' : '') + '<p class=\"text-mist text-xs mt-1\">by ' + escHtml(n.username) + ' · ' + timeAgo(new Date(n.created_at)) + '</p></div><div class="text-center"><button onclick="votePOTW(\'' + n.id + "','down')\" class=\"text-lg hover:scale-125 transition\">👎</button><p class=\"text-coral font-display text-xl\">" + (n.votes_down || 0) + '</p></div></div>';
    }).join('');
  } catch (_) { c.innerHTML = '<p class="text-coral text-xs">Failed.</p>'; }
}

// ═══ ONLINE PRESENCE ═══
var featurePresenceChannel = null;
function initPresence() {
  if (!window.currentUser || featurePresenceChannel) return;
  featurePresenceChannel = supabase.channel('online-users', { config: { presence: { key: window.currentUser.id } } });
  featurePresenceChannel.on('presence', { event: 'sync' }, function() {
    var count = Object.keys(featurePresenceChannel.presenceState()).length;
    var el = document.getElementById('online-count');
    var num = document.getElementById('online-num');
    if (el && num) { num.textContent = count; el.classList.toggle('hidden', count < 2); }
  });
  featurePresenceChannel.subscribe(function(status) {
    if (status === 'SUBSCRIBED') featurePresenceChannel.track({ user_id: window.currentUser.id, username: window.currentUserDoc && window.currentUserDoc.username, online_at: new Date().toISOString() });
  });
}

// ═══ ADMIN ═══
async function initAdmin() {
  var ac = document.getElementById('admin-content');
  if (!ac) return;
  if (!isAdmin()) { ac.innerHTML = '<p class="text-coral text-center py-12">Access denied. Admin only.</p>'; return; }
  try {
    var r1 = await supabase.from('users').select('*', { count: 'exact', head: true });
    var r2 = await supabase.from('posts').select('*', { count: 'exact', head: true });
    var r3 = await supabase.from('chat_messages').select('*', { count: 'exact', head: true });
    var r4 = await supabase.from('reports').select('*').order('created_at', { ascending: false }).limit(20);
    var stats = document.getElementById('admin-stats');
    if (stats) {
      var items = [{ l: 'Users', v: r1.count||0, i: 'users' }, { l: 'Posts', v: r2.count||0, i: 'file-text' }, { l: 'Messages', v: r3.count||0, i: 'message-square' }, { l: 'Reports', v: (r4.data||[]).length, i: 'flag' }];
      stats.innerHTML = items.map(function(s) { return '<div class="bg-turf border border-line rounded-xl p-4 text-center"><i data-lucide="' + s.i + '" class="w-6 h-6 mx-auto text-lime mb-2"></i><p class="text-ice font-display text-2xl">' + s.v + '</p><p class="text-mist text-xs">' + s.l + '</p></div>'; }).join('');
      lucide.createIcons();
    }
    var rl = document.getElementById('admin-reports');
    if (rl) {
      var reports = r4.data || [];
      rl.innerHTML = reports.length ? reports.map(function(r) {
        return '<div class="flex items-center justify-between py-3 border-b border-line"><div><p class="text-ice text-sm">' + escHtml(r.reason) + ' on ' + escHtml(r.content_type) + '</p><p class="text-mist text-xs">' + escHtml(r.content_id) + ' · ' + timeAgo(new Date(r.created_at)) + '</p></div><button onclick="dismissReport(\'' + r.id + '\')" class="text-mist text-xs hover:text-coral">Dismiss</button></div>';
      }).join('') : '<p class="text-mist text-sm">No reports.</p>';
    }
  } catch (_) {}
}
window.dismissReport = async function(id) { await supabase.from('reports').delete().eq('id', id); showToast('Dismissed'); initAdmin(); };

// ═══ BOOTSTRAP ═══
document.addEventListener('DOMContentLoaded', function() {
  // Init presence when user logs in
  if (window.currentUser) initPresence();
  // Watch for auth changes
  var origOnAuth = window.onAuthChange;
  if (origOnAuth) origOnAuth(function(user) { if (user) setTimeout(initPresence, 2000); });
});
