/**
 * Pi web daemon entry point. All server features live in the sibling modules
 * (see `webServerApp.ts` for the composition root); this file only boots the
 * app so `bun run web/server/index.ts` keeps spawning the daemon directly.
 */
import { createWebServerApp } from "./webServerApp.js";

const app = createWebServerApp();

void app.lifecycle.start().catch((error) => {
  console.error(error);
  process.exit(1);
});
