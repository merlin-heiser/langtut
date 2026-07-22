import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AnkiMetrics, CandidateItem } from "@langtut/contracts";
import { createLocalLangtutClient, type RuntimeAnkiBridge, type RuntimePersistence, type RuntimeProviderBridge, type RuntimeState } from "@langtut/runtime";
import { buildApp } from "../apps/api/src/app.js";
import { createHttpLangtutClient } from "../apps/web/src/http-client.js";

class MemoryPersistence implements RuntimePersistence {
  value?: RuntimeState;
  async load() { return this.value ? structuredClone(this.value) : undefined; }
  async save(state: RuntimeState) { this.value = structuredClone(state); }
}
class ProviderMock implements RuntimeProviderBridge {
  configured = { openai: false, gemini: false };
  async status() { return this.configured; }
  async setKey(provider: "openai" | "gemini") { this.configured[provider] = true; }
  async request() {
    const turn = { message: "Dobrý deň!", correction: "", explanation: "", newExample: "", errorTags: [], targetLanguageUse: "target", goalProgress: "partial", conversationState: "continue" };
    return { status: 200, body: JSON.stringify({ output: [{ content: [{ type: "output_text", text: JSON.stringify(turn) }] }], usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens: 5 } }) };
  }
}
class AnkiMock implements RuntimeAnkiBridge {
  async metrics(): Promise<AnkiMetrics> { return { reachable: true, version: 2, dueReviews: 0, newCards: 0, leeches: 0, lapses7d: 0 }; }
  async setupPreview(_packageId: string, deck: string) { return { deck: { name: deck, action: "none" as const }, models: [] }; }
  async applySetup(packageId: string, deck: string) { return this.setupPreview(packageId, deck); }
  async addItems(_packageId: string, _deck: string, items: CandidateItem[]) { return items.map((_item, index) => index + 1); }
  async removeNotes() {}
}

async function fixture(persistence = new MemoryPersistence(), providers = new ProviderMock()) {
  const root = process.cwd(); const read = (file: string) => readFile(path.join(root, file), "utf8");
  const [packageYaml, curriculumYaml, promptsYaml, activitiesYaml, placementYaml, modelTasksYaml, modelPricingYaml, contractsRaw] = await Promise.all([
    read("learning-packages/slowakisch-deutsch/package.yaml"), read("learning-packages/slowakisch-deutsch/curriculum.yaml"), read("learning-packages/slowakisch-deutsch/prompts.yaml"), read("learning-packages/slowakisch-deutsch/activities.yaml"), read("learning-packages/slowakisch-deutsch/placement.yaml"), read("config/model_tasks.yaml"), read("config/model_pricing.yaml"), read("specs/schemas/contracts.schema.json"),
  ]);
  const client = await createLocalLangtutClient({ builtInPackage: { package: packageYaml, curriculum: curriculumYaml, prompts: promptsYaml, activities: activitiesYaml, placement: placementYaml }, modelTasksYaml, modelPricingYaml, contractsSchema: JSON.parse(contractsRaw), persistence, providers, anki: new AnkiMock() });
  return { client, persistence, providers };
}

describe("shared local runtime", () => {
  it("persists placement and reconstructs it without a backend", async () => {
    const persistence = new MemoryPersistence(); const first = await fixture(persistence);
    const placement = await first.client.startPlacement();
    expect(placement.nextItem?.id).toBe("p1");
    const answered = await first.client.answerPlacement(placement.id, "p1", "Dobrý deň");
    expect(answered.itemsAnswered).toBe(1);
    const second = await fixture(persistence);
    expect((await second.client.latestPlacement())?.itemsAnswered).toBe(1);
    expect((await second.client.settings()).anki.mode).toBe("ankidroid");
  });

  it("uses local provider credentials and the direct session runtime", async () => {
    const { client, providers } = await fixture();
    await client.saveProviderKey("openai", "secret");
    expect(providers.configured.openai).toBe(true);
    const plan = await client.createSessionPlan();
    const session = await client.startSession({ planId: plan.id, moduleId: plan.primaryModuleId ?? undefined, activityId: "rp-spelling-desk" });
    expect(session.initialTurns?.[0]?.turn.message).toBe("Dobrý deň!");
    const result = await client.activityTurn(session.id, "Dobrý deň");
    expect(result.turns[0].turn.message).toBe("Dobrý deň!");
    expect((await client.costs()).totalInputTokens).toBeGreaterThan(0);
  });

  it("keeps the direct and HTTP bindings conformant for the learning entry flow", async () => {
    const direct = (await fixture()).client;
    const temporary = await mkdtemp(path.join(tmpdir(), "langtut-client-contract-"));
    const previousDb = process.env.LANGTUT_DB_PATH;
    process.env.LANGTUT_DB_PATH = path.join(temporary, "contract.db");
    const app = await buildApp(process.cwd(), {
      anki: {
        metrics: async () => ({ reachable: true, dueReviews: 0, newCards: 0, leeches: 0, lapses7d: 0 }),
        setupPreview: async () => ({ deck: { name: "test", action: "none" }, models: [] }),
        applySetup: async () => ({ deck: { name: "test", action: "none" }, models: [] }),
        addItems: async (items: CandidateItem[]) => items.map((_item, index) => index + 1), removeNotes: async () => undefined,
      },
      models: { status: () => ({ fake: { configured: true } }), structured: async () => { throw new Error("not used by entry-flow contract"); } },
      localMt: { translate: async () => undefined, settings: () => ({ enabled: false, cloudFallback: true }), configure: () => undefined, status: async () => ({ runtime: { available: false }, models: [] }), install: async () => undefined },
    });
    const fetcher: typeof fetch = async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      const response = await app.inject({ method: (init?.method ?? "GET") as any, url: `${url.pathname}${url.search}`, payload: typeof init?.body === "string" ? init.body : undefined, headers: init?.headers as any });
      return new Response(response.body, { status: response.statusCode });
    };
    const http = createHttpLangtutClient("http://langtut.test/api/v1", fetcher);
    try {
      for (const client of [direct, http]) {
        const packages = await client.packages();
        expect(packages.packages.filter(({ active }) => active)).toHaveLength(1);
        expect((await client.curriculum()).modules).toHaveLength(23);
        expect(Object.keys((await client.moduleProgress()).modules)).toHaveLength(23);
        const placement = await client.startPlacement();
        expect(placement.nextItem?.id).toBe("p1");
        expect((await client.answerPlacement(placement.id, "p1", "Dobrý deň")).itemsAnswered).toBe(1);
      }
    } finally {
      await app.close();
      if (previousDb === undefined) delete process.env.LANGTUT_DB_PATH; else process.env.LANGTUT_DB_PATH = previousDb;
      await rm(temporary, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });
});
