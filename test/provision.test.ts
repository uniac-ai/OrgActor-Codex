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
      one_way: false,
      long_running: false,
    },
  },
});
const tools = [
  tool("hub:team", "team", "team_alias"),
  tool("hub:messages", "messages", "inbox_alias"),
  tool("hub:messages", "message_read", "read_alias"),
];
async function until(description: string, read: () => boolean) {
  for (let i = 0; i < 500; i++) {
    if (read()) return;
    await setTimeout(10);
  }
  assert.fail(description);
}

for (const mode of ["fresh", "unknown", "offline", "rejected", "lost"])
  test(`production provisioning ${mode === "unknown" ? "refuses initial reuse with an uncertain accepted input" : mode === "offline" ? "completes native creation while Actor admission is held" : mode === "rejected" || mode === "lost" ? `retires its prepared peer and capability after ${mode} native creation` : "prepares the Hub bridge before native creation and keeps its owners through first use"}`, {
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
      inboxDeliveries: 0,
      inboxReads: 0,
      hubMethods: [] as string[],
      actorAdmissions: 0,
      causes: [] as (string | undefined)[],
    };
    let providerSocket!: WebSocket;
    let actorSocket!: WebSocket;
    let creatingSocket!: WebSocket;
    let preparedActor!: ActorController;
    let preparedHub: ActorController["hub"];
    let startReplied = false;
    let deliverInbox: (() => void) | undefined;
    const mcp = new Client({ name: "mock-native", version: "1" });
    const metadata = () => ({
      id: "fresh-native",
      sessionId: "fresh-session",
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
        if (socket === actorSocket && m.method) state.hubMethods.push(m.method);
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
        } else if (m.method === "initialize") {
          assert.deepEqual(m.params.capabilities, {});
          respond({
            protocolVersion: m.params.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: "mock-hub", version: "1" },
          });
        } else if (m.method === "tools/list") respond({ tools });
        else if (m.method === "tools/call" && m.params.name === "team_alias") {
          state.causes.push(m.params._meta?.["agentorg/cause"]);
          const value = { root: "root", positions: [{ id: "fresh-actor", manager: "root" }] };
          respond({
            content: [{ type: "text", text: JSON.stringify(value) }],
            structuredContent: value,
          });
        } else if (m.method === "tools/call" && m.params.name === "inbox_alias") {
          assert.deepEqual(m.params.arguments, { unread: true, limit: 200, wait: 20 });
          const deliver = () => {
            state.inboxDeliveries++;
            respond({
              content: [],
              structuredContent: {
                messages: [{ id: "inbox-message", text: "Mock first input", from: "root" }],
                cursor: 1,
              },
            });
          };
          if (!state.inboxDeliveries) deliverInbox = deliver;
          else if (state.inboxDeliveries === 1) deliver();
        } else if (m.method === "tools/call" && m.params.name === "read_alias") {
          assert.deepEqual(m.params.arguments, { ids: ["inbox-message"] });
          state.inboxReads++;
          respond({ content: [], structuredContent: {} });
        } else if (m.id === "create") state.providerReply = m;
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
              assert.equal(list.tools.length, 3);
              assert.equal(startReplied, false);
              assert.equal(preparedActor.hubReady, true);
              assert.equal(preparedActor.bootstrap.threadId, "");
              assert.equal(runtime.actors.get("fresh-actor"), preparedActor);
              assert.equal(preparedActor.hub, preparedHub);
              await assert.rejects(
                mcp.callTool({ name: "team_alias", arguments: {}, _meta: { threadId: "" } }),
                /another native thread/,
              );
              assert.deepEqual(state.causes, []);
              const early = await fetch(`${runtime.url}/api/actors/fresh-actor/inputs`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ inputId: "before-binding", text: "Before binding" }),
              });
              assert.equal(early.status, 503);
              assert.equal(((await early.json()) as any).error.code, "NATIVE_BINDING_PENDING");
              assert.equal(preparedActor.bootstrap.submissions.length, mode === "unknown" ? 1 : 0);
              state.mcpReady = true;
              if (mode === "rejected" || mode === "lost") {
                if (mode === "lost") {
                  actorSocket.close(1001);
                  await until(
                    "Prepared peer is disconnected with a retry pending",
                    () => !runtime.actors.actors.has("fresh-actor"),
                  );
                }
                if (mode === "rejected") error(-32602, "Creation refused SECRET_NATIVE_PAYLOAD");
                else socket.terminate();
                return;
              }
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
          assert.equal(m.params.clientUserMessageId, "message:inbox-message");
          assert.match(m.params.input[0].text, /Origin: Hub Actor root/);
          assert.equal(preparedActor.snapshot().observation, "available");
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
          socket.send(
            JSON.stringify({
              method: "item/started",
              params: {
                threadId: "fresh-native",
                turnId: "mock-turn",
                item: {
                  id: "native-tool-call",
                  type: "mcpToolCall",
                  server: "org",
                  tool: "team_alias",
                },
              },
            }),
          );
          void mcp
            .callTool({
              name: "team_alias",
              arguments: {},
              _meta: {
                threadId: "fresh-native",
                sessionId: "fresh-session",
                callId: "native-tool-call",
              },
            })
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
            })
            .catch((e) => {
              state.mcpError = e;
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
    if (mode === "rejected" || mode === "lost") {
      const outcome = mode === "rejected" ? "failed" : "unknown";
      const code = mode === "rejected" ? "PROVISIONING_FAILED" : "PROVISIONING_UNKNOWN";
      const bootstrap = runtime.store.data.actors["fresh-actor"];
      assert.equal(state.providerReply.error.data.code, code);
      assert.equal(Object.values(runtime.store.data.journal)[0].state, outcome);
      assert.equal(bootstrap.enabled, false);
      assert.equal(bootstrap.threadId, "");
      assert.equal(bootstrap.submissions.length, 0);
      assert.equal(runtime.actors.actors.has("fresh-actor"), false);
      await until("Failed creation peer is closed", () => state.actorClosed);
      const bridge = await fetch(`${runtime.url}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${bootstrap.bridgeToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
      });
      assert.equal(bridge.status, 401);
      assert.equal(JSON.stringify(state.providerReply).includes("SECRET_NATIVE_PAYLOAD"), false);
      state.providerReply = undefined;
      providerSocket.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: "create",
          method: "provider.createActor",
          params: { actorId: "fresh-actor", credential: "ACTOR_SECRET_SENTINEL", config: {} },
        }),
      );
      await until(
        "Identical factory retry preserves the accepted outcome",
        () => !!state.providerReply,
      );
      assert.equal(state.providerReply.error.data.code, code);
      await setTimeout(1700);
      assert.equal(state.actorAdmissions, 1);
      assert.equal(runtime.actors.actors.has("fresh-actor"), false);
      assert.equal(state.calls.filter((m) => m === "thread/start").length, 1);
      assert.equal(state.calls.includes("turn/start"), false);
      return;
    }
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
      const input = await fetch(`${runtime.url}/api/actors/fresh-actor/inputs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ inputId: "held-hub", text: "Too early" }),
      });
      assert.equal(input.status, 503);
      assert.equal(((await input.json()) as any).error.code, "NATIVE_BINDING_PENDING");
      assert.equal(preparedActor.bootstrap.submissions.length, 0);
      assert.equal(state.calls.includes("thread/resume"), false);
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
    await until("Actor reads its own Hub inbox", () => !!deliverInbox);
    deliverInbox?.();
    await until(
      "Locally chosen native turn settles and duplicate inbox delivery is acknowledged",
      () =>
        runtime.store.data.actors["fresh-actor"].submissions[0]?.state === "done" &&
        state.inboxReads === 2,
    );
    const input = runtime.store.data.actors["fresh-actor"].submissions[0];
    assert.equal(input.result?.status, "completed");
    assert.equal(input.result?.output, "MOCK_COMPLETE");
    assert.equal(input.from, "root");
    assert.equal(input.id, "message:inbox-message");
    assert.equal(state.calls.filter((m) => m === "turn/start").length, 1);
    assert.equal(runtime.store.data.actors["fresh-actor"].submissions.length, 1);
    assert.deepEqual(state.causes, [undefined]);
    await assert.rejects(
      mcp.callTool({
        name: "team_alias",
        arguments: {},
        _meta: { threadId: "fresh-native", sessionId: "fresh-session", callId: "native-tool-call" },
      }),
      /current native session and tool call/,
    );
    assert.deepEqual(state.causes, [undefined]);
    assert.ok(
      state.hubMethods.every((m) =>
        ["initialize", "notifications/initialized", "tools/list", "tools/call"].includes(m),
      ),
    );
    assert.equal(JSON.stringify(actor.snapshot()).includes("SECRET_SENTINEL"), false);
  });
