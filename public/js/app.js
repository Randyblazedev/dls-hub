-- ═══════════════════════════════════════════════════════════
--  DLS Hub — Feature Expansion SQL
--  Run in Supabase Dashboard → SQL Editor
-- ═══════════════════════════════════════════════════════════

-- 1. ACHIEVEMENTS TABLE
CREATE TABLE IF NOT EXISTS achievements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  userid TEXT REFERENCES users(uid) ON DELETE CASCADE,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  icon TEXT DEFAULT '🏆',
  earned_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_achievements_user ON achievements(userid);

-- 2. SQUADS TABLE
CREATE TABLE IF NOT EXISTS squads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  userid TEXT REFERENCES users(uid) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT 'My Squad',
  formation TEXT DEFAULT '4-4-2',
  players JSONB DEFAULT '[]',
  likes TEXT[] DEFAULT '{}',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_squads_user ON squads(userid);

-- 3. CHALLENGES TABLE
CREATE TABLE IF NOT EXISTS challenges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  description TEXT,
  challenge_type TEXT DEFAULT 'score',
  reward_points INT DEFAULT 100,
  start_date TIMESTAMP WITH TIME ZONE DEFAULT now(),
  end_date TIMESTAMP WITH TIME ZONE,
  status TEXT DEFAULT 'active',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- 4. CHALLENGE SUBMISSIONS TABLE
CREATE TABLE IF NOT EXISTS challenge_submissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  challengeid UUID REFERENCES challenges(id) ON DELETE CASCADE,
  userid TEXT REFERENCES users(uid) ON DELETE CASCADE,
  score INT DEFAULT 0,
  screenshot_url TEXT,
  submitted_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_submissions_challenge ON challenge_submissions(challengeid);

-- 5. PLAYER RATINGS TABLE
CREATE TABLE IF NOT EXISTS player_ratings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  player_name TEXT NOT NULL,
  userid TEXT REFERENCES users(uid) ON DELETE CASCADE,
  rating INT DEFAULT 5 CHECK (rating >= 1 AND rating <= 10),
  review TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ratings_player ON player_ratings(player_name);

-- 6. ACTIVITY FEED TABLE
CREATE TABLE IF NOT EXISTS activity_feed (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  userid TEXT REFERENCES users(uid) ON DELETE CASCADE,
  username TEXT,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_activity_created ON activity_feed(created_at DESC);

-- 7. UPDATE NOTIFICATIONS TABLE (add read status if missing)
DO $$ BEGIN
  ALTER TABLE notifications ADD COLUMN IF NOT EXISTS read BOOLEAN DEFAULT false;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

-- 8. ENABLE REALTIME for new tables
ALTER PUBLICATION supabase_realtime ADD TABLE achievements;
ALTER PUBLICATION supabase_realtime ADD TABLE squads;
ALTER PUBLICATION supabase_realtime ADD TABLE challenges;
ALTER PUBLICATION supabase_realtime ADD TABLE activity_feed;

-- 9. STORAGE BUCKET for squad images
INSERT INTO storage.buckets (id, name, public)
VALUES ('squads', 'squads', true)
ON CONFLICT (id) DO NOTHING;

-- 10. STORAGE POLICIES
CREATE POLICY "Authenticated users can upload squad images"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (bucket_id = 'squads');

CREATE POLICY "Public can view squad images"
ON storage.objects FOR SELECT USING (bucket_id = 'squads');
