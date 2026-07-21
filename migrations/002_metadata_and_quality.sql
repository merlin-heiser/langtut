CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS curriculum_versions (
  version TEXT PRIMARY KEY,
  source_hash TEXT NOT NULL,
  activated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS error_clusters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tag TEXT NOT NULL,
  occurrences INTEGER NOT NULL DEFAULT 1,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS anki_imports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT,
  module_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  anki_note_id INTEGER,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(item_id, status)
);
