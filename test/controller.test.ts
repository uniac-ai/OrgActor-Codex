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
    read: async () => ({ thread: { turns: history } }),
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
test("recovery uses native clientId, never caller text or foreign completion", async (t) => {
  const f = fixture(t);
  f.actor.adapter = undefined;
  const input = f.actor.enqueue("known", "payload", "manager", "known");
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
test("local steering retains input provenance; mixed native-applied inputs do not guess a cause", async (t) => {
  const f = fixture(t);
  f.actor.adapter = undefined;
  const run = f.actor.enqueue("run", "first", "manager", "call-run");
  run.state = "running";
  run.turnId = "turn-owned";
  f.actor.adapter = f.adapter as any;
  f.event("turn/started", { turn: { id: "turn-owned" } });
  f.event("item/completed", {
    turnId: "turn-owned",
    item: { type: "userMessage", clientId: "run" },
  });
  assert.equal(f.actor.currentCause(), "call-run");
  await f.actor.steer("call-steer", "turn-owned", "second", "manager", "call-steer");
  assert.equal(f.bootstrap.submissions[1].cause, "call-steer");
  f.event("item/completed", {
    turnId: "turn-owned",
    item: { type: "userMessage", clientId: "call-steer" },
  });
  assert.equal(f.actor.currentCause(), null);
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
test("unread backlog drains past 200; restart after durable acceptance before acknowledgement duplicates none", async (t) => {
  const f = fixture(t);
  f.actor.adapter = undefined;
  let unread = Array.from({ length: 251 }, (_, n) => ({
    id: `m${n}`,
    from: "manager",
    text: `task ${n}`,
    cursor: n + 1,
  }));
  let crash = true;
  const hub = {
    connection: { connected: true },
    alias: (_: string, name: string) => name,
    call: async (name: string, input: any) => {
      if (name === "messages") {
        assert.equal(Object.hasOwn(input, "since"), false);
        return {
          structuredContent: { messages: unread.slice(-input.limit).reverse(), cursor: 251 },
        };
      }
      if (crash) {
        crash = false;
        throw new Error("crash before ack");
      }
      unread = unread.filter((m) => !input.ids.includes(m.id));
      if (!unread.length) hub.connection.connected = false;
      return { structuredContent: {} };
    },
  };
  f.actor.hub = hub as any;
  await (f.actor as any).watchInbox();
  assert.equal(f.bootstrap.submissions.length, 200);
  const restored = new RuntimeStore(f.store.root);
  const restarted = new ActorController(
    restored.data.actors.actor,
    restored,
    async () => ({}) as any,
  );
  restarted.hub = hub as any;
  await (restarted as any).watchInbox();
  assert.equal(restored.data.actors.actor.submissions.length, 251);
  assert.equal(unread.length, 0);
  assert.equal(new Set(restored.data.actors.actor.submissions.map((s) => s.id)).size, 251);
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
    responseFor(
      "item/tool/requestUserInput",
      { questions: [{ id: "a" }] },
      "accept",
      '{"answers":{"a":{"answers":["yes"]}}}',
    ),
    { answers: { a: { answers: ["yes"] } } },
  );
  assert.throws(() =>
    responseFor(
      "item/tool/requestUserInput",
      { questions: [{ id: "a" }] },
      "accept",
      '{"answers":{"foreign":{"answers":["yes"]}}}',
    ),
  );
  assert.deepEqual(responseFor("mcpServer/elicitation/request", {}, "decline", null), {
    action: "decline",
    content: null,
    _meta: null,
  });
});

test("Hub approval binds the designated manager and native IDs; stale answers and Desktop observation never respond", async (t) => {
  const f = fixture(t);
  const sent: any[] = [];
  f.adapter.answer = ((id: string, result: any) => sent.push({ id, result })) as any;
  f.bootstrap.config.approvalAuthority = "hub";
  f.actor.turnId = "turn-owned";
  const question = deferred<any>();
  const asked: any[] = [];
  const hub = f.actor.hub as any;
  hub.call = async (name: string, input: any) => {
    if (name === "team")
      return {
        structuredContent: { root: "root", positions: [{ id: "actor", manager: "manager" }] },
      };
    if (name === "question_ask") {
      asked.push(input);
      return question.promise;
    }
    return {
      structuredContent: {
        questions: [{ id: "q", answer: { by: "manager", choice: "accept", text: null } }],
      },
    };
  };
  f.event(
    "item/commandExecution/requestApproval",
    { turnId: "turn-owned", command: "echo safe" },
    "request",
  );
  await new Promise(setImmediate);
  assert.equal(asked[0].answerer, "manager");
  assert.equal(asked[0].to, "manager");
  assert.equal(f.bootstrap.approvals?.request.threadId, "owned");
  f.event("serverRequest/resolved", { requestId: "request" });
  question.resolve({ structuredContent: { id: "q" } });
  await new Promise(setImmediate);
  assert.equal(sent.length, 0);
  assert.equal(f.bootstrap.approvals?.request.state, "resolved");
  f.bootstrap.config.approvalAuthority = "desktop";
  f.event("item/fileChange/requestApproval", { turnId: "turn-owned" }, "desktop");
  await new Promise(setImmediate);
  assert.equal(asked.length, 1);
  assert.equal(sent.length, 0);
  f.bootstrap.config.approvalAuthority = "hub";
  hub.call = async (name: string) =>
    name === "team"
      ? { structuredContent: { root: "root", positions: [{ id: "actor", manager: "manager" }] } }
      : name === "question_ask"
        ? { structuredContent: { id: "q2" } }
        : {
            structuredContent: {
              questions: [{ id: "q2", answer: { by: "manager", choice: "decline", text: null } }],
            },
          };
  f.event(
    "item/permissions/requestApproval",
    { turnId: "turn-owned", permissions: { network: { enabled: true } } },
    "permission",
  );
  await new Promise(setImmediate);
  await new Promise(setImmediate);
  assert.deepEqual(sent, [{ id: "permission", result: { permissions: {}, scope: "turn" } }]);
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

test("lost Hub approval reply reconciles its exact scoped question after restart without duplicate issuance", async (t) => {
  const f = fixture(t);
  f.bootstrap.config.approvalAuthority = "hub";
  f.actor.turnId = "turn-owned";
  const params = {
    turnId: "turn-owned",
    reason: "Read one input and write one output",
    permissions: {
      network: { enabled: true },
      fileSystem: { read: ["/approved/input"], write: ["/approved/output"] },
    },
  };
  const questions: any[] = [];
  let issued = 0;
  const responses: any[] = [];
  const call = async (name: string, input: any) => {
    if (name === "team")
      return {
        structuredContent: { root: "root", positions: [{ id: "actor", manager: "manager" }] },
      };
    if (name === "question_ask") {
      issued++;
      questions.push({
        id: "committed",
        cursor: 7,
        from: "actor",
        ...input,
        answer: { by: "manager", choice: "accept", text: null },
      });
      throw new Fault("NATIVE_UNKNOWN", "Hub response was lost");
    }
    return { structuredContent: { questions } };
  };
  (f.actor.hub as any).call = call;
  f.event("item/permissions/requestApproval", params, "request");
  await new Promise(setImmediate);
  assert.equal(issued, 1);
  assert.equal(f.bootstrap.approvals?.request.state, "asking");
  assert.equal(f.bootstrap.approvals?.request.questionId, undefined);
  for (const scope of [
    "/approved/input",
    "/approved/output",
    '"enabled":true',
    "Read one input and write one output",
    "Session owned, turn turn-owned, request request",
  ])
    assert.ok(questions[0].text.includes(scope));
  const uncertain = structuredClone(f.store.data);
  const restored = new RuntimeStore(f.store.root);
  const actor = new ActorController(
    restored.data.actors.actor,
    restored,
    async () => f.adapter as any,
  );
  actor.turnId = "turn-owned";
  actor.adapter = {
    ...f.adapter,
    answer: (id: string, result: any) => responses.push({ id, result }),
  } as any;
  actor.hub = { ...f.actor.hub, call } as any;
  (actor as any).observe({
    method: "item/permissions/requestApproval",
    id: "request",
    params: { threadId: "owned", ...params },
  });
  await new Promise(setImmediate);
  await new Promise(setImmediate);
  assert.equal(issued, 1);
  assert.deepEqual(responses, [
    { id: "request", result: { permissions: params.permissions, scope: "turn" } },
  ]);
  assert.equal(restored.data.actors.actor.approvals?.request.state, "resolved");
  const ambiguous = fixture(t);
  ambiguous.store.data = uncertain;
  const other = new ActorController(
    uncertain.actors.actor,
    ambiguous.store,
    async () => f.adapter as any,
  );
  other.turnId = "turn-owned";
  other.adapter = {
    ...f.adapter,
    answer: () => assert.fail("Ambiguous questions cannot authorize a native response"),
  } as any;
  other.hub = {
    ...f.actor.hub,
    call: async (name: string, input: any) =>
      name === "questions"
        ? { structuredContent: { questions: [...questions, { ...questions[0], id: "duplicate" }] } }
        : call(name, input),
  } as any;
  (other as any).observe({
    method: "item/permissions/requestApproval",
    id: "request",
    params: { threadId: "owned", ...params },
  });
  await new Promise(setImmediate);
  await new Promise(setImmediate);
  assert.match(other.lastError ?? "", /Multiple Hub questions/);
  assert.equal(issued, 1);
});
