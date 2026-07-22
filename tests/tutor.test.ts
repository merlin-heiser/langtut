import { describe, expect, it } from "vitest";
import { normalizeTutorTurn } from "../apps/api/src/app.js";

describe("tutor output normalization", () => {
  it("removes raw markdown and separates a misplaced German explanation", () => {
    expect(normalizeTutorTurn({
      message: "Výborne! **Toto je správne.**Deutsch: Der Satz ist korrekt.",
      correction: "**Toto je správne.**",
      explanation: "Betonung auf der **ersten** Silbe.",
      newExample: "`Toto je príklad.`",
      errorTags: [],
      targetLanguageUse: "target",
      goalProgress: "met",
      conversationState: "continue",
    })).toEqual({
      message: "Výborne! Toto je správne.",
      correction: "Toto je správne.",
      explanation: "Der Satz ist korrekt. Betonung auf der ersten Silbe.",
      newExample: "Toto je príklad.",
      errorTags: [],
      targetLanguageUse: "target",
      goalProgress: "met",
      conversationState: "continue",
    });
  });
});
