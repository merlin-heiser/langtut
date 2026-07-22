const CLIENT_ID_PATTERN = /^[0-9]+-[a-z0-9-]+\.apps\.googleusercontent\.com$/i;

export type GoogleOAuthClientConfig = { clientId: string; clientSecret?: string };

/** Extract OAuth client settings without exposing them outside the local API flow. */
export function extractGoogleOAuthConfig(value: unknown): GoogleOAuthClientConfig {
  if (!value || typeof value !== "object") throw new Error("Die Google-OAuth-Datei ist kein JSON-Objekt.");
  const root = value as Record<string, unknown>;
  const profiles = [root, root.installed as Record<string, unknown> | undefined, root.web as Record<string, unknown> | undefined].filter(Boolean) as Record<string, unknown>[];
  const candidates = profiles.map((profile) => profile.client_id);
  const clientId = candidates.find((candidate): candidate is string => typeof candidate === "string" && CLIENT_ID_PATTERN.test(candidate.trim()))?.trim();
  if (!clientId) throw new Error("Keine gültige Google-OAuth-Client-ID in der Datei gefunden.");
  const profile = profiles.find((candidate) => candidate.client_id === clientId);
  const clientSecret = typeof profile?.client_secret === "string" ? profile.client_secret.trim() : undefined;
  return clientSecret ? { clientId, clientSecret } : { clientId };
}

export function extractGoogleOAuthClientId(value: unknown): string {
  return extractGoogleOAuthConfig(value).clientId;
}

export async function readGoogleOAuthClientFile(file: File): Promise<GoogleOAuthClientConfig> {
  let parsed: unknown;
  try { parsed = JSON.parse(await file.text()); }
  catch { throw new Error("Die Google-OAuth-Datei enthält kein gültiges JSON."); }
  return extractGoogleOAuthConfig(parsed);
}
