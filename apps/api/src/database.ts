import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { Job, ModuleStatus, SessionPlan } from "@langtut/contracts";
import { reduceSyncEvents, type ModuleEvidence, type ProgressByModule, type SyncEventKind, type SyncEventV1 } from "@langtut/domain";

// Credentials and runtime-only integration details intentionally never leave this device.
function isLocalOnlySetting(key: string): boolean {
  return key === "anki.connect_api_key" || key.startsWith("google_drive.") || key.startsWith("provider.") || key.startsWith("local_mt.");
}

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
    store.ensureSyncIdentity();
    store.bootstrapSyncLog();
    return store;
  }

  close(): void { this.db.close(); }

  private syncState<T>(key: string): T | undefined {
    const row = this.db.prepare("SELECT value_json FROM sync_state WHERE key=?").get(key) as { value_json: string } | undefined;
    return row ? JSON.parse(row.value_json) as T : undefined;
  }
  private setSyncState(key: string, value: unknown): void {
    this.db.prepare("INSERT INTO sync_state(key,value_json,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at")
      .run(key, JSON.stringify(value), new Date().toISOString());
  }
  private ensureSyncIdentity(): void { if (!this.syncState<string>("device_id")) this.setSyncState("device_id", randomUUID()); }
  /** Converts an existing SQLite snapshot once, so enabling Drive on an established install does not lose history. */
  private bootstrapSyncLog(): void {
    const count = this.db.prepare("SELECT count(*) AS count FROM sync_events").get() as { count: number };
    if (count.count) return;
    const progress = this.db.prepare("SELECT package_id,module_id,status,attempted_milestones_json,updated_at FROM module_progress").all() as Array<{ package_id: string; module_id: string; status: string; attempted_milestones_json: string; updated_at: string }>;
    const settings = this.db.prepare("SELECT key,value_json,updated_at FROM settings").all() as Array<{ key: string; value_json: string; updated_at: string }>;
    const sessions = this.db.prepare("SELECT session_id,event_type,payload_json,created_at FROM session_events").all() as Array<{ session_id: string; event_type: string; payload_json: string; created_at: string }>;
    for (const row of progress) this.appendSyncEvent("progress", { packageId: row.package_id, moduleId: row.module_id, status: row.status, attemptedMilestones: JSON.parse(row.attempted_milestones_json) }, row.updated_at);
    for (const row of settings) if (!isLocalOnlySetting(row.key)) this.appendSyncEvent("setting", { key: row.key, value: JSON.parse(row.value_json) }, row.updated_at);
    for (const row of sessions) this.appendSyncEvent("session_event", { sessionId: row.session_id, eventType: row.event_type, payload: transcriptPayload(row.session_id, row.event_type, JSON.parse(row.payload_json)) }, row.created_at);
  }
  syncDeviceId(): string { return this.syncState<string>("device_id")!; }
  appendSyncEvent(kind: SyncEventKind, payload: Record<string, unknown>, occurredAt = new Date().toISOString()): SyncEventV1 {
    const deviceId = this.syncDeviceId(); const sequence = (this.syncState<number>("next_sequence") ?? 0) + 1;
    const event: SyncEventV1 = { schema: 1, id: randomUUID(), deviceId, sequence, occurredAt, kind, payload };
    this.db.prepare("INSERT INTO sync_events(id,device_id,sequence,occurred_at,kind,payload_json) VALUES (?,?,?,?,?,?)")
      .run(event.id, event.deviceId, event.sequence, event.occurredAt, event.kind, JSON.stringify(event.payload));
    this.setSyncState("next_sequence", sequence); return event;
  }
  pendingSyncEvents(limit = 200): SyncEventV1[] {
    const rows = this.db.prepare("SELECT * FROM sync_events WHERE uploaded_at IS NULL ORDER BY device_id,sequence LIMIT ?").all(limit) as Array<Record<string, unknown>>;
    return rows.map((row) => ({ schema: 1, id: String(row.id), deviceId: String(row.device_id), sequence: Number(row.sequence), occurredAt: String(row.occurred_at), kind: String(row.kind) as SyncEventKind, payload: JSON.parse(String(row.payload_json)) }));
  }
  markSyncEventsUploaded(ids: string[]): void {
    if (!ids.length) return; const marks = ids.map(() => "?").join(","); this.db.prepare(`UPDATE sync_events SET uploaded_at=? WHERE id IN (${marks})`).run(new Date().toISOString(), ...ids);
  }
  ingestSyncEvents(events: SyncEventV1[]): { accepted: number } {
    let accepted = 0; const insert = this.db.prepare("INSERT OR IGNORE INTO sync_events(id,device_id,sequence,occurred_at,kind,payload_json,uploaded_at) VALUES (?,?,?,?,?,?,?)");
    this.db.transaction(() => { for (const event of events) { const result = insert.run(event.id, event.deviceId, event.sequence, event.occurredAt, event.kind, JSON.stringify(event.payload), new Date().toISOString()); accepted += result.changes; } })();
    if (accepted) this.applySyncProjection(); return { accepted };
  }
  private applySyncProjection(): void {
    const events = this.db.prepare("SELECT id,device_id,sequence,occurred_at,kind,payload_json FROM sync_events ORDER BY occurred_at,device_id,sequence").all() as Array<Record<string, unknown>>;
    const projection = reduceSyncEvents(events.map((row) => ({ schema: 1, id: String(row.id), deviceId: String(row.device_id), sequence: Number(row.sequence), occurredAt: String(row.occurred_at), kind: String(row.kind) as SyncEventKind, payload: JSON.parse(String(row.payload_json)) })));
    const saveProgress = this.db.prepare("INSERT INTO module_progress(package_id,module_id,status,attempted_milestones_json,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(package_id,module_id) DO UPDATE SET status=excluded.status,attempted_milestones_json=excluded.attempted_milestones_json,updated_at=excluded.updated_at");
    const saveSetting = this.db.prepare("INSERT INTO settings(key,value_json,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at");
    this.db.transaction(() => {
      for (const [key, value] of Object.entries(projection.progress)) { const [packageId, moduleId] = key.split(":"); saveProgress.run(packageId, moduleId, value.status, JSON.stringify(value.milestones), new Date().toISOString()); }
      for (const [key, value] of Object.entries(projection.settings)) if (!isLocalOnlySetting(key)) saveSetting.run(key, JSON.stringify(value), new Date().toISOString());
    })();
  }

  getSetting<T>(key: string): T | undefined {
    const row = this.db.prepare("SELECT value_json FROM settings WHERE key = ?").get(key) as { value_json: string } | undefined;
    return row ? JSON.parse(row.value_json) as T : undefined;
  }

  setSetting(key: string, value: unknown): void {
    this.db.prepare(`INSERT INTO settings(key,value_json,updated_at) VALUES (?,?,?)
      ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at`)
      .run(key, JSON.stringify(value), new Date().toISOString());
    if (!isLocalOnlySetting(key)) this.appendSyncEvent("setting", { key, value });
  }

  deleteSetting(key: string): void {
    this.db.prepare("DELETE FROM settings WHERE key = ?").run(key);
  }

  getProgress(packageId: string): ProgressByModule {
    const rows = this.db.prepare("SELECT module_id, status FROM module_progress WHERE package_id=?").all(packageId) as Array<{ module_id: string; status: ModuleStatus }>;
    return Object.fromEntries(rows.map((row) => [row.module_id, row.status]));
  }

  setStatus(packageId: string, moduleId: string, status: ModuleStatus): void {
    this.db.prepare(`INSERT INTO module_progress(package_id,module_id,status,updated_at) VALUES (?,?,?,?)
      ON CONFLICT(package_id,module_id) DO UPDATE SET status=excluded.status, updated_at=excluded.updated_at`)
      .run(packageId, moduleId, status, new Date().toISOString());
    this.appendSyncEvent("progress", { packageId, moduleId, status });
  }

  getEvidence(packageId: string, moduleId: string): ModuleEvidence {
    const row = this.db.prepare("SELECT * FROM module_progress WHERE package_id=? AND module_id = ?").get(packageId, moduleId) as Record<string, unknown> | undefined;
    return {
      importedVocab: Number(row?.imported_vocab ?? 0),
      importedFunctions: JSON.parse(String(row?.imported_functions_json ?? "[]")),
      importedMilestones: JSON.parse(String(row?.imported_milestones_json ?? "[]")),
      attemptedMilestones: JSON.parse(String(row?.attempted_milestones_json ?? "[]")),
    };
  }

  saveEvidence(packageId: string, moduleId: string, evidence: ModuleEvidence, status: ModuleStatus): void {
    this.db.prepare(`INSERT INTO module_progress(package_id,module_id,status,imported_vocab,imported_functions_json,imported_milestones_json,attempted_milestones_json,updated_at)
      VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(package_id,module_id) DO UPDATE SET status=excluded.status, imported_vocab=excluded.imported_vocab,
      imported_functions_json=excluded.imported_functions_json, imported_milestones_json=excluded.imported_milestones_json,
      attempted_milestones_json=excluded.attempted_milestones_json, updated_at=excluded.updated_at`)
      .run(packageId, moduleId, status, evidence.importedVocab, JSON.stringify(evidence.importedFunctions), JSON.stringify(evidence.importedMilestones), JSON.stringify(evidence.attemptedMilestones), new Date().toISOString());
    this.appendSyncEvent("progress", { packageId, moduleId, status, attemptedMilestones: evidence.attemptedMilestones });
  }

  savePlan(plan: SessionPlan): void {
    this.db.prepare("INSERT INTO session_plans(id,payload_json,created_at,package_id) VALUES (?,?,?,?)").run(plan.id, JSON.stringify(plan), plan.createdAt, plan.packageId);
    this.appendSyncEvent("session_plan", { id: plan.id, plan });
  }

  getPlan(id: string): SessionPlan | null {
    const row = this.db.prepare("SELECT payload_json FROM session_plans WHERE id=?").get(id) as { payload_json: string } | undefined;
    return row ? JSON.parse(row.payload_json) as SessionPlan : null;
  }

  savePlacement(placement: { id: string; packageId: string; status: string; startedAt: string }): void {
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO placement_sessions(id,status,payload_json,created_at,updated_at,package_id) VALUES (?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET status=excluded.status,payload_json=excluded.payload_json,updated_at=excluded.updated_at`)
      .run(placement.id, placement.status, JSON.stringify(placement), placement.startedAt, now, placement.packageId);
    this.appendSyncEvent("placement", { id: placement.id, placement });
  }

  getPlacement<T>(packageId: string, id: string): T | null {
    const row = this.db.prepare("SELECT payload_json FROM placement_sessions WHERE package_id=? AND id=?").get(packageId, id) as { payload_json: string } | undefined;
    return row ? JSON.parse(row.payload_json) as T : null;
  }

  getLatestPlacement<T>(packageId: string): T | null {
    const row = this.db.prepare("SELECT payload_json FROM placement_sessions WHERE package_id=? ORDER BY updated_at DESC LIMIT 1").get(packageId) as { payload_json: string } | undefined;
    return row ? JSON.parse(row.payload_json) as T : null;
  }

  createSession(packageId: string, id: string, planId: string | null, moduleId: string | null, activityId?: string): void {
    this.db.prepare("INSERT INTO sessions(id,plan_id,module_id,status,created_at,package_id) VALUES (?,?,?,?,?,?)")
      .run(id, planId, moduleId, "active", new Date().toISOString(), packageId);
    this.appendSessionEvent(id, "session_started", { packageId, planId, moduleId, activityId });
  }

  getSession(id: string): Record<string, unknown> | null {
    const row = this.db.prepare("SELECT id,package_id AS packageId,plan_id AS planId,module_id AS moduleId,status,created_at AS createdAt,completed_at AS completedAt FROM sessions WHERE id=?").get(id) as Record<string, unknown> | undefined;
    return row ?? null;
  }

  appendSessionEvent(sessionId: string, eventType: string, payload: unknown): void {
    const createdAt = new Date().toISOString(); this.db.prepare("INSERT INTO session_events(session_id,event_type,payload_json,created_at) VALUES (?,?,?,?)")
      .run(sessionId, eventType, JSON.stringify(payload), createdAt);
    this.appendSyncEvent("session_event", { sessionId, eventType, payload: transcriptPayload(sessionId, eventType, payload) }, createdAt);
  }

  getSessionEvents(sessionId: string): Array<{ eventType: string; payload: unknown; createdAt: string }> {
    const rows = this.db.prepare("SELECT event_type,payload_json,created_at FROM session_events WHERE session_id=? ORDER BY id").all(sessionId) as Array<{ event_type: string; payload_json: string; created_at: string }>;
    return rows.map((row) => ({ eventType: row.event_type, payload: JSON.parse(row.payload_json), createdAt: row.created_at }));
  }
  markTranscriptDeleted(sessionId: string): void { this.appendSyncEvent("transcript_deleted", { sessionId }); }

  completeSession(id: string, report: unknown): void {
    this.db.transaction(() => {
      this.appendSessionEvent(id, "session_completed", report);
      this.db.prepare("UPDATE sessions SET status='completed',completed_at=? WHERE id=?").run(new Date().toISOString(), id);
    })();
  }

  createJob(job: Job): void {
    this.db.prepare("INSERT INTO jobs(id,kind,module_id,status,progress,message,error,created_at,updated_at,package_id) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(job.id, job.kind, job.moduleId ?? null, job.status, job.progress, job.message ?? null, job.error ?? null, job.createdAt, job.updatedAt, job.packageId);
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
      id: String(row.id), packageId: String(row.package_id), kind: String(row.kind), moduleId: row.module_id ? String(row.module_id) : undefined,
      status: String(row.status) as Job["status"], progress: Number(row.progress), message: row.message ? String(row.message) : undefined,
      error: row.error ? String(row.error) : undefined, createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    } : null;
  }

  getLatestJob(packageId: string): Job | null {
    const row = this.db.prepare("SELECT id,package_id AS packageId,kind,module_id AS moduleId,status,progress,message,error,created_at AS createdAt,updated_at AS updatedAt FROM jobs WHERE package_id=? ORDER BY updated_at DESC LIMIT 1").get(packageId) as Job | undefined;
    return row ?? null;
  }

  failInterruptedJobs(): number {
    const result = this.db.prepare(`UPDATE jobs
      SET status='failed', message='Vorbereitung unterbrochen',
          error='Der API-Server wurde während der Vorbereitung beendet. Bitte Vorbereitung erneut starten.',
          updated_at=?
      WHERE status IN ('queued','running')`).run(new Date().toISOString());
    return result.changes;
  }

  hasActiveWork(packageId: string): boolean {
    const activeJob = this.db.prepare("SELECT 1 FROM jobs WHERE package_id=? AND status IN ('queued','running') LIMIT 1").get(packageId);
    const activeSession = this.db.prepare("SELECT 1 FROM sessions WHERE package_id=? AND status='active' LIMIT 1").get(packageId);
    const activePlacement = this.db.prepare("SELECT 1 FROM placement_sessions WHERE package_id=? AND status='active' LIMIT 1").get(packageId);
    return Boolean(activeJob || activeSession || activePlacement);
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

  countItems(packageId: string, moduleId: string, kind: string): number {
    const row = this.db.prepare("SELECT count(*) AS count FROM generated_items WHERE package_id=? AND module_id=? AND kind=? AND validation_status='imported'").get(packageId, moduleId, kind) as { count: number };
    return row.count;
  }

  hasImportedItem(packageId: string, itemId: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM generated_items WHERE package_id=? AND item_id=? AND validation_status='imported'").get(packageId, itemId));
  }

  importedItems<T>(packageId: string, moduleId: string, kind: string): Array<{ item: T; ankiNoteId?: number }> {
    const rows = this.db.prepare("SELECT payload_json,anki_note_id FROM generated_items WHERE package_id=? AND module_id=? AND kind=? AND validation_status='imported'").all(packageId, moduleId, kind) as Array<{ payload_json: string; anki_note_id: number | null }>;
    return rows.map((row) => ({ item: JSON.parse(row.payload_json) as T, ...(row.anki_note_id ? { ankiNoteId: row.anki_note_id } : {}) }));
  }

  retractGenerated(packageId: string, item: { itemId: string; moduleId: string }, payload: unknown, issues: string[]): void {
    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.db.prepare("UPDATE generated_items SET validation_status='retracted' WHERE package_id=? AND item_id=?").run(packageId, item.itemId);
      this.db.prepare("INSERT INTO quarantine(item_id,module_id,issues_json,payload_json,created_at,package_id) VALUES (?,?,?,?,?,?)")
        .run(item.itemId, item.moduleId, JSON.stringify(issues), JSON.stringify(payload), now, packageId);
      this.db.prepare("INSERT INTO import_events(item_id,action,payload_json,created_at,package_id) VALUES (?,?,?,?,?)")
        .run(item.itemId, "retracted", JSON.stringify({ packageId, moduleId: item.moduleId, issues }), now, packageId);
    })();
  }

  importedCoverage(packageId: string, moduleId: string, kind: string, field: "functionId" | "milestoneId"): string[] {
    const rows = this.db.prepare("SELECT payload_json FROM generated_items WHERE package_id=? AND module_id=? AND kind=? AND validation_status='imported'").all(packageId, moduleId, kind) as Array<{ payload_json: string }>;
    return [...new Set(rows.map((row) => (JSON.parse(row.payload_json) as Record<string, unknown>)[field]).filter((value): value is string => typeof value === "string"))];
  }

  existingFronts(packageId: string): string[] {
    const rows = this.db.prepare("SELECT normalized_target FROM generated_items WHERE package_id=? AND validation_status IN ('approved','imported')").all(packageId) as Array<{ normalized_target: string }>;
    return rows.map((row) => row.normalized_target);
  }

  generationExclusions(packageId: string, moduleId: string): string[] {
    const quarantined = this.db.prepare("SELECT payload_json FROM quarantine WHERE package_id=? AND module_id=? AND resolved_at IS NULL").all(packageId, moduleId) as Array<{ payload_json: string }>;
    const fronts = [...this.existingFronts(packageId)];
    for (const row of quarantined) {
      const payload = JSON.parse(row.payload_json) as { target?: unknown };
      if (typeof payload.target === "string" && payload.target.trim()) fronts.push(payload.target.normalize("NFC").trim());
    }
    return [...new Set(fronts)];
  }

  saveGenerated(packageId: string, item: { itemId: string; moduleId: string; kind: string; normalized: string; payload: unknown }, status: string, ankiNoteId?: number): void {
    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.db.prepare(`INSERT OR REPLACE INTO generated_items(package_id,item_id,module_id,kind,normalized_target,payload_json,validation_status,anki_note_id,created_at)
        VALUES (?,?,?,?,?,?,?,?,?)`).run(packageId, item.itemId, item.moduleId, item.kind, item.normalized, JSON.stringify(item.payload), status, ankiNoteId ?? null, now);
      this.db.prepare("INSERT INTO import_events(item_id,action,payload_json,created_at,package_id) VALUES (?,?,?,?,?)")
        .run(item.itemId, status, JSON.stringify({ packageId, moduleId: item.moduleId, kind: item.kind, ankiNoteId: ankiNoteId ?? null }), now, packageId);
    })();
    this.appendSyncEvent("generated_item", { itemId: item.itemId, item: { packageId, ...item, status, ankiNoteId } });
  }

  quarantine(packageId: string, item: { itemId: string; moduleId: string }, payload: unknown, issues: string[]): void {
    this.db.prepare("INSERT INTO quarantine(item_id,module_id,issues_json,payload_json,created_at,package_id) VALUES (?,?,?,?,?,?)")
      .run(item.itemId, item.moduleId, JSON.stringify(issues), JSON.stringify(payload), new Date().toISOString(), packageId);
  }

  listQuarantine(packageId: string): unknown[] {
    return this.db.prepare("SELECT id,package_id AS packageId,item_id AS itemId,module_id AS moduleId,issues_json AS issues,payload_json AS payload,created_at AS createdAt FROM quarantine WHERE package_id=? AND resolved_at IS NULL ORDER BY id DESC").all(packageId)
      .map((row: any) => ({ ...row, issues: JSON.parse(row.issues), payload: JSON.parse(row.payload) }));
  }

  lookupLexicon(surface: string, targetLanguageCode: string, sourceLanguageCode: string): LexiconLookupRow[] {
    const normalized = normalizeLexiconText(surface);
    const rows = this.db.prepare(`
      SELECT DISTINCT s.id AS sense_id,s.lemma,s.pos,s.gloss,s.concept_id,s.frequency_rank,s.provenance_json,
        f.morphology_json,t.translation,t.origin,t.status AS translation_status,t.confidence
      FROM lexicon_senses s
      LEFT JOIN lexicon_forms f ON f.sense_id=s.id AND f.normalized_form=?
      LEFT JOIN translation_cache t ON t.sense_id=s.id AND t.language_code=? AND t.status!='rejected'
      WHERE s.language_code=? AND s.quality_status='approved'
        AND (s.normalized_lemma=? OR f.normalized_form=?)
      ORDER BY CASE WHEN s.normalized_lemma=? THEN 0 ELSE 1 END, COALESCE(s.frequency_rank,2147483647),s.id
      LIMIT 12`).all(normalized, sourceLanguageCode, targetLanguageCode, normalized, normalized, normalized) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      senseId: String(row.sense_id), lemma: String(row.lemma), pos: String(row.pos),
      gloss: row.gloss ? String(row.gloss) : undefined, conceptId: row.concept_id ? String(row.concept_id) : undefined,
      frequencyRank: row.frequency_rank == null ? undefined : Number(row.frequency_rank),
      morphology: JSON.parse(String(row.morphology_json ?? "{}")) as Record<string, unknown>,
      translation: row.translation ? String(row.translation) : undefined,
      origin: row.origin ? String(row.origin) as LexiconLookupRow["origin"] : undefined,
      translationStatus: row.translation_status ? String(row.translation_status) : undefined,
      confidence: row.confidence == null ? undefined : Number(row.confidence),
      provenance: JSON.parse(String(row.provenance_json ?? "{}")) as Record<string, unknown>,
    }));
  }

  lexiconDrawPool(packageId: string, moduleId: string, targetLanguageCode: string, sourceLanguageCode: string): LexiconDrawRow[] {
    const rows = this.db.prepare(`
      SELECT s.id AS sense_id,s.lemma,s.pos,s.gloss,s.cefr,s.frequency,s.frequency_rank,s.provenance_json,
        t.translation,t.example_target,t.example_source,t.notes,t.origin,t.status AS translation_status,t.confidence,
        COALESCE(MAX(m.weight),0) AS mapping_weight,
        GROUP_CONCAT(DISTINCT COALESCE(m.curriculum_tag,c.label)) AS category_tags
      FROM lexicon_senses s
      LEFT JOIN translation_cache t ON t.sense_id=s.id AND t.language_code=? AND t.status!='rejected'
      LEFT JOIN sense_categories sc ON sc.sense_id=s.id
      LEFT JOIN lexicon_categories c ON c.id=sc.category_id
      LEFT JOIN module_category_mappings m ON m.category_id=sc.category_id AND m.package_id=? AND m.module_id=?
      LEFT JOIN module_lexicon_selections selected ON selected.sense_id=s.id AND selected.package_id=?
      WHERE s.language_code=? AND s.quality_status='approved' AND selected.sense_id IS NULL
      GROUP BY s.id
      ORDER BY CASE WHEN MAX(m.weight) IS NULL THEN 1 ELSE 0 END,COALESCE(s.frequency_rank,2147483647),s.id
      LIMIT 2000`).all(sourceLanguageCode, packageId, moduleId, packageId, targetLanguageCode) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      senseId: String(row.sense_id), lemma: String(row.lemma), pos: String(row.pos), gloss: row.gloss ? String(row.gloss) : undefined,
      cefr: row.cefr ? String(row.cefr) : undefined, frequency: row.frequency == null ? undefined : Number(row.frequency),
      frequencyRank: row.frequency_rank == null ? undefined : Number(row.frequency_rank), mappingWeight: Number(row.mapping_weight ?? 0),
      categoryTags: String(row.category_tags ?? "").split(",").filter(Boolean), translation: row.translation ? String(row.translation) : undefined,
      exampleTarget: row.example_target ? String(row.example_target) : undefined, exampleSource: row.example_source ? String(row.example_source) : undefined,
      notes: row.notes ? String(row.notes) : undefined, origin: row.origin ? String(row.origin) as LexiconDrawRow["origin"] : undefined,
      translationStatus: row.translation_status ? String(row.translation_status) : undefined,
      confidence: row.confidence == null ? undefined : Number(row.confidence), provenance: JSON.parse(String(row.provenance_json ?? "{}")),
      morphology: {},
    }));
  }

  cacheLexiconTranslation(senseId: string, languageCode: string, value: { translation: string; exampleTarget?: string; exampleSource?: string; notes?: string; origin: "dictionary" | "concept" | "llm" | "local_mt" | "native"; status: "approved" | "pending_verification" | "rejected"; confidence: number; provider?: string; modelId?: string; modelRevision?: string; modelLicense?: string; sourceLanguageCode?: string; contextHash?: string; translationMode?: "direct" | "pivot" }): void {
    this.db.prepare(`INSERT INTO translation_cache(sense_id,language_code,translation,example_target,example_source,notes,origin,status,confidence,updated_at,provider,model_id,model_revision,source_language_code,context_hash,translation_mode,model_license)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(sense_id,language_code) DO UPDATE SET translation=excluded.translation,
      example_target=COALESCE(excluded.example_target,translation_cache.example_target),example_source=COALESCE(excluded.example_source,translation_cache.example_source),
      notes=COALESCE(excluded.notes,translation_cache.notes),origin=excluded.origin,status=excluded.status,confidence=excluded.confidence,updated_at=excluded.updated_at,
      provider=excluded.provider,model_id=excluded.model_id,model_revision=excluded.model_revision,source_language_code=excluded.source_language_code,context_hash=excluded.context_hash,translation_mode=excluded.translation_mode,model_license=excluded.model_license`)
      .run(senseId, languageCode, value.translation, value.exampleTarget ?? null, value.exampleSource ?? null, value.notes ?? null, value.origin, value.status, value.confidence, new Date().toISOString(), value.provider ?? null, value.modelId ?? null, value.modelRevision ?? null, value.sourceLanguageCode ?? null, value.contextHash ?? null, value.translationMode ?? null, value.modelLicense ?? null);
  }

  listLocalMtInstallations(): Array<{ key: string; status: string; error?: string }> {
    return (this.db.prepare("SELECT key,status,error FROM local_mt_installations ORDER BY key").all() as Array<{ key: string; status: string; error: string | null }>).map((row) => ({ key: row.key, status: row.status, ...(row.error ? { error: row.error } : {}) }));
  }

  saveLocalMtInstallation(model: { key: string; model_id: string; revision: string; license: string; size_bytes: number }, status: "not_installed" | "installing" | "installed" | "failed", installedPath?: string, error?: string): void {
    this.db.prepare(`INSERT INTO local_mt_installations(key,model_id,revision,license,size_bytes,installed_path,status,error,updated_at) VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(key) DO UPDATE SET model_id=excluded.model_id,revision=excluded.revision,license=excluded.license,size_bytes=excluded.size_bytes,
      installed_path=COALESCE(excluded.installed_path,local_mt_installations.installed_path),status=excluded.status,error=excluded.error,updated_at=excluded.updated_at`)
      .run(model.key, model.model_id, model.revision, model.license, model.size_bytes, installedPath ?? null, status, error ?? null, new Date().toISOString());
  }

  failInterruptedLocalMtInstallations(): void {
    this.db.prepare("UPDATE local_mt_installations SET status='failed',error='Installation durch Neustart unterbrochen',updated_at=? WHERE status='installing'")
      .run(new Date().toISOString());
  }

  setLexiconTranslationStatus(senseId: string, languageCode: string, status: "approved" | "pending_verification" | "rejected"): void {
    this.db.prepare("UPDATE translation_cache SET status=?,updated_at=? WHERE sense_id=? AND language_code=?")
      .run(status, new Date().toISOString(), senseId, languageCode);
  }

  saveLexiconSelection(packageId: string, moduleId: string, senseId: string, score: number, seed: string, reasons: string[], status = "selected"): void {
    this.db.prepare(`INSERT INTO module_lexicon_selections(package_id,module_id,sense_id,score,seed,reasons_json,status,created_at)
      VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(package_id,module_id,sense_id) DO UPDATE SET score=excluded.score,seed=excluded.seed,reasons_json=excluded.reasons_json,status=excluded.status`)
      .run(packageId, moduleId, senseId, score, seed, JSON.stringify(reasons), status, new Date().toISOString());
  }

  setLexiconSelectionStatus(packageId: string, moduleId: string, senseId: string, status: "selected" | "materialized" | "imported" | "rejected"): void {
    this.db.prepare("UPDATE module_lexicon_selections SET status=? WHERE package_id=? AND module_id=? AND sense_id=?")
      .run(status, packageId, moduleId, senseId);
  }

  stageLexicon(packageId: string, input: { sessionId?: string; languageCode: string; sourceLanguageCode: string; surface: string; lemma: string; pos: string; translation: string; context?: string; payload: unknown }): string {
    const id = `staging:${randomUUID()}`; const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO lexicon_staging(id,package_id,session_id,language_code,source_language_code,surface,lemma,pos,translation,context,payload_json,status,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, packageId, input.sessionId ?? null, input.languageCode, input.sourceLanguageCode, input.surface, input.lemma, input.pos, input.translation, input.context ?? null, JSON.stringify(input.payload), "pending", now, now);
    return id;
  }

  exportJsonl(): string {
    const tables = ["module_progress", "session_plans", "sessions", "session_events", "placement_sessions", "jobs", "generated_items", "quarantine", "import_events", "api_usage_events", "lexicon_sources", "lexicon_categories", "category_localizations", "module_category_mappings", "lexicon_senses", "lexicon_forms", "sense_categories", "translation_cache", "module_lexicon_selections", "lexicon_staging", "local_mt_installations"];
    const lines: string[] = [];
    for (const table of tables) {
      const rows = this.db.prepare(`SELECT * FROM ${table}`).all();
      for (const row of rows) lines.push(JSON.stringify({ table, exportedAt: new Date().toISOString(), row }));
    }
    return `${lines.join("\n")}${lines.length ? "\n" : ""}`;
  }
}

function transcriptPayload(sessionId: string, eventType: string, payload: unknown): unknown {
  return eventType === "learner_turn" || eventType === "activity_turn" ? { transcriptRef: sessionId } : payload;
}

export interface LexiconLookupRow {
  senseId: string; lemma: string; pos: string; gloss?: string; conceptId?: string; frequencyRank?: number;
  morphology: Record<string, unknown>; translation?: string; origin?: "dictionary" | "concept" | "llm" | "local_mt" | "native";
  translationStatus?: string; confidence?: number; provenance: Record<string, unknown>;
}

export interface LexiconDrawRow extends LexiconLookupRow {
  cefr?: string; frequency?: number; mappingWeight: number; categoryTags: string[];
  exampleTarget?: string; exampleSource?: string; notes?: string;
}

function normalizeLexiconText(value: string): string {
  return value.normalize("NFC").trim().toLocaleLowerCase().replace(/^[^\p{L}\p{M}\d]+|[^\p{L}\p{M}\d]+$/gu, "");
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
