-- Add register dimension: ethereal (0.0) to visceral (1.0)
-- NULL = unclassified (scoring coalesces to 0.5 neutral)
ALTER TABLE atoms ADD COLUMN register REAL DEFAULT NULL;

-- Arrangements default to 0.5 (neutral) so register has zero scoring impact until tuned
ALTER TABLE arrangements ADD COLUMN register REAL DEFAULT 0.5;
