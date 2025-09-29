-- Migration: Add conversation state support
-- This migration adds support for conversation context using brief + outline system

-- Step 1: Add columns to messages table
ALTER TABLE messages
ADD COLUMN outline TEXT,                    -- 100-token outline of assistant responses
ADD COLUMN is_initial BOOLEAN NOT NULL DEFAULT FALSE; -- Mark initial responses for key points

-- Step 2: Create conversation_briefs table
CREATE TABLE conversation_briefs (
  id SERIAL PRIMARY KEY,
  chat_id UUID REFERENCES chats(chat_id) ON DELETE CASCADE,
  user_id UUID NOT NULL, -- References auth.users.id from Supabase Auth (no FK constraint like messages/chats)
  brief JSONB NOT NULL,
  token_count INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(chat_id),
  CONSTRAINT brief_is_object CHECK (jsonb_typeof(brief) = 'object')
);

-- Step 3: Create indexes for performance
CREATE INDEX idx_briefs_chat ON conversation_briefs(chat_id);
CREATE INDEX idx_messages_chat_role_created_at ON messages (chat_id, created_at DESC)
  WHERE role = 'assistant';

-- Step 4: Create trigger using Supabase's built-in function (if available)
-- Note: Supabase may have update_updated_at_column() function available
-- If not available, the custom function below will be used as fallback
DO $$
BEGIN
  -- Try to use Supabase's built-in trigger function first
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'update_updated_at_column') THEN
    EXECUTE 'CREATE TRIGGER update_brief_updated_at
      BEFORE UPDATE ON conversation_briefs
      FOR EACH ROW EXECUTE FUNCTION update_updated_at_column()';
  ELSE
    -- Fallback: create our own trigger function
    EXECUTE 'CREATE OR REPLACE FUNCTION update_brief_timestamp()
      RETURNS TRIGGER AS $trigger$
      BEGIN
        NEW.updated_at = NOW();
        RETURN NEW;
      END;
      $trigger$ LANGUAGE plpgsql;

      CREATE TRIGGER update_brief_updated_at
        BEFORE UPDATE ON conversation_briefs
        FOR EACH ROW EXECUTE FUNCTION update_brief_timestamp()';
  END IF;
END $$;

-- Step 5: Add comments for documentation
COMMENT ON TABLE conversation_briefs IS 'Stores conversation context briefs for memory management';
COMMENT ON COLUMN conversation_briefs.brief IS 'JSON object containing goal, decisions, techniques, etc.';
COMMENT ON COLUMN conversation_briefs.token_count IS 'Approximate token count of the brief';
COMMENT ON COLUMN conversation_briefs.user_id IS 'References auth.users.id from Supabase Auth';
COMMENT ON COLUMN messages.outline IS 'Outline/summary of assistant responses for next turn context';
COMMENT ON COLUMN messages.is_initial IS 'True if this is the first assistant response in a chat';