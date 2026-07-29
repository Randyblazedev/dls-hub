-- ═══════════════════════════════════════════════════════════
--  DLS Hub — Tournament System Tables
--  Run this in: Supabase Dashboard → SQL Editor → New Query
-- ═══════════════════════════════════════════════════════════

-- 1. TOURNAMENTS TABLE
create table if not exists tournaments (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text default '',
  game text default 'DLS 25',
  max_players int default 16,
  prize text default '',
  entry_fee numeric default 0,
  status text default 'registration' check (status in ('registration','in_progress','completed','cancelled')),
  created_by text not null,
  created_at timestamptz default now(),
  started_at timestamptz,
  ended_at timestamptz,
  winner_id text,
  winner_name text
);

-- 2. TOURNAMENT PLAYERS TABLE
create table if not exists tournament_players (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid references tournaments(id) on delete cascade not null,
  user_id text not null,
  username text not null,
  avatar text default '',
  status text default 'pending' check (status in ('pending','approved','rejected')),
  seed int default 0,
  joined_at timestamptz default now(),
  unique(tournament_id, user_id)
);

-- 3. TOURNAMENT MATCHES TABLE
create table if not exists tournament_matches (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid references tournaments(id) on delete cascade not null,
  round int not null,
  match_index int not null,
  player1_id text,
  player2_id text,
  player1_name text default '',
  player2_name text default '',
  player1_score int default null,
  player2_score int default null,
  winner_id text,
  winner_name text default '',
  status text default 'pending' check (status in ('pending','in_progress','completed')),
  created_at timestamptz default now()
);

-- 4. TOURNAMENT PAYMENTS TABLE
create table if not exists tournament_payments (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid references tournaments(id) on delete cascade not null,
  user_id text not null,
  username text not null,
  amount numeric not null,
  reference text default '',
  status text default 'pending' check (status in ('pending','confirmed','failed')),
  paid_at timestamptz default now(),
  unique(tournament_id, user_id)
);

-- ── RLS POLICIES ──
alter table tournaments enable row level security;
alter table tournament_players enable row level security;
alter table tournament_matches enable row level security;
alter table tournament_payments enable row level security;

-- Tournaments: anyone can view, authenticated can create, creator can update/delete
create policy "Anyone can view tournaments" on tournaments for select using (true);
create policy "Auth can create tournaments" on tournaments for insert to authenticated with check (true);
create policy "Creator can update tournament" on tournaments for update using (auth.uid()::text = created_by);
create policy "Creator can delete tournament" on tournaments for delete using (auth.uid()::text = created_by);

-- Tournament players: anyone can view, auth can join, user can update own status
create policy "Anyone can view players" on tournament_players for select using (true);
create policy "Auth can join tournament" on tournament_players for insert to authenticated with check (true);
create policy "Admin can update player status" on tournament_players for update using (exists (select 1 from tournaments where id = tournament_id and (auth.uid()::text = created_by)));

-- Tournament matches: anyone can view, auth can create/update (via app logic)
create policy "Anyone can view matches" on tournament_matches for select using (true);
create policy "Auth can insert matches" on tournament_matches for insert to authenticated with check (true);
create policy "Auth can update matches" on tournament_matches for update using (true);

-- Payments: users can view own, auth can insert own
create policy "Users can view own payments" on tournament_payments for select using (auth.uid()::text = user_id);
create policy "Creators can view all payments" on tournament_payments for select using (exists (select 1 from tournaments where id = tournament_id and (auth.uid()::text = created_by)));
create policy "Auth can insert payment" on tournament_payments for insert to authenticated with check (true);

-- ── INDEXES ──
create index if not exists idx_tp_tournament on tournament_players(tournament_id);
create index if not exists idx_tp_user on tournament_players(user_id);
create index if not exists idx_tm_tournament on tournament_matches(tournament_id);
create index if not exists idx_tm_round on tournament_matches(tournament_id, round);
create index if not exists idx_tpay_tournament on tournament_payments(tournament_id);
create index if not exists idx_tpay_user on tournament_payments(user_id);
create index if not exists idx_tournaments_status on tournaments(status);

-- ── ENABLE REALTIME ──
alter publication supabase_realtime add table tournaments;
alter publication supabase_realtime add table tournament_players;
alter publication supabase_realtime add table tournament_matches;
alter publication supabase_realtime add table tournament_payments;
