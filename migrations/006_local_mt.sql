ALTER TABLE translation_cache ADD COLUMN provider TEXT;
ALTER TABLE translation_cache ADD COLUMN model_id TEXT;
ALTER TABLE translation_cache ADD COLUMN model_revision TEXT;
ALTER TABLE translation_cache ADD COLUMN source_language_code TEXT;
ALTER TABLE translation_cache ADD COLUMN context_hash TEXT;
ALTER TABLE translation_cache ADD COLUMN translation_mode TEXT CHECK(translation_mode IN ('direct','pivot'));
ALTER TABLE translation_cache ADD COLUMN model_license TEXT;

ALTER TABLE translation_cache RENAME TO translation_cache_legacy;
CREATE TABLE translation_cache (
  sense_id TEXT NOT NULL REFERENCES lexicon_senses(id), language_code TEXT NOT NULL, translation TEXT NOT NULL,
  example_target TEXT, example_source TEXT, notes TEXT,
  origin TEXT NOT NULL CHECK(origin IN ('dictionary','concept','llm','local_mt','native')),
  status TEXT NOT NULL CHECK(status IN ('approved','pending_verification','rejected')),
  confidence REAL NOT NULL DEFAULT 1 CHECK(confidence >= 0 AND confidence <= 1), updated_at TEXT NOT NULL,
  provider TEXT, model_id TEXT, model_revision TEXT, source_language_code TEXT, context_hash TEXT,
  translation_mode TEXT CHECK(translation_mode IN ('direct','pivot')), model_license TEXT,
  PRIMARY KEY(sense_id, language_code)
);
INSERT INTO translation_cache SELECT * FROM translation_cache_legacy;
DROP TABLE translation_cache_legacy;

CREATE TABLE local_mt_installations (
  key TEXT PRIMARY KEY,
  model_id TEXT NOT NULL,
  revision TEXT NOT NULL,
  license TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  installed_path TEXT,
  status TEXT NOT NULL CHECK(status IN ('not_installed','installing','installed','failed')),
  error TEXT,
  updated_at TEXT NOT NULL
);
