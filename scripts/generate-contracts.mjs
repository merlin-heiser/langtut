import { compile } from "json-schema-to-typescript";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const source = path.resolve("specs/schemas/contracts.schema.json");
const target = path.resolve("packages/contracts/src/generated.ts");
await mkdir(path.dirname(target), { recursive: true });
const document = JSON.parse(await readFile(source, "utf8"));
const names = Object.keys(document.definitions);
const generationSchema = {
  $schema: document.$schema,
  title: "GeneratedContracts",
  type: "object",
  definitions: document.definitions,
  properties: Object.fromEntries(names.map((name) => [name, { $ref: `#/definitions/${name}` }])),
};
const output = await compile(generationSchema, "GeneratedContracts", {
  bannerComment: "/* Generated from specs/schemas/contracts.schema.json. Do not edit. */",
  style: { singleQuote: false },
  ignoreMinAndMaxItems: true,
});
await writeFile(target, output, "utf8");
