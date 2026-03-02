-- Seed 17 arrangements for StyleFusion conductor auto-snap.
-- Each arrangement defines a harmonic profile (5-axis) and category weights
-- that influence atom selection during compilation.
-- context_key maps to existing category_contexts rows for per-category guidance.

INSERT OR REPLACE INTO arrangements (slug, name, harmonics, category_weights, context_key) VALUES

-- Core HobFarm identity: Art Deco architecture, hard key lighting, three palettes
('atomic-noir', 'Atomic Noir',
 '{"hardness":"hard","temperature":"cool","weight":"heavy","formality":"structured","era_affinity":"industrial"}',
 '{"environment.setting":2.0,"lighting.source":1.8,"color.palette":1.8,"style.genre":1.5,"style.medium":1.5,"environment.atmosphere":1.3,"covering.clothing":1.0,"subject.expression":0.8}',
 'atomic-noir'),

-- Fashion/beauty: strong structure, cool lighting, modern styling
('editorial-portrait', 'Editorial Portrait',
 '{"hardness":"hard","temperature":"cool","weight":"heavy","formality":"structured","era_affinity":"modern"}',
 '{"camera.shot":1.8,"covering.clothing":1.8,"lighting.source":1.5,"style.medium":1.3,"subject.expression":1.3,"color.palette":1.2,"pose.position":1.2}',
 'default'),

-- Documentary/street: raw energy, warm tones, loose framing
('street-candid', 'Street Candid',
 '{"hardness":"hard","temperature":"warm","weight":"light","formality":"organic","era_affinity":"modern"}',
 '{"environment.setting":1.8,"lighting.source":1.5,"camera.shot":1.3,"environment.atmosphere":1.3,"pose.position":1.2,"style.medium":1.0,"covering.clothing":0.8}',
 'default'),

-- Film noir: chiaroscuro, hard shadows, monochrome leanings
('noir-cinematic', 'Noir Cinematic',
 '{"hardness":"hard","temperature":"cool","weight":"heavy","formality":"structured","era_affinity":"industrial"}',
 '{"lighting.source":2.0,"environment.atmosphere":1.8,"style.genre":1.5,"style.medium":1.5,"color.palette":1.3,"environment.setting":1.2,"covering.clothing":0.8,"subject.expression":0.7}',
 'noir'),

-- Natural light: warm glow, soft focus, gentle weight
('golden-hour', 'Golden Hour',
 '{"hardness":"soft","temperature":"warm","weight":"light","formality":"organic","era_affinity":"timeless"}',
 '{"lighting.source":2.0,"color.palette":1.5,"environment.atmosphere":1.5,"environment.setting":1.3,"subject.expression":1.2,"style.medium":1.0,"covering.clothing":0.8}',
 'default'),

-- Product/headshot: clean lighting, controlled everything
('studio-commercial', 'Studio Commercial',
 '{"hardness":"hard","temperature":"neutral","weight":"heavy","formality":"structured","era_affinity":"modern"}',
 '{"lighting.source":1.8,"camera.shot":1.5,"camera.lens":1.5,"style.medium":1.3,"color.palette":1.2,"subject.form":1.2,"covering.clothing":1.0}',
 'default'),

-- Otherworldly: soft glow, floaty fabrics, mythological
('ethereal-fantasy', 'Ethereal Fantasy',
 '{"hardness":"soft","temperature":"cool","weight":"light","formality":"organic","era_affinity":"archaic"}',
 '{"style.genre":1.8,"environment.atmosphere":1.8,"lighting.source":1.5,"color.palette":1.5,"covering.clothing":1.3,"environment.setting":1.3,"subject.expression":1.0}',
 'fantasy'),

-- Industrial decay: neon, concrete, street culture
('gritty-urban', 'Gritty Urban',
 '{"hardness":"hard","temperature":"warm","weight":"heavy","formality":"organic","era_affinity":"industrial"}',
 '{"environment.setting":1.8,"environment.atmosphere":1.8,"lighting.source":1.5,"style.genre":1.3,"color.palette":1.3,"covering.clothing":1.2,"subject.expression":0.8}',
 'cyberpunk'),

-- Nature: florals, earthy palettes, diffused light
('botanical-natural', 'Botanical Natural',
 '{"hardness":"soft","temperature":"warm","weight":"light","formality":"organic","era_affinity":"timeless"}',
 '{"environment.setting":1.8,"color.palette":1.5,"environment.atmosphere":1.5,"lighting.source":1.3,"covering.material":1.3,"style.medium":1.0,"subject.expression":0.8}',
 'default'),

-- Film grain: vintage processing, 70s/80s palette
('retro-analog', 'Retro Analog',
 '{"hardness":"soft","temperature":"warm","weight":"heavy","formality":"structured","era_affinity":"industrial"}',
 '{"style.medium":1.8,"color.palette":1.8,"style.genre":1.5,"lighting.source":1.3,"covering.clothing":1.3,"camera.lens":1.2,"environment.setting":1.0}',
 'default'),

-- Clean geometry: negative space, monochrome accent
('minimalist-modern', 'Minimalist Modern',
 '{"hardness":"hard","temperature":"cool","weight":"light","formality":"structured","era_affinity":"modern"}',
 '{"environment.setting":1.8,"color.palette":1.5,"lighting.source":1.5,"camera.shot":1.3,"style.medium":1.3,"subject.form":1.0,"covering.clothing":0.8}',
 'default'),

-- Rich textures: gilt, dramatic drapery, candlelight
('baroque-ornate', 'Baroque Ornate',
 '{"hardness":"soft","temperature":"warm","weight":"heavy","formality":"structured","era_affinity":"archaic"}',
 '{"covering.material":1.8,"covering.clothing":1.8,"lighting.source":1.5,"color.palette":1.5,"environment.setting":1.3,"style.genre":1.3,"environment.prop":1.2}',
 'art-deco'),

-- Neon saturation: chrome, synthetic materials, tech
('cyberpunk-neon', 'Cyberpunk Neon',
 '{"hardness":"hard","temperature":"cool","weight":"heavy","formality":"organic","era_affinity":"modern"}',
 '{"color.palette":1.8,"lighting.source":1.8,"environment.atmosphere":1.5,"environment.setting":1.5,"style.genre":1.5,"covering.material":1.3,"subject.expression":0.8}',
 'cyberpunk'),

-- Painterly: translucent washes, paper texture, gentle
('watercolor-soft', 'Watercolor Soft',
 '{"hardness":"soft","temperature":"warm","weight":"light","formality":"organic","era_affinity":"timeless"}',
 '{"style.medium":2.0,"style.genre":1.5,"color.palette":1.5,"covering.material":1.3,"environment.atmosphere":1.2,"lighting.source":1.0,"subject.expression":0.8}',
 'default'),

-- Raw concrete: geometric mass, stark, imposing
('brutalist-concrete', 'Brutalist Concrete',
 '{"hardness":"hard","temperature":"cool","weight":"heavy","formality":"structured","era_affinity":"industrial"}',
 '{"environment.setting":2.0,"environment.atmosphere":1.5,"lighting.source":1.5,"style.medium":1.3,"color.palette":1.2,"covering.material":1.2,"subject.expression":0.7}',
 'default'),

-- Linen, wildflowers, natural dye, handcraft, rustic
('cottagecore-pastoral', 'Cottagecore Pastoral',
 '{"hardness":"soft","temperature":"warm","weight":"light","formality":"organic","era_affinity":"archaic"}',
 '{"environment.setting":1.8,"covering.material":1.8,"covering.clothing":1.5,"color.palette":1.5,"environment.prop":1.3,"lighting.source":1.2,"environment.atmosphere":1.2}',
 'default'),

-- Reflective surfaces: clean tech, specular highlights
('chrome-futurism', 'Chrome Futurism',
 '{"hardness":"hard","temperature":"cool","weight":"light","formality":"structured","era_affinity":"modern"}',
 '{"covering.material":1.8,"lighting.source":1.8,"style.medium":1.5,"color.palette":1.3,"environment.setting":1.3,"style.genre":1.2,"camera.lens":1.2}',
 'cyberpunk');
