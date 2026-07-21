import { describe, expect, it } from "vitest";
import { createSessionPlan } from "../packages/domain/src/index.js";

const metrics = { reachable: true, dueReviews: 0, newCards: 0, leeches: 0, lapses7d: 0 };

describe("deterministic planner priority", () => {
  it("prioritizes overload over recovery", () => {
    expect(createSessionPlan({ ...metrics, dueReviews: 100, leeches: 2 }, null).mode).toBe("OVERLOAD");
  });
  it("prioritizes recovery when lapses cluster", () => {
    expect(createSessionPlan({ ...metrics, lapses7d: 3 }, null).mode).toBe("RECOVERY");
  });
  it("does not schedule expansion from missing Anki metrics", () => {
    const plan = createSessionPlan({ ...metrics, reachable: false }, { id: "m", cefr: "A1", displayLevel: "A1", title: "M", vocabTarget: 1, vocabDomains: [], functions: [], grammarMilestones: [], practiceTypes: [], prerequisites: [], exitCriteria: [], focusTags: ["func_greet"], status: "available" });
    expect(plan.mode).toBe("NORMAL");
    expect(plan.newCardBudget).toBe(0);
  });
});
