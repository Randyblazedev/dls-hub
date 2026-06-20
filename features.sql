-- =====================================================
-- DLS Hub v4 — Features SQL
-- Run these in Supabase SQL Editor
-- =====================================================

-- 1. Chat image support
-- ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS imageurl TEXT;

-- 2. Post reactions (JSONB object like {"🔥":["uid1"],"⚽":["uid2"]})
-- ALTER TABLE posts ADD COLUMN IF NOT EXISTS reactions JSONB DEFAULT '{}';

-- 3. Squads table
-- CREATE TABLE IF NOT EXISTS squads (
--   id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
--   user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
--   username TEXT,
--   squad_name TEXT NOT NULL,
--   formation TEXT DEFAULT '4-4-2',
--   players TEXT,
--   description TEXT,
--   image_url TEXT,
--   created_at TIMESTAMPTZ DEFAULT NOW(),
--   likes UUID[] DEFAULT '{}',
--   comment_count INT DEFAULT 0
-- );

-- 4. Prediction matches
-- CREATE TABLE IF NOT EXISTS prediction_matches (
--   id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
--   team_a TEXT NOT NULL,
--   team_b TEXT NOT NULL,
--   match_date TIMESTAMPTZ,
--   deadline TIMESTAMPTZ NOT NULL,
--   result_a INT,
--   result_b INT,
--   status TEXT DEFAULT 'upcoming',
--   created_by UUID REFERENCES auth.users(id),
--   created_at TIMESTAMPTZ DEFAULT NOW()
-- );

-- 5. Predictions
-- CREATE TABLE IF NOT EXISTS predictions (
--   id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
--   match_id UUID REFERENCES prediction_matches(id) ON DELETE CASCADE,
--   user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
--   username TEXT,
--   pred_a INT NOT NULL,
--   pred_b INT NOT NULL,
--   points INT DEFAULT 0,
--   created_at TIMESTAMPTZ DEFAULT NOW(),
--   UNIQUE(match_id, user_id)
-- );

-- 6. Player of the Week nominations
-- CREATE TABLE IF NOT EXISTS potw_nominations (
--   id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
--   player_name TEXT NOT NULL,
--   team TEXT,
--   rating NUMERIC(3,1),
--   reason TEXT,
--   nominated_by UUID REFERENCES auth.users(id),
--   username TEXT,
--   votes_up UUID[] DEFAULT '{}',
--   votes_down UUID[] DEFAULT '{}',
--   week_start DATE DEFAULT DATE_TRUNC('week', NOW()),
--   created_at TIMESTAMPTZ DEFAULT NOW()
-- );

-- 7. Reports
-- CREATE TABLE IF NOT EXISTS reports (
--   id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
--   reported_by UUID REFERENCES auth.users(id),
--   reporter_name TEXT,
--   content_type TEXT NOT NULL,
--   content_id TEXT NOT NULL,
--   reason TEXT NOT NULL,
--   status TEXT DEFAULT 'pending',
--   created_at TIMESTAMPTZ DEFAULT NOW()
-- );

-- 8. Squad comments
-- CREATE TABLE IF NOT EXISTS squad_comments (
--   id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
--   squad_id UUID REFERENCES squads(id) ON DELETE CASCADE,
--   user_id UUID REFERENCES auth.users(id),
--   username TEXT,
--   content TEXT NOT NULL,
--   created_at TIMESTAMPTZ DEFAULT NOW()
-- );

-- Enable Realtime for presence (run in Supabase dashboard > Replication):
-- ALTER PUBLICATION supabase_realtime ADD TABLE chat_messages;
-- ALTER PUBLICATION supabase_realtime ADD TABLE posts;

-- RLS policies (run after creating tables):
-- Enable RLS on all new tables and add permissive policies for authenticated users.
