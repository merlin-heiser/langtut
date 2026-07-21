import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../apps/api/src/database.js";
import { calculateCostMicrousd, resolveProviderSchema } from "../apps/api/src/providers.js";

let temporary: string | undefined;
afterEach(async () => { if (temporary) await rm(temporary, { recursive: true, force: true }); });

describe("API cost accounting", () => {
  it("prices uncached, cached and output tokens independently", () => {
    expect(calculateCostMicrousd(
      { inputTokens: 1000, cachedInputTokens: 100, outputTokens: 200 },
      { effective_date: "2026-07-01", source: "https://example.test", input_per_million: 2.5, cached_input_per_million: 0.25, output_per_million: 15 },
    )).toBe(5275);
  });

  it("inlines shared definitions before sending structured schemas to providers", () => {
    const resolved = resolveProviderSchema(
      { type: "object", properties: { items: { type: "array", items: { $ref: "#/definitions/Item" } } } },
      { Item: { type: "object", properties: { value: { type: "string" } } } },
    );
    expect(JSON.stringify(resolved)).not.toContain("$ref");
    expect(resolved).toMatchObject({ properties: { items: { items: { type: "object", properties: { value: { type: "string" } } } } } });
  });

  it("keeps append-only total and current ISO-week sums", async () => {
    temporary = await mkdtemp(path.join(tmpdir(), "langtut-costs-"));
    const store = await Store.open(path.join(temporary, "test.db"), process.cwd());
    store.recordApiUsage({ provider: "openai", model: "gpt-5.6-terra", taskId: "tutor_conversation", inputTokens: 1000, cachedInputTokens: 100, outputTokens: 200, costMicrousd: 5275, pricingVersion: "2026-07-09", createdAt: "2026-07-20T10:00:00.000Z" });
    store.recordApiUsage({ provider: "gemini", model: "gemini-3.5-flash", taskId: "session_report", inputTokens: 100, cachedInputTokens: 0, outputTokens: 100, costMicrousd: 1000, pricingVersion: "2026-07-09", createdAt: "2026-07-19T10:00:00.000Z" });
    const summary = store.getApiCostSummary(new Date("2026-07-21T12:00:00.000Z"), "2026-07-09");
    expect(summary).toMatchObject({ currency: "USD", weekCost: 0.005275, totalCost: 0.006275, weekInputTokens: 1000, weekOutputTokens: 200, totalInputTokens: 1100, totalOutputTokens: 300, trackedSince: "2026-07-19T10:00:00.000Z" });
    expect(() => store.db.prepare("UPDATE api_usage_events SET cost_microusd=0").run()).toThrow(/append-only/);
    expect(store.exportJsonl()).toContain('"table":"api_usage_events"');
    store.close();
  });
});
