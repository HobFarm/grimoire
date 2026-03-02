-- Insert new domain and narrative categories
INSERT INTO categories (slug, parent, label, description, output_schema) VALUES
  ('domain.academia', 'domain', 'Academia', 'Academic and scholarly vocabulary', '{}'),
  ('domain.athletics', 'domain', 'Athletics', 'Sports and physical competition terms', '{}'),
  ('domain.aviation', 'domain', 'Aviation', 'Aviation and flight vocabulary', '{}'),
  ('domain.chemistry', 'domain', 'Chemistry', 'Chemical and alchemical vocabulary', '{}'),
  ('domain.cuisine', 'domain', 'Cuisine', 'Culinary and food vocabulary', '{}'),
  ('domain.folklore', 'domain', 'Folklore', 'Myth, legend, and folk tradition vocabulary', '{}'),
  ('domain.law', 'domain', 'Law', 'Legal and judicial vocabulary', '{}'),
  ('domain.maritime', 'domain', 'Maritime', 'Nautical and ocean vocabulary', '{}'),
  ('domain.medicine', 'domain', 'Medicine', 'Medical and anatomical vocabulary', '{}'),
  ('domain.military', 'domain', 'Military', 'Military and strategic vocabulary', '{}'),
  ('domain.occult', 'domain', 'Occult', 'Occult, mystical, and esoteric vocabulary', '{}'),
  ('domain.technology', 'domain', 'Technology', 'Technical and digital vocabulary', '{}'),
  ('narrative.action', 'narrative', 'Action', 'Verbs driving narrative momentum', '{}'),
  ('narrative.archetype', 'narrative', 'Archetype', 'Character archetypes and roles', '{}'),
  ('narrative.concept', 'narrative', 'Concept', 'Abstract narrative concepts and themes', '{}'),
  ('narrative.phrase', 'narrative', 'Phrase', 'Compressed atmospheric descriptions', '{}');
