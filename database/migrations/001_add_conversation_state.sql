-- Migration: Add conversation state support
-- This migration adds support for conversation context using brief + outline system

-- Step 1: Add columns to messages table
ALTER TABLE messages
ADD COLUMN outline TEXT,                    -- 100-token outline of assistant responses
ADD COLUMN is_initial BOOLEAN DEFAULT FALSE; -- Mark initial responses for key points

-- Step 2: Create conversation_briefs table
CREATE TABLE conversation_briefs (
  id SERIAL PRIMARY KEY,
  chat_id UUID REFERENCES chats(chat_id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  brief JSONB NOT NULL,
  token_count INTEGER,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(chat_id)
);

-- Step 3: Create index for performance
CREATE INDEX idx_briefs_chat ON conversation_briefs(chat_id);

-- Step 4: Create trigger for auto-updating updated_at
CREATE OR REPLACE FUNCTION update_brief_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_brief_updated_at
  BEFORE UPDATE ON conversation_briefs
  FOR EACH ROW EXECUTE FUNCTION update_brief_timestamp();

-- Step 5: Add comments for documentation
COMMENT ON TABLE conversation_briefs IS 'Stores conversation context briefs for memory management';
COMMENT ON COLUMN conversation_briefs.brief IS 'JSON object containing goal, decisions, techniques, etc.';
COMMENT ON COLUMN conversation_briefs.token_count IS 'Approximate token count of the brief';
COMMENT ON COLUMN messages.outline IS 'Outline/summary of assistant responses for next turn context';
COMMENT ON COLUMN messages.is_initial IS 'True if this is the first assistant response in a chat';