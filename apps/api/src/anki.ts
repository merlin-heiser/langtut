import type { AnkiMetrics, CandidateItem } from "@langtut/contracts";

type InvokeResponse<T> = { result: T; error: string | null };

export interface AnkiGateway {
  configurePackage?(packageId: string, deck: string): void;
  metrics(): Promise<AnkiMetrics>;
  setupPreview(): Promise<SetupPreview>;
  applySetup(): Promise<SetupPreview>;
  addItems(items: CandidateItem[]): Promise<Array<number | null>>;
  removeNotes(noteIds: number[]): Promise<void>;
  activateNotes?(noteIds: number[]): Promise<void>;
  cardProgress?(packageId: string, moduleId: string): Promise<{ total: number; statuses: Record<"suspended" | "new" | "learning" | "fresh" | "mature", number>; dueAutomatic: number; difficultVocab: number }>;
  nextAutomaticCard?(packageId: string, moduleId: string, target?: string): Promise<number | null>;
  gradeAutomaticCard?(cardId: number, outcome: "good" | "again"): Promise<boolean>;
  syncModuleAvailability?(packageId: string, learningModuleIds: string[]): Promise<void>;
}

export class AnkiClient implements AnkiGateway {
  private packageId = "slowakisch-deutsch";
  constructor(private readonly url: string, private deck: string, private key?: string) {}

  configureKey(key?: string): void { this.key = key; }
  configurePackage(packageId: string, deck: string): void { this.packageId = packageId; this.deck = deck; }

  async invoke<T>(action: string, params: Record<string, unknown> = {}): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    try {
      const response = await fetch(this.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, version: 6, params, ...(this.key ? { key: this.key } : {}) }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`AnkiConnect HTTP ${response.status}`);
      const body = await response.json() as InvokeResponse<T>;
      if (body.error) throw new Error(body.error);
      return body.result;
    } finally {
      clearTimeout(timer);
    }
  }

  async metrics(): Promise<AnkiMetrics> {
    try {
      const version = await this.invoke<number>("version");
      if (this.packageId === "slowakisch-deutsch") {
        const legacy = await this.invoke<number[]>("findNotes", { query: "tag:langtut -tag:package::*" });
        if (legacy.length) await this.invoke("addTags", { notes: legacy, tags: `package::${this.packageId}` });
      }
      const packageQuery = `tag:langtut tag:package::${this.packageId}`;
      const [due, fresh, leeches, lapses] = await Promise.all([
        this.invoke<number[]>("findCards", { query: `${packageQuery} is:due` }),
        this.invoke<number[]>("findCards", { query: `${packageQuery} is:new` }),
        this.invoke<number[]>("findCards", { query: `${packageQuery} tag:leech` }),
        this.invoke<number[]>("findCards", { query: `${packageQuery} rated:7:1` }),
      ]);
      return { reachable: true, version, dueReviews: due.length, newCards: fresh.length, leeches: leeches.length, lapses7d: lapses.length };
    } catch (error) {
      return { reachable: false, dueReviews: 0, newCards: 0, leeches: 0, lapses7d: 0, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async setupPreview(): Promise<SetupPreview> {
    const modelNames = await this.invoke<string[]>("modelNames");
    const deckNames = await this.invoke<string[]>("deckNames");
    const models: ModelPreview[] = [];
    for (const definition of modelDefinitions) {
      if (!modelNames.includes(definition.name)) {
        models.push({
          name: definition.name,
          action: "create",
          fields: definition.fields,
          templates: Object.fromEntries(definition.templates.map((template) => [template.Name, { Front: template.Front, Back: template.Back }])),
          css: definition.css,
          changes: ["fields", "templates", "css"],
          managed: true,
        });
        continue;
      }
      const [fields, styling] = await Promise.all([
        this.invoke<string[]>("modelFieldNames", { modelName: definition.name }),
        this.invoke<{ css: string }>("modelStyling", { modelName: definition.name }),
      ]);
      const templates = await this.invoke<Record<string, { Front: string; Back: string }>>("modelTemplates", { modelName: definition.name });
      const managed = styling.css.includes(MANAGED_SENTINEL);
      const expectedTemplates = Object.fromEntries(definition.templates.map((template) => [template.Name, { Front: template.Front, Back: template.Back }]));
      const changes = [
        ...(JSON.stringify(fields) === JSON.stringify(definition.fields) ? [] : ["fields"]),
        ...(styling.css === definition.css ? [] : ["css"]),
        ...(JSON.stringify(templates) === JSON.stringify(expectedTemplates) ? [] : ["templates"]),
      ];
      models.push({ name: definition.name, action: !managed ? "conflict" : changes.length ? "update" : "none", fields: definition.fields, templates: expectedTemplates, css: definition.css, changes, managed });
    }
    return { deck: { name: this.deck, action: deckNames.includes(this.deck) ? "none" : "create" }, models };
  }

  async applySetup(): Promise<SetupPreview> {
    const preview = await this.setupPreview();
    const conflict = preview.models.find((model) => model.action === "conflict");
    if (conflict) throw new Error(`${conflict.name} existiert ohne Langtut-Sentinel und wird nicht verändert.`);
    if (preview.deck.action === "create") await this.invoke("createDeck", { deck: this.deck });
    for (const model of preview.models) {
      const definition = modelDefinitions.find((entry) => entry.name === model.name)!;
      if (model.action === "create") {
        await this.invoke("createModel", {
          modelName: definition.name,
          inOrderFields: definition.fields,
          css: definition.css,
          isCloze: false,
          cardTemplates: definition.templates,
        });
      } else if (model.action === "update") {
        const currentFields = await this.invoke<string[]>("modelFieldNames", { modelName: definition.name });
        for (const fieldName of definition.fields.filter((field) => !currentFields.includes(field))) {
          await this.invoke("modelFieldAdd", { modelName: definition.name, fieldName });
        }
        await this.invoke("updateModelStyling", { model: { name: definition.name, css: definition.css } });
        await this.invoke("updateModelTemplates", {
          model: { name: definition.name, templates: Object.fromEntries(definition.templates.map((template) => [template.Name, { Front: template.Front, Back: template.Back }])) },
        });
      }
    }
    return this.setupPreview();
  }

  async addItems(items: CandidateItem[]): Promise<Array<number | null>> {
    const notes = items.map((item) => ({
      deckName: this.deck,
      modelName: modelNameFor(item.kind),
      fields: fieldsFor(item, this.packageId),
      tags: ["langtut", `package::${this.packageId}`, `module::${item.moduleId}`, `kind::${item.kind}`, ...(item.functionId ? [`target::function::${item.functionId}`] : []), ...(item.milestoneId ? [`target::grammar::${item.milestoneId}`] : []), ...item.tags],
      options: { allowDuplicate: false, duplicateScope: "deck" },
    }));
    const canAdd = await this.invoke<boolean[]>("canAddNotes", { notes });
    const accepted = notes.filter((_, index) => canAdd[index]);
    const ids = accepted.length ? await this.invoke<Array<number | null>>("addNotes", { notes: accepted }) : [];
    let cursor = 0;
    return canAdd.map((allowed) => allowed ? ids[cursor++] ?? null : null);
  }

  async removeNotes(noteIds: number[]): Promise<void> {
    if (noteIds.length) await this.invoke("deleteNotes", { notes: noteIds });
  }

  async activateNotes(noteIds: number[]): Promise<void> {
    if (!noteIds.length) return;
    const cards = await this.invoke<number[]>("findCards", { query: `nid:${noteIds.join(",")}` });
    if (cards.length) await this.invoke("unsuspend", { cards });
  }

  async cardProgress(packageId: string, moduleId: string) {
    try {
      const base = `tag:langtut tag:package::${packageId} tag:module::${moduleId}`;
      const count = async (query: string) => (await this.invoke<number[]>("findCards", { query })).length;
      const [total, suspended, fresh, mature, newly, learning, dueAutomatic, difficultVocab] = await Promise.all([
        count(base), count(`${base} is:suspended`), count(`${base} is:review -prop:ivl>=21`), count(`${base} is:review prop:ivl>=21`), count(`${base} is:new`), count(`${base} is:learn`),
        count(`${base} is:due (tag:kind::chunk OR tag:kind::rule)`), count(`${base} tag:kind::vocab (tag:leech OR prop:lapses>0)`),
      ]);
      return { total, statuses: { suspended, new: newly, learning, fresh, mature }, dueAutomatic, difficultVocab };
    } catch {
      return { total: 0, statuses: { suspended: 0, new: 0, learning: 0, fresh: 0, mature: 0 }, dueAutomatic: 0, difficultVocab: 0 };
    }
  }

  async nextAutomaticCard(packageId: string, moduleId: string, target?: string): Promise<number | null> {
    const targetTag = target ? ` tag:target::${target.replace(":", "::")}` : "";
    const cards = await this.invoke<number[]>("findCards", { query: `tag:langtut tag:package::${packageId} tag:module::${moduleId}${targetTag} is:due (tag:kind::chunk OR tag:kind::rule)` });
    return cards[0] ?? null;
  }

  async gradeAutomaticCard(cardId: number, outcome: "good" | "again"): Promise<boolean> {
    const result = await this.invoke<boolean[]>("answerCards", { answers: [{ cardId, ease: outcome === "good" ? 3 : 1 }] });
    return result[0] === true;
  }

  async syncModuleAvailability(packageId: string, learningModuleIds: string[]): Promise<void> {
    const base = `tag:langtut tag:package::${packageId}`;
    const active = await this.invoke<number[]>("findCards", { query: `${base} -is:suspended` });
    if (active.length) await this.invoke("suspend", { cards: active });
    for (const moduleId of [...new Set(learningModuleIds)]) {
      const cards = await this.invoke<number[]>("findCards", { query: `${base} tag:module::${moduleId} tag:kind::vocab` });
      if (cards.length) await this.invoke("unsuspend", { cards });
    }
  }
}

const MANAGED_SENTINEL = "langtut-managed:v1";
const SCHEMA_HASH = "sha256:6a8334af11a42445";
const commonFields = ["ItemId", "ModuleId", "PackageId", "Origin", "SchemaVersion"];
const languageFields = ["Target", "Source", "ExampleTarget", "ExampleSource", "Notes", ...commonFields];
const css = `/* ${MANAGED_SENTINEL}; langtut-schema:${SCHEMA_HASH} */
.card{font-family:system-ui;font-size:24px;text-align:left;color:#17201d;background:#f7f4ed;padding:24px}.target{font-size:1.35em;font-weight:700}.example{margin-top:18px;color:#41665a}.source{margin-top:24px;font-size:.55em;color:#777}`;

export const modelDefinitions = [
  {
    name: "LangtutVocabV1", fields: languageFields, css,
    templates: bidirectionalTemplates("Vokabel"),
  },
  {
    name: "LangtutChunkV1", fields: languageFields, css,
    templates: bidirectionalTemplates("Chunk"),
  },
  {
    name: "LangtutRuleV1", fields: ["Title", "Prompt", "Explanation", "Examples", "MilestoneId", ...commonFields], css,
    templates: [{ Name: "Regel", Front: `<div class="target">{{Title}}</div><div>{{Prompt}}</div>`, Back: `{{FrontSide}}<hr><div>{{Explanation}}</div><div class="example">{{Examples}}</div>` }],
  },
];

function bidirectionalTemplates(label: string) {
  return [
    { Name: `${label} Ziel–Quelle`, Front: `<div class="target">{{Target}}</div>{{#ExampleTarget}}<div class="example">{{ExampleTarget}}</div>{{/ExampleTarget}}`, Back: `{{FrontSide}}<hr><div>{{Source}}</div><div class="example">{{ExampleSource}}</div>` },
    { Name: `${label} Quelle–Ziel`, Front: `<div class="target">{{Source}}</div>{{#ExampleSource}}<div class="example">{{ExampleSource}}</div>{{/ExampleSource}}`, Back: `{{FrontSide}}<hr><div>{{Target}}</div><div class="example">{{ExampleTarget}}</div>` },
  ];
}

function modelNameFor(kind: CandidateItem["kind"]): string {
  return kind === "vocab" ? "LangtutVocabV1" : kind === "chunk" ? "LangtutChunkV1" : "LangtutRuleV1";
}

function fieldsFor(item: CandidateItem, packageId: string): Record<string, string> {
  const common = { ItemId: item.itemId, ModuleId: item.moduleId, PackageId: packageId, Origin: `langtut:${packageId}:${item.moduleId}`, SchemaVersion: "1" };
  if (item.kind === "rule") return { Title: item.target, Prompt: item.source, Explanation: item.notes, Examples: `${item.exampleTarget}<br>${item.exampleSource}`, MilestoneId: item.milestoneId ?? "", ...common };
  return { Target: item.target, Source: item.source, ExampleTarget: item.exampleTarget, ExampleSource: item.exampleSource, Notes: item.notes, ...common };
}

export interface SetupPreview {
  deck: { name: string; action: "create" | "none" };
  models: ModelPreview[];
}
interface ModelPreview {
  name: string;
  action: "create" | "update" | "none" | "conflict";
  fields: string[];
  templates?: Record<string, { Front: string; Back: string }>;
  css?: string;
  changes?: string[];
  managed: boolean;
}
