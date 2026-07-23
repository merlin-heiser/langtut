import type { LangtutClient } from "@langtut/runtime";

const API_BASE = import.meta.env.VITE_API_BASE_URL?.trim().replace(/\/$/, "") || "/api/v1";

export function createHttpLangtutClient(base = API_BASE, fetcher: typeof fetch = fetch): LangtutClient {
const retryableMethods = new Set(["GET", "HEAD", "OPTIONS"]);
const retryableStatuses = new Set([502, 503, 504]);

async function fetchWithTransientRetry(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const method = (init?.method ?? "GET").toUpperCase();
  const canRetry = retryableMethods.has(method);
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetcher(input, init);
      if (!canRetry || !retryableStatuses.has(response.status) || attempt >= 2) return response;
    } catch (error) {
      if (!canRetry || attempt >= 2) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)));
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetchWithTransientRetry(`${base}${path}`, { ...init, headers: { ...(!(init?.body instanceof FormData) ? { "content-type": "application/json" } : {}), ...init?.headers } });
  const raw = await response.text(); let body: Record<string, unknown> | undefined;
  if (raw.trim()) { try { body = JSON.parse(raw) as Record<string, unknown>; } catch { throw new Error(`Ungültige Serverantwort (${response.status})`); } }
  if (!response.ok) throw new Error(typeof body?.error === "string" ? body.error : `HTTP ${response.status}`);
  return body as T;
}
const post = <T>(path: string, body: unknown = {}) => request<T>(path, { method: "POST", body: JSON.stringify(body) });
return {
  status: () => request("/status"), costs: () => request("/costs/summary"), curriculum: () => request("/curriculum"), moduleProgress: () => request("/modules/progress"), latestPlacement: () => request("/placement-sessions/latest"), latestJob: () => request("/jobs/latest"), job: (id) => request(`/jobs/${encodeURIComponent(id)}`), settings: () => request("/settings"), packages: () => request("/packages"), activities: () => request("/activities"),
  startPlacement: () => post("/placement-sessions"), answerPlacement: (id, itemId, answer) => post(`/placement-sessions/${encodeURIComponent(id)}/answers`, { itemId, answer }), overridePlacement: (id, moduleId) => post(`/placement-sessions/${encodeURIComponent(id)}/override`, { moduleId }), prepareModule: (id) => post(`/modules/${encodeURIComponent(id)}/prepare`), createSessionPlan: () => post("/session-plans"), dailyPlan: () => request("/daily-plan"), createDailyPlan: () => post("/daily-plan"), completeDailyTask: (planId, taskId, result) => post(`/daily-plan/${encodeURIComponent(planId)}/tasks/${encodeURIComponent(taskId)}/complete`, { result }), startSession: (input) => post("/sessions", input), activityTurn: (id, message) => post(`/sessions/${encodeURIComponent(id)}/activity-turns`, { message }), submitExercise: (id, answer) => post(`/sessions/${encodeURIComponent(id)}/exercise-attempts`, { answer }), activateTarget: (moduleId, targetId) => post(`/modules/${encodeURIComponent(moduleId)}/targets/${encodeURIComponent(targetId)}/activate`), recordMilestone: (moduleId, milestoneId) => post(`/modules/${encodeURIComponent(moduleId)}/milestones/${encodeURIComponent(milestoneId)}/attempt`),
  saveAnkiKey: (apiKey) => post("/settings/anki-api-key", { apiKey }), saveProviderKey: (provider, apiKey) => post(`/settings/providers/${provider}/key`, { apiKey }), saveModels: (selection) => post("/settings/models", selection), saveLocalMt: (settings) => post("/settings/local-mt", settings), installLocalMt: (key) => post(`/settings/local-mt/models/${encodeURIComponent(key)}/install`), syncNow: () => post("/sync/now"), configureGoogle: (input) => post("/sync/google/client", input), acceptGoogleToken: (accessToken) => post("/sync/google/token", { accessToken }), authorizeGoogle: async () => { window.location.assign(`${base}/sync/google/authorize?return_to=${encodeURIComponent(window.location.href)}`); return new Promise<never>(() => undefined); },
  activatePackage: (id) => post(`/packages/${encodeURIComponent(id)}/activate`), importPackage: (file) => { const body = new FormData(); body.append("file", file); return request("/packages/import", { method: "POST", body }); }, previewAnkiSetup: () => post("/integrations/anki/setup/preview"), applyAnkiSetup: () => post("/integrations/anki/setup/apply", { confirm: true }), lookupLexicon: (input) => post("/lexicon/lookup", input), stageLexicon: (input) => post("/lexicon/staging", input),
};
}

export const httpClient = createHttpLangtutClient();
