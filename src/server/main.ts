import { resolve } from "node:path";
import { startServer } from "./index.js";

const running = await startServer({
  root: resolve(process.env.ORGACTOR_HOME ?? "./.runtime"),
  port: Number(process.env.PORT ?? 8787),
  hostname: process.env.HOST ?? "127.0.0.1",
});
const invitation = running.auth.issue();
process.stderr.write(
  `OrgActor-Codex console: ${running.url}/#sign-in=${invitation}\nThis one-time operator link expires in 15 minutes.\n`,
);
let closing = false;
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => {
    if (closing) return;
    closing = true;
    void running.close().then(() => process.exit(0));
  });
