import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { type WebSocket, WebSocketServer } from "ws";
import { RuntimeStore } from "../src/runtime/index.js";
import { startServer } from "../src/server/index.js";

function home(t: any) {
  const root = mkdtempSync(join(tmpdir(), "orgactor-lifecycle-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
async function hub(t: any) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  t.after(() => {
    for (const socket of server.clients) socket.terminate();
    server.close();
  });
  const address = server.address() as { port: number };
  return { server, url: `http://127.0.0.1:${address.port}` };
}

function answer(socket: WebSocket, id: string, admitted = true) {
  socket.send(
    JSON.stringify({
      jsonrpc: "2.0",
      id,
      ...(admitted
        ? { result: { connectionId: "admitted" } }
        : { error: { code: -32000, message: "rejected" } }),
    }),
  );
}

test("composition waits for real Provider admission before exposing a ready runtime, without HTTP or native activity", async (t) => {
  const mock = await hub(t);
  let accept!: () => void;
  let received!: () => void;
  const admission = new Promise<void>((r) => {
    received = r;
  });
  const requests: any[] = [];
  mock.server.on("connection", (socket) =>
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      requests.push(message);
      accept = () => answer(socket, message.id);
      received();
    }),
  );
  let returned = false;
  const opening = startServer({
    root: home(t),
    port: 0,
    hub: { url: mock.url, providerId: "composed", credential: "FAKE_PROVIDER_SECRET" },
  });
  void opening.then(() => {
    returned = true;
  });
  await admission;
  assert.equal(returned, false);
  assert.deepEqual(requests[0].params, {
    providerId: "composed",
    credential: "FAKE_PROVIDER_SECRET",
  });
  accept();
  const runtime = await opening;
  t.after(() => runtime.close());
  assert.equal(runtime.ready, true);
  assert.equal(runtime.provider.snapshot().state, "connected");
  assert.equal(runtime.store.data.probes.hub?.state, "ready");
  assert.equal(runtime.store.data.settings.backend, undefined);
  const state = await (await fetch(`${runtime.url}/api/state`)).text();
  assert.ok(!state.includes("FAKE_PROVIDER_SECRET"));
  await runtime.setup.probe("hub");
  assert.equal(requests.length, 1);
  await runtime.provider.setEnabled(false);
  assert.equal(runtime.ready, false);
});

test("server composition preserves pause across restart and omits absent credentials on explicit resume", async (t) => {
  const mock = await hub(t);
  const requests: any[] = [];
  mock.server.on("connection", (socket) =>
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      requests.push(message);
      answer(socket, message.id);
    }),
  );
  const root = home(t);
  const store = new RuntimeStore(root);
  store.data.providerEnabled = false;
  store.save();
  let runtime = await startServer({
    root,
    port: 0,
    hub: { url: mock.url, providerId: "composed" },
  });
  assert.equal(runtime.ready, false);
  assert.equal(runtime.provider.snapshot().state, "paused");
  assert.equal(requests.length, 0);
  const response = await fetch(`${runtime.url}/api/provider`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled: true }),
  });
  assert.equal(response.status, 200);
  assert.equal(runtime.ready, true);
  assert.deepEqual(requests[0].params, { providerId: "composed" });
  await runtime.provider.setEnabled(false);
  await runtime.close();
  runtime = await startServer({ root, port: 0 });
  t.after(() => runtime.close());
  assert.equal(runtime.provider.snapshot().state, "paused");
  assert.equal(requests.length, 1);
});

test("rejected startup stays unready and requires explicit reconnect; successful reconnect establishes readiness", async (t) => {
  const mock = await hub(t);
  let admitted = false;
  let attempts = 0;
  mock.server.on("connection", (socket) =>
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      attempts++;
      answer(socket, message.id, admitted);
    }),
  );
  const runtime = await startServer({
    root: home(t),
    port: 0,
    hub: { url: mock.url, providerId: "composed" },
  });
  t.after(() => runtime.close());
  assert.equal(runtime.ready, false);
  assert.equal(runtime.provider.snapshot().state, "rejected");
  assert.equal(runtime.store.data.probes.hub?.state, "rejected");
  await runtime.provider.start();
  assert.equal(attempts, 1);
  admitted = true;
  await runtime.provider.setEnabled(true);
  assert.equal(runtime.ready, true);
  assert.equal(attempts, 2);
});

test("unconfigured and unreachable diagnostic consoles never claim Provider readiness", async (t) => {
  const root = home(t);
  let runtime = await startServer({ root, port: 0 });
  assert.equal(runtime.ready, false);
  assert.equal(runtime.provider.snapshot().state, "unconfigured");
  assert.equal((await runtime.setup.probe("hub")).state, "unconfigured");
  await runtime.close();
  const mock = await hub(t);
  await new Promise<void>((r) => mock.server.close(() => r()));
  runtime = await startServer({ root, port: 0, hub: { url: mock.url, providerId: "composed" } });
  t.after(() => runtime.close());
  assert.equal(runtime.ready, false);
  assert.equal(runtime.provider.snapshot().state, "unreachable");
  assert.equal(runtime.store.data.probes.hub?.state, "unreachable");
});

test("composition cannot retarget retained execution records", async (t) => {
  const root = home(t);
  const store = new RuntimeStore(root);
  store.data.settings.hub = { url: "http://old", providerId: "old" };
  store.data.journal.old = { state: "unknown", fingerprint: "accepted" };
  store.save();
  await assert.rejects(
    startServer({ root, port: 0, hub: { url: "http://new", providerId: "new" } }),
    (e: any) => e.code === "EXECUTION_CONFIG_BOUND",
  );
  assert.equal(new RuntimeStore(root).data.settings.hub?.providerId, "old");
});
