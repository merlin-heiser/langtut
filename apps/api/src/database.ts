import Database from "better-sqlite3";
import { mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { Job, ModuleStatus, SessionPlan } from "@langtut/contracts";
import type { ModuleEvidence, ProgressByModule } from "@langtut/domain";

export class Store {
  readonly db: Database.Database;

  private constructor(db: Database.Database) {
    this.db = db;
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
  }

  static async open(dbPath: string, root: string): Promise<Store> {
    await mkdir(path.dirname(dbPath), { recursive: true });
    const store = new Store(new Database(dbPath));
    store.db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
    const migrationDir = path.join(root, "migrations");
    for (const file of (await readdir(migrationDir)).filter((name) => name.endsWith(".sql")).sort()) {
      const version = file.replace(/\.sql$/, "");
      const exists = store.db.prepare("SELECT 1 FROM schema_migrations WHERE version = ?").get(version);
      if (!exists) {
        const sql = await readFile(path.join(migrationDir, file), "utf8");
        store.db.transaction(() => {
          store.db.exec(sql);
          store.db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(version, new Date().toISOString());
        })();
      }
    }
    return store;
  }

  close(): void { this.db.close(); }

  getSetting<T>(key: string): T | undefined {
    const row = this.db.prepare("SELECT value_json FROM settings WHERE key = ?").get(key) as { value_json: string } | undefined;
    return row ? JSON.parse(row.value_json) as T : undefined;
  }

  setSetting(key: string, value: unknown): void {
    this.db.prepare(`INSERT INTO settings(key,value_json,updated_at) VALUES (?,?,?)
      ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at`)
      .run(key, JSON.stringify(value), new Date().toISOString());
  }

  deleteSetting(key: string): void {
    this.db.prepare("DELETE FROM settings WHERE key = ?").run(key);
  }

  getProgress(): ProgressByModule {
    const rows = this.db.prepare("SELECT module_id, status FROM module_progress").all() as Array<{ module_id: string; status: ModuleStatus }>;
    return Object.fromEntries(rows.map((row) => [row.module_id, row.status]));
  }

  setStatus(moduleId: string, status: ModuleStatus): void {
    this.db.prepare(`INSERT INTO module_progress(module_id,status,updated_at) VALUES (?,?,?)
      ON CONFLICT(module_id) DO UPDATE SET status=excluded.status, updated_at=excluded.updated_at`)
      .run(moduleId, status, new Date().toISOString());
  }

  getEvidence(moduleId: string): ModuleEvidence {
    const row = this.db.prepare("SELECT * FROM module_progress WHERE module_id = ?").get(moduleId) as Record<string, unknown> | undefined;
    return {
      importedVocab: Number(row?.imported_vocab ?? 0),
      importedFunctions: JSON.parse(String(row?.imported_functions_json ?? "[]")),
      importedMilestones: JSON.parse(String(row?.imported_milestones_json ?? "[]")),
      attemptedMilestones: JSON.parse(String(row?.attempted_milestones_json ?? "[]")),
    };
  }

  saveEvidence(moduleId: string, evidence: ModuleEvidence, status: ModuleStatus): void {
    this.db.prepare(`INSERT INTO module_progress(module_id,status,imported_vocab,imported_functions_json,imported_milestones_json,attempted_milestones_json,updated_at)
      VALUES (?,?,?,?,?,?,?) ON CONFLICT(module_id) DO UPDATE SET status=excluded.status, imported_vocab=excluded.imported_vocab,
      imported_functions_json=excluded.imported_functions_json, imported_milestones_json=excluded.imported_milestones_json,
      attempted_milestones_json=excluded.attempted_milestones_json, updated_at=excluded.updated_at`)
      .run(moduleId, status, evidence.importedVocab, JSON.stringify(evidence.importedFunctions), JSON.stringify(evidence.importedMilestones), JSON.stringify(evidence.attemptedMilestones), new Date().toISOString());
  }

  savePlan(plan: SessionPlan): void {
    this.db.prepare("INSERT INTO session_plans(id,payload_json,created_at) VALUES (?,?,?)").run(plan.id, JSON.stringify(plan), plan.createdAt);
  }

  savePlacement(placement: { id: string; status: string; startedAt: string }): void {
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO placement_sessions(id,status,payload_json,created_at,updated_at) VALUES (?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET status=excluded.status,payload_json=excluded.payload_json,updated_at=excluded.updated_at`)
      .run(placement.id, placement.status, JSON.stringify(placement), placement.startedAt, now);
  }

  getPlacement<T>(id: string): T | null {
    const row = this.db.prepare("SELECT payload_json FROM placement_sessions WHERE id=?").get(id) as { payload_json: string } | undefined;
    return row ? JSON.parse(row.payload_json) as T : null;
  }

  getLatestPlacement<T>(): T | null {
    const row = this.db.prepare("SELECT payload_json FROM placement_sessions ORDER BY updated_at DESC LIMIT 1").get() as { payload_json: string } | undefined;
    return row ? JSON.parse(row.payload_json) as T : null;
  }

  createSession(id: string, planId: string | null, moduleId: string | null): void {
    this.db.prepare("INSERT INTO sessions(id,plan_id,module_id,status,created_at) VALUES (?,?,?,?,?)")
      .run(id, planId, moduleId, "active", new Date().toISOString());
    this.appendSessionEvent(id, "session_started", { planId, moduleId });
  }

  getSession(id: string): Record<string, unknown> | null {
    const row = this.db.prepare("SELECT id,plan_id AS planId,module_id AS moduleId,status,created_at AS createdAt,completed_at AS completedAt FROM sessions WHERE id=?").get(id) as Record<string, unknown> | undefined;
    return row ?? null;
  }

  appendSessionEvent(sessionId: string, eventType: string, payload: unknown): void {
    this.db.prepare("INSERT INTO session_events(session_id,event_type,payload_json,created_at) VALUES (?,?,?,?)")
      .run(sessionId, eventType, JSON.stringify(payload), new Date().toISOString());
  }

  getSessionEvents(sessionId: string): Array<{ eventType: string; payload: unknown; createdAt: string }> {
    const rows = this.db.prepare("SELECT event_type,payload_json,created_at FROM session_events WHERE session_id=? ORDER BY id").all(sessionId) as Array<{ event_type: string; payload_json: string; created_at: string }>;
    return rows.map((row) => ({ eventType: row.event_type, payload: JSON.parse(row.payload_json), createdAt: row.created_at }));
  }

  completeSession(id: string, report: unknown): void {
    this.db.transaction(() => {
      this.appendSessionEvent(id, "session_completed", report);
      this.db.prepare("UPDATE sessions SET status='completed',completed_at=? WHERE id=?").run(new Date().toISOString(), id);
    })();
  }

  createJob(job: Job): void {
    this.db.prepare("INSERT INTO jobs(id,kind,module_id,status,progress,message,error,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(job.id, job.kind, job.moduleId ?? null, job.status, job.progress, job.message ?? null, job.error ?? null, job.createdAt, job.updatedAt);
  }

  updateJob(id: string, patch: Partial<Job>): Job {
    const current = this.getJob(id);
    if (!current) throw new Error(`Unknown job ${id}`);
    const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
    this.db.prepare("UPDATE jobs SET status=?,progress=?,message=?,error=?,updated_at=? WHERE id=?")
      .run(next.status, next.progress, next.message ?? null, next.error ?? null, next.updatedAt, id);
    return next;
  }

  getJob(id: string): Job | null {
    const row = this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? {
      id: String(row.id), kind: String(row.kind), moduleId: row.module_id ? String(row.module_id) : undefined,
      status: String(row.status) as Job["status"], progress: Number(row.progress), message: row.message ? String(row.message) : undefined,
      error: row.error ? String(row.error) : undefined, createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    } : null;
  }

  getLatestJob(): Job | null {
    const row = this.db.prepare("SELECT id,kind,module_id AS moduleId,status,progress,message,error,created_at AS createdAt,updated_at AS updatedAt FROM jobs ORDER BY updated_at DESC LIMIT 1").get() as Job | undefined;
    return row ?? null;
  }

  recordApiUsage(event: { provider: string; model: string; taskId: string; inputTokens: number; cachedInputTokens: number; outputTokens: number; costMicrousd: number; pricingVersion: string; createdAt?: string }): void {
    this.db.prepare(`INSERT INTO api_usage_events(provider,model,task_id,input_tokens,cached_input_tokens,output_tokens,cost_microusd,pricing_version,created_at)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(event.provider, event.model, event.taskId, event.inputTokens, event.cachedInputTokens, event.outputTokens, event.costMicrousd, event.pricingVersion, event.createdAt ?? new Date().toISOString());
  }

  getApiCostSummary(now = new Date(), pricingVersion = "unknown"): ApiCostSummary {
    const weekStartedAt = isoWeekStart(now).toISOString();
    const aggregate = (where = "", value?: string) => this.db.prepare(`SELECT COALESCE(SUM(cost_microusd),0) AS cost, COALESCE(SUM(input_tokens),0) AS inputTokens, COALESCE(SUM(output_tokens),0) AS outputTokens FROM api_usage_events ${where}`).get(...(value ? [value] : [])) as { cost: number; inputTokens: number; outputTokens: number };
    const total = aggregate();
    const week = aggregate("WHERE created_at >= ?", weekStartedAt);
    const first = this.db.prepare("SELECT MIN(created_at) AS trackedSince FROM api_usage_events").get() as { trackedSince: string | null };
    return {
      currency: "USD",
      weekCost: week.cost / 1_000_000,
      totalCost: total.cost / 1_000_000,
      weekInputTokens: week.inputTokens,
      weekOutputTokens: week.outputTokens,
      totalInputTokens: total.inputTokens,
      totalOutputTokens: total.outputTokens,
      weekStartedAt,
      trackedSince: first.trackedSince,
      pricingVersion,
    };
  }

  countItems(moduleId: string, kind: string): number {
    const row = this.db.prepare("SELECT count(*) AS count FROM generated_items WHERE module_id=? AND kind=? AND validation_status='imported'").get(moduleId, kind) as { count: number };
    return row.count;
  }

  importedItems<T>(moduleId: string, kind: string): Array<{ item: T; ankiNoteId?: number }> {
    const rows = this.db.prepare("SELECT payload_json,anki_note_id FROM generated_items WHERE module_id=? AND kind=? AND validation_status='imported'").all(moduleId, kind) as Array<{ payload_json: string; anki_note_id: number | null }>;
    return rows.map((row) => ({ item: JSON.parse(row.payload_json) as T, ...(row.anki_note_id ? { ankiNoteId: row.anki_note_id } : {}) }));
  }

  retractGenerated(item: { itemId: string; moduleId: string }, payload: unknown, issues: string[]): void {
    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.db.prepare("UPDATE generated_items SET validation_status='retracted' WHERE item_id=?").run(item.itemId);
      this.db.prepare("INSERT INTO quarantine(item_id,module_id,issues_json,payload_json,created_at) VALUES (?,?,?,?,?)")
        .run(item.itemId, item.moduleId, JSON.stringify(issues), JSON.stringify(payload), now);
      this.db.prepare("INSERT INTO import_events(item_id,action,payload_json,created_at) VALUES (?,?,?,?)")
        .run(item.itemId, "retracted", JSON.stringify({ moduleId: item.moduleId, issues }), now);
    })();
  }

  importedCoverage(moduleId: string, kind: string, field: "functionId" | "milestoneId"): string[] {
    const rows = this.db.prepare("SELECT payload_json FROM generated_items WHERE module_id=? AND kind=? AND validation_status='imported'").all(moduleId, kind) as Array<{ payload_json: string }>;
    return [...new Set(rows.map((row) => (JSON.parse(row.payload_json) as Record<string, unknown>)[field]).filter((value): value is string => typeof value === "string"))];
  }

  existingFronts(): string[] {
    const rows = this.db.prepare("SELECT normalized_slovak FROM generated_items WHERE validation_status IN ('approved','imported')").all() as Array<{ normalized_slovak: string }>;
    return rows.map((row) => row.normalized_slovak);
  }

  generationExclusions(moduleId: string): string[] {
    const quarantined = this.db.prepare("SELECT payload_json FROM quarantine WHERE module_id=? AND resolved_at IS NULL").all(moduleId) as Array<{ payload_json: string }>;
    const fronts = [...this.existingFronts()];
    for (const row of quarantined) {
      const payload = JSON.parse(row.payload_json) as { slovak?: unknown };
      if (typeof payload.slovak === "string" && payload.slovak.trim()) fronts.push(payload.slovak.normalize("NFC").trim());
    }
    return [...new Set(fronts)];
  }

  saveGenerated(item: { itemId: string; moduleId: string; kind: string; normalized: string; payload: unknown }, status: string, ankiNoteId?: number): void {
    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.db.prepare(`INSERT OR REPLACE INTO generated_items(item_id,module_id,kind,normalized_slovak,payload_json,validation_status,anki_note_id,created_at)
        VALUES (?,?,?,?,?,?,?,?)`).run(item.itemId, item.moduleId, item.kind, item.normalized, JSON.stringify(item.payload), status, ankiNoteId ?? null, now);
      this.db.prepare("INSERT INTO import_events(item_id,action,payload_json,created_at) VALUES (?,?,?,?)")
        .run(item.itemId, status, JSON.stringify({ moduleId: item.moduleId, kind: item.kind, ankiNoteId: ankiNoteId ?? null }), now);
    })();
  }

  quarantine(item: { itemId: string; moduleId: string }, payload: unknown, issues: string[]): void {
    this.db.prepare("INSERT INTO quarantine(item_id,module_id,issues_json,payload_json,created_at) VALUES (?,?,?,?,?)")
      .run(item.itemId, item.moduleId, JSON.stringify(issues), JSON.stringify(payload), new Date().toISOString());
  }

  listQuarantine(): unknown[] {
    return this.db.prepare("SELECT id,item_id AS itemId,module_id AS moduleId,issues_json AS issues,payload_json AS payload,created_at AS createdAt FROM quarantine WHERE resolved_at IS NULL ORDER BY id DESC").all()
      .map((row: any) => ({ ...row, issues: JSON.parse(row.issues), payload: JSON.parse(row.payload) }));
  }

  exportJsonl(): string {
    const tables = ["module_progress", "session_plans", "sessions", "session_events", "placement_sessions", "jobs", "generated_items", "quarantine", "import_events", "api_usage_events"];
    const lines: string[] = [];
    for (const table of tables) {
      const rows = this.db.prepare(`SELECT * FROM ${table}`).all();
      for (const row of rows) lines.push(JSON.stringify({ table, exportedAt: new Date().toISOString(), row }));
    }
    return `${lines.join("\n")}${lines.length ? "\n" : ""}`;
  }
}

export interface ApiCostSummary {
  currency: "USD";
  weekCost: number;
  totalCost: number;
  weekInputTokens: number;
  weekOutputTokens: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  weekStartedAt: string;
  trackedSince: string | null;
  pricingVersion: string;
}

export function isoWeekStart(now: Date): Date {
  const start = new Date(now);
  const daysSinceMonday = (start.getDay() + 6) % 7;
  start.setDate(start.getDate() - daysSinceMonday);
  start.setHours(0, 0, 0, 0);
  return start;
}
