import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import YAML from "yaml";
import type { Store } from "./database.js";

export interface LocalMtModel {
  key: string;
  family: "marian" | "m2m100";
  model_id: string;
  revision: string;
  license: string;
  size_bytes: number;
  source_languages: string[];
  target_languages: string[];
  priority: number;
}

export interface LocalMtTranslation {
  translation: string;
  sourceLanguage: string;
  targetLanguage: string;
  modelKey: string;
  modelId: string;
  modelRevision: string;
  license: string;
  confidence: number;
  mode: "direct" | "pivot";
}

export interface LocalMtGateway {
  translate(input: { text: string; sourceLanguage: string; targetLanguage: string }): Promise<LocalMtTranslation | undefined>;
  status?(): Promise<unknown>;
  configure?(settings: { enabled: boolean; cloudFallback: boolean }): void;
  refresh?(): Promise<void>;
  settings?(): { enabled: boolean; cloudFallback: boolean };
  install?(key: string): Promise<void>;
  close?(): Promise<void>;
}

type Pending = { resolve: (value: LocalMtTranslation | undefined) => void; reject: (error: Error) => void; model: LocalMtModel; source: string; target: string; timer: ReturnType<typeof setTimeout> };

export class LocalMtClient implements LocalMtGateway {
  private worker?: ChildProcessWithoutNullStreams;
  private pending = new Map<string, Pending>();
  private runtime = { available: false, error: "Noch nicht geprüft" };
  private lastError?: string;

  private constructor(
    private readonly root: string,
    private readonly modelRoot: string,
    private readonly store: Store,
    private readonly models: LocalMtModel[],
    private currentSettings: { enabled: boolean; cloudFallback: boolean },
    private readonly python = process.env.LANGTUT_PYTHON ?? "python",
  ) {}

  static async load(root: string, dataRoot: string, store: Store, settings: { enabled: boolean; cloudFallback: boolean }): Promise<LocalMtClient> {
    const raw = YAML.parse(await readFile(path.join(root, "config/local_mt.yaml"), "utf8")) as { models: LocalMtModel[] };
    const client = new LocalMtClient(root, path.join(dataRoot, "local-mt"), store, raw.models, settings);
    store.failInterruptedLocalMtInstallations();
    await mkdir(client.modelRoot, { recursive: true });
    await client.probe();
    return client;
  }

  settings() { return { ...this.currentSettings }; }
  configure(settings: { enabled: boolean; cloudFallback: boolean }): void { this.currentSettings = { ...settings }; }
  async refresh(): Promise<void> { await this.probe(); }

  async status(): Promise<unknown> {
    const installs = new Map(this.store.listLocalMtInstallations().map((row) => [row.key, row]));
    return {
      enabled: this.currentSettings.enabled,
      cloudFallback: this.currentSettings.cloudFallback,
      runtime: this.runtime,
      lastError: this.lastError,
      models: this.models.map((model) => ({
        key: model.key, family: model.family, modelId: model.model_id, revision: model.revision,
        license: model.license, sizeBytes: model.size_bytes, sourceLanguages: model.source_languages,
        targetLanguages: model.target_languages, priority: model.priority,
        status: installs.get(model.key)?.status ?? "not_installed", error: installs.get(model.key)?.error,
      })),
    };
  }

  async install(key: string): Promise<void> {
    const model = this.models.find((candidate) => candidate.key === key);
    if (!model) throw new Error(`Unbekanntes lokales Modell: ${key}`);
    if (!this.runtime.available) await this.probe();
    if (!this.runtime.available) throw new Error(this.runtime.error);
    const directory = path.join(this.modelRoot, model.key);
    this.store.saveLocalMtInstallation(model, "installing");
    try {
      await promisify(execFile)(this.python, [path.join(this.root, "scripts/local_mt_worker.py"), "install", "--model", model.model_id, "--revision", model.revision, "--directory", directory], { timeout: 30 * 60 * 1000, maxBuffer: 1024 * 1024 });
      this.store.saveLocalMtInstallation(model, "installed", directory);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.store.saveLocalMtInstallation(model, "failed", undefined, message);
      throw new Error(message);
    }
  }

  async translate(input: { text: string; sourceLanguage: string; targetLanguage: string }): Promise<LocalMtTranslation | undefined> {
    if (!this.currentSettings.enabled || !this.runtime.available || input.sourceLanguage === input.targetLanguage) return undefined;
    const installed = new Set(this.store.listLocalMtInstallations().filter((row) => row.status === "installed").map((row) => row.key));
    const candidates = selectLocalMtModels(this.models, installed, input.sourceLanguage, input.targetLanguage);
    for (const model of candidates) {
      try { return await this.request(model, input); }
      catch (error) { this.lastError = error instanceof Error ? error.message : String(error); }
    }
    return undefined;
  }

  async close(): Promise<void> {
    this.worker?.kill();
    this.worker = undefined;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error("Lokaler MT-Prozess wurde beendet")); }
    this.pending.clear();
  }

  private async probe(): Promise<void> {
    try {
      const { stdout } = await promisify(execFile)(this.python, [path.join(this.root, "scripts/local_mt_worker.py"), "probe"], { timeout: 15000 });
      const result = JSON.parse(stdout.trim()) as { ok: boolean; error?: string };
      this.runtime = result.ok ? { available: true, error: "" } : { available: false, error: result.error ?? "Python-Runtime nicht verfügbar" };
    } catch (error) { this.runtime = { available: false, error: error instanceof Error ? error.message : String(error) }; }
  }

  private request(model: LocalMtModel, input: { text: string; sourceLanguage: string; targetLanguage: string }): Promise<LocalMtTranslation | undefined> {
    const worker = this.ensureWorker();
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("Lokale Übersetzung hat das Zeitlimit überschritten")); this.worker?.kill(); }, 60_000);
      this.pending.set(id, { resolve, reject, model, source: input.sourceLanguage, target: input.targetLanguage, timer });
      worker.stdin.write(`${JSON.stringify({ id, modelPath: path.join(this.modelRoot, model.key), family: model.family, sourceLanguage: input.sourceLanguage, targetLanguage: input.targetLanguage, text: input.text })}\n`);
    });
  }

  private ensureWorker(): ChildProcessWithoutNullStreams {
    if (this.worker && !this.worker.killed) return this.worker;
    const worker = spawn(this.python, [path.join(this.root, "scripts/local_mt_worker.py"), "serve"], { stdio: "pipe", windowsHide: true });
    this.worker = worker;
    createInterface({ input: worker.stdout }).on("line", (line) => {
      let response: { id?: string; translation?: string; error?: string };
      try { response = JSON.parse(line); } catch { return; }
      if (!response.id) return;
      const pending = this.pending.get(response.id); if (!pending) return;
      this.pending.delete(response.id);
      clearTimeout(pending.timer);
      if (response.error || !response.translation) { pending.reject(new Error(response.error ?? "Leere lokale Übersetzung")); return; }
      pending.resolve({
        translation: response.translation, sourceLanguage: pending.source, targetLanguage: pending.target,
        modelKey: pending.model.key, modelId: pending.model.model_id, modelRevision: pending.model.revision,
        license: pending.model.license, confidence: pending.model.family === "marian" ? 0.68 : 0.58, mode: "direct",
      });
      });
    worker.stderr.on("data", (chunk) => { this.lastError = String(chunk).trim().slice(-2000); });
    worker.on("error", (error) => { this.lastError = error.message; });
    worker.on("exit", () => {
      this.worker = undefined;
      for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error("Lokaler MT-Prozess unerwartet beendet")); }
      this.pending.clear();
    });
    return worker;
  }
}

function supports(languages: string[], requested: string): boolean { return languages.includes("*") || languages.includes(requested); }

export function selectLocalMtModels(models: LocalMtModel[], installed: Set<string>, sourceLanguage: string, targetLanguage: string): LocalMtModel[] {
  return models.filter((model) => installed.has(model.key) && supports(model.source_languages, sourceLanguage) && supports(model.target_languages, targetLanguage))
    .sort((left, right) => right.priority - left.priority || left.key.localeCompare(right.key));
}
