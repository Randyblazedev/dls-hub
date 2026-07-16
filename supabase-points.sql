-- ═══════════════════════════════════════════════════════════
-- DLS Hub Points & Challenges System
-- Run this SQL in your Supabase SQL Editor (https://supabase.com)
-- ═══════════════════════════════════════════════════════════

-- 1. Add columns to users table (if not exists)
ALTER TABLE users ADD COLUMN IF NOT EXISTS points INTEGER DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen TIMESTAMPTZ;

-- 2. Challenges table
CREATE TABLE IF NOT EXISTS challenges (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  team1 TEXT NOT NULL,
  team2 TEXT DEFAULT 'TBD',
  bet INTEGER NOT NULL CHECK (bet >= 1 AND bet <= 5),
  rules TEXT DEFAULT '',
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending','playing','submitted','done')),
  created_by TEXT NOT NULL,
  accepted_by TEXT,
  winner TEXT,
  score TEXT,
  verified_by TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

-- 3. Debts table (who owes who)
CREATE TABLE IF NOT EXISTS debts (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  debtor TEXT NOT NULL,        -- user who owes
  creditor TEXT NOT NULL,      -- user owed to
  amount INTEGER NOT NULL,
  settled BOOLEAN DEFAULT FALSE,
  challenge_id uuid REFERENCES challenges(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 4. Enable Row Level Security
ALTER TABLE challenges ENABLE ROW LEVEL SECURITY;
ALTER TABLE debts ENABLE ROW LEVEL SECURITY;

-- 5. Allow all operations for authenticated users (simplified for now)
CREATE POLICY "challenges_public" ON challenges FOR ALL USING (true);
CREATE POLICY "debts_public" ON debts FOR ALL USING (true);

-- 6. Function to transfer points (auto-settle debts)
CREATE OR REPLACE FUNCTION transfer_points(
  p_from TEXT,
  p_to TEXT,
  p_amount INTEGER,
  p_challenge_id uuid
) RETURNS void AS $$
DECLARE
  v_debt_id uuid;
  v_debt_amount INTEGER;
BEGIN
  -- Deduct from loser
  UPDATE users SET points = GREATEST(0, points - p_amount) WHERE username = p_from;
  -- Add to winner
  UPDATE users SET points = points + p_amount WHERE username = p_to;
  
  -- Check if loser now has unpaid debt
  IF (SELECT points FROM users WHERE username = p_from) < 0 THEN
    INSERT INTO debts (debtor, creditor, amount, challenge_id)
    VALUES (p_from, p_to, ABS((SELECT points FROM users WHERE username = p_from)), p_challenge_id);
  END IF;
END;
$$ LANGUAGE plpgsql;
