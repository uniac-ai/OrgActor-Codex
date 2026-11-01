import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Work } from "@agentorg/cli/contract";
import { ActorController } from "../src/actors/controller.js";
import { Fault } from "../src/management/schema.js";
import { type Bootstrap, RuntimeStore } from "../src/runtime/index.js";
import { at, attention, form, message } from "./workspace-fixtures.js";

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
  bootstrap.delivered = "0";
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
    steers: [] as string[],
    steer: async (_thread: string, turnId: string, _text: string, id: string) => {
      adapter.steers.push(id);
      if (id.includes(":refused:")) throw new Fault("NATIVE_REJECTED", "Refused", 422);
      return turnId;
    },
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

const ok = (structuredContent: object) => ({ structuredContent });

test("attention receipts persist before the position; a failed save and restart neither lose nor duplicate input", async (t) => {
  const f = fixture(t);
  const items = ["w1", "w2", "w3"].map((recordID) => ({ kind: "assigned", recordID }));
  const seen: unknown[] = [];
  const call = async (name: string, args: any, timeout?: number) => {
    assert.equal(name, "attention");
    assert.equal(timeout, 630_000);
    seen.push(args);
    if (args.since === "3") (f.actor.hub as any).connection.connected = false;
    return ok(args.since === "0" ? attention("3", items) : attention("3"));
  };
  (f.actor.hub as any).call = call;
  const save = f.store.save.bind(f.store);
  f.store.save = () => {
    if (f.bootstrap.submissions.length === 2) throw new Error("owned persistence fault");
    save();
  };
  await (f.actor as any).watchInbox();
  const reopened = new RuntimeStore(f.root);
  assert.equal(reopened.data.actors.actor.delivered, "0");
  assert.equal(reopened.data.actors.actor.submissions.length, 1);
  const actor = new ActorController(
    reopened.data.actors.actor,
    reopened,
    async () => f.adapter as any,
  );
  actor.hub = f.actor.hub;
  t.after(() => actor.close());
  await (actor as any).watchInbox();
  assert.deepEqual(seen, [
    { since: "0", wait: 600 },
    { since: "0", wait: 600 },
    { since: "3", wait: 600 },
  ]);
  const inputs = reopened.data.actors.actor.submissions;
  assert.deepEqual(
    inputs.map((s) => s.id),
    items.map((i) => `assigned:${i.recordID}:${at}`),
  );
  assert.ok(inputs.every((s) => s.state === "queued" && s.from === "manager"));
  assert.match(inputs[0].text, /manager assigned you Work "w1" \(w1\)/);
  assert.equal(reopened.data.actors.actor.delivered, "3");
});

test("a missing position starts at the Hub's current one, and one the Hub never issued restarts from now", async (t) => {
  const f = fixture(t);
  delete f.bootstrap.delivered;
  const seen: unknown[] = [];
  (f.actor.hub as any).call = async (name: string, args: any) => {
    assert.equal(name, "attention");
    seen.push(args);
    if (args.since === "7")
      return {
        isError: true,
        content: [{ type: "text", text: "invalid: since: beyond this Hub's position" }],
      };
    if (args.since === "9") (f.actor.hub as any).connection.connected = false;
    return ok(attention(seen.length === 1 ? "7" : "9"));
  };
  await (f.actor as any).watchInbox();
  assert.deepEqual(seen, [{}, { since: "7", wait: 600 }, {}, { since: "9", wait: 600 }]);
  assert.equal(f.bootstrap.delivered, "9");
  assert.equal(f.bootstrap.submissions.length, 0);
});

test("input steers a running turn, and starts the next turn when the turn waits on a native request or refuses", async (t) => {
  const f = fixture(t);
  f.bootstrap.config.approvalAuthority = "desktop";
  await f.ready();
  const deliver = (recordID: string) =>
    (f.actor as any).deliver(
      f.actor.hub,
      attention("1", [{ kind: "assigned", recordID }]).items[0],
    );
  await deliver("steered");
  await deliver("refused");
  f.request();
  await deliver("waiting");
  await deliver("steered");
  assert.deepEqual(f.adapter.steers, [`assigned:steered:${at}`, `assigned:refused:${at}`]);
  assert.deepEqual(
    f.bootstrap.submissions.map((s) => [s.id, s.kind ?? "run", s.state]),
    [
      [`assigned:steered:${at}`, "steer", "running"],
      [`assigned:refused:${at}`, "steer", "done"],
      [`assigned:refused:${at}:next`, "run", "queued"],
      [`assigned:waiting:${at}`, "run", "queued"],
    ],
  );
});

test("an answer carries its ask and Work; the answer to a native request's approval ask is not input", async (t) => {
  const f = fixture(t);
  const fields = [{ name: "field_native_0", label: "Decision", required: true }];
  f.bootstrap.approvals = {
    native: {
      requestId: "r",
      threadId: "thread",
      turnId: "turn",
      method: "m",
      fields,
      state: "waiting",
    },
  };
  const answered = { answers: { approach: "freeze" }, note: "Go", at };
  (f.actor.hub as any).call = async (name: string, args: any) => {
    if (name === "work_get")
      return ok(
        Work.parse({
          ticketID: "w1",
          requesterID: "actor",
          ownerID: "actor",
          title: "Switch to v2",
          status: "active",
          links: [],
          createdAt: at,
          revision: 1,
          updatedAt: at,
        }),
      );
    assert.equal(name, "form_get");
    return ok(
      args.formID === "own"
        ? form({ title: "Grant?", fields }, { formID: "own", responses: { manager: answered } })
        : form(
            { title: "Freeze?", fields: [{ name: "approach", label: "Approach", required: true }] },
            {
              formID: "other",
              approval: false,
              status: "resolved",
              workID: "w1",
              responses: { manager: answered },
            },
          ),
    );
  };
  for (const recordID of ["own", "other"])
    await (f.actor as any).deliver(
      f.actor.hub,
      attention("1", [{ kind: "answer", recordID, title: "Freeze?" }]).items[0],
    );
  assert.deepEqual(
    f.bootstrap.submissions.map((s) => s.id),
    [`answer:other:${at}`],
  );
  assert.equal(
    f.bootstrap.submissions[0].text,
    'manager answered your ask "Freeze?" (other): approach: freeze. Note: Go Apply it, then update "Switch to v2" (w1). The ask records the answer; it is resolved.',
  );
});

test("a message carries its conversation from the Actor's own last message, once per sender", async (t) => {
  const f = fixture(t);
  const conversation = [message(1), message(2, "manager", "actor"), message(3), message(4)];
  (f.actor.hub as any).call = async (name: string, args: any) => {
    if (name === "message_list") {
      assert.deepEqual(args, { counterpartyID: "manager", before: "latest", limit: 20 });
      return ok({ items: conversation, next: null, older: null, actors: {} });
    }
    assert.equal(name, "attention");
    if (args.since === "2") (f.actor.hub as any).connection.connected = false;
    return ok(
      args.since === "0"
        ? attention("2", [
            { kind: "message", recordID: "m3" },
            { kind: "message", recordID: "m4" },
          ])
        : attention("2"),
    );
  };
  await (f.actor as any).watchInbox();
  assert.deepEqual(
    f.bootstrap.submissions.map((s) => s.id),
    [`message:m4:${at}`],
  );
  assert.equal(
    f.bootstrap.submissions[0].text,
    "manager sent you a message. The conversation from your last message in it:\nyou (m2): task 2\nmanager (m3): task 3\nmanager (m4): task 4\nReply with message_send {recipientID: manager}.",
  );
});

test("a repeated item keeps its unknown outcome without a new dispatch", async (t) => {
  const f = fixture(t);
  f.actor.enqueue(`assigned:w1:${at}`, "earlier", "manager").state = "unknown";
  f.store.save();
  (f.actor.hub as any).call = async (_: string, args: any) => {
    if (args.since === "1") (f.actor.hub as any).connection.connected = false;
    return ok(attention("1", args.since === "0" ? [{ kind: "assigned", recordID: "w1" }] : []));
  };
  await (f.actor as any).watchInbox();
  assert.equal(f.bootstrap.submissions.length, 1);
  assert.equal(f.bootstrap.submissions[0].state, "unknown");
  assert.equal(f.bootstrap.delivered, "1");
});

const answer = (name: string, value = "Approve") => ({
  status: "resolved" as const,
  responses: { manager: { answers: { [name]: value }, at } },
});
const noTeam = (name: string) => assert.notEqual(name, "team", "approval asks name no answerer");

test("an approval ask binds the exact native scope; one manager answer has one durable uncertain attempt", async (t) => {
  const f = fixture(t);
  await f.ready();
  let created: any,
    reads = 0;
  (f.actor.hub as any).call = async (name: string, args: any) => {
    noTeam(name);
    if (name === "form_create") {
      created = form(args, answer(args.fields[0].name));
      return { structuredContent: created };
    }
    assert.equal(name, "form_get");
    assert.deepEqual(args, { formID: created.formID });
    reads++;
    return { structuredContent: created };
  };
  f.request();
  await settle();
  assert.equal(created.approval, true);
  assert.equal(created.workID, undefined);
  assert.equal(created.title, "Grant Codex network access for this turn?");
  assert.match(created.context, /Requested scope: \{"network":\{"enabled":true\}\}/);
  assert.match(created.fields[0].name, /field_[a-f0-9]{64}_0/);
  assert.deepEqual(
    created.fields[0].options.map((o: any) => o.value),
    ["Approve", "Decline", "Cancel"],
  );
  assert.equal(JSON.stringify(created).includes("session"), false);
  assert.deepEqual(f.answers, [
    { id: "request", response: { permissions: { network: { enabled: true } }, scope: "turn" } },
  ]);
  assert.equal(reads, 1);
  const binding = Object.values(f.bootstrap.approvals ?? {})[0];
  assert.equal(binding.sessionId, "session");
  assert.equal(binding.answerAttempt?.formRevision, 1);
  f.event("serverRequest/resolved", { requestId: "request" });
  assert.equal(binding.state, "resolved");
  f.request();
  await settle();
  assert.equal(f.answers.length, 1);
});

for (const invalid of [
  "requester",
  "approval",
  "fields",
  "closed",
  "terminal",
  "session",
  "desktop",
])
  test(`an ask's ${invalid} change cannot authorize an unrelated/stale native request`, async (t) => {
    const f = fixture(t);
    await f.ready();
    let created: any;
    (f.actor.hub as any).call = async (name: string, args: any) => {
      noTeam(name);
      if (name === "form_create") {
        created = form(args);
        return { structuredContent: created };
      }
      assert.equal(name, "form_get");
      const answered = { ...created, ...answer(created.fields[0].name) };
      if (invalid === "requester") answered.requesterID = "other";
      if (invalid === "approval") answered.approval = false;
      if (invalid === "fields")
        answered.fields = [{ name: "fake", label: "fake", required: false }];
      if (invalid === "closed") {
        answered.status = "cancelled";
        answered.responses = {};
        answered.resolution = { text: "approve", at };
      }
      if (invalid === "terminal")
        f.event("turn/completed", { turn: { id: "turn", status: "completed", items: [] } });
      if (invalid === "session") (f.actor as any).sessionId = "replacement";
      if (invalid === "desktop") f.bootstrap.config.approvalAuthority = "desktop";
      return { structuredContent: answered };
    };
    f.request();
    await settle();
    assert.equal(f.answers.length, 0);
  });

test("lost ask issuance recovers one exact requester's ask, never reissues or resends an uncertain answer after restart", async (t) => {
  const f = fixture(t);
  await f.ready();
  let created: any,
    creates = 0,
    reads = false;
  const call = async (name: string, args: any): Promise<any> => {
    noTeam(name);
    if (name === "form_create") {
      creates++;
      created = form(args, answer(args.fields[0].name));
      throw new Error("lost creation reply");
    }
    if (name === "form_list") {
      assert.equal(args.requesterID, "actor");
      if (!reads) throw new Error("held read unavailable");
      return {
        structuredContent: {
          items: args.after
            ? []
            : [
                form(
                  { title: "Other", fields: [{ name: "x", label: "x", required: false }] },
                  { formID: "x" },
                ),
                created,
              ],
          next: args.after ? null : "page-2",
          actors: {},
        },
      };
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

test("old private rows remain readable and exact", async (t) => {
  const f = fixture(t);
  const old: any = structuredClone(f.store.data);
  old.actors.actor.inbox = { scope: "historical", after: 3, baseline: [] };
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
  assert.equal(reopened.data.actors.actor.submissions.length, 1);
});

for (const matches of [0, 2])
  test(`uncertain ask creation with ${matches} matches never duplicates issuance or grants native input`, async (t) => {
    const f = fixture(t);
    await f.ready();
    let created: any,
      creates = 0;
    (f.actor.hub as any).call = async (name: string, args: any) => {
      noTeam(name);
      if (name === "form_create") {
        creates++;
        created = form(args);
        throw new Error("unknown create outcome");
      }
      assert.equal(name, "form_list");
      return {
        structuredContent: {
          items: Array.from({ length: matches }, (_, n) => ({ ...created, formID: `form-${n}` })),
          next: null,
          actors: {},
        },
      };
    };
    f.request();
    await settle();
    f.request();
    await settle();
    assert.equal(creates, 1);
    assert.equal(f.answers.length, 0);
    assert.match(f.actor.lastError ?? "", matches ? /Multiple asks/ : /issuance is uncertain/);
  });
