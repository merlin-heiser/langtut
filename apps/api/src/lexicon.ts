import { createHash } from "node:crypto";
import type {
  CandidateItem, CurriculumModule, LexiconAiResolution, LexiconLookupRequest, LexiconLookupResult,
  LexiconMaterializations, LexiconSenseCandidate,
} from "@langtut/contracts";
import type { LoadedLearningPackage } from "@langtut/domain";
import type { Store, LexiconDrawRow } from "./database.js";
import type { LocalMtGateway, LocalMtTranslation } from "./local-mt.js";
import type { ModelGateway } from "./providers.js";

export class LexiconService {
  constructor(private readonly store: Store, private readonly models: ModelGateway, private readonly pkg: LoadedLearningPackage, private readonly localMt?: LocalMtGateway) {}

  async lookup(input: LexiconLookupRequest): Promise<LexiconLookupResult> {
    const rows = this.store.lookupLexicon(input.surface, input.targetLanguageCode, input.sourceLanguageCode);
    const locallyResolved = rows.filter((row) => row.translation && row.translationStatus === "approved").map((row): LexiconSenseCandidate => ({
      senseId: row.senseId, lemma: row.lemma, pos: row.pos, translation: row.translation!,
      ...(row.gloss ? { gloss: row.gloss } : {}), morphology: row.morphology,
      origin: row.origin ?? "dictionary", confidence: row.confidence ?? 0.8,
    }));
    if (rows.length === 1 && locallyResolved.length === 1) return { status: "resolved", surface: input.surface, candidates: locallyResolved };

    if (rows.length === 1) {
      const row = rows[0];
      if (row.translation) return { status: "local_mt_candidate", surface: input.surface, candidates: [{
        senseId: row.senseId, lemma: row.lemma, pos: row.pos, translation: row.translation,
        ...(row.gloss ? { gloss: row.gloss } : {}), morphology: row.morphology,
        origin: row.origin ?? "local_mt", confidence: row.confidence ?? 0.5,
      }] };
      const translated = await this.tryLocalTranslation(row.lemma, input.targetLanguageCode, input.sourceLanguageCode);
      if (translated) {
        this.cacheLocalTranslation(row.senseId, input.sourceLanguageCode, input.text, translated);
        return { status: "local_mt_candidate", surface: input.surface, candidates: [{
          senseId: row.senseId, lemma: row.lemma, pos: row.pos, translation: translated.translation,
          ...(row.gloss ? { gloss: row.gloss } : {}), morphology: row.morphology, origin: "local_mt", confidence: translated.confidence,
        }] };
      }
    }

    if (this.localMt?.settings && !this.localMt.settings().cloudFallback) return { status: rows.length > 1 ? "ambiguous" : "not_found", surface: input.surface, candidates: locallyResolved };

    const localOptions = rows.map((row) => ({ senseId: row.senseId, lemma: row.lemma, pos: row.pos, gloss: row.gloss, translation: row.translation }));
    try {
      const prompt = `Bestimme die Grundform, Wortart und kontextuell passende Übersetzung des markierten Ausdrucks aus ${this.pkg.manifest.targetLanguage.name} nach ${this.pkg.manifest.sourceLanguage.name}.
Gesamter Gesprächszug: ${input.text}
Markierter Ausdruck: ${input.surface}
Lokale Kandidaten: ${JSON.stringify(localOptions)}
Wenn lokale Kandidaten vorhanden sind, wähle ausschließlich eine ihrer senseId und erfinde keinen neuen Sinn. Antworte knapp und ohne zusätzliche Erklärung.`;
      const ai = await this.models.structured<LexiconAiResolution>("lexicon_resolution", prompt, "LexiconAiResolution");
      if (localOptions.length && !ai.senseId) return { status: locallyResolved.length > 1 ? "ambiguous" : "not_found", surface: input.surface, candidates: locallyResolved };
      if (ai.senseId && !rows.some((row) => row.senseId === ai.senseId)) return { status: "ambiguous", surface: input.surface, candidates: locallyResolved };
      const candidate: LexiconSenseCandidate = {
        ...(ai.senseId ? { senseId: ai.senseId } : {}), lemma: ai.lemma, pos: ai.pos, translation: ai.translation,
        ...(ai.gloss ? { gloss: ai.gloss } : {}), origin: "llm", confidence: ai.confidence,
      };
      if (ai.senseId) this.store.cacheLexiconTranslation(ai.senseId, input.sourceLanguageCode, {
        translation: ai.translation, origin: "llm", status: "pending_verification", confidence: ai.confidence,
      });
      return { status: "ai_resolved", surface: input.surface, candidates: [candidate] };
    } catch {
      if (locallyResolved.length) return { status: "ambiguous", surface: input.surface, candidates: locallyResolved };
      return { status: "not_found", surface: input.surface, candidates: [] };
    }
  }

  async materializeForModule(module: CurriculumModule, count: number, seed: string): Promise<CandidateItem[]> {
    if (count <= 0) return [];
    const pool = this.store.lexiconDrawPool(this.pkg.manifest.id, module.id, this.pkg.manifest.targetLanguage.code, this.pkg.manifest.sourceLanguage.code);
    const ranked = pool.map((row) => scoreRow(row, module, seed)).sort((a, b) => b.drawScore - a.drawScore || a.row.senseId.localeCompare(b.row.senseId));
    const selected = ranked.slice(0, count);
    if (!selected.length) return [];

    const localTranslations = new Map<string, LocalMtTranslation>();
    for (const { row } of selected.filter(({ row }) => !row.translation)) {
      const translated = await this.tryLocalTranslation(row.lemma, this.pkg.manifest.targetLanguage.code, this.pkg.manifest.sourceLanguage.code);
      if (!translated) continue;
      localTranslations.set(row.senseId, translated);
      this.cacheLocalTranslation(row.senseId, this.pkg.manifest.sourceLanguage.code, row.lemma, translated);
    }
    const incomplete = selected.filter(({ row }) => !(row.translation ?? localTranslations.get(row.senseId)?.translation) || !row.exampleTarget || !row.exampleSource || !row.notes);
    const resolved = new Map<string, LexiconMaterializations["items"][number]>();
    if (incomplete.length) {
      const prompt = `Ergänze ausschließlich die folgenden bereits ausgewählten lexikalischen Einträge aus ${this.pkg.manifest.targetLanguage.name} für Lernende mit Erklärungssprache ${this.pkg.manifest.sourceLanguage.name}.
Übersetze bedeutungsgenau. Erzeuge je einen kurzen natürlichen Beispielsatz in beiden Sprachen und eine knappe Lernnotiz. Ändere senseId und Lemma nicht. Vorhandene Übersetzungen sind zu übernehmen, sofern sie zum angegebenen Sinn passen.
Niveau: ${module.displayLevel}. Modulkategorien: ${module.vocabDomains.join(", ")}.
Einträge: ${JSON.stringify(incomplete.map(({ row }) => ({ senseId: row.senseId, lemma: row.lemma, pos: row.pos, gloss: row.gloss, existingTranslation: row.translation ?? localTranslations.get(row.senseId)?.translation, categories: row.categoryTags })))}`;
      const generated = await this.models.structured<LexiconMaterializations>("lexicon_materialization", prompt, "LexiconMaterializations");
      for (const item of generated.items) if (incomplete.some(({ row }) => row.senseId === item.senseId)) resolved.set(item.senseId, item);
    }

    const items: CandidateItem[] = [];
    for (const selection of selected) {
      const { row } = selection; const generated = resolved.get(row.senseId);
      const translation = row.translation ?? localTranslations.get(row.senseId)?.translation ?? generated?.translation;
      const exampleTarget = row.exampleTarget ?? generated?.exampleTarget;
      const exampleSource = row.exampleSource ?? generated?.exampleSource;
      const notes = row.notes ?? generated?.notes;
      if (!translation || !exampleTarget || !exampleSource || !notes) continue;
      if (generated) this.store.cacheLexiconTranslation(row.senseId, this.pkg.manifest.sourceLanguage.code, {
        translation, exampleTarget, exampleSource, notes, origin: row.origin ?? "llm",
        status: "pending_verification", confidence: generated.confidence,
      });
      this.store.saveLexiconSelection(this.pkg.manifest.id, module.id, row.senseId, selection.score, seed, selection.reasons);
      items.push({
        itemId: `lexicon:${row.senseId}`, kind: "vocab", moduleId: module.id, target: row.lemma, source: translation,
        exampleTarget, exampleSource, notes, tags: module.focusTags.slice(0, 3),
      });
    }
    return items;
  }

  markMaterialization(itemId: string, moduleId: string, status: "materialized" | "imported" | "rejected", rejectTranslation = status === "rejected"): void {
    if (!itemId.startsWith("lexicon:")) return;
    const senseId = itemId.slice("lexicon:".length);
    if (status === "materialized" || status === "imported") this.store.setLexiconTranslationStatus(senseId, this.pkg.manifest.sourceLanguage.code, "approved");
    else if (rejectTranslation) this.store.setLexiconTranslationStatus(senseId, this.pkg.manifest.sourceLanguage.code, "rejected");
    this.store.setLexiconSelectionStatus(this.pkg.manifest.id, moduleId, senseId, status);
  }

  private cacheLocalTranslation(senseId: string, languageCode: string, context: string, translated: LocalMtTranslation): void {
    this.store.cacheLexiconTranslation(senseId, languageCode, {
      translation: translated.translation, origin: "local_mt", status: "pending_verification", confidence: translated.confidence,
      provider: "local_mt", modelId: translated.modelId, modelRevision: translated.modelRevision, modelLicense: translated.license,
      sourceLanguageCode: translated.sourceLanguage, contextHash: createHash("sha256").update(context).digest("hex"), translationMode: translated.mode,
    });
  }

  private async tryLocalTranslation(text: string, sourceLanguage: string, targetLanguage: string): Promise<LocalMtTranslation | undefined> {
    try { return await this.localMt?.translate({ text, sourceLanguage, targetLanguage }); }
    catch { return undefined; }
  }
}

function scoreRow(row: LexiconDrawRow, module: CurriculumModule, seed: string): { row: LexiconDrawRow; score: number; drawScore: number; reasons: string[] } {
  const desired = new Set([...module.vocabDomains, ...module.focusTags].map(normalizeTag));
  const overlap = row.categoryTags.filter((tag) => desired.has(normalizeTag(tag))).length;
  const tagScore = Math.min(1, Math.max(row.mappingWeight, overlap / Math.max(1, desired.size)));
  const levelScore = cefrScore(row.cefr, module.cefr);
  const frequencyScore = row.frequencyRank ? Math.max(0, 1 - Math.log10(Math.max(1, row.frequencyRank)) / 6) : row.frequency ? Math.min(1, Math.log10(1 + row.frequency) / 6) : 0.25;
  const confidenceScore = row.confidence ?? (row.translation ? 0.8 : 0.5);
  const score = 0.4 * tagScore + 0.25 * levelScore + 0.2 * frequencyScore + 0.1 * (tagScore > 0 ? 1 : 0) + 0.05 * confidenceScore;
  const jitter = seededUnit(`${seed}:${row.senseId}`);
  return { row, score, drawScore: score * 0.85 + jitter * 0.15, reasons: [`category=${tagScore.toFixed(3)}`, `level=${levelScore.toFixed(3)}`, `frequency=${frequencyScore.toFixed(3)}`, `confidence=${confidenceScore.toFixed(3)}`] };
}

function cefrScore(candidate: string | undefined, target: string): number {
  if (!candidate) return 0.5;
  const order = ["A0", "A1", "A2", "B1", "B2", "C1", "C2"];
  const left = order.indexOf(candidate.toUpperCase()); const right = order.indexOf(target.toUpperCase());
  if (left < 0 || right < 0) return candidate === target ? 1 : 0.5;
  return Math.max(0, 1 - Math.abs(left - right) * 0.3);
}

function normalizeTag(value: string): string { return value.toLowerCase().replace(/^(topic_|func_|grammar_|case_|verb_|syntax_)/, "").replace(/[^a-z0-9]+/g, "_"); }
function seededUnit(value: string): number { return createHash("sha256").update(value).digest().readUInt32BE(0) / 0xffffffff; }
