import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { LexiconAiResolution, LexiconMaterializations } from "@langtut/contracts";
import { loadLearningPackage } from "@langtut/domain";
import { Store } from "../apps/api/src/database.js";
import { LexiconService } from "../apps/api/src/lexicon.js";
import { selectLocalMtModels, type LocalMtGateway, type LocalMtModel, type LocalMtTranslation } from "../apps/api/src/local-mt.js";
import type { ModelGateway } from "../apps/api/src/providers.js";

let temporary: string | undefined;
afterEach(async () => { if (temporary) await rm(temporary, { recursive: true, force: true }); temporary = undefined; });

describe("lazy lexicon", () => {
  it("imports a licensed JSONL catalog idempotently", async () => {
    temporary = await mkdtemp(path.join(tmpdir(), "langtut-lexicon-import-"));
    const dbPath = path.join(temporary, "catalog.db"); const store = await Store.open(dbPath, process.cwd()); store.close();
    const input = path.join(temporary, "catalog.jsonl");
    await writeFile(input, [
      { type: "source", id: "fixture", name: "Fixture", version: "1", license: "CC0", redistributable: true },
      { type: "sense", id: "fixture:ahoj", sourceId: "fixture", externalId: "ahoj", languageCode: "sk", lemma: "Ahoj", pos: "interjection", qualityStatus: "approved" },
      { type: "translation", senseId: "fixture:ahoj", languageCode: "de", translation: "Hallo", origin: "dictionary", status: "approved", confidence: 1 },
    ].map((row) => JSON.stringify(row)).join("\n"), "utf8");
    const run = promisify(execFile); const script = path.join(process.cwd(), "scripts", "import-lexicon.mjs");
    await run(process.execPath, [script, dbPath, input]); await run(process.execPath, [script, dbPath, input]);
    const imported = await Store.open(dbPath, process.cwd());
    expect(imported.lookupLexicon("ahoj", "sk", "de")).toMatchObject([{ senseId: "fixture:ahoj", translation: "Hallo" }]);
    imported.close();
  });

  it("resolves an inflected form entirely from the local cache", async () => {
    const { store, pkg, models } = await fixture();
    seedSense(store, { id: "greet", lemma: "ahoj", form: "ahojte", translation: "hallo" });
    const localMt = new FakeLocalMt(localResult("Hallo"));
    const service = new LexiconService(store, models, pkg, localMt);
    const result = await service.lookup({ text: "Ahojte, ako sa máte?", surface: "Ahojte", targetLanguageCode: "sk", sourceLanguageCode: "de" });
    expect(result).toMatchObject({ status: "resolved", candidates: [{ senseId: "greet", lemma: "ahoj", translation: "hallo", morphology: { mood: "imperative" } }] });
    expect(models.calls).toEqual([]);
    expect(localMt.calls).toEqual([]);
    store.close();
  });

  it("uses and labels a contextual model fallback only without a local result", async () => {
    const { store, service, models } = await fixture({ lemma: "ísť", pos: "verb", translation: "gehen", confidence: 0.72 });
    const result = await service.lookup({ text: "Musím ísť.", surface: "ísť", targetLanguageCode: "sk", sourceLanguageCode: "de" });
    expect(result).toMatchObject({ status: "ai_resolved", candidates: [{ lemma: "ísť", translation: "gehen", origin: "llm" }] });
    expect(models.calls).toEqual(["lexicon_resolution"]);
    store.close();
  });

  it("draws complete cached material without invoking a model and records the seed", async () => {
    const { store, service, pkg, models } = await fixture();
    seedSense(store, { id: "family", lemma: "rodina", translation: "Familie", exampleTarget: "Moja rodina je veľká.", exampleSource: "Meine Familie ist groß.", notes: "Alltagswort" });
    const module = pkg.curriculum.modules[0];
    const items = await service.materializeForModule(module, 1, "stable-seed");
    expect(items).toMatchObject([{ itemId: "lexicon:family", target: "rodina", source: "Familie", moduleId: module.id }]);
    expect(models.calls).toEqual([]);
    expect(store.db.prepare("SELECT seed,status FROM module_lexicon_selections WHERE sense_id='family'").get()).toEqual({ seed: "stable-seed", status: "selected" });
    store.close();
  });

  it("materializes only the selected incomplete entry and caches the result", async () => {
    const materialized: LexiconMaterializations = { items: [{ senseId: "coffee", translation: "Kaffee", exampleTarget: "Prosím si kávu.", exampleSource: "Ich hätte gern einen Kaffee.", notes: "Getränk", confidence: 0.9 }] };
    const { store, service, pkg, models } = await fixture(materialized);
    seedSense(store, { id: "coffee", lemma: "káva" });
    const items = await service.materializeForModule(pkg.curriculum.modules[0], 1, "coffee-seed");
    expect(items[0]).toMatchObject({ target: "káva", source: "Kaffee", exampleTarget: "Prosím si kávu." });
    expect(models.calls).toEqual(["lexicon_materialization"]);
    expect(store.db.prepare("SELECT translation,status FROM translation_cache WHERE sense_id='coffee'").get()).toEqual({ translation: "Kaffee", status: "pending_verification" });
    store.close();
  });

  it("uses a local MT candidate for one unique untranslated sense and preserves provenance", async () => {
    const { store, pkg, models } = await fixture();
    seedSense(store, { id: "local-coffee", lemma: "káva" });
    const localMt = new FakeLocalMt(localResult("Kaffee"));
    const service = new LexiconService(store, models, pkg, localMt);
    const result = await service.lookup({ text: "Káva je dobrá.", surface: "káva", targetLanguageCode: "sk", sourceLanguageCode: "de" });
    expect(result).toMatchObject({ status: "local_mt_candidate", candidates: [{ senseId: "local-coffee", translation: "Kaffee", origin: "local_mt" }] });
    expect(models.calls).toEqual([]);
    expect(localMt.calls).toHaveLength(1);
    expect(store.db.prepare("SELECT origin,status,provider,model_id,model_revision,model_license,source_language_code,context_hash,translation_mode FROM translation_cache WHERE sense_id='local-coffee'").get()).toMatchObject({
      origin: "local_mt", status: "pending_verification", provider: "local_mt", model_id: "facebook/m2m100_418M", model_revision: "revision", model_license: "MIT", source_language_code: "sk", translation_mode: "direct",
    });
    expect(store.exportJsonl()).toContain('"model_license":"MIT"');
    store.close();
  });

  it("falls back to contextual cloud resolution when local MT fails", async () => {
    const ai: LexiconAiResolution = { senseId: "walk", lemma: "ísť", pos: "verb", translation: "gehen", confidence: 0.8 };
    const { store, pkg, models } = await fixture(ai);
    seedSense(store, { id: "walk", lemma: "ísť" });
    const localMt = new FakeLocalMt(undefined, true);
    const service = new LexiconService(store, models, pkg, localMt);
    const result = await service.lookup({ text: "Musím ísť.", surface: "ísť", targetLanguageCode: "sk", sourceLanguageCode: "de" });
    expect(result.status).toBe("ai_resolved");
    expect(models.calls).toEqual(["lexicon_resolution"]);
    store.close();
  });

  it("does not let isolated local MT resolve an ambiguous lemma", async () => {
    const ai: LexiconAiResolution = { senseId: "bank-finance", lemma: "banka", pos: "noun", translation: "Bank", confidence: 0.8 };
    const { store, pkg, models } = await fixture(ai);
    seedSense(store, { id: "bank-finance", lemma: "banka" }); seedSense(store, { id: "bank-seat", lemma: "banka" });
    const localMt = new FakeLocalMt(localResult("Bank"));
    const service = new LexiconService(store, models, pkg, localMt);
    await service.lookup({ text: "Banka je otvorená.", surface: "banka", targetLanguageCode: "sk", sourceLanguageCode: "de" });
    expect(localMt.calls).toEqual([]);
    expect(models.calls).toEqual(["lexicon_resolution"]);
    store.close();
  });

  it("prefers installed direct Marian and otherwise selects M2M100", () => {
    const marian = model("marian-sk-de", "marian", 100, ["sk"], ["de"]);
    const m2m = model("m2m100-418m", "m2m100", 10, ["*"], ["*"]);
    expect(selectLocalMtModels([m2m, marian], new Set([m2m.key, marian.key]), "sk", "de").map(({ key }) => key)).toEqual([marian.key, m2m.key]);
    expect(selectLocalMtModels([m2m, marian], new Set([m2m.key]), "sk", "de").map(({ key }) => key)).toEqual([m2m.key]);
  });
});

async function fixture(response?: LexiconAiResolution | LexiconMaterializations) {
  temporary = await mkdtemp(path.join(tmpdir(), "langtut-lexicon-"));
  const store = await Store.open(path.join(temporary, "test.db"), process.cwd());
  const pkg = await loadLearningPackage(path.join(process.cwd(), "learning-packages", "slowakisch-deutsch"));
  const models = new LexiconModels(response);
  return { store, pkg, models, service: new LexiconService(store, models, pkg) };
}

class LexiconModels implements ModelGateway {
  calls: string[] = [];
  constructor(private readonly response?: LexiconAiResolution | LexiconMaterializations) {}
  status() { return {}; }
  async structured<T>(taskId: string): Promise<T> { this.calls.push(taskId); if (!this.response) throw new Error("unexpected model call"); return this.response as T; }
}

class FakeLocalMt implements LocalMtGateway {
  calls: Array<{ text: string; sourceLanguage: string; targetLanguage: string }> = [];
  constructor(private readonly result?: LocalMtTranslation, private readonly fail = false) {}
  async translate(input: { text: string; sourceLanguage: string; targetLanguage: string }) {
    this.calls.push(input); if (this.fail) throw new Error("local model failed"); return this.result;
  }
  settings() { return { enabled: true, cloudFallback: true }; }
}

function localResult(translation: string): LocalMtTranslation {
  return { translation, sourceLanguage: "sk", targetLanguage: "de", modelKey: "m2m100-418m", modelId: "facebook/m2m100_418M", modelRevision: "revision", license: "MIT", confidence: 0.58, mode: "direct" };
}

function model(key: string, family: "marian" | "m2m100", priority: number, source_languages: string[], target_languages: string[]): LocalMtModel {
  return { key, family, priority, source_languages, target_languages, model_id: key, revision: "revision", license: "MIT", size_bytes: 1 };
}

function seedSense(store: Store, value: { id: string; lemma: string; form?: string; translation?: string; exampleTarget?: string; exampleSource?: string; notes?: string }) {
  const now = new Date().toISOString();
  store.db.prepare("INSERT OR IGNORE INTO lexicon_sources(id,name,version,license,redistributable,imported_at) VALUES ('test','Test','1','CC0',1,?)").run(now);
  store.db.prepare(`INSERT INTO lexicon_senses(id,source_id,external_id,language_code,lemma,normalized_lemma,pos,quality_status,provenance_json,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(value.id, "test", value.id, "sk", value.lemma, value.lemma.toLocaleLowerCase(), "noun", "approved", "{}", now);
  if (value.form) store.db.prepare("INSERT INTO lexicon_forms(sense_id,form,normalized_form,morphology_json) VALUES (?,?,?,?)").run(value.id, value.form, value.form.toLocaleLowerCase(), JSON.stringify({ mood: "imperative" }));
  if (value.translation) store.cacheLexiconTranslation(value.id, "de", { translation: value.translation, exampleTarget: value.exampleTarget, exampleSource: value.exampleSource, notes: value.notes, origin: "dictionary", status: "approved", confidence: 0.95 });
}
