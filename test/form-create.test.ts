import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { BUILTINS, Form } from "@agentorg/cli/contract";
import { RuntimeStore } from "../src/runtime/index.js";
import { deferred, nativeFormFixture } from "./native-form-fixture.js";

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
    const release = deferred<void>(),
      committed = deferred<string>();
    t.after(() => release.resolve());
    const { actor, root, child, store, bootstrap, session, answers, event, routed } =
      await nativeFormFixture(t);
    let reads = 0,
      creates = 0;
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
    const publicResult = await root.call("form_list", { requesterID: child.actor.id });
    assert.ok(publicResult.state === "done");
    const forms = BUILTINS.form_list.response.parse(publicResult.value).items;
    assert.equal(forms.length, 1);
    assert.equal(forms[0].formID, formID);
    assert.equal(forms[0].status, "open");
    assert.deepEqual(forms[0].responses, {});
  });
