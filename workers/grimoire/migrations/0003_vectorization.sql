-- Phase 4: Vectorization status tracking
-- Column likely already exists on remote DB (added manually)
-- This migration ensures schema parity for fresh/local instances

ALTER TABLE atoms ADD COLUMN embedding_status TEXT DEFAULT 'pending';
CREATE INDEX idx_atoms_embedding_status ON atoms(embedding_status);
