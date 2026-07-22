import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";
import Database from "better-sqlite3";

const [dbArg, inputArg, ...flags] = process.argv.slice(2);
if (!dbArg || !inputArg) throw new Error("Usage: npm run lexicon:import -- <database.sqlite> <catalog.jsonl> [--allow-local-restricted]");
const dbPath = path.resolve(dbArg); const inputPath = path.resolve(inputArg);
const allowRestricted = flags.includes("--allow-local-restricted");
const db = new Database(dbPath); db.pragma("foreign_keys = ON");
if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='lexicon_sources'").get()) throw new Error("Database must be opened by Langtut once so migration 005 is applied");

const statements = {
  source: db.prepare(`INSERT INTO lexicon_sources(id,name,version,source_url,license,redistributable,checksum,imported_at) VALUES (@id,@name,@version,@sourceUrl,@license,@redistributable,@checksum,@importedAt)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name,version=excluded.version,source_url=excluded.source_url,license=excluded.license,redistributable=excluded.redistributable,checksum=excluded.checksum,imported_at=excluded.imported_at`),
  category: db.prepare(`INSERT INTO lexicon_categories(id,source_id,external_id,parent_id,label,description) VALUES (@id,@sourceId,@externalId,@parentId,@label,@description)
    ON CONFLICT(id) DO UPDATE SET parent_id=excluded.parent_id,label=excluded.label,description=excluded.description`),
  localization: db.prepare(`INSERT INTO category_localizations(category_id,language_code,label,description) VALUES (@categoryId,@languageCode,@label,@description)
    ON CONFLICT(category_id,language_code) DO UPDATE SET label=excluded.label,description=excluded.description`),
  mapping: db.prepare(`INSERT INTO module_category_mappings(package_id,module_id,category_id,curriculum_tag,weight) VALUES (@packageId,@moduleId,@categoryId,@curriculumTag,@weight)
    ON CONFLICT(package_id,module_id,category_id,curriculum_tag) DO UPDATE SET weight=excluded.weight`),
  sense: db.prepare(`INSERT INTO lexicon_senses(id,source_id,external_id,concept_id,language_code,lemma,normalized_lemma,pos,gloss,cefr,frequency,frequency_rank,quality_status,provenance_json,created_at)
    VALUES (@id,@sourceId,@externalId,@conceptId,@languageCode,@lemma,@normalizedLemma,@pos,@gloss,@cefr,@frequency,@frequencyRank,@qualityStatus,@provenanceJson,@createdAt)
    ON CONFLICT(id) DO UPDATE SET concept_id=excluded.concept_id,lemma=excluded.lemma,normalized_lemma=excluded.normalized_lemma,pos=excluded.pos,gloss=excluded.gloss,cefr=excluded.cefr,frequency=excluded.frequency,frequency_rank=excluded.frequency_rank,quality_status=excluded.quality_status,provenance_json=excluded.provenance_json`),
  form: db.prepare(`INSERT INTO lexicon_forms(sense_id,form,normalized_form,morphology_json) VALUES (@senseId,@form,@normalizedForm,@morphologyJson)
    ON CONFLICT(sense_id,normalized_form) DO UPDATE SET form=excluded.form,morphology_json=excluded.morphology_json`),
  senseCategory: db.prepare(`INSERT INTO sense_categories(sense_id,category_id,confidence) VALUES (@senseId,@categoryId,@confidence)
    ON CONFLICT(sense_id,category_id) DO UPDATE SET confidence=excluded.confidence`),
  translation: db.prepare(`INSERT INTO translation_cache(sense_id,language_code,translation,example_target,example_source,notes,origin,status,confidence,updated_at)
    VALUES (@senseId,@languageCode,@translation,@exampleTarget,@exampleSource,@notes,@origin,@status,@confidence,@updatedAt)
    ON CONFLICT(sense_id,language_code) DO UPDATE SET translation=excluded.translation,example_target=excluded.example_target,example_source=excluded.example_source,notes=excluded.notes,origin=excluded.origin,status=excluded.status,confidence=excluded.confidence,updated_at=excluded.updated_at`),
};

const rows = []; const reader = createInterface({ input: createReadStream(inputPath, "utf8"), crlfDelay: Infinity });
for await (const line of reader) if (line.trim()) rows.push(JSON.parse(line));
const importedAt = new Date().toISOString();
db.transaction(() => {
  for (const row of rows) {
    const statement = statements[row.type]; if (!statement) throw new Error(`Unknown record type: ${row.type}`);
    const value = normalizeRecord(row, importedAt);
    if (row.type === "source" && !value.redistributable && !allowRestricted) throw new Error(`Source ${value.id} is not redistributable; pass --allow-local-restricted only for a private local database`);
    statement.run(value);
  }
})();
db.close();
console.log(`Imported ${rows.length} lexicon records into ${dbPath}`);

function normalizeRecord(row, now) {
  const nullable = (value) => value ?? null;
  if (row.type === "source") return { ...row, sourceUrl: nullable(row.sourceUrl), redistributable: row.redistributable ? 1 : 0, checksum: nullable(row.checksum), importedAt: row.importedAt ?? now };
  if (row.type === "category") return { ...row, parentId: nullable(row.parentId), description: nullable(row.description) };
  if (row.type === "localization") return { ...row, description: nullable(row.description) };
  if (row.type === "mapping") return { ...row, weight: row.weight ?? 1 };
  if (row.type === "sense") return { ...row, externalId: nullable(row.externalId), conceptId: nullable(row.conceptId), normalizedLemma: normalize(row.lemma), gloss: nullable(row.gloss), cefr: nullable(row.cefr), frequency: nullable(row.frequency), frequencyRank: nullable(row.frequencyRank), qualityStatus: row.qualityStatus ?? "approved", provenanceJson: JSON.stringify(row.provenance ?? {}), createdAt: row.createdAt ?? now };
  if (row.type === "form") return { ...row, normalizedForm: normalize(row.form), morphologyJson: JSON.stringify(row.morphology ?? {}) };
  if (row.type === "senseCategory") return { ...row, confidence: row.confidence ?? 1 };
  if (row.type === "translation") return { ...row, exampleTarget: nullable(row.exampleTarget), exampleSource: nullable(row.exampleSource), notes: nullable(row.notes), origin: row.origin ?? "dictionary", status: row.status ?? "approved", confidence: row.confidence ?? 1, updatedAt: row.updatedAt ?? now };
  return row;
}
function normalize(value) { return value.normalize("NFC").trim().toLocaleLowerCase().replace(/^[^\p{L}\p{M}\d]+|[^\p{L}\p{M}\d]+$/gu, ""); }
