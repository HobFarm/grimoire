-- Add separate column for arrangement tagger output.
-- Existing `tags` column stays for user-supplied tags (MCP ingest).
-- arrangement_tags stores [{slug, dist}] JSON from top-N scoring.
ALTER TABLE atoms ADD COLUMN arrangement_tags TEXT NOT NULL DEFAULT '[]';
