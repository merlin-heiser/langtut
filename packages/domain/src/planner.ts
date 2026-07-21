import { randomUUID } from "node:crypto";
import type { AnkiMetrics, CurriculumModule, SessionMode, SessionPlan } from "@langtut/contracts";

export interface PlannerConfig {
  timeBudgetMin: number;
  reviewsPerMinute: number;
  overloadRatio: number;
  recoveryLapses7d: number;
  expansionRatio: number;
}

export const defaultPlannerConfig: PlannerConfig = {
  timeBudgetMin: 20,
  reviewsPerMinute: 3,
  overloadRatio: 1.25,
  recoveryLapses7d: 3,
  expansionRatio: 0.5,
};

export function createSessionPlan(anki: AnkiMetrics, module: CurriculumModule | null, config: PlannerConfig = defaultPlannerConfig, packageId = "slowakisch-deutsch"): SessionPlan {
  const capacity = config.timeBudgetMin * config.reviewsPerMinute;
  const reasons: string[] = [];
  let mode: SessionMode;
  let newCardBudget: number;
  if (!anki.reachable) {
    mode = "NORMAL";
    newCardBudget = 0;
    reasons.push("Anki ist nicht erreichbar; Schreibzugriffe und neue Karten bleiben bis zur Diagnose gesperrt.");
  } else if (anki.dueReviews > capacity * config.overloadRatio) {
    mode = "OVERLOAD";
    newCardBudget = 0;
    reasons.push(`Fällige Reviews (${anki.dueReviews}) überschreiten 125 % der Sessionkapazität (${capacity}).`);
  } else if (anki.leeches > 0 || anki.lapses7d >= config.recoveryLapses7d) {
    mode = "RECOVERY";
    newCardBudget = 0;
    reasons.push(`${anki.leeches} Leeches und ${anki.lapses7d} Lapses in sieben Tagen erfordern Stabilisierung.`);
  } else if (module && module.status === "available" && anki.dueReviews <= capacity * config.expansionRatio) {
    mode = "EXPANSION";
    newCardBudget = 5;
    reasons.push(`${module.id} ist verfügbar und die Reviewlast lässt Expansion zu.`);
  } else {
    mode = "NORMAL";
    newCardBudget = 3;
    reasons.push("Reviewlast und Lernstand liegen im normalen Arbeitsbereich.");
  }
  return {
    id: randomUUID(),
    packageId,
    createdAt: new Date().toISOString(),
    mode,
    timeBudgetMin: config.timeBudgetMin,
    reviewCapacity: capacity,
    newCardBudget,
    primaryModuleId: module?.id ?? null,
    focusTags: module?.focusTags ?? [],
    reasons,
    anki,
  };
}
