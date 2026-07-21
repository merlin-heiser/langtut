import { describe, expect, it } from "vitest";
import { loadCurriculum, recomputeLocks } from "../packages/domain/src/index.js";

const root = process.cwd();

describe("recovered curriculum contract", () => {
  it("contains the complete versioned roadmap", async () => {
    const curriculum = await loadCurriculum(root);
    expect(curriculum.modules).toHaveLength(23);
    expect(new Set(curriculum.modules.map(({ id }) => id)).size).toBe(23);
    expect(curriculum.modules.reduce((sum, module) => sum + module.vocabTarget, 0)).toBe(2000);
    expect(curriculum.modules.filter(({ cefr }) => cefr === "A0").every(({ displayLevel }) => displayLevel === "Pre-A1")).toBe(true);
    expect(curriculum.exerciseTypes).toContain("listening_stub");
  });

  it("unlocks successors only after exposure or credit", async () => {
    const curriculum = await loadCurriculum(root);
    const first = curriculum.modules[0];
    const second = curriculum.modules[1];
    const locked = recomputeLocks(curriculum, { [first.id]: "available" });
    expect(locked[second.id]).toBe("locked");
    const open = recomputeLocks(curriculum, { [first.id]: "learning" });
    expect(open[second.id]).toBe("available");
  });
});
