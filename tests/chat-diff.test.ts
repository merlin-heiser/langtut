import { describe, expect, it } from "vitest";
import { wordDiff } from "../apps/web/src/App.js";

describe("chat correction diff", () => {
  it("marks changed words and diacritics without changing equal text", () => {
    const operations = wordDiff("Odkiam v Berlina.", "Som z Berlína.");
    expect(operations.filter(({ kind }) => kind === "delete").map(({ value }) => value)).toEqual(["Odkiam", "v", "Berlina"]);
    expect(operations.filter(({ kind }) => kind === "insert").map(({ value }) => value)).toEqual(["Som", "z", "Berlína"]);
    expect(operations.filter(({ kind }) => kind === "equal").map(({ value }) => value)).toContain(".");
  });
});
