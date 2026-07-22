const apiBase = process.env.VITE_API_BASE_URL?.trim();

if (!apiBase) {
  console.error("Android builds require VITE_API_BASE_URL, e.g. https://api.example.com/api/v1");
  process.exit(1);
}

let url;
try { url = new URL(apiBase); }
catch { console.error("VITE_API_BASE_URL must be an absolute HTTPS URL."); process.exit(1); }

const localDebugApi = process.env.LANGTUT_ALLOW_HTTP_API === "true" && url.protocol === "http:";
if (url.protocol !== "https:" && !localDebugApi) {
  console.error("Android release builds require an HTTPS API URL.");
  process.exit(1);
}
