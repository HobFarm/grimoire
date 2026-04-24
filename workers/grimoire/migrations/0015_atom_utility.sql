-- Add utility classification column to atoms.
-- visual: renderable (default, covers most atoms)
-- literary: abstract/domain vocabulary with no visual form
-- dual: both visual and conceptual applications

ALTER TABLE atoms ADD COLUMN utility TEXT NOT NULL DEFAULT 'visual';
CREATE INDEX idx_atoms_utility ON atoms(utility);

-- Pure narrative/domain vocabulary -> literary
UPDATE atoms SET utility = 'literary' WHERE category_slug IN (
  'domain.chemistry', 'domain.medicine', 'domain.law',
  'domain.academia', 'domain.athletics',
  'narrative.phrase', 'narrative.action', 'narrative.concept'
);

-- Categories with both visual and conceptual applications -> dual
UPDATE atoms SET utility = 'dual' WHERE category_slug IN (
  'narrative.mood', 'narrative.scene', 'narrative.archetype',
  'reference.person', 'reference.character', 'reference.film',
  'reference.location', 'reference.game',
  'domain.technology', 'domain.maritime', 'domain.aviation',
  'domain.military', 'domain.folklore', 'domain.occult',
  'domain.cuisine',
  'style.era'
);
