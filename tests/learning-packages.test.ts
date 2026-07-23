import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LearningPackageRepository, evaluateExercise, loadLearningPackage } from "@langtut/domain";
import { rolesAfterLearner, rolesBeforeLearner } from "../apps/api/src/app.js";
import { Store } from "../apps/api/src/database.js";
import { ContentPipeline } from "../apps/api/src/content-pipeline.js";
import type { AnkiMetrics, CandidateItem, GeneratedItems, VerificationResult } from "@langtut/contracts";
import type { AnkiGateway, SetupPreview } from "../apps/api/src/anki.js";
import type { ModelGateway } from "../apps/api/src/providers.js";

const temporary: string[] = [];
afterEach(async () => { for (const folder of temporary.splice(0)) await rm(folder, { recursive: true, force: true }); });

describe("learning packages", () => {
  it("loads language-neutral vocabulary and a declarative three-role method", async () => {
    const pkg = await loadLearningPackage(path.join(process.cwd(), "examples", "english-norwegian"));
    expect(pkg.curriculum).toMatchObject({ packageId: "english-norwegian-demo", language: "en", sourceLanguage: "nb", vocabTarget: 3 });
    expect(pkg.vocabulary[0]).toMatchObject({ target: "hello", source: "hei" });
    expect(pkg.activities[0].roles).toHaveLength(3);
    expect(rolesAfterLearner(pkg.activities[0])).toEqual(["host", "guest"]);
    expect(rolesBeforeLearner(pkg.activities[0])).toEqual([]);
    expect(pkg.prompts.tutor_conversation).toContain("assigned conversation role");
    const slovak = await loadLearningPackage(path.join(process.cwd(), "learning-packages", "slowakisch-deutsch"));
    const deterministicExercises = slovak.activities.filter(({ type }) => type !== "roleplay");
    expect(deterministicExercises).toHaveLength(6);
    expect(deterministicExercises.every((activity) => activity.evidenceTargets?.length)).toBe(true);
    expect(deterministicExercises.flatMap((activity) => activity.evidenceTargets ?? [])).toEqual(expect.arrayContaining(["function:func_greet", "function:func_ask_info", "grammar:pronouns_personal_nom", "grammar:verb_byt_present", "grammar:phonology_soft_hard"]));
    expect(slovak.activities.find(({ id }) => id === "rp-spelling-desk")?.scenarioTarget).toBeTruthy();
    expect(slovak.curriculum.modules.find(({ id }) => id === "a1_food_restaurant")?.activityIds).toContain("rp-restaurant");
  });

  it("scores exact and missing-diacritic exercise answers deterministically", () => {
    const definition = { prompt: "", answers: ["Dobrý deň"] };
    expect(evaluateExercise("Dobrý deň", definition).outcome).toBe("correct");
    expect(evaluateExercise("Dobry den", definition).outcome).toBe("near_correct");
    expect(evaluateExercise("Ahoj", definition).outcome).toBe("incorrect");
  });

  it("installs a zip and updates the same package id", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "langtut-packages-")); temporary.push(root);
    const builtIn = path.join(root, "learning-packages", "slowakisch-deutsch");
    await mkdir(builtIn, { recursive: true });
    await writeFile(path.join(builtIn, "package.yaml"), "schemaVersion: 1\nid: slowakisch-deutsch\nversion: 1.0.0\nname: Default\ntargetLanguage: {code: sk, name: Slovak}\nsourceLanguage: {code: de, name: German}\ntargetLevel: A1\n");
    await writeFile(path.join(builtIn, "curriculum.yaml"), "version: 1\nmodules:\n  - {id: first, level: A1, title: First, vocabTarget: 1, focusTags: [general]}\n");
    const source = path.join(root, "source"); await cp(path.join(process.cwd(), "examples", "english-norwegian"), source, { recursive: true });
    const zip = path.join(root, "package.zip"); await tar(["-a", "-cf", zip, "-C", source, "."]);
    const repo = new LearningPackageRepository(root); await repo.loadAll(); const installed = await repo.importZip(zip);
    expect(installed.manifest.id).toBe("english-norwegian-demo");
    expect(repo.list("english-norwegian-demo").find(({ active }) => active)?.modules).toBe(1);
  });

  it("keeps progress isolated for equal module ids", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "langtut-store-")); temporary.push(root);
    const store = await Store.open(path.join(root, "test.db"), process.cwd());
    store.setStatus("package-one", "first", "learning"); store.setStatus("package-two", "first", "available");
    expect(store.getProgress("package-one").first).toBe("learning"); expect(store.getProgress("package-two").first).toBe("available");
    store.close();
  });

  it("imports native vocabulary first and asks the LLM only for the missing delta", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "langtut-native-")); temporary.push(root);
    const store = await Store.open(path.join(root, "test.db"), process.cwd());
    const pkg = await loadLearningPackage(path.join(process.cwd(), "examples", "english-norwegian"));
    const anki = new SeedAnki(); const models = new SeedModels(); const job = new ContentPipeline(store, anki, models, pkg).start(pkg.curriculum.modules[0]);
    for (let attempt = 0; attempt < 100 && !["completed", "failed"].includes(store.getJob(job.id)?.status ?? ""); attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(store.getJob(job.id)?.status).toBe("completed"); expect(models.requestedVocab).toEqual([10]);
    expect(anki.items.filter(({ kind }) => kind === "vocab")).toHaveLength(3);
    store.close();
  });
});

function tar(args: string[]): Promise<void> { return new Promise((resolve, reject) => { const child = spawn("tar", args, { windowsHide: true }); let error = ""; child.stderr.on("data", (chunk) => error += chunk); child.on("error", reject); child.on("close", (code) => code === 0 ? resolve() : reject(new Error(error))); }); }

class SeedAnki implements AnkiGateway {
  items: CandidateItem[] = [];
  async metrics(): Promise<AnkiMetrics> { return { reachable: true, dueReviews: 0, newCards: 0, leeches: 0, lapses7d: 0 }; }
  async setupPreview(): Promise<SetupPreview> { return { deck: { name: "test", action: "none" }, models: [] }; }
  async applySetup(): Promise<SetupPreview> { return this.setupPreview(); }
  async addItems(items: CandidateItem[]): Promise<Array<number | null>> { this.items.push(...items); return items.map((_, index) => this.items.length + index + 1); }
  async removeNotes(): Promise<void> {}
  async syncModuleAvailability(): Promise<void> {}
}
class SeedModels implements ModelGateway {
  requestedVocab: number[] = [];
  status() { return {}; }
  async structured<T>(_taskId: string, prompt: string, definitionName: string): Promise<T> {
    if (definitionName === "VerificationResult") { const items = JSON.parse(prompt.slice(prompt.lastIndexOf("\n") + 1)) as CandidateItem[]; return { results: items.map(({ itemId }) => ({ itemId, approved: true, issues: [] })) } as VerificationResult as T; }
    const count = Number(prompt.match(/Erzeuge exakt (\d+)/)?.[1] ?? 1); const kind = prompt.match(/ (vocab|chunk|rule)-Lernobjekte/)?.[1] as CandidateItem["kind"];
    if (kind === "vocab") this.requestedVocab.push(count);
    const items = Array.from({ length: count }, (_, index): CandidateItem => ({ itemId: `generated:${kind}:${index}`, kind, moduleId: "introductions", target: kind === "vocab" ? `word-${index}` : `phrase-${index}`, source: kind === "vocab" ? `ord-${index}` : `frase-${index}`, exampleTarget: "An example.", exampleSource: "Et eksempel.", notes: "Useful.", tags: ["greetings"], ...(kind === "chunk" ? { functionId: "introduce-yourself" } : {}) }));
    return { items } as GeneratedItems as T;
  }
}
