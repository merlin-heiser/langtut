import { buildApp } from "./app.js";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../../..");
const app = await buildApp(root);
const port = Number(process.env.LANGTUT_PORT ?? 3210);
try {
  await app.listen({ port, host: "127.0.0.1" });
} catch (error) {
  if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
    app.log.error(`Port ${port} ist bereits belegt. Beende den älteren Langtut-API-Prozess oder setze LANGTUT_PORT.`);
  }
  throw error;
}
