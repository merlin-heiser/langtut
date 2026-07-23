import type { CurriculumModule, ModuleStatus } from "@langtut/contracts";

export interface ModuleEvidence {
  importedVocab: number;
  importedFunctions: string[];
  importedMilestones: string[];
  attemptedMilestones: string[];
}

/** Stable IDs stored in the existing monotonic progress event.  Keeping these
 * alongside legacy milestone attempts makes the change sync-compatible. */
export function targetActivationId(kind: "vocab" | "function" | "grammar", id?: string): string {
  return `target:${kind}:${id ?? "module"}`;
}

export function requiredTargetActivationIds(module: CurriculumModule): string[] {
  return [
    targetActivationId("vocab"),
    ...module.functions.map((id) => targetActivationId("function", id)),
    ...module.grammarMilestones.map(({ id }) => targetActivationId("grammar", id)),
  ];
}

export function targetsActivated(module: CurriculumModule, evidence: ModuleEvidence): boolean {
  const activated = new Set(evidence.attemptedMilestones);
  return requiredTargetActivationIds(module).every((id) => activated.has(id));
}

/**
 * Large vocabulary targets are a coverage goal, not a reason to loop on the
 * final handful of marginal candidates. The remaining space is intentionally
 * available for learner-imported vocabulary later in the course.
 */
export function vocabPreparationMinimum(module: CurriculumModule): number {
  return module.vocabTarget >= 80 ? Math.ceil(module.vocabTarget * 0.9) : module.vocabTarget;
}

export function exposureComplete(module: CurriculumModule, evidence: ModuleEvidence): boolean {
  if (!preparationComplete(module, evidence)) return false;
  return targetsActivated(module, evidence);
}

export function preparationComplete(module: CurriculumModule, evidence: ModuleEvidence): boolean {
  const functions = new Set(evidence.importedFunctions);
  const rules = new Set(evidence.importedMilestones);
  return evidence.importedVocab >= vocabPreparationMinimum(module)
    && module.functions.every((id) => functions.has(id))
    && module.grammarMilestones.every(({ id }) => rules.has(id));
}

export function deriveModuleStatus(current: ModuleStatus, module: CurriculumModule, evidence: ModuleEvidence): ModuleStatus {
  if (current === "credited" || current === "learning") return current;
  if (exposureComplete(module, evidence)) return "learning";
  if (evidence.importedVocab > 0 || evidence.importedFunctions.length > 0 || evidence.importedMilestones.length > 0) return "preparing";
  return current;
}
