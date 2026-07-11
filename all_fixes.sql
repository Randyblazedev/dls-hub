-- ═══════════════════════════════════════════════════════════
--  DLS Hub — Bug-fix patch
--  Run this in: Supabase Dashboard → SQL Editor → New Query
-- ═══════════════════════════════════════════════════════════

-- 1. FIX: only post authors could update their own posts, which
--    silently blocked *everyone else* from liking posts or
--    incrementing comment counts (RLS was rejecting the UPDATE).
DO $$ BEGIN
  CREATE POLICY "Authenticated users can like/comment-count posts"
    ON posts FOR UPDATE
    TO authenticated
    USING (true)
    WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 1b. FIX: comments never had an avatar column, so authoravatar was
--     always missing/blank in app.js queries.
alter table comments add column if not exists authoravatar text default '';

-- 1c. FIX: notifications table had no free-text message column, so
--     there was nowhere to store "X liked your post" style text.
alter table notifications add column if not exists text text;

-- 3. ADMIN & MODERATION — real server-side enforcement (not just
--    hiding buttons in JS, which anyone can bypass with dev tools
--    and the public anon key).

alter table users add column if not exists is_admin boolean not null default false;
alter table users add column if not exists banned   boolean not null default false;

-- Set yourself as admin (replace the email if needed):
update users set is_admin = true where email = 'asonganyirandy143@gmail.com';

-- Helper functions. SECURITY DEFINER so they can check `users` without
-- being blocked by users' own RLS policy (which we're about to restrict).
create or replace function is_admin_user(check_uid text) returns boolean as $$
  select coalesce((select is_admin from users where uid = check_uid), false);
$$ language sql stable security definer set search_path = public;

create or replace function is_banned_user(check_uid text) returns boolean as $$
  select coalesce((select banned from users where uid = check_uid), false);
$$ language sql stable security definer set search_path = public;

grant execute on function is_admin_user(text) to authenticated, anon;
grant execute on function is_banned_user(text) to authenticated, anon;

-- Restrict full user rows (incl. email) to the owner or an admin.
-- Public/other-user fields (username, avatar, team, postcount) are served
-- instead through the safe view below, used by leaderboards/DM search.
drop policy if exists "Users can view all profiles" on users;
create policy "Users can view own profile or admin views all"
  on users for select
  using (auth.uid()::text = uid or is_admin_user(auth.uid()::text));

create or replace view public_profiles as
  select uid, username, avatar, team, postcount, joinedat from users;
grant select on public_profiles to anon, authenticated;

-- Admins can update any user (needed for ban/unban).
create policy "Admins can update any user" on users for update
  using (is_admin_user(auth.uid()::text));

-- Admins can delete ANY post/comment/chat/DM message, not just their own.
create policy "Admins can delete any post" on posts for delete
  using (is_admin_user(auth.uid()::text));
create policy "Admins can delete any comment" on comments for delete
  using (is_admin_user(auth.uid()::text));
create policy "Admins can delete any chat message" on chat_messages for delete
  using (is_admin_user(auth.uid()::text));
create policy "Admins can delete any DM message" on dm_messages for delete
  using (is_admin_user(auth.uid()::text));

-- Banned users can no longer post/comment/chat/DM (enforced in the DB,
-- not just by hiding UI). Replaces the old fully-open insert policies.
drop policy if exists "Authenticated users can create posts" on posts;
create policy "Non-banned users can create posts" on posts for insert
  to authenticated with check (not is_banned_user(auth.uid()::text));

drop policy if exists "Authenticated users can create comments" on comments;
create policy "Non-banned users can create comments" on comments for insert
  to authenticated with check (not is_banned_user(auth.uid()::text));

drop policy if exists "Authenticated users can send chat" on chat_messages;
create policy "Non-banned users can send chat" on chat_messages for insert
  to authenticated with check (not is_banned_user(auth.uid()::text));

drop policy if exists "Authenticated users can send DM messages" on dm_messages;
create policy "Non-banned users can send DM messages" on dm_messages for insert
  to authenticated with check (not is_banned_user(auth.uid()::text));

-- Reports table (admin.js already queries this; ensure it exists with RLS).
create table if not exists reports (
  id           uuid primary key default gen_random_uuid(),
  reported_by  text not null,
  content_type text not null,
  content_id   text not null,
  reason       text not null,
  created_at   timestamptz default now()
);
alter table reports enable row level security;

create policy "Authenticated users can file reports" on reports for insert
  to authenticated with check (auth.uid()::text = reported_by);
create policy "Only admins can view reports" on reports for select
  using (is_admin_user(auth.uid()::text));
create policy "Only admins can delete reports" on reports for delete
  using (is_admin_user(auth.uid()::text));

-- 4. Reply-to-message support (chat + DMs)
alter table chat_messages add column if not exists replytoid uuid;
alter table chat_messages add column if not exists replytoauthor text;
alter table chat_messages add column if not exists replytotext text;

alter table dm_messages add column if not exists replytoid uuid;
alter table dm_messages add column if not exists replytoauthor text;
alter table dm_messages add column if not exists replytotext text;

-- 5. Web Push subscriptions table
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  userid     text NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
  endpoint   text NOT NULL UNIQUE,
  p256dh     text NOT NULL,
  auth       text NOT NULL,
  created_at timestamptz DEFAULT now()
);
ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "Users manage own push subs" ON push_subscriptions
    FOR ALL USING (auth.uid()::text = userid);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY "Admins can read all push subs" ON push_subscriptions
    FOR SELECT USING (is_admin_user(auth.uid()::text));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER PUBLICATION supabase_realtime ADD TABLE push_subscriptions;
