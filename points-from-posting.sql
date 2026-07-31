-- ═══════════════════════════════════════════════════════════
--  DLS Hub — Points from Posting (server-side, cheat-proof)
--  Run in Supabase SQL Editor
-- ═══════════════════════════════════════════════════════════

-- 1. Points column (run if you haven't already)
ALTER TABLE users ADD COLUMN IF NOT EXISTS points int DEFAULT 0;

-- 2. Block clients from editing points directly (stops console hacks)
DROP POLICY IF EXISTS "Users can update own profile" ON users;
CREATE POLICY "Users can update own profile" ON users
  FOR UPDATE USING (auth.uid()::text = uid)
  WITH CHECK (
    auth.uid()::text = uid AND
    points = (SELECT points FROM users WHERE uid = auth.uid()::text)
  );

-- 3. Server-side award function (awards 10 points per post)
CREATE OR REPLACE FUNCTION award_points_on_post()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE users SET points = points + 10 WHERE uid = NEW.authorid;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 4. Auto-award on every new post
DROP TRIGGER IF EXISTS trg_award_points_on_post ON posts;
CREATE TRIGGER trg_award_points_on_post
  AFTER INSERT ON posts
  FOR EACH ROW EXECUTE FUNCTION award_points_on_post();
