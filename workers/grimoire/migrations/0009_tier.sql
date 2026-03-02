-- Phase 1.9: Operational tier column
-- Tier 1: atoms with both correspondences AND exemplar appearances
-- Tier 2: atoms with correspondences but no exemplars
-- Tier 3: isolated atoms (default)

ALTER TABLE atoms ADD COLUMN tier INTEGER NOT NULL DEFAULT 3;

-- Tier 1: appears in exemplars AND has correspondences
UPDATE atoms SET tier = 1
WHERE id IN (SELECT DISTINCT atom_id FROM exemplars)
  AND id IN (
    SELECT DISTINCT atom_a_id FROM correspondences
    UNION
    SELECT DISTINCT atom_b_id FROM correspondences
  );

-- Tier 2: has correspondences but not in exemplars
UPDATE atoms SET tier = 2
WHERE tier = 3
  AND id IN (
    SELECT DISTINCT atom_a_id FROM correspondences
    UNION
    SELECT DISTINCT atom_b_id FROM correspondences
  );

CREATE INDEX idx_atoms_tier ON atoms(tier);
