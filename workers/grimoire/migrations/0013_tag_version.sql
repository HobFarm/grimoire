-- Track which arrangement set an atom was tagged against.
-- Existing atoms get 0 (force re-tag against all current arrangements).
-- The tagger uses arrangement count as the version ceiling.
-- Adding new arrangements auto-triggers backlog re-processing.
ALTER TABLE atoms ADD COLUMN tag_version INTEGER NOT NULL DEFAULT 0;

CREATE INDEX idx_atoms_tag_version ON atoms(tag_version);
