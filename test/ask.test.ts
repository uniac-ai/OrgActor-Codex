import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { connectClient } from "@agentorg/cli/actor";
import { Form, Work } from "@agentorg/cli/contract";
import { RuntimeStore } from "../src/runtime/index.js";
import { deferred, nativeFormFixture, readAsk } from "./native-form-fixture.js";

for (const mode of [
  "request-resolved",
  "turn-completed",
  "controller-closed",
  "binding-replaced",
  "bootstrap-replaced",
])
  test(`a held ask's creation preserves correspondence after ${mode}`, {
    timeout: 10_000,
  }, async (t) => {
    const release = deferred<void>(),
      committed = deferred<string>();
    t.after(() => release.resolve());
    const { actor, root, child, store, bootstrap, session, answers, event, routed } =
      await nativeFormFixture(t);
    let reads = 0,
      creates = 0;
    const call = session.call.bind(session);
    session.call = async (name, args, timeout) => {
      if (name === session.alias("hub:work", "work_get")) reads++;
      const result = await call(name, args, timeout);
      if (name === session.alias("hub:work", "work_update") && args.ask !== undefined) {
        creates++;
        assert.equal(!!result.isError, false);
        committed.resolve(Form.parse(result.structuredContent).formID);
        await release.promise;
      }
      return result;
    };
    event(
      "item/permissions/requestApproval",
      { turnId: "fixture-turn", permissions: { network: { enabled: true } } },
      "fixture-request",
    );
    const formID = await committed.promise;
    assert.ok(bootstrap.approvals);
    const [key, original] = Object.entries(bootstrap.approvals)[0];
    assert.equal(original.formId, null);
    if (mode === "request-resolved")
      event("serverRequest/resolved", { requestId: "fixture-request" });
    if (mode === "turn-completed")
      event("turn/completed", { turn: { id: "fixture-turn", status: "completed", items: [] } });
    if (mode === "controller-closed") await actor.close();
    if (mode === "binding-replaced")
      bootstrap.approvals[key] = { ...original, requestId: "replacement" };
    if (mode === "bootstrap-replaced")
      store.data.actors[child.actor.id] = {
        ...bootstrap,
        threadId: "replacement-thread",
        approvals: { ...bootstrap.approvals },
      };
    store.save();
    const originalBeforeReply = structuredClone(original);
    const diskBeforeReply = JSON.parse(readFileSync(store.file, "utf8"));
    release.resolve();
    await routed();
    const disk = JSON.parse(readFileSync(store.file, "utf8"));
    const binding = disk.actors[child.actor.id].approvals[key];
    if (mode.endsWith("replaced")) {
      assert.deepEqual(original, originalBeforeReply);
      assert.deepEqual(disk, diskBeforeReply);
    } else {
      assert.equal(
        binding.formId,
        formID,
        "The returned canonical ID belongs to its original retained binding after native scope ends",
      );
      assert.deepEqual(binding, { ...originalBeforeReply, formId: formID });
      assert.equal(
        new RuntimeStore(store.root).data.actors[child.actor.id].approvals?.[key].formId,
        formID,
      );
    }
    assert.equal(creates, 1);
    assert.equal(reads, 0);
    assert.equal(answers.length, 0);
    assert.equal(original.answerAttempt, undefined);
    // The ask is on the thread's Work, opened once and active.
    const ticketID = bootstrap.threadWork?.ticketId;
    assert.ok(ticketID);
    assert.equal(original.ticketId, ticketID);
    const publicResult = await root.call("work_get", { ticketID });
    assert.ok(publicResult.state === "done");
    const work = Work.parse(publicResult.value);
    assert.equal(work.title, "Codex thread fixture-");
    assert.equal(work.status, "active");
    assert.equal(work.ownerID, child.actor.id);
    assert.equal(work.asks?.length, 1);
    assert.equal(work.asks?.[0].formID, formID);
    assert.equal(work.asks?.[0].status, "open");
    assert.deepEqual(work.asks?.[0].responses, {});
  });

const approval = { turnId: "fixture-turn", permissions: { network: { enabled: true } } };
/** The Actor's own Hub client, and a way to make Work it owns. */
async function own(t: any, f: Awaited<ReturnType<typeof nativeFormFixture>>) {
  const self = await connectClient({
    url: f.hub.url,
    actorId: f.child.actor.id,
    credential: f.child.credential,
  });
  t.after(() => self.close());
  const make = async (title: string, status?: string) => {
    const created = await self.call("work_create", { title });
    assert.ok(created.state === "done");
    const work = Work.parse(created.value);
    if (status)
      assert.equal(
        (await self.call("work_update", { ticketID: work.ticketID, status })).state,
        "done",
      );
    return work.ticketID;
  };
  return { self, make };
}
/** Each ask the controller starts polling, by askID, in the order it starts. */
function polls(f: Awaited<ReturnType<typeof nativeFormFixture>>) {
  const seen = new Set<string>();
  const queued: string[] = [];
  let waiting: ((askID: string) => void) | undefined;
  const call = f.session.call.bind(f.session);
  f.session.call = async (name, args, timeout) => {
    const askID = String(args.askID);
    if (
      name === f.session.alias("hub:work", "work_get") &&
      args.askID !== undefined &&
      !seen.has(askID)
    ) {
      seen.add(askID);
      if (waiting) waiting(askID);
      else queued.push(askID);
      waiting = undefined;
    }
    return call(name, args, timeout);
  };
  return () => {
    const askID = queued.shift();
    return askID === undefined
      ? new Promise<string>((resolve) => {
          waiting = resolve;
        })
      : Promise.resolve(askID);
  };
}

test("a native prompt is asked on the Actor's most recently updated active Work, opening none", {
  timeout: 10_000,
}, async (t) => {
  const f = await nativeFormFixture(t);
  const { self, make } = await own(t, f);
  const older = await make("Older", "active");
  await make("Newer", "active");
  assert.equal(
    (await self.call("work_update", { ticketID: older, progress: "Still going." })).state,
    "done",
  );
  const next = polls(f);
  f.event("item/permissions/requestApproval", approval, "fixture-request");
  const ask = await readAsk(f.root, await next());
  assert.equal(ask.workID, older);
  assert.equal(f.bootstrap.threadWork, undefined);
});

test("with no active Work, the thread's Work opens once, and is reused and set active while open", {
  timeout: 10_000,
}, async (t) => {
  const f = await nativeFormFixture(t);
  let creates = 0,
    activations = 0;
  const call = f.session.call.bind(f.session);
  f.session.call = async (name, args, timeout) => {
    if (name === f.session.alias("hub:work", "work_create")) creates++;
    // The first write that sets it active is lost, so the Work stays open until the next one.
    if (name === f.session.alias("hub:work", "work_update") && args.status === "active")
      if (activations++ === 0)
        return { isError: true, content: [{ type: "text", text: "unavailable: lost" }] };
    return call(name, args, timeout);
  };
  const next = polls(f);
  f.event("item/permissions/requestApproval", approval, "first-request");
  const first = await readAsk(f.root, await next());
  const opened = await f.root.call("work_get", { ticketID: first.workID });
  assert.ok(opened.state === "done");
  assert.equal(Work.parse(opened.value).title, "Codex thread fixture-");
  assert.equal(Work.parse(opened.value).status, "open");
  f.event("item/permissions/requestApproval", approval, "second-request");
  const second = await readAsk(f.root, await next());
  assert.notEqual(first.formID, second.formID);
  assert.equal(first.workID, f.bootstrap.threadWork?.ticketId);
  assert.equal(second.workID, first.workID, "the open thread Work is reused");
  assert.equal(creates, 1);
  assert.equal(activations, 2);
  const reused = await f.root.call("work_get", { ticketID: first.workID });
  assert.ok(reused.state === "done");
  assert.equal(Work.parse(reused.value).status, "active", "reuse sets it active");
});

const creations = {
  "lost after the Hub opened it": "recovered by its exact title",
  refused: "retried by the next prompt",
  "lost before it reached the Hub": "retried by the next prompt",
  "lost with two Work of its title": "left uncertain",
} as const;
for (const [lost, outcome] of Object.entries(creations))
  test(`a thread Work creation ${lost} is ${outcome}`, { timeout: 10_000 }, async (t) => {
    const f = await nativeFormFixture(t);
    const { make } = await own(t, f);
    if (outcome === "left uncertain")
      for (let n = 0; n < 2; n++) await make("Codex thread fixture-");
    let creates = 0;
    const call = f.session.call.bind(f.session);
    f.session.call = async (name, args, timeout) => {
      if (name === f.session.alias("hub:work", "work_create") && creates++ === 0) {
        if (lost === "refused")
          return { isError: true, content: [{ type: "text", text: "unavailable: refused" }] };
        if (lost === "lost after the Hub opened it") await call(name, args, timeout);
        throw new Error("lost creation reply");
      }
      return call(name, args, timeout);
    };
    const next = polls(f);
    f.event("item/permissions/requestApproval", approval, "first-request");
    if (outcome === "recovered by its exact title") {
      const ask = await readAsk(f.root, await next());
      assert.equal(ask.workID, f.bootstrap.threadWork?.ticketId);
      const work = await f.root.call("work_get", { ticketID: ask.workID });
      assert.ok(work.state === "done");
      assert.equal(Work.parse(work.value).title, "Codex thread fixture-");
      assert.equal(Work.parse(work.value).status, "active", "recovered Work is set active");
      assert.equal(creates, 1);
      return;
    }
    await f.routed();
    assert.match(f.actor.lastError ?? "", /thread's Work is uncertain/);
    assert.equal(Object.values(f.bootstrap.approvals ?? {})[0].formId, undefined, "no ask issued");
    assert.equal(f.actor.snapshot().requests.length, 1, "the request stays with its owner");
    f.event("item/permissions/requestApproval", approval, "second-request");
    if (outcome === "left uncertain") {
      await f.routed();
      assert.match(f.actor.lastError ?? "", /thread's Work is uncertain/);
      assert.equal(creates, 1, "no duplicate is opened");
      return;
    }
    // Nothing was opened, so a later prompt opens the thread's Work.
    const ask = await readAsk(f.root, await next());
    assert.equal(ask.workID, f.bootstrap.threadWork?.ticketId);
    assert.equal(creates, 2);
  });

test("an ask whose creation reply is lost is recovered from its Work's asks, and its answer applies", {
  timeout: 10_000,
}, async (t) => {
  const f = await nativeFormFixture(t);
  const call = f.session.call.bind(f.session);
  f.session.call = async (name, args, timeout) => {
    const result = await call(name, args, timeout);
    if (name === f.session.alias("hub:work", "work_update") && args.ask !== undefined)
      throw new Error("lost creation reply");
    return result;
  };
  const next = polls(f);
  f.event("item/permissions/requestApproval", approval, "fixture-request");
  const askID = await next();
  const binding = Object.values(f.bootstrap.approvals ?? {})[0];
  assert.equal(binding.formId, askID);
  assert.equal(binding.ticketId, f.bootstrap.threadWork?.ticketId);
  const ask = await readAsk(f.root, askID);
  const answered = await f.root.call("work_answer", {
    askID,
    answers: { [ask.fields[0].name]: "Approve" },
  });
  assert.ok(answered.state === "done");
  await f.routed();
  assert.deepEqual(f.answers, [
    { id: "fixture-request", response: { permissions: approval.permissions, scope: "turn" } },
  ]);
});

test("cancelling the Work cancels its ask, which answers nothing", {
  timeout: 10_000,
}, async (t) => {
  const f = await nativeFormFixture(t);
  const { self } = await own(t, f);
  const next = polls(f);
  f.event("item/permissions/requestApproval", approval, "fixture-request");
  const askID = await next();
  const ticketID = f.bootstrap.threadWork?.ticketId;
  assert.ok(ticketID);
  const work = await self.call("work_get", { ticketID });
  assert.ok(work.state === "done");
  const cancelled = await self.call("work_update", {
    ticketID,
    status: "cancelled",
    expectedRevision: Work.parse(work.value).revision,
  });
  assert.ok(cancelled.state === "done");
  await f.routed();
  const ask = await readAsk(f.root, askID);
  assert.equal(ask.status, "cancelled");
  assert.equal(ask.resolution?.reason, "cancelled");
  assert.equal(f.answers.length, 0);
  assert.equal(f.actor.snapshot().requests.length, 1, "the request stays with its owner");
});

test("two prompts at once with no active Work open the thread's Work once and both ask on it", {
  timeout: 10_000,
}, async (t) => {
  const f = await nativeFormFixture(t);
  let creates = 0;
  const call = f.session.call.bind(f.session);
  f.session.call = async (name, args, timeout) => {
    // The Hub sees the creation late, after the second prompt has looked for the thread's Work.
    if (name === f.session.alias("hub:work", "work_create")) {
      creates++;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return call(name, args, timeout);
  };
  const next = polls(f);
  f.event("item/permissions/requestApproval", approval, "first-request");
  f.event("item/permissions/requestApproval", approval, "second-request");
  const asks = [await readAsk(f.root, await next()), await readAsk(f.root, await next())];
  assert.equal(creates, 1);
  assert.notEqual(asks[0].formID, asks[1].formID);
  assert.deepEqual(
    asks.map((ask) => ask.workID),
    [f.bootstrap.threadWork?.ticketId, f.bootstrap.threadWork?.ticketId],
  );
});

test("a thread Work handed to another Actor is no longer the thread's, so the next prompt opens one", {
  timeout: 10_000,
}, async (t) => {
  const f = await nativeFormFixture(t);
  const { self } = await own(t, f);
  const next = polls(f);
  f.event("item/permissions/requestApproval", approval, "first-request");
  const first = await readAsk(f.root, await next());
  assert.ok(first.workID);
  const work = await self.call("work_get", { ticketID: first.workID });
  assert.ok(work.state === "done");
  const handed = await self.call("work_update", {
    ticketID: first.workID,
    ownerID: f.hub.rootId,
    expectedRevision: Work.parse(work.value).revision,
  });
  assert.ok(handed.state === "done");
  f.event("item/permissions/requestApproval", approval, "second-request");
  const second = await readAsk(f.root, await next());
  assert.notEqual(second.workID, first.workID);
  assert.equal(second.workID, f.bootstrap.threadWork?.ticketId);
});

test("a finished or unreadable thread Work is not reused, so the next prompt opens one", {
  timeout: 10_000,
}, async (t) => {
  const f = await nativeFormFixture(t);
  const { self } = await own(t, f);
  let hidden: string | undefined;
  const call = f.session.call.bind(f.session);
  f.session.call = async (name, args, timeout) => {
    if (name === f.session.alias("hub:work", "work_get") && args.ticketID === hidden)
      return { isError: true, content: [{ type: "text", text: "not_found: no such Work" }] };
    return call(name, args, timeout);
  };
  const next = polls(f);
  f.event("item/permissions/requestApproval", approval, "first-request");
  const first = await readAsk(f.root, await next());
  assert.ok(first.workID);
  // Submitting the Actor's own Work completes it, and cancels its open asks.
  const submitted = await self.call("work_submit", { ticketID: first.workID, result: "Done." });
  assert.ok(submitted.state === "done");
  f.event("item/permissions/requestApproval", approval, "second-request");
  const second = await readAsk(f.root, await next());
  assert.notEqual(second.workID, first.workID);
  assert.equal(second.workID, f.bootstrap.threadWork?.ticketId);
  assert.ok(second.workID);
  const work = await self.call("work_get", { ticketID: second.workID });
  assert.ok(work.state === "done");
  const cancelled = await self.call("work_update", {
    ticketID: second.workID,
    status: "cancelled",
    expectedRevision: Work.parse(work.value).revision,
  });
  assert.ok(cancelled.state === "done");
  hidden = second.workID;
  f.event("item/permissions/requestApproval", approval, "third-request");
  const third = await readAsk(f.root, await next());
  assert.ok(![first.workID, second.workID].includes(third.workID ?? ""));
});

test("an ask the Hub refuses created nothing, so the prompt chooses its Work and asks again", {
  timeout: 10_000,
}, async (t) => {
  const f = await nativeFormFixture(t);
  const { self, make } = await own(t, f);
  const chosen = await make("Chosen", "active");
  let asks = 0;
  const call = f.session.call.bind(f.session);
  f.session.call = async (name, args, timeout) => {
    // The chosen Work is submitted, so frozen, between its choice and the ask on it.
    if (
      name === f.session.alias("hub:work", "work_update") &&
      args.ask !== undefined &&
      asks++ === 0
    )
      assert.ok(
        (await self.call("work_submit", { ticketID: chosen, result: "Done." })).state === "done",
      );
    return call(name, args, timeout);
  };
  const next = polls(f);
  f.event("item/permissions/requestApproval", approval, "fixture-request");
  const ask = await readAsk(f.root, await next());
  assert.equal(asks, 2);
  assert.notEqual(ask.workID, chosen);
  assert.equal(ask.workID, f.bootstrap.threadWork?.ticketId, "asked on the thread's Work instead");
  const binding = Object.values(f.bootstrap.approvals ?? {})[0];
  assert.equal(binding.formId, ask.formID);
  assert.equal(binding.ticketId, ask.workID);
});

test("an ask refused twice waits unasked, and the next routing asks it", {
  timeout: 10_000,
}, async (t) => {
  const f = await nativeFormFixture(t);
  let refusals = 2;
  const call = f.session.call.bind(f.session);
  f.session.call = async (name, args, timeout) => {
    if (
      name === f.session.alias("hub:work", "work_update") &&
      args.ask !== undefined &&
      refusals > 0
    ) {
      refusals--;
      return { isError: true, content: [{ type: "text", text: "conflict: refused" }] };
    }
    return call(name, args, timeout);
  };
  const next = polls(f);
  f.event("item/permissions/requestApproval", approval, "first-request");
  await f.routed();
  assert.equal(refusals, 0);
  assert.match(f.actor.lastError ?? "", /Hub refused the approval ask/);
  const [binding] = Object.values(f.bootstrap.approvals ?? {});
  assert.equal(Object.hasOwn(binding, "formId"), false, "free to be asked again");
  assert.equal(binding.ticketId, undefined);
  // Once its routing ends, another native event routes the requests again, and both are asked.
  await new Promise(setImmediate);
  f.event("item/permissions/requestApproval", approval, "second-request");
  const asked = [await next(), await next()];
  assert.equal(new Set(asked).size, 2);
  assert.ok(Object.values(f.bootstrap.approvals ?? {}).every((each) => each.formId));
});
