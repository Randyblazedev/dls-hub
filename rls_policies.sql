-- ═══════════════════════════════════════════════════════════
--  DLS Hub — RLS Policies (run AFTER setup.sql)
--  Column names now match app.js (camelCase)
-- ═══════════════════════════════════════════════════════════

-- Enable RLS on all tables
alter table users enable row level security;
alter table posts enable row level security;
alter table comments enable row level security;
alter table chat_messages enable row level security;
alter table dms enable row level security;
alter table dm_messages enable row level security;
alter table notifications enable row level security;

-- USERS
create policy "Users can view all profiles" on users for select using (true);
create policy "Users can insert own profile" on users for insert with check (auth.uid()::text = uid);
create policy "Users can update own profile" on users for update using (auth.uid()::text = uid);

-- POSTS
create policy "Anyone can view posts" on posts for select using (true);
create policy "Authenticated users can create posts" on posts for insert to authenticated with check (true);
create policy "Authors can delete own posts" on posts for delete using (auth.uid()::text = authorId);
create policy "Authors can update own posts" on posts for update using (auth.uid()::text = authorId);

-- COMMENTS
create policy "Anyone can view comments" on comments for select using (true);
create policy "Authenticated users can create comments" on comments for insert to authenticated with check (true);
create policy "Authors can delete own comments" on comments for delete using (auth.uid()::text = authorId);

-- CHAT MESSAGES
create policy "Anyone can view chat" on chat_messages for select using (true);
create policy "Authenticated users can send chat" on chat_messages for insert to authenticated with check (true);

-- DMs
create policy "Users can view own DMs" on dms for select using (auth.uid()::text = user1Id or auth.uid()::text = user2Id);
create policy "Authenticated users can create DMs" on dms for insert to authenticated with check (true);
create policy "Users can update own DMs" on dms for update using (auth.uid()::text = user1Id or auth.uid()::text = user2Id);

-- DM MESSAGES
create policy "Users can view DM messages" on dm_messages
  for select using (
    exists (
      select 1 from dms
      where dms.id = dm_messages.dmId
      and (auth.uid()::text = dms.user1Id or auth.uid()::text = dms.user2Id)
    )
  );
create policy "Authenticated users can send DM messages" on dm_messages for insert to authenticated with check (true);

-- NOTIFICATIONS
create policy "Users can view own notifications" on notifications for select using (auth.uid()::text = userId);
create policy "System can create notifications" on notifications for insert to authenticated with check (true);
create policy "Users can update own notifications" on notifications for update using (auth.uid()::text = userId);
