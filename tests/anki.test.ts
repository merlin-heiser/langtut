import { describe, expect, it } from "vitest";
import { AnkiClient, modelDefinitions } from "../apps/api/src/anki.js";

class FakeAnki extends AnkiClient {
  decks = new Set<string>();
  models = new Map<string, { fields: string[]; css: string; templates: Record<string, { Front: string; Back: string }> }>();
  addedNotes: unknown[] = [];
  queries: string[] = [];
  constructor() { super("fake://anki", "Slovak Tutor"); }

  override async invoke<T>(action: string, params: Record<string, any> = {}): Promise<T> {
    if (action === "version") return 6 as T;
    if (action === "findNotes") return [] as T;
    if (action === "addTags") return undefined as T;
    if (action === "findCards") { this.queries.push(params.query); return [] as T; }
    if (action === "modelNames") return [...this.models.keys()] as T;
    if (action === "deckNames") return [...this.decks] as T;
    if (action === "createDeck") { this.decks.add(params.deck); return 1 as T; }
    if (action === "modelFieldNames") return [...this.models.get(params.modelName)!.fields] as T;
    if (action === "modelStyling") return { css: this.models.get(params.modelName)!.css } as T;
    if (action === "modelTemplates") return this.models.get(params.modelName)!.templates as T;
    if (action === "createModel") {
      this.models.set(params.modelName, { fields: params.inOrderFields, css: params.css, templates: Object.fromEntries(params.cardTemplates.map((template: any) => [template.Name, { Front: template.Front, Back: template.Back }])) });
      return 1 as T;
    }
    if (action === "canAddNotes") return params.notes.map(() => true) as T;
    if (action === "addNotes") { this.addedNotes.push(...params.notes); return params.notes.map((_: unknown, index: number) => index + 100) as T; }
    throw new Error(`Unsupported fake action ${action}`);
  }
}

describe("managed Anki models", () => {
  it("previews, applies and then reports an idempotent setup", async () => {
    const anki = new FakeAnki();
    expect((await anki.setupPreview()).models.every(({ action }) => action === "create")).toBe(true);
    const applied = await anki.applySetup();
    expect(applied.deck.action).toBe("none");
    expect(applied.models.every(({ action }) => action === "none")).toBe(true);
    expect(modelDefinitions[0].templates).toHaveLength(2);
  });

  it("does not modify a same-named foreign model", async () => {
    const anki = new FakeAnki();
    anki.models.set("LangtutVocabV1", { fields: ["Front"], css: ".card{}", templates: {} });
    const preview = await anki.setupPreview();
    expect(preview.models.find(({ name }) => name === "LangtutVocabV1")?.action).toBe("conflict");
    await expect(anki.applySetup()).rejects.toThrow(/Sentinel/);
  });

  it("scopes every planner metric to Langtut cards", async () => {
    const anki = new FakeAnki();
    await anki.metrics();
    expect(anki.queries).toHaveLength(4);
    expect(anki.queries.every((query) => query.includes("tag:langtut"))).toBe(true);
    expect(anki.queries.every((query) => query.includes("tag:package::slowakisch-deutsch"))).toBe(true);
  });

  it("only releases vocabulary cards for a learning module", async () => {
    const anki = new FakeAnki();
    await anki.syncModuleAvailability("slowakisch-deutsch", ["b1-final"]);
    expect(anki.queries).toContain("tag:langtut tag:package::slowakisch-deutsch tag:module::b1-final tag:kind::vocab");
  });

  it("tags function and grammar notes with their evidence targets", async () => {
    const anki = new FakeAnki();
    await anki.addItems([{ itemId: "function", kind: "chunk", moduleId: "m1", target: "Ahoj", source: "Hallo", exampleTarget: "", exampleSource: "", notes: "", tags: [], functionId: "func_greet" }, { itemId: "grammar", kind: "rule", moduleId: "m1", target: "Regel", source: "Regel", exampleTarget: "", exampleSource: "", notes: "", tags: [], milestoneId: "verb_byt" }]);
    expect((anki.addedNotes[0] as { tags: string[] }).tags).toContain("target::function::func_greet");
    expect((anki.addedNotes[1] as { tags: string[] }).tags).toContain("target::grammar::verb_byt");
  });
});
