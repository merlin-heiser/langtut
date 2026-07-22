import type { CurriculumModule, ModuleStatus } from "@langtut/contracts";

export interface ModuleEvidence {
  importedVocab: number;
  importedFunctions: string[];
  importedMilestones: string[];
  attemptedMilestones: string[];
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
  const attempts = new Set(evidence.attemptedMilestones);
  return module.grammarMilestones.every(({ id }) => attempts.has(id));
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
