import { lstat, mkdir, readlink, readdir, rm, symlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scope = path.join(root, "node_modules", "@langtut");
await mkdir(scope, { recursive: true });

for (const parent of ["apps", "packages"]) {
  const parentPath = path.join(root, parent);
  for (const entry of await readdir(parentPath, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const source = path.join(parentPath, entry.name);
    const target = path.join(scope, entry.name);
    let stat;
    try { stat = await lstat(target); } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    if (stat) {
      if (!stat.isSymbolicLink()) throw new Error(`Refusing to replace non-link workspace path: ${target}`);
      const linked = path.resolve(path.dirname(target), await readlink(target));
      if (samePath(linked, source)) continue;
      await rm(target);
    }
    await symlink(source, target, process.platform === "win32" ? "junction" : "dir");
    console.log(`Linked @langtut/${entry.name} -> ${source}`);
  }
}

function samePath(a, b) {
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}
