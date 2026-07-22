CREATE TABLE lexicon_sources (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  source_url TEXT,
  license TEXT NOT NULL,
  redistributable INTEGER NOT NULL CHECK(redistributable IN (0,1)),
  checksum TEXT,
  imported_at TEXT NOT NULL
);

CREATE TABLE lexicon_categories (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES lexicon_sources(id),
  external_id TEXT NOT NULL,
  parent_id TEXT REFERENCES lexicon_categories(id),
  label TEXT NOT NULL,
  description TEXT,
  UNIQUE(source_id, external_id)
);

CREATE TABLE category_localizations (
  category_id TEXT NOT NULL REFERENCES lexicon_categories(id),
  language_code TEXT NOT NULL,
  label TEXT NOT NULL,
  description TEXT,
  PRIMARY KEY(category_id, language_code)
);

CREATE TABLE module_category_mappings (
  package_id TEXT NOT NULL,
  module_id TEXT NOT NULL,
  category_id TEXT NOT NULL REFERENCES lexicon_categories(id),
  curriculum_tag TEXT NOT NULL,
  weight REAL NOT NULL DEFAULT 1 CHECK(weight >= 0),
  PRIMARY KEY(package_id, module_id, category_id, curriculum_tag)
);

CREATE TABLE lexicon_senses (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES lexicon_sources(id),
  external_id TEXT,
  concept_id TEXT,
  language_code TEXT NOT NULL,
  lemma TEXT NOT NULL,
  normalized_lemma TEXT NOT NULL,
  pos TEXT NOT NULL,
  gloss TEXT,
  cefr TEXT,
  frequency REAL,
  frequency_rank INTEGER,
  quality_status TEXT NOT NULL CHECK(quality_status IN ('approved','pending','rejected')),
  provenance_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  UNIQUE(source_id, external_id)
);
CREATE INDEX idx_lexicon_senses_lookup ON lexicon_senses(language_code, normalized_lemma);
CREATE INDEX idx_lexicon_senses_draw ON lexicon_senses(language_code, quality_status, frequency_rank);

CREATE TABLE lexicon_forms (
  sense_id TEXT NOT NULL REFERENCES lexicon_senses(id),
  form TEXT NOT NULL,
  normalized_form TEXT NOT NULL,
  morphology_json TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY(sense_id, normalized_form)
);
CREATE INDEX idx_lexicon_forms_lookup ON lexicon_forms(normalized_form);

CREATE TABLE sense_categories (
  sense_id TEXT NOT NULL REFERENCES lexicon_senses(id),
  category_id TEXT NOT NULL REFERENCES lexicon_categories(id),
  confidence REAL NOT NULL DEFAULT 1 CHECK(confidence >= 0 AND confidence <= 1),
  PRIMARY KEY(sense_id, category_id)
);

CREATE TABLE translation_cache (
  sense_id TEXT NOT NULL REFERENCES lexicon_senses(id),
  language_code TEXT NOT NULL,
  translation TEXT NOT NULL,
  example_target TEXT,
  example_source TEXT,
  notes TEXT,
  origin TEXT NOT NULL CHECK(origin IN ('dictionary','concept','llm','local_mt','native')),
  status TEXT NOT NULL CHECK(status IN ('approved','pending_verification','rejected')),
  confidence REAL NOT NULL DEFAULT 1 CHECK(confidence >= 0 AND confidence <= 1),
  updated_at TEXT NOT NULL,
  PRIMARY KEY(sense_id, language_code)
);

CREATE TABLE module_lexicon_selections (
  package_id TEXT NOT NULL,
  module_id TEXT NOT NULL,
  sense_id TEXT NOT NULL REFERENCES lexicon_senses(id),
  score REAL NOT NULL,
  seed TEXT NOT NULL,
  reasons_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('selected','materialized','imported','rejected')),
  created_at TEXT NOT NULL,
  PRIMARY KEY(package_id, module_id, sense_id)
);

CREATE TABLE lexicon_staging (
  id TEXT PRIMARY KEY,
  package_id TEXT NOT NULL,
  session_id TEXT,
  language_code TEXT NOT NULL,
  source_language_code TEXT NOT NULL,
  surface TEXT NOT NULL,
  lemma TEXT NOT NULL,
  pos TEXT NOT NULL,
  translation TEXT NOT NULL,
  context TEXT,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_lexicon_staging_package_status ON lexicon_staging(package_id, status);
