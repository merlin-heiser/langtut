import { randomUUID } from "node:crypto";
import type { CandidateItem, CurriculumModule, GeneratedItems, Job, VerificationResult } from "@langtut/contracts";
import { deriveModuleStatus, isNearDuplicate, normalizeSlovak, validateCandidate } from "@langtut/domain";
import type { Store } from "./database.js";
import type { AnkiGateway } from "./anki.js";
import type { ModelGateway } from "./providers.js";

export class ContentPipeline {
  constructor(
    private readonly store: Store,
    private readonly anki: AnkiGateway,
    private readonly models: ModelGateway,
    private readonly allowedTags: Set<string>,
  ) {}

  start(module: CurriculumModule): Job {
    const now = new Date().toISOString();
    const job: Job = { id: randomUUID(), kind: "prepare-module", moduleId: module.id, status: "queued", progress: 0, message: "Vorbereitung eingeplant", createdAt: now, updatedAt: now };
    this.store.createJob(job);
    this.store.setStatus(module.id, "preparing");
    setImmediate(() => this.run(job.id, module).catch((error) => {
      this.store.updateJob(job.id, { status: "failed", error: error instanceof Error ? error.message : String(error), message: "Vorbereitung fehlgeschlagen" });
    }));
    return job;
  }

  private async run(jobId: string, module: CurriculumModule): Promise<void> {
    this.store.updateJob(jobId, { status: "running", progress: 0.01, message: "Prüfe Anki" });
    const anki = await this.anki.metrics();
    if (!anki.reachable) throw new Error(`Anki ist nicht erreichbar: ${anki.error ?? "unbekannter Fehler"}`);
    this.store.updateJob(jobId, { status: "running", progress: 0.02, message: "Richte Langtut-Modelle in Anki sicher ein" });
    await this.anki.applySetup();

    let importedVocab = this.store.countItems(module.id, "vocab");
    let attempts = 0;
    while (importedVocab < module.vocabTarget && attempts++ < Math.ceil(module.vocabTarget / 20) * 3) {
      const count = Math.min(20, module.vocabTarget - importedVocab);
      const items = await this.generate(module, "vocab", count);
      importedVocab += await this.verifyAndImport(module, items);
      this.store.updateJob(jobId, { progress: Math.min(0.75, importedVocab / Math.max(1, module.vocabTarget) * 0.75), message: `${importedVocab}/${module.vocabTarget} Vokabeln importiert` });
    }
    if (importedVocab < module.vocabTarget) throw new Error(`Vokabelziel nach ${attempts} Batches nicht erreicht; abgelehnte Einträge liegen in Quarantäne.`);

    const missingFunctions = module.functions.filter((id) => !this.store.importedCoverage(module.id, "chunk", "functionId").includes(id));
    const chunks = missingFunctions.length ? await this.generate(module, "chunk", missingFunctions.length) : [];
    await this.verifyAndImport(module, chunks);
    this.store.updateJob(jobId, { progress: 0.85, message: "Chunks importiert" });
    const missingMilestones = module.grammarMilestones.filter(({ id }) => !this.store.importedCoverage(module.id, "rule", "milestoneId").includes(id));
    const rules = missingMilestones.length ? await this.generate(module, "rule", missingMilestones.length) : [];
    await this.verifyAndImport(module, rules);

    const evidence = this.store.getEvidence(module.id);
    evidence.importedVocab = this.store.countItems(module.id, "vocab");
    evidence.importedFunctions = this.store.importedCoverage(module.id, "chunk", "functionId");
    evidence.importedMilestones = this.store.importedCoverage(module.id, "rule", "milestoneId");
    const status = deriveModuleStatus("preparing", module, evidence);
    this.store.saveEvidence(module.id, evidence, status);
    this.store.updateJob(jobId, { status: "completed", progress: 1, message: "Modulmaterial vollständig vorbereitet; Milestone-Aufgaben stehen noch aus." });
  }

  private async generate(module: CurriculumModule, kind: CandidateItem["kind"], count: number): Promise<CandidateItem[]> {
    const taskId = kind === "vocab" ? "vocabulary_generation" : kind === "chunk" ? "chunk_generation" : "rule_generation";
    const prompt = `Erzeuge exakt ${count} ${kind}-Lernobjekte für Slowakisch (Erklärungssprache Deutsch).
Modul: ${module.id} – ${module.title}; Niveau: ${module.displayLevel}; Domänen: ${module.vocabDomains.join(", ")}.
Funktionen: ${module.functions.join(", ")}. Grammatikziele: ${module.grammarMilestones.map((m) => `${m.id}: ${m.description}`).join(" | ")}.
Verwende ausschließlich diese fachlichen Tags: ${module.focusTags.join(", ")}.
Jedes Objekt enthält genau eine primäre Information, korrekte slowakische Diakritik und natürliche beidsprachige Beispiele.
kind muss "${kind}" und moduleId muss "${module.id}" sein. itemId muss stabil und eindeutig wirken.
Für chunks ordne functionId zu; für rules milestoneId.`;
    const result = await this.models.structured<GeneratedItems>(taskId, prompt, "GeneratedItems");
    return result.items.map((item) => ({ ...item, slovak: normalizeSlovak(item.slovak), exampleSlovak: normalizeSlovak(item.exampleSlovak) }));
  }

  private async verifyAndImport(module: CurriculumModule, items: CandidateItem[]): Promise<number> {
    const existing = this.store.existingFronts();
    const clean: CandidateItem[] = [];
    for (const item of items) {
      const issues = validateCandidate(item, this.allowedTags);
      if (item.moduleId !== module.id) issues.push("wrong_module");
      if (item.kind === "chunk" && !module.functions.includes(item.functionId ?? "")) issues.push("unknown_function");
      if (item.kind === "rule" && !module.grammarMilestones.some(({ id }) => id === item.milestoneId)) issues.push("unknown_milestone");
      if (existing.some((front) => isNearDuplicate(front, item.slovak))) issues.push("duplicate_or_near_duplicate");
      if (issues.length) this.store.quarantine(item, item, issues);
      else clean.push(item);
    }
    if (!clean.length) return 0;
    const verificationPrompt = `Prüfe die folgenden slowakisch-deutschen Lernobjekte unabhängig auf korrekte Übersetzung, Natürlichkeit, Beispielsätze und Passung zu ${module.displayLevel}.
Genehmige nur fachlich sichere Einträge. Gib für jedes itemId approved und issues zurück.\n${JSON.stringify(clean)}`;
    const verification = await this.models.structured<VerificationResult>("content_verification", verificationPrompt, "VerificationResult");
    const decision = new Map(verification.results.map((result) => [result.itemId, result]));
    const approved = clean.filter((item) => {
      const result = decision.get(item.itemId);
      if (!result?.approved) this.store.quarantine(item, item, result?.issues ?? ["missing_verification"]);
      return result?.approved;
    });
    if (!approved.length) return 0;
    const noteIds = await this.anki.addItems(approved);
    let imported = 0;
    approved.forEach((item, index) => {
      const noteId = noteIds[index];
      if (noteId) {
        this.store.saveGenerated({ itemId: item.itemId, moduleId: item.moduleId, kind: item.kind, normalized: normalizeSlovak(item.slovak), payload: item }, "imported", noteId);
        imported++;
      } else this.store.quarantine(item, item, ["anki_rejected_note"]);
    });
    return imported;
  }
}
