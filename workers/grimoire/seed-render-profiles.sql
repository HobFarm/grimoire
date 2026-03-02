-- Seed render profile collections and atoms for StyleFusion adaptive render system.
-- Run via: npx wrangler d1 execute grimoire-db --file=seed-render-profiles.sql --remote

-- ── Collections ─────────────────────────────────────────

INSERT OR IGNORE INTO collections (slug, name, description, parent_slug, created_at)
VALUES
  ('render', 'Render', 'Rendering mode profiles, grounding tokens, and anti-drift negatives', NULL, datetime('now')),
  ('render-profile-photographic', 'Photographic Render Profile', 'Camera/film rendering directives for photographic sources', 'render', datetime('now')),
  ('render-profile-cgi', 'CGI Render Profile', 'Engine/shader rendering directives for 3D/CGI sources', 'render', datetime('now')),
  ('render-profile-illustration', 'Illustration Render Profile', 'Linework/technique directives for illustration sources', 'render', datetime('now')),
  ('render-profile-painterly', 'Painterly Render Profile', 'Medium/substrate directives for painted sources', 'render', datetime('now')),
  ('render-imperfection', 'Render Imperfections', 'Grounding tokens per render mode that prevent uncanny perfection', 'render', datetime('now')),
  ('render-negative', 'Render Negatives', 'Anti-drift negatives per render mode', 'render', datetime('now'));

-- ── Photographic Render Profile Atoms ───────────────────
-- Paired encoding: text_lower is the match term, metadata.camera is the directive.
-- lookupGrimoire() in utils.ts splits on " -> " to find directive text.
-- The loader in grimoire-loader.ts encodes atoms with metadata.camera as "term -> camera".

INSERT OR IGNORE INTO atoms (id, text, text_lower, collection_slug, observation, status, confidence, encounter_count, tags, source, source_app, metadata, created_at, updated_at)
VALUES
  (hex(randomblob(8)), 'photorealistic', 'photorealistic', 'render-profile-photographic', 'observation',
   'confirmed', 1.0, 1, '[]', 'seed', 'stylefusion',
   '{"camera": "Shot on a high-resolution full-frame sensor with natural optical characteristics, capturing fine detail through precision glass"}',
   datetime('now'), datetime('now')),

  (hex(randomblob(8)), 'cinematic photograph', 'cinematic photograph', 'render-profile-photographic', 'observation',
   'confirmed', 1.0, 1, '[]', 'seed', 'stylefusion',
   '{"camera": "Captured with anamorphic glass producing organic lens breathing and filmic tonal rolloff with natural halation around bright sources"}',
   datetime('now'), datetime('now')),

  (hex(randomblob(8)), 'portrait photography', 'portrait photography', 'render-profile-photographic', 'observation',
   'confirmed', 1.0, 1, '[]', 'seed', 'stylefusion',
   '{"camera": "Shallow-focus portrait lens rendering with natural skin detail, selective sharpness, and creamy background separation"}',
   datetime('now'), datetime('now')),

  (hex(randomblob(8)), 'editorial photography', 'editorial photography', 'render-profile-photographic', 'observation',
   'confirmed', 1.0, 1, '[]', 'seed', 'stylefusion',
   '{"camera": "Editorial photograph with controlled studio lighting, precise color reproduction, and magazine-grade sharpness across the focal plane"}',
   datetime('now'), datetime('now')),

  (hex(randomblob(8)), 'street photography', 'street photography', 'render-profile-photographic', 'observation',
   'confirmed', 1.0, 1, '[]', 'seed', 'stylefusion',
   '{"camera": "Candid street capture with available-light exposure, natural grain structure, and environmental depth through a moderate wide-angle lens"}',
   datetime('now'), datetime('now'));

-- ── CGI Render Profile Atoms ────────────────────────────

INSERT OR IGNORE INTO atoms (id, text, text_lower, collection_slug, observation, status, confidence, encounter_count, tags, source, source_app, metadata, created_at, updated_at)
VALUES
  (hex(randomblob(8)), '3d render', '3d render', 'render-profile-cgi', 'observation',
   'confirmed', 1.0, 1, '[]', 'seed', 'stylefusion',
   '{"camera": "Constructed in a physically-based rendering engine with ray-traced global illumination, accurate light transport, and material-correct surface response"}',
   datetime('now'), datetime('now')),

  (hex(randomblob(8)), 'unreal engine', 'unreal engine', 'render-profile-cgi', 'observation',
   'confirmed', 1.0, 1, '[]', 'seed', 'stylefusion',
   '{"camera": "Real-time rendered with screen-space reflections, temporal anti-aliasing, subsurface scattering profiles, and dynamic global illumination"}',
   datetime('now'), datetime('now')),

  (hex(randomblob(8)), 'octane render', 'octane render', 'render-profile-cgi', 'observation',
   'confirmed', 1.0, 1, '[]', 'seed', 'stylefusion',
   '{"camera": "Path-traced with spectral rendering, physically accurate caustics, volumetric scattering, and HDR light response"}',
   datetime('now'), datetime('now'));

-- ── Illustration Render Profile Atoms ───────────────────

INSERT OR IGNORE INTO atoms (id, text, text_lower, collection_slug, observation, status, confidence, encounter_count, tags, source, source_app, metadata, created_at, updated_at)
VALUES
  (hex(randomblob(8)), 'digital illustration', 'digital illustration', 'render-profile-illustration', 'observation',
   'confirmed', 1.0, 1, '[]', 'seed', 'stylefusion',
   '{"camera": "Drawn with visible edge work, flat color fills transitioning through controlled gradients, and deliberate linework weight variation"}',
   datetime('now'), datetime('now')),

  (hex(randomblob(8)), 'anime', 'anime', 'render-profile-illustration', 'observation',
   'confirmed', 1.0, 1, '[]', 'seed', 'stylefusion',
   '{"camera": "Cel-shaded with clean uniform linework, simplified two-tone shadows, saturated flat color regions, and high-contrast rim lighting"}',
   datetime('now'), datetime('now')),

  (hex(randomblob(8)), 'concept art', 'concept art', 'render-profile-illustration', 'observation',
   'confirmed', 1.0, 1, '[]', 'seed', 'stylefusion',
   '{"camera": "Rendered with loose confident brush strokes, selective detail concentration on focal areas, and atmospheric perspective through value control"}',
   datetime('now'), datetime('now'));

-- ── Painterly Render Profile Atoms ──────────────────────

INSERT OR IGNORE INTO atoms (id, text, text_lower, collection_slug, observation, status, confidence, encounter_count, tags, source, source_app, metadata, created_at, updated_at)
VALUES
  (hex(randomblob(8)), 'oil painting', 'oil painting', 'render-profile-painterly', 'observation',
   'confirmed', 1.0, 1, '[]', 'seed', 'stylefusion',
   '{"camera": "Painted in oil with visible brushstroke direction, paint thickness variation across the surface, and luminous color mixing through layered glazes"}',
   datetime('now'), datetime('now')),

  (hex(randomblob(8)), 'watercolor', 'watercolor', 'render-profile-painterly', 'observation',
   'confirmed', 1.0, 1, '[]', 'seed', 'stylefusion',
   '{"camera": "Rendered in watercolor with wet-into-wet diffusion at edges, granulation in pigment-heavy areas, and paper texture visible through transparent washes"}',
   datetime('now'), datetime('now')),

  (hex(randomblob(8)), 'gouache', 'gouache', 'render-profile-painterly', 'observation',
   'confirmed', 1.0, 1, '[]', 'seed', 'stylefusion',
   '{"camera": "Painted in gouache with opaque flat color fields, crisp hard edges where wet paint meets dry, and subtle chalky surface texture"}',
   datetime('now'), datetime('now'));

-- ── Render Imperfection Atoms ───────────────────────────
-- Grounding tokens that prevent uncanny perfection per render mode.
-- Matched on the render mode name string.

INSERT OR IGNORE INTO atoms (id, text, text_lower, collection_slug, observation, status, confidence, encounter_count, tags, source, source_app, metadata, created_at, updated_at)
VALUES
  (hex(randomblob(8)), 'photographic', 'photographic', 'render-imperfection', 'observation',
   'confirmed', 1.0, 1, '[]', 'seed', 'stylefusion',
   '{"camera": "Subtle sensor noise in shadow regions, minor chromatic fringing at high-contrast edges, natural depth-of-field falloff with optical bokeh characteristics"}',
   datetime('now'), datetime('now')),

  (hex(randomblob(8)), 'cgi', 'cgi', 'render-imperfection', 'observation',
   'confirmed', 1.0, 1, '[]', 'seed', 'stylefusion',
   '{"camera": "Subsurface scattering hotspots at thin geometry, contact shadow density variation in crevices, ambient occlusion softening at surface junctions"}',
   datetime('now'), datetime('now')),

  (hex(randomblob(8)), 'illustration', 'illustration', 'render-imperfection', 'observation',
   'confirmed', 1.0, 1, '[]', 'seed', 'stylefusion',
   '{"camera": "Visible edge variation in linework weight, slight color bleed at boundary intersections, intentional paper or canvas texture showing through"}',
   datetime('now'), datetime('now')),

  (hex(randomblob(8)), 'painterly', 'painterly', 'render-imperfection', 'observation',
   'confirmed', 1.0, 1, '[]', 'seed', 'stylefusion',
   '{"camera": "Visible brushstroke direction following form, paint thickness variation between passages, substrate texture showing through thin areas"}',
   datetime('now'), datetime('now'));

-- ── Render Negative Atoms ───────────────────────────────
-- Anti-drift negatives per render mode. Prevent style drift away from detected mode.

INSERT OR IGNORE INTO atoms (id, text, text_lower, collection_slug, observation, status, confidence, encounter_count, tags, source, source_app, metadata, created_at, updated_at)
VALUES
  (hex(randomblob(8)), 'photographic negatives', 'photographic', 'render-negative', 'observation',
   'confirmed', 1.0, 1, '[]', 'seed', 'stylefusion',
   '{"camera": "CGI, 3D render, digital art, cartoon, plastic skin, overly smooth, airbrushed, uncanny valley, Octane, Unreal Engine, video game screenshot"}',
   datetime('now'), datetime('now')),

  (hex(randomblob(8)), 'cgi negatives', 'cgi', 'render-negative', 'observation',
   'confirmed', 1.0, 1, '[]', 'seed', 'stylefusion',
   '{"camera": "film grain, lens flare, motion blur, shallow depth of field, photographic noise, dust particles, lens distortion, chromatic aberration"}',
   datetime('now'), datetime('now')),

  (hex(randomblob(8)), 'illustration negatives', 'illustration', 'render-negative', 'observation',
   'confirmed', 1.0, 1, '[]', 'seed', 'stylefusion',
   '{"camera": "photorealistic, 3D render, film grain, subsurface scattering, ray tracing, sensor noise, lens artifacts, depth of field blur"}',
   datetime('now'), datetime('now')),

  (hex(randomblob(8)), 'painterly negatives', 'painterly', 'render-negative', 'observation',
   'confirmed', 1.0, 1, '[]', 'seed', 'stylefusion',
   '{"camera": "photorealistic, CGI, clean digital edges, vector art, digital smoothness, pixel-perfect lines, 3D render, airbrushed"}',
   datetime('now'), datetime('now'));
