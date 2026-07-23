import YAML from "yaml";
import type { CandidateItem, Curriculum, CurriculumModule, ModuleStatus } from "@langtut/contracts";

export const DEFAULT_PACKAGE_ID = "slowakisch-deutsch";
export interface LanguageDescriptor { code: string; name: string }
export interface LearningPackageManifest { schemaVersion: 1; id: string; version: string; name: string; targetLanguage: LanguageDescriptor; sourceLanguage: LanguageDescriptor; targetLevel: string; ankiDeck?: string }
export interface ActivityRole { id: string; label: string; controller: "learner" | "llm" | "fixed"; prompt?: string; message?: string }
export interface LearningActivity { id: string; title: string; description?: string; type?: "roleplay" | import("./exercises.js").ExerciseType; scenarioTarget?: string; scenarioSource?: string; exercise?: import("./exercises.js").ExerciseDefinition; roles: ActivityRole[]; turnOrder: string[]; rounds: number; focusTags?: string[]; evidenceTargets?: string[]; moduleIds?: string[] }
export interface PlacementItemDefinition { id: string; level: string; prompt: string; expected: string[]; tag: string; kind?: "production" | "recognition" | "open"; choices?: string[] }
export interface PackageDocuments { package: string; curriculum: string; prompts?: string; activities?: string; placement?: string; vocabulary?: string }
export interface PortableLearningPackage { manifest: LearningPackageManifest; curriculum: Curriculum; prompts: Record<string, string>; activities: LearningActivity[]; placement: PlacementItemDefinition[]; vocabulary: CandidateItem[]; allowedTags: string[]; capabilities: { placement: boolean; nativeVocabulary: boolean; customPrompts: boolean; activities: boolean } }

type RawModule = { id: string; cefr?: string; level?: string; displayLevel?: string; title: string; vocab_target?: number; vocabTarget?: number; vocab_domains?: string[]; vocabDomains?: string[]; functions?: string[]; grammar_milestones?: Array<{ id: string; description: string }>; grammarMilestones?: Array<{ id: string; description: string }>; practice_types?: string[]; practiceTypes?: string[]; prerequisites?: string[]; exit_criteria?: string[]; exitCriteria?: string[]; focus_tags?: string[]; focusTags?: string[]; activities?: string[] };
const promptDefaults: Record<string, string> = {
  vocabulary_generation: "Erzeuge hochwertige Lernobjekte für {{targetLanguage}} mit Erklärungen auf {{sourceLanguage}}.", chunk_generation: "Erzeuge natürliche Wendungen in {{targetLanguage}} mit Erklärungen auf {{sourceLanguage}}.", rule_generation: "Erzeuge verständliche Regeln für {{targetLanguage}} mit Erklärungen auf {{sourceLanguage}}.", content_verification: "Prüfe Korrektheit und Natürlichkeit für {{targetLanguage}} und {{sourceLanguage}}.", placement_open_response: "Bewerte die freie Antwort in {{targetLanguage}}.", tutor_conversation: "Du bist ein geduldiger Tutor für {{targetLanguage}}. Erkläre knapp auf {{sourceLanguage}}.", session_report: "Fasse die beobachteten Lernsignale präzise zusammen.",
};

export function parseLearningPackage(documents: PackageDocuments): PortableLearningPackage {
  const manifest = YAML.parse(documents.package) as LearningPackageManifest;
  if (manifest?.schemaVersion !== 1 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(manifest.id ?? "")) throw new Error("Ungültiges Lernpaket-Manifest");
  const raw = YAML.parse(documents.curriculum) as Record<string, any>; const rawModules = (raw.modules ?? []) as RawModule[];
  if (!rawModules.length) throw new Error("curriculum.yaml muss mindestens ein Modul enthalten");
  const ids = new Set<string>();
  const modules: CurriculumModule[] = rawModules.map((value, index) => {
    if (!value.id || ids.has(value.id)) throw new Error(`Doppelte oder fehlende Modul-ID: ${value.id ?? "<missing>"}`); ids.add(value.id);
    const cefr = value.cefr ?? value.level ?? value.displayLevel ?? "1"; const domains = value.vocab_domains ?? value.vocabDomains ?? [];
    return { id: value.id, cefr, displayLevel: value.displayLevel ?? (cefr === "A0" ? "Pre-A1" : cefr), title: value.title, vocabTarget: value.vocab_target ?? value.vocabTarget ?? 1, vocabDomains: domains, functions: value.functions ?? [], grammarMilestones: value.grammar_milestones ?? value.grammarMilestones ?? [], practiceTypes: value.practice_types ?? value.practiceTypes ?? [], prerequisites: value.prerequisites ?? [], exitCriteria: value.exit_criteria ?? value.exitCriteria ?? [], focusTags: value.focus_tags ?? value.focusTags ?? domains.slice(0, 3).map(slugTag), activityIds: value.activities ?? [], status: index === 0 ? "available" as ModuleStatus : "locked" as ModuleStatus };
  });
  validateGraph(modules);
  const curriculum: Curriculum = { packageId: manifest.id, version: String(raw.version ?? manifest.version), language: manifest.targetLanguage.code, sourceLanguage: manifest.sourceLanguage.code, targetLevel: manifest.targetLevel, vocabTarget: Number(raw.global_targets?.estimated_total_vocab_new_items ?? raw.vocabTarget ?? modules.reduce((sum, module) => sum + module.vocabTarget, 0)), exerciseTypes: [...new Set([...(raw.exercise_type_catalog ?? raw.exerciseTypes ?? []), ...modules.flatMap((module) => module.practiceTypes)])].sort() as string[], modules };
  const prompts = { ...promptDefaults, ...(documents.prompts ? YAML.parse(documents.prompts) : {}) };
  const activityDoc = documents.activities ? YAML.parse(documents.activities) as { activities?: LearningActivity[] } : {}; const activities = activityDoc.activities ?? [];
  const activityIds = new Set(activities.map(({ id }) => id));
  for (const activity of activities) { if (!activity.id || !activity.roles?.length || !activity.turnOrder?.length || !Number.isInteger(activity.rounds) || activity.rounds < 1) throw new Error(`Ungültige Aktivität: ${activity.id ?? "<missing>"}`); for (const moduleId of activity.moduleIds ?? []) { const module = modules.find(({ id }) => id === moduleId); if (!module) throw new Error(`${activity.id}: unbekanntes Modul ${moduleId}`); module.activityIds = [...new Set([...(module.activityIds ?? []), activity.id])]; } }
  for (const module of modules) for (const id of module.activityIds ?? []) if (!activityIds.has(id)) throw new Error(`${module.id}: unbekannte Aktivität ${id}`);
  const placementDoc = documents.placement ? YAML.parse(documents.placement) as { items?: PlacementItemDefinition[] } | PlacementItemDefinition[] : [];
  const vocabularyDoc = documents.vocabulary ? YAML.parse(documents.vocabulary) as { items?: CandidateItem[] } | CandidateItem[] : [];
  const placement = Array.isArray(placementDoc) ? placementDoc : placementDoc.items ?? []; const vocabulary = Array.isArray(vocabularyDoc) ? vocabularyDoc : vocabularyDoc.items ?? [];
  const allowedTags = [...new Set([...modules.flatMap((module) => module.focusTags), ...vocabulary.flatMap((item) => item.tags)])];
  return { manifest, curriculum, prompts, activities, placement, vocabulary, allowedTags, capabilities: { placement: placement.length > 0, nativeVocabulary: vocabulary.length > 0, customPrompts: Boolean(documents.prompts), activities: activities.length > 0 } };
}

export function renderPackagePrompt(template: string, pkg: PortableLearningPackage, values: Record<string, string> = {}): string {
  const context = { targetLanguage: pkg.manifest.targetLanguage.name, sourceLanguage: pkg.manifest.sourceLanguage.name, targetLanguageCode: pkg.manifest.targetLanguage.code, sourceLanguageCode: pkg.manifest.sourceLanguage.code, ...values };
  return template.replace(/\{\{([A-Za-z][A-Za-z0-9]*)\}\}/g, (_match, key: keyof typeof context) => context[key] ?? "");
}
function validateGraph(modules: CurriculumModule[]) { const byId = new Map(modules.map((module) => [module.id, module])); const visiting = new Set<string>(); const visited = new Set<string>(); const visit = (id: string) => { if (visiting.has(id)) throw new Error(`Zyklus bei ${id}`); if (visited.has(id)) return; visiting.add(id); for (const parent of byId.get(id)?.prerequisites ?? []) { if (!byId.has(parent)) throw new Error(`${id}: unbekannte Voraussetzung ${parent}`); visit(parent); } visiting.delete(id); visited.add(id); }; for (const id of byId.keys()) visit(id); }
function slugTag(value: string): string { return value.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || "general"; }
