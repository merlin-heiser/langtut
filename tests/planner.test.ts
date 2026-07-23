import { describe, expect, it } from "vitest";
import { completeDailyTask, createSessionPlan, dailyPlanProgress, nextDailyTask } from "../packages/domain/src/index.js";

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
  it("counts a weak completed unit and makes its rework visible", () => {
    const sessionPlan = createSessionPlan(metrics, null);
    const plan = { id: "day", packageId: "test", date: "2026-07-23", sessionPlan, createdAt: sessionPlan.createdAt, updatedAt: sessionPlan.createdAt, tasks: [{ id: "exercise", kind: "exercise" as const, moduleId: "m", title: "Deklinationsübung", activityId: "declension", evidenceTargets: ["grammar:case"], status: "pending" as const, completedWork: 0, expectedWork: 1 }] };
    const updated = completeDailyTask(plan, "exercise", "incorrect", "2026-07-23T12:00:00.000Z");
    expect(dailyPlanProgress(updated)).toMatchObject({ completedWork: 1, expectedWork: 2, percent: 50, remainingTasks: 1 });
    expect(nextDailyTask(updated)?.retryOf).toBe("exercise");
  });
});
