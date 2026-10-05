// Process entry (pm2 wraps scripts, so "is this the main module?" checks don't work).
import { start } from "./server.ts";

start().catch((e: Error) => {
  console.error(`[tm-judge] ${e.message}`);
  process.exit(1);
});
