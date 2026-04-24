-- Pixel Art Arrangements: 8 arrangements spanning the full pixel art taxonomy.
-- Each context_key = slug for 1:1 mapping to category_contexts rows.

INSERT OR IGNORE INTO arrangements (slug, name, harmonics, category_weights, context_key, register, description) VALUES
('pixel-art', 'Pixel Art',
 '{"hardness":0.9,"temperature":0.3,"weight":0.4,"formality":0.6,"era_affinity":0.4}',
 '{"style.medium":2.5,"color.palette":2.0,"composition.rule":1.5,"style.genre":1.5,"lighting.source":1.0,"subject.expression":0.8}',
 'pixel-art', 0.45,
 'General pixel art: grid-locked raster graphics where every pixel is deliberate. Spans all eras and platforms.');

INSERT OR IGNORE INTO arrangements (slug, name, harmonics, category_weights, context_key, register, description) VALUES
('8bit-nes', '8-Bit NES',
 '{"hardness":1.0,"temperature":0.3,"weight":0.3,"formality":0.8,"era_affinity":0.2}',
 '{"style.medium":2.5,"color.palette":2.5,"composition.rule":1.8,"style.genre":1.5,"subject.expression":1.3,"lighting.source":0.8}',
 '8bit-nes', 0.40,
 'NES constraints: 52 colors, 3+1 per sprite palette, 8x8 tiles, silhouette-first design. Canonical games: SMB3, Mega Man, Castlevania.');

INSERT OR IGNORE INTO arrangements (slug, name, harmonics, category_weights, context_key, register, description) VALUES
('16bit-snes', '16-Bit SNES',
 '{"hardness":0.9,"temperature":0.5,"weight":0.4,"formality":0.7,"era_affinity":0.3}',
 '{"style.medium":2.5,"color.palette":2.0,"style.genre":1.8,"composition.rule":1.5,"lighting.source":1.3,"environment.atmosphere":1.2}',
 '16bit-snes', 0.45,
 'SNES visual range: 256 on-screen from 32K palette, Mode 7 rotation, multi-layer parallax. Canonical: Chrono Trigger, FF6, Super Metroid.');

INSERT OR IGNORE INTO arrangements (slug, name, harmonics, category_weights, context_key, register, description) VALUES
('16bit-genesis', '16-Bit Genesis',
 '{"hardness":0.9,"temperature":0.3,"weight":0.5,"formality":0.7,"era_affinity":0.3}',
 '{"style.medium":2.5,"color.palette":2.0,"style.genre":1.8,"composition.rule":1.5,"lighting.source":1.3,"environment.setting":1.2}',
 '16bit-genesis', 0.45,
 'Genesis/Mega Drive VDP: 512 palette, 61 on-screen, highlight/shadow mode, blast processing speed. Canonical: Sonic, Streets of Rage, Gunstar Heroes.');

INSERT OR IGNORE INTO arrangements (slug, name, harmonics, category_weights, context_key, register, description) VALUES
('demoscene', 'Demoscene',
 '{"hardness":0.8,"temperature":0.3,"weight":0.5,"formality":0.5,"era_affinity":0.2}',
 '{"style.medium":2.0,"style.genre":2.0,"color.palette":1.8,"composition.rule":1.5,"effect.post":1.5,"reference.technique":1.3}',
 'demoscene', 0.50,
 'Competition-driven pixel art from Amiga/C64/Atari ST scenes. Photorealism push within hardware limits, cracktro aesthetics, dithering mastery.');

INSERT OR IGNORE INTO arrangements (slug, name, harmonics, category_weights, context_key, register, description) VALUES
('neo-retro', 'Neo-Retro',
 '{"hardness":0.8,"temperature":0.5,"weight":0.3,"formality":0.5,"era_affinity":0.7}',
 '{"style.medium":2.0,"style.genre":1.8,"color.palette":1.8,"composition.rule":1.5,"environment.atmosphere":1.3,"lighting.source":1.2}',
 'neo-retro', 0.40,
 'Modern games with self-imposed retro constraints plus modern conveniences. Shovel Knight, Celeste, Hyper Light Drifter approach.');

INSERT OR IGNORE INTO arrangements (slug, name, harmonics, category_weights, context_key, register, description) VALUES
('pixel-illustration', 'Pixel Illustration',
 '{"hardness":0.7,"temperature":0.4,"weight":0.5,"formality":0.6,"era_affinity":0.6}',
 '{"style.medium":2.0,"composition.rule":1.8,"style.genre":1.5,"color.palette":1.5,"environment.setting":1.5,"environment.prop":1.3}',
 'pixel-illustration', 0.55,
 'Large-canvas pixel art for commercial and editorial use. eBoy isometric cities, Superbrothers, advertising and poster work.');

INSERT OR IGNORE INTO arrangements (slug, name, harmonics, category_weights, context_key, register, description) VALUES
('pixel-dolls', 'Pixel Dolls',
 '{"hardness":0.7,"temperature":0.6,"weight":0.2,"formality":0.3,"era_affinity":0.5}',
 '{"covering.clothing":2.0,"covering.accessory":2.0,"subject.hair":1.8,"covering.footwear":1.5,"subject.expression":1.5,"color.palette":1.3}',
 'pixel-dolls', 0.30,
 'Character design and dress-up pixel art. Adoptable lineage, dollmaker community, intricate clothing and accessory detail.');
