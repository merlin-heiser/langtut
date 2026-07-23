import { randomUUID } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { CandidateItem, CurriculumModule, GeneratedItems, Job, VerificationResult } from "@langtut/contracts";
import { deriveModuleStatus, isNearDuplicate, normalizeTarget, renderPackagePrompt, validateCandidate, validateLearningRole, vocabPreparationMinimum, type LoadedLearningPackage } from "@langtut/domain";
import type { Store } from "./database.js";
import type { AnkiGateway } from "./anki.js";
import type { ModelGateway } from "./providers.js";
import { LexiconService } from "./lexicon.js";
import type { LocalMtGateway } from "./local-mt.js";
import { buildGenerationPrompt } from "@langtut/runtime";
export { buildGenerationPrompt } from "@langtut/runtime";

interface ImportResult {
  generated: number;
  deterministicRejected: number;
  semanticRejected: number;
  ankiRejected: number;
  imported: number;
  issues: Record<string, number>;
}

const VOCAB_GENERATION_BATCH_SIZE = 40;
const VOCAB_ALTERNATIVE_BUFFER = 8;

export class ContentPipeline {
  private readonly lexicon: LexiconService;
  constructor(
    private readonly store: Store,
    private readonly anki: AnkiGateway,
    private readonly models: ModelGateway,
    private readonly pkg: LoadedLearningPackage,
    private readonly diagnosticPath?: string,
    localMt?: LocalMtGateway,
  ) { this.lexicon = new LexiconService(store, models, pkg, localMt); }

  start(module: CurriculumModule): Job {
    const now = new Date().toISOString();
    const job: Job = { id: randomUUID(), packageId: this.pkg.manifest.id, kind: "prepare-module", moduleId: module.id, status: "queued", progress: 0, message: "Vorbereitung eingeplant", createdAt: now, updatedAt: now };
    this.store.createJob(job);
    this.store.setStatus(this.pkg.manifest.id, module.id, "preparing");
    void this.log({ event: "job_started", jobId: job.id, moduleId: module.id });
    setImmediate(() => this.run(job.id, module).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      this.store.updateJob(job.id, { status: "failed", error: message, message: "Vorbereitung fehlgeschlagen" });
      void this.log({ event: "job_failed", jobId: job.id, moduleId: module.id, error: message });
    }));
    return job;
  }

  private async run(jobId: string, module: CurriculumModule): Promise<void> {
    this.store.updateJob(jobId, { status: "running", progress: 0.01, message: "Prüfe Anki" });
    const anki = await this.anki.metrics();
    if (!anki.reachable) throw new Error(`Anki ist nicht erreichbar: ${anki.error ?? "unbekannter Fehler"}`);
    this.store.updateJob(jobId, { status: "running", progress: 0.02, message: "Richte Langtut-Modelle in Anki sicher ein" });
    await this.anki.applySetup();
    const retracted = await this.retractMisclassifiedVocab(jobId, module);
    if (retracted) this.store.updateJob(jobId, { status: "running", message: `${retracted} falsch klassifizierte Vokabel-Notes zurückgezogen; erzeuge lexikalischen Ersatz` });

    const nativeItems = this.pkg.vocabulary.filter((item) => item.moduleId === module.id && !this.store.hasImportedItem(this.pkg.manifest.id, item.itemId));
    if (nativeItems.length) await this.verifyAndImport(module, nativeItems);
    let importedVocab = this.store.countItems(this.pkg.manifest.id, module.id, "vocab");
    const preparationMinimum = vocabPreparationMinimum(module);
    const libraryMissing = Math.max(0, preparationMinimum - importedVocab);
    if (libraryMissing) {
      const seed = `${this.pkg.manifest.id}:${this.pkg.curriculum.version}:${module.id}`;
      const libraryItems = await this.lexicon.materializeForModule(module, libraryMissing, seed);
      if (libraryItems.length) {
        await this.log({ event: "library_draw_started", jobId, moduleId: module.id, requested: libraryMissing, selected: libraryItems.length, seed });
        const libraryResult = await this.verifyAndImport(module, libraryItems, libraryMissing);
        importedVocab += libraryResult.imported;
        await this.log({ event: "library_draw_finished", jobId, moduleId: module.id, ...libraryResult, importedTotal: importedVocab, seed });
        this.store.updateJob(jobId, { progress: Math.min(0.7, importedVocab / Math.max(1, preparationMinimum) * 0.7), message: `${importedVocab}/${preparationMinimum} Vokabeln aus Bibliothek und Paket importiert` });
      }
    }
    const initiallyMissing = Math.max(0, preparationMinimum - importedVocab);
    const maxBatches = Math.ceil(initiallyMissing / VOCAB_GENERATION_BATCH_SIZE) + 2;
    let batchesExecuted = 0;
    for (let batch = 1; importedVocab < preparationMinimum && batch <= maxBatches; batch++) {
      batchesExecuted = batch;
      const missing = preparationMinimum - importedVocab;
      // A small final batch is otherwise brittle: one rejected suggestion can
      // exhaust all replacement attempts. Generate a modest alternative pool,
      // while importing no more than the remaining target.
      const count = Math.min(VOCAB_GENERATION_BATCH_SIZE, missing + VOCAB_ALTERNATIVE_BUFFER);
      const exclusions = this.store.generationExclusions(this.pkg.manifest.id, module.id);
      await this.log({ event: "batch_started", jobId, moduleId: module.id, kind: "vocab", batch, maxBatches, requested: count, alreadyImported: importedVocab, exclusions: exclusions.length });
      const items = await this.generate(module, "vocab", count, exclusions);
      const result = await this.verifyAndImport(module, items, missing);
      importedVocab += result.imported;
      await this.log({ event: "batch_finished", jobId, moduleId: module.id, kind: "vocab", batch, requested: count, ...result, importedTotal: importedVocab });
      this.store.updateJob(jobId, { progress: Math.min(0.75, importedVocab / Math.max(1, preparationMinimum) * 0.75), message: `Batch ${batch}/${maxBatches}: ${importedVocab}/${preparationMinimum} Vokabeln importiert (Ziel: ${module.vocabTarget})` });
    }
    if (importedVocab < preparationMinimum) throw new Error(`Vorbereitungsminimum nach ${batchesExecuted} Batches nicht erreicht; ${preparationMinimum - importedVocab} Einträge fehlen. Details: data/diagnostics/content-pipeline.jsonl`);

    let uncoveredFunctions = module.functions.filter((id) => !this.store.importedCoverage(this.pkg.manifest.id, module.id, "chunk", "functionId").includes(id));
    for (let attempt = 1; uncoveredFunctions.length && attempt <= 3; attempt++) {
      const candidateCount = uncoveredFunctions.length === module.functions.length ? uncoveredFunctions.length : uncoveredFunctions.length + 2;
      const chunks = await this.generate(module, "chunk", candidateCount, this.store.generationExclusions(this.pkg.manifest.id, module.id), uncoveredFunctions);
      await this.verifyAndImport(module, chunks, uncoveredFunctions.length);
      uncoveredFunctions = module.functions.filter((id) => !this.store.importedCoverage(this.pkg.manifest.id, module.id, "chunk", "functionId").includes(id));
      this.store.updateJob(jobId, { progress: 0.8, message: `Chunk-Abdeckung: ${module.functions.length - uncoveredFunctions.length}/${module.functions.length}` });
    }
    if (uncoveredFunctions.length) throw new Error(`Kommunikative Funktionen nicht vollständig vorbereitet: ${uncoveredFunctions.join(", ")}`);
    this.store.updateJob(jobId, { progress: 0.85, message: "Chunks importiert" });
    let uncoveredMilestones = module.grammarMilestones.filter(({ id }) => !this.store.importedCoverage(this.pkg.manifest.id, module.id, "rule", "milestoneId").includes(id));
    for (let attempt = 1; uncoveredMilestones.length && attempt <= 3; attempt++) {
      const ids = uncoveredMilestones.map(({ id }) => id);
      const candidateCount = ids.length === module.grammarMilestones.length ? ids.length : ids.length + 2;
      const rules = await this.generate(module, "rule", candidateCount, this.store.generationExclusions(this.pkg.manifest.id, module.id), ids);
      await this.verifyAndImport(module, rules, ids.length);
      uncoveredMilestones = module.grammarMilestones.filter(({ id }) => !this.store.importedCoverage(this.pkg.manifest.id, module.id, "rule", "milestoneId").includes(id));
      this.store.updateJob(jobId, { progress: 0.9, message: `Regel-Abdeckung: ${module.grammarMilestones.length - uncoveredMilestones.length}/${module.grammarMilestones.length}` });
    }
    if (uncoveredMilestones.length) throw new Error(`Grammatik-Milestones nicht vollständig vorbereitet: ${uncoveredMilestones.map(({ id }) => id).join(", ")}`);

    const evidence = this.store.getEvidence(this.pkg.manifest.id, module.id);
    evidence.importedVocab = this.store.countItems(this.pkg.manifest.id, module.id, "vocab");
    evidence.importedFunctions = this.store.importedCoverage(this.pkg.manifest.id, module.id, "chunk", "functionId");
    evidence.importedMilestones = this.store.importedCoverage(this.pkg.manifest.id, module.id, "rule", "milestoneId");
    const status = deriveModuleStatus("preparing", module, evidence);
    this.store.saveEvidence(this.pkg.manifest.id, module.id, evidence, status);
    await this.anki.syncModuleAvailability?.(this.pkg.manifest.id, Object.entries(this.store.getProgress(this.pkg.manifest.id)).filter(([, value]) => value === "learning").map(([moduleId]) => moduleId));
    this.store.updateJob(jobId, { status: "completed", progress: 1, message: "Modulmaterial vollständig vorbereitet; Milestone-Aufgaben stehen noch aus." });
    await this.log({ event: "job_completed", jobId, moduleId: module.id, importedVocab: evidence.importedVocab, importedFunctions: evidence.importedFunctions.length, importedMilestones: evidence.importedMilestones.length });
  }

  private async generate(module: CurriculumModule, kind: CandidateItem["kind"], count: number, exclusions: string[], requestedIds?: string[]): Promise<CandidateItem[]> {
    const taskId = kind === "vocab" ? "vocabulary_generation" : kind === "chunk" ? "chunk_generation" : "rule_generation";
    const prompt = buildGenerationPrompt(this.pkg, module, kind, count, exclusions, requestedIds);
    const result = await this.models.structured<GeneratedItems>(taskId, prompt, "GeneratedItems");
    return result.items.map(normalizeCandidateItem);
  }

  private async verifyAndImport(module: CurriculumModule, items: CandidateItem[], importLimit = Number.POSITIVE_INFINITY): Promise<ImportResult> {
    const existing = this.store.existingFronts(this.pkg.manifest.id);
    const seen = [...existing];
    const clean: CandidateItem[] = [];
    const issuesByName: Record<string, number> = {};
    let deterministicRejected = 0;
    for (const rawItem of items) {
      const item = normalizeCandidateItem(rawItem);
      const issues = validateCandidate(item, this.pkg.allowedTags);
      issues.push(...validateLearningRole(item, this.pkg.manifest.targetLanguage.code));
      if (item.moduleId !== module.id) issues.push("wrong_module");
      if (item.kind === "chunk" && !module.functions.includes(item.functionId ?? "")) issues.push("unknown_function");
      if (item.kind === "rule" && !module.grammarMilestones.some(({ id }) => id === item.milestoneId)) issues.push("unknown_milestone");
      if (seen.some((front) => isNearDuplicate(front, item.target))) issues.push("duplicate_or_near_duplicate");
      if (issues.length) {
        this.lexicon.markMaterialization(item.itemId, module.id, "rejected", false);
        deterministicRejected++;
        for (const issue of issues) issuesByName[issue] = (issuesByName[issue] ?? 0) + 1;
        this.store.quarantine(this.pkg.manifest.id, item, item, issues);
      } else {
        clean.push(item);
        seen.push(item.target);
      }
    }
    if (!clean.length) return { generated: items.length, deterministicRejected, semanticRejected: 0, ankiRejected: 0, imported: 0, issues: issuesByName };
    const roleRubric = clean[0]?.kind === "vocab"
      ? "Vocab muss eine kommunikativ verwendbare lexikalische Einheit in Wörterbuchform sein. Lehne Metasprache, einzelne Schriftzeichen, isolierte Flexionszellen und Begriffe ab, deren Hauptzweck das Benennen eines Grammatik-/Aussprachekonzepts ist. Solche Inhalte gehören in Rule-Notes oder Übungen."
      : clean[0]?.kind === "chunk"
        ? "Chunks müssen direkt verwendbare feste Wendungen sein; bloße Funktions- oder Grammatikbezeichnungen sind abzulehnen."
        : "Bei Rule-Notes ist notwendige Metasprache erlaubt, muss aber knapp, korrekt und beispielgestützt sein.";
    const verificationPrompt = `${renderPackagePrompt(this.pkg.prompts.content_verification, this.pkg)} Prüfe die folgenden Lernobjekte unabhängig auf korrekte Übersetzung, Natürlichkeit, Beispielsätze, pädagogische Rolle und Passung zu ${module.displayLevel}.
${roleRubric} Lehne außerdem bei Fehlern, Irreführung, unnatürlicher Sprache oder falscher Modulpassung ab. Gib für jedes itemId approved und issues zurück.\n${JSON.stringify(clean)}`;
    const verification = await this.models.structured<VerificationResult>("content_verification", verificationPrompt, "VerificationResult");
    const decision = new Map(verification.results.map((result) => [result.itemId, result]));
    let semanticRejected = 0;
    const approved = clean.filter((item) => {
      const result = decision.get(item.itemId);
      if (!result?.approved) {
        this.lexicon.markMaterialization(item.itemId, module.id, "rejected");
        semanticRejected++;
        const issues = result?.issues ?? ["missing_verification"];
        for (const issue of issues) issuesByName[issue] = (issuesByName[issue] ?? 0) + 1;
        this.store.quarantine(this.pkg.manifest.id, item, item, issues);
      }
      else this.lexicon.markMaterialization(item.itemId, module.id, "materialized");
      return result?.approved;
    });
    const selected = approved.slice(0, importLimit);
    if (!selected.length) return { generated: items.length, deterministicRejected, semanticRejected, ankiRejected: 0, imported: 0, issues: issuesByName };
    const noteIds = await this.anki.addItems(selected);
    let imported = 0;
    let ankiRejected = 0;
    selected.forEach((item, index) => {
      const noteId = noteIds[index];
      if (noteId) {
        this.store.saveGenerated(this.pkg.manifest.id, { itemId: item.itemId, moduleId: item.moduleId, kind: item.kind, normalized: normalizeTarget(item.target), payload: item }, "imported", noteId);
        imported++;
        this.lexicon.markMaterialization(item.itemId, module.id, "imported");
      } else {
        ankiRejected++;
        issuesByName.anki_rejected_note = (issuesByName.anki_rejected_note ?? 0) + 1;
        this.store.quarantine(this.pkg.manifest.id, item, item, ["anki_rejected_note"]);
        this.lexicon.markMaterialization(item.itemId, module.id, "rejected", false);
      }
    });
    return { generated: items.length, deterministicRejected, semanticRejected, ankiRejected, imported, issues: issuesByName };
  }

  private async retractMisclassifiedVocab(jobId: string, module: CurriculumModule): Promise<number> {
    const invalid = this.store.importedItems<CandidateItem>(this.pkg.manifest.id, module.id, "vocab")
      .map((entry) => ({ ...entry, item: normalizeCandidateItem(entry.item), issues: validateLearningRole(normalizeCandidateItem(entry.item), this.pkg.manifest.targetLanguage.code) }))
      .filter(({ issues }) => issues.length > 0);
    if (!invalid.length) return 0;
    const noteIds = invalid.flatMap(({ ankiNoteId }) => ankiNoteId ? [ankiNoteId] : []);
    await this.anki.removeNotes(noteIds);
    for (const { item, issues } of invalid) this.store.retractGenerated(this.pkg.manifest.id, item, item, issues);
    await this.log({ event: "imported_content_retracted", jobId, moduleId: module.id, kind: "vocab", count: invalid.length, ankiNotesRemoved: noteIds.length, issues: countIssues(invalid.flatMap(({ issues }) => issues)) });
    return invalid.length;
  }

  private async log(payload: Record<string, unknown>): Promise<void> {
    if (!this.diagnosticPath) return;
    try {
      await mkdir(path.dirname(this.diagnosticPath), { recursive: true });
      await appendFile(this.diagnosticPath, `${JSON.stringify({ at: new Date().toISOString(), ...payload })}\n`, "utf8");
    } catch {
      // Diagnostics must never change learning state or retry semantics.
    }
  }
}

function countIssues(issues: string[]): Record<string, number> {
  return issues.reduce<Record<string, number>>((counts, issue) => ({ ...counts, [issue]: (counts[issue] ?? 0) + 1 }), {});
}

/** Accept the pre-1.0 Slovak/German field names stored by earlier imports. */
function normalizeCandidateItem(item: CandidateItem): CandidateItem {
  const legacy = item as CandidateItem & {
    slovak?: unknown; german?: unknown; exampleSlovak?: unknown; exampleGerman?: unknown;
  };
  const text = (value: unknown): string => typeof value === "string" ? normalizeTarget(value) : "";
  return {
    ...item,
    target: text(item.target ?? legacy.slovak),
    source: text(item.source ?? legacy.german),
    exampleTarget: text(item.exampleTarget ?? legacy.exampleSlovak),
    exampleSource: text(item.exampleSource ?? legacy.exampleGerman),
    notes: text(item.notes),
    tags: Array.isArray(item.tags) ? item.tags.filter((tag): tag is string => typeof tag === "string") : [],
  };
}
