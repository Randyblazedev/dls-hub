-- Add DELETE policies for all tables so users can delete their own content

-- Posts delete
DO $$ BEGIN
  CREATE POLICY "Users can delete own posts" ON posts FOR DELETE USING (auth.uid()::text = authorid);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Comments delete
DO $$ BEGIN
  CREATE POLICY "Users can delete own comments" ON comments FOR DELETE USING (auth.uid()::text = authorid);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Chat messages delete (own messages)
DO $$ BEGIN
  CREATE POLICY "Users can delete own chat" ON chat_messages FOR DELETE USING (auth.uid()::text = authorid);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- DM messages delete (sender only)
DO $$ BEGIN
  CREATE POLICY "Users can delete own DMs" ON dm_messages FOR DELETE USING (auth.uid()::text = senderid);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
