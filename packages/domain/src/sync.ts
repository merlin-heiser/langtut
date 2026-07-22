/** Platform-independent event log used to replicate Langtut state through Drive. */
export type SyncEventKind =
  | "progress"
  | "milestone_attempted"
  | "setting"
  | "session_event"
  | "session_plan"
  | "placement"
  | "generated_item"
  | "transcript_deleted";

export interface SyncEventV1 {
  schema: 1;
  id: string;
  deviceId: string;
  sequence: number;
  occurredAt: string;
  kind: SyncEventKind;
  payload: Record<string, unknown>;
}

export interface SyncProjection {
  progress: Record<string, { status: string; milestones: string[] }>;
  settings: Record<string, unknown>;
  sessionEvents: Record<string, Array<{ eventType: string; payload: unknown; occurredAt: string }>>;
  sessionPlans: Record<string, unknown>;
  placements: Record<string, unknown>;
  generatedItems: Record<string, unknown>;
  deletedTranscripts: Record<string, true>;
}

export const emptySyncProjection = (): SyncProjection => ({
  progress: {}, settings: {}, sessionEvents: {}, sessionPlans: {}, placements: {}, generatedItems: {}, deletedTranscripts: {},
});

const statusRank: Record<string, number> = { locked: 0, available: 1, preparing: 2, learning: 3, credited: 4 };
const order = (event: SyncEventV1) => `${event.occurredAt}\u0000${event.deviceId}\u0000${String(event.sequence).padStart(16, "0")}`;

/** Reduces an unordered collection deterministically. Duplicate IDs are ignored. */
export function reduceSyncEvents(events: Iterable<SyncEventV1>): SyncProjection {
  const state = emptySyncProjection();
  const unique = new Map<string, SyncEventV1>();
  for (const event of events) if (event.schema === 1 && !unique.has(event.id)) unique.set(event.id, event);
  const latestSettings = new Map<string, SyncEventV1>();
  for (const event of [...unique.values()].sort((a, b) => order(a).localeCompare(order(b)))) {
    const p = event.payload;
    if (event.kind === "progress" || event.kind === "milestone_attempted") {
      const key = `${String(p.packageId)}:${String(p.moduleId)}`;
      const current = state.progress[key] ?? { status: "locked", milestones: [] };
      const candidate = typeof p.status === "string" ? p.status : current.status;
      current.status = (statusRank[candidate] ?? -1) > (statusRank[current.status] ?? -1) ? candidate : current.status;
      if (typeof p.milestoneId === "string") current.milestones = [...new Set([...current.milestones, p.milestoneId])].sort();
      if (Array.isArray(p.attemptedMilestones)) current.milestones = [...new Set([...current.milestones, ...p.attemptedMilestones.filter((x): x is string => typeof x === "string")])].sort();
      state.progress[key] = current;
    } else if (event.kind === "setting" && typeof p.key === "string") {
      const existing = latestSettings.get(p.key);
      if (!existing || order(event) > order(existing)) { latestSettings.set(p.key, event); state.settings[p.key] = p.value; }
    } else if (event.kind === "session_event" && typeof p.sessionId === "string") {
      const list = state.sessionEvents[p.sessionId] ?? [];
      list.push({ eventType: String(p.eventType), payload: p.payload, occurredAt: event.occurredAt }); state.sessionEvents[p.sessionId] = list;
    } else if (event.kind === "session_plan" && typeof p.id === "string") state.sessionPlans[p.id] = p.plan;
    else if (event.kind === "placement" && typeof p.id === "string") state.placements[p.id] = p.placement;
    else if (event.kind === "generated_item" && typeof p.itemId === "string") state.generatedItems[p.itemId] = p.item;
    else if (event.kind === "transcript_deleted" && typeof p.sessionId === "string") state.deletedTranscripts[p.sessionId] = true;
  }
  return state;
}

export function serializeEventSegment(events: SyncEventV1[]): string {
  return events.map((event) => JSON.stringify(event)).join("\n") + (events.length ? "\n" : "");
}

export function parseEventSegment(value: string): SyncEventV1[] {
  return value.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as SyncEventV1);
}
