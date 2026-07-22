import type { Curriculum } from "@langtut/contracts";
import { DEFAULT_PACKAGE_ID, loadLearningPackage } from "./learning-package.js";
import { applyProgress, type ProgressByModule } from "./curriculum-core.js";
export * from "./curriculum-core.js";

export async function loadCurriculum(root: string, progress: ProgressByModule = {}): Promise<Curriculum> {
  const loaded = await loadLearningPackage(`${root}/learning-packages/${DEFAULT_PACKAGE_ID}`, root);
  return applyProgress(loaded.curriculum, progress);
}
