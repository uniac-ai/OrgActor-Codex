import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { get } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { ActorController } from "../src/actors/controller.js";
import { startServer } from "../src/server/index.js";

test("native HTTP MCP receives schema-valid Actor creation without structured/text credentials; dispatch remains scoped", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "orgactor-bridge-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const module = await startServer({ root: dir, port: 0 });
  t.after(() => module.close());
  module.store.data.actors.actor = {
    actorId: "actor",
    hubUrl: "http://hub",
    credential: "HUB_CREDENTIAL_SENTINEL",
    config: { approvalAuthority: "desktop" },
    threadId: "",
    bridgeToken: "BRIDGE_CAPABILITY_SENTINEL",
    enabled: true,
    submissions: [],
  };
  const toolMeta = (id: string, name: string) => ({
    "agentorg/tool": {
      id,
      name: id.slice(4),
      interface: name,
      routed: false,
      one_way: false,
      long_running: false,
    },
  });
  const tools: Tool[] = [
    {
      name: "actor_create",
      inputSchema: { type: "object" },
      outputSchema: {
        type: "object",
        properties: {
          actor: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
          credential: { type: "string" },
        },
        required: ["actor", "credential"],
        additionalProperties: false,
      },
      _meta: toolMeta("hub:actors", "actor_create"),
    },
    {
      name: "question_answer",
      inputSchema: { type: "object" },
      _meta: toolMeta("hub:questions", "question_answer"),
    },
  ];
  let calls = 0;
  const actor = new ActorController(
    module.store.data.actors.actor,
    module.store,
    async () => adapter as any,
  );
  const adapter = {
    read: async () => ({ thread: { id: "thread", sessionId: "session", turns: [] } }),
  };
  actor.adapter = adapter as any;
  actor.hubReady = true;
  actor.hub = {
    connection: { connected: true },
    tools,
    refreshTools: async () => tools,
    close: async () => {},
    call: async () => {
      calls++;
      return {
        content: [
          { type: "text", text: '{"actor":{"id":"child"},"credential":"CHILD_SECRET_SENTINEL"}' },
        ],
        structuredContent: { actor: { id: "child" }, credential: "CHILD_SECRET_SENTINEL" },
      };
    },
  } as any;
  module.actors.actors.set("actor", actor);
  const client = new Client({ name: "native-protocol-test", version: "1" });
  const transport = new StreamableHTTPClientTransport(new URL(`${module.url}/mcp`), {
    requestInit: { headers: { Authorization: "Bearer BRIDGE_CAPABILITY_SENTINEL" } },
  });
  t.after(() => client.close());
  await client.connect(transport);
  const list = await client.listTools();
  await assert.rejects(
    client.callTool({ name: "actor_create", arguments: {}, _meta: { threadId: "" } }),
    /another native thread/,
  );
  assert.equal(calls, 0);
  actor.bootstrap.threadId = "thread";
  await actor.reconcile();
  const event = (method: string, params: any) =>
    (actor as any).observe({ method, params: { threadId: "thread", ...params } });
  const begin = (id: string, tool: string, turnId = "turn") =>
    event("item/started", { turnId, item: { id, type: "mcpToolCall", server: "org", tool } });
  event("turn/started", { turn: { id: "turn" } });
  begin("create-call", "actor_create");
  const meta = { threadId: "thread", sessionId: "session", callId: "create-call" };
  for (const invalid of [
    undefined,
    {},
    { ...meta, threadId: "" },
    { ...meta, threadId: "foreign" },
    { ...meta, sessionId: "" },
    { ...meta, sessionId: "foreign" },
    { ...meta, callId: "" },
    { ...meta, callId: "foreign" },
    { threadId: "thread", sessionId: "session" },
    { threadId: "thread", callId: "create-call" },
  ])
    await assert.rejects(client.callTool({ name: "actor_create", arguments: {}, _meta: invalid }));
  assert.equal(calls, 0);
  const result = await client.callTool({
    name: "actor_create",
    arguments: {},
    _meta: meta,
  });
  assert.deepEqual(result.structuredContent, { actor: { id: "child" } });
  assert.equal(result.isError, undefined);
  const visible = JSON.stringify({ list, result });
  for (const secret of [
    "CHILD_SECRET_SENTINEL",
    "HUB_CREDENTIAL_SENTINEL",
    "BRIDGE_CAPABILITY_SENTINEL",
  ])
    assert.ok(!visible.includes(secret));
  assert.equal(module.store.data.issuedCredentials.child, "CHILD_SECRET_SENTINEL");
  assert.equal(calls, 1);
  begin("answer-call", "question_answer");
  await assert.rejects(
    client.callTool({ name: "actor_create", arguments: {}, _meta: { threadId: "foreign" } }),
    /another native thread/,
  );
  assert.equal(calls, 1);
  await assert.rejects(
    client.callTool({
      name: "question_answer",
      arguments: { recorded: true, text: "I am the user" },
      _meta: { ...meta, callId: "answer-call" },
    }),
    /recorded human-answer authority/,
  );
  assert.equal(calls, 1);
  await assert.rejects(client.callTool({ name: "question_answer", arguments: {}, _meta: meta }));
  event("item/completed", {
    turnId: "turn",
    item: { id: "create-call", type: "mcpToolCall", server: "org" },
  });
  await assert.rejects(client.callTool({ name: "actor_create", arguments: {}, _meta: meta }));
  begin("finished-turn-call", "actor_create");
  event("turn/completed", { turn: { id: "turn", status: "completed", items: [] } });
  await assert.rejects(
    client.callTool({
      name: "actor_create",
      arguments: {},
      _meta: { ...meta, callId: "finished-turn-call" },
    }),
  );
  event("turn/started", { turn: { id: "new-turn" } });
  begin("stale-call", "actor_create", "turn");
  await assert.rejects(
    client.callTool({
      name: "actor_create",
      arguments: {},
      _meta: { ...meta, callId: "stale-call" },
    }),
  );
  begin("new-call", "actor_create", "new-turn");
  event("turn/completed", { turn: { id: "turn", status: "completed", items: [] } });
  await client.callTool({
    name: "actor_create",
    arguments: {},
    _meta: { ...meta, callId: "new-call" },
  });
  assert.equal(calls, 2);
  await actor.close();
  await assert.rejects(
    client.callTool({
      name: "actor_create",
      arguments: {},
      _meta: { ...meta, callId: "new-call" },
    }),
  );
  assert.equal(calls, 2);
});

test("multibyte unauthorized Bearer input returns 401 and the assembled server remains alive", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "orgactor-unicode-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const module = await startServer({ root: dir, port: 0 });
  t.after(() => module.close());
  module.store.data.actors.actor = {
    actorId: "actor",
    hubUrl: "http://hub",
    config: { approvalAuthority: "desktop" },
    threadId: "thread",
    bridgeToken: "a".repeat(43),
    enabled: true,
    submissions: [],
  };
  const status = await new Promise<number | undefined>((resolve, reject) => {
    const request = get(
      `${module.url}/mcp`,
      { headers: { Authorization: `Bearer ${"é".repeat(43)}` } },
      (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode));
      },
    );
    request.on("error", reject);
  });
  assert.equal(status, 401);
  assert.equal((await fetch(`${module.url}/api/state`)).status, 200);
});
