import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { get } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout } from "node:timers/promises";
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
    await assert.rejects(
      client.callTool({ name: "actor_create", arguments: {}, _meta: invalid }, undefined, {
        signal: AbortSignal.timeout(30),
      }),
    );
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
  await assert.rejects(
    client.callTool({ name: "actor_create", arguments: {}, _meta: { threadId: "foreign" } }),
    /another native thread/,
  );
  assert.equal(calls, 1);
  assert.equal(calls, 1);
  await assert.rejects(client.callTool({ name: "question_answer", arguments: {}, _meta: meta }));
  event("item/completed", {
    turnId: "turn",
    item: { id: "create-call", type: "mcpToolCall", server: "org", tool: "actor_create" },
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
    client.callTool(
      {
        name: "actor_create",
        arguments: {},
        _meta: { ...meta, callId: "stale-call" },
      },
      undefined,
      { signal: AbortSignal.timeout(30) },
    ),
  );
  begin("new-call", "actor_create", "new-turn");
  event("turn/completed", { turn: { id: "turn", status: "completed", items: [] } });
  await client.callTool({
    name: "actor_create",
    arguments: {},
    _meta: { ...meta, callId: "new-call" },
  });
  assert.equal(calls, 2);
  const wait = actor.waitForToolCall.bind(actor);
  actor.waitForToolCall = async (...args) => {
    const valid = await wait(...args);
    event("item/completed", {
      turnId: "new-turn",
      item: {
        id: "completed-before-dispatch",
        type: "mcpToolCall",
        server: "org",
        tool: "actor_create",
      },
    });
    return valid;
  };
  begin("completed-before-dispatch", "actor_create", "new-turn");
  await assert.rejects(
    client.callTool({
      name: "actor_create",
      arguments: {},
      _meta: { ...meta, callId: "completed-before-dispatch" },
    }),
  );
  assert.equal(calls, 2);
  actor.waitForToolCall = wait;
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

test("cancelled HTTP Tool request cannot dispatch when its native observation arrives later", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "orgactor-cancel-"));
  const module = await startServer({ root: dir, port: 0 });
  const bootstrap = {
    actorId: "actor",
    hubUrl: "http://unused.invalid",
    config: { approvalAuthority: "desktop" as const },
    threadId: "thread",
    bridgeToken: "OWNED_CANCEL_CAPABILITY",
    enabled: true,
    submissions: [],
  };
  module.store.data.actors.actor = bootstrap;
  const adapter = {
    read: async () => ({ thread: { id: "thread", sessionId: "session", turns: [] } }),
  };
  const actor = new ActorController(bootstrap, module.store, async () => adapter as any);
  actor.adapter = adapter as any;
  await actor.reconcile();
  let dispatches = 0;
  const tools = [
    {
      name: "team",
      inputSchema: { type: "object" },
      _meta: {
        "agentorg/tool": {
          id: "hub:team",
          name: "team",
          interface: "team",
          one_way: false,
          long_running: false,
        },
      },
    },
  ];
  actor.hubReady = true;
  actor.hub = {
    connection: { connected: true },
    tools,
    refreshTools: async () => tools,
    call: async () => {
      dispatches++;
      return { content: [], structuredContent: {} };
    },
    close: async () => {},
  } as any;
  module.actors.actors.set("actor", actor);
  const event = (method: string, params: any) =>
    (actor as any).observe({ method, params: { threadId: "thread", ...params } });
  event("turn/started", { turn: { id: "turn" } });
  let reached!: () => void;
  const pending = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const wait = actor.waitForToolCall.bind(actor);
  actor.waitForToolCall = (...args) => {
    const result = wait(...args);
    reached();
    return result;
  };
  const client = new Client({ name: "owned-cancellation-fixture", version: "1" });
  t.after(async () => {
    await client.close();
    await module.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const transport = new StreamableHTTPClientTransport(new URL(`${module.url}/mcp`), {
    requestInit: { headers: { Authorization: "Bearer OWNED_CANCEL_CAPABILITY" } },
  });
  await client.connect(transport);
  const cancel = new AbortController();
  const request = client.callTool(
    {
      name: "team",
      arguments: {},
      _meta: { threadId: "thread", sessionId: "session", callId: "cancelled-call" },
    },
    undefined,
    { signal: cancel.signal },
  );
  const cancelled = assert.rejects(request, /abort|cancel/i);
  await pending;
  assert.equal(actor.listenerCount("toolObserved"), 1);
  cancel.abort();
  await cancelled;
  for (let i = 0; i < 200 && actor.listenerCount("toolObserved"); i++) await setTimeout(10);
  event("item/started", {
    turnId: "turn",
    item: { id: "cancelled-call", type: "mcpToolCall", server: "org", tool: "team" },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    dispatches,
    0,
    "Client cancellation must prevent dispatch even after the exact native item arrives",
  );
  assert.equal(actor.listenerCount("toolObserved"), 0);
  assert.equal(actor.listenerCount("toolInvalidated"), 0);
  const sessionId = transport.sessionId;
  assert.ok(sessionId);
  module.store.data.actors.other = {
    ...bootstrap,
    actorId: "other",
    bridgeToken: "OTHER_OWNED_CAPABILITY",
  };
  const foreign = await fetch(`${module.url}/mcp`, {
    headers: { Authorization: "Bearer OTHER_OWNED_CAPABILITY", "mcp-session-id": sessionId },
  });
  assert.equal(foreign.status, 404);
  await actor.close();
  const replacement = new ActorController(bootstrap, module.store, async () => adapter as any);
  replacement.adapter = adapter as any;
  await replacement.reconcile();
  let replacementDispatches = 0;
  replacement.hubReady = true;
  replacement.hub = {
    connection: { connected: true },
    tools,
    refreshTools: async () => tools,
    call: async () => {
      replacementDispatches++;
      return { content: [], structuredContent: { replacement: true } };
    },
    close: async () => {},
  } as any;
  module.actors.actors.set("actor", replacement);
  (replacement as any).observe({
    method: "turn/started",
    params: { threadId: "thread", turn: { id: "replacement-turn" } },
  });
  (replacement as any).observe({
    method: "item/started",
    params: {
      threadId: "thread",
      turnId: "replacement-turn",
      item: { id: "replacement-call", type: "mcpToolCall", server: "org", tool: "team" },
    },
  });
  assert.equal((await client.listTools()).tools[0].name, "team");
  const result = await client.callTool({
    name: "team",
    arguments: {},
    _meta: { threadId: "thread", sessionId: "session", callId: "replacement-call" },
  });
  assert.deepEqual(result.structuredContent, { replacement: true });
  assert.equal(replacementDispatches, 1);
  assert.equal(transport.sessionId, sessionId);
  let endingReached!: () => void;
  const ending = new Promise<void>((resolve) => {
    endingReached = resolve;
  });
  const replacementWait = replacement.waitForToolCall.bind(replacement);
  replacement.waitForToolCall = (...args) => {
    const result = replacementWait(...args);
    endingReached();
    return result;
  };
  const inFlight = client
    .callTool({
      name: "team",
      arguments: {},
      _meta: { threadId: "thread", sessionId: "session", callId: "terminated-call" },
    })
    .catch((error) => error.message);
  await ending;
  await transport.terminateSession();
  await client.close();
  assert.equal(typeof (await inFlight), "string");
  (replacement as any).observe({
    method: "item/started",
    params: {
      threadId: "thread",
      turnId: "replacement-turn",
      item: { id: "terminated-call", type: "mcpToolCall", server: "org", tool: "team" },
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(replacementDispatches, 1);
  const ended = await fetch(`${module.url}/mcp`, {
    headers: { Authorization: "Bearer OWNED_CANCEL_CAPABILITY", "mcp-session-id": sessionId },
  });
  assert.equal(ended.status, 404);
  assert.equal(dispatches, 0);
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

test("the native session is offered its chosen level's Hub interfaces and the report guidance", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "orgactor-level-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const module = await startServer({ root: dir, port: 0 });
  t.after(() => module.close());
  const bootstrap = {
    actorId: "actor",
    hubUrl: "http://unused.invalid",
    config: { approvalAuthority: "desktop" as const, level: "report" as const },
    threadId: "thread",
    bridgeToken: "OWNED_LEVEL_CAPABILITY",
    enabled: true,
    submissions: [],
  };
  module.store.data.actors.actor = bootstrap;
  const adapter = {
    read: async () => ({ thread: { id: "thread", sessionId: "session", turns: [] } }),
  };
  const actor = new ActorController(bootstrap, module.store, async () => adapter as any);
  actor.adapter = adapter as any;
  await actor.reconcile();
  const tool = (id: string, name: string, level?: string): Tool => ({
    name,
    inputSchema: { type: "object" },
    _meta: {
      "agentorg/tool": {
        id,
        name: id.slice(4),
        interface: name,
        one_way: false,
        long_running: false,
        ...(level ? { level } : {}),
      },
    },
  });
  const tools = [
    tool("hub:status", "status_set", "report"),
    tool("hub:messages", "message_send", "team"),
    tool("hub:actors", "actor_close", "organization"),
    tool("hub:legacy", "untagged"),
  ];
  let dispatches = 0;
  actor.hubReady = true;
  actor.hub = {
    connection: { connected: true },
    tools,
    refreshTools: async () => tools,
    close: async () => {},
    call: async () => {
      dispatches++;
      return { content: [] };
    },
  } as any;
  module.actors.actors.set("actor", actor);
  const client = new Client({ name: "native-level-test", version: "1" });
  t.after(() => client.close());
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${module.url}/mcp`), {
      requestInit: { headers: { Authorization: "Bearer OWNED_LEVEL_CAPABILITY" } },
    }),
  );
  assert.match(client.getInstructions() ?? "", /You fill AgentOrg Actor actor\./);
  assert.match(client.getInstructions() ?? "", /One Work per workstream: work_create/);
  assert.match(client.getInstructions() ?? "", /recommended value/);
  assert.deepEqual(
    (await client.listTools()).tools.map((t) => t.name),
    ["status_set"],
  );
  await assert.rejects(
    client.callTool({ name: "message_send", arguments: {}, _meta: { threadId: "thread" } }),
    /no such interface/,
  );
  bootstrap.config = { approvalAuthority: "desktop", level: "team" } as any;
  assert.deepEqual(
    (await client.listTools()).tools.map((t) => t.name),
    ["status_set", "message_send"],
  );
  delete (bootstrap.config as { level?: string }).level;
  assert.equal((await client.listTools()).tools.length, 4);
  assert.equal(dispatches, 0);
});
