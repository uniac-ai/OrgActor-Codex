import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Work } from "@agentorg/cli/contract";
import { ActorController } from "../src/actors/controller.js";
import { nativeForm } from "../src/actors/forms.js";
import { Fault } from "../src/management/schema.js";
import { type Bootstrap, hash, RuntimeStore } from "../src/runtime/index.js";
import { at, attention, form, message } from "./workspace-fixtures.js";

/** The Hub's work_answer, at the Team level. */
const answering = {
  name: "work_answer",
  inputSchema: { type: "object" },
  _meta: {
    "agentorg/tool": {
      id: "hub:work",
      name: "work",
      interface: "work_answer",
      one_way: false,
      long_running: false,
      level: "team",
    },
  },
};
/** The Actor's most recently updated active Work, which a native prompt is asked on. */
const active = Work.parse({
  ticketID: "w-active",
  requesterID: "actor",
  ownerID: "actor",
  title: "Build",
  status: "active",
  links: [],
  createdAt: at,
  revision: 1,
  updatedAt: at,
});
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
    tools: [answering],
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
  assert.match(inputs[0].text, /manager gave you Work "w1" \(w1\)/);
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
    assert.equal(name, "work_get");
    // An ask from before asks on Work comes alone; one on Work comes with its Work.
    if (args.askID === "own")
      return ok(
        form({ title: "Grant?", fields }, { formID: "own", responses: { manager: answered } }),
      );
    return ok(
      Work.parse({
        ...active,
        ticketID: "w1",
        title: "Switch to v2",
        asks: [
          form(
            { title: "Freeze?", fields: [{ name: "approach", label: "Approach", required: true }] },
            {
              formID: "other",
              approval: false,
              status: "resolved",
              workID: "w1",
              responses: { manager: answered },
            },
          ),
        ],
      }),
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
    'manager answered your ask "Freeze?" (other): approach: freeze. Note: Go. Apply it, then update "Switch to v2" (w1). The ask records the answer; it is resolved.',
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
    if (name === "work_list") {
      assert.deepEqual(args, { ownerID: "actor", status: ["active"], order: "recent", limit: 1 });
      return ok({ items: [active], next: null, actors: {} });
    }
    if (name === "work_update") {
      created = form(args.ask, { workID: args.ticketID, ...answer(args.ask.fields[0].name) });
      return ok(created);
    }
    assert.equal(name, "work_get");
    assert.deepEqual(args, { askID: created.formID });
    reads++;
    return ok({ ...active, asks: [created] });
  };
  f.request();
  await settle();
  assert.equal(created.approval, true);
  assert.equal(created.workID, "w-active", "asked on the Actor's most recent active Work");
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
  "work",
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
      if (name === "work_list") return ok({ items: [active], next: null, actors: {} });
      if (name === "work_update") {
        created = form(args.ask, { workID: args.ticketID });
        return ok(created);
      }
      assert.equal(name, "work_get");
      const answered = { ...created, ...answer(created.fields[0].name) };
      if (invalid === "requester") answered.requesterID = "other";
      if (invalid === "approval") answered.approval = false;
      if (invalid === "work") answered.workID = "other-work";
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
      return ok({ ...active, asks: [answered] });
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
    if (name === "work_list") return ok({ items: [active], next: null, actors: {} });
    if (name === "work_update") {
      creates++;
      created = form(args.ask, { workID: args.ticketID, ...answer(args.ask.fields[0].name) });
      throw new Error("lost creation reply");
    }
    assert.equal(name, "work_get");
    if (args.askID !== undefined) return ok({ ...active, asks: [created] });
    // Issuance is recovered through the bound Work's asks.
    assert.deepEqual(args, { ticketID: "w-active" });
    if (!reads) throw new Error("held read unavailable");
    const other = form(
      { title: "Other", fields: [{ name: "x", label: "x", required: false }] },
      { formID: "x", workID: "w-active" },
    );
    return ok({ ...active, asks: [other, created] });
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
      if (name === "work_list") return ok({ items: [active], next: null, actors: {} });
      if (name === "work_update") {
        creates++;
        created = form(args.ask, { workID: args.ticketID });
        throw new Error("unknown create outcome");
      }
      assert.equal(name, "work_get");
      assert.deepEqual(args, { ticketID: "w-active" });
      return ok({
        ...active,
        asks: Array.from({ length: matches }, (_, n) => ({ ...created, formID: `form-${n}` })),
      });
    };
    f.request();
    await settle();
    f.request();
    await settle();
    assert.equal(creates, 1);
    assert.equal(f.answers.length, 0);
    assert.match(f.actor.lastError ?? "", matches ? /Multiple asks/ : /issuance is uncertain/);
  });

for (const level of [undefined, "team", "report"] as const)
  test(`each item is framed with what to do at ${level ?? "no"} level, naming work_answer only where presented`, async (t) => {
    const f = fixture(t);
    if (level) f.bootstrap.config.level = level;
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
    const which = form(
      { title: "Which?", fields: [{ name: "choice", label: "Choose", required: true }] },
      { formID: "raised", approval: false, workID: "w-active" },
    );
    (f.actor.hub as any).call = async (name: string, args: any) => {
      assert.equal(name, "work_get");
      if (args.askID === "raised") return ok({ ...active, asks: [which] });
      // The executor's own approval ask, on the Actor's Work, answered and raised.
      if (args.askID === "own")
        return ok({
          ...active,
          asks: [form({ title: "Grant?", fields }, { formID: "own", workID: "w-active" })],
        });
      // Work the Actor requested of its report, and Work its manager gave it.
      if (args.ticketID === "w2")
        return ok({
          ...active,
          ticketID: "w2",
          ownerID: "report",
          status: "submitted",
          submission: { submissionID: "s2", ownerID: "report", result: "Done", evidence: [], at },
        });
      // A submission the manager's close of its requester re-routed to the Actor.
      if (args.ticketID === "w6")
        return ok({
          ...active,
          ticketID: "w6",
          ownerID: "report",
          status: "submitted",
          submission: { submissionID: "s6", ownerID: "report", result: "Done", evidence: [], at },
        });
      const given = { ...active, requesterID: "manager" };
      if (args.ticketID === "w3") return ok({ ...given, ticketID: "w3", status: "cancelled" });
      assert.deepEqual(args, { ticketID: "w-active" });
      return ok(given);
    };
    const items = attention("1", [
      { kind: "ask", recordID: "a1", from: "report", title: "Delete the bucket?" },
      { kind: "review_due", recordID: "w2", from: "report", title: "Prove the backups" },
      { kind: "review_due", recordID: "w6", title: "Restore drill" },
      { kind: "raised", recordID: "raised", title: "Which?" },
      { kind: "raised", recordID: "own", title: "Grant?" },
      { kind: "answer", recordID: "own", title: "Grant?" },
      { kind: "updated", recordID: "w-active", title: "Build" },
      { kind: "updated", recordID: "w3", title: "Old plan" },
      { kind: "assigned", recordID: "w4", title: "Index it" },
      { kind: "reviewed", recordID: "w5", title: "Migrate" },
    ]).items;
    for (const item of items) await (f.actor as any).deliver(f.actor.hub, item);
    const answering = level !== "report";
    assert.deepEqual(
      f.bootstrap.submissions.map((s) => s.text),
      [
        answering
          ? 'report routes you the ask "Delete the bucket?" (a1). Read it with work_get {askID: "a1"}, then answer it with work_answer {askID, answers, note?}, or raise it one manager up with work_answer {askID, raise: true}.'
          : 'report routes you the ask "Delete the bucket?" (a1). Read it with work_get {askID: "a1"}.',
        answering
          ? 'report submitted "Prove the backups" (w2) for your answer. Read the submission with work_get, then answer it with work_answer {askID: "s2", answers: {verdict: "accepted" or "changes_requested"}, note?}; requesting changes needs the note.'
          : 'report submitted "Prove the backups" (w2) for your answer. Read the submission with work_get.',
        answering
          ? 'manager closed the Actor the submission of "Restore drill" (w6) waited on; it now waits for your answer. Read the submission with work_get, then answer it with work_answer {askID: "s6", answers: {verdict: "accepted" or "changes_requested"}, note?}; requesting changes needs the note.'
          : 'manager closed the Actor the submission of "Restore drill" (w6) waited on; it now waits for your answer. Read the submission with work_get.',
        'manager raised your ask "Which?" (raised) to its manager; it stays open until someone answers it. Keep working on what doesn\'t depend on it.',
        'manager changed your Work "Build" (w-active). Read it with work_get before your next write to it.',
        'manager cancelled your Work "Old plan" (w3); its open asks are cancelled. Stop working on it.',
        'manager gave you Work "Index it" (w4). Read it with work_get; set it active with work_update when you start.',
        'manager answered your submission of "Migrate" (w5). Read the answer with work_get; on requested changes, address them and submit again.',
      ],
      "a native request's approval ask, answered or raised, is the request's, not input",
    );
  });

test("a binding from before asks on Work with an uncertain issuance stays pending without reading Work", async (t) => {
  const f = fixture(t);
  await f.ready();
  let creates = 0,
    recoveries = 0;
  (f.actor.hub as any).call = async (name: string, _args: any) => {
    noTeam(name);
    if (name === "work_list") return ok({ items: [active], next: null, actors: {} });
    if (name === "work_update") {
      creates++;
      throw new Error("unknown create outcome");
    }
    assert.equal(name, "work_get");
    recoveries++;
    return ok({ ...active, asks: [] });
  };
  f.request();
  await settle();
  assert.equal(recoveries, 1);
  const binding = Object.values(f.bootstrap.approvals ?? {})[0];
  assert.equal(binding.formId, null);
  delete binding.ticketId;
  f.store.save();
  f.request();
  await settle();
  assert.equal(creates, 1);
  assert.equal(recoveries, 1, "no Work names the old binding's ask");
  assert.equal(f.answers.length, 0);
  assert.match(f.actor.lastError ?? "", /issuance is uncertain/);
});

test("an ask issued before asks on Work keeps its binding and is answered through its bare Form", async (t) => {
  const f = fixture(t);
  await f.ready();
  // The binding exactly as an earlier executor kept it: an ask ID, and no Work.
  const method = "item/permissions/requestApproval";
  const params = {
    threadId: "thread",
    turnId: "turn",
    permissions: { network: { enabled: true } },
  };
  const key = hash(JSON.stringify(["thread", "session", "turn", "request"]));
  const projection = nativeForm(method, params, hash(JSON.stringify([key, method, params])));
  f.bootstrap.approvals = {
    [key]: {
      requestId: "request",
      threadId: "thread",
      turnId: "turn",
      method,
      sessionId: "session",
      inputIds: [],
      fields: projection.ask.fields,
      formId: "legacy",
      state: "waiting",
    },
  };
  const legacy = form(projection.ask, {
    formID: "legacy",
    ...answer(projection.ask.fields[0].name),
  });
  (f.actor.hub as any).call = async (name: string, args: any) => {
    assert.equal(name, "work_get", "no Work is chosen for an ask already issued");
    assert.deepEqual(args, { askID: "legacy" });
    return ok(legacy);
  };
  f.request();
  await settle();
  assert.deepEqual(f.answers, [
    { id: "request", response: { permissions: { network: { enabled: true } }, scope: "turn" } },
  ]);
  assert.equal(f.bootstrap.threadWork, undefined);
});
