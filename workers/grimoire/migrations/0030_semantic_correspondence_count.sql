-- Denormalize semantic correspondence presence onto atoms so Phase 6 of the cron
-- can stop scanning 178K atoms through two NOT EXISTS subqueries every 15 min.
--
-- Counter (not boolean) so future re-discovery passes can query
-- `WHERE semantic_correspondence_count < N`.
--
-- Triggers keep the counter in sync. Upserts on correspondences resolve via
-- ON CONFLICT DO UPDATE, which fires UPDATE triggers (not INSERT), so real
-- inserts never get double-counted.

ALTER TABLE atoms ADD COLUMN semantic_correspondence_count INTEGER NOT NULL DEFAULT 0;

-- Partial index: the exact shape Phase 6 filters on.
CREATE INDEX idx_atoms_phase6_candidates
  ON atoms(id)
  WHERE semantic_correspondence_count = 0
    AND embedding_status = 'complete'
    AND category_slug IS NOT NULL;

CREATE TRIGGER trg_corr_insert_inc_semcc
AFTER INSERT ON correspondences
WHEN NEW.provenance = 'semantic'
BEGIN
  UPDATE atoms SET semantic_correspondence_count = semantic_correspondence_count + 1
    WHERE id = NEW.atom_a_id;
  UPDATE atoms SET semantic_correspondence_count = semantic_correspondence_count + 1
    WHERE id = NEW.atom_b_id;
END;

CREATE TRIGGER trg_corr_delete_dec_semcc
AFTER DELETE ON correspondences
WHEN OLD.provenance = 'semantic'
BEGIN
  UPDATE atoms SET semantic_correspondence_count = MAX(0, semantic_correspondence_count - 1)
    WHERE id = OLD.atom_a_id;
  UPDATE atoms SET semantic_correspondence_count = MAX(0, semantic_correspondence_count - 1)
    WHERE id = OLD.atom_b_id;
END;

-- Handle the rare case where an existing correspondence has its provenance flipped.
CREATE TRIGGER trg_corr_update_provenance_semcc
AFTER UPDATE OF provenance ON correspondences
WHEN OLD.provenance != NEW.provenance
BEGIN
  UPDATE atoms SET semantic_correspondence_count = MAX(0, semantic_correspondence_count - 1)
    WHERE id = OLD.atom_a_id AND OLD.provenance = 'semantic';
  UPDATE atoms SET semantic_correspondence_count = MAX(0, semantic_correspondence_count - 1)
    WHERE id = OLD.atom_b_id AND OLD.provenance = 'semantic';
  UPDATE atoms SET semantic_correspondence_count = semantic_correspondence_count + 1
    WHERE id = NEW.atom_a_id AND NEW.provenance = 'semantic';
  UPDATE atoms SET semantic_correspondence_count = semantic_correspondence_count + 1
    WHERE id = NEW.atom_b_id AND NEW.provenance = 'semantic';
END;
