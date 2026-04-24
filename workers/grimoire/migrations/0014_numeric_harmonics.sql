-- Phase 1: Convert string harmonics to numeric 0.0-1.0
-- Mapping: soft/cool/light/organic=0.2, neutral/medium=0.5, hard/warm/heavy/structured=0.8
-- era_affinity: timeless=0.25, archaic=0.4, industrial=0.65, modern=0.85
--
-- Applied 2026-03-03 via batched wrangler d1 execute (LIMIT 10000 x 16 batches).
-- json_type() in WHERE clause caused D1 "malformed JSON" errors at scale.
-- LIKE guard used instead: harmonics LIKE '%"hardness":"_%' matches string values.
-- This file records what was applied. Already tracked in d1_migrations.

-- Atom harmonics: batched at LIMIT 10000, repeated until 0 rows match
UPDATE atoms SET harmonics = json_object(
  'hardness', CASE json_extract(harmonics, '$.hardness')
    WHEN 'soft' THEN 0.2 WHEN 'hard' THEN 0.8 WHEN 'neutral' THEN 0.5 ELSE 0.5 END,
  'temperature', CASE json_extract(harmonics, '$.temperature')
    WHEN 'cool' THEN 0.2 WHEN 'warm' THEN 0.8 WHEN 'neutral' THEN 0.5 ELSE 0.5 END,
  'weight', CASE json_extract(harmonics, '$.weight')
    WHEN 'light' THEN 0.2 WHEN 'heavy' THEN 0.8 WHEN 'neutral' THEN 0.5 WHEN 'medium' THEN 0.5 ELSE 0.5 END,
  'formality', CASE json_extract(harmonics, '$.formality')
    WHEN 'organic' THEN 0.2 WHEN 'structured' THEN 0.8 WHEN 'neutral' THEN 0.5 ELSE 0.5 END,
  'era_affinity', CASE json_extract(harmonics, '$.era_affinity')
    WHEN 'timeless' THEN 0.25 WHEN 'archaic' THEN 0.4 WHEN 'industrial' THEN 0.65 WHEN 'modern' THEN 0.85 ELSE 0.5 END
)
WHERE LENGTH(harmonics) > 10
  AND harmonics LIKE '%"hardness":"_%'
  AND rowid IN (SELECT rowid FROM atoms WHERE LENGTH(harmonics) > 10 AND harmonics LIKE '%"hardness":"_%' LIMIT 10000);

-- Arrangement harmonics (28 rows)
UPDATE arrangements SET harmonics = json_object(
  'hardness', CASE json_extract(harmonics, '$.hardness')
    WHEN 'soft' THEN 0.2 WHEN 'hard' THEN 0.8 WHEN 'neutral' THEN 0.5 ELSE 0.5 END,
  'temperature', CASE json_extract(harmonics, '$.temperature')
    WHEN 'cool' THEN 0.2 WHEN 'warm' THEN 0.8 WHEN 'neutral' THEN 0.5 ELSE 0.5 END,
  'weight', CASE json_extract(harmonics, '$.weight')
    WHEN 'light' THEN 0.2 WHEN 'heavy' THEN 0.8 WHEN 'neutral' THEN 0.5 WHEN 'medium' THEN 0.5 ELSE 0.5 END,
  'formality', CASE json_extract(harmonics, '$.formality')
    WHEN 'organic' THEN 0.2 WHEN 'structured' THEN 0.8 WHEN 'neutral' THEN 0.5 ELSE 0.5 END,
  'era_affinity', CASE json_extract(harmonics, '$.era_affinity')
    WHEN 'timeless' THEN 0.25 WHEN 'archaic' THEN 0.4 WHEN 'industrial' THEN 0.65 WHEN 'modern' THEN 0.85 ELSE 0.5 END
)
WHERE harmonics LIKE '%"hardness":"_%';

-- Reset tags for re-scoring with new numeric distance function
UPDATE atoms SET tag_version = 0, tags = '[]' WHERE tag_version > 0;
