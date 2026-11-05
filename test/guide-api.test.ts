import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startServer } from "../src/server/index.js";
import { ed25519, type ThisMac } from "../src/setup/access.js";

async function guided(t: test.TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "orgactor-guide-api-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, "home");
  mkdirSync(join(home, "bin"), { recursive: true });
  writeFileSync(join(home, "host.pub"), `${ed25519("host").public} root@mac\n`);
  writeFileSync(join(home, "bin", "codex"), "#!/bin/sh\n", { mode: 0o755 });
  const mac: ThisMac = {
    platform: "darwin",
    home,
    user: "person",
    shell: "/bin/zsh",
    hostKey: join(home, "host.pub"),
    codex: [join(home, "bin", "codex")],
    sshPort: 22,
    desktopState: join(home, ".codex-global-state.json"),
    // Desktop's `codex --version` answers; `ssh -G` is real, since it only reads the config.
    ssh: async (args) =>
      args[0] === "-G"
        ? { code: 0, stdout: execFileSync("ssh", args, { encoding: "utf8", stdio: "pipe" }) }
        : { code: 0, stdout: "codex-cli 1.2.3\n" },
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
    const text = await response.text();
    assert.doesNotMatch(text, /PRIVATE KEY/, `${method} ${path} never returns key material`);
    return { status: response.status, body: JSON.parse(text) };
  };
  return { server, home, call };
}

test("the guide's API reviews, writes and removes SSH access, never returning a private key", async (t) => {
  const { server, home, call } = await guided(t);
  const guide = await call("GET", "/setup/guide");
  assert.equal(guide.status, 200);
  assert.equal(guide.body.available, true);
  assert.equal(guide.body.inUse, false);
  assert.equal(guide.body.accessPresent, false);
  assert.deepEqual(
    guide.body.steps.map((s: any) => s.id),
    ["hub", "login", "access", "desktop", "folder", "actor", "session", "tools"],
  );
  assert.equal(guide.body.steps[0].code, "HUB_UNCONFIGURED");
  assert.equal((await call("POST", "/setup/guide/check")).status, 200);

  const plan = await call("POST", "/setup/guide/access/plan");
  assert.equal(plan.status, 200);
  assert.ok(plan.body.writes.some((w: any) => w.action === "append" && w.lines.length === 4));
  assert.deepEqual(
    (await call("PUT", "/setup/guide/access", { planId: "another" })).body.error.code,
    "PLAN_STALE",
  );
  assert.equal(
    (await call("PUT", "/setup/guide/access", { planId: plan.body.id, extra: 1 })).status,
    422,
  );
  const applied = await call("PUT", "/setup/guide/access", { planId: plan.body.id });
  assert.equal(applied.status, 200);
  assert.equal(applied.body.settings.backend.kind, "ssh");
  assert.equal(applied.body.settings.backend.privateKeyPresent, true);
  assert.equal((await call("GET", "/setup/guide")).body.inUse, true);
  // Present whatever step the guide is on, so it can always be removed.
  assert.equal((await call("GET", "/setup/guide")).body.accessPresent, true);
  assert.equal(applied.body.settings.bridgeUrl, `${server.url}/mcp`);
  assert.ok(existsSync(join(home, ".ssh", "authorized_keys")));
  assert.equal((await call("POST", "/setup/guide/access/plan")).body.error.code, "ACCESS_PRESENT");

  const removed = await call("DELETE", "/setup/guide/access");
  assert.equal(removed.status, 200);
  assert.equal((await call("GET", "/setup/guide")).body.accessPresent, false);
  assert.equal(removed.body.settings.backend, undefined);
  assert.equal(existsSync(join(home, ".ssh")), false);
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
  // Without the guide's access as the backend, attaching keeps its existing checks.
  assert.equal((await call("POST", "/actors", attach)).body.error.code, "PROVISIONING_FAILED");
  const plan = await call("POST", "/setup/guide/access/plan");
  await call("PUT", "/setup/guide/access", { planId: plan.body.id });
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
    (await call("DELETE", "/setup/guide/access")).body.error.code,
    "EXECUTION_CONFIG_BOUND",
  );
  const detached = await call("DELETE", "/actors/act");
  assert.deepEqual(detached, { status: 200, body: { detached: true } });
  assert.deepEqual((await call("GET", "/state")).body.actors, []);
  assert.equal(
    JSON.parse(readFileSync(server.store.file, "utf8")).journal["http://hub|codex|act"],
    undefined,
  );
  assert.equal((await call("DELETE", "/setup/guide/access")).status, 200);
});

test("off a Mac the guide reports itself unavailable and writes nothing", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "orgactor-guide-linux-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const server = await startServer({
    root: join(dir, "runtime"),
    port: 0,
    mac: {
      platform: "linux",
      home: dir,
      user: "person",
      shell: "/bin/sh",
      hostKey: join(dir, "absent"),
      codex: [],
      sshPort: 22,
      desktopState: join(dir, "absent.json"),
      ssh: async () => ({ code: 255, stdout: "" }),
    },
  });
  t.after(() => server.close());
  const guide = await (await fetch(`${server.url}/api/setup/guide`)).json();
  assert.deepEqual(
    { available: guide.available, steps: guide.steps },
    { available: false, steps: [] },
  );
  const plan = await fetch(`${server.url}/api/setup/guide/access/plan`, { method: "POST" });
  assert.equal((await plan.json()).error.code, "THIS_MAC_UNAVAILABLE");
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
