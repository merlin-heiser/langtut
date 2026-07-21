import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../apps/api/src/database.js";

let temporary: string | undefined;
afterEach(async () => { if (temporary) await rm(temporary, { recursive: true, force: true }); });

describe("SQLite event persistence", () => {
  it("applies migrations and enforces append-only session events", async () => {
    temporary = await mkdtemp(path.join(tmpdir(), "langtut-"));
    const store = await Store.open(path.join(temporary, "test.db"), process.cwd());
    store.createSession("s1", null, "a0_alphabet_pronunciation");
    expect(store.getSessionEvents("s1")).toHaveLength(1);
    expect(() => store.db.prepare("UPDATE session_events SET event_type='changed'").run()).toThrow(/append-only/);
    store.saveGenerated({ itemId: "i1", moduleId: "m1", kind: "vocab", normalized: "ahoj", payload: { slovak: "ahoj" } }, "imported", 42);
    expect(store.db.prepare("SELECT count(*) AS count FROM import_events").get()).toMatchObject({ count: 1 });
    expect(store.exportJsonl()).toContain('"table":"import_events"');
    store.close();
  });
});
