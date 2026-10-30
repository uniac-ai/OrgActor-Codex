import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve } from "node:path";
import { getRequestListener } from "@hono/node-server";
import { SessionMcpBridge } from "../actors/bridge.js";
import { ActorSupervisor } from "../actors/supervisor.js";
import { CodexBackend } from "../codex/index.js";
import { management } from "../management/index.js";
import { Fault, HubConfig } from "../management/schema.js";
import { CodexProvider } from "../provider/index.js";
import { RuntimeStore } from "../runtime/index.js";
import { SetupService } from "../setup/index.js";

export async function startServer(options: {
  root: string;
  port?: number;
  hostname?: string;
  webRoot?: string;
  hub?: HubConfig;
}) {
  const store = new RuntimeStore(options.root);
  if (options.hub) {
    const hub = HubConfig.parse(options.hub);
    const old = store.data.settings.hub;
    if (JSON.stringify(hub) !== JSON.stringify(old)) {
      if (Object.keys(store.data.actors).length || Object.keys(store.data.journal).length)
        throw new Fault(
          "EXECUTION_CONFIG_BOUND",
          "Existing execution records are bound to the configured Hub.",
        );
      store.data.settings.hub = hub;
      store.data.revision += 1;
      store.data.probes = {};
      store.save();
    }
  }
  const backend = new CodexBackend(store);
  const actors = new ActorSupervisor(store, () => setup.executionAdapter());
  const provider = new CodexProvider(
    store,
    () => setup.executionAdapter(),
    (id) => actors.launch(id),
  );
  const setup: SetupService = new SetupService(store, backend, provider);
  const bridge = new SessionMcpBridge(store, actors);
  const app = management(store, setup, provider, actors);
  const webRoot = resolve(options.webRoot ?? "dist/web");
  app.get("/*", async (c) => {
    const pathname = new URL(c.req.url).pathname;
    const target = resolve(webRoot, `.${pathname === "/" ? "/index.html" : pathname}`);
    if (!target.startsWith(`${webRoot}/`)) return c.notFound();
    try {
      const data = await readFile(target);
      const types: Record<string, string> = {
        ".html": "text/html",
        ".js": "application/javascript",
        ".css": "text/css",
        ".svg": "image/svg+xml",
        ".png": "image/png",
      };
      c.header("Content-Type", types[extname(target)] ?? "application/octet-stream");
      c.header(
        "Content-Security-Policy",
        "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
      );
      return c.body(data);
    } catch {
      return c.notFound();
    }
  });
  const listener = getRequestListener(app.fetch);
  const server = createServer((req, res) => {
    const path = req.url?.split("?")[0];
    if (path === "/mcp") {
      void bridge.handle(req, res).catch(() => {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
      return;
    }
    if (path?.startsWith("/bridge-health/")) {
      const challenge = path.slice(15);
      if (setup.challenge(challenge))
        res
          .writeHead(200, { "Content-Type": "text/plain", "Cache-Control": "no-store" })
          .end(challenge);
      else res.writeHead(404).end();
      return;
    }
    void listener(req, res);
  });
  server.requestTimeout = 90_000;
  if (store.data.providerEnabled && store.data.settings.hub) await setup.probe("hub");
  server.listen(options.port ?? 8787, options.hostname ?? "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No TCP listener");
  const url = `http://${options.hostname ?? "127.0.0.1"}:${address.port}`;
  actors.recover();
  return {
    url,
    server,
    store,
    backend,
    actors,
    provider,
    setup,
    bridge,
    get ready() {
      return (
        server.listening &&
        store.data.providerEnabled &&
        !!store.data.settings.hub &&
        !!provider.connection?.connected
      );
    },
    app,
    async close() {
      provider.close();
      await actors.close();
      backend.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
