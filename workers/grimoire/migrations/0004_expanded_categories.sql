-- ============================================================
-- Migration 0004: Expanded Categories
-- Adds 12 new classification categories for diverse atom domains:
-- wildlife, film references, locations, scene descriptions,
-- character profiles, techniques, game references, and more.
-- ============================================================

-- Subject group (existing parent)
INSERT INTO categories (slug, parent, label, description, output_schema) VALUES
('subject.animal', 'subject', 'Animal', 'Animals, birds, insects, marine life. Physical description and species identification. Covers any living non-human organism as visual subject.', '{"term":"string","species":"string","type":"mammal|bird|reptile|amphibian|fish|insect|arachnid|marine|hybrid","scale":"tiny|small|medium|large|massive","coloring":"string?"}');

-- Environment group (existing parent)
INSERT INTO categories (slug, parent, label, description, output_schema) VALUES
('environment.natural', 'environment', 'Natural Feature', 'Natural features and phenomena. Mountains, rivers, forests, weather, seasons, geological formations. Landscape elements not built by humans.', '{"term":"string","type":"terrain|water|vegetation|geological|weather|celestial","scale":"detail|feature|landscape|panoramic","season_affinity":"string?","era_affinity":"string[]"}');

-- Reference group (new parent)
INSERT INTO categories (slug, parent, label, description, output_schema) VALUES
('reference.film', 'reference', 'Film Reference', 'Film titles, director names, cinematographer names. Cultural and cinematic source references that inform visual style and tone.', '{"term":"string","type":"film|director|cinematographer|franchise","era":"string?","style_note":"string?"}'),
('reference.technique', 'reference', 'Technique Reference', 'Cinematographic and photographic techniques. Rack focus, chiaroscuro, cross-processing, long exposure. Methods that define how an image is captured or rendered.', '{"term":"string","domain":"camera|lighting|darkroom|digital|optical","effect_on":"focus|exposure|color|motion|depth","complexity":"basic|intermediate|advanced"}'),
('reference.person', 'reference', 'Person Reference', 'Real people. Photographers, artists, directors, cinematographers. Names serving as style references that evoke a body of visual work.', '{"term":"string","role":"photographer|director|cinematographer|artist|designer","era":"string?","style_note":"string?"}'),
('reference.location', 'reference', 'Location Reference', 'Named places, heritage sites, landmarks, architectural locations. Specific real-world places that carry distinct visual character.', '{"term":"string","type":"landmark|city|region|heritage_site|natural_wonder|architectural","country":"string?","era_affinity":"string[]"}'),
('reference.character', 'reference', 'Character Reference', 'Fictional characters with known visual designs. Names paired with visual descriptions. Characters whose appearance is culturally established.', '{"term":"string","source":"film|tv|comics|anime|game|literature","visual_notes":"string","era_affinity":"string[]"}'),
('reference.game', 'reference', 'Game Reference', 'Game systems, mechanics, settings, item types. Visual elements drawn from game worlds and their distinctive aesthetic vocabularies.', '{"term":"string","type":"system|mechanic|setting|item|character_class","genre":"rpg|fps|strategy|platformer|survival|mmo","style_note":"string?"}');

-- Narrative group (new parent)
INSERT INTO categories (slug, parent, label, description, output_schema) VALUES
('narrative.scene', 'narrative', 'Scene Description', 'Scene descriptions combining multiple visual elements into a compositional concept. Phrases describing a moment or spatial relationship between elements.', '{"term":"string","element_count":"single|few|many","spatial":"foreground|midground|background|full_scene","time_of_day":"string?","mood_note":"string?"}'),
('narrative.mood', 'narrative', 'Mood Directive', 'Deliberate atmospheric intent as a compositional directive. Not single mood words but crafted atmospheric descriptions that guide the overall feel of an image.', '{"term":"string","intensity":"subtle|moderate|dramatic|overwhelming","sensory_channel":"visual|thermal|temporal|spatial","color_tendency":"string?"}');

-- Composition group (new parent)
INSERT INTO categories (slug, parent, label, description, output_schema) VALUES
('composition.rule', 'composition', 'Composition Rule', 'Compositional principles and framing rules. Rule of thirds, leading lines, negative space, symmetry. Structural guidelines for image arrangement.', '{"term":"string","type":"framing|balance|flow|depth|emphasis","complexity":"basic|intermediate|advanced","spatial_effect":"string?"}');

-- Effect group (new parent)
INSERT INTO categories (slug, parent, label, description, output_schema) VALUES
('effect.post', 'effect', 'Post Effect', 'Post-processing and optical effects. Film grain, chromatic aberration, bloom, vignette, lens flare, color grading. Applied after capture to alter the image.', '{"term":"string","type":"grain|aberration|blur|color|light_leak|distortion|tone","stage":"in-camera|darkroom|digital","intensity":"subtle|moderate|heavy"}');
