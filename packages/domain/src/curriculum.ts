import { readFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import type { Curriculum, CurriculumModule, ModuleStatus } from "@langtut/contracts";

type RawModule = {
  id: string;
  cefr: "A0" | "A1" | "A2" | "B1";
  title: string;
  vocab_target: number;
  vocab_domains: string[];
  functions: string[];
  grammar_milestones: Array<{ id: string; description: string }>;
  practice_types: string[];
  prerequisites: string[];
  exit_criteria: string[];
};

type RawRoadmap = {
  version: string;
  language: "sk";
  target_level: "B1";
  global_targets: { estimated_total_vocab_new_items: number };
  exercise_type_catalog: string[];
  modules: RawModule[];
};

export type ProgressByModule = Record<string, ModuleStatus>;

export async function loadCurriculum(root: string, progress: ProgressByModule = {}): Promise<Curriculum> {
  const roadmapPath = path.join(root, "slowakisch_ai_tutor_recovery_bundle/roadmap_a0_b1.yaml");
  const focusPath = path.join(root, "curriculum/module_focus_tags.yaml");
  const raw = YAML.parse(await readFile(roadmapPath, "utf8")) as RawRoadmap;
  const focus = YAML.parse(await readFile(focusPath, "utf8")) as { modules: Record<string, string[]> };
  const referencedExercises = raw.modules.flatMap((module) => module.practice_types);
  const exerciseTypes = [...new Set([...raw.exercise_type_catalog, ...referencedExercises])].sort();
  const modules: CurriculumModule[] = raw.modules.map((module, index) => ({
    id: module.id,
    cefr: module.cefr,
    displayLevel: module.cefr === "A0" ? "Pre-A1" : module.cefr,
    title: module.title,
    vocabTarget: module.vocab_target,
    vocabDomains: module.vocab_domains,
    functions: module.functions,
    grammarMilestones: module.grammar_milestones,
    practiceTypes: module.practice_types,
    prerequisites: module.prerequisites,
    exitCriteria: module.exit_criteria,
    focusTags: focus.modules[module.id] ?? [],
    status: progress[module.id] ?? (index === 0 ? "available" : "locked"),
  }));
  return {
    version: "4.0-recovery-modernized",
    language: raw.language,
    targetLevel: raw.target_level,
    vocabTarget: raw.global_targets.estimated_total_vocab_new_items as 2000,
    exerciseTypes,
    modules,
  };
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
