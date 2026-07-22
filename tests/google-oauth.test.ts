import { describe, expect, it } from "vitest";
import { extractGoogleOAuthClientId, extractGoogleOAuthConfig } from "../apps/web/src/google-oauth.js";

const clientId = "1001170730660-r7g4b2892hc8g4p6vq5uah72f5nf9adv.apps.googleusercontent.com";

describe("Google OAuth import", () => {
  it("extracts the client ID from installed-app JSON", () => {
    expect(extractGoogleOAuthClientId({ installed: { client_id: clientId, client_secret: "never-returned" } })).toBe(clientId);
    expect(extractGoogleOAuthConfig({ installed: { client_id: clientId, client_secret: "local-only" } })).toEqual({ clientId, clientSecret: "local-only" });
  });

  it("accepts web client JSON and rejects missing IDs", () => {
    expect(extractGoogleOAuthClientId({ web: { client_id: clientId } })).toBe(clientId);
    expect(() => extractGoogleOAuthClientId({ installed: { client_secret: "secret" } })).toThrow();
  });
});
