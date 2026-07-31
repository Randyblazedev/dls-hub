-- ═══════════════════════════════════════════════════════════
--  DLS Hub - Tournament Security & Points (server-side)
--  Run in Supabase SQL Editor
--  NOTE: plain ASCII only (no fancy dashes), run each block.
-- ═══════════════════════════════════════════════════════════

-- 1. Team name on players (real DLS game team name, set before start)
ALTER TABLE tournament_players ADD COLUMN IF NOT EXISTS team_name text DEFAULT '';

-- 2. Points prize on tournaments (awarded to winner automatically)
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS points_prize int DEFAULT 0;

-- 3. Match evidence columns (screenshot + opponent confirmation)
ALTER TABLE tournament_matches ADD COLUMN IF NOT EXISTS screenshot_url text DEFAULT '';
ALTER TABLE tournament_matches ADD COLUMN IF NOT EXISTS proposed_winner_id text DEFAULT '';
ALTER TABLE tournament_matches ADD COLUMN IF NOT EXISTS proposed_winner_name text DEFAULT '';
ALTER TABLE tournament_matches ADD COLUMN IF NOT EXISTS result_submitted_by text DEFAULT '';

-- 4. Secure atomic point deduction (used for tournament entry fee)
--    Only deducts from the logged-in user; cannot go below 0.
CREATE OR REPLACE FUNCTION decrement_points(amount int)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  new_points int;
BEGIN
  UPDATE users
    SET points = GREATEST(0, points - amount)
    WHERE uid = auth.uid()::text
    RETURNING points INTO new_points;
  RETURN new_points;
END;
$$;

-- 5. Server-side point award (used by prize trigger)
CREATE OR REPLACE FUNCTION award_points(target_uid text, amount int)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE users SET points = points + amount WHERE uid = target_uid;
END;
$$;

-- 6. Winner takes all: payout = entry fee x approved players.
--    Runs when a tournament is marked completed.
CREATE OR REPLACE FUNCTION award_tournament_prize()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  entry int;
  joined int;
  pool int;
BEGIN
  IF NEW.status = 'completed' AND OLD.status IS DISTINCT FROM 'completed' AND NEW.winner_id IS NOT NULL THEN
    SELECT COALESCE(points_cost, 0) INTO entry FROM tournaments WHERE id = NEW.id;
    SELECT COUNT(*) INTO joined FROM tournament_players
      WHERE tournament_id = NEW.id AND status = 'approved';
    pool := entry * joined;
    IF pool > 0 THEN
      PERFORM award_points(NEW.winner_id, pool);
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_award_tournament_prize ON tournaments;
CREATE TRIGGER trg_award_tournament_prize
  AFTER UPDATE ON tournaments
  FOR EACH ROW EXECUTE FUNCTION award_tournament_prize();

-- 6b. AI match verification fields + opponent confirmation auto-lock
ALTER TABLE tournament_matches ADD COLUMN IF NOT EXISTS confirmed boolean DEFAULT false;
ALTER TABLE tournament_matches ADD COLUMN IF NOT EXISTS verification_status text DEFAULT 'pending';
ALTER TABLE tournament_matches ADD COLUMN IF NOT EXISTS ai_detected_winner text DEFAULT '';
ALTER TABLE tournament_matches ADD COLUMN IF NOT EXISTS ai_detected_score text DEFAULT '';
ALTER TABLE tournament_matches ADD COLUMN IF NOT EXISTS ai_confidence numeric DEFAULT 0;
ALTER TABLE tournament_matches ADD COLUMN IF NOT EXISTS ai_verified_at timestamptz DEFAULT NULL;

CREATE OR REPLACE FUNCTION confirm_match()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  IF NEW.confirmed = true AND OLD.confirmed IS DISTINCT FROM true THEN
    NEW.verification_status := 'locked';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_confirm_match ON tournament_matches;
CREATE TRIGGER trg_confirm_match
  AFTER UPDATE ON tournament_matches
  FOR EACH ROW
  WHEN (NEW.confirmed = true AND OLD.confirmed IS DISTINCT FROM true)
  EXECUTE FUNCTION confirm_match();

-- 7. Lock down who can run these functions
REVOKE ALL ON FUNCTION decrement_points(int) FROM PUBLIC;
REVOKE ALL ON FUNCTION award_points(text, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION decrement_points(int) TO authenticated;
GRANT EXECUTE ON FUNCTION award_points(text, int) TO authenticated;
