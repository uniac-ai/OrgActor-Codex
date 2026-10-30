import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { type WebSocket, WebSocketServer } from "ws";
import type { ActorController } from "../src/actors/controller.js";
import { RuntimeStore } from "../src/runtime/index.js";
import { startServer } from "../src/server/index.js";

const tool = (id: string, name: string, alias: string) => ({
  name: alias,
  inputSchema: { type: "object" as const },
  _meta: {
    "agentorg/tool": {
      id,
      name: id.slice(4),
      interface: name,
      routed: false,
      one_way: false,
      long_running: false,
    },
  },
});
const tools = [
  tool("hub:team", "team", "team_alias"),
  tool("hub:messages", "messages", "inbox_alias"),
];
async function until(description: string, read: () => boolean) {
  for (let i = 0; i < 500; i++) {
    if (read()) return;
    await setTimeout(10);
  }
  assert.fail(description);
}

for (const mode of ["fresh", "unknown", "offline"])
  test(`production provisioning ${mode === "unknown" ? "refuses initial reuse with an uncertain accepted input" : mode === "offline" ? "completes native creation while Actor admission is held" : "prepares the Hub bridge before native creation and keeps its owners through first use"}`, {
    timeout: 15_000,
  }, async (t) => {
    const root = mkdtempSync(join(tmpdir(), "orgactor-provision-"));
    const hub = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    const native = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await Promise.all([once(hub, "listening"), once(native, "listening")]);
    const hubUrl = `http://127.0.0.1:${(hub.address() as { port: number }).port}`;
    const nativeUrl = `ws://127.0.0.1:${(native.address() as { port: number }).port}`;
    const state = {
      calls: [] as string[],
      materialized: false,
      mcpReady: false,
      mcpError: undefined as unknown,
      actorClosed: false,
      providerReply: undefined as any,
      runReply: undefined as any,
      earlyReply: undefined as any,
      actorAdmissions: 0,
      causes: [] as (string | undefined)[],
    };
    let providerSocket!: WebSocket;
    let actorSocket!: WebSocket;
    let creatingSocket!: WebSocket;
    let preparedActor!: ActorController;
    let preparedHub: ActorController["hub"];
    let startReplied = false;
    const mcp = new Client({ name: "mock-native", version: "1" });
    const metadata = () => ({
      id: "fresh-native",
      historyMode: "legacy",
      status: { type: "idle" },
      preview: "",
      name: null,
      cwd: "/owned",
      modelProvider: "openai",
      turns: [],
    });
    hub.on("connection", (socket) =>
      socket.on("message", (raw) => {
        const m = JSON.parse(String(raw));
        const respond = (result: any) =>
          socket.send(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }));
        if (m.method === "connection.connect") {
          if (m.params.providerId) providerSocket = socket;
          else {
            assert.deepEqual(m.params, {
              actorId: "fresh-actor",
              credential: "ACTOR_SECRET_SENTINEL",
            });
            actorSocket = socket;
            state.actorAdmissions++;
            socket.on("close", () => {
              state.actorClosed = true;
            });
          }
          if (m.params.actorId && mode === "offline") return;
          respond({ connectionId: m.params.actorId ? "actor-peer" : "provider-peer" });
          if (m.params.actorId)
            socket.send(
              JSON.stringify({
                jsonrpc: "2.0",
                id: "reverse-init",
                method: "initialize",
                params: {
                  protocolVersion: "2025-11-25",
                  capabilities: {},
                  clientInfo: { name: "mock-hub", version: "1" },
                },
              }),
            );
        } else if (m.method === "initialize")
          respond({
            protocolVersion: m.params.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: "mock-hub", version: "1" },
          });
        else if (m.method === "tools/list") respond({ tools });
        else if (m.method === "tools/call" && m.params.name === "team_alias") {
          state.causes.push(m.params._meta?.["agentorg/cause"]);
          const value = { root: "root", positions: [{ id: "fresh-actor", manager: "root" }] };
          respond({
            content: [{ type: "text", text: JSON.stringify(value) }],
            structuredContent: value,
          });
        } else if (m.id === "create") state.providerReply = m;
        else if (m.id === "run") state.runReply = m;
        else if (m.id === "early") state.earlyReply = m;
      }),
    );
    native.on("connection", (socket) =>
      socket.on("message", (raw) => {
        const m = JSON.parse(String(raw));
        if (m.id === undefined) return;
        state.calls.push(m.method);
        const respond = (result: any) => socket.send(JSON.stringify({ id: m.id, result }));
        const error = (code: number, message: string) =>
          socket.send(JSON.stringify({ id: m.id, error: { code, message } }));
        if (m.method === "initialize") respond({});
        else if (m.method === "thread/start") {
          creatingSocket = socket;
          preparedActor = runtime.actors.get("fresh-actor");
          preparedHub = preparedActor.hub;
          assert.equal(preparedActor.bootstrap.threadId, "");
          assert.throws(
            () => preparedActor.enqueue("before-binding", "Too early"),
            (e: any) => e.code === "NATIVE_BINDING_PENDING",
          );
          if (mode === "unknown") {
            runtime.store.data.actors["fresh-actor"].submissions.push({
              id: "uncertain",
              text: "Already accepted",
              from: "root",
              cause: null,
              state: "unknown",
            });
            runtime.store.save();
          }
          assert.equal(m.params.historyMode, "legacy");
          assert.equal(m.params.config.forced_login_method, "chatgpt");
          const acknowledgeStart = () => {
            startReplied = true;
            respond({ thread: metadata() });
          };
          const config = m.params.config["mcp_servers.org"];
          assert.equal(config.required, false);
          if (mode === "offline") {
            acknowledgeStart();
            return;
          }
          void mcp
            .connect(
              new StreamableHTTPClientTransport(new URL(config.url), {
                requestInit: { headers: config.http_headers },
              }),
            )
            .then(() => mcp.listTools())
            .then(async (list) => {
              assert.equal(list.tools.length, 2);
              assert.equal(startReplied, false);
              assert.equal(preparedActor.hubReady, true);
              assert.equal(preparedActor.bootstrap.threadId, "");
              assert.equal(runtime.actors.get("fresh-actor"), preparedActor);
              assert.equal(preparedActor.hub, preparedHub);
              actorSocket.send(
                JSON.stringify({
                  jsonrpc: "2.0",
                  id: "early",
                  method: "tools/call",
                  params: {
                    name: "run",
                    arguments: { text: "Before binding" },
                    _meta: { "agentorg/call": { id: "early-input", from: "root", cause: null } },
                  },
                }),
              );
              await until("Pre-binding Hub input is rejected", () => !!state.earlyReply);
              assert.equal(state.earlyReply.result.isError, true);
              assert.match(state.earlyReply.result.content[0].text, /NATIVE_BINDING_PENDING/);
              assert.equal(preparedActor.bootstrap.submissions.length, mode === "unknown" ? 1 : 0);
              state.mcpReady = true;
              acknowledgeStart();
            })
            .catch((e) => {
              state.mcpError = e;
            });
        } else if (m.method === "thread/resume")
          error(-32600, "no rollout found for thread id fresh-native");
        else if (m.method === "thread/read") {
          if (m.params.includeTurns) {
            assert.throws(
              () => preparedActor.enqueue("during-binding", "Too early"),
              (e: any) => e.code === "NATIVE_BINDING_PENDING",
            );
          }
          if (m.params.includeTurns && !state.materialized)
            error(
              -32600,
              "thread fresh-native is not materialized yet; includeTurns is unavailable before first user message",
            );
          else respond({ thread: metadata() });
        } else if (m.method === "mcpServerStatus/list")
          respond({ data: [{ name: "org", tools: state.mcpReady ? { team_alias: {} } : {} }] });
        else if (m.method === "account/read") respond({ account: { type: "chatgpt" } });
        else if (m.method === "account/rateLimits/read") respond({ ordinaryUsageAllowed: true });
        else if (m.method === "turn/start") {
          assert.equal(socket, creatingSocket);
          state.materialized = true;
          respond({ turn: { id: "mock-turn" } });
          socket.send(
            JSON.stringify({
              method: "turn/started",
              params: { threadId: "fresh-native", turn: { id: "mock-turn" } },
            }),
          );
          socket.send(
            JSON.stringify({
              method: "item/completed",
              params: {
                threadId: "fresh-native",
                turnId: "mock-turn",
                item: { type: "userMessage", clientId: m.params.clientUserMessageId },
              },
            }),
          );
          void mcp
            .callTool({ name: "team_alias", arguments: {}, _meta: { threadId: "fresh-native" } })
            .then(() => {
              socket.send(
                JSON.stringify({
                  method: "turn/completed",
                  params: {
                    threadId: "fresh-native",
                    turn: {
                      id: "mock-turn",
                      status: "completed",
                      items: [
                        { type: "userMessage", clientId: m.params.clientUserMessageId },
                        { type: "agentMessage", text: "MOCK_COMPLETE" },
                      ],
                    },
                  },
                }),
              );
            });
        } else error(-32601, "Unexpected native operation");
      }),
    );
    const seed = new RuntimeStore(root);
    seed.data.settings = {
      backend: { kind: "app-server", endpoint: nativeUrl },
      workspaceRoot: "/owned",
      hub: { url: hubUrl, providerId: "provider", credential: "PROVIDER_SECRET_SENTINEL" },
    };
    seed.save();
    const runtime = await startServer({ root, port: 0 });
    runtime.store.data.settings.bridgeUrl = `${runtime.url}/mcp`;
    runtime.store.save();
    t.after(async () => {
      await mcp.close();
      await runtime.close();
      for (const s of [...hub.clients, ...native.clients]) s.terminate();
      await Promise.all([
        new Promise<void>((r) => hub.close(() => r())),
        new Promise<void>((r) => native.close(() => r())),
      ]);
      rmSync(root, { recursive: true, force: true });
    });
    providerSocket.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "create",
        method: "provider.createActor",
        params: { actorId: "fresh-actor", credential: "ACTOR_SECRET_SENTINEL", config: {} },
      }),
    );
    await until("Provider creation reply", () => !!state.providerReply);
    assert.deepEqual(state.providerReply.result, { actorId: "fresh-actor" });
    if (mode !== "unknown") {
      assert.ok(runtime.actors.get("fresh-actor") === preparedActor);
      assert.ok(preparedActor.hub === preparedHub);
    }
    assert.equal(preparedActor.bootstrap.threadId, "fresh-native");
    assert.equal(state.actorAdmissions, 1);
    if (mode === "offline") {
      assert.equal(Object.values(runtime.store.data.journal)[0].state, "ready");
      assert.equal(preparedActor.hubReady, false);
      assert.equal(preparedActor.snapshot().observation, "unavailable");
      assert.equal(state.calls.includes("thread/resume"), false);
      assert.equal(state.calls.includes("turn/start"), false);
      assert.equal(preparedActor.bootstrap.submissions.length, 0);
      return;
    }
    assert.equal(state.mcpReady, true);
    await until(
      "Actual Controller native observation or recorded failure",
      () =>
        runtime.actors.actors.get("fresh-actor")?.snapshot().observation === "available" ||
        !!runtime.store.data.actors["fresh-actor"].startupFailure,
    );
    if (mode === "unknown") {
      const bootstrap = runtime.store.data.actors["fresh-actor"];
      assert.deepEqual(bootstrap.startupFailure, {
        phase: "native",
        code: "NATIVE_REJECTED",
        native: { method: "thread/resume", code: -32600, reason: "missing-rollout" },
      });
      assert.equal(bootstrap.submissions[0].state, "unknown");
      assert.equal(state.calls.filter((m) => m === "thread/resume").length, 1);
      assert.equal(state.calls.includes("turn/start"), false);
      assert.equal(JSON.stringify(bootstrap.startupFailure).includes("SECRET_SENTINEL"), false);
      return;
    }
    assert.equal(runtime.store.data.actors["fresh-actor"].startupFailure, undefined);
    const actor = runtime.actors.get("fresh-actor");
    assert.equal(actor.snapshot().observation, "available");
    await until("Native MCP actual catalog or failure", () => state.mcpReady || !!state.mcpError);
    assert.equal(state.mcpError, undefined);
    assert.equal(state.actorClosed, false);
    assert.equal(await actor.adapter?.bridgeReady("fresh-native"), true);
    assert.equal(state.calls.filter((m) => m === "thread/start").length, 1);
    assert.equal(state.calls.includes("thread/resume"), false);
    assert.equal(
      state.calls.some((m) =>
        ["thread/name/set", "thread/settings/update", "turn/start"].includes(m),
      ),
      false,
    );
    assert.equal(runtime.store.data.actors["fresh-actor"].submissions.length, 0);
    actorSocket.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "run",
        method: "tools/call",
        params: {
          name: "run",
          arguments: { text: "Mock first input" },
          _meta: { "agentorg/call": { id: "mock-call", from: "root", cause: null } },
        },
      }),
    );
    await until("Native owner notifications settle the actual Hub run", () => !!state.runReply);
    assert.equal(state.runReply.result.structuredContent.status, "completed");
    assert.equal(state.runReply.result.structuredContent.output, "MOCK_COMPLETE");
    assert.ok(state.causes.includes("mock-call"));
    assert.equal(state.calls.filter((m) => m === "turn/start").length, 1);
    assert.equal(runtime.store.data.actors["fresh-actor"].submissions[0].state, "done");
    assert.equal(JSON.stringify(actor.snapshot()).includes("SECRET_SENTINEL"), false);
  });
