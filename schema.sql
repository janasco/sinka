-- D1 schema for Sinka (Option 1: Containers + D1).
-- Replaces data/seen.json (Message-IDs already replicated).
CREATE TABLE IF NOT EXISTS seen (
  id TEXT PRIMARY KEY,
  seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_seen_at ON seen(seen_at);
