import { readFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";

const root = process.cwd();
const road = YAML.parse(await readFile(path.join(root, "slowakisch_ai_tutor_recovery_bundle/roadmap_a0_b1.yaml"), "utf8"));
const tags = YAML.parse(await readFile(path.join(root, "slowakisch_ai_tutor_recovery_bundle/tag_schema.yaml"), "utf8"));
const focus = YAML.parse(await readFile(path.join(root, "curriculum/module_focus_tags.yaml"), "utf8"));
const openapi = YAML.parse(await readFile(path.join(root, "specs/api/openapi.yaml"), "utf8"));
const contracts = JSON.parse(await readFile(path.join(root, "specs/schemas/contracts.schema.json"), "utf8"));
const modelTasks = YAML.parse(await readFile(path.join(root, "config/model_tasks.yaml"), "utf8"));
const modelPricing = YAML.parse(await readFile(path.join(root, "config/model_pricing.yaml"), "utf8"));
const localMt = YAML.parse(await readFile(path.join(root, "config/local_mt.yaml"), "utf8"));
const ids = new Set(road.modules.map((module) => module.id));
const allowedTags = new Set(Object.values(tags.categories).flat());
const failures = [];
const localMtKeys = new Set();
for (const model of localMt.models ?? []) {
  if (localMtKeys.has(model.key)) failures.push(`local MT model key duplicated: ${model.key}`); else localMtKeys.add(model.key);
  if (!["marian", "m2m100"].includes(model.family)) failures.push(`${model.key}: unsupported local MT family`);
  if (!/^[a-f0-9]{40}$/.test(model.revision ?? "")) failures.push(`${model.key}: local MT revision must be pinned to a commit`);
  if (!model.license || !Number.isFinite(model.size_bytes) || model.size_bytes <= 0 || !Number.isFinite(model.priority)) failures.push(`${model.key}: incomplete local MT metadata`);
  if (!(model.source_languages?.length && model.target_languages?.length)) failures.push(`${model.key}: local MT language directions missing`);
  if (/nllb|madlad/i.test(model.model_id ?? "")) failures.push(`${model.key}: restricted or oversized model must not be a default`);
}
if (road.modules.length !== 23) failures.push(`expected 23 modules, got ${road.modules.length}`);
const total = road.modules.reduce((sum, module) => sum + module.vocab_target, 0);
if (total !== 2000) failures.push(`expected vocabulary target 2000, got ${total}`);
if (ids.size !== road.modules.length) failures.push("module ids are not unique");
const exerciseTypes = new Set([...road.exercise_type_catalog, ...road.modules.flatMap((module) => module.practice_types)]);
if (exerciseTypes.size !== 31 || !exerciseTypes.has("listening_stub")) failures.push(`expected 30 referenced exercises plus listening_stub, got ${exerciseTypes.size}`);
if (openapi.openapi !== "3.1.0") failures.push("OpenAPI must use version 3.1.0");
const requiredPaths = ["/status", "/costs/summary", "/curriculum", "/curriculum/next", "/session-plans", "/placement-sessions", "/sessions", "/quarantine", "/integrations/anki/status", "/integrations/anki/setup/preview", "/integrations/anki/setup/apply"];
for (const route of requiredPaths) if (!openapi.paths?.[route]) failures.push(`OpenAPI path missing: ${route}`);
const openapiText = await readFile(path.join(root, "specs/api/openapi.yaml"), "utf8");
for (const match of openapiText.matchAll(/contracts\.schema\.json#\/definitions\/([A-Za-z0-9_]+)/g)) if (!contracts.definitions[match[1]]) failures.push(`OpenAPI references unknown schema ${match[1]}`);
for (const match of openapiText.matchAll(/\.\.\/schemas\/([a-z-]+\.schema\.json)/g)) {
  const schemaPath = path.join(root, "specs/schemas", match[1]);
  let wrapper;
  try { wrapper = JSON.parse(await readFile(schemaPath, "utf8")); } catch { failures.push(`OpenAPI references missing or invalid schema ${match[1]}`); continue; }
  const definition = wrapper.$ref?.match(/contracts\.schema\.json#\/definitions\/([A-Za-z0-9_]+)/)?.[1];
  if (definition && !contracts.definitions[definition]) failures.push(`${match[1]} references unknown definition ${definition}`);
}
for (const [taskId, task] of Object.entries(modelTasks.tasks)) {
  if (!Object.values(task).every((value) => value !== undefined && value !== null)) failures.push(`${taskId}: incomplete model task`);
  const schemaName = Object.keys(contracts.definitions).find((name) => name.replace(/[A-Z]/g, (letter, index) => `${index ? "-" : ""}${letter.toLowerCase()}`) === task.schema);
  if (!schemaName) failures.push(`${taskId}: unknown output schema alias ${task.schema}`);
  const pricing = modelPricing.models?.[task.model];
  if (!pricing) failures.push(`${taskId}: missing pricing for ${task.model}`);
  else if (![pricing.input_per_million, pricing.cached_input_per_million, pricing.output_per_million].every((value) => Number.isFinite(value) && value >= 0)) failures.push(`${taskId}: invalid pricing for ${task.model}`);
}
for (const module of road.modules) {
  for (const prerequisite of module.prerequisites) if (!ids.has(prerequisite)) failures.push(`${module.id}: missing prerequisite ${prerequisite}`);
  const assigned = focus.modules[module.id];
  if (!assigned || assigned.length < 1 || assigned.length > 3) failures.push(`${module.id}: invalid focus tag assignment`);
  for (const tag of assigned ?? []) if (!allowedTags.has(tag)) failures.push(`${module.id}: unknown focus tag ${tag}`);
}
const visiting = new Set();
const visited = new Set();
const byId = new Map(road.modules.map((module) => [module.id, module]));
function visit(id) {
  if (visiting.has(id)) failures.push(`prerequisite cycle at ${id}`);
  if (visited.has(id)) return;
  visiting.add(id);
  for (const prerequisite of byId.get(id)?.prerequisites ?? []) visit(prerequisite);
  visiting.delete(id);
  visited.add(id);
}
for (const id of ids) visit(id);
if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(`Specs valid: ${road.modules.length} modules, ${total} vocabulary items, ${exerciseTypes.size} exercise types, ${allowedTags.size} official tags.`);
