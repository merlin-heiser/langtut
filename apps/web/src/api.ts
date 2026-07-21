const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "/api/v1";

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, { ...init, headers: { "content-type": "application/json", ...init?.headers } });
  const raw = await response.text();
  let body: Record<string, unknown> | undefined;
  if (raw.trim()) {
    try { body = JSON.parse(raw) as Record<string, unknown>; }
    catch { throw new Error(`Ungültige Serverantwort (${response.status})`); }
  }
  if (!response.ok) throw new Error(typeof body?.error === "string" ? body.error : `HTTP ${response.status}`);
  return body as T;
}

export const post = <T>(path: string, body: unknown = {}) => api<T>(path, { method: "POST", body: JSON.stringify(body) });
