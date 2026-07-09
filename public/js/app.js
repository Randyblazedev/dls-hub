// ═══════════════════════════════════════════════════════════
//  app.js  — DLS Hub Main Application (Supabase Edition)
//  Handles: routing, auth, feed, chat, DMs, leaderboards
//  Migrated from Firebase → Supabase
// ═══════════════════════════════════════════════════════════

import { supabase, getCurrentUser, onAuthChange } from "./supabase-config.js";
window.supabase = supabase; // expose for features.js
window.onAuthChange = onAuthChange; // expose for features.js

// ── Global state ──────────────────────────────────────────
let currentUser   = null;   // Supabase auth user
let currentUserDoc = null;  // Row from "users" table
let activeDMUser  = null;   // Currently open DM conversation

// Expose globals for features.js
window.getCurrentUser = () => currentUser;
window.setCurrentUser = (u) => { currentUser = u; window.currentUser = u; };
window.setCurrentUserDoc = (d) => { currentUserDoc = d; window.currentUserDoc = d; };
let dmUnsubscribe = null;   // Listener cleanup for DMs
let chatUnsubscribe = null; // Listener cleanup for global chat
let feedUnsubscribe = null; // Listener cleanup for feed
let notifications  = [];    // In-memory notification list
let soundEnabled   = localStorage.getItem('dls-sound') !== 'off'; // Sound toggle
let lastChatMsgId  = null;   // Track last chat message to detect new ones
let lastDmMsgId     = null;   // Track last DM message to detect new ones

// ═══════════════════════════════════════════════════════════
//  NOTIFICATION SOUNDS
// ═══════════════════════════════════════════════════════════

const notifAudio = new Audio('/public/sounds/notif.mp3');

function playNotifSound() {
  if (!soundEnabled) return;
  try {
    notifAudio.currentTime = 0;
    notifAudio.play().catch(() => {});
  } catch (_) {}
}

window.toggleSound = function () {
  soundEnabled = !soundEnabled;
  localStorage.setItem('dls-sound', soundEnabled ? 'on' : 'off');
  const icon = document.getElementById('sound-icon');
  if (icon) icon.setAttribute('data-lucide', soundEnabled ? 'volume-2' : 'volume-x');
  lucide.createIcons();
  showToast(soundEnabled ? 'Sound on 🔊' : 'Sound off 🔇');
};

// ═══════════════════════════════════════════════════════════
//  REALTIME / POLLING HELPER
// ═══════════════════════════════════════════════════════════

/**
 * Subscribe to Supabase Realtime postgres_changes on `table`.
 * Falls back to polling every 5 s if Realtime cannot connect.
 * Returns an unsubscribe() function.
 *
 * @param {string}   table   — Supabase table name
 * @param {Function} fetchFn — called whenever the table changes
 * @param {object}   [opts]  — { filter: "dm_id=eq.xxx", interval: 5000 }
 */
function subscribeChanges(table, fetchFn, opts = {}) {
  let pollTimer  = null;
  let live       = false; // only true once a REAL postgres_changes event has fired
  let channel    = null;
  const interval = opts.interval || 5000;
  const chanName = `rt:${table}:${Math.random().toString(36).slice(2)}`; // avoid name collisions across DM threads

  try {
    channel = supabase
      .channel(chanName)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table, filter: opts.filter || undefined },
        () => { live = true; fetchFn(); }
      )
      .subscribe();
  } catch (_) { /* Realtime unavailable — rely on polling */ }

  // Safety-net poll ALWAYS runs; we just skip a fetch if realtime just delivered one,
  // so a silently-broken realtime channel (e.g. table not in publication, or RLS
  // blocking replication) can never leave the UI stuck until manual refresh.
  pollTimer = setInterval(() => { fetchFn(); }, interval);

  return () => {
    if (channel) { supabase.removeChannel(channel); channel = null; }
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  };
}

// ═══════════════════════════════════════════════════════════
//  ROUTER
// ═══════════════════════════════════════════════════════════

/** Navigates to a page by name */
window.navigate = function (page) {
  // Guard: redirect unauthenticated users away from protected pages
  const protected_ = ["feed", "chat", "dm", "profile", "profile-public", "leaderboards", "squads", "predictions", "potw", "admin"];
  if (protected_.includes(page) && !currentUser) {
    navigate("login");
    showToast("Please log in first", "error");
    return;
  }
  if (page === "admin" && !currentUserDoc?.is_admin) {
    navigate(currentUser ? "feed" : "login");
    showToast("Admins only", "error");
    return;
  }

  // Hide all pages
  document.querySelectorAll(".page-view").forEach(el => el.classList.add("hidden"));
  const target = document.getElementById(`page-${page}`);
  if (!target) return;
  target.classList.remove("hidden");

  // Tear down old realtime listeners
  if (page !== "chat" && chatUnsubscribe)  { chatUnsubscribe(); chatUnsubscribe = null; }
  if (page !== "dm"   && dmUnsubscribe)    { dmUnsubscribe();   dmUnsubscribe = null; }
  if (page !== "feed" && feedUnsubscribe)  { feedUnsubscribe(); feedUnsubscribe = null; }

  // Page-specific init
  if (page === "feed")         initFeed();
  if (page === "chat")         initChat();
  if (page === "profile")      initProfile();
  if (page === "leaderboards") initLeaderboard("posts");
  if (page === "dm")           initDM();
  if (page === "squads")       initSquads();
  if (page === "predictions")  initPredictions();
  if (page === "potw")         initPOTW();
  if (page === "admin")        initAdmin();

  // Re-init icons after DOM changes
  setTimeout(() => lucide.createIcons(), 50);

  // Close mobile menu
  document.getElementById("mobile-menu").classList.add("hidden");
};

// ═══════════════════════════════════════════════════════════
//  AUTH STATE
// ═══════════════════════════════════════════════════════════

onAuthChange(async (user) => {
  currentUser = user;
  window.currentUser = user;

  const navAuth       = document.getElementById("nav-auth");
  const authButtons   = document.getElementById("auth-buttons");
  const avatarMenu    = document.getElementById("avatar-menu");
  const notifBtn      = document.getElementById("notif-btn");
  const mobileNavAuth = document.getElementById("mobile-nav-auth");

  if (user) {
    // Fetch user row from Supabase — auto-create if missing (dashboard-created users)
    let { data: row } = await supabase
      .from("users").select("*").eq("uid", user.id).single();
    if (!row) {
      const email = user.email || "";
      const username = email.split("@")[0] || "User";
      const { error: insErr } = await supabase.from("users").insert({
        uid: user.id,
        username,
        email,
        team: "No Team Set",
        avatar: "",
        bio: "",
        postcount: 0,
        joinedat: new Date().toISOString(),
      });
      if (!insErr) {
        const { data: fresh } = await supabase
          .from("users").select("*").eq("uid", user.id).single();
        row = fresh;
      }
    }
    currentUserDoc = row || null;
    window.currentUserDoc = currentUserDoc;

    // Enforce ban server-side truth: banned users get signed out immediately,
    // even if they still have a valid session token.
    if (currentUserDoc?.banned) {
      showToast("Your account has been suspended.", "error");
      await supabase.auth.signOut();
      return;
    }

    // Update nav avatar
    const avatarUrl = currentUserDoc?.avatar ||
      `https://ui-avatars.com/api/?name=${encodeURIComponent(currentUserDoc?.username || "User")}&background=0f1f17&color=b5ff47`;
    document.getElementById("nav-avatar").src = avatarUrl;

    navAuth.style.display = "";
    navAuth.style.flexDirection = "row";
    authButtons.classList.add("hidden");
    avatarMenu.classList.remove("hidden");
    notifBtn.classList.remove("hidden");
    mobileNavAuth.classList.remove("hidden");
    // Show admin link only if the DATABASE says so (server-enforced via RLS),
    // not just a hardcoded client-side email check.
    var adminLink = document.getElementById("admin-nav-link");
    if (adminLink) { adminLink.classList.toggle("hidden", !currentUserDoc?.is_admin); }
    mobileNavAuth.style.display = "flex";

    loadHomeStats();
    startNotifications();
  } else {
    currentUserDoc = null;
    window.currentUserDoc = null;
    navAuth.style.display = "none";
    authButtons.classList.remove("hidden");
    avatarMenu.classList.add("hidden");
    notifBtn.classList.add("hidden");
    mobileNavAuth.classList.add("hidden");

    stopNotifications();
    if (window.cleanupPresence) window.cleanupPresence();

    navigate("home");
  }
});

// ═══════════════════════════════════════════════════════════
//  SIGN UP
// ═══════════════════════════════════════════════════════════

window.handleSignUp = async function () {
  const username = document.getElementById("su-username").value.trim();
  const email    = document.getElementById("su-email").value.trim();
  const password = document.getElementById("su-password").value;
  const team     = document.getElementById("su-team").value.trim();
  const errEl    = document.getElementById("signup-error");

  // Basic validation
  if (!username || !email || !password) {
    showAuthError(errEl, "Please fill in all required fields.");
    return;
  }
  if (username.length < 3) {
    showAuthError(errEl, "Username must be at least 3 characters.");
    return;
  }
  if (password.length < 6) {
    showAuthError(errEl, "Password must be at least 6 characters.");
    return;
  }

  try {
    // Supabase Auth creates the user
    const { data, error } = await supabase.auth.signUp({ email, password });
    if (error) throw error;

    // Write user row to Supabase
    const { error: insertErr } = await supabase.from("users").insert({
      uid:       data.user.id,
      username,
      email,
      team:      team || "No Team Set",
      avatar:    "",
      bio:       "",
      postcount: 0,
      joinedat:  new Date().toISOString(),
    });
    if (insertErr) throw insertErr;

    errEl.classList.add("hidden");
    showToast("Welcome to DLS Hub! 🎉");
    navigate("feed");
  } catch (err) {
    showAuthError(errEl, friendlyAuthError(err.message));
  }
};

// ═══════════════════════════════════════════════════════════
//  LOGIN
// ═══════════════════════════════════════════════════════════

window.handleLogin = async function () {
  const email    = document.getElementById("li-email").value.trim();
  const password = document.getElementById("li-password").value;
  const errEl    = document.getElementById("login-error");

  if (!email || !password) {
    showAuthError(errEl, "Please enter your email and password.");
    return;
  }

  try {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;
    errEl.classList.add("hidden");
    showToast("Logged in successfully ✅");
    navigate("feed");
  } catch (err) {
    showAuthError(errEl, friendlyAuthError(err.message));
  }
};

// ═══════════════════════════════════════════════════════════
//  SIGN OUT
// ═══════════════════════════════════════════════════════════

window.handleSignOut = async function () {
  try {
    const { error } = await supabase.auth.signOut();
    if (error) throw error;
    showToast("Signed out successfully");
    navigate("home");
  } catch (err) {
    showToast("Sign-out failed. Try again.", "error");
  }
};

// ═══════════════════════════════════════════════════════════
//  PROFILE
// ═══════════════════════════════════════════════════════════

async function initProfile() {
  if (!currentUser || !currentUserDoc) return;

  const { username, email, team, avatar, bio } = currentUserDoc;

  // Set avatar (fallback to generated one)
  const avatarUrl = avatar || `https://ui-avatars.com/api/?name=${encodeURIComponent(username)}&background=0f1f17&color=b5ff47&size=200`;
  document.getElementById("profile-avatar").src   = avatarUrl;
  document.getElementById("profile-username").textContent = username;
  document.getElementById("profile-email").textContent    = email;
  document.getElementById("profile-team").textContent     = team ? `⚽ ${team}` : "";

  // Pre-fill edit form
  document.getElementById("edit-username").value = username;
  document.getElementById("edit-team").value     = team || "";
  document.getElementById("edit-bio").value      = bio  || "";

  // Load this user's posts
  await loadProfilePosts(currentUser.id);
}

async function loadProfilePosts(uid) {
  const container = document.getElementById("profile-posts");
  container.innerHTML = `<p class="text-mist text-sm">Loading...</p>`;

  try {
    const { data, error } = await supabase
      .from("posts").select("*")
      .eq("authorid", uid)
      .order("created_at", { ascending: false })
      .limit(20);

    if (error) throw error;

    if (!data || !data.length) {
      container.innerHTML = `<p class="text-mist text-sm">No posts yet. Head to the Feed to share something!</p>`;
      return;
    }

    container.innerHTML = "";
    data.forEach(p => {
      container.innerHTML += buildPostCard(p.id, p, true);
    });
    lucide.createIcons();
  } catch (err) {
    container.innerHTML = `<p class="text-coral text-sm">Failed to load posts.</p>`;
  }
}

window.toggleEditProfile = function () {
  document.getElementById("edit-profile-form").classList.toggle("hidden");
};

window.saveProfile = async function () {
  const username = document.getElementById("edit-username").value.trim();
  const team     = document.getElementById("edit-team").value.trim();
  const bio      = document.getElementById("edit-bio").value.trim();

  if (!username) { showToast("Username cannot be empty", "error"); return; }

  try {
    const { error } = await supabase
      .from("users").update({ username, team, bio }).eq("uid", currentUser.id);
    if (error) throw error;

    currentUserDoc = { ...currentUserDoc, username, team, bio };

    // Sync username across posts, comments, and chat
    await supabase.from("posts").update({ authorname: username }).eq("authorid", currentUser.id);
    await supabase.from("comments").update({ authorname: username }).eq("authorid", currentUser.id);
    await supabase.from("chat_messages").update({ authorname: username }).eq("authorid", currentUser.id);

    document.getElementById("profile-username").textContent = username;
    document.getElementById("profile-team").textContent     = team ? `⚽ ${team}` : "";

    document.getElementById("edit-profile-form").classList.add("hidden");
    showToast("Profile updated ✅");
  } catch (err) {
    showToast("Failed to save. Try again.", "error");
  }
};

window.handleAvatarUpload = async function (event) {
  const file = event.target.files[0];
  if (!file || !currentUser) return;

  if (file.size > 2 * 1024 * 1024) {
    showToast("Image must be under 2 MB", "error"); return;
  }

  try {
    showToast("Uploading avatar...");

    // Upload to Supabase Storage
    const filePath = `avatars/${currentUser.id}`;
    const { error: uploadErr } = await supabase.storage
      .from("avatars").upload(filePath, file, { upsert: true });
    if (uploadErr) throw uploadErr;

    // Get public URL
    const { data: urlData } = supabase.storage
      .from("avatars").getPublicUrl(filePath);
    const url = urlData.publicUrl;

    // Update user row
    const { error: updateErr } = await supabase
      .from("users").update({ avatar: url }).eq("uid", currentUser.id);
    if (updateErr) throw updateErr;

    currentUserDoc = { ...currentUserDoc, avatar: url };

    document.getElementById("profile-avatar").src = url;
    document.getElementById("nav-avatar").src     = url;
    showToast("Avatar updated ✅");
  } catch (err) {
    console.error("AVATAR UPLOAD ERROR:", err);
    showToast("Failed to upload avatar: " + (err.message || "unknown"), "error");
  }
};

// ═══════════════════════════════════════════════════════════
//  COMMUNITY FEED
// ═══════════════════════════════════════════════════════════

function initFeed() {
  const container = document.getElementById("feed-posts");
  container.innerHTML = `<div class="text-center text-mist py-12"><i data-lucide="loader" class="w-6 h-6 mx-auto animate-spin mb-2"></i>Loading feed...</div>`;
  lucide.createIcons();

  async function fetchFeed() {
    try {
      const { data, error } = await supabase
        .from("posts").select("*")
        .order("created_at", { ascending: false })
        .limit(30);
      if (error) throw error;

      if (!data || !data.length) {
        container.innerHTML = `<p class="text-mist text-center py-12">No posts yet. Be the first to post!</p>`;
        return;
      }
      container.innerHTML = "";
      data.forEach(p => {
        container.innerHTML += buildPostCard(p.id, p);
      });
      lucide.createIcons();
    } catch (err) {
      console.error("FEED ERROR:", err);
      container.innerHTML = `<p class="text-coral text-sm">Failed to load feed. Check your connection. (${escHtml(err.message || "unknown")})</p>`;
    }
  }

  fetchFeed();
  feedUnsubscribe = subscribeChanges("posts", fetchFeed);
}

// ── Post image helpers ────────────────────────────────────────
let pendingPostImage = null;

window.previewPostImage = function (e) {
  const file = e.target.files[0];
  if (!file) return;
  pendingPostImage = file;
  const reader = new FileReader();
  reader.onload = function (ev) {
    document.getElementById("post-preview-img").src = ev.target.result;
    document.getElementById("post-image-preview").classList.remove("hidden");
  };
  reader.readAsDataURL(file);
};

window.removePostImage = function () {
  pendingPostImage = null;
  document.getElementById("post-image-input").value = "";
  document.getElementById("post-image-preview").classList.add("hidden");
};

async function uploadPostImage(file) {
  const ext = file.name.split(".").pop();
  const path = `posts/${currentUser.id}/${Date.now()}.${ext}`;
  const { error } = await supabase.storage.from("avatars").upload(path, file);
  if (error) throw error;
  const { data } = supabase.storage.from("avatars").getPublicUrl(path);
  return data?.publicUrl || "";
}

window.submitPost = async function () {
  const textarea = document.getElementById("post-content");
  const content  = textarea.value.trim();
  const postBtn  = document.querySelector("#page-feed .btn-lime");

  if (!content && !pendingPostImage) { showToast("Write something first", "error"); return; }
  if (!currentUser) { showToast("Please log in", "error"); return; }
  if (postBtn?.disabled) return;

  // Disable button to prevent spam
  if (postBtn) { postBtn.disabled = true; postBtn.textContent = "Posting..."; }

  try {
    let imageUrl = "";
    if (pendingPostImage) {
      imageUrl = await uploadPostImage(pendingPostImage);
    }

    const { error } = await supabase.from("posts").insert({
      authorid:       currentUser.id,
      authorname:     currentUserDoc?.username || "Anonymous",
      authoravatar:   currentUserDoc?.avatar   || "",
      content,
      imageurl:   imageUrl,
      created_at:     new Date().toISOString(),
      likes:          [],
      commentcount:   0,
    });
    if (error) throw error;

    const newCount = (currentUserDoc?.postcount || 0) + 1;
    await supabase.from("users").update({ postcount: newCount }).eq("uid", currentUser.id);
    currentUserDoc = { ...currentUserDoc, postcount: newCount };

    textarea.value = "";
    removePostImage();
    if (postBtn) { postBtn.disabled = false; postBtn.textContent = "Post"; }
    showToast("Posted! ✅");
  } catch (err) {
    if (postBtn) { postBtn.disabled = false; postBtn.textContent = "Post"; }
    showToast("Failed to post. Try again.", "error");
  }
};

/** Build HTML for a post card */
function buildPostCard(postId, p, isProfile = false) {
  window.buildPostCard = buildPostCard; // expose for features.js
  const avatarSrc  = p.authoravatar || `https://ui-avatars.com/api/?name=${encodeURIComponent(p.authorname || "U")}&background=0f1f17&color=b5ff47`;
  const timestamp  = p.created_at ? timeAgo(new Date(p.created_at)) : "just now";
  const isMyPost   = currentUser && p.authorid === currentUser.id;
  const canDelete  = isMyPost || currentUserDoc?.is_admin;
  const likeCount  = p.likes?.length || 0;
  const liked      = currentUser && p.likes?.includes(currentUser.id);

  return `
    <div class="post-card" id="post-${postId}">
      <div class="flex items-start gap-3 mb-3">
        <img src="${avatarSrc}" class="w-9 h-9 rounded-full object-cover shrink-0" />
        <div class="flex-1 min-w-0">
          <div class="flex items-center justify-between">
            <span class="font-medium text-ice text-sm">${escHtml(p.authorname)}</span>
            <span class="text-mist text-xs">${timestamp}</span>
          </div>

        </div>
        ${canDelete ? `<button onclick="deletePost('${postId}')" class="text-coral hover:text-white text-xs flex items-center gap-1 ml-2 transition"><i data-lucide="trash-2" class="w-3.5 h-3.5"></i>Delete</button>` : ""}
      </div>
      <p class="text-ice text-sm leading-relaxed mb-4 whitespace-pre-wrap">${escHtml(p.content)}</p>
      ${p.imageurl ? `<img src="${p.imageurl}" alt="Post image" class="w-full max-h-80 object-cover rounded-lg mb-3" />` : ""}
      <div class="flex items-center gap-4 sm:gap-6 text-xs text-mist border-t border-line pt-3 flex-wrap">
        <button onclick="toggleLike('${postId}')"
          class="like-btn flex items-center gap-1.5 hover:text-lime transition ${liked ? "text-lime" : ""}">
          <i data-lucide="thumbs-up" class="w-3.5 h-3.5"></i> ${likeCount}
        </button>
        <button onclick="toggleComments('${postId}')" class="flex items-center gap-1.5 hover:text-lime transition">
          <i data-lucide="message-square" class="w-3.5 h-3.5"></i> ${p.commentcount || 0}
        </button>
        <button onclick="sharePost('${postId}')" class="flex items-center gap-1.5 hover:text-lime transition"><i data-lucide="share-2" class="w-3.5 h-3.5"></i></button>
        <button onclick="reportContent('post','${postId}')" class="flex items-center gap-1.5 hover:text-coral transition"><i data-lucide="flag" class="w-3.5 h-3.5"></i></button>
        <button onclick="openDMFromPost('${p.authorid}','${escHtml(p.authorname)}')" class="flex items-center gap-1.5 hover:text-lime transition">
          <i data-lucide="mail" class="w-3.5 h-3.5"></i> DM
        </button>
      </div>
      <!-- Comment section (collapsed) -->
      <div id="comments-${postId}" class="hidden mt-4 border-t border-line pt-4">
        <div id="comment-list-${postId}" class="space-y-3 mb-3"></div>
        <div class="flex gap-2">
          <input id="comment-input-${postId}" type="text" class="form-input flex-1 py-2 text-sm"
            placeholder="Add a comment..." onkeydown="if(event.key==='Enter')submitComment('${postId}')" />
          <button onclick="submitComment('${postId}')" class="btn-lime px-3 py-2 text-xs">Send</button>
        </div>
      </div>
    </div>`;
}

window.toggleLike = async function (postId) {
  if (!currentUser) { showToast("Log in to like posts", "error"); return; }

  const uid = currentUser.id;

  // Fetch fresh likes from DB to avoid stale data
  const { data: post } = await supabase
    .from("posts").select("likes, authorid").eq("id", postId).single();
  if (!post) return;

  const currentLikes = (post.likes || []).filter(Boolean); // remove nulls
  let newLikes;

  if (currentLikes.includes(uid)) {
    newLikes = currentLikes.filter(id => id !== uid);
  } else {
    newLikes = [...currentLikes, uid];
    if (post.authorid !== uid) {
      pushNotification(post.authorid, `${currentUserDoc?.username} liked your post!`, postId);
    }
  }

  const { error } = await supabase.from("posts").update({ likes: newLikes }).eq("id", postId);
  if (error) { console.error("LIKE FAILED:", error); return; }
  // Re-render the like count
  const btn = document.querySelector(`#post-${postId} .like-btn`);
  if (btn) btn.innerHTML = `<i data-lucide="thumbs-up" class="w-3.5 h-3.5"></i> ${newLikes.length}`;
  lucide.createIcons();
};

window.deletePost = async function (postId) {
  if (!currentUser) return;
  if (!await window.showConfirm("Delete this post?")) return;

  try {
    const { error } = await supabase.from("posts").delete().eq("id", postId);
    if (error) throw error;
    document.getElementById(`post-${postId}`)?.remove();
    showToast("Post deleted");
  } catch (err) {
    showToast("Failed to delete", "error");
  }
};

// ── Delete Comment ──
window.deleteComment = async function (commentId) {
  if (!currentUser) return;
  if (!await window.showConfirm("Delete this comment?")) return;

  try {
    const { error } = await supabase.from("comments").delete().eq("id", commentId);
    if (error) throw error;
    document.getElementById(`comment-${commentId}`)?.remove();
    showToast("Comment deleted");
  } catch (err) {
    showToast("Failed to delete comment", "error");
  }
};

// ── Delete Chat Message ──
window.deleteChatMessage = async function (msgId) {
  if (!currentUser) return;
  if (!await window.showConfirm("Delete this message?")) return;

  try {
    const { error } = await supabase.from("chat_messages").delete().eq("id", msgId);
    if (error) throw error;
    document.getElementById(`chat-msg-${msgId}`)?.remove();
    showToast("Message deleted");
  } catch (err) {
    showToast("Failed to delete message", "error");
  }
};

// ── Delete DM Message ──
window.deleteDMMessage = async function (msgId) {
  if (!currentUser) return;
  if (!await window.showConfirm("Delete this DM?")) return;

  try {
    const { error } = await supabase.from("dm_messages").delete().eq("id", msgId);
    if (error) throw error;
    document.getElementById(`dm-msg-${msgId}`)?.remove();
    showToast("DM deleted");
  } catch (err) {
    showToast("Failed to delete DM", "error");
  }
};

window.toggleComments = async function (postId) {
  const section = document.getElementById(`comments-${postId}`);
  section.classList.toggle("hidden");

  if (!section.classList.contains("hidden")) {
    await loadComments(postId);
  }
};

async function loadComments(postId) {
  const listEl = document.getElementById(`comment-list-${postId}`);
  listEl.innerHTML = `<p class="text-mist text-xs">Loading...</p>`;

  try {
    const { data, error } = await supabase
      .from("comments").select("*")
      .eq("postid", postId)
      .order("created_at", { ascending: true })
      .limit(20);

    if (error) throw error;
    listEl.innerHTML = "";

    if (!data || !data.length) {
      listEl.innerHTML = `<p class="text-mist text-xs">No comments yet. Be first!</p>`;
      return;
    }

    data.forEach(c => {
      const avSrc = c.authoravatar || `https://ui-avatars.com/api/?name=${encodeURIComponent(c.authorname||"U")}&background=0f1f17&color=b5ff47&size=40`;
      const isMine = currentUser && c.authorid === currentUser.id;
      const canDeleteComment = isMine || currentUserDoc?.is_admin;
      listEl.innerHTML += `
        <div class="comment-item" id="comment-${c.id}">
          <img src="${avSrc}" class="w-7 h-7 rounded-full shrink-0 object-cover" />
          <div class="flex-1">
            <div class="flex items-center justify-between">
              <div>
                <span class="text-lime text-xs font-medium mr-2">${escHtml(c.authorname)}</span>
                <span class="text-mist text-xs">${timeAgo(c.created_at ? new Date(c.created_at) : new Date())}</span>
              </div>
              ${canDeleteComment ? `<button onclick="deleteComment('${c.id}')" class="text-coral text-xs hover:text-white"><i data-lucide="trash-2" class="w-3 h-3"></i></button>` : ''}
            </div>
            <p class="text-ice text-xs mt-0.5">${escHtml(c.content)}</p>
          </div>
        </div>`;
    });
  } catch (err) {
    listEl.innerHTML = `<p class="text-coral text-xs">Failed to load comments.</p>`;
  }
}

window.submitComment = async function (postId) {
  const input   = document.getElementById(`comment-input-${postId}`);
  const content = input.value.trim();
  if (!content || !currentUser) return;

  try {
    // Insert comment row
    const { error } = await supabase.from("comments").insert({
      postid:       postId,
      authorid:     currentUser.id,
      authorname:   currentUserDoc?.username || "Anonymous",
      authoravatar: currentUserDoc?.avatar   || "",
      content,
      created_at:   new Date().toISOString(),
    });
    if (error) throw error;

    // Increment comment count on post and get author for notification
    const { data: post } = await supabase
      .from("posts").select("commentcount, authorid").eq("id", postId).single();

    if (post) {
      await supabase
        .from("posts").update({ commentcount: (post.commentcount || 0) + 1 })
        .eq("id", postId);

      // Notify post author if not self
      if (post.authorid !== currentUser.id) {
        pushNotification(post.authorid, `${currentUserDoc?.username} commented on your post.`, postId);
      }
    }

    input.value = "";
    await loadComments(postId);
  } catch (err) {
    showToast("Failed to comment. Try again.", "error");
  }
};

// ═══════════════════════════════════════════════════════════
//  GLOBAL CHAT
// ═══════════════════════════════════════════════════════════

function initChat() {
  const container = document.getElementById("chat-messages");
  container.innerHTML = `<div class="text-center text-mist py-12"><i data-lucide="loader" class="w-6 h-6 mx-auto animate-spin mb-2"></i>Loading chat...</div>`;
  lucide.createIcons();
  const renderedIds = new Set();

  async function fetchChat() {
    try {
      const { data, error } = await supabase
        .from("chat_messages").select("*")
        .order("created_at", { ascending: true })
        .limit(100);
      if (error) throw error;

      if (!data || !data.length) {
        if (!renderedIds.size) {
          container.innerHTML = `<p class="text-mist text-center py-12">No messages yet. Say something!</p>`;
        }
        return;
      }

      // Was the user already near the bottom before we add anything?
      // (must check BEFORE appending, since appending changes scrollHeight)
      const wasNearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 120;
      const isFirstLoad = renderedIds.size === 0;

      // Clear the "no messages yet" placeholder (if any) once real data arrives
      if (isFirstLoad) container.innerHTML = "";

      let addedNew = false;
      data.forEach(m => {
        if (!renderedIds.has(m.id)) {
          renderedIds.add(m.id);
          appendChatMessage(container, m);
          addedNew = true;
          // Play sound for new messages from others
          if (currentUser && m.authorid !== currentUser.id && lastChatMsgId) {
            playNotifSound();
          }
        }
      });
      if (data.length) lastChatMsgId = data[data.length - 1].id;

      // Only jump to the bottom when something new actually arrived, and
      // only if the user hadn't scrolled up to read older messages — the
      // 5s safety-net poll runs constantly, so without this check it would
      // yank the user back to the bottom every few seconds regardless.
      if (addedNew && (isFirstLoad || wasNearBottom)) {
        container.scrollTop = container.scrollHeight;
      }
    } catch (err) {
      console.error("CHAT FETCH ERROR:", err);
      container.innerHTML = `<p class="text-coral text-sm text-center py-12">Failed to load chat: ${escHtml(err.message || "unknown error")}</p>`;
    }
  }

  fetchChat();
  chatUnsubscribe = subscribeChanges("chat_messages", fetchChat);
}

function appendChatMessage(container, m) {
  const isMine    = currentUser && m.authorid === currentUser.id;
  const avatarSrc = m.authoravatar || `https://ui-avatars.com/api/?name=${encodeURIComponent(m.authorname||"U")}&background=0f1f17&color=b5ff47&size=40`;
  const ts        = m.created_at ? timeAgo(new Date(m.created_at)) : "";

  const wrapper = document.createElement("div");
  wrapper.id = `chat-msg-${m.id}`;
  wrapper.className = `flex items-end gap-2 ${isMine ? "flex-row-reverse" : ""}`;
  const replyBlock = m.replytoid ? `
    <div class="border-l-2 border-lime/50 pl-2 mb-1 opacity-70">
      <p class="text-lime text-xs font-medium">${escHtml(m.replytoauthor || "")}</p>
      <p class="text-xs truncate max-w-[200px]">${escHtml(m.replytotext || "")}</p>
    </div>` : "";

  wrapper.innerHTML = `
    <img src="${avatarSrc}" class="w-7 h-7 rounded-full shrink-0 object-cover" />
    <div class="max-w-xs">
      ${!isMine ? `<button onclick="openDMFromPost('${m.authorid}','${escHtml(m.authorname)}')" class="text-xs text-mist mb-1 hover:text-lime transition text-left">${escHtml(m.authorname)}</button>` : ""}
      <div class="${isMine ? "bubble-me" : "bubble-other"}">
        ${replyBlock}
        ${m.imageurl ? `<img src="${m.imageurl}" class="w-full rounded-lg mb-2 cursor-pointer" onclick="window.open('${m.imageurl}','_blank')" />` : ''}
        <p>${escHtml(m.content)}</p>
      </div>
      <div class="flex items-center gap-2 mt-1 ${isMine ? "justify-end" : ""}">
        <p class="text-xs text-mist">${ts}</p>
        <button onclick="startChatReply('${m.id}','${escHtml(m.authorname)}','${escHtml((m.content||'').slice(0,80)).replace(/'/g,"\\'")}')" class="text-mist text-xs hover:text-lime"><i data-lucide="reply" class="w-3 h-3"></i></button>
        ${(isMine || currentUserDoc?.is_admin) ? `<button onclick="deleteChatMessage('${m.id}')" class="text-coral text-xs hover:text-white"><i data-lucide="trash-2" class="w-3 h-3"></i></button>` : ''}
      </div>
    </div>`;

  container.appendChild(wrapper);
  lucide.createIcons();

  const bubbleEl = wrapper.querySelector(".bubble-me, .bubble-other");
  enableSwipeToReply(wrapper, bubbleEl, () =>
    startChatReply(m.id, m.authorname, (m.content || "").slice(0, 80))
  );
}

// ── Swipe-to-reply (WhatsApp-style, touch only) ─────────────
// Swipe a message bubble to the right past the threshold to trigger reply.
// Falls back to the tap reply button for non-touch/desktop.
function enableSwipeToReply(wrapperEl, bubbleEl, onReply) {
  if (!wrapperEl || !bubbleEl) return;
  let startX = 0, dx = 0, dragging = false;
  const THRESHOLD = 60;
  const MAX_DRAG  = 80;

  wrapperEl.style.position = wrapperEl.style.position || "relative";
  wrapperEl.style.touchAction = "pan-y";

  // Reply icon that fades in as you swipe
  const icon = document.createElement("div");
  icon.className = "swipe-reply-icon";
  icon.innerHTML = `<i data-lucide="reply" class="w-4 h-4"></i>`;
  icon.style.cssText = "position:absolute;top:50%;left:-28px;transform:translateY(-50%);opacity:0;color:#b5ff47;pointer-events:none;transition:opacity 0.1s;";
  wrapperEl.style.overflow = "visible";
  wrapperEl.insertBefore(icon, wrapperEl.firstChild);

  wrapperEl.addEventListener("touchstart", (e) => {
    startX = e.touches[0].clientX;
    dragging = true;
    bubbleEl.style.transition = "none";
  }, { passive: true });

  wrapperEl.addEventListener("touchmove", (e) => {
    if (!dragging) return;
    const raw = e.touches[0].clientX - startX;
    dx = Math.max(0, Math.min(raw, MAX_DRAG)); // only allow rightward swipe
    bubbleEl.style.transform = `translateX(${dx}px)`;
    icon.style.opacity = String(Math.min(dx / THRESHOLD, 1));
  }, { passive: true });

  const endDrag = () => {
    if (!dragging) return;
    dragging = false;
    bubbleEl.style.transition = "transform 0.2s ease";
    bubbleEl.style.transform = "translateX(0)";
    icon.style.opacity = "0";
    if (dx >= THRESHOLD) {
      if (navigator.vibrate) navigator.vibrate(10);
      onReply();
    }
    dx = 0;
  };
  wrapperEl.addEventListener("touchend", endDrag);
  wrapperEl.addEventListener("touchcancel", endDrag);
}

// ── Reply-to-message (chat) ─────────────────────────────────
let pendingChatReply = null;

window.startChatReply = function (msgId, authorName, preview) {
  pendingChatReply = { id: msgId, author: authorName, text: preview };
  document.getElementById("chat-reply-author").textContent = authorName;
  document.getElementById("chat-reply-text").textContent = preview;
  document.getElementById("chat-reply-preview").classList.remove("hidden");
  document.getElementById("chat-input")?.focus();
};

window.cancelChatReply = function () {
  pendingChatReply = null;
  document.getElementById("chat-reply-preview").classList.add("hidden");
};

window._pendingChatImage = null;
window.sendChatMessage = async function () {
  const input   = document.getElementById("chat-input");
  const message = input.value.trim();
  if (!message && !window._pendingChatImage) return;
  if (!currentUser) return;

  input.value = "";
  try {
    let imageUrl = null;
    if (window._pendingChatImage) {
      showToast("Uploading image...");
      const ext = window._pendingChatImage.name.split(".").pop();
      const path = "chat-images/" + currentUser.id + "/" + Date.now() + "." + ext;
      const { error: upErr } = await supabase.storage.from("avatars").upload(path, window._pendingChatImage);
      if (upErr) throw upErr;
      imageUrl = supabase.storage.from("avatars").getPublicUrl(path).data.publicUrl;
      window._pendingChatImage = null;
      const preview = document.getElementById("chat-image-preview");
      if (preview) preview.classList.add("hidden");
    }
    const { error } = await supabase.from("chat_messages").insert({
      authorid:      currentUser.id,
      authorname:    currentUserDoc?.username || "Anonymous",
      authoravatar:  currentUserDoc?.avatar   || "",
      content:       message,
      imageurl:      imageUrl,
      created_at:    new Date().toISOString(),
      replytoid:     pendingChatReply?.id || null,
      replytoauthor: pendingChatReply?.author || null,
      replytotext:   pendingChatReply?.text || null,
    });
    if (error) throw error;
    cancelChatReply();
  } catch (err) {
    input.value = message;
    showToast("Failed to send message", "error");
  }
};

// ═══════════════════════════════════════════════════════════
//  DIRECT MESSAGES
// ═══════════════════════════════════════════════════════════

function initDM() {
  loadDMConversations();
}

async function loadDMConversations() {
  const container = document.getElementById("dm-conversations");
  if (!currentUser) return;

  // Query DMs where current user is a participant
  try {
    const { data, error } = await supabase
      .from("dms").select("*")
      .or(`user1id.eq.${currentUser.id},user2id.eq.${currentUser.id}`)
      .order("created_at", { ascending: false })
      .limit(20);

    if (error) throw error;
    container.innerHTML = "";

    if (!data || !data.length) {
      container.innerHTML = `<p class="p-4 text-mist text-sm">No conversations yet.<br/>Search a username to start chatting.</p>`;
      return;
    }

    for (const dm of data) {
      const otherId = dm.user1id === currentUser.id ? dm.user2id : dm.user1id;
      // Fetch other user's profile
      const { data: otherProfile } = await supabase
        .from("public_profiles").select("username, avatar").eq("uid", otherId).single();
      const otherName   = otherProfile?.username || "Unknown";
      const otherAvatar = otherProfile?.avatar || `https://ui-avatars.com/api/?name=${encodeURIComponent(otherName)}&background=0f1f17&color=b5ff47&size=40`;
      const preview     = dm.lastmsg || "";

      container.innerHTML += `
        <div class="dm-convo-item" data-dm-id="${dm.id}" onclick="openDMById('${dm.id}','${otherId}','${escHtml(otherName)}','${escHtml(otherAvatar)}')">
          <img src="${otherAvatar}" class="w-8 h-8 rounded-full shrink-0 object-cover" />
          <div class="min-w-0">
            <p class="text-ice text-sm font-medium truncate">${escHtml(otherName)}</p>
            <p class="text-mist text-xs truncate">${escHtml(preview)}</p>
          </div>
        </div>`;
    }
  } catch (err) {
    container.innerHTML = `<p class="p-4 text-coral text-xs">Failed to load conversations.</p>`;
  }
}

/** Start DM by username search */
window.startDM = async function () {
  const query_    = document.getElementById("dm-search").value.trim();
  if (!query_)    { showToast("Enter a username", "error"); return; }
  if (!currentUser){ showToast("Please log in", "error"); return; }

  try {
    const { data, error } = await supabase
      .from("public_profiles").select("*")
      .eq("username", query_)
      .limit(1);

    if (error) throw error;

    if (!data || !data.length) {
      showToast(`User "${query_}" not found`, "error"); return;
    }

    const targetData = data[0];

    if (targetData.uid === currentUser.id) {
      showToast("You can't DM yourself", "error"); return;
    }

    openDMById(null, targetData.uid, targetData.username, targetData.avatar || "");
    document.getElementById("dm-search").value = "";
  } catch (err) {
    showToast("Search failed. Try again.", "error");
  }
};

/** Open (or create) a DM thread */
window.openDMById = async function (dmId, otherId, otherName, otherAvatar) {
  activeDMUser = { id: otherId, name: otherName, avatar: otherAvatar };
  cancelDMReply();

  document.getElementById("dm-header").textContent = `💬 ${otherName}`;
  document.getElementById("dm-input-area").classList.remove("hidden");
  document.getElementById("dm-messages").innerHTML = `<div class="text-center text-mist py-12"><i data-lucide="loader" class="w-6 h-6 mx-auto animate-spin mb-2"></i>Loading messages...</div>`;
  lucide.createIcons();

  // Unsubscribe from previous DM
  if (dmUnsubscribe) { dmUnsubscribe(); dmUnsubscribe = null; }

  // Determine DM conversation ID (sorted uid pair for uniqueness)
  if (!dmId) {
    dmId = [currentUser.id, otherId].sort().join("_");
  }

  // Create DM row if it doesn't exist
  const { data: existingDm } = await supabase
    .from("dms").select("id").eq("id", dmId).single();

  if (!existingDm) {
    await supabase.from("dms").insert({
      id: dmId,
      user1id:    [currentUser.id, otherId].sort()[0],
      user2id:    [currentUser.id, otherId].sort()[1],
      lastmsg:    "",
      created_at: new Date().toISOString(),
    });
  }

  // Subscribe to DM messages
  const dmContainer = document.getElementById("dm-messages");
  const renderedDmIds = new Set();

  async function fetchDMMessages() {
    const { data, error } = await supabase
      .from("dm_messages").select("*")
      .eq("dmid", dmId)
      .order("created_at", { ascending: true })
      .limit(50);

    if (error) {
      if (!renderedDmIds.size) {
        dmContainer.innerHTML = `<p class="text-coral text-sm text-center py-12">Failed to load messages.</p>`;
      }
      return;
    }
    if (!data) return;

    const isFirstLoad = renderedDmIds.size === 0;
    if (isFirstLoad) dmContainer.innerHTML = "";
    if (isFirstLoad && !data.length) {
      dmContainer.innerHTML = `<p class="text-mist text-sm text-center py-12">No messages yet. Say hi!</p>`;
    }

    const wasNearBottom = dmContainer.scrollHeight - dmContainer.scrollTop - dmContainer.clientHeight < 120;
    let addedNew = false;

    data.forEach(m => {
      if (renderedDmIds.has(m.id)) return;
      renderedDmIds.add(m.id);
      addedNew = true;

      const isMine  = m.senderid === currentUser.id;
      const avSrc   = isMine
        ? (currentUserDoc?.avatar || `https://ui-avatars.com/api/?name=${encodeURIComponent(currentUserDoc?.username||"Me")}&background=0f1f17&color=b5ff47&size=40`)
        : (otherAvatar || `https://ui-avatars.com/api/?name=${encodeURIComponent(otherName)}&background=0f1f17&color=b5ff47&size=40`);

      const dmReplyBlock = m.replytoid ? `
        <div class="border-l-2 border-lime/50 pl-2 mb-1 opacity-70">
          <p class="text-lime text-xs font-medium">${escHtml(m.replytoauthor || "")}</p>
          <p class="text-xs truncate max-w-[200px]">${escHtml(m.replytotext || "")}</p>
        </div>` : "";

      const senderName = isMine ? (currentUserDoc?.username || "Me") : otherName;

      const el = document.createElement("div");
      el.id = `dm-msg-${m.id}`;
      el.className = `flex items-end gap-2 ${isMine ? "flex-row-reverse" : ""}`;
      el.innerHTML = `
        <img src="${avSrc}" class="w-7 h-7 rounded-full shrink-0 object-cover" />
        <div>
          <div class="${isMine ? "bubble-me" : "bubble-other"}">${dmReplyBlock}${escHtml(m.content)}</div>
          <div class="flex items-center gap-2 mt-1 ${isMine ? "justify-end" : ""}">
            <p class="text-xs text-mist">${timeAgo(m.created_at ? new Date(m.created_at) : new Date())}</p>
            <button onclick="startDMReply('${m.id}','${escHtml(senderName).replace(/'/g,"\\'")}','${escHtml((m.content||'').slice(0,80)).replace(/'/g,"\\'")}')" class="text-mist text-xs hover:text-lime"><i data-lucide="reply" class="w-3 h-3"></i></button>
            ${(isMine || currentUserDoc?.is_admin) ? `<button onclick="deleteDMMessage('${m.id}')" class="text-coral text-xs hover:text-white"><i data-lucide="trash-2" class="w-3 h-3"></i></button>` : ''}
          </div>
        </div>`;
      dmContainer.appendChild(el);
      lucide.createIcons();

      const dmBubbleEl = el.querySelector(".bubble-me, .bubble-other");
      enableSwipeToReply(el, dmBubbleEl, () =>
        startDMReply(m.id, senderName, (m.content || "").slice(0, 80))
      );
    });
    if (addedNew && (isFirstLoad || wasNearBottom)) {
      dmContainer.scrollTop = dmContainer.scrollHeight;
    }
  }

  fetchDMMessages();
  dmUnsubscribe = subscribeChanges("dm_messages", fetchDMMessages, { filter: `dmid=eq.${dmId}` });

  // Highlight active conversation
  document.querySelectorAll(".dm-convo-item").forEach(el => el.classList.remove("active"));
  const activeConvoEl = document.querySelector(`.dm-convo-item[data-dm-id="${dmId}"]`);
  if (activeConvoEl) activeConvoEl.classList.add("active");
};

let pendingDMReply = null;

window.startDMReply = function (msgId, authorName, preview) {
  pendingDMReply = { id: msgId, author: authorName, text: preview };
  document.getElementById("dm-reply-author").textContent = authorName;
  document.getElementById("dm-reply-text").textContent = preview;
  document.getElementById("dm-reply-preview").classList.remove("hidden");
  document.getElementById("dm-input")?.focus();
};

window.cancelDMReply = function () {
  pendingDMReply = null;
  document.getElementById("dm-reply-preview")?.classList.add("hidden");
};

window.sendDM = async function () {
  const input   = document.getElementById("dm-input");
  const message = input.value.trim();
  if (!message || !activeDMUser || !currentUser) return;

  input.value = "";
  const dmId = [currentUser.id, activeDMUser.id].sort().join("_");

  try {
    const { error } = await supabase.from("dm_messages").insert({
      dmid:          dmId,
      senderid:      currentUser.id,
      content:       message,
      created_at:    new Date().toISOString(),
      replytoid:     pendingDMReply?.id || null,
      replytoauthor: pendingDMReply?.author || null,
      replytotext:   pendingDMReply?.text || null,
    });
    if (error) throw error;
    cancelDMReply();

    // Update DM doc preview
    await supabase.from("dms").update({
      lastmsg: message,
    }).eq("id", dmId);

    // Push notification to receiver (stored globally; in prod use FCM)
    pushNotification(activeDMUser.id, `New DM from ${currentUserDoc?.username}`);

  } catch (err) {
    input.value = message;
    showToast("Failed to send message", "error");
  }
};

/** Open DM from a post's DM button */
window.openDMFromPost = function (authorId, authorName) {
  if (!currentUser) { showToast("Log in to send DMs", "error"); return; }
  if (authorId === currentUser.id) { showToast("You can't DM yourself", "error"); return; }
  navigate("dm");
  setTimeout(() => openDMById(null, authorId, authorName, ""), 200);
};

// ═══════════════════════════════════════════════════════════
//  LEADERBOARDS
// ═══════════════════════════════════════════════════════════

window.switchLeaderboard = async function (type) {
  document.querySelectorAll(".lb-tab").forEach(el => el.classList.remove("lb-tab-active"));
  document.getElementById(`tab-${type}`).classList.add("lb-tab-active");
  await initLeaderboard(type);
};

async function initLeaderboard(type = "posts") {
  const tbody = document.getElementById("leaderboard-body");
  tbody.innerHTML = `<tr><td colspan="4" class="text-center py-10 text-mist"><i data-lucide="loader" class="w-5 h-5 mx-auto animate-spin mb-2"></i>Loading...</td></tr>`;
  lucide.createIcons();

  try {
    const orderField = type === "posts" ? "postcount" : "joinedat";

    const { data, error } = await supabase
      .from("public_profiles").select("*")
      .order(orderField, { ascending: false })
      .limit(20);

    if (error) throw error;

    if (!data || !data.length) {
      tbody.innerHTML = `<tr><td colspan="4" class="text-center py-10 text-mist">No users yet.</td></tr>`;
      return;
    }

    tbody.innerHTML = "";
    let rank = 0;
    data.forEach(u => {
      rank++;
      const avatarSrc = u.avatar || `https://ui-avatars.com/api/?name=${encodeURIComponent(u.username||"U")}&background=0f1f17&color=b5ff47&size=40`;
      const score     = type === "posts"
        ? `${u.postcount || 0} posts`
        : new Date(u.joinedat).toLocaleDateString();

      const rankClass = rank === 1 ? "lb-rank-1" : rank === 2 ? "lb-rank-2" : rank === 3 ? "lb-rank-3" : "text-mist";
      const medal     = rank === 1 ? "🥇" : rank === 2 ? "🥈" : rank === 3 ? "🥉" : rank;

      tbody.innerHTML += `
        <tr class="lb-row">
          <td class="py-4 px-6 ${rankClass} font-bold">${medal}</td>
          <td class="py-4 px-6">
            <div class="flex items-center gap-3">
              <img src="${avatarSrc}" class="w-8 h-8 rounded-full object-cover" />
              <span class="text-ice font-medium">${escHtml(u.username)}</span>
            </div>
          </td>
          <td class="py-4 px-6 text-mist text-sm">${escHtml(u.team || "—")}</td>
          <td class="py-4 px-6 text-right text-lime font-medium">${score}</td>
        </tr>`;
    });
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="4" class="text-center py-10 text-coral text-sm">Failed to load leaderboard.</td></tr>`;
  }
}

// ═══════════════════════════════════════════════════════════
//  HOME STATS
// ═══════════════════════════════════════════════════════════

async function loadHomeStats() {
  try {
    const [usersRes, postsRes, msgsRes] = await Promise.all([
      supabase.from("public_profiles").select("*", { count: "exact", head: true }),
      supabase.from("posts").select("*", { count: "exact", head: true }),
      supabase.from("chat_messages").select("*", { count: "exact", head: true }),
    ]);

    const fmt = n => n >= 1000 ? (n/1000).toFixed(1) + "k" : n.toString();
    document.getElementById("stat-users").textContent = fmt(usersRes.count || 0);
    document.getElementById("stat-posts").textContent = fmt(postsRes.count || 0);
    document.getElementById("stat-msgs").textContent  = fmt(msgsRes.count || 0);
  } catch (_) { /* stats are non-critical */ }
}

// ═══════════════════════════════════════════════════════════
//  NOTIFICATIONS (persisted in Supabase "notifications" table,
//  so they actually reach the recipient's own session/device)
// ═══════════════════════════════════════════════════════════

let notifUnsubscribe = null;

/** Insert a notification row for the RECIPIENT (never for yourself). */
async function pushNotification(recipientUid, text, postId = null) {
  if (!recipientUid || !currentUser || recipientUid === currentUser.id) return;
  try {
    await supabase.from("notifications").insert({
      userid:     recipientUid,
      fromuser:   currentUserDoc?.username || "Someone",
      fromavatar: currentUserDoc?.avatar || "",
      text,
      postid:     postId,
      read:       false,
      timestamp:  new Date().toISOString(),
    });
  } catch (err) {
    console.error("NOTIFICATION INSERT FAILED:", err);
  }
}

/** Fetch this user's own notifications and render them. */
async function loadNotifications() {
  if (!currentUser) return;
  const listEl  = document.getElementById("notif-list");
  const badge   = document.getElementById("notif-badge");
  if (!listEl) return;

  try {
    const { data, error } = await supabase
      .from("notifications").select("*")
      .eq("userid", currentUser.id)
      .order("timestamp", { ascending: false })
      .limit(20);
    if (error) throw error;

    notifications = data || [];
    const unreadCount = notifications.filter(n => !n.read).length;
    if (badge) badge.classList.toggle("hidden", unreadCount === 0);

    renderNotifications(listEl);
  } catch (err) {
    listEl.innerHTML = `<p class="p-4 text-center text-coral text-xs">Failed to load notifications.</p>`;
  }
}

function renderNotifications(listEl) {
  if (!notifications.length) {
    listEl.innerHTML = `<p class="p-4 text-center text-mist text-sm">No notifications yet</p>`;
    return;
  }
  listEl.innerHTML = notifications.slice(0, 20).map(n => `
    <div class="notif-item ${!n.read ? "bg-lime/5" : ""}">
      <p class="text-ice text-sm">${escHtml(n.text)}</p>
      <p class="text-mist text-xs mt-0.5">${timeAgo(n.timestamp ? new Date(n.timestamp) : new Date())}</p>
    </div>`).join("");
}

/** Start listening for this user's notifications (call after login). */
function startNotifications() {
  if (!currentUser) return;
  loadNotifications();
  playNotifSoundOnNewRow(); // subscribe below
}

// Subscribes with realtime + poll fallback, and plays a sound only for
// notifications that are genuinely new since the listener started.
function playNotifSoundOnNewRow() {
  if (notifUnsubscribe) { notifUnsubscribe(); notifUnsubscribe = null; }
  let knownIds = new Set(notifications.map(n => n.id));
  notifUnsubscribe = subscribeChanges("notifications", async () => {
    const { data } = await supabase
      .from("notifications").select("*")
      .eq("userid", currentUser.id)
      .order("timestamp", { ascending: false })
      .limit(20);
    if (data) {
      const hasNew = data.some(n => !knownIds.has(n.id));
      if (hasNew) playNotifSound();
      knownIds = new Set(data.map(n => n.id));
      notifications = data;
      const listEl = document.getElementById("notif-list");
      const badge  = document.getElementById("notif-badge");
      if (listEl) renderNotifications(listEl);
      if (badge) badge.classList.toggle("hidden", !data.some(n => !n.read));
    }
  }, { filter: `userid=eq.${currentUser.id}` });
}

function stopNotifications() {
  if (notifUnsubscribe) { notifUnsubscribe(); notifUnsubscribe = null; }
  notifications = [];
}

window.toggleNotifications = async function () {
  const panel = document.getElementById("notif-panel");
  panel.classList.toggle("hidden");

  if (!panel.classList.contains("hidden") && currentUser) {
    // Mark all as read when the panel is opened
    document.getElementById("notif-badge").classList.add("hidden");
    const unreadIds = notifications.filter(n => !n.read).map(n => n.id);
    if (unreadIds.length) {
      await supabase.from("notifications").update({ read: true }).in("id", unreadIds);
      notifications = notifications.map(n => ({ ...n, read: true }));
    }
  }
};

window.clearNotifications = async function () {
  if (currentUser) {
    await supabase.from("notifications").delete().eq("userid", currentUser.id);
  }
  notifications = [];
  const listEl = document.getElementById("notif-list");
  if (listEl) renderNotifications(listEl);
  document.getElementById("notif-badge").classList.add("hidden");
};

// ═══════════════════════════════════════════════════════════
//  UI HELPERS
// ═══════════════════════════════════════════════════════════

window.toggleAvatarMenu = function () {
  document.getElementById("avatar-dropdown").classList.toggle("hidden");
};

window.toggleMobileMenu = function () {
  document.getElementById("mobile-menu").classList.toggle("hidden");
};

// Close dropdowns on outside click
document.addEventListener("click", (e) => {
  if (!e.target.closest("#avatar-menu")) {
    document.getElementById("avatar-dropdown")?.classList.add("hidden");
  }
  if (!e.target.closest("#notif-panel") && !e.target.closest("#notif-btn")) {
    document.getElementById("notif-panel")?.classList.add("hidden");
  }
});

/** Show toast notification */
function showToast(msg, type = "success") {
  window.showToast = showToast; // expose for features.js
  const toast  = document.getElementById("toast");
  const msgEl  = document.getElementById("toast-msg");
  const iconEl = document.getElementById("toast-icon");

  msgEl.textContent = msg;
  iconEl.setAttribute("data-lucide", type === "error" ? "alert-circle" : "check-circle");
  iconEl.setAttribute("class", `w-4 h-4 ${type === "error" ? "text-coral" : "text-lime"}`);

  toast.classList.remove("hidden");
  try { lucide.createIcons(); } catch(_) {}

  clearTimeout(toast._timeout);
  toast._timeout = setTimeout(() => toast.classList.add("hidden"), 3000);
}

/** Show auth error */
function showAuthError(el, msg) {
  el.textContent = msg;
  el.classList.remove("hidden");
}

/** Sanitise for HTML injection */
function escHtml(str) {
  window.escHtml = escHtml; // expose for features.js
  if (!str) return "";
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/** Human-readable time ago */
function timeAgo(date) {
  window.timeAgo = timeAgo; // expose for features.js
  if (!date) return "";
  const now   = new Date();
  const diff  = Math.floor((now - date) / 1000);
  if (diff < 60)   return "just now";
  if (diff < 3600) return `${Math.floor(diff/60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff/3600)}h ago`;
  return `${Math.floor(diff/86400)}d ago`;
}

/** Map Supabase auth error messages to friendly text */
function friendlyAuthError(msg) {
  if (!msg) return "Something went wrong. Please try again.";
  const lower = msg.toLowerCase();

  if (lower.includes("already registered") || lower.includes("already been registered"))
    return "That email is already registered. Try logging in.";
  if (lower.includes("invalid email") || lower.includes("invalid format"))
    return "Invalid email address.";
  if (lower.includes("password") && lower.includes("short"))
    return "Password is too weak. Use at least 6 characters.";
  if (lower.includes("password") && lower.includes("weak"))
    return "Password is too weak. Use at least 6 characters.";
  if (lower.includes("user not found") || lower.includes("no user found"))
    return "No account found with that email.";
  if (lower.includes("invalid login") || lower.includes("invalid credentials") || lower.includes("wrong password"))
    return "Incorrect email or password.";
  if (lower.includes("too many") || lower.includes("rate limit"))
    return "Too many failed attempts. Try again later.";
  if (lower.includes("email not confirmed"))
    return "Please confirm your email address first.";

  return "Something went wrong. Please try again.";
}

// ── Theme Toggle ───────────────────────────────────────────
window.toggleTheme = function () {
  const html = document.documentElement;
  const isDark = html.classList.contains('dark');
  html.classList.toggle('dark');
  html.classList.toggle('light');
  localStorage.setItem('dls-theme', isDark ? 'light' : 'dark');
  updateThemeIcon(isDark ? 'light' : 'dark');
}

function updateThemeIcon(theme) {
  const lightIcon = document.getElementById('theme-icon-light');
  const darkIcon = document.getElementById('theme-icon-dark');
  if (lightIcon && darkIcon) {
    lightIcon.classList.toggle('hidden', theme === 'dark');
    darkIcon.classList.toggle('hidden', theme === 'light');
  }
  // Update body class for light mode overrides
  document.body.classList.toggle('bg-white', theme === 'light');
  document.body.classList.toggle('bg-pitch', theme === 'dark');
  document.body.classList.toggle('text-gray-900', theme === 'light');
  document.body.classList.toggle('text-ice', theme === 'dark');
}

// Load saved theme
(function() {
  const saved = localStorage.getItem('dls-theme') || 'dark';
  document.documentElement.classList.remove('dark', 'light');
  document.documentElement.classList.add(saved);
  updateThemeIcon(saved);
})();

// ═══════════════════════════════════════════════════════════
//  PWA INSTALL PROMPT
// ═══════════════════════════════════════════════════════════

let deferredInstallPrompt = null;

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => { /* non-critical */ });
  });
}

window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  const btn = document.getElementById("install-btn");
  if (btn) { btn.classList.remove("hidden"); btn.classList.add("flex"); }
});

// iOS Safari never fires beforeinstallprompt, so show the button with
// manual instructions instead of leaving it permanently hidden there.
function isIOSSafari() {
  const ua = navigator.userAgent;
  const isIOS = /iPad|iPhone|iPod/.test(ua) || (ua.includes("Macintosh") && navigator.maxTouchPoints > 1);
  const isStandalone = window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone;
  return isIOS && !isStandalone;
}
if (isIOSSafari()) {
  document.addEventListener("DOMContentLoaded", () => {
    const btn = document.getElementById("install-btn");
    if (btn) { btn.classList.remove("hidden"); btn.classList.add("flex"); }
  });
}

window.installApp = async function () {
  if (isIOSSafari()) {
    showToast("Tap the Share icon, then 'Add to Home Screen' 📲");
    return;
  }
  if (!deferredInstallPrompt) {
    showToast("App is already installed or not installable here", "error");
    return;
  }
  deferredInstallPrompt.prompt();
  const { outcome } = await deferredInstallPrompt.userChoice;
  if (outcome === "accepted") showToast("App installed 🎉");
  deferredInstallPrompt = null;
  const btn = document.getElementById("install-btn");
  if (btn) { btn.classList.add("hidden"); btn.classList.remove("flex"); }
};

window.addEventListener("appinstalled", () => {
  const btn = document.getElementById("install-btn");
  if (btn) { btn.classList.add("hidden"); btn.classList.remove("flex"); }
  deferredInstallPrompt = null;
});

// ── Bootstrap ─────────────────────────────────────────────
// Initialise Lucide icons on first load
document.addEventListener("DOMContentLoaded", () => {
  lucide.createIcons();
  navigate("home");
});
