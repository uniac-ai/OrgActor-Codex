import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ActorController } from "../src/actors/controller.js";
import { responseFor } from "../src/actors/requests.js";
import { AppServerAdapter } from "../src/codex/index.js";
import { Fault } from "../src/management/schema.js";
import { type Bootstrap, RuntimeStore } from "../src/runtime/index.js";
import { SetupService } from "../src/setup/index.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function fixture(t: any) {
  const dir = mkdtempSync(join(tmpdir(), "orgactor-control-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new RuntimeStore(dir);
  const bootstrap: Bootstrap = {
    actorId: "actor",
    hubUrl: "http://localhost",
    threadId: "owned",
    bridgeToken: "CAPABILITY_SENTINEL",
    config: { approvalAuthority: "desktop" },
    enabled: true,
    submissions: [],
  };
  store.data.actors.actor = bootstrap;
  const actor = new ActorController(bootstrap, store, async () => adapter as any);
  const starts: any[] = [];
  const interrupts: string[] = [];
  let history: any[] = [];
  const adapter = {
    bridgeReady: async () => true,
    start: async (...args: any[]) => {
      starts.push(args);
      return "turn-owned";
    },
    steer: async () => "turn-owned",
    interrupt: async (_: string, turn: string) => {
      interrupts.push(turn);
    },
    read: async () => ({ thread: { id: "owned", sessionId: "native-session", turns: history } }),
    answer() {},
    reject() {},
  };
  actor.adapter = adapter as any;
  actor.hub = {
    connection: { connected: true },
    alias: (_: string, name: string) => name,
    call: async () => ({
      structuredContent: { root: "root", positions: [{ id: "actor", manager: "manager" }] },
    }),
    close: async () => {},
  } as any;
  const event = (method: string, params: any, id?: string) =>
    (actor as any).observe({
      method,
      params: { threadId: "owned", ...params },
      ...(id ? { id } : {}),
    });
  return {
    actor,
    bootstrap,
    store,
    adapter,
    starts,
    interrupts,
    event,
    history: (turns: any[]) => {
      history = turns;
    },
  };
}
test("native history restores active Tool identity without replaying item events", async (t) => {
  const f = fixture(t);
  f.history([
    {
      id: "active",
      status: "inProgress",
      items: [
        {
          id: "active-call",
          type: "mcpToolCall",
          server: "org",
          tool: "team",
          status: "inProgress",
        },
        {
          id: "completed-call",
          type: "mcpToolCall",
          server: "org",
          tool: "team",
          status: "completed",
        },
        {
          id: "foreign-server",
          type: "mcpToolCall",
          server: "other",
          tool: "team",
          status: "inProgress",
        },
      ],
    },
  ]);
  await f.actor.reconcile();
  const meta = { threadId: "owned", sessionId: "native-session", callId: "active-call" };
  assert.equal(await f.actor.waitForToolCall(meta, "team", new AbortController().signal), true);
  assert.equal(f.actor.matchesToolCall({ ...meta, callId: "completed-call" }, "team"), false);
  assert.equal(f.actor.matchesToolCall({ ...meta, callId: "foreign-server" }, "team"), false);
  assert.equal(f.actor.matchesToolCall(meta, "other-alias"), false);
  f.event("item/completed", {
    turnId: "active",
    item: { id: "active-call", type: "mcpToolCall", server: "org", tool: "team" },
  });
  await f.actor.reconcile();
  assert.equal(f.actor.matchesToolCall(meta, "team"), false);
});
test("late history cannot overwrite newer turn events, item completion, scope or reconciliation", async (t) => {
  const f = fixture(t);
  const old = deferred<any>();
  f.adapter.read = async () => old.promise;
  const reading = f.actor.reconcile();
  f.event("turn/started", { turn: { id: "new-turn" } });
  f.event("item/started", {
    turnId: "new-turn",
    item: { id: "new-call", type: "mcpToolCall", server: "org", tool: "team" },
  });
  const meta = { threadId: "owned", sessionId: "native-session", callId: "new-call" };
  const pending = f.actor.waitForToolCall(meta, "team", new AbortController().signal);
  old.resolve({
    thread: {
      id: "owned",
      sessionId: "native-session",
      turns: [
        {
          id: "old-turn",
          status: "inProgress",
          items: [
            {
              id: "old-call",
              type: "mcpToolCall",
              server: "org",
              tool: "team",
              status: "inProgress",
            },
          ],
        },
      ],
    },
  });
  await reading;
  assert.equal(f.actor.turnId, "new-turn");
  assert.equal(await pending, true);
  assert.equal(f.actor.matchesToolCall({ ...meta, callId: "old-call" }, "team"), false);

  const staleItem = deferred<any>();
  f.adapter.read = async () => staleItem.promise;
  const itemRead = f.actor.reconcile();
  f.event("item/completed", {
    turnId: "new-turn",
    item: { id: "new-call", type: "mcpToolCall", server: "org", tool: "team" },
  });
  staleItem.resolve({
    thread: {
      id: "owned",
      sessionId: "native-session",
      turns: [
        {
          id: "new-turn",
          status: "inProgress",
          items: [
            {
              id: "new-call",
              type: "mcpToolCall",
              server: "org",
              tool: "team",
              status: "inProgress",
            },
          ],
        },
      ],
    },
  });
  await itemRead;
  assert.equal(f.actor.matchesToolCall(meta, "team"), false);

  const oldest = deferred<any>();
  const newest = deferred<any>();
  let reads = 0;
  f.adapter.read = async () => (++reads === 1 ? oldest.promise : newest.promise);
  const olderRead = f.actor.reconcile();
  const newerRead = f.actor.reconcile();
  newest.resolve({
    thread: {
      id: "owned",
      sessionId: "new-session",
      turns: [
        {
          id: "latest-turn",
          status: "inProgress",
          items: [
            {
              id: "latest-call",
              type: "mcpToolCall",
              server: "org",
              tool: "team",
              status: "inProgress",
            },
          ],
        },
      ],
    },
  });
  await newerRead;
  oldest.resolve({ thread: { id: "owned", sessionId: "old-session", turns: [] } });
  await olderRead;
  assert.equal(f.actor.turnId, "latest-turn");
  const latestMeta = { threadId: "owned", sessionId: "new-session", callId: "latest-call" };
  assert.equal(f.actor.matchesToolCall(latestMeta, "team"), true);

  const disconnected = deferred<any>();
  f.adapter.read = async () => disconnected.promise;
  const disconnectedRead = f.actor.reconcile();
  f.event("connection/closed", {});
  disconnected.resolve({
    thread: {
      id: "owned",
      sessionId: "new-session",
      turns: [
        {
          id: "latest-turn",
          status: "inProgress",
          items: [
            {
              id: "latest-call",
              type: "mcpToolCall",
              server: "org",
              tool: "team",
              status: "inProgress",
            },
          ],
        },
      ],
    },
  });
  await disconnectedRead;
  assert.equal(f.actor.matchesToolCall(latestMeta, "team"), false);
  const foreign = fixture(t);
  foreign.adapter.read = async () => ({
    thread: { id: "foreign", sessionId: "native-session", turns: [] },
  });
  await assert.rejects(
    foreign.actor.reconcile(),
    (error: any) => error.code === "NATIVE_HISTORY_MISMATCH",
  );
  assert.equal(foreign.actor.turnId, null);
});
test("terminal native history dominates delayed turn and item start notifications", async (t) => {
  for (const terminal of ["turn", "item"]) {
    const f = fixture(t);
    const history = deferred<any>();
    f.adapter.read = async () => history.promise;
    const reading = f.actor.reconcile();
    const start = () => {
      f.event("turn/started", { turn: { id: "terminal-turn" } });
      f.event("item/started", {
        turnId: "terminal-turn",
        item: { id: "terminal-call", type: "mcpToolCall", server: "org", tool: "team" },
      });
    };
    start();
    const meta = { threadId: "owned", sessionId: "native-session", callId: "terminal-call" };
    const waiting = f.actor.waitForToolCall(meta, "team", new AbortController().signal);
    history.resolve({
      thread: {
        id: "owned",
        sessionId: "native-session",
        turns: [
          {
            id: "terminal-turn",
            status: terminal === "turn" ? "completed" : "inProgress",
            items: [
              {
                id: "terminal-call",
                type: "mcpToolCall",
                server: "org",
                tool: "team",
                status: "completed",
              },
            ],
          },
        ],
      },
    });
    await reading;
    assert.equal(await waiting, false);
    assert.equal(f.actor.matchesToolCall(meta, "team"), false);
    start();
    assert.equal(f.actor.turnId, terminal === "turn" ? null : "terminal-turn");
    assert.equal(f.actor.matchesToolCall(meta, "team"), false);
  }
});
test("native observation waits expire or cancel without retaining authority or listeners", async (t) => {
  const meta = { threadId: "owned", sessionId: "native-session", callId: "not-yet-observed" };
  for (const end of ["abort", "disconnect", "reconcile", "close"]) {
    const f = fixture(t);
    await f.actor.reconcile();
    const request = new AbortController();
    let settled = false;
    const pending = f.actor.waitForToolCall(meta, "team", request.signal).finally(() => {
      settled = true;
    });
    await Promise.resolve();
    assert.equal(settled, false);
    assert.equal(f.actor.listenerCount("toolObserved"), 1);
    if (end === "abort") request.abort();
    if (end === "disconnect") f.event("connection/closed", {});
    if (end === "reconcile") await f.actor.reconcile();
    if (end === "close") await f.actor.close();
    assert.equal(await pending, false);
    assert.equal(f.actor.listenerCount("toolObserved"), 0);
    assert.equal(f.actor.listenerCount("toolInvalidated"), 0);
  }
  const f = fixture(t);
  await f.actor.reconcile();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = f.actor.waitForToolCall(meta, "team", new AbortController().signal);
  t.mock.timers.tick(20_000);
  assert.equal(await pending, false);
  assert.equal(f.actor.listenerCount("toolObserved"), 0);
  assert.equal(f.actor.listenerCount("toolInvalidated"), 0);
});
test("recovery uses native clientId, never caller text or foreign completion", async (t) => {
  const f = fixture(t);
  f.actor.adapter = undefined;
  const input = f.actor.enqueue("known", "payload", "manager");
  input.state = "unknown";
  f.actor.adapter = f.adapter as any;
  f.history([
    {
      id: "foreign",
      status: "completed",
      items: [{ type: "userMessage", clientId: "other", content: [{ text: "[input known]" }] }],
    },
  ]);
  await f.actor.reconcile();
  assert.equal(input.state, "unknown");
  assert.equal(input.result, undefined);
  f.history([
    {
      id: "owned-turn",
      status: "completed",
      items: [
        { type: "userMessage", clientId: "known" },
        { type: "agentMessage", text: "actual" },
      ],
    },
  ]);
  await f.actor.reconcile();
  assert.equal(f.bootstrap.submissions[0].result?.turnId, "owned-turn");
  assert.equal(f.bootstrap.submissions[0].result?.output, "actual");
  f.event("turn/completed", {
    turn: { id: "foreign", status: "completed", items: [{ type: "agentMessage", text: "wrong" }] },
  });
  assert.equal(f.bootstrap.submissions[0].result?.output, "actual");
});
test("local steering retains sender and native input provenance", async (t) => {
  const f = fixture(t);
  f.actor.adapter = undefined;
  const run = f.actor.enqueue("run", "first", "manager");
  run.state = "running";
  run.turnId = "turn-owned";
  f.actor.adapter = f.adapter as any;
  f.event("turn/started", { turn: { id: "turn-owned" } });
  f.event("item/completed", {
    turnId: "turn-owned",
    item: { type: "userMessage", clientId: "run" },
  });
  assert.equal(run.from, "manager");
  await f.actor.steer("call-steer", "turn-owned", "second", "manager");
  assert.equal(f.bootstrap.submissions[1].from, "manager");
  f.event("item/completed", {
    turnId: "turn-owned",
    item: { type: "userMessage", clientId: "call-steer" },
  });
  f.event("turn/completed", { turn: { id: "turn-owned", status: "completed", items: [] } });
  assert.equal(f.bootstrap.submissions[1].result?.status, "completed");
  assert.equal(
    (await f.actor.steer("call-steer", "turn-owned", "second", "manager")).status,
    "accepted",
  );
});
test("refused steering stays failed after the original turn completes and retries retain the error", async (t) => {
  for (const code of ["EXECUTION_NOT_ADMITTED", "NATIVE_REJECTED", "BACKEND_UNREACHABLE"]) {
    const f = fixture(t);
    let nativeSteers = 0;
    if (code === "EXECUTION_NOT_ADMITTED") {
      const native = new AppServerAdapter({
        request: async (method: string) => {
          if (method === "account/read") return { account: { type: "apiKey" } };
          if (method === "turn/steer") nativeSteers++;
          throw new Error("Unexpected native call");
        },
      } as any);
      const setup = new SetupService(f.store, { get: async () => native } as any);
      f.actor.adapter = await setup.executionAdapter();
    } else {
      f.adapter.steer = async () => {
        nativeSteers++;
        throw new Fault(code, "Refused", 422);
      };
    }
    f.event("turn/started", { turn: { id: "original" } });
    const retry = (actor = f.actor) =>
      assert.rejects(
        actor.steer("denied", "original", "second"),
        (error: any) => error.code === code && error.status === 422,
      );
    await retry();
    await retry();
    const denied = f.bootstrap.submissions[0];
    assert.equal(denied.state, "done");
    assert.equal(denied.result?.status, "failed");
    f.event("turn/completed", {
      turn: {
        id: "original",
        status: "completed",
        items: [{ type: "userMessage", clientId: "original-input" }],
      },
    });
    assert.equal(denied.result?.status, "failed");
    await retry();
    const restored = new RuntimeStore(f.store.root);
    const recovered = new ActorController(
      restored.data.actors.actor,
      restored,
      async () => f.adapter as any,
    );
    await retry(recovered);
    assert.equal(restored.data.actors.actor.submissions[0].failure?.code, code);
    assert.equal(nativeSteers, code === "EXECUTION_NOT_ADMITTED" ? 0 : 1);
  }
});
test("ambiguous steering completes only after its native client ID is observed, including recovery", async (t) => {
  const f = fixture(t);
  let nativeSteers = 0;
  f.adapter.steer = async () => {
    nativeSteers++;
    throw new Fault("NATIVE_UNKNOWN", "Lost reply");
  };
  f.event("turn/started", { turn: { id: "original" } });
  assert.equal((await f.actor.steer("uncertain", "original", "second")).status, "unknown");
  const uncertain = f.bootstrap.submissions[0];
  const original = {
    id: "original",
    status: "completed",
    items: [{ type: "userMessage", clientId: "original-input" }],
  };
  f.event("turn/completed", { turn: original });
  assert.equal(uncertain.result, undefined);
  assert.equal((await f.actor.steer("uncertain", "original", "second")).status, "unknown");
  f.history([original]);
  await f.actor.reconcile();
  assert.equal(uncertain.state, "unknown");
  assert.equal(uncertain.result, undefined);
  const restored = new RuntimeStore(f.store.root);
  const recovered = new ActorController(
    restored.data.actors.actor,
    restored,
    async () => f.adapter as any,
  );
  recovered.adapter = f.adapter as any;
  await recovered.reconcile();
  assert.equal(restored.data.actors.actor.submissions[0].result, undefined);
  f.history([
    { ...original, items: [...original.items, { type: "userMessage", clientId: "uncertain" }] },
  ]);
  await recovered.reconcile();
  assert.equal(
    new RuntimeStore(f.store.root).data.actors.actor.submissions[0].result?.status,
    "completed",
  );
  assert.equal((await recovered.steer("uncertain", "original", "second")).status, "accepted");
  assert.equal(nativeSteers, 1);
});
test("native response union grants requested scope, validates question IDs and declines forms", () => {
  assert.deepEqual(
    responseFor(
      "item/permissions/requestApproval",
      {
        permissions: {
          network: { enabled: true },
          fileSystem: { read: ["/owned"] },
          extra: "never-granted",
        },
      },
      "accept",
      null,
    ),
    {
      permissions: { network: { enabled: true }, fileSystem: { read: ["/owned"] } },
      scope: "turn",
    },
  );
  assert.deepEqual(
    responseFor("item/tool/requestUserInput", { questions: [{ id: "a" }] }, "accept", {
      answers: { a: { answers: ["yes"] } },
    }),
    { answers: { a: { answers: ["yes"] } } },
  );
  assert.throws(() =>
    responseFor("item/tool/requestUserInput", { questions: [{ id: "a" }] }, "accept", {
      answers: { foreign: { answers: ["yes"] } },
    }),
  );
  assert.deepEqual(responseFor("mcpServer/elicitation/request", {}, "decline", null), {
    action: "decline",
    content: null,
    _meta: null,
  });
});

test("no controller observation does not report an idle native executor", (t) => {
  const f = fixture(t);
  f.actor.adapter = undefined;
  assert.equal(f.actor.snapshot().observation, "unavailable");
});

test("explicit native refusal settles the run as failed and releases the next queued input", async (t) => {
  const f = fixture(t);
  let attempts = 0;
  f.adapter.start = async (...args: any[]) => {
    f.starts.push(args);
    if (++attempts === 1) throw new Fault("NATIVE_REJECTED", "Refused");
    return "second-turn";
  };
  const first = f.actor.enqueue("refused", "first");
  const second = f.actor.enqueue("second", "second");
  await new Promise(setImmediate);
  await new Promise(setImmediate);
  assert.equal(first.state, "done");
  assert.equal(first.result?.status, "failed");
  assert.equal(second.state, "running");
  assert.equal(second.turnId, "second-turn");
  assert.equal(attempts, 2);
});

test("durable cancellation recovered by native clientId interrupts only its correlated active turn", async (t) => {
  const f = fixture(t);
  f.actor.adapter = undefined;
  const input = f.actor.enqueue("cancelled", "task");
  input.state = "unknown";
  input.cancelRequested = true;
  f.actor.adapter = f.adapter as any;
  f.history([
    {
      id: "foreign",
      status: "completed",
      items: [
        { type: "userMessage", clientId: "foreign", content: [{ text: "[input cancelled]" }] },
      ],
    },
    {
      id: "correlated",
      status: "inProgress",
      items: [{ type: "userMessage", clientId: "cancelled" }],
    },
  ]);
  await f.actor.reconcile();
  assert.deepEqual(f.interrupts, ["correlated"]);
  assert.equal(input.turnId, "correlated");
  assert.equal(f.starts.length, 0);
});
