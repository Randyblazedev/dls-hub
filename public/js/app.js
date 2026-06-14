
// ═══════════════════════════════════════════════════════════
//  app.js  — DLS Hub Main Application (Supabase Edition)
//  Handles: routing, auth, feed, chat, DMs, leaderboards
//  Migrated from Firebase → Supabase
// ═══════════════════════════════════════════════════════════

import { supabase, getCurrentUser, onAuthChange } from "./supabase-config.js";

// ── Global state ──────────────────────────────────────────
let currentUser   = null;   // Supabase auth user
let currentUserDoc = null;  // Row from "users" table
let activeDMUser  = null;   // Currently open DM conversation
let dmUnsubscribe = null;   // Listener cleanup for DMs
let chatUnsubscribe = null; // Listener cleanup for global chat
let feedUnsubscribe = null; // Listener cleanup for feed
let notifications  = [];    // In-memory notification list

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
  let live       = false;
  let channel    = null;
  const interval = opts.interval || 5000;

  try {
    channel = supabase
      .channel(`rt:${table}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table, filter: opts.filter || undefined },
        () => fetchFn()
      )
      .subscribe((status) => {
        if (status === "SUBSCRIBED") {
          live = true;
          if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
        }
      });
  } catch (_) { /* Realtime unavailable — rely on polling */ }

  pollTimer = setInterval(() => { if (!live) fetchFn(); }, interval);

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
  const protected_ = ["feed", "chat", "dm", "profile", "leaderboards"];
  if (protected_.includes(page) && !currentUser) {
    navigate("login");
    showToast("Please log in first", "error");
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
  if (page === "news")          loadNews();
  if (page === "totw")          loadTOTW();
  if (page === "stats")         loadStats();

  // Re-init icons after DOM changes
  setTimeout(() => lucide.createIcons(), 50);

  // Re-render nav with active state

  // Close mobile menu
  document.getElementById("mobile-menu").classList.add("hidden");
};

// ═══════════════════════════════════════════════════════════
//  AUTH STATE
// ═══════════════════════════════════════════════════════════

onAuthChange(async (user) => {
  currentUser = user;

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
    mobileNavAuth.style.display = "flex";

    loadHomeStats();
  } else {
    currentUserDoc = null;
    navAuth.style.display = "none";
    authButtons.classList.remove("hidden");
    avatarMenu.classList.add("hidden");
    notifBtn.classList.add("hidden");
    mobileNavAuth.classList.add("hidden");

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
  const avatarSrc  = p.authoravatar || `https://ui-avatars.com/api/?name=${encodeURIComponent(p.authorname || "U")}&background=0f1f17&color=b5ff47`;
  const timestamp  = p.created_at ? timeAgo(new Date(p.created_at)) : "just now";
  const isMyPost   = currentUser && p.authorid === currentUser.id;
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
        ${isMyPost ? `<button onclick="deletePost('${postId}')" class="text-coral hover:text-white text-xs flex items-center gap-1 ml-2 transition"><i data-lucide="trash-2" class="w-3.5 h-3.5"></i>Delete</button>` : ""}
      </div>
      <p class="text-ice text-sm leading-relaxed mb-4 whitespace-pre-wrap">${escHtml(p.content)}</p>
      ${p.imageurl ? `<img src="${p.imageurl}" alt="Post image" class="w-full max-h-80 object-cover rounded-lg mb-3" />` : ""}
      <div class="flex items-center gap-6 text-xs text-mist border-t border-line pt-3">
        <button onclick="toggleLike('${postId}')"
          class="like-btn flex items-center gap-1.5 hover:text-lime transition ${liked ? "text-lime" : ""}">
          <i data-lucide="thumbs-up" class="w-3.5 h-3.5"></i> ${likeCount}
        </button>
        <button onclick="toggleComments('${postId}')" class="flex items-center gap-1.5 hover:text-lime transition">
          <i data-lucide="message-square" class="w-3.5 h-3.5"></i> ${p.commentcount || 0}
        </button>
        ${!isProfile ? `<button onclick="openDMFromPost('${p.authorid}','${escHtml(p.authorname)}')" class="flex items-center gap-1.5 hover:text-lime transition ml-auto">
          <i data-lucide="mail" class="w-3.5 h-3.5"></i> DM
        </button>` : ""}
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
      pushNotification(`${currentUserDoc?.username} liked your post!`);
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
  if (!confirm("Delete this post?")) return;

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
  if (!confirm("Delete this comment?")) return;

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
  if (!confirm("Delete this message?")) return;

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
  if (!confirm("Delete this DM?")) return;

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
      const avSrc = c.authorAvatar || `https://ui-avatars.com/api/?name=${encodeURIComponent(c.authorname||"U")}&background=0f1f17&color=b5ff47&size=40`;
      const isMine = currentUser && c.authorid === currentUser.id;
      listEl.innerHTML += `
        <div class="comment-item" id="comment-${c.id}">
          <img src="${avSrc}" class="w-7 h-7 rounded-full shrink-0 object-cover" />
          <div class="flex-1">
            <div class="flex items-center justify-between">
              <div>
                <span class="text-lime text-xs font-medium mr-2">${escHtml(c.authorname)}</span>
                <span class="text-mist text-xs">${timeAgo(c.created_at ? new Date(c.created_at) : new Date())}</span>
              </div>
              ${isMine ? `<button onclick="deleteComment('${c.id}')" class="text-coral text-xs hover:text-white"><i data-lucide="trash-2" class="w-3 h-3"></i></button>` : ''}
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
      postid:      postId,
      authorid:     currentUser.id,
      authorname:   currentUserDoc?.username || "Anonymous",
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
        pushNotification(`${currentUserDoc?.username} commented on your post.`);
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
  container.innerHTML = "";
  const renderedIds = new Set();

  async function fetchChat() {
    try {
      const { data, error } = await supabase
        .from("chat_messages").select("*")
        .order("created_at", { ascending: true })
        .limit(100);
      if (error) throw error;
      if (!data) return;

      data.forEach(m => {
        if (!renderedIds.has(m.id)) {
          renderedIds.add(m.id);
          appendChatMessage(container, m);
        }
      });
      container.scrollTop = container.scrollHeight;
    } catch (_) { /* chat is non-critical */ }
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
  wrapper.innerHTML = `
    <img src="${avatarSrc}" class="w-7 h-7 rounded-full shrink-0 object-cover" />
    <div class="max-w-xs">
      ${!isMine ? `<p class="text-xs text-mist mb-1">${escHtml(m.authorname)}</p>` : ""}
      <div class="${isMine ? "bubble-me" : "bubble-other"}">
        <p>${escHtml(m.content)}</p>
      </div>
      <div class="flex items-center gap-2 mt-1 ${isMine ? "justify-end" : ""}">
        <p class="text-xs text-mist">${ts}</p>
        ${isMine ? `<button onclick="deleteChatMessage('${m.id}')" class="text-coral text-xs hover:text-white"><i data-lucide="trash-2" class="w-3 h-3"></i></button>` : ''}
      </div>
    </div>`;

  container.appendChild(wrapper);
}

window.sendChatMessage = async function () {
  const input   = document.getElementById("chat-input");
  const message = input.value.trim();
  if (!message || !currentUser) return;

  input.value = "";
  try {
    const { error } = await supabase.from("chat_messages").insert({
      authorid:     currentUser.id,
      authorname:   currentUserDoc?.username || "Anonymous",
      authoravatar: currentUserDoc?.avatar   || "",
      content:      message,
      created_at:   new Date().toISOString(),
    });
    if (error) throw error;
  } catch (err) {
    input.value = message; // restore on failure
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
        .from("users").select("username, avatar").eq("uid", otherId).single();
      const otherName   = otherProfile?.username || "Unknown";
      const otherAvatar = otherProfile?.avatar || `https://ui-avatars.com/api/?name=${encodeURIComponent(otherName)}&background=0f1f17&color=b5ff47&size=40`;
      const preview     = dm.lastmsg || "";

      container.innerHTML += `
        <div class="dm-convo-item" onclick="openDMById('${dm.id}','${otherId}','${escHtml(otherName)}','${escHtml(otherAvatar)}')">
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
      .from("users").select("*")
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

  document.getElementById("dm-header").textContent = `💬 ${otherName}`;
  document.getElementById("dm-input-area").classList.remove("hidden");
  document.getElementById("dm-messages").innerHTML = "";

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

    if (error || !data) return;

    data.forEach(m => {
      if (renderedDmIds.has(m.id)) return;
      renderedDmIds.add(m.id);

      const isMine  = m.senderid === currentUser.id;
      const avSrc   = isMine
        ? (currentUserDoc?.avatar || `https://ui-avatars.com/api/?name=${encodeURIComponent(currentUserDoc?.username||"Me")}&background=0f1f17&color=b5ff47&size=40`)
        : (otherAvatar || `https://ui-avatars.com/api/?name=${encodeURIComponent(otherName)}&background=0f1f17&color=b5ff47&size=40`);

      const el = document.createElement("div");
      el.className = `flex items-end gap-2 ${isMine ? "flex-row-reverse" : ""}`;
      el.innerHTML = `
        <img src="${avSrc}" class="w-7 h-7 rounded-full shrink-0 object-cover" />
        <div>
          <div class="${isMine ? "bubble-me" : "bubble-other"}">${escHtml(m.content)}</div>
          <p class="text-xs text-mist mt-1 ${isMine ? "text-right" : ""}">${timeAgo(m.created_at ? new Date(m.created_at) : new Date())}</p>
        </div>`;
      dmContainer.appendChild(el);
    });
    dmContainer.scrollTop = dmContainer.scrollHeight;
  }

  fetchDMMessages();
  dmUnsubscribe = subscribeChanges("dm_messages", fetchDMMessages, { filter: `dmId=eq.${dmId}` });

  // Highlight active conversation
  document.querySelectorAll(".dm-convo-item").forEach(el => el.classList.remove("active"));
};

window.sendDM = async function () {
  const input   = document.getElementById("dm-input");
  const message = input.value.trim();
  if (!message || !activeDMUser || !currentUser) return;

  input.value = "";
  const dmId = [currentUser.id, activeDMUser.id].sort().join("_");

  try {
    const { error } = await supabase.from("dm_messages").insert({
      dmid:      dmId,
      senderid:   currentUser.id,
      content:    message,
      created_at: new Date().toISOString(),
    });
    if (error) throw error;

    // Update DM doc preview
    await supabase.from("dms").update({
      lastmsg: message,
    }).eq("id", dmId);

    // Push notification to receiver (stored globally; in prod use FCM)
    pushNotification(`New DM from ${currentUserDoc?.username}`);

  } catch (err) {
    input.value = message;
    showToast("Failed to send message", "error");
  }
};

/** Open DM from a post's DM button */
window.openDMFromPost = function (authorId, authorName) {
  if (!currentUser) { showToast("Log in to send DMs", "error"); return; }
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
      .from("users").select("*")
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
      supabase.from("users").select("*", { count: "exact", head: true }),
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
//  NOTIFICATIONS (in-memory; extend with Supabase table for persistence)
// ═══════════════════════════════════════════════════════════

function pushNotification(text) {
  notifications.unshift({ text, time: new Date() });

  const badge   = document.getElementById("notif-badge");
  const listEl  = document.getElementById("notif-list");
  badge.classList.remove("hidden");

  renderNotifications(listEl);
}

function renderNotifications(listEl) {
  if (!notifications.length) {
    listEl.innerHTML = `<p class="p-4 text-center text-mist text-sm">No notifications yet</p>`;
    return;
  }
  listEl.innerHTML = notifications.slice(0, 10).map(n => `
    <div class="notif-item">
      <p class="text-ice text-sm">${escHtml(n.text)}</p>
      <p class="text-mist text-xs mt-0.5">${timeAgo(n.time)}</p>
    </div>`).join("");
}

window.toggleNotifications = function () {
  const panel = document.getElementById("notif-panel");
  panel.classList.toggle("hidden");
  // Clear badge
  document.getElementById("notif-badge").classList.add("hidden");
};

window.clearNotifications = function () {
  notifications = [];
  const listEl  = document.getElementById("notif-list");
  renderNotifications(listEl);
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
  const toast  = document.getElementById("toast");
  const msgEl  = document.getElementById("toast-msg");
  const iconEl = document.getElementById("toast-icon");

  msgEl.textContent = msg;
  iconEl.setAttribute("data-lucide", type === "error" ? "alert-circle" : "check-circle");
  iconEl.setAttribute("class", `w-4 h-4 ${type === "error" ? "text-coral" : "text-lime"}`);

  toast.classList.remove("hidden");
  lucide.createIcons(); } catch(_) {}

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

// ── Bootstrap ─────────────────────────────────────────────
// Initialise Lucide icons on first load
document.addEventListener("DOMContentLoaded", () => {
  lucide.createIcons();
  navigate("home");
});

// ═══════════════════════════════════════════════════════════
//  SQUAD BUILDER
// ═══════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════
//  ACHIEVEMENTS
// ═══════════════════════════════════════════════════════════

const ACHIEVEMENT_DEFS = [
  { type: 'first_post', title: 'First Post', description: 'Made your first post', icon: '📝' },
  { type: 'post_10', title: 'Active Poster', description: 'Made 10 posts', icon: '🔥' },
  { type: 'first_comment', title: 'Commentator', description: 'Left your first comment', icon: '💬' },
  { type: 'first_like', title: 'Popular', description: 'Received your first like', icon: '❤️' },
  { type: 'squad_creator', title: 'Squad Boss', description: 'Created your first squad', icon: '⚽' },
  { type: 'chatter', title: 'Chatterbox', description: 'Sent 10 chat messages', icon: '🗣️' },
  { type: 'streak_7', title: '7 Day Streak', description: 'Active for 7 consecutive days', icon: '🔥' },
  { type: 'top_poster', title: 'Top Poster', description: 'Most posts this month', icon: '👑' },
  { type: 'rater', title: 'Critic', description: 'Rated 5 different players', icon: '⭐' },
  { type: 'challenger', title: 'Challenger', description: 'Completed a challenge', icon: '🎯' },
  { type: 'replay_sharer', title: 'Replay King', description: 'Shared a match replay', icon: '🎬' },
  { type: 'predictor', title: 'Fortune Teller', description: 'Made 5 match predictions', icon: '🔮' },
  { type: 'trader', title: 'Transfer Guru', description: 'Listed a player on the market', icon: '💰' },
  { type: 'voter', title: 'Scout', description: 'Voted for POTW or TOTW', icon: '🏅' },
  { type: 'news_poster', title: 'Reporter', description: 'Published a news article', icon: '📰' },
];

// ═══════════════════════════════════════════════════════════
//  CHALLENGES
// ═══════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════
//  PLAYER RATINGS
// ═══════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════
//  MATCH PREDICTOR
// ═══════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════
//  MATCH REPLAYS
// ═══════════════════════════════════════════════════════════

let pendingReplayImage = null;

// ═══════════════════════════════════════════════════════════
//  NEWS FEED
// ═══════════════════════════════════════════════════════════

window.loadNews = async function () {
  const container = document.getElementById('news-content');
  if (!container) return;
  container.innerHTML = '<div class="text-center text-mist py-8"><i data-lucide="loader" class="w-6 h-6 mx-auto animate-spin mb-2"></i>Loading news...</div>';
  lucide.createIcons();

  const uploadHtml = currentUser ? `
    <div class="bg-turf border border-line rounded-2xl p-5 mb-4">
      <h3 class="text-ice font-bold text-lg mb-3">📰 Post News</h3>
      <input id="news-title" class="form-input mb-3" placeholder="Headline" />
      <textarea id="news-body" class="form-input mb-3" rows="3" placeholder="Write your news article..."></textarea>
      <div class="flex items-center gap-3">
        <select id="news-category" class="form-input mb-0" style="width:auto">
          <option value="general">General</option>
          <option value="update">Update</option>
          <option value="tip">Tip</option>
          <option value="event">Event</option>
        </select>
        <button onclick="submitNews()" class="btn-lime text-sm px-6 py-2">Publish</button>
      </div>
    </div>
  ` : '';

  try {
    const { data, error } = await supabase.from('news').select('*').order('created_at', { ascending: false }).limit(20);
    if (error) throw error;
    container.innerHTML = uploadHtml;
    if (!data || !data.length) {
      container.innerHTML += '<p class="text-mist text-center py-8">No news yet. Be the first to post!</p>';
      return;
    }
    data.forEach(n => {
      const isMine = currentUser && n.authorid === currentUser.id;
      container.innerHTML += `
        <div class="bg-turf border border-line rounded-2xl p-5">
          <div class="flex items-center justify-between mb-2">
            <div class="flex items-center gap-2">
              <span class="text-mist text-xs uppercase tracking-wider px-2 py-0.5 bg-lime/10 rounded">${escHtml(n.category || 'general')}</span>
              <span class="text-mist text-xs">${timeAgo(n.created_at)}</span>
            </div>
            ${isMine ? '<button onclick="deleteNews(\'' + n.id + '\')" class="text-coral text-xs hover:text-white">Delete</button>' : ''}
          </div>
          <h3 class="text-ice font-bold text-lg mb-2">${escHtml(n.title)}</h3>
          <p class="text-mist text-sm leading-relaxed whitespace-pre-wrap">${escHtml(n.content)}</p>
          <p class="text-mist text-xs mt-3">by ${escHtml(n.authorname || 'Admin')}</p>
        </div>
      `;
    });
  lucide.createIcons();
  } catch (err) {
    console.error('News error:', err);
    container.innerHTML = '<p class="text-coral text-sm text-center py-8">Failed to load news</p>';
  }
};

window.submitNews = async function () {
  if (!currentUser) { showToast('Please log in', 'error'); return; }
  const title = document.getElementById('news-title').value.trim();
  const content_ = document.getElementById('news-body').value.trim();
  const category = document.getElementById('news-category').value;
  if (!title || !content_) { showToast('Fill in all fields', 'error'); return; }
  try {
    const { error } = await supabase.from('news').insert({
      title, content: content_, category,
      authorid: currentUser.id,
      authorname: currentUserDoc?.username || 'Admin',
    });
    if (error) throw error;
    showToast('News published! 📰');
    loadNews();
  } catch (err) {
    console.error('News error:', err);
    showToast('Failed to publish', 'error');
  }
};

window.deleteNews = async function (id) {
  if (!currentUser) return;
  if (!confirm('Delete this news post?')) return;
  await supabase.from('news').delete().eq('id', id);
  loadNews();
};

// ═══════════════════════════════════════════════════════════
//  TRANSFER MARKET
// ═══════════════════════════════════════════════════════════

window.showCreateTransfer = function () {
  const el = document.getElementById('create-transfer-form');
  if (el) el.classList.toggle('hidden');
};

// ═══════════════════════════════════════════════════════════
//  PLAYER OF THE WEEK
// ═══════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════
//  TEAM OF THE WEEK
// ═══════════════════════════════════════════════════════════

window.loadTOTW = async function () {
  const container = document.getElementById('totw-content');
  if (!container) return;
  const week = getCurrentWeek();
  container.innerHTML = '<div class="text-center text-mist py-8"><i data-lucide="loader" class="w-6 h-6 mx-auto animate-spin mb-2"></i>Loading...</div>';
  lucide.createIcons();

  const nominateHtml = currentUser ? `
    <div class="bg-turf border border-lime/30 rounded-2xl p-5 mb-4">
      <h3 class="text-ice font-bold text-lg mb-3">🏅 Nominate for TOTW</h3>
      <div class="grid grid-cols-1 md:grid-cols-3 gap-3 mb-3">
        <input id="totw-player" class="form-input" placeholder="Player name" />
        <select id="totw-position" class="form-input">
          <option value="GK">GK</option><option value="DEF">DEF</option>
          <option value="MID">MID</option><option value="FWD">FWD</option>
        </select>
        <button onclick="submitTOTW()" class="btn-lime text-sm px-6 py-2">Nominate</button>
      </div>
      <p class="text-mist text-xs">Week: ${week}</p>
    </div>
  ` : '';

  try {
    const { data, error } = await supabase.from('team_of_week').select('*').eq('week', week).order('position').order('vote_count', { ascending: false });
    if (error) throw error;
    container.innerHTML = nominateHtml;

    if (!data || !data.length) {
      container.innerHTML += '<p class="text-mist text-center py-8">No nominations this week. Build the dream team!</p>';
      return;
    }

    // Group by position
    const posOrder = ['GK', 'DEF', 'MID', 'FWD'];
    const grouped = {};
    data.forEach(t => { if (!grouped[t.position]) grouped[t.position] = []; grouped[t.position].push(t); });

    posOrder.forEach(pos => {
      if (!grouped[pos]) return;
      container.innerHTML += '<h3 class="text-lime font-display text-lg mt-4 mb-2">' + pos + '</h3>';
      grouped[pos].forEach(t => {
        const hasVoted = currentUser && (t.votes || []).includes(currentUser.id);
        container.innerHTML += `
          <div class="bg-turf border border-line rounded-xl p-4 flex items-center justify-between mb-2">
            <div>
              <h4 class="text-ice font-bold">${escHtml(t.player_name)}</h4>
              <p class="text-mist text-xs">by ${escHtml(t.username || 'Unknown')}</p>
            </div>
            <div class="flex items-center gap-3">
              <span class="text-lime font-bold">${t.vote_count || 0} votes</span>
              ${currentUser ? '<button onclick="voteTOTW(\''+t.id+'\')" class="btn-'+(hasVoted?'ghost':'lime')+' text-xs px-3 py-1">'+(hasVoted?'✓':'Vote')+'</button>' : ''}
            </div>
          </div>
        `;
      });
    });
  lucide.createIcons();
  } catch (err) {
    console.error('TOTW error:', err);
    container.innerHTML = '<p class="text-coral text-sm text-center py-8">Failed to load TOTW</p>';
  }
};

window.submitTOTW = async function () {
  if (!currentUser) { showToast('Please log in', 'error'); return; }
  const player = document.getElementById('totw-player').value.trim();
  const position = document.getElementById('totw-position').value;
  if (!player) { showToast('Enter a player name', 'error'); return; }
  const week = getCurrentWeek();
  try {
    const { error } = await supabase.from('team_of_week').insert({
      player_name: player, position, userid: currentUser.id,
      username: currentUserDoc?.username || 'Unknown', week,
      votes: [currentUser.id], vote_count: 1,
    });
    if (error) throw error;
    showToast('Nominated for TOTW! 🏅');
    loadTOTW();
  } catch (err) {
    console.error('TOTW error:', err);
    showToast('Failed to nominate', 'error');
  }
};

window.voteTOTW = async function (id) {
  if (!currentUser) { showToast('Please log in', 'error'); return; }
  try {
    const { data: t } = await supabase.from('team_of_week').select('votes, vote_count').eq('id', id).single();
    if (!t) return;
    const votes = t.votes || [];
    if (votes.includes(currentUser.id)) { showToast('Already voted', 'error'); return; }
    const newVotes = [...votes, currentUser.id];
    await supabase.from('team_of_week').update({ votes: newVotes, vote_count: newVotes.length }).eq('id', id);
    showToast('Vote recorded! 🏅');
    loadTOTW();
  } catch (err) {
    console.error('Vote error:', err);
  }
};

// ═══════════════════════════════════════════════════════════
//  STATS DASHBOARD
// ═══════════════════════════════════════════════════════════

window.loadStats = async function () {
  const container = document.getElementById('stats-content');
  if (!container) return;
  container.innerHTML = '<div class="text-center text-mist py-8"><i data-lucide="loader" class="w-6 h-6 mx-auto animate-spin mb-2"></i>Loading stats...</div>';
  lucide.createIcons();

  try {
    const [usersR, postsR, msgsR, predsR, squadsR, replaysR, transfersR, newsR, ratingsR, potwR] = await Promise.all([
      supabase.from('users').select('*', { count: 'exact', head: true }),
      supabase.from('posts').select('*', { count: 'exact', head: true }),
      supabase.from('chat_messages').select('*', { count: 'exact', head: true }),
      supabase.from('predictions').select('*', { count: 'exact', head: true }),
      supabase.from('squads').select('*', { count: 'exact', head: true }),
      supabase.from('replays').select('*', { count: 'exact', head: true }),
      supabase.from('transfers').select('*', { count: 'exact', head: true }),
      supabase.from('news').select('*', { count: 'exact', head: true }),
      supabase.from('player_ratings').select('*', { count: 'exact', head: true }),
      supabase.from('player_of_week').select('*', { count: 'exact', head: true }),
    ]);

    const stats = [
      { label: 'Managers', value: usersR.count || 0, icon: 'users' },
      { label: 'Posts', value: postsR.count || 0, icon: 'message-square' },
      { label: 'Chat Messages', value: msgsR.count || 0, icon: 'message-circle' },
      { label: 'Predictions', value: predsR.count || 0, icon: 'target' },
      { label: 'Squads Built', value: squadsR.count || 0, icon: 'shield' },
      { label: 'Replays Shared', value: replaysR.count || 0, icon: 'play-circle' },
      { label: 'Players Listed', value: transfersR.count || 0, icon: 'banknote' },
      { label: 'News Posts', value: newsR.count || 0, icon: 'newspaper' },
      { label: 'Player Ratings', value: ratingsR.count || 0, icon: 'star' },
      { label: 'POTW Nominations', value: potwR.count || 0, icon: 'trophy' },
    ];

    const fmt = n => n >= 1000 ? (n/1000).toFixed(1) + 'k' : n.toString();

    container.innerHTML = `
      <div class="grid grid-cols-2 md:grid-cols-5 gap-4 mb-8">
        ${stats.map(s => `
          <div class="bg-turf border border-line rounded-2xl p-4 text-center">
            <i data-lucide="${s.icon}" class="w-6 h-6 text-lime mx-auto mb-2"></i>
            <p class="font-display text-2xl text-lime">${fmt(s.value)}</p>
            <p class="text-mist text-xs mt-1">${s.label}</p>
          </div>
        `).join('')}
      </div>
      <div class="bg-turf border border-line rounded-2xl p-5">
        <h3 class="text-ice font-bold mb-3">📈 Community Activity</h3>
        <p class="text-mist text-sm">Total community interactions across all features: <span class="text-lime font-bold">${fmt((postsR.count||0) + (msgsR.count||0) + (predsR.count||0) + (replaysR.count||0) + (ratingsR.count||0))}</span></p>
      </div>
    `;
  lucide.createIcons();
  } catch (err) {
    console.error('Stats error:', err);
    container.innerHTML = '<p class="text-coral text-sm text-center py-8">Failed to load stats</p>';
  }
};


// ═══════════════════════════════════════════════════════════
//  JOIN THE HUB BUTTON HIDE WHEN LOGGED IN
// ═══════════════════════════════════════════════════════════

const joinBtn = document.getElementById('join-hub-btn');
if (joinBtn) {
  const observer = new MutationObserver(() => {
    if (currentUser) joinBtn.style.display = 'none';
    else joinBtn.style.display = '';
  });
  // Check every time auth state changes
  setInterval(() => {
    if (currentUser) joinBtn.style.display = 'none';
    else joinBtn.style.display = '';
  }, 1000);
}
