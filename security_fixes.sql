-- ═══════════════════════════════════════════════════════════
--  DLS Hub — Security Fixes: Tournament RLS Lockdown
--  Run this in: Supabase Dashboard → SQL Editor → New Query
-- ═══════════════════════════════════════════════════════════

-- 1. Tournaments INSERT: enforce created_by matches auth user
drop policy if exists "Auth can create tournaments" on tournaments;
create policy "Users can create own tournaments" on tournaments
  for insert to authenticated
  with check (auth.uid()::text = created_by);

-- 2. Tournament matches INSERT: only tournament creator or admin
drop policy if exists "Auth can insert matches" on tournament_matches;
create policy "Creator or admin inserts matches" on tournament_matches
  for insert to authenticated
  with check (
    exists (
      select 1 from tournaments
      where id = tournament_id
      and (auth.uid()::text = created_by or is_admin_user(auth.uid()::text))
    )
  );

-- 3. Tournament matches UPDATE: only participants, creator, or admin
drop policy if exists "Auth can update matches" on tournament_matches;
create policy "Participants, creator, or admin update matches" on tournament_matches
  for update
  using (
    auth.uid()::text = player1_id
    or auth.uid()::text = player2_id
    or exists (
      select 1 from tournaments
      where id = tournament_id
      and (auth.uid()::text = created_by or is_admin_user(auth.uid()::text))
    )
  )
  with check (
    auth.uid()::text = player1_id
    or auth.uid()::text = player2_id
    or exists (
      select 1 from tournaments
      where id = tournament_id
      and (auth.uid()::text = created_by or is_admin_user(auth.uid()::text))
    )
  );

-- 4. Tournament payments INSERT: only own payments
drop policy if exists "Auth can insert payment" on tournament_payments;
create policy "Users insert own payments" on tournament_payments
  for insert to authenticated
  with check (auth.uid()::text = user_id);

-- 5. Admin overrides for tournament tables
create policy "Admins update any tournament" on tournaments
  for update using (is_admin_user(auth.uid()::text));

create policy "Admins delete any tournament" on tournaments
  for delete using (is_admin_user(auth.uid()::text));

create policy "Admins update any player" on tournament_players
  for update using (is_admin_user(auth.uid()::text));

create policy "Admins delete any player" on tournament_players
  for delete using (is_admin_user(auth.uid()::text));

create policy "Admins update any match" on tournament_matches
  for update using (is_admin_user(auth.uid()::text));

create policy "Admins delete any match" on tournament_matches
  for delete using (is_admin_user(auth.uid()::text));

create policy "Admins view all payments" on tournament_payments
  for select using (is_admin_user(auth.uid()::text));

create policy "Admins update any payment" on tournament_payments
  for update using (is_admin_user(auth.uid()::text));

create policy "Admins delete any payment" on tournament_payments
  for delete using (is_admin_user(auth.uid()::text));
