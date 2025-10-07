-- Migration: Add vector store support for multi-tenant semantic search
-- Status: ALREADY APPLIED TO PRODUCTION (2025-10-07)
-- This file serves as documentation for the schema changes

-- Add vector store tracking to user_settings
ALTER TABLE user_settings
ADD COLUMN vector_store_id TEXT,
ADD COLUMN vector_store_created_at TIMESTAMPTZ;

CREATE INDEX idx_user_settings_vector_store
ON user_settings(vector_store_id)
WHERE vector_store_id IS NOT NULL;

-- Add vector store file tracking to recordings
ALTER TABLE recordings
ADD COLUMN vector_store_file_id TEXT,
ADD COLUMN openai_file_id TEXT;

CREATE INDEX idx_recordings_vector_store_file
ON recordings(vector_store_file_id)
WHERE vector_store_file_id IS NOT NULL;

CREATE INDEX idx_recordings_openai_file
ON recordings(openai_file_id)
WHERE openai_file_id IS NOT NULL;

-- Add documentation comments
COMMENT ON COLUMN user_settings.vector_store_id IS 'OpenAI vector store ID for user-specific lesson knowledge base';
COMMENT ON COLUMN user_settings.vector_store_created_at IS 'Timestamp when the user-specific vector store was provisioned';
COMMENT ON COLUMN recordings.vector_store_file_id IS 'Vector store file ID for this lesson';
COMMENT ON COLUMN recordings.openai_file_id IS 'Underlying OpenAI file ID (for cleanup on deletion)';

-- Implementation notes:
-- 1. Vector stores are created on-demand when a user first uploads a lesson
-- 2. Each user gets their own vector store (multi-tenant pattern)
-- 3. Combined summary + transcript files are uploaded to user's vector store
-- 4. Deletion requires removing both vector_store_file_id AND openai_file_id
-- 5. Search results are injected into chat context for relevant lesson history
-- 6. Partial indexes enable fast queries without penalizing writes when IDs are null
