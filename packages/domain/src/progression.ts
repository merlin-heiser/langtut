import type { CurriculumModule, ModuleStatus } from "@langtut/contracts";

export interface ModuleEvidence {
  importedVocab: number;
  importedFunctions: string[];
  importedMilestones: string[];
  attemptedMilestones: string[];
}

export function exposureComplete(module: CurriculumModule, evidence: ModuleEvidence): boolean {
  const functions = new Set(evidence.importedFunctions);
  const rules = new Set(evidence.importedMilestones);
  const attempts = new Set(evidence.attemptedMilestones);
  return evidence.importedVocab >= module.vocabTarget
    && module.functions.every((id) => functions.has(id))
    && module.grammarMilestones.every(({ id }) => rules.has(id) && attempts.has(id));
}

export function deriveModuleStatus(current: ModuleStatus, module: CurriculumModule, evidence: ModuleEvidence): ModuleStatus {
  if (current === "credited" || current === "learning") return current;
  if (exposureComplete(module, evidence)) return "learning";
  if (evidence.importedVocab > 0 || evidence.importedFunctions.length > 0 || evidence.importedMilestones.length > 0) return "preparing";
  return current;
}
