import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { WebSocketServer } from "ws";
import { projectTool } from "../src/actors/bridge.js";
import { Fault } from "../src/management/schema.js";
import { CodexProvider } from "../src/provider/index.js";
import { RuntimeStore } from "../src/runtime/index.js";
import { startServer } from "../src/server/index.js";
import { SetupService } from "../src/setup/index.js";

function fixture(t: any) {
  const dir = mkdtempSync(join(tmpdir(), "orgactor-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new RuntimeStore(dir);
  store.data.providerEnabled = false;
  store.data.settings = {
    backend: { kind: "app-server", endpoint: "unix:///test.sock" },
    workspaceRoot: "/owned/workspace",
    bridgeUrl: "http://127.0.0.1:8787/mcp",
    hub: { url: "http://127.0.0.1:8740", providerId: "provider", credential: "PROVIDER_SENTINEL" },
  };
  store.save();
  return store;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

test("native creation completes with Actor admission completely held; same inputs reconcile", async (t) => {
  const store = fixture(t);
  const held = deferred<string>();
  let starts = 0;
  let handoffs = 0;
  const provider = new CodexProvider(
    store,
    async () =>
      ({
        create: async () => {
          starts++;
          return held.promise;
        },
      }) as any,
    () => handoffs++,
  );
  const input = { actorId: "actor", credential: "ACTOR_SENTINEL", config: {} };
  const first = provider.create(input);
  const duplicate = provider.create(input);
  await new Promise(setImmediate);
  assert.equal(starts, 1);
  await assert.rejects(
    provider.create({ ...input, credential: "DIFFERENT" }),
    (e: any) => e.code === "CREATION_CONFLICT",
  );
  held.resolve("native-thread");
  assert.deepEqual(await first, { actorId: "actor" });
  await duplicate;
  assert.equal(handoffs, 1);
  assert.equal(store.data.actors.actor.credential, "ACTOR_SENTINEL");
  assert.equal(statSync(store.file).mode & 0o777, 0o600);
  assert.equal(statSync(store.root).mode & 0o777, 0o700);
  assert.deepEqual(await provider.create(input), { actorId: "actor" });
  assert.equal(starts, 1);
});
test("ambiguous native creation survives restart without replay", async (t) => {
  const store = fixture(t);
  let starts = 0;
  const adapter = async () =>
    ({
      create: async () => {
        starts++;
        throw new Fault("NATIVE_UNKNOWN", "Response lost");
      },
    }) as any;
  const provider = new CodexProvider(store, adapter, () =>
    assert.fail("No handoff without a native identity"),
  );
  const input = { actorId: "actor", credential: "ACTOR_SENTINEL", config: {} };
  await assert.rejects(provider.create(input), (e: any) => e.code === "PROVISIONING_UNKNOWN");
  const restarted = new CodexProvider(new RuntimeStore(store.root), adapter, () => {});
  await assert.rejects(restarted.create(input), (e: any) => e.code === "PROVISIONING_UNKNOWN");
  assert.equal(starts, 1);
});
test("ManagementApi opens directly, validates mutations and keeps private material write-only", async (t) => {
  const store = fixture(t);
  const server = await startServer({ root: store.root, port: 0 });
  t.after(() => server.close());
  const initial = await fetch(`${server.url}/api/state`);
  assert.equal(initial.status, 200);
  assert.equal(initial.headers.get("set-cookie"), null);
  assert.equal(initial.headers.get("cache-control"), "no-store");
  const headers = { "Content-Type": "application/json" };
  const settings = {
    backend: {
      kind: "ssh",
      host: "localhost",
      port: 22,
      user: "test",
      privateKey: "KEY_SENTINEL",
      knownHosts: "HOST_SENTINEL",
    },
  };
  const save = await fetch(`${server.url}/api/setup`, {
    method: "PUT",
    headers,
    body: JSON.stringify(settings),
  });
  assert.equal(save.status, 200);
  const overwrite = await fetch(`${server.url}/api/setup`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ ...settings, hub: { url: "http://other", providerId: "browser" } }),
  });
  assert.equal(overwrite.status, 422);
  const state = await (await fetch(`${server.url}/api/state`)).text();
  for (const secret of ["KEY_SENTINEL", "HOST_SENTINEL", "PROVIDER_SENTINEL"])
    assert.ok(!state.includes(secret));
  assert.match(state, /credentialPresent/);
  assert.equal(server.store.data.settings.hub?.providerId, "provider");
  assert.match(readFileSync(store.file, "utf8"), /PROVIDER_SENTINEL/);
  assert.equal(statSync(store.file).mode & 0o777, 0o600);
  assert.equal(statSync(store.root).mode & 0o777, 0o700);
  assert.equal(
    (
      await fetch(`${server.url}/api/provider`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ enabled: false }),
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await fetch(`${server.url}/api/actors`, {
        method: "POST",
        headers,
        body: JSON.stringify({ actorId: "actor" }),
      })
    ).status,
    422,
  );
});
test("settings cannot switch any bound execution target, including paused bindings", (t) => {
  const store = fixture(t);
  const setup = new SetupService(store, { close() {} } as any);
  store.data.journal.old = { fingerprint: "accepted", state: "unknown" };
  assert.throws(
    () =>
      setup.configure({ backend: store.data.settings.backend, bridgeUrl: "http://another/mcp" }),
    (e: any) => e.code === "EXECUTION_CONFIG_BOUND",
  );
});
test("single login owner is claimed before awaits and survives settings attempts and unrelated completion", async (t) => {
  const store = fixture(t);
  const backendReady = deferred<any>();
  let starts = 0;
  let listener: any;
  const backend = { get: () => backendReady.promise, close() {} } as any;
  const setup = new SetupService(store, backend);
  const first = setup.login();
  await assert.rejects(setup.login(), (e: any) => e.code === "LOGIN_IN_PROGRESS");
  assert.throws(
    () => setup.configure(store.data.settings),
    (e: any) => e.code === "LOGIN_IN_PROGRESS",
  );
  backendReady.resolve({
    protocol: {
      request: async () => {
        starts++;
        return { loginId: "owned", authUrl: "https://auth.openai.com/owned" };
      },
      watch: (fn: any) => {
        listener = fn;
        return () => {};
      },
    },
  });
  await first;
  assert.equal(starts, 1);
  listener({ method: "account/login/completed", params: { loginId: "foreign" } });
  await assert.rejects(setup.login(), (e: any) => e.code === "LOGIN_IN_PROGRESS");
  listener({ method: "account/login/completed", params: { loginId: "owned" } });
  await setup.login();
  assert.equal(starts, 2);
});
test("authenticated account with unavailable quota is distinct from explicit denial", async (t) => {
  const store = fixture(t);
  let allowed: boolean | undefined;
  const setup = new SetupService(store, {
    get: async () => ({
      protocol: {
        request: async (name: string) =>
          name === "account/read"
            ? { account: { type: "chatgpt", planType: "pro" } }
            : { ordinaryUsageAllowed: allowed },
      },
    }),
  } as any);
  const unavailable = await setup.probe("account");
  assert.equal(unavailable.state, "ready");
  assert.equal(unavailable.code, "CHATGPT_AUTHENTICATED_QUOTA_UNAVAILABLE");
  assert.equal(unavailable.details?.ordinaryUsageAllowed, null);
  allowed = false;
  assert.equal((await setup.probe("account")).code, "PLAN_USAGE_DENIED");
  allowed = true;
  assert.equal((await setup.probe("account")).code, "PLAN_USAGE_ALLOWED");
});
test("model Actor creation schema removes only its known credential field", () => {
  const original: Tool = {
    name: "actor_create",
    inputSchema: { type: "object" },
    outputSchema: {
      type: "object",
      properties: {
        actor: { type: "object" },
        credential: { type: "string" },
        execution: { type: "object" },
      },
      required: ["actor", "credential"],
      additionalProperties: false,
    },
    _meta: { "agentorg/tool": { id: "hub:actors", interface: "actor_create" } },
  };
  const visible = projectTool(original);
  assert.deepEqual(visible.outputSchema?.required, ["actor"]);
  assert.ok(visible.outputSchema?.properties);
  assert.ok(original.outputSchema?.properties);
  assert.ok(!Object.hasOwn(visible.outputSchema.properties as object, "credential"));
  assert.ok(Object.hasOwn(original.outputSchema.properties as object, "credential"));
  assert.deepEqual(visible._meta, original._meta);
});
test("checking an active Provider uses the actual admitted socket; replacement stops autonomous retries", async (t) => {
  const store = fixture(t);
  const sockets = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(sockets, "listening");
  t.after(() => {
    for (const s of sockets.clients) s.terminate();
    sockets.close();
  });
  let admissions = 0;
  let latest: any;
  sockets.on("connection", (socket) =>
    socket.on("message", (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.method !== "connection.connect") return;
      admissions++;
      latest?.close(4000, "replaced");
      latest = socket;
      socket.send(
        JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { connectionId: `c-${admissions}` } }),
      );
    }),
  );
  const address = sockets.address() as any;
  assert.ok(store.data.settings.hub);
  store.data.settings.hub.url = `http://127.0.0.1:${address.port}`;
  store.data.providerEnabled = true;
  const first = new CodexProvider(
    store,
    async () => ({}) as any,
    () => {},
  );
  t.after(() => first.close());
  await first.start();
  const connectionId = first.connection?.connectionId;
  const setup = new SetupService(store, {} as any, first);
  assert.equal((await setup.probe("hub")).state, "ready");
  assert.equal(first.connection?.connectionId, connectionId);
  assert.equal(admissions, 1);
  const secondStore = fixture(t);
  secondStore.data.settings.hub = store.data.settings.hub;
  secondStore.data.providerEnabled = true;
  const second = new CodexProvider(
    secondStore,
    async () => ({}) as any,
    () => {},
  );
  t.after(() => second.close());
  assert.ok(first.connection);
  const closed = once(first.connection, "closed");
  await second.start();
  await closed;
  assert.equal(store.data.providerSuspended, 4000);
  await first.start();
  assert.equal(admissions, 2);
  assert.equal(second.connection?.connected, true);
});
