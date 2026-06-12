-- ═══════════════════════════════════════════════════════════
--  DLS Hub — Supabase Table Setup (FIXED: matches app.js columns)
--  Run this in: Supabase Dashboard → SQL Editor → New Query
-- ═══════════════════════════════════════════════════════════

-- 1. USERS TABLE
create table if not exists users (
  uid         text primary key,
  username    text unique not null,
  email       text unique not null,
  team        text default 'No Team Set',
  avatar      text default '',
  bio         text default '',
  postCount   int default 0,
  joinedAt    timestamp with time zone default now()
);

-- 2. POSTS TABLE
create table if not exists posts (
  id            uuid primary key default gen_random_uuid(),
  authorId      text references users(uid) on delete cascade,
  authorName    text,
  authorAvatar  text default '',
  content       text not null default '',
  imageUrl      text default '',
  likes         text[] default '{}',
  commentCount  int default 0,
  timestamp     timestamp with time zone default now()
);

-- 3. COMMENTS TABLE
create table if not exists comments (
  id          uuid primary key default gen_random_uuid(),
  postId      uuid references posts(id) on delete cascade,
  authorId    text references users(uid) on delete cascade,
  authorName  text,
  content     text not null,
  timestamp   timestamp with time zone default now()
);

-- 4. CHAT MESSAGES TABLE
create table if not exists chat_messages (
  id            uuid primary key default gen_random_uuid(),
  authorId      text references users(uid) on delete cascade,
  authorName    text,
  authorAvatar  text default '',
  content       text not null,
  timestamp     timestamp with time zone default now()
);

-- 5. DM CONVERSATIONS TABLE
create table if not exists dms (
  id          uuid primary key default gen_random_uuid(),
  user1Id     text references users(uid) on delete cascade,
  user2Id     text references users(uid) on delete cascade,
  lastMsg     text default '',
  timestamp   timestamp with time zone default now(),
  unique(user1Id, user2Id)
);

-- 6. DM MESSAGES TABLE
create table if not exists dm_messages (
  id          uuid primary key default gen_random_uuid(),
  dmId        uuid references dms(id) on delete cascade,
  senderId    text references users(uid) on delete cascade,
  content     text not null,
  timestamp   timestamp with time zone default now()
);

-- 7. NOTIFICATIONS TABLE
create table if not exists notifications (
  id          uuid primary key default gen_random_uuid(),
  userId      text references users(uid) on delete cascade,
  type        text,
  fromUser    text,
  fromAvatar  text default '',
  postId      uuid,
  read        boolean default false,
  timestamp   timestamp with time zone default now()
);

-- ── INDEXES ──
create index if not exists idx_posts_author on posts(authorId);
create index if not exists idx_posts_timestamp on posts(timestamp desc);
create index if not exists idx_comments_post on comments(postId);
create index if not exists idx_chat_timestamp on chat_messages(timestamp);
create index if not exists idx_dms_users on dms(user1Id, user2Id);
create index if not exists idx_dm_messages_dm on dm_messages(dmId, timestamp);
create index if not exists idx_notifications_user on notifications(userId, read);

-- ── ENABLE REALTIME ──
alter publication supabase_realtime add table chat_messages;
alter publication supabase_realtime add table dm_messages;
alter publication supabase_realtime add table posts;
alter publication supabase_realtime add table notifications;
