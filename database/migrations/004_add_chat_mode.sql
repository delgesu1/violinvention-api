-- Add chat_mode column to chats table
ALTER TABLE chats
ADD COLUMN IF NOT EXISTS chat_mode TEXT NOT NULL DEFAULT 'arcoai';

-- Add constraint to ensure valid modes
ALTER TABLE chats
ADD CONSTRAINT IF NOT EXISTS chat_mode_check CHECK (chat_mode IN ('arcoai', 'personal_lessons'));

-- Backfill existing chats (in case column was added without default)
UPDATE chats SET chat_mode = 'arcoai' WHERE chat_mode IS NULL;

-- Add index for mode filtering
CREATE INDEX IF NOT EXISTS idx_chats_chat_mode ON chats(chat_mode);

-- Document the column
COMMENT ON COLUMN chats.chat_mode IS 'Chat mode: arcoai (shared vector store) or personal_lessons (user vector store)';
