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
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
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
  const attach = { actorId: "act", config: {} };
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
    config: {},
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

test("a request another site's page could send unasked, or from a foreign Origin, is refused", async (t) => {
  const { server } = await guided(t);
  server.store.data.actors.act = {
    actorId: "act",
    hubUrl: "http://hub",
    threadId: "thread",
    bridgeToken: "private",
    enabled: false,
    config: {},
    submissions: [],
  };
  const send = (method: string, path: string, headers: Record<string, string>, body?: unknown) =>
    fetch(`${server.url}/api${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }).then(async (r) => ({ status: r.status, code: (await r.json()).error?.code }));
  const input = { inputId: "i1", text: "run this" };
  // A form-like POST needs no preflight, so the browser sends it from any site.
  for (const type of ["text/plain;charset=UTF-8", "application/x-www-form-urlencoded"])
    assert.deepEqual(await send("POST", "/actors/act/inputs", { "content-type": type }, input), {
      status: 415,
      code: "JSON_REQUIRED",
    });
  assert.deepEqual(await send("POST", "/setup/probes/backend", {}), {
    status: 415,
    code: "JSON_REQUIRED",
  });
  for (const origin of ["https://attacker.example", "http://localhost:1", "null"])
    assert.deepEqual(
      await send(
        "POST",
        "/actors/act/inputs",
        { "content-type": "application/json", origin },
        input,
      ),
      { status: 403, code: "ORIGIN_NOT_ALLOWED" },
    );
  assert.deepEqual(await send("GET", "/state", { origin: "https://attacker.example" }), {
    status: 403,
    code: "ORIGIN_NOT_ALLOWED",
  });
  assert.deepEqual(server.store.data.actors.act.submissions, []);
  // The console's own requests: JSON from its own origin, or a client that sends no Origin.
  const own = { "content-type": "application/json", origin: new URL(server.url).origin };
  assert.equal((await send("POST", "/setup/probes/backend", own)).status, 200);
  assert.equal((await send("GET", "/state", { origin: own.origin })).status, 200);
  assert.equal(
    (await send("POST", "/setup/probes/backend", { "content-type": "application/json" })).status,
    200,
  );
});
