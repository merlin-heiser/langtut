import { readFile } from "node:fs/promises";
import path from "node:path";
import OpenAI from "openai";
import { GoogleGenAI } from "@google/genai";
import Ajv2020, { type ValidateFunction } from "ajv/dist/2020.js";
import YAML from "yaml";

export interface ModelTask {
  provider: "openai" | "gemini";
  model: string;
  quality: string;
  latency: string;
  reasoning_effort?: "none" | "low" | "medium" | "high";
  max_output_tokens: number;
  schema: string;
}

export interface ModelPricing {
  effective_date: string;
  source: string;
  input_per_million: number;
  cached_input_per_million: number;
  output_per_million: number;
}

export interface ApiUsageEvent {
  provider: "openai" | "gemini";
  model: string;
  taskId: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  costMicrousd: number;
  pricingVersion: string;
}

export interface ModelGateway {
  status(): Record<string, unknown>;
  structured<T>(taskId: string, prompt: string, definitionName: string): Promise<T>;
  pricingVersion?(): string;
}

export const modelChoices = {
  openai: ["gpt-5.6-terra", "gpt-5.6-luna", "gpt-4o-mini"],
  gemini: ["gemini-3.5-flash", "gemini-3.1-flash-lite"],
} as const;

export class ModelRouter implements ModelGateway {
  private constructor(
    private readonly tasks: Record<string, ModelTask>,
    private readonly schemas: Record<string, unknown>,
    private readonly validators: Record<string, ValidateFunction>,
    private readonly pricing: Record<string, ModelPricing>,
    private readonly pricingCatalogVersion: string,
    private readonly recordUsage?: (event: ApiUsageEvent) => void,
    private openai?: OpenAI,
    private gemini?: GoogleGenAI,
  ) {}

  static async load(root: string, tasksPath: string, recordUsage?: (event: ApiUsageEvent) => void): Promise<ModelRouter> {
    const raw = YAML.parse(await readFile(tasksPath, "utf8")) as { tasks: Record<string, ModelTask> };
    const pricing = YAML.parse(await readFile(path.join(root, "config/model_pricing.yaml"), "utf8")) as { version: string; models: Record<string, ModelPricing> };
    const contracts = JSON.parse(await readFile(path.join(root, "specs/schemas/contracts.schema.json"), "utf8")) as { definitions: Record<string, unknown> };
    const ajv: any = new (Ajv2020 as any)({
      allErrors: true,
      strict: false,
      formats: { "date-time": { type: "string", validate: (value: string) => Number.isFinite(Date.parse(value)) } },
    });
    ajv.addSchema(contracts);
    const validators = Object.fromEntries(Object.keys(contracts.definitions).map((name) => {
      const validator = ajv.getSchema(`${(contracts as any).$id}#/definitions/${name}`);
      if (!validator) throw new Error(`Cannot compile contract schema ${name}`);
      return [name, validator];
    }));
    return new ModelRouter(
      raw.tasks,
      contracts.definitions,
      validators,
      pricing.models,
      pricing.version,
      recordUsage,
      process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : undefined,
      process.env.GEMINI_API_KEY ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }) : undefined,
    );
  }

  status(): Record<string, unknown> {
    return {
      openai: { configured: Boolean(this.openai) },
      gemini: { configured: Boolean(this.gemini) },
      tasks: this.tasks,
      pricingVersion: this.pricingCatalogVersion,
    };
  }

  pricingVersion(): string { return this.pricingCatalogVersion; }

  modelSelection(): { openai: string; gemini: string } {
    return {
      openai: this.tasks.tutor_conversation?.model ?? modelChoices.openai[0],
      gemini: this.tasks.vocabulary_generation?.model ?? modelChoices.gemini[0],
    };
  }

  setModelSelection(selection: { openai: string; gemini: string }): void {
    if (!(modelChoices.openai as readonly string[]).includes(selection.openai)) throw new Error(`Unsupported OpenAI model: ${selection.openai}`);
    if (!(modelChoices.gemini as readonly string[]).includes(selection.gemini)) throw new Error(`Unsupported Gemini model: ${selection.gemini}`);
    for (const task of Object.values(this.tasks)) {
      task.model = task.provider === "openai" ? selection.openai : selection.gemini;
    }
  }

  configure(provider: "openai" | "gemini", apiKey: string): void {
    if (provider === "openai") this.openai = new OpenAI({ apiKey });
    else this.gemini = new GoogleGenAI({ apiKey });
  }

  task(id: string): ModelTask {
    const task = this.tasks[id];
    if (!task) throw new Error(`Unknown model task: ${id}`);
    return task;
  }

  async structured<T>(taskId: string, prompt: string, definitionName: string): Promise<T> {
    const task = this.task(taskId);
    const pricing = this.pricing[task.model];
    if (!pricing) throw new Error(`No pricing configured for model ${task.model}`);
    const schemaDefinition = this.schemas[definitionName];
    if (!schemaDefinition) throw new Error(`Unknown JSON schema definition: ${definitionName}`);
    const schema = resolveProviderSchema(schemaDefinition, this.schemas);
    if (task.provider === "openai") {
      if (!this.openai) throw new Error("OPENAI_API_KEY is not configured");
      const response = await this.openai.responses.create({
        model: task.model,
        input: prompt,
        max_output_tokens: task.max_output_tokens,
        ...(task.reasoning_effort && supportsReasoning(task.model) ? { reasoning: { effort: task.reasoning_effort } } : {}),
        text: { format: { type: "json_schema", name: task.schema.replace(/-/g, "_"), strict: true, schema: schema as Record<string, unknown> } },
      });
      const usage = response.usage;
      if (usage) this.captureUsage(taskId, task, pricing, usage.input_tokens, usage.input_tokens_details.cached_tokens, usage.output_tokens);
      return this.validate<T>(definitionName, response.output_text);
    }
    if (!this.gemini) throw new Error("GEMINI_API_KEY is not configured");
    const response = await this.gemini.models.generateContent({
      model: task.model,
      contents: prompt,
      config: { responseMimeType: "application/json", responseJsonSchema: schema as Record<string, unknown>, maxOutputTokens: task.max_output_tokens },
    });
    const usage = response.usageMetadata;
    if (usage) this.captureUsage(taskId, task, pricing, usage.promptTokenCount ?? 0, usage.cachedContentTokenCount ?? 0, (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0));
    const output = response.text;
    if (!output) throw new Error("Gemini returned no structured text output");
    return this.validate<T>(definitionName, output);
  }

  private captureUsage(taskId: string, task: ModelTask, pricing: ModelPricing, inputTokens: number, cachedInputTokens: number, outputTokens: number): void {
    this.recordUsage?.({
      provider: task.provider,
      model: task.model,
      taskId,
      inputTokens,
      cachedInputTokens,
      outputTokens,
      costMicrousd: calculateCostMicrousd({ inputTokens, cachedInputTokens, outputTokens }, pricing),
      pricingVersion: this.pricingCatalogVersion,
    });
  }

  private validate<T>(definitionName: string, raw: string): T {
    const parsed: unknown = JSON.parse(raw);
    const validator = this.validators[definitionName];
    if (!validator(parsed)) throw new Error(`Provider output violates ${definitionName}: ${JSON.stringify(validator.errors)}`);
    return parsed as T;
  }
}

function supportsReasoning(model: string): boolean {
  return model.startsWith("gpt-5.") || model.startsWith("o1") || model.startsWith("o3") || model.startsWith("o4");
}

export function calculateCostMicrousd(usage: { inputTokens: number; cachedInputTokens: number; outputTokens: number }, pricing: ModelPricing): number {
  const cached = Math.min(usage.inputTokens, Math.max(0, usage.cachedInputTokens));
  const uncached = Math.max(0, usage.inputTokens - cached);
  return Math.round(uncached * pricing.input_per_million + cached * pricing.cached_input_per_million + usage.outputTokens * pricing.output_per_million);
}

export function resolveProviderSchema(schema: unknown, definitions: Record<string, unknown>, resolving = new Set<string>()): unknown {
  if (Array.isArray(schema)) return schema.map((entry) => resolveProviderSchema(entry, definitions, resolving));
  if (!schema || typeof schema !== "object") return schema;
  const object = schema as Record<string, unknown>;
  if (typeof object.$ref === "string") {
    const match = object.$ref.match(/^#\/definitions\/([^/]+)$/);
    if (!match) throw new Error(`Unsupported provider schema reference: ${object.$ref}`);
    const name = match[1];
    const target = definitions[name];
    if (!target) throw new Error(`Undefined provider schema reference: ${name}`);
    if (resolving.has(name)) throw new Error(`Recursive provider schema reference is not supported: ${name}`);
    const next = new Set(resolving).add(name);
    return resolveProviderSchema(target, definitions, next);
  }
  return Object.fromEntries(Object.entries(object).map(([key, value]) => [key, resolveProviderSchema(value, definitions, resolving)]));
}
