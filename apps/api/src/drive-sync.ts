import { gzipSync, gunzipSync } from "node:zlib";
import { GoogleDriveAppDataClient, parseEventSegment, serializeEventSegment, type SyncEventV1 } from "@langtut/domain";
import type { Store } from "./database.js";

export interface DriveSyncStatus { configured: boolean; connected: boolean; pendingEvents: number; lastSyncAt?: string; error?: string; }

/** A deliberately small Drive REST adapter. It uses appDataFolder only, so Langtut files stay hidden from the user's Drive. */
export class GoogleDriveSync {
  private readonly drive: GoogleDriveAppDataClient;
  constructor(private readonly store: Store) { this.drive = new GoogleDriveAppDataClient(() => this.token()); }
  private token(): string | undefined { return this.store.getSetting<string>("google_drive.access_token"); }
  status(): DriveSyncStatus {
    const configured = Boolean(this.token());
    return { configured, connected: configured && !this.store.getSetting<string>("google_drive.last_error"), pendingEvents: this.store.pendingSyncEvents().length, lastSyncAt: this.store.getSetting<string>("google_drive.last_sync_at"), error: this.store.getSetting<string>("google_drive.last_error") };
  }
  configureAccessToken(accessToken: string): void {
    this.store.setSetting("google_drive.access_token", accessToken);
    this.store.deleteSetting("google_drive.last_error");
  }
  disconnect(): void {
    this.store.deleteSetting("google_drive.access_token"); this.store.deleteSetting("google_drive.last_error"); this.store.deleteSetting("google_drive.last_sync_at");
  }
  private async uploadSegment(events: SyncEventV1[]): Promise<void> {
    if (!events.length) return;
    const deviceId = events[0].deviceId; const first = events[0].sequence; const last = events.at(-1)!.sequence;
    const content = gzipSync(serializeEventSegment(events));
    await this.drive.upload(`langtut-events-${deviceId}-${first}-${last}.ndjson.gz`, { langtutKind: "event-segment", deviceId, firstSequence: String(first), lastSequence: String(last), schema: "1" }, content, "application/gzip");
  }
  private async uploadTranscript(sessionId: string, revision: string): Promise<void> {
    const transcript = this.store.getSessionEvents(sessionId); if (!transcript.length) return;
    await this.drive.upload(`langtut-transcript-${sessionId}-${revision}.json.gz`, { langtutKind: "transcript", sessionId, revision, schema: "1" }, gzipSync(JSON.stringify(transcript)), "application/gzip");
  }
  async deleteTranscript(sessionId: string): Promise<DriveSyncStatus> {
    try {
      for (const file of await this.drive.listFiles()) if (file.appProperties?.langtutKind === "transcript" && file.appProperties.sessionId === sessionId) await this.drive.delete(file.id);
      this.store.markTranscriptDeleted(sessionId); return await this.sync();
    } catch (error) { const message = error instanceof Error ? error.message : String(error); this.store.setSetting("google_drive.last_error", message); return this.status(); }
  }
  async sync(): Promise<DriveSyncStatus> {
    try {
      const outgoing = this.store.pendingSyncEvents();
      // A segment is immutable. Retrying after an interrupted request is safe because event IDs are deduplicated on download.
      await this.uploadSegment(outgoing);
      for (const event of outgoing) {
        const p = event.payload;
        if (event.kind === "session_event" && (p.eventType === "learner_turn" || p.eventType === "activity_turn") && typeof p.sessionId === "string") await this.uploadTranscript(p.sessionId, event.id);
      }
      if (outgoing.length) this.store.markSyncEventsUploaded(outgoing.map(({ id }) => id));
      for (const file of (await this.drive.listFiles()).filter((candidate) => candidate.appProperties?.langtutKind === "event-segment")) {
        const events = parseEventSegment(gunzipSync(await this.drive.download(file.id)).toString("utf8")); this.store.ingestSyncEvents(events);
      }
      this.store.setSetting("google_drive.last_sync_at", new Date().toISOString()); this.store.deleteSetting("google_drive.last_error");
      return this.status();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error); this.store.setSetting("google_drive.last_error", message);
      return this.status();
    }
  }
}
