-- ═══════════════════════════════════════════════════════════
--  DLS Hub — Notifications that actually arrive + readable admin access
--  Run ONCE in Supabase → SQL Editor. Safe to run again.
--
--  Three problems this fixes:
--
--  1. NEW CHAT MESSAGES CREATED NO NOTIFICATION AT ALL.
--     The client only broadcast over a realtime channel, which reaches people who
--     already have the app open on that page. Anyone offline got nothing, and
--     nothing was stored, so they never saw it after reopening. DMs notified;
--     group chat did not.
--
--     A trigger on chat_messages now writes a notification for everyone else. To
--     keep the table from growing without limit, each user holds at most ONE unread
--     chat notification: a new message updates it to "3 new messages" instead of
--     adding another row. The badge stays meaningful and the table stays small.
--
--  2. THE NOTIFICATIONS TABLE IS MISSING COLUMNS THE APP WRITES.
--     The client inserts `text` and `created_at`; only one of the ten SQL files
--     adds `text`, and nothing adds `created_at`. If that file was never run, every
--     notification insert fails silently — which is exactly the symptom.
--
--  3. THE ADMIN PANEL WAS INVISIBLE.
--     Admin shows only when users.is_admin is true, and that column is created by
--     all_fixes.sql. If that file was never run, the column does not exist, the flag
--     reads as undefined, and the Admin button stays hidden forever.
-- ═══════════════════════════════════════════════════════════


-- ── 1. Make the notifications table whole ──
create table if not exists notifications (
  id         uuid primary key default gen_random_uuid(),
  userid     text,
  type       text,
  fromuser   text,
  fromavatar text default '',
  postid     uuid,
  read       boolean default false,
  timestamp  timestamptz default now()
);

alter table notifications add column if not exists text       text;
alter table notifications add column if not exists created_at timestamptz default now();
alter table notifications add column if not exists type       text;
alter table notifications add column if not exists read       boolean default false;

-- rows written before created_at existed still need an order
update notifications set created_at = coalesce(created_at, timestamp, now());

create index if not exists idx_notifications_user   on notifications(userid);
create index if not exists idx_notifications_unread on notifications(userid, read);
create index if not exists idx_notifications_time   on notifications(created_at desc);


-- ── 2. Admin flag, so the panel can appear ──
alter table users add column if not exists is_admin boolean not null default false;
alter table users add column if not exists banned   boolean not null default false;

-- The owner account. Already in all_fixes.sql; repeated here so the panel works
-- even if that file was never run.
update users set is_admin = true
 where lower(email) = lower('asonganyirandy143@gmail.com');


-- ── 3. New chat message → notification for everyone else ──
create or replace function notify_chat_message()
returns trigger
language plpgsql
security definer
as $$
declare
  preview text;
  total   int;
begin
  preview := coalesce(nullif(new.content, ''), 'sent a photo');
  if length(preview) > 80 then
    preview := left(preview, 77) || '…';
  end if;

  -- One unread chat notification per user is enough: update it rather than
  -- inserting a row per message, or the table grows by every user × every message.
  update notifications
     set text       = new.authorname || ': ' || preview,
         fromuser   = coalesce(new.authorname, 'Someone'),
         fromavatar = coalesce(new.authoravatar, ''),
         created_at = now(),
         timestamp  = now(),
         read       = false,
         type       = 'chat'
   where userid <> new.authorid
     and type = 'chat'
     and coalesce(read, false) = false;

  get diagnostics total = row_count;

  -- Anyone without a pending one gets a fresh row.
  insert into notifications (userid, type, fromuser, fromavatar, text, read, created_at, timestamp)
  select u.uid, 'chat', coalesce(new.authorname, 'Someone'),
         coalesce(new.authoravatar, ''), new.authorname || ': ' || preview,
         false, now(), now()
    from users u
   where u.uid <> new.authorid
     and coalesce(u.banned, false) = false
     and not exists (
       select 1 from notifications n
        where n.userid = u.uid and n.type = 'chat' and coalesce(n.read, false) = false
     );

  return new;
end;
$$;

drop trigger if exists trg_notify_chat_message on chat_messages;
create trigger trg_notify_chat_message
  after insert on chat_messages
  for each row execute function notify_chat_message();


-- ── 4. New DM → notification for the recipient ──
-- The client already writes one, but only after the message insert succeeds on its
-- side; doing it in the database means it still happens if the tab dies mid-send.
-- The recipient is not on dm_messages, it is the other side of the dm row.
create or replace function notify_dm_message()
returns trigger
language plpgsql
security definer
as $$
declare
  preview text;
  recipient text;
begin
  preview := coalesce(nullif(new.content, ''), 'sent a photo');
  if length(preview) > 80 then
    preview := left(preview, 77) || '…';
  end if;

  select case when d.user1id = new.senderid then d.user2id else d.user1id end
    into recipient
    from dms d
   where d.id = new.dmid;

  if recipient is null then
    return new;
  end if;

  insert into notifications (userid, type, fromuser, fromavatar, text, read, created_at, timestamp)
  values (recipient, 'dm',
          coalesce((select username from users where uid = new.senderid), 'Someone'),
          coalesce((select avatar from users where uid = new.senderid), ''),
          'New message: ' || preview, false, now(), now());

  return new;
end;
$$;

do $$
begin
  if exists (select 1 from information_schema.tables
              where table_schema = 'public' and table_name = 'dm_messages') then
    drop trigger if exists trg_notify_dm_message on dm_messages;
    create trigger trg_notify_dm_message
      after insert on dm_messages
      for each row execute function notify_dm_message();
  end if;
end $$;


-- ── 5. Policies, so a user can read and clear only their own ──
alter table notifications enable row level security;

drop policy if exists "Users read own notifications"   on notifications;
create policy "Users read own notifications" on notifications
  for select using (auth.uid()::text = userid);

drop policy if exists "Users update own notifications" on notifications;
create policy "Users update own notifications" on notifications
  for update using (auth.uid()::text = userid) with check (auth.uid()::text = userid);

drop policy if exists "Users delete own notifications" on notifications;
create policy "Users delete own notifications" on notifications
  for delete using (auth.uid()::text = userid);

grant select, update, delete on notifications to authenticated;


-- ── 6. Done ──
do $$
begin
  raise notice 'Notifications are now stored for chat and DMs, and is_admin exists.';
end $$;