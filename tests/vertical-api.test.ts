import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AnkiMetrics, CandidateItem, CurriculumModule, SessionAnalysis, TutorTurn, VerificationResult } from "@langtut/contracts";
import { buildApp } from "../apps/api/src/app.js";
import type { AnkiGateway, SetupPreview } from "../apps/api/src/anki.js";
import type { ModelGateway } from "../apps/api/src/providers.js";
import type { LocalMtGateway } from "../apps/api/src/local-mt.js";
import { Store } from "../apps/api/src/database.js";
import { loadCurriculum } from "../packages/domain/src/index.js";

let temporary: string | undefined;
afterEach(async () => { delete process.env.LANGTUT_DB_PATH; if (temporary) await rm(temporary, { recursive: true, force: true }); });

class FakeAnkiGateway implements AnkiGateway {
  notes: CandidateItem[] = [];
  removedNoteIds: number[] = [];
  setupApplications = 0;
  async metrics(): Promise<AnkiMetrics> { return { reachable: true, dueReviews: 0, newCards: 0, leeches: 0, lapses7d: 0, version: 6 }; }
  async setupPreview(): Promise<SetupPreview> { return { deck: { name: "test", action: "none" }, models: [] }; }
  async applySetup(): Promise<SetupPreview> { this.setupApplications++; return this.setupPreview(); }
  async addItems(items: CandidateItem[]): Promise<Array<number | null>> { this.notes.push(...items); return items.map((_, index) => this.notes.length + index + 1); }
  async removeNotes(noteIds: number[]): Promise<void> { this.removedNoteIds.push(...noteIds); }
}

class FakeModels implements ModelGateway {
  private vocab = 0;
  readonly vocabularyPrompts: string[] = [];
  reportPrompt = "";
  constructor(private readonly module: CurriculumModule, private readonly failAnalysis = false) {}
  status() { return { fake: { configured: true } }; }
  async structured<T>(taskId: string, prompt: string, definitionName: string): Promise<T> {
    if (definitionName === "GeneratedItems") {
      if (taskId === "vocabulary_generation") this.vocabularyPrompts.push(prompt);
      const count = Number(prompt.match(/Erzeuge exakt (\d+)/)?.[1] ?? 1);
      const kind = prompt.match(/ (vocab|chunk|rule)-Lernobjekte/)?.[1] as CandidateItem["kind"];
      const items = Array.from({ length: count }, (_, index): CandidateItem => {
        const sequence = kind === "vocab" ? this.vocab++ : index;
        return {
          itemId: `${this.module.id}:${kind}:${sequence}`, kind, moduleId: this.module.id,
          target: kind === "vocab" ? `slovo ${sequence}` : kind === "chunk" ? `fráza ${this.module.functions[index]}` : `pravidlo ${this.module.grammarMilestones[index].id}`,
          source: kind === "vocab" ? `Wort ${sequence}` : kind === "chunk" ? `Wendung ${this.module.functions[index]}` : `Regel ${this.module.grammarMilestones[index].id}`,
          exampleTarget: `Toto je príklad ${sequence}.`, exampleSource: `Das ist Beispiel ${sequence}.`, notes: "Eine Lernidee.", tags: [...this.module.focusTags],
          ...(kind === "chunk" ? { functionId: this.module.functions[index] } : {}),
          ...(kind === "rule" ? { milestoneId: this.module.grammarMilestones[index].id } : {}),
        };
      });
      return { items } as T;
    }
    if (definitionName === "VerificationResult") {
      const items = JSON.parse(prompt.slice(prompt.lastIndexOf("\n") + 1)) as CandidateItem[];
      return { results: items.map(({ itemId }) => ({ itemId, approved: true, issues: [] })) } as VerificationResult as T;
    }
    if (definitionName === "TutorTurn") {
      const opening = prompt.includes("Eröffne dieses Rollenspiel");
      const sourceLanguage = prompt.includes("Lernereingabe: Ich bin zu Besuch");
      const farewell = prompt.includes("Lernereingabe: Dovidenia") || prompt.includes("letzte erlaubte Lernendenzug");
      return {
        message: opening ? "Dobrý deň, ako sa voláte?" : farewell ? "Ďakujem za rozhovor. Dovidenia!" : sourceLanguage ? "Aha, ste na návšteve! Čo vás sem priviedlo?" : "Teší ma. Odkiaľ ste?",
        correction: opening ? "" : sourceLanguage ? "Som tu na návšteve." : "Volám sa Anna.", explanation: sourceLanguage ? "Formuliere die Antwort auf Slowakisch." : "", newExample: "",
        errorTags: opening ? [] : sourceLanguage ? ["error_language_switch"] : ["grammar_reflexive"], targetLanguageUse: sourceLanguage ? "source" : "target", goalProgress: opening ? "partial" : sourceLanguage ? "not_met" : "partial", conversationState: farewell ? "completed" : "continue",
      } as TutorTurn as T;
    }
    if (definitionName === "SessionAnalysis") {
      if (this.failAnalysis) throw new Error("analysis unavailable");
      this.reportPrompt = prompt;
      return {
        report: { focusTags: this.module.focusTags, observedErrors: ["Reflexives Verb"], observedStrengths: ["Antwortet verständlich"], languageSwitches: 0, goalCompletionPercent: 50, suggestedReviewItems: [], suggestedNewCards: [], nextSessionSuggestions: ["Vorstellung wiederholen"] },
        profile: { interests: ["Reisen"], strengths: ["Verständliche Antworten"], difficulties: ["Reflexive Verben"], helpfulSupports: ["Kurze Modelle"], priorities: ["Vorstellung"] },
        rapportMarkdown: "# Lernrapport\n\n## Interessen und Präferenzen\n- Reisen\n\n## Stärken\n- Verständliche Antworten\n\n## Schwierigkeiten\n- Reflexive Verben\n\n## Hilfreiche Unterstützung\n- Kurze Modelle\n\n## Aktuelle Prioritäten\n- Vorstellung\n",
      } as SessionAnalysis as T;
    }
    throw new Error(`Unexpected fake schema ${definitionName}`);
  }
}

class FakeLocalMt implements LocalMtGateway {
  private value = { enabled: false, cloudFallback: true };
  installed = false;
  async translate() { return undefined; }
  settings() { return { ...this.value }; }
  configure(value: { enabled: boolean; cloudFallback: boolean }) { this.value = { ...value }; }
  async status() { return { runtime: { available: true }, models: [{ key: "m2m100-418m", license: "MIT", revision: "revision", sizeBytes: 1_940_000_000, status: this.installed ? "installed" : "not_installed" }] }; }
  async install(key: string) { if (key !== "m2m100-418m") throw new Error("unknown model"); this.installed = true; }
}

describe("vertical release path with fake integrations", () => {
  it("exposes, configures and installs the opt-in local MT provider", async () => {
    temporary = await mkdtemp(path.join(tmpdir(), "langtut-local-mt-api-"));
    process.env.LANGTUT_DB_PATH = path.join(temporary, "local-mt.db");
    const module = (await loadCurriculum(process.cwd())).modules[0];
    const localMt = new FakeLocalMt();
    const app = await buildApp(process.cwd(), { anki: new FakeAnkiGateway(), models: new FakeModels(module), localMt });
    expect((await app.inject({ method: "GET", url: "/api/v1/settings" })).json()).toMatchObject({ localMt: { enabled: false, cloudFallback: true } });
    expect((await app.inject({ method: "POST", url: "/api/v1/settings/local-mt", payload: { enabled: true, cloudFallback: false } })).json()).toMatchObject({ localMt: { enabled: true, cloudFallback: false } });
    expect((await app.inject({ method: "POST", url: "/api/v1/settings/local-mt/models/m2m100-418m/install" })).statusCode).toBe(201);
    expect((await app.inject({ method: "GET", url: "/api/v1/status" })).json()).toMatchObject({ providers: { local_mt: { models: [{ key: "m2m100-418m", status: "installed" }] } } });
    await app.close();
  });

  it("prepares all notes and unlocks the successor after milestone exposure", async () => {
    temporary = await mkdtemp(path.join(tmpdir(), "langtut-vertical-"));
    process.env.LANGTUT_DB_PATH = path.join(temporary, "vertical.db");
    const module = (await loadCurriculum(process.cwd())).modules[0];
    const anki = new FakeAnkiGateway();
    const models = new FakeModels(module);
    const app = await buildApp(process.cwd(), { anki, models });
    const start = await app.inject({ method: "POST", url: `/api/v1/modules/${module.id}/prepare` });
    expect(start.statusCode).toBe(202);
    const jobId = start.json().id as string;
    let job: any;
    for (let attempt = 0; attempt < 100; attempt++) {
      job = (await app.inject({ method: "GET", url: `/api/v1/jobs/${jobId}` })).json();
      if (["completed", "failed"].includes(job.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(job.status).toBe("completed");
    expect(anki.setupApplications).toBe(1);
    expect(anki.notes.filter(({ kind }) => kind === "vocab")).toHaveLength(module.vocabTarget);
    expect(anki.notes.filter(({ kind }) => kind === "chunk")).toHaveLength(module.functions.length);
    expect(anki.notes.filter(({ kind }) => kind === "rule")).toHaveLength(module.grammarMilestones.length);
    expect(models.vocabularyPrompts).toHaveLength(Math.ceil(module.vocabTarget / 40));
    expect(models.vocabularyPrompts[0]).not.toContain(module.title);
    expect(models.vocabularyPrompts[0]).not.toContain(module.grammarMilestones[0].description);
    expect(models.vocabularyPrompts[0]).toContain("keine einzelnen Buchstaben oder Zeichen");
    const preparedProgress = (await app.inject({ method: "GET", url: "/api/v1/modules/progress" })).json();
    expect(preparedProgress.modules[module.id]).toEqual({ materialPrepared: true, attemptedMilestoneIds: [] });
    const diagnostics = (await readFile(path.join(temporary, "diagnostics/slowakisch-deutsch.jsonl"), "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line));
    expect(diagnostics.filter(({ event }) => event === "batch_finished")).toHaveLength(Math.ceil(module.vocabTarget / 40));
    expect(diagnostics.some(({ event, importedTotal }) => event === "batch_finished" && importedTotal === module.vocabTarget)).toBe(true);
    for (const milestone of module.grammarMilestones) {
      const response = await app.inject({ method: "POST", url: `/api/v1/modules/${module.id}/milestones/${milestone.id}/attempt` });
      expect(response.statusCode).toBe(200);
    }
    const completedProgress = (await app.inject({ method: "GET", url: "/api/v1/modules/progress" })).json();
    expect(completedProgress.modules[module.id].attemptedMilestoneIds).toEqual(module.grammarMilestones.map(({ id }) => id));
    const curriculum = (await app.inject({ method: "GET", url: "/api/v1/curriculum" })).json();
    expect(curriculum.modules[0].status).toBe("learning");
    expect(curriculum.modules[1].status).toBe("available");
    await app.close();
  });

  it("retracts previously imported metalanguage before filling the vocabulary target", async () => {
    temporary = await mkdtemp(path.join(tmpdir(), "langtut-retract-"));
    const dbPath = path.join(temporary, "retract.db");
    process.env.LANGTUT_DB_PATH = dbPath;
    const module = (await loadCurriculum(process.cwd())).modules[0];
    const wrong: CandidateItem = {
      itemId: "legacy:case", kind: "vocab", moduleId: module.id,
      target: "akuzatív", source: "Akkusativ", exampleTarget: "Toto je akuzatív.", exampleSource: "Das ist der Akkusativ.",
      notes: "Grammatikbezeichnung.", tags: [...module.focusTags],
    };
    const seed = await Store.open(dbPath, process.cwd());
    seed.saveGenerated("slowakisch-deutsch", { itemId: wrong.itemId, moduleId: wrong.moduleId, kind: wrong.kind, normalized: wrong.target, payload: wrong }, "imported", 777);
    seed.close();

    const anki = new FakeAnkiGateway();
    const app = await buildApp(process.cwd(), { anki, models: new FakeModels(module) });
    const started = (await app.inject({ method: "POST", url: `/api/v1/modules/${module.id}/prepare` })).json();
    let job: any;
    for (let attempt = 0; attempt < 100; attempt++) {
      job = (await app.inject({ method: "GET", url: `/api/v1/jobs/${started.id}` })).json();
      if (["completed", "failed"].includes(job.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(job.status).toBe("completed");
    expect(anki.removedNoteIds).toContain(777);
    expect(anki.notes.filter(({ kind }) => kind === "vocab")).toHaveLength(module.vocabTarget);
    const quarantine = (await app.inject({ method: "GET", url: "/api/v1/quarantine" })).json();
    expect(quarantine).toEqual(expect.arrayContaining([expect.objectContaining({ itemId: wrong.itemId, issues: expect.arrayContaining(["vocab_is_metalanguage"]) })]));
    await app.close();
  });

  it("restores a completed placement after an application restart", async () => {
    temporary = await mkdtemp(path.join(tmpdir(), "langtut-placement-"));
    process.env.LANGTUT_DB_PATH = path.join(temporary, "placement.db");
    const module = (await loadCurriculum(process.cwd())).modules[0];
    const first = await buildApp(process.cwd(), { anki: new FakeAnkiGateway(), models: new FakeModels(module) });
    const started = (await first.inject({ method: "POST", url: "/api/v1/placement-sessions" })).json();
    let state = started;
    for (let index = 0; index < 6; index++) {
      state = (await first.inject({ method: "POST", url: `/api/v1/placement-sessions/${started.id}/answers`, payload: { itemId: state.nextItem.id, answer: "falsch" } })).json();
    }
    expect(state.status).toBe("completed");
    await first.close();

    const second = await buildApp(process.cwd(), { anki: new FakeAnkiGateway(), models: new FakeModels(module) });
    const restored = (await second.inject({ method: "GET", url: "/api/v1/placement-sessions/latest" })).json();
    expect(restored).toMatchObject({ id: started.id, status: "completed", itemsAnswered: 6, recommendedModuleId: module.id });
    expect(restored.nextItem).toBeUndefined();
    await second.close();
  });

  it("opens a roleplay before the learner and updates the package rapport on completion", async () => {
    temporary = await mkdtemp(path.join(tmpdir(), "langtut-roleplay-"));
    process.env.LANGTUT_DB_PATH = path.join(temporary, "roleplay.db");
    const module = (await loadCurriculum(process.cwd())).modules[2];
    const models = new FakeModels(module);
    const app = await buildApp(process.cwd(), { anki: new FakeAnkiGateway(), models });
    const started = await app.inject({ method: "POST", url: "/api/v1/sessions", payload: { moduleId: module.id, activityId: "rp-meet-neighbor" } });
    expect(started.statusCode).toBe(201);
    expect(started.json()).toMatchObject({ activity: { type: "roleplay" }, initialTurns: [{ roleId: "neighbor", turn: { message: "Dobrý deň, ako sa voláte?" } }] });
    const sessionId = started.json().id as string;
    await app.inject({ method: "POST", url: `/api/v1/sessions/${sessionId}/activity-turns`, payload: { message: "Ja volám Anna." } });
    const completed = await app.inject({ method: "POST", url: `/api/v1/sessions/${sessionId}/complete` });
    expect(completed.json()).toMatchObject({ observedStrengths: ["Antwortet verständlich"] });
    expect(models.reportPrompt).toContain("Sused: Dobrý deň, ako sa voláte?\nLernender: Ja volám Anna.");
    expect(models.reportPrompt).toContain('"grammar_reflexive":1');
    expect(await readFile(path.join(temporary, "rapports", "slowakisch-deutsch", "rapport.md"), "utf8")).toContain("Reflexive Verben");
    await app.close();
  });

  it("completes the session while preserving the old rapport when analysis fails", async () => {
    temporary = await mkdtemp(path.join(tmpdir(), "langtut-rapport-failure-"));
    const dbPath = path.join(temporary, "failure.db");
    process.env.LANGTUT_DB_PATH = dbPath;
    const module = (await loadCurriculum(process.cwd())).modules[2];
    const app = await buildApp(process.cwd(), { anki: new FakeAnkiGateway(), models: new FakeModels(module, true) });
    const started = (await app.inject({ method: "POST", url: "/api/v1/sessions", payload: { moduleId: module.id, activityId: "rp-meet-neighbor" } })).json();
    await app.inject({ method: "POST", url: `/api/v1/sessions/${started.id}/activity-turns`, payload: { message: "Ja volám Anna." } });
    const completed = await app.inject({ method: "POST", url: `/api/v1/sessions/${started.id}/complete` });
    expect(completed.statusCode).toBe(200);
    expect(completed.json().observedErrors).toEqual(["grammar_reflexive (1)"]);
    await app.close();
    const store = await Store.open(dbPath, process.cwd());
    expect(store.getSession(started.id)?.status).toBe("completed");
    store.close();
    await expect(readFile(path.join(temporary, "rapports", "slowakisch-deutsch", "rapport.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps source-language corrections outside the partner message and deducts them from goal completion", async () => {
    temporary = await mkdtemp(path.join(tmpdir(), "langtut-language-switch-"));
    process.env.LANGTUT_DB_PATH = path.join(temporary, "language.db");
    const module = (await loadCurriculum(process.cwd())).modules[2];
    const models = new FakeModels(module);
    const app = await buildApp(process.cwd(), { anki: new FakeAnkiGateway(), models });
    const started = (await app.inject({ method: "POST", url: "/api/v1/sessions", payload: { moduleId: module.id, activityId: "rp-meet-neighbor" } })).json();
    const turn = await app.inject({ method: "POST", url: `/api/v1/sessions/${started.id}/activity-turns`, payload: { message: "Ich bin zu Besuch" } });
    expect(turn.json()).toMatchObject({ completed: false, turns: [{ turn: { message: "Aha, ste na návšteve! Čo vás sem priviedlo?", correction: "Som tu na návšteve.", targetLanguageUse: "source", goalProgress: "not_met", errorTags: ["error_language_switch"] } }] });
    const report = await app.inject({ method: "POST", url: `/api/v1/sessions/${started.id}/complete` });
    expect(report.json()).toMatchObject({ languageSwitches: 1, goalCompletionPercent: 0 });
    expect(models.reportPrompt).toContain('"languageSwitches":1');
    await app.close();
  });

  it("recognizes a learner farewell, replies in character and returns the report automatically", async () => {
    temporary = await mkdtemp(path.join(tmpdir(), "langtut-farewell-"));
    process.env.LANGTUT_DB_PATH = path.join(temporary, "farewell.db");
    const module = (await loadCurriculum(process.cwd())).modules[2];
    const app = await buildApp(process.cwd(), { anki: new FakeAnkiGateway(), models: new FakeModels(module) });
    const started = (await app.inject({ method: "POST", url: "/api/v1/sessions", payload: { moduleId: module.id, activityId: "rp-meet-neighbor" } })).json();
    const ending = await app.inject({ method: "POST", url: `/api/v1/sessions/${started.id}/activity-turns`, payload: { message: "Dovidenia" } });
    expect(ending.json()).toMatchObject({ completed: true, turns: [{ turn: { message: "Ďakujem za rozhovor. Dovidenia!", conversationState: "completed" } }], report: { goalCompletionPercent: 50 } });
    const rejected = await app.inject({ method: "POST", url: `/api/v1/sessions/${started.id}/activity-turns`, payload: { message: "Ešte raz" } });
    expect(rejected.statusCode).toBe(404);
    await app.close();
  });

  it("closes a six-round roleplay with a partner farewell instead of failing on the next input", async () => {
    temporary = await mkdtemp(path.join(tmpdir(), "langtut-round-ending-"));
    process.env.LANGTUT_DB_PATH = path.join(temporary, "rounds.db");
    const module = (await loadCurriculum(process.cwd())).modules[0];
    const app = await buildApp(process.cwd(), { anki: new FakeAnkiGateway(), models: new FakeModels(module) });
    const started = (await app.inject({ method: "POST", url: "/api/v1/sessions", payload: { moduleId: module.id, activityId: "rp-spelling-desk" } })).json();
    let response: any;
    for (let round = 1; round <= 6; round++) response = (await app.inject({ method: "POST", url: `/api/v1/sessions/${started.id}/activity-turns`, payload: { message: `Odpoveď ${round}` } })).json();
    expect(response).toMatchObject({ completed: true, turns: [{ turn: { message: "Ďakujem za rozhovor. Dovidenia!", conversationState: "completed" } }], report: { goalCompletionPercent: 50 } });
    await app.close();
  });
});
