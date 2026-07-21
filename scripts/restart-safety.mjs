import Database from "better-sqlite3";
import path from "node:path";
import { existsSync } from "node:fs";

const root = path.resolve(import.meta.dirname, "..");
const dbPath = path.resolve(root, process.env.LANGTUT_DB_PATH ?? "data/langtut.db");

if (!existsSync(dbPath)) {
  console.log("Kein lokaler Lernstand vorhanden; Neustart ist sicher.");
  process.exit(0);
}

const db = new Database(dbPath, { readonly: true, fileMustExist: true });
try {
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(({ name }) => name));
  const blockers = [];

  if (tables.has("jobs")) {
    const jobs = db.prepare("SELECT id,kind,module_id,status,progress FROM jobs WHERE status IN ('queued','running') ORDER BY created_at").all();
    for (const job of jobs) blockers.push(`Generierungsjob ${job.id} (${job.kind}${job.module_id ? `, Modul ${job.module_id}` : ""}) ist ${job.status}; Fortschritt ${Math.round(job.progress * 100)} %.`);
  }

  if (tables.has("placement_sessions")) {
    const placements = db.prepare("SELECT id,payload_json FROM placement_sessions WHERE status='active' ORDER BY created_at").all();
    for (const placement of placements) {
      const payload = JSON.parse(placement.payload_json);
      blockers.push(`Placement ${placement.id} ist nach ${payload.itemsAnswered ?? 0} beantworteten Aufgaben noch aktiv.`);
    }
  }

  if (tables.has("sessions")) {
    const sessions = db.prepare("SELECT id,module_id FROM sessions WHERE status='active' ORDER BY created_at").all();
    for (const session of sessions) blockers.push(`Tutor-Session ${session.id}${session.module_id ? ` für ${session.module_id}` : ""} ist noch aktiv.`);
  }

  if (blockers.length) {
    console.error("Sanfter Neustart abgebrochen: Nicht abgeschlossener Fortschritt könnte in der Browseroberfläche verloren gehen:");
    for (const blocker of blockers) console.error(`  - ${blocker}`);
    console.error("Schließe diese Vorgänge zuerst ab oder verwende bewusst: make force webapp");
    process.exit(2);
  }

  console.log("Keine aktiven Placements, Tutor-Sessions oder Generierungsjobs gefunden.");
} finally {
  db.close();
}
