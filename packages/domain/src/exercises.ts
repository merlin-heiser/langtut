export const exerciseTypes = ["flashcards_translation", "gap_fill", "sentence_building", "declension_drills", "conjugation_drills", "dictation_light"] as const;
export type ExerciseType = typeof exerciseTypes[number];
export type ExerciseDefinition = { prompt: string; answers: string[]; tokens?: string[]; hint?: string };
export type ExerciseResult = { outcome: "correct" | "near_correct" | "incorrect"; expected: string; feedback: string };

export function isExerciseType(value: unknown): value is ExerciseType { return typeof value === "string" && (exerciseTypes as readonly string[]).includes(value); }
export function evaluateExercise(answer: string, definition: ExerciseDefinition): ExerciseResult {
  const exact = normalize(answer); const accepted = definition.answers.map(normalize);
  if (accepted.includes(exact)) return { outcome: "correct", expected: definition.answers[0], feedback: "Richtig." };
  if (accepted.some((value) => stripDiacritics(value) === stripDiacritics(exact))) return { outcome: "near_correct", expected: definition.answers[0], feedback: "Fast richtig – achte auf die Diakritik." };
  return { outcome: "incorrect", expected: definition.answers[0], feedback: "Noch nicht. Vergleiche die Lösung und versuche es erneut." };
}
function normalize(value: string) { return value.normalize("NFC").trim().replace(/\s+/g, " ").toLocaleLowerCase(); }
function stripDiacritics(value: string) { return value.normalize("NFD").replace(/\p{M}/gu, "").normalize("NFC"); }
