import { loadConfig } from "@agentforge/config";
import { createApp } from "./app.js";
import { hydrateApiAuthEnvironment } from "./runtime-env.js";

hydrateApiAuthEnvironment(loadConfig());
const app = createApp();
const port = Number(process.env.PORT ?? 4000);
const host = process.env.HOST ?? "0.0.0.0";

try {
  await app.listen({ port, host });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
