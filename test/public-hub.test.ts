import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout } from "node:timers/promises";
import { connectClient } from "@agentorg/cli/actor";
import { BUILTINS } from "@agentorg/cli/contract";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { WebSocketServer } from "ws";
import { startPublicHub } from "../scripts/hub.js";
import { startServer } from "../src/server/index.js";

async function until(read: () => boolean) {
  for (let i = 0; i < 500; i++) {
    if (read()) return;
    await setTimeout(10);
  }
  assert.fail("The owned public protocol fixture did not settle");
}

for (const delayed of ["item", "turn-and-item"])
  test(`packaged public Hub and Provider complete inbox work when native ${delayed} observation arrives after HTTP`, {
    timeout: 20_000,
  }, async (t) => {
    const owned = mkdtempSync(join(tmpdir(), "orgactor-public-hub-"));
    const hub = await startPublicHub(
      join(owned, "hub"),
      "fixture-provider",
      "OWNED_PROVIDER_CREDENTIAL",
    );
    const native = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(native, "listening");
    const mcp = new Client({ name: "owned-native-fixture", version: "1" });
    const state = {
      discovery: false,
      nativeStarts: 0,
      guardReached: false,
      responseReleased: false,
      failure: undefined as unknown,
      teamDescription: undefined as string | undefined,
    };
    const metadata = () => ({
      id: "native-thread",
      sessionId: "native-session",
      historyMode: "legacy",
      status: { type: "idle" },
      preview: "",
      name: null,
      cwd: "/owned",
      modelProvider: "openai",
      turns: [],
    });
    native.on("connection", (socket) =>
      socket.on("message", (raw) => {
        const m = JSON.parse(String(raw));
        if (m.id === undefined) return;
        const reply = (result: any) => socket.send(JSON.stringify({ id: m.id, result }));
        const event = (method: string, params: any) =>
          socket.send(JSON.stringify({ method, params: { threadId: "native-thread", ...params } }));
        if (m.method === "initialize") reply({});
        else if (m.method === "thread/start") {
          void (async () => {
            const actor = Object.values(runtime.store.data.actors)[0];
            assert.equal(actor.threadId, "");
            const config = m.params.config["mcp_servers.org"];
            await mcp.connect(
              new StreamableHTTPClientTransport(new URL(config.url), {
                requestInit: { headers: config.http_headers },
              }),
            );
            const list = await mcp.listTools();
            assert.equal(list.tools.length, 15);
            assert.equal(
              list.tools.find((tool) => tool.name === "team")?.description,
              state.teamDescription,
            );
            for (const tool of list.tools)
              assert.deepEqual(
                Object.keys(tool._meta?.["agentorg/tool"] as object).sort(),
                ["id", "name", "interface", "one_way", "long_running"].sort(),
              );
            assert.equal(actor.threadId, "");
            await assert.rejects(
              mcp.callTool({ name: "team", arguments: {}, _meta: { threadId: "" } }),
            );
            state.discovery = true;
            reply({ thread: metadata() });
          })().catch((error) => {
            state.failure = error;
            socket.send(
              JSON.stringify({
                id: m.id,
                error: { code: -32602, message: "Owned fixture failed" },
              }),
            );
          });
        } else if (m.method === "thread/read") reply({ thread: metadata() });
        else if (m.method === "account/read") reply({ account: { type: "chatgpt" } });
        else if (m.method === "account/rateLimits/read") reply({ ordinaryUsageAllowed: true });
        else if (m.method === "mcpServerStatus/list")
          reply({ data: [{ name: "org", tools: { team: {} } }] });
        else if (m.method === "turn/start") {
          state.nativeStarts++;
          void (async () => {
            const actor = [...runtime.actors.actors.values()][0];
            const wait = actor.waitForToolCall.bind(actor);
            actor.waitForToolCall = (...args) => {
              const pending = wait(...args);
              state.guardReached = true;
              return pending;
            };
            const started = () => event("turn/started", { turn: { id: "native-turn" } });
            if (delayed === "item") started();
            let settled = false;
            const call = mcp
              .callTool({
                name: "team",
                arguments: { depth: 0 },
                _meta: {
                  threadId: "native-thread",
                  sessionId: "native-session",
                  callId: "native-call",
                },
              })
              .finally(() => {
                settled = true;
              });
            await until(() => state.guardReached);
            assert.equal(settled, false);
            assert.equal(runtime.bridge.requests, 0);
            assert.equal(state.responseReleased, false);
            if (delayed === "turn-and-item") started();
            event("item/started", {
              turnId: "native-turn",
              item: { id: "native-call", type: "mcpToolCall", server: "org", tool: "team" },
            });
            const result = await call;
            assert.equal(result.isError, undefined);
            const team = BUILTINS.team.response.parse(result.structuredContent);
            assert.equal(team.positions[0].id, actor.bootstrap.actorId);
            assert.equal(state.responseReleased, false);
            reply({ turn: { id: "native-turn" } });
            state.responseReleased = true;
            event("item/completed", {
              turnId: "native-turn",
              item: { type: "userMessage", clientId: m.params.clientUserMessageId },
            });
            event("item/completed", {
              turnId: "native-turn",
              item: { id: "native-call", type: "mcpToolCall", server: "org", tool: "team" },
            });
            event("turn/completed", {
              turn: {
                id: "native-turn",
                status: "completed",
                items: [
                  { type: "userMessage", clientId: m.params.clientUserMessageId },
                  { type: "agentMessage", text: "OWNED_FIXTURE_COMPLETE" },
                ],
              },
            });
          })().catch((error) => {
            state.failure = error;
          });
        } else {
          state.failure = new Error(`Unexpected owned native operation: ${m.method}`);
          reply({});
        }
      }),
    );
    const runtime = await startServer({
      root: join(owned, "provider"),
      port: 0,
      hub: {
        url: hub.url,
        providerId: "fixture-provider",
        credential: "OWNED_PROVIDER_CREDENTIAL",
      },
    });
    const root = await connectClient({
      url: hub.url,
      actorId: hub.rootId,
      credential: hub.rootCredential,
    });
    t.after(async () => {
      await mcp.close();
      await root.close();
      await runtime.close();
      for (const socket of native.clients) socket.terminate();
      await new Promise<void>((resolve) => native.close(() => resolve()));
      await hub.close();
      rmSync(owned, { recursive: true, force: true });
    });
    await runtime.provider.setEnabled(false);
    runtime.setup.configure({
      backend: {
        kind: "app-server",
        endpoint: `ws://127.0.0.1:${(native.address() as { port: number }).port}`,
      },
      workspaceRoot: "/owned",
      bridgeUrl: `${runtime.url}/mcp`,
    });
    await runtime.provider.setEnabled(true);
    await until(() => runtime.provider.snapshot().connected);
    const publicTools = await root.available();
    assert.equal(publicTools.length, 7);
    state.teamDescription = publicTools
      .find((tool) => tool.id === "hub:team")
      ?.interfaces.find((offer) => offer.interface.name === "team")?.interface.description;
    assert.ok(state.teamDescription);
    const created = await root.call("actor_create", {
      name: "owned-provider-proof",
      purpose: "Model-free public protocol fixture",
      execution: { providerId: "fixture-provider", config: {} },
    });
    assert.equal(state.failure, undefined);
    assert.equal(created.state, "done");
    assert.ok(created.state === "done");
    const value = BUILTINS.actor_create.response.parse(created.value);
    assert.equal(value.execution?.status, "ready");
    assert.equal("interfaces" in value.actor, false);
    assert.equal("created_at_attach" in value.actor, false);
    assert.equal(state.discovery, true);
    const actor = runtime.actors.get(value.actor.id);
    await until(() => actor.snapshot().observation === "available");
    for (const name of ["owned-provider-proof.run", `${value.actor.id}.status`, "call_withdraw"]) {
      const refused = await root.call(name, {});
      assert.equal(refused.state, "refused");
      assert.deepEqual(Object.keys(refused).sort(), ["state", "code", "message"].sort());
    }
    assert.equal(state.nativeStarts, 0);
    assert.equal((await root.available()).flatMap((tool) => tool.interfaces).length, 15);
    const message = await root.call("message_send", {
      to: value.actor.id,
      text: "Owned inbox decision",
    });
    assert.ok(message.state === "done");
    const sent = BUILTINS.message_send.response.parse(message.value);
    await until(() => !!state.failure || actor.bootstrap.submissions[0]?.state === "done");
    assert.equal(state.failure, undefined);
    const input = actor.bootstrap.submissions[0];
    assert.equal(input.id, `message:${sent.id}`);
    assert.equal(input.from, hub.rootId);
    assert.equal(input.cause, null);
    assert.equal(input.result?.output, "OWNED_FIXTURE_COMPLETE");
    assert.equal(actor.enqueue(input.id, input.text, input.from), input);
    assert.equal(actor.bootstrap.submissions.length, 1);
    assert.equal(state.nativeStarts, 1);
    assert.equal(runtime.bridge.requests, 1);
    await assert.rejects(
      mcp.callTool({
        name: "team",
        arguments: {},
        _meta: { threadId: "native-thread", sessionId: "native-session", callId: "native-call" },
      }),
    );
    assert.equal(runtime.bridge.requests, 1);
  });
