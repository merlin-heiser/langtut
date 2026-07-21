import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../apps/api/src/database.js";
import Database from "better-sqlite3";

let temporary: string | undefined;
afterEach(async () => { if (temporary) await rm(temporary, { recursive: true, force: true }); });

describe("SQLite event persistence", () => {
  it("applies migrations and enforces append-only session events", async () => {
    temporary = await mkdtemp(path.join(tmpdir(), "langtut-"));
    const store = await Store.open(path.join(temporary, "test.db"), process.cwd());
    store.createSession("slowakisch-deutsch", "s1", null, "a0_alphabet_pronunciation");
    expect(store.getSessionEvents("s1")).toHaveLength(1);
    expect(() => store.db.prepare("UPDATE session_events SET event_type='changed'").run()).toThrow(/append-only/);
    store.saveGenerated("slowakisch-deutsch", { itemId: "i1", moduleId: "m1", kind: "vocab", normalized: "ahoj", payload: { target: "ahoj" } }, "imported", 42);
    expect(store.db.prepare("SELECT count(*) AS count FROM import_events").get()).toMatchObject({ count: 1 });
    expect(store.exportJsonl()).toContain('"table":"import_events"');
    store.close();
  });

  it("moves legacy Slowakisch data into the default package", async () => {
    temporary = await mkdtemp(path.join(tmpdir(), "langtut-legacy-")); const dbPath = path.join(temporary, "legacy.db");
    const legacy = new Database(dbPath);
    for (const file of ["001_initial.sql", "002_metadata_and_quality.sql", "003_api_usage.sql"]) {
      legacy.exec(await readFile(path.join(process.cwd(), "migrations", file), "utf8"));
      legacy.prepare("INSERT INTO schema_migrations(version,applied_at) VALUES (?,?)").run(file.replace(/\.sql$/, ""), new Date().toISOString());
    }
    legacy.prepare("INSERT INTO module_progress(module_id,status,updated_at) VALUES (?,?,?)").run("shared", "learning", new Date().toISOString());
    legacy.prepare("INSERT INTO generated_items(item_id,module_id,kind,normalized_slovak,payload_json,validation_status,created_at) VALUES (?,?,?,?,?,?,?)").run("legacy-item", "shared", "vocab", "ahoj", JSON.stringify({ target: "ahoj" }), "imported", new Date().toISOString());
    legacy.close();
    const migrated = await Store.open(dbPath, process.cwd());
    expect(migrated.getProgress("slowakisch-deutsch").shared).toBe("learning");
    expect(migrated.hasImportedItem("slowakisch-deutsch", "legacy-item")).toBe(true);
    migrated.close();
  });
});
