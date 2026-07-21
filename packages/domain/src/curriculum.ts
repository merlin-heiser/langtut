import type { Curriculum, CurriculumModule, ModuleStatus } from "@langtut/contracts";
import { DEFAULT_PACKAGE_ID, loadLearningPackage } from "./learning-package.js";

export type ProgressByModule = Record<string, ModuleStatus>;

export async function loadCurriculum(root: string, progress: ProgressByModule = {}): Promise<Curriculum> {
  const loaded = await loadLearningPackage(`${root}/learning-packages/${DEFAULT_PACKAGE_ID}`, root);
  return applyProgress(loaded.curriculum, progress);
}

export function applyProgress(curriculum: Curriculum, progress: ProgressByModule = {}): Curriculum {
  return { ...curriculum, modules: curriculum.modules.map((module, index) => ({ ...module, status: progress[module.id] ?? (index === 0 ? "available" : "locked") })) };
}

export function nextAvailableModule(curriculum: Curriculum): CurriculumModule | null {
  return curriculum.modules.find((module) => module.status === "available" || module.status === "preparing") ?? null;
}

export function recomputeLocks(curriculum: Curriculum, progress: ProgressByModule): ProgressByModule {
  const next = { ...progress };
  for (const module of curriculum.modules) {
    const current = next[module.id];
    if (current === "learning" || current === "credited" || current === "preparing") continue;
    const ready = module.prerequisites.every((id) => ["learning", "credited"].includes(next[id] ?? "locked"));
    next[module.id] = ready ? "available" : "locked";
  }
  return next;
}
