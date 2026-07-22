import { describe, expect, it } from "vitest";
import type { CurriculumModule } from "@langtut/contracts";
import { deriveModuleStatus, exposureComplete, preparationComplete, vocabPreparationMinimum } from "../packages/domain/src/index.js";

const module: CurriculumModule = {
  id: "m1", cefr: "A1", displayLevel: "A1", title: "Test", vocabTarget: 40,
  vocabDomains: [], functions: ["greet"], grammarMilestones: [{ id: "case_nom", description: "Nominativ" }],
  practiceTypes: [], prerequisites: [], exitCriteria: [], focusTags: ["func_greet"], status: "preparing",
};

describe("progression is exposure, not mastery", () => {
  it("uses a 90 percent preparation minimum for large vocabulary modules", () => {
    expect(vocabPreparationMinimum({ ...module, vocabTarget: 79 })).toBe(79);
    expect(vocabPreparationMinimum({ ...module, vocabTarget: 80 })).toBe(72);
    expect(vocabPreparationMinimum({ ...module, vocabTarget: 120 })).toBe(108);
  });

  it("requires each exposure dimension but no perfect score", () => {
    const evidence = { importedVocab: 40, importedFunctions: ["greet"], importedMilestones: ["case_nom"], attemptedMilestones: [] };
    expect(preparationComplete(module, evidence)).toBe(true);
    expect(exposureComplete(module, evidence)).toBe(false);
    evidence.attemptedMilestones.push("case_nom");
    expect(exposureComplete(module, evidence)).toBe(true);
    expect(deriveModuleStatus("preparing", module, evidence)).toBe("learning");
  });

  it("never regresses completed exposure", () => {
    const weakEvidence = { importedVocab: 0, importedFunctions: [], importedMilestones: [], attemptedMilestones: [] };
    expect(deriveModuleStatus("learning", module, weakEvidence)).toBe("learning");
    expect(deriveModuleStatus("credited", module, weakEvidence)).toBe("credited");
  });
});
