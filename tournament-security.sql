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

-- 6. Auto-award prize points when a tournament is marked completed
CREATE OR REPLACE FUNCTION award_tournament_prize()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status = 'completed' AND NEW.winner_id IS NOT NULL AND COALESCE(NEW.points_prize, 0) > 0 THEN
    PERFORM award_points(NEW.winner_id, NEW.points_prize);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_award_tournament_prize ON tournaments;
CREATE TRIGGER trg_award_tournament_prize
  AFTER UPDATE ON tournaments
  FOR EACH ROW EXECUTE FUNCTION award_tournament_prize();

-- 7. Lock down who can run these functions
REVOKE ALL ON FUNCTION decrement_points(int) FROM PUBLIC;
REVOKE ALL ON FUNCTION award_points(text, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION decrement_points(int) TO authenticated;
GRANT EXECUTE ON FUNCTION award_points(text, int) TO authenticated;
