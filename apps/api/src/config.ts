import { readFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";

export interface AppConfig {
  root: string;
  port: number;
  dbPath: string;
  anki: { url: string; deck: string; key?: string };
  planner: {
    timeBudgetMin: number;
    reviewsPerMinute: number;
    overloadRatio: number;
    recoveryLapses7d: number;
    expansionRatio: number;
  };
  modelTasksPath: string;
}

export async function loadConfig(root = process.cwd()): Promise<AppConfig> {
  const raw = YAML.parse(await readFile(path.join(root, "config/app.yaml"), "utf8"));
  return {
    root,
    port: Number(process.env.LANGTUT_PORT ?? 3210),
    dbPath: path.resolve(root, process.env.LANGTUT_DB_PATH ?? "data/langtut.db"),
    anki: {
      url: process.env.ANKI_CONNECT_URL ?? raw.anki?.url ?? "http://localhost:8765",
      deck: process.env.ANKI_DECK ?? raw.anki?.deck ?? "Slovak Tutor",
      key: process.env.ANKI_CONNECT_KEY,
    },
    planner: {
      timeBudgetMin: raw.session.time_budget_min,
      reviewsPerMinute: raw.session.reviews_per_minute,
      overloadRatio: raw.session.overload_ratio,
      recoveryLapses7d: raw.session.recovery_lapses_7d,
      expansionRatio: raw.session.expansion_ratio,
    },
    modelTasksPath: path.resolve(root, raw.models),
  };
}
