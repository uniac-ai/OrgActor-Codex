import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import WebSocket, { WebSocketServer } from "ws";
import { ActorController } from "../src/actors/controller.js";
import { AppServerAdapter, NativeProtocol, SshAdapter } from "../src/codex/index.js";
import { RuntimeStore } from "../src/runtime/index.js";

async function fixture(t: any) {
  const sockets = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(sockets, "listening");
  const address = sockets.address();
  assert.ok(address && typeof address === "object");
  const state = {
    mode: "paginated",
    id: "owned",
    status: "idle",
    path: null as string | null,
    preview: "",
    materialized: false,
    turns: [] as any[],
    error: undefined as { code: number; message?: string } | undefined,
    metadataError: false,
    calls: [] as { method: string; params: any }[],
  };
  const empty =
    "thread owned is not materialized yet; includeTurns is unavailable before first user message";
  const metadata = () => ({
    id: state.id,
    historyMode: state.mode,
    status: { type: state.status },
    path: state.path,
    preview: state.preview,
    name: null,
    modelProvider: "openai",
    turns: [],
  });
  sockets.on("connection", (socket) =>
    socket.on("message", (raw) => {
      const frame = JSON.parse(String(raw));
      if (frame.id === undefined) return;
      state.calls.push({ method: frame.method, params: frame.params });
      let result: any = {};
      let error: { code: number; message?: string } | undefined;
      if (frame.method === "thread/start") {
        state.mode = frame.params.historyMode ?? "paginated";
        result = { thread: metadata() };
      } else if (frame.method === "thread/resume") {
        if (!state.materialized)
          error = {
            code: -32600,
            message: `no rollout found for thread id ${frame.params.threadId}`,
          };
        result = { thread: metadata() };
      } else if (frame.method === "thread/read") {
        if (frame.params.includeTurns) {
          error =
            state.error ??
            (!state.materialized
              ? state.mode === "legacy"
                ? { code: -32600, message: empty }
                : { code: -32601, message: "list_turns is not supported yet" }
              : undefined);
          result = { thread: { ...metadata(), turns: state.turns } };
        } else {
          if (state.metadataError) error = { code: -32600, message: empty };
          result = { thread: metadata() };
        }
      } else if (frame.method !== "initialize")
        error = { code: -32601, message: "Unexpected native operation" };
      socket.send(JSON.stringify({ id: frame.id, ...(error ? { error } : { result }) }));
    }),
  );
  const protocol = new NativeProtocol(new WebSocket(`ws://127.0.0.1:${address.port}`));
  t.after(async () => {
    protocol.close();
    for (const socket of sockets.clients) socket.terminate();
    await new Promise<void>((resolve) => sockets.close(() => resolve()));
  });
  await protocol.initialize();
  return { protocol, state, empty };
}

for (const Adapter of [SshAdapter, AppServerAdapter])
  test(`${Adapter.name} reconciles a fresh unnamed session before any user message or presentation rename`, async (t) => {
    const { protocol, state } = await fixture(t);
    const native = new Adapter(protocol);
    const threadId = await native.create({
      cwd: "/owned",
      bridgeUrl: "http://127.0.0.1/mcp",
      bridgeToken: "BRIDGE_TEST_ONLY",
    });
    await native.resume(threadId, {
      bridgeUrl: "http://127.0.0.1/mcp",
      bridgeToken: "BRIDGE_TEST_ONLY",
      initial: true,
    });
    const root = mkdtempSync(join(tmpdir(), "orgactor-empty-history-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const store = new RuntimeStore(root);
    const bootstrap = {
      actorId: "actor",
      threadId,
      hubUrl: "http://unused",
      bridgeToken: "BRIDGE_TEST_ONLY",
      enabled: true,
      config: { approvalAuthority: "desktop" as const },
      submissions: [] as any[],
    };
    store.data.actors.actor = bootstrap;
    const actor = new ActorController(bootstrap, store, async () => native);
    actor.adapter = native;
    await actor.reconcile();
    assert.equal(actor.snapshot().observation, "available");
    assert.equal(actor.turnId, null);
    assert.equal(state.mode, "legacy");
    assert.ok(!state.calls.some((c) => ["thread/name/set", "turn/start"].includes(c.method)));
    assert.ok(!state.calls.some((c) => c.method === "thread/resume"));
    state.materialized = true;
    state.path = "/owned/history.jsonl";
    state.turns = [
      {
        id: "turn-owned",
        status: "completed",
        items: [
          { type: "userMessage", clientId: "known" },
          { type: "agentMessage", text: "actual" },
        ],
      },
    ];
    bootstrap.submissions.push({
      id: "known",
      text: "task",
      from: "operator",
      cause: null,
      state: "unknown",
    });
    await actor.reconcile();
    assert.equal(bootstrap.submissions[0].result?.status, "completed");
    assert.equal(bootstrap.submissions[0].result?.output, "actual");
  });

test("initial reuse requires the creating adapter, unchanged binding, empty identity and no submitted request", async (t) => {
  const { protocol, state } = await fixture(t);
  const native = new AppServerAdapter(protocol);
  const binding = {
    bridgeUrl: "http://127.0.0.1/mcp",
    bridgeToken: "CAPABILITY_SENTINEL",
    initial: true,
  };
  await native.create({ cwd: "/owned", ...binding });
  await assert.rejects(
    new AppServerAdapter(protocol).resume("owned", binding),
    (e: any) => e.code === "NATIVE_REJECTED" && e.native.reason === "missing-rollout",
  );
  await assert.rejects(native.resume("foreign", binding), (e: any) => e.code === "NATIVE_REJECTED");
  await assert.rejects(
    native.resume("owned", { ...binding, bridgeToken: "OTHER" }),
    (e: any) => e.code === "NATIVE_BINDING_MISMATCH",
  );
  for (const mismatch of [
    { id: "foreign" },
    { status: "active" },
    { mode: "paginated" },
    { preview: "Existing user message" },
    { turns: [{ id: "foreign-turn", status: "completed", items: [] }] },
  ]) {
    Object.assign(
      state,
      { id: "owned", mode: "legacy", status: "idle", preview: "", turns: [], materialized: true },
      mismatch,
    );
    await assert.rejects(
      native.resume("owned", binding),
      (e: any) => e.code === "NATIVE_INITIAL_STATE_MISMATCH",
    );
  }
  Object.assign(state, {
    id: "owned",
    mode: "legacy",
    status: "idle",
    preview: "",
    turns: [],
    materialized: false,
    error: { code: -32601, message: "UNSUPPORTED SECRET_NATIVE_PAYLOAD" },
  });
  await assert.rejects(
    native.resume("owned", binding),
    (e: any) =>
      e.code === "NATIVE_REJECTED" && !JSON.stringify(e).includes("SECRET_NATIVE_PAYLOAD"),
  );
  state.error = undefined;
  await assert.rejects(native.start("owned", "mock submitted request", "input"));
  await assert.rejects(native.resume("owned", binding), (e: any) => e.code === "NATIVE_REJECTED");
});

test("only the exact scoped native unmaterialized signal plus idle legacy metadata establishes empty history", async (t) => {
  const { protocol, state, empty } = await fixture(t);
  const native = new AppServerAdapter(protocol);
  state.mode = "legacy";
  for (const error of [
    { code: -32601, message: "list_turns is not supported yet" },
    { code: -32600, message: empty.replace("owned", "foreign") },
    { code: -32600, message: "Other failure" },
    { code: -32600 },
  ]) {
    state.error = error;
    await assert.rejects(native.read("owned"), (e: any) => e.code === "NATIVE_REJECTED");
  }
  state.error = undefined;
  for (const mismatch of [
    { status: "active" },
    { preview: "A first user message already exists" },
    { id: "foreign" },
    { mode: "paginated" },
  ]) {
    Object.assign(
      state,
      {
        id: "owned",
        mode: "legacy",
        status: "idle",
        path: null,
        preview: "",
        error: { code: -32600, message: empty },
      },
      mismatch,
    );
    await assert.rejects(
      native.read("owned"),
      (e: any) => e.code === "NATIVE_HISTORY_UNMATERIALIZED",
    );
  }
  Object.assign(state, {
    id: "owned",
    mode: "legacy",
    status: "idle",
    path: null,
    preview: "",
    error: undefined,
    metadataError: true,
  });
  await assert.rejects(native.read("owned"), (e: any) => e.code === "NATIVE_REJECTED");
});
