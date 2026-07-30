-- DLS Hub Points Migration
-- Run this in Supabase SQL Editor

-- 1. Add points column to users table (default 0)
ALTER TABLE users ADD COLUMN IF NOT EXISTS points int DEFAULT 0;

-- 2. Rename entry_fee to points_cost in tournaments
ALTER TABLE tournaments RENAME COLUMN entry_fee TO points_cost;

-- 3. Drop the tournament_payments table (no longer needed)
DROP TABLE IF EXISTS tournament_payments;
