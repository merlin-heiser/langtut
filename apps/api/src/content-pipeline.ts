import { randomUUID } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { CandidateItem, CurriculumModule, GeneratedItems, Job, VerificationResult } from "@langtut/contracts";
import { deriveModuleStatus, isNearDuplicate, normalizeTarget, renderPackagePrompt, validateCandidate, validateLearningRole, type LoadedLearningPackage } from "@langtut/domain";
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
    const initiallyMissing = Math.max(0, module.vocabTarget - importedVocab);
    const maxBatches = Math.ceil(initiallyMissing / 20) + 2;
    let batchesExecuted = 0;
    for (let batch = 1; importedVocab < module.vocabTarget && batch <= maxBatches; batch++) {
      batchesExecuted = batch;
      const count = Math.min(20, module.vocabTarget - importedVocab);
      const exclusions = this.store.generationExclusions(this.pkg.manifest.id, module.id);
      await this.log({ event: "batch_started", jobId, moduleId: module.id, kind: "vocab", batch, maxBatches, requested: count, alreadyImported: importedVocab, exclusions: exclusions.length });
      const items = await this.generate(module, "vocab", count, exclusions);
      const result = await this.verifyAndImport(module, items);
      importedVocab += result.imported;
      await this.log({ event: "batch_finished", jobId, moduleId: module.id, kind: "vocab", batch, requested: count, ...result, importedTotal: importedVocab });
      this.store.updateJob(jobId, { progress: Math.min(0.75, importedVocab / Math.max(1, module.vocabTarget) * 0.75), message: `Batch ${batch}/${maxBatches}: ${importedVocab}/${module.vocabTarget} Vokabeln importiert` });
    }
    if (importedVocab < module.vocabTarget) throw new Error(`Vokabelziel nach ${batchesExecuted} Batches nicht erreicht; ${module.vocabTarget - importedVocab} Einträge fehlen. Details: data/diagnostics/content-pipeline.jsonl`);

    const missingFunctions = module.functions.filter((id) => !this.store.importedCoverage(this.pkg.manifest.id, module.id, "chunk", "functionId").includes(id));
    const chunks = missingFunctions.length ? await this.generate(module, "chunk", missingFunctions.length, this.store.generationExclusions(this.pkg.manifest.id, module.id)) : [];
    await this.verifyAndImport(module, chunks);
    this.store.updateJob(jobId, { progress: 0.85, message: "Chunks importiert" });
    const missingMilestones = module.grammarMilestones.filter(({ id }) => !this.store.importedCoverage(this.pkg.manifest.id, module.id, "rule", "milestoneId").includes(id));
    const rules = missingMilestones.length ? await this.generate(module, "rule", missingMilestones.length, this.store.generationExclusions(this.pkg.manifest.id, module.id)) : [];
    await this.verifyAndImport(module, rules);

    const evidence = this.store.getEvidence(this.pkg.manifest.id, module.id);
    evidence.importedVocab = this.store.countItems(this.pkg.manifest.id, module.id, "vocab");
    evidence.importedFunctions = this.store.importedCoverage(this.pkg.manifest.id, module.id, "chunk", "functionId");
    evidence.importedMilestones = this.store.importedCoverage(this.pkg.manifest.id, module.id, "rule", "milestoneId");
    const status = deriveModuleStatus("preparing", module, evidence);
    this.store.saveEvidence(this.pkg.manifest.id, module.id, evidence, status);
    this.store.updateJob(jobId, { status: "completed", progress: 1, message: "Modulmaterial vollständig vorbereitet; Milestone-Aufgaben stehen noch aus." });
    await this.log({ event: "job_completed", jobId, moduleId: module.id, importedVocab: evidence.importedVocab, importedFunctions: evidence.importedFunctions.length, importedMilestones: evidence.importedMilestones.length });
  }

  private async generate(module: CurriculumModule, kind: CandidateItem["kind"], count: number, exclusions: string[]): Promise<CandidateItem[]> {
    const taskId = kind === "vocab" ? "vocabulary_generation" : kind === "chunk" ? "chunk_generation" : "rule_generation";
    const prompt = buildGenerationPrompt(this.pkg, module, kind, count, exclusions);
    const result = await this.models.structured<GeneratedItems>(taskId, prompt, "GeneratedItems");
    return result.items.map((item) => ({ ...item, target: normalizeTarget(item.target), exampleTarget: normalizeTarget(item.exampleTarget) }));
  }

  private async verifyAndImport(module: CurriculumModule, items: CandidateItem[]): Promise<ImportResult> {
    const existing = this.store.existingFronts(this.pkg.manifest.id);
    const seen = [...existing];
    const clean: CandidateItem[] = [];
    const issuesByName: Record<string, number> = {};
    let deterministicRejected = 0;
    for (const item of items) {
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
    if (!approved.length) return { generated: items.length, deterministicRejected, semanticRejected, ankiRejected: 0, imported: 0, issues: issuesByName };
    const noteIds = await this.anki.addItems(approved);
    let imported = 0;
    let ankiRejected = 0;
    approved.forEach((item, index) => {
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
      .map((entry) => ({ ...entry, issues: validateLearningRole(entry.item, this.pkg.manifest.targetLanguage.code) }))
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

export function buildGenerationPrompt(pkg: LoadedLearningPackage, module: CurriculumModule, kind: CandidateItem["kind"], count: number, exclusions: string[]): string {
  const roleInstruction = kind === "vocab"
    ? `Erzeuge lexikalischen Wortschatz aus diesen Domänen: ${module.vocabDomains.join(", ")}.
Erzeuge keine sprachwissenschaftlichen Bezeichnungen (z. B. Kasus, Vokal, Betonung, Aspekt, Satzart), keine einzelnen Buchstaben oder Zeichen und keine einzelnen Formen eines Konjugations-/Deklinationsparadigmas. Verben stehen grundsätzlich im Infinitiv, Nomen in der Wörterbuchform und Adjektive in der Grundform. Funktionswörter wie čo, kde oder keď sind zulässig, wenn sie selbst kommunikativ gebraucht werden. Die deutsche Seite ist eine direkte lexikalische Übersetzung; der Beispielsatz zeigt Alltagsgebrauch und erklärt keine Sprachregel.`
    : kind === "chunk"
      ? `Erzeuge feste, direkt verwendbare Wendungen, die genau diese kommunikativen Funktionen realisieren: ${module.functions.join(", ")}. Erzeuge keine bloßen Namen der Funktionen und keine Grammatikterminologie.`
      : `Erzeuge je Grammatik-Milestone eine verständliche Regel-/Abrufnote für diese Ziele: ${module.grammarMilestones.map((m) => `${m.id}: ${m.description}`).join(" | ")}. Hier ist notwendige Metasprache erlaubt, sofern sie knapp erklärt und an konkreten Beispielen gezeigt wird.`;
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
