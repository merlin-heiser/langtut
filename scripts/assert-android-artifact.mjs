import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const root = path.resolve("apps/web/dist");
const files = [];
async function visit(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) await visit(target); else files.push(target);
  }
}
await visit(root);
const forbidden = [/VITE_API_BASE_URL/, /\/api\/v1/, /(?:localhost|127\.0\.0\.1):3210/, /https?:\/\/[^\s"']+\/api\/v1/];
const failures = [];
for (const file of files.filter((value) => /\.(?:js|html|json)$/.test(value))) {
  const content = await readFile(file, "utf8");
  for (const pattern of forbidden) if (pattern.test(content)) failures.push(`${path.relative(root, file)} contains ${pattern}`);
}
if (failures.length) { console.error(failures.join("\n")); process.exit(1); }
console.log("Android artifact contains no Langtut backend configuration or route base.");
