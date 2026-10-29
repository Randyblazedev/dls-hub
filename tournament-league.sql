-- ═══════════════════════════════════════════════════════════
--  DLS Hub — Tournament League
--  Run this ONCE in: Supabase Dashboard → SQL Editor → New Query
--  Safe to run again: every statement is idempotent.
--
--  What this adds, and why:
--
--  1. POINTS FOR MATCHES.  Before this, points only moved as an entry fee in and a
--     winner-takes-all prize out. A player who lost in round one walked away with
--     nothing, so there was no reason to finish the tournament. Now every verified
--     result pays both players: the winner more, the loser something.
--
--  2. DIVISIONS.  Points now decide a division, so a player has a standing even
--     between tournaments. Nothing in the app had the word "division" before.
--
--  3. TITLES.  Winning a tournament is recorded permanently, so a profile can show
--     trophies instead of a single winner_id that gets overwritten next season.
--
--  4. NO DOUBLE PAYMENT.  A result can be confirmed by the AI and again by the
--     opponent. A ledger row per match per user makes the award happen exactly once.
-- ═══════════════════════════════════════════════════════════


-- ── 0. Make sure the columns we depend on exist ──
alter table users add column if not exists points int default 0;
alter table users add column if not exists division text default 'Bronze';
alter table users add column if not exists titles int default 0;
-- referenced by the standings view below; normally created by all_fixes.sql, but the
-- view must not depend on which order the files happen to be run in.
alter table users add column if not exists banned boolean not null default false;

alter table tournament_matches add column if not exists screenshot_url text;
alter table tournament_matches add column if not exists proposed_winner_id text;
alter table tournament_matches add column if not exists proposed_winner_name text default '';
alter table tournament_matches add column if not exists result_submitted_by text;
alter table tournament_matches add column if not exists confirmed boolean default false;
alter table tournament_matches add column if not exists verification_status text default 'pending';

-- 'pending_confirmation' is used by the client but was never in the check constraint.
alter table tournament_matches drop constraint if exists tournament_matches_status_check;
alter table tournament_matches
  add constraint tournament_matches_status_check
  check (status in ('pending', 'in_progress', 'pending_confirmation', 'completed'));


-- ── 1. Points ledger: one row per match per player, so nothing pays twice ──
create table if not exists points_ledger (
  id           uuid primary key default gen_random_uuid(),
  user_id      text not null,
  match_id     uuid references tournament_matches(id) on delete cascade,
  tournament_id uuid references tournaments(id) on delete cascade,
  amount       int  not null,
  reason       text not null default 'match',
  created_at   timestamptz default now(),
  unique (user_id, match_id, reason)
);

alter table points_ledger enable row level security;
drop policy if exists "Users read own ledger" on points_ledger;
create policy "Users read own ledger" on points_ledger
  for select using (auth.uid()::text = user_id);


-- ── 2. Divisions ──
-- Ten divisions, widening as they go up: easy to leave Bronze, hard to reach Legend.
create or replace function division_for(points int)
returns text
language sql
immutable
as $$
  select case
    when points >= 12000 then 'Legend'
    when points >= 8000  then 'Elite'
    when points >= 5000  then 'Diamond'
    when points >= 3000  then 'Platinum'
    when points >= 1800  then 'Gold'
    when points >= 1000  then 'Silver'
    when points >= 500   then 'Bronze II'
    when points >= 200   then 'Bronze III'
    else                      'Bronze'
  end;
$$;

-- The points needed to reach the next division, and how far through this one you are.
create or replace function division_progress(points int)
returns table (division text, next_division text, next_at int, progress_pct int)
language sql
immutable
as $$
  with bands(name, at) as (
    values ('Bronze',0), ('Bronze III',200), ('Bronze II',500), ('Silver',1000),
           ('Gold',1800), ('Platinum',3000), ('Diamond',5000), ('Elite',8000),
           ('Legend',12000)
  ),
  current_band as (
    select * from bands where at <= greatest(points, 0) order by at desc limit 1
  ),
  next_band as (
    select * from bands where at > greatest(points, 0) order by at asc limit 1
  )
  select
    (select name from current_band),
    coalesce((select name from next_band), (select name from current_band)),
    coalesce((select at from next_band), (select at from current_band)),
    case
      when (select at from next_band) is null then 100
      else least(100, greatest(0,
        ((greatest(points, 0) - (select at from current_band)) * 100)
        / greatest(1, (select at from next_band) - (select at from current_band))
      ))
    end;
$$;


-- ── 3. Keep users.division in step with users.points ──
create or replace function sync_division()
returns trigger
language plpgsql
as $$
begin
  new.division := division_for(coalesce(new.points, 0));
  return new;
end;
$$;

drop trigger if exists trg_sync_division on users;
create trigger trg_sync_division
  before insert or update of points on users
  for each row execute function sync_division();

-- backfill anyone who already has points
update users set division = division_for(coalesce(points, 0));


-- ── 4. Award points for a finished match, exactly once ──
--    Winner gets the win bonus; the loser still gets appearance points, because
--    playing the tournament to the end should be worth something.
create or replace function award_match_points()
returns trigger
language plpgsql
security definer
as $$
declare
  win_points   int := 100;   -- to the winner of a match
  loss_points  int := 25;    -- to the player who lost, for turning up
  loser_id     text;
begin
  -- only when a match actually becomes completed
  if new.status <> 'completed' or coalesce(old.status, '') = 'completed' then
    return new;
  end if;
  if new.winner_id is null then
    return new;
  end if;

  -- winner
  insert into points_ledger (user_id, match_id, tournament_id, amount, reason)
  values (new.winner_id, new.id, new.tournament_id, win_points, 'match_win')
  on conflict (user_id, match_id, reason) do nothing;

  if found then
    update users set points = coalesce(points, 0) + win_points where uid = new.winner_id;
  end if;

  -- loser = whichever of player1/player2 is not the winner
  if new.player1_id is not null and new.player1_id <> new.winner_id then
    loser_id := new.player1_id;
  elsif new.player2_id is not null and new.player2_id <> new.winner_id then
    loser_id := new.player2_id;
  end if;

  if loser_id is not null then
    insert into points_ledger (user_id, match_id, tournament_id, amount, reason)
    values (loser_id, new.id, new.tournament_id, loss_points, 'match_loss')
    on conflict (user_id, match_id, reason) do nothing;

    if found then
      update users set points = coalesce(points, 0) + loss_points where uid = loser_id;
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_award_match_points on tournament_matches;
create trigger trg_award_match_points
  after update on tournament_matches
  for each row execute function award_match_points();


-- ── 5. Champion: prize, title and an unoverwritable record ──
create table if not exists tournament_champions (
  id            uuid primary key default gen_random_uuid(),
  tournament_id uuid references tournaments(id) on delete cascade,
  user_id       text not null,
  username      text default '',
  points_awarded int default 0,
  won_at        timestamptz default now(),
  unique (tournament_id)
);

alter table tournament_champions enable row level security;
drop policy if exists "Champions are public" on tournament_champions;
create policy "Champions are public" on tournament_champions for select using (true);

-- Replace the old winner-takes-all trigger: same payout, plus the title and the record.
create or replace function award_tournament_prize()
returns trigger
language plpgsql
security definer
as $$
declare
  entry  int;
  joined int;
  pool   int;
begin
  if new.status = 'completed'
     and old.status is distinct from 'completed'
     and new.winner_id is not null then

    select coalesce(points_cost, 0) into entry from tournaments where id = new.id;
    select count(*) into joined from tournament_players
      where tournament_id = new.id and status = 'approved';

    pool := entry * joined;

    insert into tournament_champions (tournament_id, user_id, username, points_awarded)
    values (new.id, new.winner_id, coalesce(new.winner_name, ''), pool)
    on conflict (tournament_id) do nothing;

    if found then
      update users
         set titles = coalesce(titles, 0) + 1,
             points = coalesce(points, 0) + pool
       where uid = new.winner_id;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_award_tournament_prize on tournaments;
create trigger trg_award_tournament_prize
  after update on tournaments
  for each row execute function award_tournament_prize();


-- ── 6. A standings view the UI can read directly ──
create or replace view tournament_standings as
select
  u.uid,
  u.username,
  coalesce(u.avatar, '')  as avatar,
  coalesce(u.points, 0)   as points,
  coalesce(u.division, division_for(coalesce(u.points, 0))) as division,
  coalesce(u.titles, 0)   as titles,
  coalesce((select count(*) from points_ledger l
             where l.user_id = u.uid and l.reason = 'match_win'), 0) as wins,
  coalesce((select count(*) from points_ledger l
             where l.user_id = u.uid and l.reason = 'match_loss'), 0) as losses
from users u
where coalesce(u.banned, false) = false;

grant select on tournament_standings to authenticated, anon;


-- ── 7. Lock the award function down ──
revoke all on function award_tournament_prize() from public;
revoke all on function award_match_points() from public;