import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Work } from "@agentorg/cli/contract";
import { ActorController } from "../src/actors/controller.js";
import { Fault } from "../src/management/schema.js";
import { type Bootstrap, RuntimeStore } from "../src/runtime/index.js";
import { at, attention, form, message } from "./workspace-fixtures.js";

/** The Actor's most recently updated active Work. */
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
    config: {},
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
    tools: [],
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

test("input steers a running turn, starts the next turn when the turn refuses, and a native request holds nothing", async (t) => {
  const f = fixture(t);
  await f.ready();
  const deliver = (recordID: string) =>
    (f.actor as any).deliver(
      f.actor.hub,
      attention("1", [{ kind: "assigned", recordID }]).items[0],
    );
  await deliver("steered");
  await deliver("refused");
  // Codex asks nothing under the never policy; a request it still sends is declined at once.
  f.request();
  assert.deepEqual(f.answers, [{ id: "request", response: { permissions: {}, scope: "turn" } }]);
  await deliver("steered");
  assert.deepEqual(f.adapter.steers, [`assigned:steered:${at}`, `assigned:refused:${at}`]);
  assert.deepEqual(
    f.bootstrap.submissions.map((s) => [s.id, s.kind ?? "run", s.state]),
    [
      [`assigned:steered:${at}`, "steer", "running"],
      [`assigned:refused:${at}`, "steer", "done"],
      [`assigned:refused:${at}:next`, "run", "queued"],
    ],
  );
});

test("an answer carries its ask, and its Work when it is on one", async (t) => {
  const f = fixture(t);
  const fields = [{ name: "approach", label: "Approach", required: true }];
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
    [`answer:own:${at}`, `answer:other:${at}`],
  );
  assert.match(
    f.bootstrap.submissions[0].text,
    /^manager answered your ask "Freeze\?" \(own\): approach: freeze\. Note: Go\. Apply it\. /,
  );
  assert.equal(
    f.bootstrap.submissions[1].text,
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

test("each item is framed with what to do, naming work_answer for asks and submissions", async (t) => {
  const f = fixture(t);
  (f.actor.hub as any).call = async (name: string, args: any) => {
    assert.equal(name, "work_get");
    // Work the Actor requested of another, and Work another gave it.
    if (args.ticketID === "w2")
      return ok({
        ...active,
        ticketID: "w2",
        ownerID: "report",
        status: "submitted",
        submission: { submissionID: "s2", ownerID: "report", result: "Done", evidence: [], at },
      });
    // A submission the close of its requester passed to the Actor, the person.
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
    { kind: "updated", recordID: "w-active", title: "Build" },
    { kind: "updated", recordID: "w3", title: "Old plan" },
    { kind: "assigned", recordID: "w4", title: "Index it" },
    { kind: "reviewed", recordID: "w5", title: "Migrate" },
  ]).items;
  for (const item of items) await (f.actor as any).deliver(f.actor.hub, item);
  assert.deepEqual(
    f.bootstrap.submissions.map((s) => s.text),
    [
      'report routes you the ask "Delete the bucket?" (a1). Read it with work_get {askID: "a1"}, then answer it with work_answer {askID, answers, note?}.',
      'report submitted "Prove the backups" (w2) for your answer. Read the submission with work_get, then answer it with work_answer {askID: "s2", answers: {verdict: "accepted" or "changes_requested"}, note?}; requesting changes needs the note.',
      'manager closed the Actor the submission of "Restore drill" (w6) waited on; it now waits for your answer. Read the submission with work_get, then answer it with work_answer {askID: "s6", answers: {verdict: "accepted" or "changes_requested"}, note?}; requesting changes needs the note.',
      'manager changed your Work "Build" (w-active). Read it with work_get before your next write to it.',
      'manager cancelled your Work "Old plan" (w3); its open asks are cancelled. Stop working on it.',
      'manager gave you Work "Index it" (w4). Read it with work_get; set it active with work_update when you start.',
      'manager answered your submission of "Migrate" (w5). Read the answer with work_get; on requested changes, address them and submit again.',
    ],
  );
});
