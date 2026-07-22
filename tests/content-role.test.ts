import { describe, expect, it } from "vitest";
import type { CandidateItem } from "@langtut/contracts";
import { validateLearningRole } from "@langtut/domain";
import { DEFAULT_PACKAGE_ID, loadCurriculum, loadLearningPackage } from "@langtut/domain";
import { buildGenerationPrompt } from "../apps/api/src/content-pipeline.js";

function vocab(slovak: string, german: string, notes = "Alltagswort."): CandidateItem {
  return {
    itemId: `test:${slovak}`,
    kind: "vocab",
    moduleId: "test",
    target: slovak,
    source: german,
    exampleTarget: `Používam slovo ${slovak}.`,
    exampleSource: `Ich verwende das Wort ${german}.`,
    notes,
    tags: [],
  };
}

describe("learning-role separation", () => {
  it.each([
    ["dĺžeň", "Längenzeichen"],
    ["pravopis", "Rechtschreibung"],
    ["prízvuk", "Wortbetonung"],
    ["akuzatív", "Akkusativ"],
    ["minulý čas", "Vergangenheit"],
    ["slovesný vid", "Verbalaspekt"],
    ["vedľajšia veta", "Nebensatz"],
    ["podmieňovací spôsob", "Konditional"],
    ["formálny register", "formales Register"],
  ])("rejects cross-module metalanguage %s", (slovak, german) => {
    expect(validateLearningRole(vocab(slovak, german))).toContain("vocab_is_metalanguage");
  });

  it("targets only missing chunk coverage during continuation", async () => {
    const pkg = await loadLearningPackage(`${process.cwd()}/learning-packages/${DEFAULT_PACKAGE_ID}`, process.cwd());
    const module = pkg.curriculum.modules[0];
    const missing = module.functions[module.functions.length - 1];
    const prompt = buildGenerationPrompt(pkg, module, "chunk", 1, [], [missing]);
    const coverageLine = prompt.split("\n").find((line) => line.includes("Funktionen realisieren:"));
    expect(coverageLine).toContain(`Funktionen realisieren: ${missing}`);
    for (const covered of module.functions.slice(0, -1)) expect(coverageLine).not.toContain(covered);
  });

  it("rejects alphabet symbols and isolated paradigm cells", () => {
    expect(validateLearningRole(vocab("Á", "langes A"))).toContain("vocab_is_symbol_not_lexeme");
    expect(validateLearningRole(vocab("som", "ich bin", "1. Person Singular von byť"))).toContain("vocab_is_inflection_cell");
  });

  it("rejects a non-canonical dictionary form of a closed-class word", () => {
    expect(validateLearningRole(vocab("Ja", "ich"))).toContain("vocab_noncanonical_dictionary_form");
  });

  it.each([
    ["písmeno", "Buchstabe"],
    ["hláskovať", "buchstabieren"],
    ["čas", "Zeit"],
    ["rodina", "Familie"],
    ["keď", "wenn"],
  ])("keeps directly usable lexical vocabulary %s", (slovak, german) => {
    expect(validateLearningRole(vocab(slovak, german))).toEqual([]);
  });

  it("allows metalanguage in rule notes", () => {
    expect(validateLearningRole({ ...vocab("akuzatív", "Akkusativ"), kind: "rule", milestoneId: "case_acc" })).toEqual([]);
  });

  it("keeps grammar metadata out of vocabulary prompts for all 23 modules", async () => {
    const curriculum = await loadCurriculum(process.cwd());
    const pkg = await loadLearningPackage(`${process.cwd()}/learning-packages/${DEFAULT_PACKAGE_ID}`, process.cwd());
    expect(curriculum.modules).toHaveLength(23);
    for (const module of curriculum.modules) {
      const vocabPrompt = buildGenerationPrompt(pkg, module, "vocab", 20, []);
      expect(vocabPrompt).toContain(module.vocabDomains.join(", "));
      expect(vocabPrompt).not.toContain(module.title);
      for (const milestone of module.grammarMilestones) expect(vocabPrompt).not.toContain(milestone.description);

      const chunkPrompt = buildGenerationPrompt(pkg, module, "chunk", 1, []);
      expect(chunkPrompt).toContain(module.functions.join(", "));
      for (const milestone of module.grammarMilestones) expect(chunkPrompt).not.toContain(milestone.description);

      const rulePrompt = buildGenerationPrompt(pkg, module, "rule", module.grammarMilestones.length, []);
      for (const milestone of module.grammarMilestones) expect(rulePrompt).toContain(milestone.description);
    }
  });
});
