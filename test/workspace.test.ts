import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ActorController } from "../src/actors/controller.js";
import { type Bootstrap, inboxScope, RuntimeStore } from "../src/runtime/index.js";
import { form, message, team } from "./workspace-fixtures.js";

const settle = async () => {
  for (let i = 0; i < 12; i++) await new Promise(setImmediate);
};
function fixture(t: any) {
  const root = mkdtempSync(join(tmpdir(), "orgactor-workspace-"));
  const store = new RuntimeStore(root);
  const bootstrap: Bootstrap = {
    actorId: "actor",
    hubUrl: "http://owned.invalid",
    credential: "HUB_SENTINEL",
    threadId: "thread",
    bridgeToken: "BRIDGE_SENTINEL",
    enabled: true,
    config: { approvalAuthority: "hub" },
    submissions: [],
  };
  bootstrap.inbox = { scope: inboxScope(bootstrap), after: 0, baseline: [] };
  store.data.actors.actor = bootstrap;
  const answers: any[] = [];
  const adapter = {
    read: async () => ({
      thread: {
        id: "thread",
        sessionId: "session",
        turns: [{ id: "turn", status: "inProgress", items: [] }],
      },
    }),
    answer: (id: string, response: object) => {
      const saved = JSON.parse(readFileSync(store.file, "utf8"));
      assert.ok(Object.values(saved.actors.actor.approvals).some((b: any) => b.answerAttempt));
      answers.push({ id, response });
    },
    reject: () => {},
  };
  const actor = new ActorController(bootstrap, store, async () => adapter as any);
  actor.hub = {
    connection: { connected: true },
    alias: (_: string, name: string) => name,
    close: async () => {},
  } as any;
  const event = (method: string, params: any = {}, id?: string) =>
    (actor as any).observe({
      method,
      params: { threadId: "thread", turnId: "turn", ...params },
      ...(id ? { id } : {}),
    });
  const ready = async () => {
    actor.adapter = adapter as any;
    await actor.reconcile();
  };
  const request = () =>
    event(
      "item/permissions/requestApproval",
      { permissions: { network: { enabled: true } } },
      "request",
    );
  t.after(async () => {
    await actor.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, store, bootstrap, actor, adapter, event, ready, request, answers };
}

test("incoming pages persist receipts before cursor; partial save failure/restart neither loses nor duplicates input", async (t) => {
  const f = fixture(t);
  f.bootstrap.cursor = 999999;
  const all = Array.from({ length: 251 }, (_, n) => message(n + 1));
  const seen: number[] = [];
  const call = async (name: string, args: any) => {
    assert.equal(name, "message_list");
    assert.equal(args.direction, "incoming");
    assert.equal(args.limit, 100);
    seen.push(args.after);
    const items = all.filter((m) => m.cursor > args.after).slice(0, args.limit);
    if (!items.length) (f.actor.hub as any).connection.connected = false;
    return { structuredContent: { items, after: items.at(-1)?.cursor ?? args.after } };
  };
  (f.actor.hub as any).call = call;
  const save = f.store.save.bind(f.store);
  f.store.save = () => {
    if (f.bootstrap.submissions.length === 101) throw new Error("owned persistence fault");
    save();
  };
  await (f.actor as any).watchInbox();
  const reopened = new RuntimeStore(f.root);
  assert.equal(reopened.data.actors.actor.inbox?.after, 100);
  assert.equal(reopened.data.actors.actor.submissions.length, 100);
  const actor = new ActorController(
    reopened.data.actors.actor,
    reopened,
    async () => f.adapter as any,
  );
  actor.hub = f.actor.hub;
  t.after(() => actor.close());
  await (actor as any).watchInbox();
  assert.deepEqual(seen, [0, 100, 100, 200, 251]);
  assert.equal(reopened.data.actors.actor.submissions.length, 251);
  assert.equal(new Set(reopened.data.actors.actor.submissions.map((s) => s.id)).size, 251);
  assert.equal(reopened.data.actors.actor.cursor, 999999);
  assert.equal(reopened.data.actors.actor.inbox?.after, 251);
});

test("explicit historical baseline skips only exact imported rows without manufacturing receipts or completion", async (t) => {
  const f = fixture(t);
  const first = message(1),
    historical = message(3),
    fresh = message(2);
  f.bootstrap.inbox = {
    scope: inboxScope(f.bootstrap),
    after: 0,
    baseline: [first, historical].map(({ messageID, recipientID, cursor }) => ({
      messageID,
      recipientID,
      cursor,
    })),
  };
  (f.actor.hub as any).call = async (_: string, args: any) => {
    if (args.after) (f.actor.hub as any).connection.connected = false;
    return { structuredContent: { items: args.after ? [] : [first, fresh, historical], after: 3 } };
  };
  await (f.actor as any).watchInbox();
  assert.deepEqual(
    f.bootstrap.submissions.map((s) => ({ id: s.id, state: s.state, result: s.result })),
    [{ id: "message:m2", state: "queued", result: undefined }],
  );
  assert.equal(f.bootstrap.inbox.after, 3);
  assert.equal(f.bootstrap.inbox.baseline?.length, 2);
});

for (const change of ["hubUrl", "actorId", "credential", "threadId"] as const)
  test(`wrong ${change} scope holds inbox migration without querying or dispatching`, async (t) => {
    const f = fixture(t);
    f.bootstrap.inbox = { scope: inboxScope(f.bootstrap), after: 50, baseline: [] };
    f.bootstrap[change] += "-changed";
    (f.actor.hub as any).call = async () => assert.fail("No new traversal before scoped migration");
    await (f.actor as any).watchInbox();
    assert.equal(f.bootstrap.inbox.after, 50);
    assert.match(f.actor.lastError ?? "", /authoritative historical Message baseline/);
  });

test("same-ID receipt dedup preserves unknown input; baseline mismatch cannot move the cursor", async (t) => {
  const f = fixture(t),
    m = message(1);
  f.actor.enqueue("message:m1", m.text, m.senderID).state = "unknown";
  f.store.save();
  f.bootstrap.inbox = {
    scope: inboxScope(f.bootstrap),
    after: 0,
    baseline: [{ messageID: "m2", recipientID: "foreign", cursor: 2 }],
  };
  (f.actor.hub as any).call = async () => ({
    structuredContent: { items: [m, message(2)], after: 2 },
  });
  await (f.actor as any).watchInbox();
  assert.equal(f.bootstrap.inbox.after, 0);
  assert.equal(f.bootstrap.submissions.length, 1);
  assert.equal(f.bootstrap.submissions[0].state, "unknown");
});

for (const bad of [
  undefined,
  [{ messageID: "m1", recipientID: "actor", cursor: 0 }],
  [{ messageID: "m1", recipientID: "other", cursor: 1 }],
])
  test("incomplete or invalid host baseline holds inbox migration", async (t) => {
    const f = fixture(t);
    f.bootstrap.inbox = { scope: inboxScope(f.bootstrap), after: 0, baseline: bad };
    (f.actor.hub as any).call = async () => assert.fail("Invalid baseline cannot start delivery");
    await (f.actor as any).watchInbox();
    assert.equal(f.bootstrap.submissions.length, 0);
    assert.match(f.actor.lastError ?? "", /authoritative historical Message baseline/);
  });

test("receipt-based repeated Message identity retains an unknown outcome without a new dispatch", async (t) => {
  const f = fixture(t),
    m = message(1);
  f.actor.enqueue("message:m1", m.text, m.senderID).state = "unknown";
  f.store.save();
  (f.actor.hub as any).call = async (_: string, args: any) => {
    if (args.after) (f.actor.hub as any).connection.connected = false;
    return { structuredContent: { items: args.after ? [] : [m], after: 1 } };
  };
  await (f.actor as any).watchInbox();
  assert.equal(f.bootstrap.submissions.length, 1);
  assert.equal(f.bootstrap.submissions[0].state, "unknown");
  assert.equal(f.bootstrap.submissions[0].result, undefined);
  assert.equal(f.bootstrap.inbox?.after, 1);
});

test("standalone Form binds current manager and exact native scope; one response has one durable uncertain attempt", async (t) => {
  const f = fixture(t);
  await f.ready();
  let created: any,
    reads = 0;
  (f.actor.hub as any).call = async (name: string, args: any) => {
    if (name === "team") return { structuredContent: team() };
    if (name === "form_create") {
      created = form(args, { responses: { manager: { decision: "accept", input: "" } } });
      return { structuredContent: created };
    }
    assert.equal(name, "form_get");
    assert.deepEqual(args, { formID: created.formID });
    reads++;
    return { structuredContent: created };
  };
  f.request();
  await settle();
  assert.equal(created.workID, undefined);
  assert.deepEqual(created.respondentIDs, ["manager"]);
  assert.match(created.fields[0].label, /Request reference [a-f0-9]{64}/);
  assert.equal(created.fields[0].label.includes("native session session"), false);
  assert.deepEqual(f.answers, [
    { id: "request", response: { permissions: { network: { enabled: true } }, scope: "turn" } },
  ]);
  assert.equal(reads, 1);
  const binding = Object.values(f.bootstrap.approvals ?? {})[0];
  assert.equal(binding.sessionId, "session");
  assert.equal(binding.answerAttempt?.formRevision, 1);
  f.event("serverRequest/resolved", { requestId: "request" });
  assert.equal(binding.state, "resolved");
  assert.equal(created.status, "open");
  f.request();
  await settle();
  assert.equal(f.answers.length, 1);
});

for (const invalid of [
  "requester",
  "respondent",
  "fields",
  "closed",
  "manager",
  "terminal",
  "session",
  "desktop",
])
  test(`Form ${invalid} cannot authorize an unrelated/stale native request`, async (t) => {
    const f = fixture(t);
    await f.ready();
    let created: any;
    (f.actor.hub as any).call = async (name: string, args: any) => {
      if (name === "team") return { structuredContent: team() };
      if (name === "form_create") {
        created = form(args);
        return { structuredContent: created };
      }
      assert.equal(name, "form_get");
      const answer = { ...created, responses: { manager: { decision: "accept", input: "" } } };
      if (invalid === "requester") answer.requesterID = "other";
      if (invalid === "respondent") answer.respondentIDs = ["other"];
      if (invalid === "fields") answer.fields = [{ name: "fake", label: "fake", required: false }];
      if (invalid === "closed") {
        answer.status = "resolved";
        answer.responses = {};
        answer.resolution = { text: "accept", at: created.createdAt };
      }
      if (invalid === "manager")
        (f.actor.hub as any).call = async () => ({
          structuredContent: {
            root: "root",
            positions: [{ ...team().positions[0], manager: "replacement" }],
          },
        });
      if (invalid === "terminal")
        f.event("turn/completed", { turn: { id: "turn", status: "completed", items: [] } });
      if (invalid === "session") (f.actor as any).sessionId = "replacement";
      if (invalid === "desktop") f.bootstrap.config.approvalAuthority = "desktop";
      return { structuredContent: answer };
    };
    f.request();
    await settle();
    assert.equal(f.answers.length, 0);
  });

test("lost Form issuance recovers one exact requester's Form, never reissues or resends an uncertain answer after restart", async (t) => {
  const f = fixture(t);
  await f.ready();
  let created: any,
    creates = 0,
    reads = false;
  const call = async (name: string, args: any): Promise<any> => {
    if (name === "team") return { structuredContent: team() };
    if (name === "form_create") {
      creates++;
      created = form(args, { responses: { manager: { decision: "accept" } } });
      throw new Error("lost creation reply");
    }
    if (name === "form_list") {
      assert.equal(args.requesterID, "actor");
      if (!reads) throw new Error("held read unavailable");
      return { structuredContent: { items: args.after ? [] : [created], after: 1 } };
    }
    assert.equal(name, "form_get");
    return { structuredContent: created };
  };
  (f.actor.hub as any).call = call;
  f.request();
  await settle();
  const reopen = () => {
    const store = new RuntimeStore(f.root);
    const actor = new ActorController(store.data.actors.actor, store, async () => f.adapter as any);
    actor.hub = { ...f.actor.hub, call } as any;
    actor.adapter = {
      ...f.adapter,
      answer: (id: string, response: object) => {
        f.answers.push({ id, response });
        throw new Error("socket outcome unknown");
      },
    } as any;
    t.after(() => actor.close());
    return { store, actor };
  };
  reads = true;
  const second = reopen();
  await second.actor.reconcile();
  (second.actor as any).observe({
    method: "item/permissions/requestApproval",
    id: "request",
    params: { threadId: "thread", turnId: "turn", permissions: { network: { enabled: true } } },
  });
  await settle();
  assert.equal(creates, 1);
  assert.equal(f.answers.length, 1);
  const third = reopen();
  await third.actor.reconcile();
  (third.actor as any).observe({
    method: "item/permissions/requestApproval",
    id: "request",
    params: { threadId: "thread", turnId: "turn", permissions: { network: { enabled: true } } },
  });
  await settle();
  assert.equal(creates, 1);
  assert.equal(f.answers.length, 1);
  assert.ok(Object.values(third.store.data.actors.actor.approvals ?? {})[0].answerAttempt);
});

test("old private rows remain readable and exact; missing Workspace state is inert", async (t) => {
  const f = fixture(t);
  const old = structuredClone(f.store.data);
  delete old.actors.actor.inbox;
  old.actors.actor.cursor = 7;
  old.actors.actor.enabled = false;
  old.actors.actor.submissions = [
    {
      id: "real-receipt",
      text: "retained",
      from: "manager",
      cause: "historical-cause",
      state: "done",
      turnId: "completed-turn",
      applied: true,
      result: {
        inputId: "real-receipt",
        turnId: "completed-turn",
        status: "completed",
        output: "retained result",
      },
    },
  ];
  old.actors.actor.approvals = {
    legacy: {
      requestId: "legacy",
      threadId: "thread",
      turnId: "old-turn",
      method: "item/fileChange/requestApproval",
      answerer: "manager",
      questionId: "old-question",
      questionCursor: 3,
      state: "resolved",
    },
  };
  writeFileSync(f.store.file, JSON.stringify(old));
  const reopened = new RuntimeStore(f.root);
  assert.deepEqual(reopened.data, old);
  assert.equal(reopened.data.actors.actor.inbox, undefined);
  assert.equal(reopened.data.actors.actor.submissions.length, 1);
  f.bootstrap.inbox = undefined;
  (f.actor.hub as any).call = async () =>
    assert.fail("Missing historical baseline must hold inbox delivery");
  await (f.actor as any).watchInbox();
  assert.match(f.actor.lastError ?? "", /authoritative historical Message baseline/);
});

for (const matches of [0, 2])
  test(`uncertain Form creation with ${matches} matches never duplicates issuance or grants native input`, async (t) => {
    const f = fixture(t);
    await f.ready();
    let created: any,
      creates = 0;
    (f.actor.hub as any).call = async (name: string, args: any) => {
      if (name === "team") return { structuredContent: team() };
      if (name === "form_create") {
        creates++;
        created = form(args);
        throw new Error("unknown create outcome");
      }
      assert.equal(name, "form_list");
      return {
        structuredContent: {
          items: args.after
            ? []
            : Array.from({ length: matches }, (_, n) => ({
                ...created,
                formID: `form-${n}`,
                cursor: n + 1,
              })),
          after: matches,
        },
      };
    };
    f.request();
    await settle();
    f.request();
    await settle();
    assert.equal(creates, 1);
    assert.equal(f.answers.length, 0);
    assert.match(f.actor.lastError ?? "", matches ? /Multiple Forms/ : /issuance is uncertain/);
  });
