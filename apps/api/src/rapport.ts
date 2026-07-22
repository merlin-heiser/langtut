import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { LearnerProfile, TutorTurn } from "@langtut/contracts";
import type { LearningActivity } from "@langtut/domain";

export type SessionEvent = { eventType: string; payload: unknown; createdAt: string };

export function transcriptFromEvents(events: SessionEvent[], activity: LearningActivity): string {
  const labels = new Map(activity.roles.map((role) => [role.id, role.label]));
  const lines: string[] = [];
  for (const event of events) {
    const payload = event.payload as { roleId?: string; message?: string; turn?: TutorTurn };
    if (event.eventType === "learner_turn" && payload.message?.trim()) lines.push(`${labels.get(payload.roleId ?? "") ?? "Lernender"}: ${plain(payload.message)}`);
    if (event.eventType === "activity_turn" && payload.turn?.message?.trim()) lines.push(`${labels.get(payload.roleId ?? "") ?? payload.roleId ?? "Tutor"}: ${plain(payload.turn.message)}`);
  }
  return lines.join("\n");
}

export function aggregateErrorTags(events: SessionEvent[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const event of events) {
    if (event.eventType !== "activity_turn") continue;
    const tags = (event.payload as { turn?: TutorTurn }).turn?.errorTags ?? [];
    for (const tag of new Set(tags.map((value) => plain(value)).filter(Boolean))) counts[tag] = (counts[tag] ?? 0) + 1;
  }
  return counts;
}

export function buildLearnerContext(profile: LearnerProfile | undefined, relevanceTerms: string[]): string {
  if (!profile) return "Noch kein belastbares Lernprofil vorhanden.";
  const terms = relevanceTerms.flatMap(tokens);
  const choose = (values: string[], limit: number) => [...values]
    .map((value, index) => ({ value: plain(value), index, score: tokens(value).filter((token) => terms.includes(token)).length }))
    .filter(({ value }) => value)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit).map(({ value }) => value);
  const sections = [
    ["Interessen", choose(profile.interests, 3)],
    ["Stärken", choose(profile.strengths, 3)],
    ["Schwierigkeiten", choose(profile.difficulties, 3)],
    ["Hilfreich", choose(profile.helpfulSupports, 2)],
    ["Prioritäten", choose(profile.priorities, 2)],
  ] as const;
  return sections.filter(([, values]) => values.length).map(([label, values]) => `${label}: ${values.join("; ")}`).join("\n") || "Noch kein belastbares Lernprofil vorhanden.";
}

export function sanitizeRapportMarkdown(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const result: string[] = [];
  let excludedSection = false;
  for (const line of lines) {
    if (/^#{1,6}\s+/u.test(line)) {
      excludedSection = /quelle|source|beleg|evidenz|sitzung|session|zitat/i.test(line);
      if (excludedSection) continue;
    }
    if (excludedSection || /^\s*>/.test(line) || /^(quelle|source|datum|date|session):/i.test(line.trim())) continue;
    result.push(line.replace(/\b\d{4}-\d{2}-\d{2}(?:T[^\s]+)?\b/g, "").trimEnd());
  }
  const cleaned = result.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!cleaned) throw new Error("rapport_markdown_empty_after_sanitization");
  return `${cleaned}\n`;
}

export async function readRapport(dataRoot: string, packageId: string): Promise<string> {
  try { return await readFile(rapportPath(dataRoot, packageId), "utf8"); }
  catch (error: any) { if (error?.code === "ENOENT") return ""; throw error; }
}

export async function writeRapportAtomic(dataRoot: string, packageId: string, markdown: string): Promise<string> {
  const target = rapportPath(dataRoot, packageId);
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  const clean = sanitizeRapportMarkdown(markdown);
  await writeFile(temporary, clean, "utf8");
  await rename(temporary, target);
  return target;
}

export function rapportPath(dataRoot: string, packageId: string): string {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(packageId)) throw new Error("invalid_package_id");
  return path.join(dataRoot, "rapports", packageId, "rapport.md");
}

function plain(value: string): string { return value.replace(/\s+/g, " ").trim(); }
function tokens(value: string): string[] { return value.toLocaleLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, " ").split(" ").filter((token) => token.length > 2); }
