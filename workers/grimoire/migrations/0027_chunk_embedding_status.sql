-- Track embedding status for document chunks (matches atom embedding_status pattern).
-- Existing rows default to 'pending'. Idempotent re-vectorization handles backfill.
ALTER TABLE document_chunks ADD COLUMN embedding_status TEXT DEFAULT 'pending';
