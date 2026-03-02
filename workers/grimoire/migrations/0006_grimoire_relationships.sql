-- ============================================================
-- Migration 0006: Grimoire Relationships
-- Creates: correspondences, incantations, incantation_slots, exemplars
-- Seeds 8 visual incantation templates derived from exemplar files
-- ============================================================

-- Atom-to-atom typed relationships
CREATE TABLE correspondences (
  id TEXT PRIMARY KEY,
  atom_a_id TEXT NOT NULL REFERENCES atoms(id),
  atom_b_id TEXT NOT NULL REFERENCES atoms(id),
  relationship_type TEXT NOT NULL CHECK(relationship_type IN ('resonates','opposes','requires','substitutes','evokes')),
  strength REAL NOT NULL DEFAULT 0.5,
  provenance TEXT NOT NULL CHECK(provenance IN ('harmonic','semantic','exemplar','co_occurrence')),
  arrangement_scope TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_corr_atom_a ON correspondences(atom_a_id);
CREATE INDEX idx_corr_atom_b ON correspondences(atom_b_id);
CREATE INDEX idx_corr_type ON correspondences(relationship_type);
CREATE INDEX idx_corr_provenance ON correspondences(provenance);
CREATE INDEX idx_corr_scope ON correspondences(arrangement_scope);
CREATE UNIQUE INDEX idx_corr_pair ON correspondences(atom_a_id, atom_b_id, relationship_type, arrangement_scope);

-- Prompt/narrative templates
CREATE TABLE incantations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  description TEXT,
  modality TEXT NOT NULL DEFAULT 'visual' CHECK(modality IN ('visual','narrative','both')),
  genre TEXT,
  template_text TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_incantations_modality ON incantations(modality);
CREATE INDEX idx_incantations_genre ON incantations(genre);

-- Typed slots within templates
CREATE TABLE incantation_slots (
  id TEXT PRIMARY KEY,
  incantation_id TEXT NOT NULL REFERENCES incantations(id) ON DELETE CASCADE,
  slot_name TEXT NOT NULL,
  category_filter TEXT,
  required INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_slots_incantation ON incantation_slots(incantation_id);
CREATE UNIQUE INDEX idx_slots_unique ON incantation_slots(incantation_id, slot_name);

-- Proven atom fills for specific slots
CREATE TABLE exemplars (
  id TEXT PRIMARY KEY,
  incantation_id TEXT NOT NULL REFERENCES incantations(id) ON DELETE CASCADE,
  slot_name TEXT NOT NULL,
  atom_id TEXT NOT NULL REFERENCES atoms(id),
  frequency INTEGER NOT NULL DEFAULT 1,
  source_file TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_exemplars_incantation ON exemplars(incantation_id);
CREATE INDEX idx_exemplars_atom ON exemplars(atom_id);
CREATE INDEX idx_exemplars_slot ON exemplars(incantation_id, slot_name);

-- ============================================================
-- Seed 8 visual incantation templates
-- ============================================================

-- 1. character-portrait (physical_appearance_image.txt)
-- Pattern: archetype, height, build, face, skin, hair, eyes, nose, lips, chin, hair-length, hair-texture, hairstyle, earring-type, lip-color, lip-finish, scene
INSERT INTO incantations (id, name, slug, description, modality, genre, template_text) VALUES (
  'inc_character_portrait',
  'Character Portrait',
  'character-portrait',
  'Base character portrait with physical features and a scene context. Derived from physical_appearance_image.txt.',
  'visual',
  NULL,
  '{archetype}, {height}, {build}, {face_shape}, {skin_tone}, {hair_color}, {eye_color}, {nose}, {lips}, {chin}, {hair_length}, {hair_texture}, {hairstyle}, {earring_type}, {lip_color}, {lip_finish}, {scene}'
);

-- 2. historical-portrait (fine_art_female_image.txt)
-- Pattern: style, mood, artist, trait, technique, substyle1, substyle2, substyle3, archetype, ..., outfit
INSERT INTO incantations (id, name, slug, description, modality, genre, template_text) VALUES (
  'inc_historical_portrait',
  'Historical Portrait',
  'historical-portrait',
  'Fine art portrait with artist reference, style layers, and outfit. Derived from fine_art_female_image.txt.',
  'visual',
  NULL,
  '{style}, {mood}, {artist}, {trait}, {technique}, {substyle}, {archetype}, {height}, {build}, {face_shape}, {skin_tone}, {hair_color}, {eye_color}, {nose}, {lips}, {chin}, {hair_length}, {hair_texture}, {hairstyle}, {earring_type}, {lip_color}, {lip_finish}, {outfit}'
);

-- 3. scifi-portrait (scifi_outfit_image.txt)
-- Pattern: scifi-outfit, archetype, ..., setting
INSERT INTO incantations (id, name, slug, description, modality, genre, template_text) VALUES (
  'inc_scifi_portrait',
  'Sci-Fi Portrait',
  'scifi-portrait',
  'Futuristic character portrait with sci-fi outfit and setting. Derived from scifi_outfit_image.txt.',
  'visual',
  'scifi',
  '{scifi_outfit}, {archetype}, {height}, {build}, {face_shape}, {skin_tone}, {hair_color}, {eye_color}, {nose}, {lips}, {chin}, {hair_length}, {hair_texture}, {hairstyle}, {earring_type}, {lip_color}, {lip_finish}, {setting}'
);

-- 4. surrealistic-portrait (surrealistic_portrait_image.txt)
-- Pattern: "portrait", surreal-setting, archetype, ..., art-style
INSERT INTO incantations (id, name, slug, description, modality, genre, template_text) VALUES (
  'inc_surrealistic_portrait',
  'Surrealistic Portrait',
  'surrealistic-portrait',
  'Portrait set in a surreal dreamscape with art style finish. Derived from surrealistic_portrait_image.txt.',
  'visual',
  'surreal',
  'portrait, {surreal_setting}, {archetype}, {height}, {build}, {face_shape}, {skin_tone}, {hair_color}, {eye_color}, {nose}, {lips}, {chin}, {hair_length}, {hair_texture}, {hairstyle}, {earring_type}, {lip_color}, {lip_finish}, {art_style}'
);

-- 5. master-composition (master_composition_image.txt)
-- Pattern: quality-prefix, (character block), style, mood, pose1, pose2, color-scheme, effect1, effect2
INSERT INTO incantations (id, name, slug, description, modality, genre, template_text) VALUES (
  'inc_master_composition',
  'Master Composition',
  'master-composition',
  'Full compositional portrait with quality prefix, style, mood, poses, color theory, and effects. Derived from master_composition_image.txt.',
  'visual',
  NULL,
  '{quality_prefix}, ({archetype}, {height}, {build}, {face_shape}, {skin_tone}, {hair_color}, {eye_color}, {nose}, {lips}, {chin}, {hair_length}, {hair_texture}, {hairstyle}, {earring_type}, {lip_color}, {lip_finish}), {art_style}, {mood}, {pose}, {color_scheme}, {effect}'
);

-- 6. armor-portrait (masterpiece_medieval_armor_portrait_image.txt)
-- Pattern: quality-prefix, armor-type, archetype, ..., setting
INSERT INTO incantations (id, name, slug, description, modality, genre, template_text) VALUES (
  'inc_armor_portrait',
  'Armor Portrait',
  'armor-portrait',
  'Medieval armor portrait with quality prefix and epic setting. Derived from masterpiece_medieval_armor_portrait_image.txt.',
  'visual',
  'medieval',
  '{quality_prefix}, {armor_type}, {archetype}, {height}, {build}, {face_shape}, {skin_tone}, {hair_color}, {eye_color}, {nose}, {lips}, {chin}, {hair_length}, {hair_texture}, {hairstyle}, {earring_type}, {lip_color}, {lip_finish}, {setting}'
);

-- 7. hobby-portrait (hobby_activity_portrait_image.txt)
-- Pattern: "portrait", activity, archetype, ...
INSERT INTO incantations (id, name, slug, description, modality, genre, template_text) VALUES (
  'inc_hobby_portrait',
  'Hobby Portrait',
  'hobby-portrait',
  'Character portrait engaged in a hobby or activity. Derived from hobby_activity_portrait_image.txt.',
  'visual',
  NULL,
  'portrait, {activity}, {archetype}, {height}, {build}, {face_shape}, {skin_tone}, {hair_color}, {eye_color}, {nose}, {lips}, {chin}, {hair_length}, {hair_texture}, {hairstyle}, {earring_type}, {lip_color}, {lip_finish}'
);

-- 8. accessory-portrait (accessory_combination_image.txt)
-- Pattern: material, accessory, archetype, ..., outfit
INSERT INTO incantations (id, name, slug, description, modality, genre, template_text) VALUES (
  'inc_accessory_portrait',
  'Accessory Portrait',
  'accessory-portrait',
  'Portrait showcasing accessory and material combinations with outfit. Derived from accessory_combination_image.txt.',
  'visual',
  NULL,
  '{material}, {accessory}, {archetype}, {height}, {build}, {face_shape}, {skin_tone}, {hair_color}, {eye_color}, {nose}, {lips}, {chin}, {hair_length}, {hair_texture}, {hairstyle}, {earring_type}, {lip_color}, {lip_finish}, {outfit}'
);

-- ============================================================
-- Seed incantation slots
-- Shared character slots appear in all 8 templates (sort_order 100-260)
-- Template-specific slots use lower sort_order (prefix) or higher (suffix)
-- ============================================================

-- Helper: shared character slot block (used by all templates)
-- These get inserted per-template with the incantation_id

-- 1. character-portrait slots
INSERT INTO incantation_slots (id, incantation_id, slot_name, category_filter, required, sort_order) VALUES
  ('slot_cp_archetype',    'inc_character_portrait', 'archetype',    'reference.character', 1, 100),
  ('slot_cp_height',       'inc_character_portrait', 'height',       'subject.form',        1, 110),
  ('slot_cp_build',        'inc_character_portrait', 'build',        'subject.form',        1, 120),
  ('slot_cp_face_shape',   'inc_character_portrait', 'face_shape',   'subject.face',        1, 130),
  ('slot_cp_skin_tone',    'inc_character_portrait', 'skin_tone',    'subject.feature',     1, 140),
  ('slot_cp_hair_color',   'inc_character_portrait', 'hair_color',   'subject.hair',        1, 150),
  ('slot_cp_eye_color',    'inc_character_portrait', 'eye_color',    'subject.feature',     1, 160),
  ('slot_cp_nose',         'inc_character_portrait', 'nose',         'subject.face',        1, 170),
  ('slot_cp_lips',         'inc_character_portrait', 'lips',         'subject.face',        1, 180),
  ('slot_cp_chin',         'inc_character_portrait', 'chin',         'subject.face',        1, 190),
  ('slot_cp_hair_length',  'inc_character_portrait', 'hair_length',  'subject.hair',        1, 200),
  ('slot_cp_hair_texture', 'inc_character_portrait', 'hair_texture', 'subject.hair',        1, 210),
  ('slot_cp_hairstyle',    'inc_character_portrait', 'hairstyle',    'subject.hair',        1, 220),
  ('slot_cp_earring_type', 'inc_character_portrait', 'earring_type', 'covering.accessory',  1, 230),
  ('slot_cp_lip_color',    'inc_character_portrait', 'lip_color',    'color.palette',       1, 240),
  ('slot_cp_lip_finish',   'inc_character_portrait', 'lip_finish',   'style.medium',        1, 250),
  ('slot_cp_scene',        'inc_character_portrait', 'scene',        'environment.setting',  1, 300);

-- 2. historical-portrait slots
INSERT INTO incantation_slots (id, incantation_id, slot_name, category_filter, required, sort_order) VALUES
  ('slot_hp_style',        'inc_historical_portrait', 'style',        'style.medium',        1, 10),
  ('slot_hp_mood',         'inc_historical_portrait', 'mood',         'narrative.mood',      1, 20),
  ('slot_hp_artist',       'inc_historical_portrait', 'artist',       'reference.person',    1, 30),
  ('slot_hp_trait',        'inc_historical_portrait', 'trait',        'subject.expression',  1, 40),
  ('slot_hp_technique',    'inc_historical_portrait', 'technique',    'reference.technique', 0, 50),
  ('slot_hp_substyle',     'inc_historical_portrait', 'substyle',     'style.genre',         0, 60),
  ('slot_hp_archetype',    'inc_historical_portrait', 'archetype',    'reference.character', 1, 100),
  ('slot_hp_height',       'inc_historical_portrait', 'height',       'subject.form',        1, 110),
  ('slot_hp_build',        'inc_historical_portrait', 'build',        'subject.form',        1, 120),
  ('slot_hp_face_shape',   'inc_historical_portrait', 'face_shape',   'subject.face',        1, 130),
  ('slot_hp_skin_tone',    'inc_historical_portrait', 'skin_tone',    'subject.feature',     1, 140),
  ('slot_hp_hair_color',   'inc_historical_portrait', 'hair_color',   'subject.hair',        1, 150),
  ('slot_hp_eye_color',    'inc_historical_portrait', 'eye_color',    'subject.feature',     1, 160),
  ('slot_hp_nose',         'inc_historical_portrait', 'nose',         'subject.face',        1, 170),
  ('slot_hp_lips',         'inc_historical_portrait', 'lips',         'subject.face',        1, 180),
  ('slot_hp_chin',         'inc_historical_portrait', 'chin',         'subject.face',        1, 190),
  ('slot_hp_hair_length',  'inc_historical_portrait', 'hair_length',  'subject.hair',        1, 200),
  ('slot_hp_hair_texture', 'inc_historical_portrait', 'hair_texture', 'subject.hair',        1, 210),
  ('slot_hp_hairstyle',    'inc_historical_portrait', 'hairstyle',    'subject.hair',        1, 220),
  ('slot_hp_earring_type', 'inc_historical_portrait', 'earring_type', 'covering.accessory',  1, 230),
  ('slot_hp_lip_color',    'inc_historical_portrait', 'lip_color',    'color.palette',       1, 240),
  ('slot_hp_lip_finish',   'inc_historical_portrait', 'lip_finish',   'style.medium',        1, 250),
  ('slot_hp_outfit',       'inc_historical_portrait', 'outfit',       'covering.outfit',     1, 300);

-- 3. scifi-portrait slots
INSERT INTO incantation_slots (id, incantation_id, slot_name, category_filter, required, sort_order) VALUES
  ('slot_sp_scifi_outfit', 'inc_scifi_portrait', 'scifi_outfit',  'covering.outfit',     1, 10),
  ('slot_sp_archetype',    'inc_scifi_portrait', 'archetype',     'reference.character', 1, 100),
  ('slot_sp_height',       'inc_scifi_portrait', 'height',        'subject.form',        1, 110),
  ('slot_sp_build',        'inc_scifi_portrait', 'build',         'subject.form',        1, 120),
  ('slot_sp_face_shape',   'inc_scifi_portrait', 'face_shape',    'subject.face',        1, 130),
  ('slot_sp_skin_tone',    'inc_scifi_portrait', 'skin_tone',     'subject.feature',     1, 140),
  ('slot_sp_hair_color',   'inc_scifi_portrait', 'hair_color',    'subject.hair',        1, 150),
  ('slot_sp_eye_color',    'inc_scifi_portrait', 'eye_color',     'subject.feature',     1, 160),
  ('slot_sp_nose',         'inc_scifi_portrait', 'nose',          'subject.face',        1, 170),
  ('slot_sp_lips',         'inc_scifi_portrait', 'lips',          'subject.face',        1, 180),
  ('slot_sp_chin',         'inc_scifi_portrait', 'chin',          'subject.face',        1, 190),
  ('slot_sp_hair_length',  'inc_scifi_portrait', 'hair_length',   'subject.hair',        1, 200),
  ('slot_sp_hair_texture', 'inc_scifi_portrait', 'hair_texture',  'subject.hair',        1, 210),
  ('slot_sp_hairstyle',    'inc_scifi_portrait', 'hairstyle',     'subject.hair',        1, 220),
  ('slot_sp_earring_type', 'inc_scifi_portrait', 'earring_type',  'covering.accessory',  1, 230),
  ('slot_sp_lip_color',    'inc_scifi_portrait', 'lip_color',     'color.palette',       1, 240),
  ('slot_sp_lip_finish',   'inc_scifi_portrait', 'lip_finish',    'style.medium',        1, 250),
  ('slot_sp_setting',      'inc_scifi_portrait', 'setting',       'environment.setting', 1, 300);

-- 4. surrealistic-portrait slots
INSERT INTO incantation_slots (id, incantation_id, slot_name, category_filter, required, sort_order) VALUES
  ('slot_sur_setting',      'inc_surrealistic_portrait', 'surreal_setting', 'environment.setting', 1, 10),
  ('slot_sur_archetype',    'inc_surrealistic_portrait', 'archetype',       'reference.character', 1, 100),
  ('slot_sur_height',       'inc_surrealistic_portrait', 'height',          'subject.form',        1, 110),
  ('slot_sur_build',        'inc_surrealistic_portrait', 'build',           'subject.form',        1, 120),
  ('slot_sur_face_shape',   'inc_surrealistic_portrait', 'face_shape',      'subject.face',        1, 130),
  ('slot_sur_skin_tone',    'inc_surrealistic_portrait', 'skin_tone',       'subject.feature',     1, 140),
  ('slot_sur_hair_color',   'inc_surrealistic_portrait', 'hair_color',      'subject.hair',        1, 150),
  ('slot_sur_eye_color',    'inc_surrealistic_portrait', 'eye_color',       'subject.feature',     1, 160),
  ('slot_sur_nose',         'inc_surrealistic_portrait', 'nose',            'subject.face',        1, 170),
  ('slot_sur_lips',         'inc_surrealistic_portrait', 'lips',            'subject.face',        1, 180),
  ('slot_sur_chin',         'inc_surrealistic_portrait', 'chin',            'subject.face',        1, 190),
  ('slot_sur_hair_length',  'inc_surrealistic_portrait', 'hair_length',     'subject.hair',        1, 200),
  ('slot_sur_hair_texture', 'inc_surrealistic_portrait', 'hair_texture',    'subject.hair',        1, 210),
  ('slot_sur_hairstyle',    'inc_surrealistic_portrait', 'hairstyle',       'subject.hair',        1, 220),
  ('slot_sur_earring_type', 'inc_surrealistic_portrait', 'earring_type',    'covering.accessory',  1, 230),
  ('slot_sur_lip_color',    'inc_surrealistic_portrait', 'lip_color',       'color.palette',       1, 240),
  ('slot_sur_lip_finish',   'inc_surrealistic_portrait', 'lip_finish',      'style.medium',        1, 250),
  ('slot_sur_art_style',    'inc_surrealistic_portrait', 'art_style',       'style.genre',         1, 300);

-- 5. master-composition slots
INSERT INTO incantation_slots (id, incantation_id, slot_name, category_filter, required, sort_order) VALUES
  ('slot_mc_quality',      'inc_master_composition', 'quality_prefix', 'effect.post',         1, 10),
  ('slot_mc_archetype',    'inc_master_composition', 'archetype',      'reference.character', 1, 100),
  ('slot_mc_height',       'inc_master_composition', 'height',         'subject.form',        1, 110),
  ('slot_mc_build',        'inc_master_composition', 'build',          'subject.form',        1, 120),
  ('slot_mc_face_shape',   'inc_master_composition', 'face_shape',     'subject.face',        1, 130),
  ('slot_mc_skin_tone',    'inc_master_composition', 'skin_tone',      'subject.feature',     1, 140),
  ('slot_mc_hair_color',   'inc_master_composition', 'hair_color',     'subject.hair',        1, 150),
  ('slot_mc_eye_color',    'inc_master_composition', 'eye_color',      'subject.feature',     1, 160),
  ('slot_mc_nose',         'inc_master_composition', 'nose',           'subject.face',        1, 170),
  ('slot_mc_lips',         'inc_master_composition', 'lips',           'subject.face',        1, 180),
  ('slot_mc_chin',         'inc_master_composition', 'chin',           'subject.face',        1, 190),
  ('slot_mc_hair_length',  'inc_master_composition', 'hair_length',    'subject.hair',        1, 200),
  ('slot_mc_hair_texture', 'inc_master_composition', 'hair_texture',   'subject.hair',        1, 210),
  ('slot_mc_hairstyle',    'inc_master_composition', 'hairstyle',      'subject.hair',        1, 220),
  ('slot_mc_earring_type', 'inc_master_composition', 'earring_type',   'covering.accessory',  1, 230),
  ('slot_mc_lip_color',    'inc_master_composition', 'lip_color',      'color.palette',       1, 240),
  ('slot_mc_lip_finish',   'inc_master_composition', 'lip_finish',     'style.medium',        1, 250),
  ('slot_mc_art_style',    'inc_master_composition', 'art_style',      'style.genre',         1, 300),
  ('slot_mc_mood',         'inc_master_composition', 'mood',           'narrative.mood',      1, 310),
  ('slot_mc_pose',         'inc_master_composition', 'pose',           'pose.position',       1, 320),
  ('slot_mc_color_scheme', 'inc_master_composition', 'color_scheme',   'color.palette',       0, 330),
  ('slot_mc_effect',       'inc_master_composition', 'effect',         'effect.post',         0, 340);

-- 6. armor-portrait slots
INSERT INTO incantation_slots (id, incantation_id, slot_name, category_filter, required, sort_order) VALUES
  ('slot_ap_quality',      'inc_armor_portrait', 'quality_prefix', 'effect.post',         1, 10),
  ('slot_ap_armor_type',   'inc_armor_portrait', 'armor_type',     'covering.outfit',     1, 20),
  ('slot_ap_archetype',    'inc_armor_portrait', 'archetype',      'reference.character', 1, 100),
  ('slot_ap_height',       'inc_armor_portrait', 'height',         'subject.form',        1, 110),
  ('slot_ap_build',        'inc_armor_portrait', 'build',          'subject.form',        1, 120),
  ('slot_ap_face_shape',   'inc_armor_portrait', 'face_shape',     'subject.face',        1, 130),
  ('slot_ap_skin_tone',    'inc_armor_portrait', 'skin_tone',      'subject.feature',     1, 140),
  ('slot_ap_hair_color',   'inc_armor_portrait', 'hair_color',     'subject.hair',        1, 150),
  ('slot_ap_eye_color',    'inc_armor_portrait', 'eye_color',      'subject.feature',     1, 160),
  ('slot_ap_nose',         'inc_armor_portrait', 'nose',           'subject.face',        1, 170),
  ('slot_ap_lips',         'inc_armor_portrait', 'lips',           'subject.face',        1, 180),
  ('slot_ap_chin',         'inc_armor_portrait', 'chin',           'subject.face',        1, 190),
  ('slot_ap_hair_length',  'inc_armor_portrait', 'hair_length',    'subject.hair',        1, 200),
  ('slot_ap_hair_texture', 'inc_armor_portrait', 'hair_texture',   'subject.hair',        1, 210),
  ('slot_ap_hairstyle',    'inc_armor_portrait', 'hairstyle',      'subject.hair',        1, 220),
  ('slot_ap_earring_type', 'inc_armor_portrait', 'earring_type',   'covering.accessory',  1, 230),
  ('slot_ap_lip_color',    'inc_armor_portrait', 'lip_color',      'color.palette',       1, 240),
  ('slot_ap_lip_finish',   'inc_armor_portrait', 'lip_finish',     'style.medium',        1, 250),
  ('slot_ap_setting',      'inc_armor_portrait', 'setting',        'environment.setting', 1, 300);

-- 7. hobby-portrait slots
INSERT INTO incantation_slots (id, incantation_id, slot_name, category_filter, required, sort_order) VALUES
  ('slot_hob_activity',     'inc_hobby_portrait', 'activity',      'pose.interaction',    1, 10),
  ('slot_hob_archetype',    'inc_hobby_portrait', 'archetype',     'reference.character', 1, 100),
  ('slot_hob_height',       'inc_hobby_portrait', 'height',        'subject.form',        1, 110),
  ('slot_hob_build',        'inc_hobby_portrait', 'build',         'subject.form',        1, 120),
  ('slot_hob_face_shape',   'inc_hobby_portrait', 'face_shape',    'subject.face',        1, 130),
  ('slot_hob_skin_tone',    'inc_hobby_portrait', 'skin_tone',     'subject.feature',     1, 140),
  ('slot_hob_hair_color',   'inc_hobby_portrait', 'hair_color',    'subject.hair',        1, 150),
  ('slot_hob_eye_color',    'inc_hobby_portrait', 'eye_color',     'subject.feature',     1, 160),
  ('slot_hob_nose',         'inc_hobby_portrait', 'nose',          'subject.face',        1, 170),
  ('slot_hob_lips',         'inc_hobby_portrait', 'lips',          'subject.face',        1, 180),
  ('slot_hob_chin',         'inc_hobby_portrait', 'chin',          'subject.face',        1, 190),
  ('slot_hob_hair_length',  'inc_hobby_portrait', 'hair_length',   'subject.hair',        1, 200),
  ('slot_hob_hair_texture', 'inc_hobby_portrait', 'hair_texture',  'subject.hair',        1, 210),
  ('slot_hob_hairstyle',    'inc_hobby_portrait', 'hairstyle',     'subject.hair',        1, 220),
  ('slot_hob_earring_type', 'inc_hobby_portrait', 'earring_type',  'covering.accessory',  1, 230),
  ('slot_hob_lip_color',    'inc_hobby_portrait', 'lip_color',     'color.palette',       1, 240),
  ('slot_hob_lip_finish',   'inc_hobby_portrait', 'lip_finish',    'style.medium',        1, 250);

-- 8. accessory-portrait slots
INSERT INTO incantation_slots (id, incantation_id, slot_name, category_filter, required, sort_order) VALUES
  ('slot_acc_material',     'inc_accessory_portrait', 'material',     'covering.material',  1, 10),
  ('slot_acc_accessory',    'inc_accessory_portrait', 'accessory',    'covering.accessory', 1, 20),
  ('slot_acc_archetype',    'inc_accessory_portrait', 'archetype',    'reference.character', 1, 100),
  ('slot_acc_height',       'inc_accessory_portrait', 'height',       'subject.form',        1, 110),
  ('slot_acc_build',        'inc_accessory_portrait', 'build',        'subject.form',        1, 120),
  ('slot_acc_face_shape',   'inc_accessory_portrait', 'face_shape',   'subject.face',        1, 130),
  ('slot_acc_skin_tone',    'inc_accessory_portrait', 'skin_tone',    'subject.feature',     1, 140),
  ('slot_acc_hair_color',   'inc_accessory_portrait', 'hair_color',   'subject.hair',        1, 150),
  ('slot_acc_eye_color',    'inc_accessory_portrait', 'eye_color',    'subject.feature',     1, 160),
  ('slot_acc_nose',         'inc_accessory_portrait', 'nose',         'subject.face',        1, 170),
  ('slot_acc_lips',         'inc_accessory_portrait', 'lips',         'subject.face',        1, 180),
  ('slot_acc_chin',         'inc_accessory_portrait', 'chin',         'subject.face',        1, 190),
  ('slot_acc_hair_length',  'inc_accessory_portrait', 'hair_length',  'subject.hair',        1, 200),
  ('slot_acc_hair_texture', 'inc_accessory_portrait', 'hair_texture', 'subject.hair',        1, 210),
  ('slot_acc_hairstyle',    'inc_accessory_portrait', 'hairstyle',    'subject.hair',        1, 220),
  ('slot_acc_earring_type', 'inc_accessory_portrait', 'earring_type', 'covering.accessory',  1, 230),
  ('slot_acc_lip_color',    'inc_accessory_portrait', 'lip_color',    'color.palette',       1, 240),
  ('slot_acc_lip_finish',   'inc_accessory_portrait', 'lip_finish',   'style.medium',        1, 250),
  ('slot_acc_outfit',       'inc_accessory_portrait', 'outfit',       'covering.outfit',     1, 300);
