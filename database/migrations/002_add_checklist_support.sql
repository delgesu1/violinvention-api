-- Migration: Add checklist support to conversation briefs
-- This migration adds columns to store the initial checklist from first AI response

-- Add checklist columns to existing conversation_briefs table
ALTER TABLE conversation_briefs
  ADD COLUMN IF NOT EXISTS initial_checklist_text TEXT,   -- original block, human-readable
  ADD COLUMN IF NOT EXISTS initial_checklist_items JSONB; -- ["Reframe dynamics", "Calibrate bow...", ...]

-- Add comments for documentation
COMMENT ON COLUMN conversation_briefs.initial_checklist_text IS 'Full text of initial checklist from first AI response';
COMMENT ON COLUMN conversation_briefs.initial_checklist_items IS 'Array of checklist items for numbered list generation';