import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { connectClient } from "@agentorg/cli/actor";
import { BUILTINS, Form } from "@agentorg/cli/contract";
import { startPublicHub } from "../scripts/hub.js";
import { ActorController } from "../src/actors/controller.js";
import { ActorHubSession } from "../src/hub/actor.js";
import { type Bootstrap, RuntimeStore } from "../src/runtime/index.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

for (const mode of [
  "request-resolved",
  "turn-completed",
  "controller-closed",
  "binding-replaced",
  "bootstrap-replaced",
])
  test(`held Form creation preserves correspondence after ${mode}`, {
    timeout: 10_000,
  }, async (t) => {
    const owned = mkdtempSync(join(tmpdir(), "orgactor-held-form-"));
    const hub = await startPublicHub(join(owned, "hub"), "fixture-provider", "OWNED_FIXTURE");
    const release = deferred<void>(),
      committed = deferred<string>();
    let actor: ActorController | undefined;
    let root: Awaited<ReturnType<typeof connectClient>> | undefined;
    let routed = Promise.resolve();
    t.after(async () => {
      release.resolve();
      await actor?.close();
      await routed.catch(() => {});
      await root?.close();
      await hub.close();
      rmSync(owned, { recursive: true, force: true });
    });
    root = await connectClient({
      url: hub.url,
      actorId: hub.rootId,
      credential: hub.rootCredential,
    });
    const created = await root.call("actor_create", {
      name: "held-form",
      purpose: "Owned model-free fixture",
    });
    assert.ok(created.state === "done");
    const child = BUILTINS.actor_create.response.parse(created.value);
    const store = new RuntimeStore(join(owned, "provider"));
    const bootstrap: Bootstrap = {
      actorId: child.actor.id,
      credential: child.credential,
      hubUrl: hub.url,
      threadId: "fixture-thread",
      bridgeToken: "OWNED_CAPABILITY",
      enabled: true,
      config: { approvalAuthority: "hub" },
      submissions: [],
    };
    store.data.actors[child.actor.id] = bootstrap;
    store.save();
    let nativeAnswers = 0,
      reads = 0,
      creates = 0;
    const adapter = {
      read: async () => ({
        thread: {
          id: bootstrap.threadId,
          sessionId: "fixture-session",
          turns: [{ id: "fixture-turn", status: "inProgress", items: [] }],
        },
      }),
      answer: () => {
        nativeAnswers++;
      },
    };
    actor = new ActorController(bootstrap, store, async () => adapter as any);
    const controller = actor;
    const session = new ActorHubSession(hub.url);
    actor.hub = session;
    await session.open(child.actor.id, child.credential);
    actor.adapter = adapter as any;
    await actor.reconcile();
    const route = (actor as any).routeApproval.bind(actor);
    (actor as any).routeApproval = (id: string) => {
      routed = route(id);
      return routed;
    };
    const call = session.call.bind(session);
    session.call = async (name, args, timeout) => {
      if (
        name === session.alias("hub:forms", "form_get") ||
        name === session.alias("hub:forms", "form_list")
      )
        reads++;
      const result = await call(name, args, timeout);
      if (name === session.alias("hub:forms", "form_create")) {
        creates++;
        assert.equal(!!result.isError, false);
        committed.resolve(Form.parse(result.structuredContent).formID);
        await release.promise;
      }
      return result;
    };
    const event = (method: string, params: object, id?: string) =>
      (controller as any).observe({
        method,
        params: { threadId: bootstrap.threadId, ...params },
        ...(id ? { id } : {}),
      });
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
    await routed;
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
        new RuntimeStore(join(owned, "provider")).data.actors[child.actor.id].approvals?.[key]
          .formId,
        formID,
      );
    }
    assert.equal(creates, 1);
    assert.equal(reads, 0);
    assert.equal(nativeAnswers, 0);
    assert.equal(original.answerAttempt, undefined);
    const publicResult = await root.call("form_list", { requesterID: child.actor.id });
    assert.ok(publicResult.state === "done");
    const forms = BUILTINS.form_list.response.parse(publicResult.value).items;
    assert.equal(forms.length, 1);
    assert.equal(forms[0].formID, formID);
    assert.equal(forms[0].status, "open");
    assert.deepEqual(forms[0].responses, {});
  });
