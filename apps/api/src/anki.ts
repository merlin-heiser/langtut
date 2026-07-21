import type { AnkiMetrics, CandidateItem } from "@langtut/contracts";

type InvokeResponse<T> = { result: T; error: string | null };

export interface AnkiGateway {
  metrics(): Promise<AnkiMetrics>;
  setupPreview(): Promise<SetupPreview>;
  applySetup(): Promise<SetupPreview>;
  addItems(items: CandidateItem[]): Promise<Array<number | null>>;
}

export class AnkiClient implements AnkiGateway {
  constructor(private readonly url: string, private readonly deck: string, private key?: string) {}

  configureKey(key?: string): void { this.key = key; }

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
      const [due, fresh, leeches, lapses] = await Promise.all([
        this.invoke<number[]>("findCards", { query: "tag:langtut is:due" }),
        this.invoke<number[]>("findCards", { query: "tag:langtut is:new" }),
        this.invoke<number[]>("findCards", { query: "tag:langtut tag:leech" }),
        this.invoke<number[]>("findCards", { query: "tag:langtut rated:7:1" }),
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
      fields: fieldsFor(item),
      tags: ["langtut", `module::${item.moduleId}`, `kind::${item.kind}`, ...item.tags],
      options: { allowDuplicate: false, duplicateScope: "deck" },
    }));
    const canAdd = await this.invoke<boolean[]>("canAddNotes", { notes });
    const accepted = notes.filter((_, index) => canAdd[index]);
    const ids = accepted.length ? await this.invoke<Array<number | null>>("addNotes", { notes: accepted }) : [];
    let cursor = 0;
    return canAdd.map((allowed) => allowed ? ids[cursor++] ?? null : null);
  }
}

const MANAGED_SENTINEL = "langtut-managed:v1";
const SCHEMA_HASH = "sha256:6a8334af11a42445";
const commonFields = ["ItemId", "ModuleId", "Source", "SchemaVersion"];
const languageFields = ["Slovak", "German", "ExampleSlovak", "ExampleGerman", "Notes", ...commonFields];
const css = `/* ${MANAGED_SENTINEL}; langtut-schema:${SCHEMA_HASH} */
.card{font-family:system-ui;font-size:24px;text-align:left;color:#17201d;background:#f7f4ed;padding:24px}.target{font-size:1.35em;font-weight:700}.example{margin-top:18px;color:#41665a}.source{margin-top:24px;font-size:.55em;color:#777}`;

export const modelDefinitions = [
  {
    name: "SlovakTutorVocab", fields: languageFields, css,
    templates: bidirectionalTemplates("Vokabel"),
  },
  {
    name: "SlovakTutorChunk", fields: languageFields, css,
    templates: bidirectionalTemplates("Chunk"),
  },
  {
    name: "SlovakTutorRule", fields: ["Title", "Prompt", "Explanation", "Examples", "MilestoneId", ...commonFields], css,
    templates: [{ Name: "Regel", Front: `<div class="target">{{Title}}</div><div>{{Prompt}}</div>`, Back: `{{FrontSide}}<hr><div>{{Explanation}}</div><div class="example">{{Examples}}</div>` }],
  },
];

function bidirectionalTemplates(label: string) {
  return [
    { Name: `${label} SK-DE`, Front: `<div class="target">{{Slovak}}</div>{{#ExampleSlovak}}<div class="example">{{ExampleSlovak}}</div>{{/ExampleSlovak}}`, Back: `{{FrontSide}}<hr><div>{{German}}</div><div class="example">{{ExampleGerman}}</div>` },
    { Name: `${label} DE-SK`, Front: `<div class="target">{{German}}</div>{{#ExampleGerman}}<div class="example">{{ExampleGerman}}</div>{{/ExampleGerman}}`, Back: `{{FrontSide}}<hr><div>{{Slovak}}</div><div class="example">{{ExampleSlovak}}</div>` },
  ];
}

function modelNameFor(kind: CandidateItem["kind"]): string {
  return kind === "vocab" ? "SlovakTutorVocab" : kind === "chunk" ? "SlovakTutorChunk" : "SlovakTutorRule";
}

function fieldsFor(item: CandidateItem): Record<string, string> {
  const common = { ItemId: item.itemId, ModuleId: item.moduleId, Source: `langtut:${item.moduleId}`, SchemaVersion: "1" };
  if (item.kind === "rule") return { Title: item.slovak, Prompt: item.german, Explanation: item.notes, Examples: `${item.exampleSlovak}<br>${item.exampleGerman}`, MilestoneId: item.milestoneId ?? "", ...common };
  return { Slovak: item.slovak, German: item.german, ExampleSlovak: item.exampleSlovak, ExampleGerman: item.exampleGerman, Notes: item.notes, ...common };
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
