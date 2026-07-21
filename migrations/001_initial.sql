CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS module_progress (
  module_id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK(status IN ('locked','available','preparing','learning','credited')),
  imported_vocab INTEGER NOT NULL DEFAULT 0,
  imported_functions_json TEXT NOT NULL DEFAULT '[]',
  imported_milestones_json TEXT NOT NULL DEFAULT '[]',
  attempted_milestones_json TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS session_plans (
  id TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  plan_id TEXT,
  module_id TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS session_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS session_events_no_update
BEFORE UPDATE ON session_events BEGIN SELECT RAISE(ABORT, 'session_events are append-only'); END;
CREATE TRIGGER IF NOT EXISTS session_events_no_delete
BEFORE DELETE ON session_events BEGIN SELECT RAISE(ABORT, 'session_events are append-only'); END;

CREATE TABLE IF NOT EXISTS placement_sessions (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  module_id TEXT,
  status TEXT NOT NULL,
  progress REAL NOT NULL,
  message TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS generated_items (
  item_id TEXT PRIMARY KEY,
  module_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  normalized_slovak TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  validation_status TEXT NOT NULL,
  anki_note_id INTEGER,
  created_at TEXT NOT NULL,
  UNIQUE(module_id, kind, normalized_slovak)
);

CREATE TABLE IF NOT EXISTS quarantine (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id TEXT NOT NULL,
  module_id TEXT NOT NULL,
  issues_json TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS import_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id TEXT NOT NULL,
  action TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS import_events_no_update
BEFORE UPDATE ON import_events BEGIN SELECT RAISE(ABORT, 'import_events are append-only'); END;
CREATE TRIGGER IF NOT EXISTS import_events_no_delete
BEFORE DELETE ON import_events BEGIN SELECT RAISE(ABORT, 'import_events are append-only'); END;
