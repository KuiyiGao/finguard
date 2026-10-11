import path from "node:path";
import { SERVER_ROOT } from "./config.ts";

try {
  process.loadEnvFile(process.env.ENV_FILE ?? path.join(SERVER_ROOT, "..", ".env"));
} catch (err) {
  if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
}
