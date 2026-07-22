import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { aggregateErrorTags, buildLearnerContext, transcriptFromEvents, writeRapportAtomic } from "../apps/api/src/rapport.js";
import type { LearningActivity } from "@langtut/domain";

const temporary: string[] = [];
afterEach(async () => { for (const folder of temporary.splice(0)) await rm(folder, { recursive: true, force: true }); });

const activity: LearningActivity = {
  id: "cafe", title: "V kaviarni", type: "roleplay", scenarioTarget: "Objednajte si.", scenarioSource: "Bestellen Sie.", rounds: 4,
  roles: [{ id: "waiter", label: "Čašník", controller: "llm" }, { id: "learner", label: "Lernender", controller: "learner" }], turnOrder: ["waiter", "learner"],
};

describe("learner rapport", () => {
  it("renders only spoken turns and aggregates unique error tags", () => {
    const events = [
      { eventType: "session_started", payload: { internal: true }, createdAt: "x" },
      { eventType: "activity_turn", payload: { roleId: "waiter", turn: { message: "Dobrý deň!", correction: "", explanation: "", newExample: "", errorTags: [] } }, createdAt: "x" },
      { eventType: "learner_turn", payload: { roleId: "learner", message: "Ja chcieť káva." }, createdAt: "x" },
      { eventType: "activity_turn", payload: { roleId: "waiter", turn: { message: "Nech sa páči.", correction: "Chcem kávu.", explanation: "", newExample: "", errorTags: ["grammar_case", "grammar_case"] } }, createdAt: "x" },
    ];
    expect(transcriptFromEvents(events, activity)).toBe("Čašník: Dobrý deň!\nLernender: Ja chcieť káva.\nČašník: Nech sa páči.");
    expect(aggregateErrorTags(events)).toEqual({ grammar_case: 1 });
  });

  it("limits the prompt context and atomically writes a source-free rapport", async () => {
    const context = buildLearnerContext({
      interests: ["Reisen", "Kochen", "Musik", "Sport"], strengths: ["Gute Aussprache", "Sicherer Wortschatz", "Flüssige Antworten", "Gute Fragen"],
      difficulties: ["Akkusativ", "Wortstellung", "Aspekt", "Genitiv"], helpfulSupports: ["Kurze Modelle", "Nachfragen", "Übersetzungen"], priorities: ["Restaurant", "Reisen", "Arbeit"],
    }, ["Reisen", "Restaurant"]);
    expect(context.match(/; /g)?.length ?? 0).toBeLessThanOrEqual(8);
    const root = await mkdtemp(path.join(tmpdir(), "langtut-rapport-")); temporary.push(root);
    const target = await writeRapportAtomic(root, "slowakisch-deutsch", "# Lernrapport\n\n## Stärken\n- Gute Fragen\n\n## Quellen\n> Originalzitat\nDatum: 2026-07-22\n");
    const written = await readFile(target, "utf8");
    expect(written).toContain("Gute Fragen");
    expect(written).not.toMatch(/Quellen|Originalzitat|2026-07-22/);
  });
});
