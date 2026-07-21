ALTER TABLE module_progress RENAME TO module_progress_legacy;
CREATE TABLE module_progress (
  package_id TEXT NOT NULL,
  module_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('locked','available','preparing','learning','credited')),
  imported_vocab INTEGER NOT NULL DEFAULT 0,
  imported_functions_json TEXT NOT NULL DEFAULT '[]',
  imported_milestones_json TEXT NOT NULL DEFAULT '[]',
  attempted_milestones_json TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL,
  PRIMARY KEY(package_id, module_id)
);
INSERT INTO module_progress SELECT 'slowakisch-deutsch', module_id, status, imported_vocab, imported_functions_json, imported_milestones_json, attempted_milestones_json, updated_at FROM module_progress_legacy;
DROP TABLE module_progress_legacy;

ALTER TABLE generated_items RENAME TO generated_items_legacy;
CREATE TABLE generated_items (
  package_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  module_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  normalized_target TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  validation_status TEXT NOT NULL,
  anki_note_id INTEGER,
  created_at TEXT NOT NULL,
  PRIMARY KEY(package_id, item_id),
  UNIQUE(package_id, module_id, kind, normalized_target)
);
INSERT INTO generated_items SELECT 'slowakisch-deutsch', item_id, module_id, kind, normalized_slovak, payload_json, validation_status, anki_note_id, created_at FROM generated_items_legacy;
DROP TABLE generated_items_legacy;

ALTER TABLE session_plans ADD COLUMN package_id TEXT NOT NULL DEFAULT 'slowakisch-deutsch';
ALTER TABLE sessions ADD COLUMN package_id TEXT NOT NULL DEFAULT 'slowakisch-deutsch';
ALTER TABLE placement_sessions ADD COLUMN package_id TEXT NOT NULL DEFAULT 'slowakisch-deutsch';
ALTER TABLE jobs ADD COLUMN package_id TEXT NOT NULL DEFAULT 'slowakisch-deutsch';
ALTER TABLE quarantine ADD COLUMN package_id TEXT NOT NULL DEFAULT 'slowakisch-deutsch';
ALTER TABLE import_events ADD COLUMN package_id TEXT NOT NULL DEFAULT 'slowakisch-deutsch';
CREATE INDEX idx_placement_package_updated ON placement_sessions(package_id, updated_at DESC);
CREATE INDEX idx_jobs_package_updated ON jobs(package_id, updated_at DESC);
CREATE INDEX idx_sessions_package_status ON sessions(package_id, status);
