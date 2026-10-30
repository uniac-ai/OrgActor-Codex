import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve } from "node:path";
import { getRequestListener } from "@hono/node-server";
import { SessionMcpBridge } from "../actors/bridge.js";
import { ActorSupervisor } from "../actors/supervisor.js";
import { CodexBackend } from "../codex/index.js";
import { OperatorAuth } from "../management/auth.js";
import { management } from "../management/index.js";
import { CodexProvider } from "../provider/index.js";
import { RuntimeStore } from "../runtime/index.js";
import { SetupService } from "../setup/index.js";

export async function startServer(options: {
  root: string;
  port?: number;
  hostname?: string;
  webRoot?: string;
}) {
  const store = new RuntimeStore(options.root);
  const backend = new CodexBackend(store);
  const actors = new ActorSupervisor(store, () => backend.get());
  const provider = new CodexProvider(
    store,
    () => backend.get(),
    (id) => actors.launch(id),
  );
  const setup = new SetupService(store, backend, provider);
  const bridge = new SessionMcpBridge(store, actors);
  const auth = new OperatorAuth();
  const app = management(store, setup, provider, actors, auth);
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
      void bridge.handle(req, res);
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
  server.listen(options.port ?? 8787, options.hostname ?? "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No TCP listener");
  const url = `http://${options.hostname ?? "127.0.0.1"}:${address.port}`;
  actors.recover();
  if (store.data.providerEnabled) void provider.start();
  return {
    url,
    server,
    store,
    backend,
    actors,
    provider,
    setup,
    bridge,
    auth,
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
