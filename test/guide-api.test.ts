import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startServer } from "../src/server/index.js";
import { controlSocket, type ThisMac } from "../src/setup/this-mac.js";

async function guided(t: test.TestContext, overrides: Partial<ThisMac> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "orgactor-guide-api-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, "home");
  mkdirSync(join(home, "bin"), { recursive: true });
  writeFileSync(join(home, "bin", "codex"), "#!/bin/sh\n", { mode: 0o755 });
  const starts: string[] = [];
  const mac: ThisMac = {
    platform: "darwin",
    home,
    codex: [join(home, "bin", "codex")],
    startDaemon: async (codex) => {
      starts.push(codex);
      return controlSocket(home);
    },
    ...overrides,
  };
  const server = await startServer({ root: join(dir, "runtime"), port: 0, mac });
  t.after(() => server.close());
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${server.url}/api${path}`, {
      method,
      ...(body === undefined
        ? {}
        : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  };
  return { server, home, call, starts };
}

test("the guide's API checks the app server steps and makes Codex on this Mac the backend", async (t) => {
  const { server, home, call, starts } = await guided(t);
  const guide = await call("GET", "/setup/guide");
  assert.equal(guide.status, 200);
  assert.equal(guide.body.available, true);
  assert.equal(guide.body.inUse, false);
  assert.deepEqual(
    guide.body.steps.map((s: any) => s.id),
    ["hub", "codex", "account", "folder", "actor", "tools"],
  );
  assert.equal(guide.body.steps[0].code, "HUB_UNCONFIGURED");
  assert.equal((await call("POST", "/setup/guide/check")).status, 200);

  const used = await call("PUT", "/setup/guide/codex");
  assert.equal(used.status, 200);
  assert.deepEqual(used.body.settings.backend, {
    kind: "app-server",
    endpoint: `unix://${controlSocket(home)}`,
  });
  assert.equal(used.body.settings.bridgeUrl, `${server.url}/mcp`);
  assert.equal(starts.length, 1);
  assert.equal((await call("GET", "/setup/guide")).body.inUse, true);
});

test("Codex on this Mac isn't made the backend when its app server doesn't start", async (t) => {
  const { server, call } = await guided(t, { startDaemon: async () => undefined });
  const refused = await call("PUT", "/setup/guide/codex");
  assert.equal(refused.status, 503);
  assert.equal(refused.body.error.code, "CODEX_NOT_STARTED");
  assert.equal(server.store.data.settings.backend, undefined);
});

test("the guide's API refuses an adapter-connected folder and creates the chosen one", async (t) => {
  const { server, home, call } = await guided(t);
  const trial = join(home, "trial");
  mkdirSync(join(trial, ".codex"), { recursive: true });
  writeFileSync(join(trial, ".codex", "config.toml"), '[mcp_servers.org]\ncommand = "x"\n');
  const refused = await call("PUT", "/setup/guide/folder", { path: trial });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error.code, "FOLDER_HAS_ADAPTER");
  assert.equal((await call("PUT", "/setup/guide/folder", { path: "relative" })).status, 422);
  assert.equal((await call("POST", "/setup/guide/folder")).body.error.code, "FOLDER_UNCHOSEN");
  const dedicated = join(home, "agentorg-codex");
  const chosen = await call("PUT", "/setup/guide/folder", { path: dedicated });
  assert.equal(chosen.body.settings.workspaceRoot, dedicated);
  assert.equal((await call("POST", "/setup/guide/folder")).status, 200);
  assert.ok(existsSync(dedicated));
  assert.equal(server.store.data.settings.workspaceRoot, dedicated);
});

test("attaching waits for the guide's folder step, and Detach forgets the Actor", async (t) => {
  const { server, call } = await guided(t);
  const attach = { actorId: "act", config: { approvalAuthority: "desktop" } };
  // Without Codex on this Mac as the backend, attaching keeps its existing checks.
  assert.equal((await call("POST", "/actors", attach)).body.error.code, "PROVISIONING_FAILED");
  await call("PUT", "/setup/guide/codex");
  const gated = await call("POST", "/actors", attach);
  assert.equal(gated.status, 409);
  assert.equal(gated.body.error.code, "SETUP_INCOMPLETE");

  assert.equal((await call("DELETE", "/actors/absent")).status, 404);
  server.store.data.actors.act = {
    actorId: "act",
    hubUrl: "http://hub",
    threadId: "",
    bridgeToken: "private",
    enabled: false,
    config: { approvalAuthority: "desktop" },
    submissions: [],
  };
  server.store.data.journal["http://hub|codex|act"] = { fingerprint: "f", state: "failed" };
  assert.equal(
    (await call("PUT", "/setup/guide/folder", { path: "/elsewhere" })).body.error.code,
    "EXECUTION_CONFIG_BOUND",
  );
  const detached = await call("DELETE", "/actors/act");
  assert.deepEqual(detached, { status: 200, body: { detached: true } });
  assert.deepEqual((await call("GET", "/state")).body.actors, []);
  assert.equal(
    JSON.parse(readFileSync(server.store.file, "utf8")).journal["http://hub|codex|act"],
    undefined,
  );
});

test("off a Mac the guide reports itself unavailable and changes nothing", async (t) => {
  const { server, call } = await guided(t, { platform: "linux" });
  const guide = await call("GET", "/setup/guide");
  assert.deepEqual(
    { available: guide.body.available, steps: guide.body.steps },
    { available: false, steps: [] },
  );
  assert.equal((await call("PUT", "/setup/guide/codex")).body.error.code, "THIS_MAC_UNAVAILABLE");
  assert.equal(server.store.data.settings.backend, undefined);
});

test("the API answers only requests addressed to this machine", async (t) => {
  const { server } = await guided(t);
  const port = new URL(server.url).port;
  const status = (host: string) =>
    new Promise<number>((resolve, reject) => {
      const request = httpRequest(
        { host: "127.0.0.1", port, path: "/api/setup/guide", headers: { host } },
        (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        },
      );
      request.on("error", reject);
      request.end();
    });
  for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`, "localhost"])
    assert.equal(await status(host), 200, host);
  for (const host of [`rebound.example:${port}`, "127.0.0.1.rebound.example", "[::2]"])
    assert.equal(await status(host), 403, `Host "${host}"`);
});
