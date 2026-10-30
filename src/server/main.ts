import { resolve } from "node:path";
import { HubConfig } from "../management/schema.js";
import { startServer } from "./index.js";

const hubConfigured =
  process.env.HUB_URL || process.env.PROVIDER_ID || process.env.PROVIDER_CREDENTIAL;
if (hubConfigured && (!process.env.HUB_URL || !process.env.PROVIDER_ID))
  throw new Error("HUB_URL and PROVIDER_ID must be configured together.");
const running = await startServer({
  root: resolve(process.env.ORGACTOR_HOME ?? "./.runtime"),
  port: Number(process.env.PORT ?? 8787),
  hostname: process.env.HOST ?? "127.0.0.1",
  ...(hubConfigured
    ? {
        hub: HubConfig.parse({
          url: process.env.HUB_URL,
          providerId: process.env.PROVIDER_ID,
          ...(process.env.PROVIDER_CREDENTIAL
            ? { credential: process.env.PROVIDER_CREDENTIAL }
            : {}),
        }),
      }
    : {}),
});
process.stderr.write(
  `OrgActor-Codex console: ${running.url}/\nProvider: ${running.provider.snapshot().state}\n`,
);
let closing = false;
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => {
    if (closing) return;
    closing = true;
    void running.close().then(() => process.exit(0));
  });
