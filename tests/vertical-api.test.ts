import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AnkiMetrics, CandidateItem, CurriculumModule, GeneratedItems, VerificationResult } from "@langtut/contracts";
import { buildApp } from "../apps/api/src/app.js";
import type { AnkiGateway, SetupPreview } from "../apps/api/src/anki.js";
import type { ModelGateway } from "../apps/api/src/providers.js";
import { loadCurriculum } from "../packages/domain/src/index.js";

let temporary: string | undefined;
afterEach(async () => { delete process.env.LANGTUT_DB_PATH; if (temporary) await rm(temporary, { recursive: true, force: true }); });

class FakeAnkiGateway implements AnkiGateway {
  notes: CandidateItem[] = [];
  setupApplications = 0;
  async metrics(): Promise<AnkiMetrics> { return { reachable: true, dueReviews: 0, newCards: 0, leeches: 0, lapses7d: 0, version: 6 }; }
  async setupPreview(): Promise<SetupPreview> { return { deck: { name: "test", action: "none" }, models: [] }; }
  async applySetup(): Promise<SetupPreview> { this.setupApplications++; return this.setupPreview(); }
  async addItems(items: CandidateItem[]): Promise<Array<number | null>> { this.notes.push(...items); return items.map((_, index) => this.notes.length + index + 1); }
}

class FakeModels implements ModelGateway {
  private vocab = 0;
  constructor(private readonly module: CurriculumModule) {}
  status() { return { fake: { configured: true } }; }
  async structured<T>(_taskId: string, prompt: string, definitionName: string): Promise<T> {
    if (definitionName === "GeneratedItems") {
      const count = Number(prompt.match(/Erzeuge exakt (\d+)/)?.[1] ?? 1);
      const kind = prompt.match(/ (vocab|chunk|rule)-Lernobjekte/)?.[1] as CandidateItem["kind"];
      const items = Array.from({ length: count }, (_, index): CandidateItem => {
        const sequence = kind === "vocab" ? this.vocab++ : index;
        return {
          itemId: `${this.module.id}:${kind}:${sequence}`, kind, moduleId: this.module.id,
          slovak: kind === "vocab" ? `slovo ${sequence}` : kind === "chunk" ? `fráza ${sequence}` : `pravidlo ${sequence}`,
          german: kind === "vocab" ? `Wort ${sequence}` : kind === "chunk" ? `Wendung ${sequence}` : `Regel ${sequence}`,
          exampleSlovak: `Toto je príklad ${sequence}.`, exampleGerman: `Das ist Beispiel ${sequence}.`, notes: "Eine Lernidee.", tags: [...this.module.focusTags],
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
    throw new Error(`Unexpected fake schema ${definitionName}`);
  }
}

describe("vertical release path with fake integrations", () => {
  it("prepares all notes and unlocks the successor after milestone exposure", async () => {
    temporary = await mkdtemp(path.join(tmpdir(), "langtut-vertical-"));
    process.env.LANGTUT_DB_PATH = path.join(temporary, "vertical.db");
    const module = (await loadCurriculum(process.cwd())).modules[0];
    const anki = new FakeAnkiGateway();
    const app = await buildApp(process.cwd(), { anki, models: new FakeModels(module) });
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
    for (const milestone of module.grammarMilestones) {
      const response = await app.inject({ method: "POST", url: `/api/v1/modules/${module.id}/milestones/${milestone.id}/attempt` });
      expect(response.statusCode).toBe(200);
    }
    const curriculum = (await app.inject({ method: "GET", url: "/api/v1/curriculum" })).json();
    expect(curriculum.modules[0].status).toBe("learning");
    expect(curriculum.modules[1].status).toBe("available");
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
});
