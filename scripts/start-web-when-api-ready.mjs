import { spawn } from "node:child_process";
import path from "node:path";

const apiUrl = "http://127.0.0.1:3210/health";
const timeoutMs = 30_000;
const startedAt = Date.now();

async function waitForApi() {
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(apiUrl);
      if (response.ok) return;
    } catch {
      // The API is still initializing; retry below.
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Die API wurde nicht innerhalb von ${timeoutMs / 1000} Sekunden unter ${apiUrl} erreichbar.`);
}

try {
  await waitForApi();
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const web = spawn(npm, ["run", "dev"], {
    cwd: path.resolve(import.meta.dirname, "../apps/web"),
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  web.on("spawn", () => console.log("Webapp-Server wird auf Port 5174 gestartet."));
  web.on("error", (error) => {
    console.error("Webapp konnte nicht gestartet werden:", error);
    process.exitCode = 1;
  });
  web.on("exit", (code, signal) => {
    if (code !== 0 || signal) console.error(`Webapp beendet (Code ${code ?? "-"}, Signal ${signal ?? "-"}).`);
    process.exitCode = code ?? (signal ? 1 : 0);
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
