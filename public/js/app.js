// ═══════════════════════════════════════════════════════════
//  app.js  — DLS Hub Main Application (Supabase Edition)
//  Handles: routing, auth, feed, chat, DMs, leaderboards
//  Migrated from Firebase → Supabase
// ═══════════════════════════════════════════════════════════

// Use globals set by supabase-config.js
var supabase = window._supabaseClient;
var onAuthChange = window.onAuthChange;
window.supabase = supabase;

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
  const protected_ = ["feed", "chat", "dm", "profile", "profile-public", "leaderboards", "admin"];
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
      const pendingUsername = localStorage.getItem("dls-pending-username");
      const pendingTeam = localStorage.getItem("dls-pending-team");
      const username = pendingUsername || email.split("@")[0] || "User";
      const { error: insErr } = await supabase.from("users").insert({
        uid:      user.id,
        username,
        email,
        team:     pendingTeam || "No Team Set",
        avatar:   "",
        bio:      "",
        postcount: 0,
        joinedat: new Date().toISOString(),
      });
      if (!insErr) {
        // Clear pending signup data now that the row is created
        localStorage.removeItem("dls-pending-username");
        localStorage.removeItem("dls-pending-team");
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
    startChatBroadcast();
    startAccountStatusListener();
    // Ask for push permission and register subscription
    setTimeout(registerPushSubscription, 2000); // slight delay so login flow completes first
  } else {
    currentUserDoc = null;
    window.currentUserDoc = null;
    navAuth.style.display = "none";
    authButtons.classList.remove("hidden");
    avatarMenu.classList.add("hidden");
    notifBtn.classList.add("hidden");
    mobileNavAuth.classList.add("hidden");

    stopNotifications();
    stopChatBroadcast();
    stopAccountStatusListener();
    if (window.cleanupPresence) window.cleanupPresence();

    // Reset home page to guest state
    const guestBtns   = document.getElementById("home-guest-btns");
    const authBtns    = document.getElementById("home-auth-btns");
    const statsSection = document.getElementById("home-stats-section");
    if (guestBtns)    guestBtns.classList.remove("hidden");
    if (authBtns)     authBtns.classList.add("hidden");
    if (statsSection) statsSection.classList.add("hidden");

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

  // Only allow safe characters in usernames — letters, numbers, underscore,
  // hyphen. This closes off a whole class of injection attacks (XSS via
  // inline event handlers, markup breakout, etc.) at the source, instead of
  // relying solely on escaping at render time.
  const usernameRegex = /^[a-zA-Z0-9_-]{3,20}$/;
  if (!usernameRegex.test(username)) {
    showAuthError(errEl, "Username can only contain letters, numbers, underscores, and hyphens (3-20 characters).");
    return;
  }

  // Proper email format check — rejects abc@abc, @gmail.com, abc@, etc.
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  if (!emailRegex.test(email)) {
    showAuthError(errEl, "Please enter a valid email address (e.g. you@gmail.com).");
    return;
  }

  // Block obvious disposable/fake email domains
  const blockedDomains = ["mailinator.com","guerrillamail.com","tempmail.com","throwam.com","sharklasers.com","trashmail.com","yopmail.com"];
  const emailDomain = email.split("@")[1]?.toLowerCase();
  if (blockedDomains.includes(emailDomain)) {
    showAuthError(errEl, "Please use a real email address.");
    return;
  }

  // Check username isn't already taken
  try {
    const { data: existing } = await supabase
      .from("users").select("uid").eq("username", username).limit(1);
    if (existing && existing.length > 0) {
      showAuthError(errEl, "That username is already taken. Choose another.");
      return;
    }
  } catch (_) { /* non-critical — proceed */ }

  try {
    // Supabase Auth creates the user
    const { data, error } = await supabase.auth.signUp({ email, password });
    if (error) throw error;

    // Check if Supabase requires email confirmation
    // When confirmation is ON, data.user exists but session is null
    const needsConfirmation = data.user && !data.session;

    if (needsConfirmation) {
      // Store username/team so they're available after the user confirms
      // and logs in for the first time (onAuthChange will pick these up)
      localStorage.setItem("dls-pending-username", username);
      localStorage.setItem("dls-pending-team", team || "No Team Set");
      errEl.classList.add("hidden");
      showConfirmationScreen(email);
      return;
    }

    // Confirmation is OFF — write user row and go straight to feed
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
//  EMAIL CONFIRMATION SCREEN
// ═══════════════════════════════════════════════════════════

function showConfirmationScreen(email) {
  // Hide all pages and show a dedicated confirmation message
  document.querySelectorAll(".page-view").forEach(el => el.classList.add("hidden"));
  const target = document.getElementById("page-signup");
  if (target) target.classList.remove("hidden");

  const errEl = document.getElementById("signup-error");
  errEl.className = "text-lime text-sm bg-lime/10 border border-lime/30 rounded-xl p-4 text-center";
  errEl.innerHTML = `
    <i data-lucide="mail-check" class="w-8 h-8 mx-auto mb-2 text-lime"></i>
    <p class="font-medium mb-1">Check your email!</p>
    <p class="text-mist text-xs">We sent a confirmation link to <strong class="text-ice">${escHtml(email)}</strong>.</p>
    <p class="text-mist text-xs mt-1">Click the link in that email, then come back here and log in.</p>
    <button id="resend-confirm-btn" class="mt-3 text-xs text-mist underline hover:text-lime">Didn't get it? Resend</button>
  `;
  errEl.classList.remove("hidden");
  document.getElementById("resend-confirm-btn")?.addEventListener("click", () => resendConfirmation(email));
  lucide.createIcons();
}

window.resendConfirmation = async function(email) {
  try {
    const { error } = await supabase.auth.resend({ type: "signup", email });
    if (error) throw error;
    showToast("Confirmation email resent ✅");
  } catch (err) {
    showToast("Couldn't resend. Try again later.", "error");
  }
};

// ── LOGIN ──────────────────────────────────────────────────

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
  // Last seen
  var lastSeenEl = document.getElementById("profile-lastseen");
  if (lastSeenEl && currentUserDoc.last_seen) {
    var d = new Date(currentUserDoc.last_seen);
    var now = new Date();
    var diffMin = Math.floor((now - d) / 60000);
    if (diffMin < 2) lastSeenEl.textContent = "🟢 Online now";
    else if (diffMin < 60) lastSeenEl.textContent = "Last seen " + diffMin + " minutes ago";
    else if (diffMin < 1440) lastSeenEl.textContent = "Last seen " + Math.floor(diffMin / 60) + " hours ago";
    else lastSeenEl.textContent = "Last seen " + Math.floor(diffMin / 1440) + " days ago";
  } else if (lastSeenEl) {
    lastSeenEl.textContent = "";
  }
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

  // Same allowlist as signup — never let a raw, unrestricted string become
  // a display name that gets rendered (and interpolated into handlers)
  // all over the app.
  const usernameRegex = /^[a-zA-Z0-9_-]{3,20}$/;
  if (!usernameRegex.test(username)) {
    showToast("Username can only contain letters, numbers, underscores, and hyphens (3-20 characters).", "error");
    return;
  }

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

  const renderedPostIds = new Set();

  async function fetchFeed() {
    try {
      const { data, error } = await supabase
        .from("posts").select("*")
        .order("created_at", { ascending: false })
        .limit(30);
      if (error) throw error;

      if (!data || !data.length) {
        if (!renderedPostIds.size) {
          container.innerHTML = `<p class="text-mist text-center py-12">No posts yet. Be the first to post!</p>`;
        }
        return;
      }

      // Clear loading placeholder on first load only
      if (!renderedPostIds.size) container.innerHTML = "";

      // Build a map of fetched posts for quick lookup
      const fetchedMap = new Map(data.map(p => [p.id, p]));

      // 1. PATCH existing posts in-place (likes, comment count)
      //    Never rebuild the whole card — just update the numbers
      renderedPostIds.forEach(postId => {
        const fresh = fetchedMap.get(postId);
        if (!fresh) return;

        // Update like count and liked state
        const likeBtn = document.querySelector(`#post-${postId} .like-btn`);
        if (likeBtn) {
          const liked = currentUser && (fresh.likes || []).includes(currentUser.id);
          likeBtn.className = `like-btn flex items-center gap-1.5 hover:text-lime transition ${liked ? "text-lime" : ""}`;
          likeBtn.innerHTML = `<i data-lucide="thumbs-up" class="w-3.5 h-3.5"></i> ${(fresh.likes || []).length}`;
        }

        // Update comment count
        const commentBtn = document.querySelector(`#post-${postId} .comment-count`);
        if (commentBtn) {
          commentBtn.textContent = fresh.commentcount || 0;
        }
      });

      // 2. PREPEND new posts (ones not yet in the DOM)
      // Reverse so newest ends up on top after prepending
      const newPosts = data.filter(p => !renderedPostIds.has(p.id));
      newPosts.reverse().forEach(p => {
        renderedPostIds.add(p.id);
        const temp = document.createElement("div");
        temp.innerHTML = buildPostCard(p.id, p);
        const card = temp.firstElementChild;
        // Animate new cards in
        card.style.opacity = "0";
        card.style.transform = "translateY(-8px)";
        container.prepend(card);
        requestAnimationFrame(() => {
          card.style.transition = "opacity 0.25s ease, transform 0.25s ease";
          card.style.opacity = "1";
          card.style.transform = "translateY(0)";
        });
      });

      // 3. REMOVE posts that were deleted
      renderedPostIds.forEach(postId => {
        if (!fetchedMap.has(postId)) {
          document.getElementById(`post-${postId}`)?.remove();
          renderedPostIds.delete(postId);
        }
      });

      lucide.createIcons();
      bindPostCardEvents(container);
    } catch (err) {
      console.error("FEED ERROR:", err);
      if (!renderedPostIds.size) {
        container.innerHTML = `<p class="text-coral text-sm text-center py-12">Failed to load feed. (${escHtml(err.message || "unknown")})</p>`;
      }
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

    const { data: inserted, error } = await supabase.from("posts").insert({
      authorid:       currentUser.id,
      authorname:     currentUserDoc?.username || "Anonymous",
      authoravatar:   currentUserDoc?.avatar   || "",
      content,
      imageurl:   imageUrl,
      created_at:     new Date().toISOString(),
      likes:          [],
      commentcount:   0,
    }).select().single();
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

/** Build HTML for a post card.
 *  IMPORTANT: no inline onclick="" handlers with interpolated user data.
 *  All interactive elements use data-* attributes; a single delegated
 *  listener (bindPostCardEvents) reads those attributes and calls the
 *  right function. This avoids the classic "escaped for HTML but the
 *  browser decodes entities before running onclick as JS" XSS hole.
 */
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
        <img src="${escAttr(avatarSrc)}" class="w-9 h-9 rounded-full object-cover shrink-0" />
        <div class="flex-1 min-w-0">
          <div class="flex items-center justify-between">
            <span class="font-medium text-ice text-sm">${escHtml(p.authorname)}</span>
            <span class="text-mist text-xs">${timestamp}</span>
          </div>

        </div>
        ${canDelete ? `<button data-action="delete-post" data-post-id="${escAttr(postId)}" class="text-coral hover:text-white text-xs flex items-center gap-1 ml-2 transition"><i data-lucide="trash-2" class="w-3.5 h-3.5"></i>Delete</button>` : ""}
      </div>
      <p class="text-ice text-sm leading-relaxed mb-4 whitespace-pre-wrap">${escHtml(p.content).replace(/@(\w+)/g, '<span class="text-blue-400 font-semibold">@$1</span>')}</p>
      ${p.imageurl ? `<img src="${escAttr(p.imageurl)}" alt="Post image" class="w-full max-h-80 object-cover rounded-lg mb-3" />` : ""}
      <div class="flex items-center gap-4 sm:gap-6 text-xs text-mist border-t border-line pt-3 flex-wrap">
        <button data-action="toggle-like" data-post-id="${escAttr(postId)}"
          class="like-btn flex items-center gap-1.5 hover:text-lime transition ${liked ? "text-lime" : ""}">
          <i data-lucide="thumbs-up" class="w-3.5 h-3.5"></i> ${likeCount}
        </button>
        <button data-action="toggle-comments" data-post-id="${escAttr(postId)}" class="flex items-center gap-1.5 hover:text-lime transition">
          <i data-lucide="message-square" class="w-3.5 h-3.5"></i> <span class="comment-count">${p.commentcount || 0}</span>
        </button>
        <button data-action="share-post" data-post-id="${escAttr(postId)}" class="flex items-center gap-1.5 hover:text-lime transition"><i data-lucide="share-2" class="w-3.5 h-3.5"></i></button>
        <button data-action="report" data-target-type="post" data-target-id="${escAttr(postId)}" class="flex items-center gap-1.5 hover:text-coral transition"><i data-lucide="flag" class="w-3.5 h-3.5"></i></button>
        <button data-action="dm-user" data-user-id="${escAttr(p.authorid)}" data-user-name="${escAttr(p.authorname)}" class="flex items-center gap-1.5 hover:text-lime transition">
          <i data-lucide="mail" class="w-3.5 h-3.5"></i> DM
        </button>
      </div>
      <!-- Comment section (collapsed) -->
      <div id="comments-${postId}" class="hidden mt-4 border-t border-line pt-4">
        <div id="comment-list-${postId}" class="space-y-3 mb-3"></div>
        <!-- Reply preview bar (like chat) -->
        <div id="comment-reply-preview-${postId}" class="hidden mb-2 bg-turf border border-line border-l-2 border-l-lime rounded-lg px-3 py-2 flex items-start justify-between gap-2">
          <div class="min-w-0">
            <p class="text-lime text-xs font-medium">Replying to <span class="comment-reply-author"></span></p>
            <p class="comment-reply-text text-mist text-xs truncate"></p>
          </div>
          <button data-action="cancel-comment-reply" data-post-id="${escAttr(postId)}" class="text-mist hover:text-coral text-xs shrink-0">✕</button>
        </div>
        <!-- @mention dropdown -->
        <div id="mention-dropdown-${postId}" class="hidden bg-turf border border-line rounded-xl overflow-hidden mb-2 max-h-40 overflow-y-auto"></div>
        <div class="flex gap-2">
          <input id="comment-input-${postId}" type="text" class="form-input flex-1 py-2 text-sm"
            data-post-id="${escAttr(postId)}"
            placeholder="Add a comment..." />
          <button data-action="submit-comment" data-post-id="${escAttr(postId)}" class="btn-lime px-3 py-2 text-xs">Send</button>
        </div>
      </div>
    </div>`;
}

/** Delegated click/input handler for post cards — reads data-action
 *  attributes instead of relying on inline onclick with interpolated data. */
function bindPostCardEvents(root) {
  if (root._postEventsBound) return;
  root._postEventsBound = true;

  root.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-action]");
    if (!btn || !root.contains(btn)) return;
    const action = btn.dataset.action;
    const postId = btn.dataset.postId;

    if (action === "delete-post") return deletePost(postId);
    if (action === "toggle-like") return toggleLike(postId);
    if (action === "toggle-comments") return toggleComments(postId);
    if (action === "share-post") return sharePost(postId);
    if (action === "report") return reportContent(btn.dataset.targetType, btn.dataset.targetId);
    if (action === "dm-user") return openDMFromPost(btn.dataset.userId, btn.dataset.userName);
    if (action === "cancel-comment-reply") return cancelCommentReply(postId);
    if (action === "submit-comment") return submitComment(postId);
    if (action === "delete-comment") return deleteComment(btn.dataset.commentId);
  });

  root.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const input = e.target.closest('input[id^="comment-input-"]');
    if (input) submitComment(input.dataset.postId);
  });

  root.addEventListener("input", (e) => {
    const input = e.target.closest('input[id^="comment-input-"]');
    if (input) handleCommentInput(input, input.dataset.postId);
  });

  root.addEventListener("focus", (e) => {
    const input = e.target.closest('input[id^="comment-input-"]');
    if (input) setTimeout(() => input.scrollIntoView({ behavior: "smooth", block: "nearest" }), 300);
  }, true);
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
      sendPushToUser(post.authorid, "New Like 👍", `${currentUserDoc?.username} liked your post!`);
    }
  }

  const { error } = await supabase.from("posts").update({ likes: newLikes }).eq("id", postId);
  if (error) { console.error("LIKE FAILED:", error); return; }

  // Update UI immediately (don't wait for next poll)
  const btn = document.querySelector(`#post-${postId} .like-btn`);
  if (btn) {
    const liked = newLikes.includes(uid);
    btn.className = `like-btn flex items-center gap-1.5 hover:text-lime transition ${liked ? "text-lime" : ""}`;
    btn.innerHTML = `<i data-lucide="thumbs-up" class="w-3.5 h-3.5"></i> ${newLikes.length}`;
    lucide.createIcons();
  }
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
    // Find which post this comment belongs to before deleting
    const el = document.getElementById(`comment-${commentId}`);
    const postSection = el?.closest('[id^="comments-"]');
    const postId = postSection?.id?.replace("comments-", "");

    const { error } = await supabase.from("comments").delete().eq("id", commentId);
    if (error) throw error;
    el?.remove();
    // Clear cache so count re-fetches correctly
    if (postId) delete commentRenderedIds[postId];
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
    // Subscribe once per post — don't stack subscriptions
    if (!commentUnsubscribers[postId]) {
      commentUnsubscribers[postId] = subscribeChanges(
        "comments",
        () => loadComments(postId),
        { filter: `postid=eq.${postId}` }
      );
    }
    setTimeout(() => {
      section.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }, 100);
  } else {
    // Unsubscribe and clear cache when closing so it re-fetches fresh next open
    if (commentUnsubscribers[postId]) {
      commentUnsubscribers[postId]();
      delete commentUnsubscribers[postId];
    }
    delete commentRenderedIds[postId];
  }
};

const commentRenderedIds = {};
const commentUnsubscribers = {}; // store per-post realtime unsubscribe fns

async function loadComments(postId) {
  const listEl = document.getElementById(`comment-list-${postId}`);
  if (!listEl) return;

  // Only show loading on very first open, not on subsequent refreshes
  if (!commentRenderedIds[postId]) {
    commentRenderedIds[postId] = new Set();
    listEl.innerHTML = `<p class="text-mist text-xs">Loading...</p>`;
  }

  try {
    const { data, error } = await supabase
      .from("comments").select("*")
      .eq("postid", postId)
      .order("created_at", { ascending: true })
      .limit(50);

    if (error) throw error;

    // Clear loading placeholder only on first real load
    if (commentRenderedIds[postId].size === 0) {
      listEl.innerHTML = "";
      if (!data || !data.length) {
        listEl.innerHTML = `<p class="text-mist text-xs">No comments yet. Be first!</p>`;
        return;
      }
    }

    // Remove "no comments yet" placeholder if we now have comments
    const placeholder = listEl.querySelector("p.text-mist");
    if (placeholder && data?.length) placeholder.remove();

    // Only append genuinely new comments
    (data || []).forEach(c => {
      if (commentRenderedIds[postId].has(c.id)) return;
      commentRenderedIds[postId].add(c.id);

      const avSrc = c.authoravatar || `https://ui-avatars.com/api/?name=${encodeURIComponent(c.authorname||"U")}&background=0f1f17&color=b5ff47&size=40`;
      const isMine = currentUser && c.authorid === currentUser.id;
      const canDeleteComment = isMine || currentUserDoc?.is_admin;

      // Format @mentions in blue bold
      const replyBlock = c.replytoid ? `
        <div class="border-l-2 border-lime/50 pl-2 mb-1 opacity-70">
          <p class="text-lime text-xs font-medium">${escHtml(c.replytoauthor || "")}</p>
          <p class="text-xs truncate">${escHtml(c.replytotext || "")}</p>
        </div>` : "";

      const formattedContent = escHtml(c.content).replace(/@(\w+)/g, '<span class="text-blue-400 font-semibold">@$1</span>');

      const el = document.createElement("div");
      el.className = "comment-item";
      el.id = `comment-${c.id}`;
      el.innerHTML = `
        <img src="${escAttr(avSrc)}" class="w-7 h-7 rounded-full shrink-0 object-cover" />
        <div class="flex-1">
          <div class="flex items-center justify-between">
            <div>
              <span class="text-lime text-xs font-medium mr-2">${escHtml(c.authorname)}</span>
              <span class="text-mist text-xs">${timeAgo(c.created_at ? new Date(c.created_at) : new Date())}</span>
            </div>
            ${canDeleteComment ? `<button data-action="delete-comment" data-comment-id="${escAttr(c.id)}" class="text-coral text-xs hover:text-white"><i data-lucide="trash-2" class="w-3 h-3"></i></button>` : ''}
          </div>
          ${replyBlock}
          <p class="text-ice text-xs mt-0.5">${formattedContent}</p>
        </div>`;
      listEl.appendChild(el);
      lucide.createIcons();

      // Swipe-to-reply — shows quoted preview bar like chat/DMs
      const bubbleEl = el.querySelector(".flex-1");
      enableSwipeToReply(el, bubbleEl, () => {
        startCommentReply(postId, c.id, c.authorname, (c.content || "").slice(0, 80));
      });
    });
  } catch (err) {
    if (!commentRenderedIds[postId]?.size) {
      listEl.innerHTML = `<p class="text-coral text-xs">Failed to load comments.</p>`;
    }
  }
}

const pendingCommentReplies = {}; // keyed by postId

window.startCommentReply = function(postId, commentId, authorName, preview) {
  pendingCommentReplies[postId] = { id: commentId, author: authorName, text: preview };
  const bar = document.getElementById(`comment-reply-preview-${postId}`);
  if (bar) {
    bar.querySelector(".comment-reply-author").textContent = authorName;
    bar.querySelector(".comment-reply-text").textContent = preview;
    bar.classList.remove("hidden");
  }
  const input = document.getElementById(`comment-input-${postId}`);
  if (input) {
    input.placeholder = `Reply to ${authorName}...`;
    input.focus();
    setTimeout(() => input.scrollIntoView({ behavior: "smooth", block: "nearest" }), 300);
  }
};

window.cancelCommentReply = function(postId) {
  delete pendingCommentReplies[postId];
  const bar = document.getElementById(`comment-reply-preview-${postId}`);
  if (bar) bar.classList.add("hidden");
  const input = document.getElementById(`comment-input-${postId}`);
  if (input) input.placeholder = "Add a comment...";
};

window.submitComment = async function (postId) {
  const input   = document.getElementById(`comment-input-${postId}`);
  const btn     = document.querySelector(`#comments-${postId} .btn-lime`);
  const content = input.value.trim();
  const reply   = pendingCommentReplies[postId] || null;
  if (!content || !currentUser) return;
  if (btn?.disabled) return;

  if (btn) { btn.disabled = true; btn.textContent = "..."; }
  input.disabled = true;

  try {
    const { error } = await supabase.from("comments").insert({
      postid:        postId,
      authorid:      currentUser.id,
      authorname:    currentUserDoc?.username || "Anonymous",
      authoravatar:  currentUserDoc?.avatar   || "",
      content,
      replytoid:     reply?.id     || null,
      replytoauthor: reply?.author || null,
      replytotext:   reply?.text   || null,
      created_at:    new Date().toISOString(),
    });
    if (error) throw error;

    const { data: post } = await supabase
      .from("posts").select("commentcount, authorid").eq("id", postId).single();

    if (post) {
      await supabase
        .from("posts").update({ commentcount: (post.commentcount || 0) + 1 })
        .eq("id", postId);
      if (post.authorid !== currentUser.id) {
        pushNotification(post.authorid, `${currentUserDoc?.username} commented on your post.`, postId);
        sendPushToUser(post.authorid, "New Comment 💬", `${currentUserDoc?.username} commented on your post.`);
      }
    }

    input.value = "";
    cancelCommentReply(postId);
    await loadComments(postId);
  } catch (err) {
    showToast("Failed to comment. Try again.", "error");
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Send"; }
    input.disabled = false;
  }
};

// ═══════════════════════════════════════════════════════════
//  GLOBAL CHAT BROADCAST NOTIFICATIONS
//  Uses Supabase Realtime broadcast (no DB writes) so all
//  online users get alerted when someone posts in chat.
// ═══════════════════════════════════════════════════════════

let chatBroadcastChannel = null;

function startChatBroadcast() {
  if (chatBroadcastChannel) return;
  chatBroadcastChannel = supabase.channel("community-chat-activity");

  chatBroadcastChannel
    .on("broadcast", { event: "new-message" }, (payload) => {
      // Only notify if we're NOT on the chat page and it's not our own message
      const chatPage = document.getElementById("page-chat");
      const isOnChat = chatPage && !chatPage.classList.contains("hidden");
      if (isOnChat) return;
      if (payload.payload?.authorid === currentUser?.id) return;

      const author = payload.payload?.authorname || "Someone";
      const preview = (payload.payload?.content || "").slice(0, 50);
      // Toast content is plain text via textContent inside showToast, so
      // no HTML injection risk here — but keep it defensive anyway.
      showToast(`💬 ${author}: ${preview}`);
      playNotifSound();

      // Increment badge count
      const currentCount = parseInt(document.getElementById("notif-badge")?.textContent || "0") || 0;
      updateNotifBadge(currentCount + 1);
      const badge = document.getElementById("notif-badge");
      if (badge) {
        badge.classList.add("animate-bounce");
        setTimeout(() => badge.classList.remove("animate-bounce"), 2000);
      }
    })
    .subscribe();
}

function stopChatBroadcast() {
  if (chatBroadcastChannel) {
    supabase.removeChannel(chatBroadcastChannel);
    chatBroadcastChannel = null;
  }
}

// ═══════════════════════════════════════════════════════════
//  ACCOUNT STATUS BROADCAST — force-signout the instant an admin
//  bans/removes a user, instead of waiting until their next login.
// ═══════════════════════════════════════════════════════════

let accountStatusChannel = null;

function startAccountStatusListener() {
  if (accountStatusChannel) return;
  accountStatusChannel = supabase.channel("account-status");

  accountStatusChannel
    .on("broadcast", { event: "banned" }, (payload) => {
      if (payload.payload?.uid !== currentUser?.id) return;
      showToast("Your account has been suspended.", "error");
      supabase.auth.signOut();
    })
    .subscribe();
}

function stopAccountStatusListener() {
  if (accountStatusChannel) {
    supabase.removeChannel(accountStatusChannel);
    accountStatusChannel = null;
  }
}

/** Broadcast a ban event so the target user's active session is kicked
 *  out immediately, everywhere they're logged in, without waiting for
 *  their next login attempt. */
window.broadcastBanEvent = async function(uid) {
  try {
    const ch = supabase.channel("account-status");
    await ch.subscribe();
    await ch.send({ type: "broadcast", event: "banned", payload: { uid } });
    setTimeout(() => supabase.removeChannel(ch), 1000);
  } catch (_) { /* non-critical — they'll still be blocked on next login */ }
};

// ═══════════════════════════════════════════════════════════
//  GLOBAL CHAT
// ═══════════════════════════════════════════════════════════

// Keep renderedIds outside initChat so it survives navigating away and back.
// Without this, each call to initChat() created a fresh empty Set, causing
// all previously-rendered messages to be re-appended on the next poll.
let chatRenderedIds = new Set();

function initChat() {
  const container = document.getElementById("chat-messages");
  container.innerHTML = `<div class="text-center text-mist py-12"><i data-lucide="loader" class="w-6 h-6 mx-auto animate-spin mb-2"></i>Loading chat...</div>`;
  lucide.createIcons();
  chatRenderedIds = new Set(); // reset only when explicitly re-entering chat
  bindChatEvents(container);

  async function fetchChat() {
    try {
      const { data, error } = await supabase
        .from("chat_messages").select("*")
        .order("created_at", { ascending: true })
        .limit(100);
      if (error) throw error;

      if (!data || !data.length) {
        if (!chatRenderedIds.size) {
          container.innerHTML = `<p class="text-mist text-center py-12">No messages yet. Say something!</p>`;
        }
        return;
      }

      const wasNearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 120;
      const isFirstLoad = chatRenderedIds.size === 0;

      if (isFirstLoad) container.innerHTML = "";

      let addedNew = false;
      data.forEach(m => {
        if (!chatRenderedIds.has(m.id)) {
          chatRenderedIds.add(m.id);
          appendChatMessage(container, m);
          addedNew = true;
          if (currentUser && m.authorid !== currentUser.id && lastChatMsgId) {
            playNotifSound();
          }
        }
      });
      if (data.length) lastChatMsgId = data[data.length - 1].id;

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

/** Delegated handler for chat message actions (reply/delete/dm),
 *  reading data-* attributes instead of inline onclick handlers. */
function bindChatEvents(container) {
  if (container._chatEventsBound) return;
  container._chatEventsBound = true;

  container.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-action]");
    if (!btn || !container.contains(btn)) return;
    const action = btn.dataset.action;

    if (action === "dm-user") return openDMFromPost(btn.dataset.userId, btn.dataset.userName);
    if (action === "chat-reply") return startChatReply(btn.dataset.msgId, btn.dataset.authorName, btn.dataset.preview);
    if (action === "delete-chat-msg") return deleteChatMessage(btn.dataset.msgId);
  });
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

  const preview = (m.content || "").slice(0, 80);

  wrapper.innerHTML = `
    <img src="${escAttr(avatarSrc)}" class="w-7 h-7 rounded-full shrink-0 object-cover" />
    <div class="max-w-xs">
      ${!isMine ? `<button data-action="dm-user" data-user-id="${escAttr(m.authorid)}" data-user-name="${escAttr(m.authorname)}" class="text-xs text-mist mb-1 hover:text-lime transition text-left">${escHtml(m.authorname)}</button>` : ""}
      <div class="${isMine ? "bubble-me" : "bubble-other"}">
        ${replyBlock}
        ${m.imageurl ? `<img src="${escAttr(m.imageurl)}" class="w-full rounded-lg mb-2 cursor-pointer" data-action="open-image" data-url="${escAttr(m.imageurl)}" />` : ''}
        <p>${escHtml(m.content).replace(/@(\w+)/g, '<span class="text-blue-400 font-semibold">@$1</span>')}</p>
      </div>
      <div class="flex items-center gap-2 mt-1 ${isMine ? "justify-end" : ""}">
        <p class="text-xs text-mist">${ts}</p>
        <button data-action="chat-reply" data-msg-id="${escAttr(m.id)}" data-author-name="${escAttr(m.authorname)}" data-preview="${escAttr(preview)}" class="text-mist text-xs hover:text-lime"><i data-lucide="reply" class="w-3 h-3"></i></button>
        ${(isMine || currentUserDoc?.is_admin) ? `<button data-action="delete-chat-msg" data-msg-id="${escAttr(m.id)}" class="text-coral text-xs hover:text-white"><i data-lucide="trash-2" class="w-3 h-3"></i></button>` : ''}
      </div>
    </div>`;

  container.appendChild(wrapper);
  lucide.createIcons();

  // Image click-to-open, without an inline onclick handler
  const imgEl = wrapper.querySelector('[data-action="open-image"]');
  if (imgEl) imgEl.addEventListener("click", () => window.open(imgEl.dataset.url, "_blank"));

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
let _chatSending = false; // lock to prevent double-tap duplicate messages

window.sendChatMessage = async function () {
  if (_chatSending) return; // block double-tap
  const input   = document.getElementById("chat-input");
  const sendBtn = document.getElementById("chat-send-btn");
  const message = input.value.trim();
  if (!message && !window._pendingChatImage) return;
  if (!currentUser) return;

  _chatSending = true;
  if (sendBtn) { sendBtn.disabled = true; }
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

    // Broadcast to all online users so they get a live notification
    // even if they're not on the chat page — no DB writes needed
    if (chatBroadcastChannel) {
      chatBroadcastChannel.send({
        type: "broadcast",
        event: "new-message",
        payload: {
          authorid:   currentUser.id,
          authorname: currentUserDoc?.username || "Someone",
          content:    message,
        },
      });
    }
  } catch (err) {
    input.value = message; // restore on failure
    showToast("Failed to send message", "error");
  } finally {
    _chatSending = false;
    if (sendBtn) { sendBtn.disabled = false; }
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
    bindDMConversationEvents(container);

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
        <div class="dm-convo-item" data-dm-id="${escAttr(dm.id)}" data-other-id="${escAttr(otherId)}" data-other-name="${escAttr(otherName)}" data-other-avatar="${escAttr(otherAvatar)}">
          <img src="${escAttr(otherAvatar)}" class="w-8 h-8 rounded-full shrink-0 object-cover" />
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

function bindDMConversationEvents(container) {
  if (container._dmEventsBound) return;
  container._dmEventsBound = true;
  container.addEventListener("click", (e) => {
    const item = e.target.closest(".dm-convo-item");
    if (!item) return;
    openDMById(item.dataset.dmId, item.dataset.otherId, item.dataset.otherName, item.dataset.otherAvatar);
  });
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
  bindDMMessageEvents(dmContainer);
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
      const preview = (m.content || "").slice(0, 80);

      const el = document.createElement("div");
      el.id = `dm-msg-${m.id}`;
      el.className = `flex items-end gap-2 ${isMine ? "flex-row-reverse" : ""}`;
      el.innerHTML = `
        <img src="${escAttr(avSrc)}" class="w-7 h-7 rounded-full shrink-0 object-cover" />
        <div>
          <div class="${isMine ? "bubble-me" : "bubble-other"}">${dmReplyBlock}${escHtml(m.content).replace(/@(\w+)/g, '<span class="text-blue-400 font-semibold">@$1</span>')}</div>
          <div class="flex items-center gap-2 mt-1 ${isMine ? "justify-end" : ""}">
            <p class="text-xs text-mist">${timeAgo(m.created_at ? new Date(m.created_at) : new Date())}</p>
            <button data-action="dm-reply" data-msg-id="${escAttr(m.id)}" data-author-name="${escAttr(senderName)}" data-preview="${escAttr(preview)}" class="text-mist text-xs hover:text-lime"><i data-lucide="reply" class="w-3 h-3"></i></button>
            ${(isMine || currentUserDoc?.is_admin) ? `<button data-action="delete-dm-msg" data-msg-id="${escAttr(m.id)}" class="text-coral text-xs hover:text-white"><i data-lucide="trash-2" class="w-3 h-3"></i></button>` : ''}
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
  const activeConvoEl = document.querySelector(`.dm-convo-item[data-dm-id="${cssEscape(dmId)}"]`);
  if (activeConvoEl) activeConvoEl.classList.add("active");
};

function bindDMMessageEvents(container) {
  if (container._dmMsgEventsBound) return;
  container._dmMsgEventsBound = true;
  container.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-action]");
    if (!btn || !container.contains(btn)) return;
    const action = btn.dataset.action;
    if (action === "dm-reply") return startDMReply(btn.dataset.msgId, btn.dataset.authorName, btn.dataset.preview);
    if (action === "delete-dm-msg") return deleteDMMessage(btn.dataset.msgId);
  });
}

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

let _dmSending = false;

window.sendDM = async function () {
  if (_dmSending) return;
  const input   = document.getElementById("dm-input");
  const sendBtn = document.querySelector("#dm-input-area .btn-lime");
  const message = input.value.trim();
  if (!message || !activeDMUser || !currentUser) return;

  _dmSending = true;
  if (sendBtn) sendBtn.disabled = true;
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

    await supabase.from("dms").update({ lastmsg: message }).eq("id", dmId);
    pushNotification(activeDMUser.id, `New DM from ${currentUserDoc?.username}`);
    sendPushToUser(activeDMUser.id, "New DM 📩", `${currentUserDoc?.username}: ${message.slice(0, 60)}`);

  } catch (err) {
    input.value = message;
    showToast("Failed to send message", "error");
  } finally {
    _dmSending = false;
    if (sendBtn) sendBtn.disabled = false;
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
  const scoreHeader = document.getElementById("lb-score-header");
  tbody.innerHTML = `<tr><td colspan="4" class="text-center py-10 text-mist"><i data-lucide="loader" class="w-5 h-5 mx-auto animate-spin mb-2"></i>Loading...</td></tr>`;
  if (scoreHeader) scoreHeader.textContent = type === "posts" ? "Posts" : "Joined";
  lucide.createIcons();
  bindLeaderboardEvents(tbody);

  try {
    const orderField = type === "posts" ? "postcount" : "joinedat";
    // Newest = most recently joined (descending). Most Active = most posts (descending).
    const ascending = false;

    // Fetch ALL users — no limit
    const { data, error } = await supabase
      .from("public_profiles").select("*")
      .order(orderField, { ascending })
      .limit(1000);

    if (error) throw error;

    if (!data || !data.length) {
      tbody.innerHTML = `<tr><td colspan="4" class="text-center py-10 text-mist">No users yet.</td></tr>`;
      return;
    }

    tbody.innerHTML = "";
    data.forEach((u, i) => {
      const rank = i + 1;
      const avatarSrc = u.avatar || `https://ui-avatars.com/api/?name=${encodeURIComponent(u.username||"U")}&background=0f1f17&color=b5ff47&size=40`;
      const scoreVal = type === "posts"
        ? `${u.postcount || 0} posts`
        : u.joinedat ? new Date(u.joinedat).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "—";

      const rankClass = rank === 1 ? "lb-rank-1" : rank === 2 ? "lb-rank-2" : rank === 3 ? "lb-rank-3" : "text-mist";
      const medal     = rank === 1 ? "🥇" : rank === 2 ? "🥈" : rank === 3 ? "🥉" : rank;
      const isMe      = currentUser && u.uid === currentUser.id;

      tbody.innerHTML += `
        <tr class="lb-row cursor-pointer hover:bg-white/5 transition" data-user-id="${escAttr(u.uid)}" data-user-name="${escAttr(u.username)}" data-user-avatar="${escAttr(u.avatar||"")}">
          <td class="py-4 px-6 ${rankClass} font-bold">${medal}</td>
          <td class="py-4 px-6">
            <div class="flex items-center gap-3">
              <div class="relative shrink-0">
                <img src="${escAttr(avatarSrc)}" class="w-8 h-8 rounded-full object-cover" />
                <span class="lb-online-dot hidden absolute bottom-0 right-0 w-2.5 h-2.5 bg-blue-500 rounded-full border-2 border-pitch" data-uid="${escAttr(u.uid)}"></span>
              </div>
              <span class="text-ice font-medium">${escHtml(u.username)}${isMe ? ' <span class="text-lime text-xs">(you)</span>' : ""}</span>
            </div>
          </td>
          <td class="py-4 px-6 text-mist text-sm">${escHtml(u.team || "—")}</td>
          <td class="py-4 px-6 text-right text-lime font-medium">${scoreVal}</td>
        </tr>`;
    });

    // Apply current online state to dots immediately
    if (window.onlineUserIds) {
      document.querySelectorAll('.lb-online-dot').forEach(dot => {
        dot.classList.toggle('hidden', !window.onlineUserIds.has(dot.dataset.uid));
      });
    }

    lucide.createIcons();
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="4" class="text-center py-10 text-coral text-sm">Failed to load leaderboard.</td></tr>`;
  }
}

function bindLeaderboardEvents(tbody) {
  if (tbody._lbEventsBound) return;
  tbody._lbEventsBound = true;
  tbody.addEventListener("click", (e) => {
    const row = e.target.closest(".lb-row");
    if (!row) return;
    lbTapUser(row.dataset.userId, row.dataset.userName, row.dataset.userAvatar);
  });
}

// ═══════════════════════════════════════════════════════════
//  HOME STATS
// ═══════════════════════════════════════════════════════════

async function loadHomeStats() {
  // Show/hide home page sections based on auth state
  const guestBtns  = document.getElementById("home-guest-btns");
  const authBtns   = document.getElementById("home-auth-btns");
  const statsSection = document.getElementById("home-stats-section");

  if (currentUser) {
    if (guestBtns)   guestBtns.classList.add("hidden");
    if (authBtns)    { authBtns.classList.remove("hidden"); authBtns.classList.add("flex"); }
    // Stats only visible to admin
    if (statsSection) statsSection.classList.toggle("hidden", !currentUserDoc?.is_admin);
  } else {
    if (guestBtns)   guestBtns.classList.remove("hidden");
    if (authBtns)    authBtns.classList.add("hidden");
    if (statsSection) statsSection.classList.add("hidden");
    return; // don't bother fetching counts for guests
  }

  // Only admins see the numbers
  if (!currentUserDoc?.is_admin) return;

  try {
    const [usersRes, postsRes, msgsRes] = await Promise.all([
      // Only count non-banned users
      supabase.from("public_profiles").select("*", { count: "exact", head: true }),
      supabase.from("posts").select("*", { count: "exact", head: true }),
      supabase.from("chat_messages").select("*", { count: "exact", head: true }),
    ]);

    const fmt = n => n >= 1000 ? (n / 1000).toFixed(1) + "k" : (n || 0).toString();
    document.getElementById("stat-users").textContent = fmt(usersRes.count || 0);
    document.getElementById("stat-posts").textContent = fmt(postsRes.count || 0);
    document.getElementById("stat-msgs").textContent  = fmt(msgsRes.count || 0);
  } catch (_) { /* stats are non-critical */ }
}
window.loadHomeStats = loadHomeStats; // expose for features.js admin ban/remove actions

// ═══════════════════════════════════════════════════════════
//  NOTIFICATIONS (persisted in Supabase "notifications" table,
//  so they actually reach the recipient's own session/device)
// ═══════════════════════════════════════════════════════════

let notifUnsubscribe = null;

/** Insert a notification row for the RECIPIENT (never for yourself). */
async function pushNotification(recipientUid, text, postId = null) {
  if (!recipientUid || !currentUser || recipientUid === currentUser.id) return;
  try {
    const now = new Date().toISOString();
    const { error } = await supabase.from("notifications").insert({
      userid:     recipientUid,
      fromuser:   currentUserDoc?.username || "Someone",
      fromavatar: currentUserDoc?.avatar || "",
      text,
      postid:     postId,
      read:       false,
      timestamp:  now,
      created_at: now, // write both so ordering works either way
    });
    if (error) console.error("NOTIFICATION INSERT FAILED:", error.message, error.details);
  } catch (err) {
    console.error("NOTIFICATION INSERT FAILED:", err);
  }
}

/** Fetch this user's own notifications and render them. */
async function loadNotifications() {
  if (!currentUser) return;
  const listEl = document.getElementById("notif-list");
  const badge  = document.getElementById("notif-badge");
  if (!listEl) return;

  try {
    // Try 'created_at' first (most common Supabase default), fall back to 'timestamp'
    let result = await supabase
      .from("notifications").select("*")
      .eq("userid", currentUser.id)
      .order("created_at", { ascending: false })
      .limit(20);

    // If created_at doesn't exist, try timestamp column
    if (result.error && result.error.message?.includes("created_at")) {
      result = await supabase
        .from("notifications").select("*")
        .eq("userid", currentUser.id)
        .order("timestamp", { ascending: false })
        .limit(20);
    }

    if (result.error) throw result.error;

    notifications = result.data || [];
    const unreadCount = notifications.filter(n => !n.read).length;
    updateNotifBadge(unreadCount);
    renderNotifications(listEl);
  } catch (err) {
    console.error("NOTIF LOAD ERROR:", err);
    listEl.innerHTML = `<p class="p-4 text-center text-coral text-xs">Failed to load notifications: ${escHtml(err.message || "")}</p>`;
  }
}

function updateNotifBadge(count) {
  const badge = document.getElementById("notif-badge");
  if (!badge) return;
  if (count > 0) {
    badge.textContent = count > 99 ? "99+" : count;
    badge.classList.remove("hidden");
  } else {
    badge.classList.add("hidden");
  }
}

function renderNotifications(listEl) {
  if (!notifications.length) {
    listEl.innerHTML = `<p class="p-4 text-center text-mist text-sm">No notifications yet</p>`;
    return;
  }
  listEl.innerHTML = notifications.slice(0, 20).map(n => {
    const avatar = n.fromavatar || `https://ui-avatars.com/api/?name=${encodeURIComponent(n.fromuser||"?")}&background=0f1f17&color=b5ff47&size=40`;
    const time = n.created_at || n.timestamp;
    return `
    <div class="notif-item flex items-start gap-3 ${!n.read ? "bg-lime/5" : ""}">
      <img src="${escAttr(avatar)}" class="w-8 h-8 rounded-full shrink-0 object-cover mt-0.5" />
      <div class="min-w-0">
        <p class="text-ice text-sm leading-snug">${escHtml(n.text || "")}</p>
        <p class="text-mist text-xs mt-0.5">${timeAgo(time ? new Date(time) : new Date())}</p>
      </div>
    </div>`;
  }).join("");
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
  let orderCol = "created_at";

  // CRITICAL: filter to only THIS user's notifications so realtime
  // fires on YOUR rows, not on everyone else's notification inserts.
  notifUnsubscribe = subscribeChanges("notifications", async () => {
    let result = await supabase
      .from("notifications").select("*")
      .eq("userid", currentUser.id)
      .order(orderCol, { ascending: false })
      .limit(20);

    if (result.error && result.error.message?.includes(orderCol)) {
      orderCol = orderCol === "created_at" ? "timestamp" : "created_at";
      result = await supabase
        .from("notifications").select("*")
        .eq("userid", currentUser.id)
        .order(orderCol, { ascending: false })
        .limit(20);
    }

    const data = result.data;
    if (data) {
      const newOnes = data.filter(n => !knownIds.has(n.id));
      if (newOnes.length) {
        playNotifSound();
        newOnes.forEach(n => {
          showToast(`🔔 ${n.text || "New notification"}`);
        });
        // Bounce the badge to draw attention
        const badge = document.getElementById("notif-badge");
        if (badge) {
          badge.classList.add("animate-bounce");
          setTimeout(() => badge.classList.remove("animate-bounce"), 2000);
        }
      }
      knownIds = new Set(data.map(n => n.id));
      notifications = data;
      const listEl = document.getElementById("notif-list");
      if (listEl) renderNotifications(listEl);
      updateNotifBadge(data.filter(n => !n.read).length);
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
    // Mark all as read when panel opens — badge goes to 0
    updateNotifBadge(0);
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
  updateNotifBadge(0);
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

  // textContent — never innerHTML — so toast messages built from
  // user-controlled data (usernames, message previews) can't inject markup.
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

/** Sanitise for HTML text-node context (element content) */
function escHtml(str) {
  window.escHtml = escHtml; // expose for features.js
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/** Sanitise for use inside an HTML *attribute* value (e.g. data-foo="...").
 *  Same escaping as escHtml, but named separately and used everywhere a
 *  value is placed inside an attribute, never inside an inline event
 *  handler string — attribute values are safe once entities are escaped,
 *  because nothing re-parses them as JS (unlike onclick="..." which is
 *  entity-decoded and then executed as script). */
function escAttr(str) {
  window.escAttr = escAttr;
  return escHtml(str);
}

/** Escape a value for safe interpolation into a CSS attribute selector,
 *  e.g. `[data-dm-id="${cssEscape(id)}"]`. Uses the native CSS.escape
 *  when available. */
function cssEscape(str) {
  window.cssEscape = cssEscape;
  if (!str) return "";
  if (window.CSS && CSS.escape) return CSS.escape(String(str));
  return String(str).replace(/["\\]/g, "\\$&");
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
    return "Your email hasn't been confirmed yet. Check your inbox for a confirmation link, or contact the admin.";

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
//  WEB PUSH — subscribe device, send via Edge Function
// ═══════════════════════════════════════════════════════════

const VAPID_PUBLIC_KEY = "BN4ZD0qVkYRGfBtd8Q_XfaOEQMZCXuoGJoAurglpPf9AqfVaEx2heaAzbNY_CeOOJgdGRheVyogE7mLXsBtFtbA";

async function registerPushSubscription() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;
  if (!currentUser) return;

  try {
    const reg  = await navigator.serviceWorker.ready;
    const perm = await Notification.requestPermission();
    if (perm !== "granted") return;

    // Check if already subscribed
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
      });
    }

    const json = sub.toJSON();
    // Store in Supabase — upsert so re-subscribing on same device doesn't duplicate
    await supabase.from("push_subscriptions").upsert({
      userid:   currentUser.id,
      endpoint: json.endpoint,
      p256dh:   json.keys.p256dh,
      auth:     json.keys.auth,
    }, { onConflict: "endpoint" });

  } catch (err) {
    console.warn("Push subscription failed:", err.message);
  }
}

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - base64String.length % 4) % 4);
  const base64  = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw     = window.atob(base64);
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}

/** Send a push notification to a user via the Edge Function */
async function sendPushToUser(recipientUid, title, body, url = "/") {
  if (!recipientUid || recipientUid === currentUser?.id) return;
  try {
    await supabase.functions.invoke("send-push", {
      body: { userid: recipientUid, title, body, url },
    });
  } catch (_) { /* non-critical — in-app notification already sent */ }
}

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

// ── Leaderboard tap: show DM + View Profile action sheet ──
window.lbTapUser = function(uid, username, avatar) {
  // Remove any existing sheet
  document.getElementById("lb-action-sheet")?.remove();

  const isMe = currentUser && uid === currentUser.id;
  const sheet = document.createElement("div");
  sheet.id = "lb-action-sheet";
  sheet.className = "fixed inset-0 z-50 flex items-end justify-center";
  sheet.innerHTML = `
    <div class="absolute inset-0 bg-black/60" data-action="close-sheet"></div>
    <div class="relative bg-turf border border-line rounded-t-2xl w-full max-w-lg p-5 pb-8 space-y-3 animate-slide-up">
      <div class="flex items-center gap-3 mb-4">
        <img src="${escAttr(avatar || `https://ui-avatars.com/api/?name=${encodeURIComponent(username)}&background=0f1f17&color=b5ff47&size=80`)}" class="w-12 h-12 rounded-full object-cover" />
        <div>
          <p class="text-ice font-medium">${escHtml(username)}</p>
          ${window.onlineUserIds?.has(uid) ? '<p class="text-xs text-blue-400 flex items-center gap-1"><span class="w-2 h-2 bg-blue-500 rounded-full inline-block"></span> Online now</p>' : '(u?.last_seen ? 'Last seen ' + window.timeAgo(new Date(u.last_seen)) + '</p>' : '<p class="text-xs text-mist">Offline</p>')}
        </div>
      </div>
      ${!isMe ? `
      <button data-action="dm-user" data-user-id="${escAttr(uid)}" data-user-name="${escAttr(username)}"
        class="w-full flex items-center gap-3 px-4 py-3 rounded-xl bg-white/5 hover:bg-white/10 transition text-ice text-sm">
        <i data-lucide="message-circle" class="w-5 h-5 text-lime"></i> Send DM
      </button>` : ""}
      <button data-action="view-profile" data-user-id="${escAttr(uid)}" data-user-name="${escAttr(username)}"
        class="w-full flex items-center gap-3 px-4 py-3 rounded-xl bg-white/5 hover:bg-white/10 transition text-ice text-sm">
        <i data-lucide="user" class="w-5 h-5 text-lime"></i> View Profile
      </button>
      <button data-action="close-sheet"
        class="w-full px-4 py-3 rounded-xl text-mist text-sm hover:text-ice transition">
        Cancel
      </button>
    </div>`;
  document.body.appendChild(sheet);
  lucide.createIcons();

  sheet.addEventListener("click", (e) => {
    const actionEl = e.target.closest("[data-action]");
    if (!actionEl) return;
    const action = actionEl.dataset.action;
    if (action === "close-sheet") { sheet.remove(); return; }
    if (action === "dm-user") { sheet.remove(); openDMFromPost(actionEl.dataset.userId, actionEl.dataset.userName); return; }
    if (action === "view-profile") { sheet.remove(); viewPublicProfile(actionEl.dataset.userId, actionEl.dataset.userName); return; }
  });
};

// ── Public profile view (posts by user, avatar, stats) ──
window.viewPublicProfile = async function(uid, username) {
  // Remove any existing sheet
  document.getElementById("lb-action-sheet")?.remove();

  // Show loading overlay
  const overlay = document.createElement("div");
  overlay.id = "profile-overlay";
  overlay.className = "fixed inset-0 z-50 bg-pitch overflow-y-auto";
  overlay.innerHTML = `
    <div class="max-w-2xl mx-auto px-4 py-6">
      <button data-action="close-overlay" class="flex items-center gap-2 text-mist hover:text-lime mb-6 transition">
        <i data-lucide="arrow-left" class="w-5 h-5"></i> Back
      </button>
      <div id="pub-profile-content" class="text-center py-12 text-mist">
        <i data-lucide="loader" class="w-6 h-6 mx-auto animate-spin mb-2"></i> Loading...
      </div>
    </div>`;
  document.body.appendChild(overlay);
  lucide.createIcons();

  overlay.addEventListener("click", (e) => {
    const actionEl = e.target.closest("[data-action]");
    if (!actionEl) return;
    const action = actionEl.dataset.action;
    if (action === "close-overlay") { overlay.remove(); return; }
    if (action === "dm-user") { overlay.remove(); openDMFromPost(actionEl.dataset.userId, actionEl.dataset.userName); return; }
  });

  try {
    const [profileRes, postsRes] = await Promise.all([
      supabase.from("public_profiles").select("*").eq("uid", uid).single(),
      supabase.from("posts").select("*").eq("authorid", uid).order("created_at", { ascending: false }).limit(20),
    ]);

    const u = profileRes.data;
    const posts = postsRes.data || [];
    const avatarSrc = u?.avatar || `https://ui-avatars.com/api/?name=${encodeURIComponent(username)}&background=0f1f17&color=b5ff47&size=200`;
    const isOnline = window.onlineUserIds?.has(uid);
    const isMe = currentUser && uid === currentUser.id;

    document.getElementById("pub-profile-content").innerHTML = `
      <div class="flex flex-col items-center mb-6">
        <div class="relative mb-3">
          <img src="${escAttr(avatarSrc)}" class="w-20 h-20 rounded-full object-cover border-2 border-line" />
          ${isOnline ? '<span class="absolute bottom-1 right-1 w-3.5 h-3.5 bg-blue-500 rounded-full border-2 border-pitch"></span>' : ""}
        </div>
        <h2 class="text-ice text-xl font-display">${escHtml(u?.username || username)}</h2>
        ${u?.team ? `<p class="text-mist text-sm mt-1">⚽ ${escHtml(u.team)}</p>` : ""}
        <p class="text-mist text-xs mt-1">${isOnline ? '<span class="text-blue-400">● Online now</span>' : (u?.last_seen ? 'Last seen ' + window.timeAgo(new Date(u.last_seen)) : 'Offline')}</p>
        <div class="flex gap-6 mt-4 text-center">
          <div><p class="text-lime font-display text-xl">${u?.postcount || 0}</p><p class="text-mist text-xs">Posts</p></div>
          <div><p class="text-lime font-display text-xl">${u?.joinedat ? new Date(u.joinedat).toLocaleDateString(undefined, { month: "short", year: "numeric" }) : "—"}</p><p class="text-mist text-xs">Joined</p></div>
        </div>
        ${!isMe ? `
        <button data-action="dm-user" data-user-id="${escAttr(uid)}" data-user-name="${escAttr(username)}"
          class="mt-4 btn-lime px-6 py-2 text-sm flex items-center gap-2">
          <i data-lucide="message-circle" class="w-4 h-4"></i> Send DM
        </button>` : ""}
      </div>
      <h3 class="text-lime font-display text-lg mb-4 text-left">Posts</h3>
      <div class="space-y-4">
        ${posts.length ? posts.map(p => window.buildPostCard(p.id, p)).join("") : '<p class="text-mist text-sm text-center py-8">No posts yet.</p>'}
      </div>`;
    lucide.createIcons();
    bindPostCardEvents(document.getElementById("pub-profile-content"));
  } catch (err) {
    document.getElementById("pub-profile-content").innerHTML = `<p class="text-coral text-sm">Failed to load profile.</p>`;
  }
};
// ── @mention dropdown for comments ─────────────────────────
window.handleCommentInput = async function(input, postId) {
  const val   = input.value;
  const caret = input.selectionStart;
  const atIdx = val.lastIndexOf("@", caret - 1);
  const dropdown = document.getElementById(`mention-dropdown-${postId}`);
  if (!dropdown) return;

  if (atIdx === -1) { dropdown.classList.add("hidden"); return; }

  const query = val.slice(atIdx + 1, caret).toLowerCase();

  try {
    let req = supabase.from("public_profiles").select("uid, username, avatar").limit(6);
    if (query) req = req.ilike("username", `${query}%`);
    const { data } = await req;
    if (!data?.length) { dropdown.classList.add("hidden"); return; }

    dropdown.innerHTML = data.map(u => {
      const av = u.avatar || `https://ui-avatars.com/api/?name=${encodeURIComponent(u.username)}&background=0f1f17&color=b5ff47&size=40`;
      return `<button type="button" data-username="${escAttr(u.username)}" class="mention-option flex items-center gap-2 w-full px-3 py-2 hover:bg-white/10 text-left transition">
        <img src="${escAttr(av)}" class="w-6 h-6 rounded-full object-cover shrink-0" />
        <span class="text-ice text-sm">${escHtml(u.username)}</span>
      </button>`;
    }).join("");
    dropdown.classList.remove("hidden");

    if (!dropdown._mentionEventsBound) {
      dropdown._mentionEventsBound = true;
      dropdown.addEventListener("click", (e) => {
        const opt = e.target.closest(".mention-option");
        if (opt) insertMention(postId, opt.dataset.username);
      });
    }
  } catch (_) { dropdown.classList.add("hidden"); }
};

window.insertMention = function(postId, username) {
  const input    = document.getElementById(`comment-input-${postId}`);
  const dropdown = document.getElementById(`mention-dropdown-${postId}`);
  if (!input) return;
  const val   = input.value;
  const caret = input.selectionStart;
  const atIdx = val.lastIndexOf("@", caret - 1);
  input.value  = val.slice(0, atIdx) + `@${username} ` + val.slice(caret);
  input.focus();
  const newPos = atIdx + username.length + 2;
  input.setSelectionRange(newPos, newPos);
  if (dropdown) dropdown.classList.add("hidden");
};

// Close mention dropdowns on outside click
document.addEventListener("click", (e) => {
  if (!e.target.closest('[id^="mention-dropdown-"]') && !e.target.closest('[id^="comment-input-"]')) {
    document.querySelectorAll('[id^="mention-dropdown-"]').forEach(d => d.classList.add("hidden"));
  }
});

// Initialise Lucide icons on first load
document.addEventListener("DOMContentLoaded", () => {
  lucide.createIcons();
  navigate("home");
});
