import { access, lstat, mkdir, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import YAML from "yaml";
import type { CandidateItem, Curriculum, CurriculumModule, ModuleStatus } from "@langtut/contracts";

export const DEFAULT_PACKAGE_ID = "slowakisch-deutsch";
export const KNOWN_PROMPTS = ["vocabulary_generation", "chunk_generation", "rule_generation", "content_verification", "placement_open_response", "tutor_conversation", "session_report"] as const;

export interface LanguageDescriptor { code: string; name: string }
export interface LearningPackageManifest {
  schemaVersion: 1;
  id: string;
  version: string;
  name: string;
  targetLanguage: LanguageDescriptor;
  sourceLanguage: LanguageDescriptor;
  targetLevel: string;
  ankiDeck?: string;
}
export interface ActivityRole { id: string; label: string; controller: "learner" | "llm" | "fixed"; prompt?: string; message?: string }
export interface LearningActivity {
  id: string;
  title: string;
  description?: string;
  type?: "roleplay";
  scenarioTarget?: string;
  scenarioSource?: string;
  roles: ActivityRole[];
  turnOrder: string[];
  rounds: number;
  focusTags?: string[];
}
export interface PlacementItemDefinition {
  id: string; level: string; prompt: string; expected: string[]; tag: string;
  kind?: "production" | "recognition" | "open"; choices?: string[];
}
export interface LoadedLearningPackage {
  root: string;
  manifest: LearningPackageManifest;
  curriculum: Curriculum;
  prompts: Record<string, string>;
  activities: LearningActivity[];
  placement: PlacementItemDefinition[];
  vocabulary: CandidateItem[];
  allowedTags: Set<string>;
  capabilities: { placement: boolean; nativeVocabulary: boolean; customPrompts: boolean; activities: boolean };
}
export interface PackageSummary extends LearningPackageManifest {
  active: boolean;
  modules: number;
  capabilities: LoadedLearningPackage["capabilities"];
  valid: true;
}

type RawModule = {
  id: string; cefr?: string; level?: string; displayLevel?: string; title: string;
  vocab_target?: number; vocabTarget?: number; vocab_domains?: string[]; vocabDomains?: string[];
  functions?: string[]; grammar_milestones?: Array<{ id: string; description: string }>; grammarMilestones?: Array<{ id: string; description: string }>;
  practice_types?: string[]; practiceTypes?: string[]; prerequisites?: string[]; exit_criteria?: string[]; exitCriteria?: string[];
  focus_tags?: string[]; focusTags?: string[]; activities?: string[];
};

const standardPrompts: Record<string, string> = {
  vocabulary_generation: "Erzeuge hochwertige Lernobjekte für {{targetLanguage}} mit Erklärungen auf {{sourceLanguage}}.",
  chunk_generation: "Erzeuge natürliche Wendungen in {{targetLanguage}} mit Erklärungen auf {{sourceLanguage}}.",
  rule_generation: "Erzeuge verständliche Regeln für {{targetLanguage}} mit Erklärungen auf {{sourceLanguage}}.",
  content_verification: "Prüfe Korrektheit und Natürlichkeit für {{targetLanguage}} und {{sourceLanguage}}.",
  placement_open_response: "Bewerte die freie Antwort in {{targetLanguage}}.",
  tutor_conversation: "Du bist ein geduldiger Tutor für {{targetLanguage}}. Erkläre knapp auf {{sourceLanguage}}.",
  session_report: "Fasse die beobachteten Lernsignale präzise zusammen.",
};

export class LearningPackageRepository {
  private readonly installedRoot: string;
  private packages = new Map<string, LoadedLearningPackage>();

  constructor(private readonly projectRoot: string) {
    this.installedRoot = path.join(projectRoot, "data", "packages");
  }

  async loadAll(): Promise<void> {
    await mkdir(this.installedRoot, { recursive: true });
    this.packages.clear();
    const builtIn = path.join(this.projectRoot, "learning-packages", DEFAULT_PACKAGE_ID);
    this.packages.set(DEFAULT_PACKAGE_ID, await loadLearningPackage(builtIn, this.projectRoot));
    for (const name of await readdir(this.installedRoot)) {
      if (name.startsWith(".")) continue;
      const candidate = path.join(this.installedRoot, name);
      if (!(await stat(candidate)).isDirectory()) continue;
      const loaded = await loadLearningPackage(candidate, this.projectRoot);
      this.packages.set(loaded.manifest.id, loaded);
    }
  }

  get(id: string): LoadedLearningPackage | undefined { return this.packages.get(id); }
  require(id: string): LoadedLearningPackage {
    const found = this.get(id);
    if (!found) throw new Error(`Unknown learning package: ${id}`);
    return found;
  }
  list(activeId: string): PackageSummary[] {
    return [...this.packages.values()].map((pkg) => ({ ...pkg.manifest, active: pkg.manifest.id === activeId, modules: pkg.curriculum.modules.length, capabilities: pkg.capabilities, valid: true as const }));
  }

  async importZip(zipPath: string): Promise<LoadedLearningPackage> {
    const staging = path.join(this.installedRoot, `.staging-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    await mkdir(staging, { recursive: true });
    try {
      const entries = (await runTar(["-tf", zipPath])).split(/\r?\n/).filter(Boolean);
      if (!entries.length || entries.length > 2000) throw new Error("Package archive is empty or contains too many files");
      for (const entry of entries) {
        const normalized = entry.replace(/\\/g, "/");
        if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized) || normalized.split("/").includes("..")) throw new Error(`Unsafe archive path: ${entry}`);
      }
      await runTar(["-xf", zipPath, "-C", staging]);
      await verifyExtractedTree(staging);
      let packageRoot = staging;
      if (!(await exists(path.join(packageRoot, "package.yaml")))) {
        const children = await readdir(staging);
        if (children.length !== 1) throw new Error("package.yaml must be at the archive root or in its only top-level directory");
        packageRoot = path.join(staging, children[0]);
      }
      const loaded = await loadLearningPackage(packageRoot, this.projectRoot);
      if (loaded.manifest.id === DEFAULT_PACKAGE_ID) throw new Error("The built-in package cannot be replaced");
      const destination = path.join(this.installedRoot, loaded.manifest.id);
      const previous = `${destination}.previous`;
      await rm(previous, { recursive: true, force: true });
      if (await exists(destination)) await rename(destination, previous);
      try { await rename(packageRoot, destination); }
      catch (error) { if (await exists(previous)) await rename(previous, destination); throw error; }
      await rm(previous, { recursive: true, force: true });
      await rm(staging, { recursive: true, force: true });
      const installed = await loadLearningPackage(destination, this.projectRoot);
      this.packages.set(installed.manifest.id, installed);
      return installed;
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      throw error;
    }
  }
}

export async function loadLearningPackage(packageRoot: string, _projectRoot = process.cwd()): Promise<LoadedLearningPackage> {
  const manifest = YAML.parse(await readFile(path.join(packageRoot, "package.yaml"), "utf8")) as LearningPackageManifest;
  validateManifest(manifest);
  const rawCurriculum = YAML.parse(await readFile(path.join(packageRoot, "curriculum.yaml"), "utf8"));
  const rawModules = (rawCurriculum.modules ?? []) as RawModule[];
  if (!rawModules.length) throw new Error("curriculum.yaml must define at least one module");
  const ids = new Set<string>();
  const modules: CurriculumModule[] = rawModules.map((raw, index) => {
    if (!raw.id || ids.has(raw.id)) throw new Error(`Duplicate or missing module id: ${raw.id ?? "<missing>"}`);
    ids.add(raw.id);
    const cefr = raw.cefr ?? raw.level ?? raw.displayLevel ?? "1";
    const focusTags = raw.focus_tags ?? raw.focusTags ?? (raw.vocab_domains ?? raw.vocabDomains ?? []).slice(0, 3).map(slugTag);
    return {
      id: raw.id, cefr, displayLevel: raw.displayLevel ?? (cefr === "A0" ? "Pre-A1" : cefr), title: raw.title,
      vocabTarget: raw.vocab_target ?? raw.vocabTarget ?? 1,
      vocabDomains: raw.vocab_domains ?? raw.vocabDomains ?? [], functions: raw.functions ?? [],
      grammarMilestones: raw.grammar_milestones ?? raw.grammarMilestones ?? [], practiceTypes: raw.practice_types ?? raw.practiceTypes ?? [],
      prerequisites: raw.prerequisites ?? [], exitCriteria: raw.exit_criteria ?? raw.exitCriteria ?? [], focusTags: focusTags.length ? focusTags : ["general"],
      activityIds: raw.activities ?? [],
      status: index === 0 ? "available" as ModuleStatus : "locked" as ModuleStatus,
    };
  });
  validateGraph(modules);
  const exerciseTypes = [...new Set([...(rawCurriculum.exercise_type_catalog ?? rawCurriculum.exerciseTypes ?? []), ...modules.flatMap((module) => module.practiceTypes)])].sort() as string[];
  const vocabTarget = Number(rawCurriculum.global_targets?.estimated_total_vocab_new_items ?? rawCurriculum.vocabTarget ?? modules.reduce((sum, module) => sum + module.vocabTarget, 0));
  const curriculum: Curriculum = { packageId: manifest.id, version: String(rawCurriculum.version ?? manifest.version), language: manifest.targetLanguage.code, sourceLanguage: manifest.sourceLanguage.code, targetLevel: manifest.targetLevel, vocabTarget, exerciseTypes, modules };
  const prompts = { ...standardPrompts, ...await readOptionalYaml<Record<string, string>>(packageRoot, "prompts.yaml", {}) };
  for (const key of Object.keys(prompts)) if (!(KNOWN_PROMPTS as readonly string[]).includes(key)) throw new Error(`Unknown prompt key: ${key}`);
  const activityDoc = await readOptionalYaml<{ activities?: LearningActivity[] }>(packageRoot, "activities.yaml", {});
  const activities = activityDoc.activities ?? [];
  validateActivities(activities, prompts);
  const activityIds = new Set(activities.map(({ id }) => id));
  for (const module of modules) for (const activityId of module.activityIds ?? []) if (!activityIds.has(activityId)) throw new Error(`${module.id}: unknown activity ${activityId}`);
  const placementDoc = await readOptionalYaml<{ items?: PlacementItemDefinition[] } | PlacementItemDefinition[]>(packageRoot, "placement.yaml", []);
  const placement = Array.isArray(placementDoc) ? placementDoc : placementDoc.items ?? [];
  const vocabularyDoc = await readOptionalYaml<{ items?: CandidateItem[] } | CandidateItem[]>(packageRoot, "vocabulary.yaml", []);
  const vocabulary = Array.isArray(vocabularyDoc) ? vocabularyDoc : vocabularyDoc.items ?? [];
  for (const item of vocabulary) if (!ids.has(item.moduleId)) throw new Error(`Vocabulary item ${item.itemId} references unknown module ${item.moduleId}`);
  const allowedTags = new Set([...modules.flatMap((module) => module.focusTags), ...vocabulary.flatMap((item) => item.tags)]);
  return { root: packageRoot, manifest, curriculum, prompts, activities, placement, vocabulary, allowedTags, capabilities: { placement: placement.length > 0, nativeVocabulary: vocabulary.length > 0, customPrompts: await exists(path.join(packageRoot, "prompts.yaml")), activities: activities.length > 0 } };
}

export function renderPackagePrompt(template: string, pkg: LoadedLearningPackage, values: Record<string, string> = {}): string {
  const context: Record<string, string> = { targetLanguage: pkg.manifest.targetLanguage.name, sourceLanguage: pkg.manifest.sourceLanguage.name, targetLanguageCode: pkg.manifest.targetLanguage.code, sourceLanguageCode: pkg.manifest.sourceLanguage.code, ...values };
  return template.replace(/\{\{([A-Za-z][A-Za-z0-9]*)\}\}/g, (_match, key: string) => context[key] ?? "");
}

function validateManifest(value: LearningPackageManifest): void {
  if (value?.schemaVersion !== 1) throw new Error("Unsupported or missing package schemaVersion");
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.id ?? "")) throw new Error("Package id must be a lowercase kebab-case identifier");
  if (!value.version || !value.name || !value.targetLevel || !value.targetLanguage?.code || !value.sourceLanguage?.code) throw new Error("Incomplete package manifest");
}
function validateGraph(modules: CurriculumModule[]): void {
  const byId = new Map(modules.map((module) => [module.id, module]));
  const visiting = new Set<string>(); const visited = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id)) throw new Error(`Prerequisite cycle at ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const prerequisite of byId.get(id)?.prerequisites ?? []) { if (!byId.has(prerequisite)) throw new Error(`${id} references unknown prerequisite ${prerequisite}`); visit(prerequisite); }
    visiting.delete(id); visited.add(id);
  };
  for (const id of byId.keys()) visit(id);
}
function validateActivities(activities: LearningActivity[], prompts: Record<string, string>): void {
  const ids = new Set<string>();
  for (const activity of activities) {
    if (!activity.id || ids.has(activity.id)) throw new Error(`Duplicate or missing activity id: ${activity.id ?? "<missing>"}`);
    ids.add(activity.id);
    if (!Number.isInteger(activity.rounds) || activity.rounds < 1 || activity.rounds > 100) throw new Error(`${activity.id}: rounds must be between 1 and 100`);
    const roles = new Set(activity.roles.map((role) => role.id));
    if (roles.size !== activity.roles.length || activity.turnOrder.some((role) => !roles.has(role)) || activity.turnOrder.length !== activity.roles.length || activity.roles.some(({ id }) => !activity.turnOrder.includes(id))) throw new Error(`${activity.id}: invalid role or turn order`);
    if (!activity.roles.some(({ controller }) => controller === "learner") || !activity.roles.some(({ controller }) => controller !== "learner")) throw new Error(`${activity.id}: needs learner and partner roles`);
    if (activity.type === "roleplay") {
      if (!activity.scenarioTarget?.trim() || !activity.scenarioSource?.trim()) throw new Error(`${activity.id}: roleplay needs target and source scenarios`);
      const learnerIndex = activity.turnOrder.findIndex((id) => activity.roles.find((role) => role.id === id)?.controller === "learner");
      if (learnerIndex < 1 || !activity.turnOrder.slice(0, learnerIndex).some((id) => activity.roles.find((role) => role.id === id)?.controller === "llm")) throw new Error(`${activity.id}: roleplay needs an LLM role before the learner`);
    }
    for (const role of activity.roles) {
      if (role.controller === "llm" && role.prompt && !prompts[role.prompt]) throw new Error(`${activity.id}: unknown role prompt ${role.prompt}`);
      if (role.controller === "fixed" && !role.message?.trim()) throw new Error(`${activity.id}: fixed role ${role.id} needs a message`);
    }
  }
}
async function readOptionalYaml<T>(root: string, name: string, fallback: T): Promise<T> {
  try { return YAML.parse(await readFile(path.join(root, name), "utf8")) as T; } catch (error: any) { if (error?.code === "ENOENT") return fallback; throw error; }
}
async function exists(file: string): Promise<boolean> { try { await access(file); return true; } catch { return false; } }
function slugTag(value: string): string { return value.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || "general"; }
function runTar(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("tar", args, { windowsHide: true }); let stdout = ""; let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; }); child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject); child.on("close", (code) => code === 0 ? resolve(stdout) : reject(new Error(stderr || `tar exited with ${code}`)));
  });
}
async function verifyExtractedTree(root: string): Promise<void> {
  let totalBytes = 0;
  const visit = async (entry: string): Promise<void> => {
    const info = await lstat(entry);
    if (info.isSymbolicLink()) throw new Error("Package archives may not contain symbolic links");
    if (info.isFile()) { totalBytes += info.size; if (totalBytes > 100 * 1024 * 1024) throw new Error("Unpacked package exceeds 100 MB"); return; }
    if (info.isDirectory()) for (const child of await readdir(entry)) await visit(path.join(entry, child));
  };
  await visit(root);
}
