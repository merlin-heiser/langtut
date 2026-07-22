import { describe, expect, it } from "vitest";
import { parseEventSegment, reduceSyncEvents, serializeEventSegment, type SyncEventV1 } from "@langtut/domain";

const event = (id: string, kind: SyncEventV1["kind"], payload: Record<string, unknown>, sequence = 1, deviceId = "a"): SyncEventV1 =>
  ({ schema: 1, id, deviceId, sequence, occurredAt: "2026-01-01T00:00:00.000Z", kind, payload });

describe("Drive sync event reducer", () => {
  it("is idempotent and monotonic for learning progress", () => {
    const events = [event("one", "progress", { packageId: "p", moduleId: "m", status: "learning" }), event("two", "progress", { packageId: "p", moduleId: "m", status: "available" }, 2), event("one", "progress", { packageId: "p", moduleId: "m", status: "learning" })];
    const result = reduceSyncEvents([...events].reverse());
    expect(result.progress["p:m"]).toEqual({ status: "learning", milestones: [] });
  });
  it("merges concurrent milestones and uses a deterministic setting winner", () => {
    const result = reduceSyncEvents([
      event("m1", "milestone_attempted", { packageId: "p", moduleId: "m", milestoneId: "b" }, 2, "b"),
      event("m2", "milestone_attempted", { packageId: "p", moduleId: "m", milestoneId: "a" }, 2, "a"),
      event("s1", "setting", { key: "packages.active", value: "old" }, 1, "a"),
      event("s2", "setting", { key: "packages.active", value: "new" }, 2, "b"),
    ]);
    expect(result.progress["p:m"].milestones).toEqual(["a", "b"]);
    expect(result.settings["packages.active"]).toBe("new");
  });
  it("round-trips immutable NDJSON segments", () => {
    const original = [event("one", "transcript_deleted", { sessionId: "s" })];
    expect(parseEventSegment(serializeEventSegment(original))).toEqual(original);
    expect(reduceSyncEvents(original).deletedTranscripts.s).toBe(true);
  });
});
