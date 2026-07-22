import { randomUUID } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { CandidateItem, CurriculumModule, GeneratedItems, Job, VerificationResult } from "@langtut/contracts";
import { deriveModuleStatus, isNearDuplicate, normalizeTarget, renderPackagePrompt, validateCandidate, validateLearningRole, vocabPreparationMinimum, type LoadedLearningPackage } from "@langtut/domain";
import type { Store } from "./database.js";
import type { AnkiGateway } from "./anki.js";
import type { ModelGateway } from "./providers.js";

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
  constructor(
    private readonly store: Store,
    private readonly anki: AnkiGateway,
    private readonly models: ModelGateway,
    private readonly pkg: LoadedLearningPackage,
    private readonly diagnosticPath?: string,
  ) {}

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
        semanticRejected++;
        const issues = result?.issues ?? ["missing_verification"];
        for (const issue of issues) issuesByName[issue] = (issuesByName[issue] ?? 0) + 1;
        this.store.quarantine(this.pkg.manifest.id, item, item, issues);
      }
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
      } else {
        ankiRejected++;
        issuesByName.anki_rejected_note = (issuesByName.anki_rejected_note ?? 0) + 1;
        this.store.quarantine(this.pkg.manifest.id, item, item, ["anki_rejected_note"]);
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

export function buildGenerationPrompt(pkg: LoadedLearningPackage, module: CurriculumModule, kind: CandidateItem["kind"], count: number, exclusions: string[], requestedIds?: string[]): string {
  const requested = new Set(requestedIds ?? []);
  const functions = requested.size ? module.functions.filter((id) => requested.has(id)) : module.functions;
  const milestones = requested.size ? module.grammarMilestones.filter(({ id }) => requested.has(id)) : module.grammarMilestones;
  const roleInstruction = kind === "vocab"
    ? `Erzeuge lexikalischen Wortschatz aus diesen Domänen: ${module.vocabDomains.join(", ")}.
Erzeuge keine sprachwissenschaftlichen Bezeichnungen (z. B. Kasus, Vokal, Betonung, Aspekt, Satzart), keine einzelnen Buchstaben oder Zeichen und keine einzelnen Formen eines Konjugations-/Deklinationsparadigmas. Verben stehen grundsätzlich im Infinitiv, Nomen in der Wörterbuchform und Adjektive in der Grundform. Funktionswörter wie čo, kde oder keď sind zulässig, wenn sie selbst kommunikativ gebraucht werden. Die deutsche Seite ist eine direkte lexikalische Übersetzung; der Beispielsatz zeigt Alltagsgebrauch und erklärt keine Sprachregel.`
    : kind === "chunk"
      ? `Erzeuge feste, direkt verwendbare Wendungen, die genau diese kommunikativen Funktionen realisieren: ${functions.join(", ")}. Erzeuge keine bloßen Namen der Funktionen und keine Grammatikterminologie.`
      : `Erzeuge je Grammatik-Milestone eine verständliche Regel-/Abrufnote für diese Ziele: ${milestones.map((m) => `${m.id}: ${m.description}`).join(" | ")}. Hier ist notwendige Metasprache erlaubt, sofern sie knapp erklärt und an konkreten Beispielen gezeigt wird.`;
  const taskId = kind === "vocab" ? "vocabulary_generation" : kind === "chunk" ? "chunk_generation" : "rule_generation";
  return `${renderPackagePrompt(pkg.prompts[taskId], pkg)}
Erzeuge exakt ${count} ${kind}-Lernobjekte für ${pkg.manifest.targetLanguage.name} (Erklärungssprache ${pkg.manifest.sourceLanguage.name}).
Modulkennung: ${module.id}; Niveau: ${module.displayLevel}.
${roleInstruction}
Verwende ausschließlich diese fachlichen Tags: ${module.focusTags.join(", ")}.
Jedes Objekt enthält genau eine primäre Information, korrekte Orthografie und natürliche beidsprachige Beispiele.
Formuliere Übersetzung, Notiz und Beispiele knapp: eine kurze Notiz und je ein kurzer Beispielsatz genügen.
Bereits verwendete oder abgelehnte Vorderseiten (auch keine bloßen Schreibvarianten erneut erzeugen): ${JSON.stringify(exclusions)}.
kind muss "${kind}" und moduleId muss "${module.id}" sein. itemId muss stabil und eindeutig wirken.
Für chunks ordne functionId zu; für rules milestoneId.`;
}
