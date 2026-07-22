import { access, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import path from "node:path";
import YAML from "yaml";

const input = process.argv[2];
if (!input) { console.error("Usage: npm run package:validate -- <folder-or-zip>"); process.exit(2); }
let root = path.resolve(input); let temporary;
try {
  if ((await stat(root)).isFile()) {
    temporary = await mkdtemp(path.join(tmpdir(), "langtut-package-"));
    const entries = (await tar(["-tf", root])).split(/\r?\n/).filter(Boolean);
    for (const entry of entries) { const normalized = entry.replace(/\\/g, "/"); if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized) || normalized.split("/").includes("..")) throw new Error(`Unsafe archive path: ${entry}`); }
    await tar(["-xf", root, "-C", temporary]); root = temporary;
    if (!(await exists(path.join(root, "package.yaml")))) { const children = await readdir(root); if (children.length !== 1) throw new Error("package.yaml not found at a unique package root"); root = path.join(root, children[0]); }
  }
  const manifest = YAML.parse(await readFile(path.join(root, "package.yaml"), "utf8"));
  if (manifest?.schemaVersion !== 1 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(manifest.id ?? "") || !manifest.version || !manifest.name || !manifest.targetLanguage?.code || !manifest.sourceLanguage?.code || !manifest.targetLevel) throw new Error("Invalid or incomplete package.yaml");
  const curriculum = YAML.parse(await readFile(path.join(root, "curriculum.yaml"), "utf8"));
  const modules = curriculum?.modules ?? []; if (!modules.length) throw new Error("curriculum.yaml needs modules");
  const ids = new Set(); for (const module of modules) { if (!module.id || ids.has(module.id)) throw new Error(`Duplicate or missing module id: ${module.id}`); ids.add(module.id); }
  const visiting = new Set(); const visited = new Set();
  const byId = new Map(modules.map((module) => [module.id, module]));
  const visit = (id) => { if (visiting.has(id)) throw new Error(`Prerequisite cycle at ${id}`); if (visited.has(id)) return; visiting.add(id); for (const dep of byId.get(id)?.prerequisites ?? []) { if (!ids.has(dep)) throw new Error(`${id} references unknown prerequisite ${dep}`); visit(dep); } visiting.delete(id); visited.add(id); };
  for (const id of ids) visit(id);
  const knownPrompts = new Set(["vocabulary_generation", "chunk_generation", "rule_generation", "content_verification", "placement_open_response", "tutor_conversation", "session_report"]);
  if (await exists(path.join(root, "prompts.yaml"))) for (const key of Object.keys(YAML.parse(await readFile(path.join(root, "prompts.yaml"), "utf8")) ?? {})) if (!knownPrompts.has(key)) throw new Error(`Unknown prompt key: ${key}`);
  if (await exists(path.join(root, "vocabulary.yaml"))) { const doc = YAML.parse(await readFile(path.join(root, "vocabulary.yaml"), "utf8")); for (const item of (Array.isArray(doc) ? doc : doc.items ?? [])) if (!item.itemId || !ids.has(item.moduleId) || !item.target || !item.source) throw new Error(`Invalid vocabulary item: ${item.itemId ?? "<missing>"}`); }
  if (await exists(path.join(root, "activities.yaml"))) { const doc = YAML.parse(await readFile(path.join(root, "activities.yaml"), "utf8")); const activityIds = new Set(); for (const activity of doc.activities ?? []) { if (!activity.id || activityIds.has(activity.id)) throw new Error(`Duplicate activity: ${activity.id}`); activityIds.add(activity.id); const roles = new Set((activity.roles ?? []).map((role) => role.id)); if (!activity.turnOrder?.length || activity.turnOrder.length !== roles.size || activity.turnOrder.some((id) => !roles.has(id))) throw new Error(`${activity.id}: invalid turn order`); if (activity.type === "roleplay") { const learnerIndex = activity.turnOrder.findIndex((id) => (activity.roles ?? []).find((role) => role.id === id)?.controller === "learner"); if (!activity.scenarioTarget?.trim() || !activity.scenarioSource?.trim() || learnerIndex < 1 || !activity.turnOrder.slice(0, learnerIndex).some((id) => (activity.roles ?? []).find((role) => role.id === id)?.controller === "llm")) throw new Error(`${activity.id}: invalid roleplay opening or scenario`); } for (const moduleId of activity.moduleIds ?? []) if (!ids.has(moduleId)) throw new Error(`${activity.id}: unknown module ${moduleId}`); for (const role of activity.roles ?? []) { if (!new Set(["learner", "llm", "fixed"]).has(role.controller)) throw new Error(`${activity.id}: invalid controller ${role.controller}`); if (role.controller === "llm" && role.prompt && !knownPrompts.has(role.prompt)) throw new Error(`${activity.id}: unknown prompt ${role.prompt}`); if (role.controller === "fixed" && !role.message) throw new Error(`${activity.id}: fixed role needs message`); } } }
  console.log(`Valid learning package: ${manifest.id}@${manifest.version} (${modules.length} modules)`);
} catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
finally { if (temporary) await rm(temporary, { recursive: true, force: true }); }

async function exists(file) { try { await access(file); return true; } catch { return false; } }
function tar(args) { return new Promise((resolve, reject) => { const child = spawn("tar", args, { windowsHide: true }); let out = ""; let err = ""; child.stdout.on("data", (value) => out += value); child.stderr.on("data", (value) => err += value); child.on("error", reject); child.on("close", (code) => code === 0 ? resolve(out) : reject(new Error(err || `tar exited with ${code}`))); }); }
