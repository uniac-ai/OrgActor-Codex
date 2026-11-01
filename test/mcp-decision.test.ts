import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Form } from "@agentorg/cli/contract";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv-provider.js";
import { deferred, nativeFormFixture } from "./native-form-fixture.js";

const params = {
  threadId: "fixture-thread",
  turnId: "fixture-turn",
  serverName: "Fixture",
  mode: "form",
  message: "Choose your settings.",
  requestedSchema: {
    type: "object",
    properties: {
      note: { type: "string", title: "Note" },
      enabled: { type: "boolean", title: "Enable" },
      plan: { type: "string", title: "Plan", oneOf: [{ const: "b", title: "Beta" }] },
    },
  },
};
const validator = new AjvJsonSchemaValidator();
const nativeRequest = validator.getValidator(
  JSON.parse(
    readFileSync("test/fixtures/native-input/McpServerElicitationRequestParams.json", "utf8"),
  ),
);
const nativeResponse = validator.getValidator(
  JSON.parse(
    readFileSync("test/fixtures/native-input/McpServerElicitationRequestResponse.json", "utf8"),
  ),
);

for (const choice of ["Accept", "Decline", "Cancel"])
  for (const supplied of [false, true])
    test(`MCP ${choice} with ${supplied ? "supplied" : "omitted"} optional data`, {
      timeout: 10_000,
    }, async (t) => {
      assert.equal(nativeRequest(params).valid, true);
      const release = deferred<void>(),
        requested = deferred<string>();
      t.after(() => release.resolve());
      const f = await nativeFormFixture(t),
        call = f.session.call.bind(f.session);
      f.session.call = async (name, args, timeout) => {
        if (name === f.session.alias("hub:forms", "form_get")) {
          requested.resolve(String(args.formID));
          await release.promise;
        }
        return call(name, args, timeout);
      };
      f.event("mcpServer/elicitation/request", params, "fixture-request");
      const formID = await requested.promise;
      const read = await f.root.call("form_get", { formID });
      assert.ok(read.state === "done");
      const form = Form.parse(read.value),
        decision = form.fields[0],
        data = form.fields.slice(1);
      assert.equal(form.approval, true);
      assert.equal(form.title, "Choose your settings.");
      assert.deepEqual(
        decision.options?.map((option) => option.value),
        ["Accept", "Decline", "Cancel"],
      );
      assert.equal(decision.required, true);
      assert.equal(data.length, 3);
      assert.ok(data.every((field) => !field.required));
      const answers: Record<string, string> = { [decision.name]: choice };
      if (supplied) {
        answers[data[0].name] = "Ordinary text";
        answers[data[1].name] = "No";
        answers[data[2].name] = "Beta";
      }
      const responded = await f.root.call("form_respond", {
        formID,
        expectedRevision: form.revision,
        answers,
      });
      assert.ok(responded.state === "done");
      release.resolve();
      await f.routed();
      const response = {
        action: choice.toLowerCase(),
        content:
          choice === "Accept"
            ? supplied
              ? { note: "Ordinary text", enabled: false, plan: "b" }
              : {}
            : null,
        _meta: null,
      };
      assert.equal(nativeResponse(response).valid, true);
      assert.deepEqual(f.answers, [{ id: "fixture-request", response }]);
      const binding = Object.values(f.bootstrap.approvals ?? {})[0];
      assert.deepEqual(binding.answerAttempt?.response, response);
      const resolved = await f.root.call("form_get", { formID });
      assert.ok(resolved.state === "done");
      assert.equal(Form.parse(resolved.value).status, "resolved");
    });

test("public ask validation keeps invalid MCP choices open for the manager", {
  timeout: 10_000,
}, async (t) => {
  const release = deferred<void>(),
    requested = deferred<string>();
  t.after(() => release.resolve());
  const f = await nativeFormFixture(t),
    call = f.session.call.bind(f.session);
  f.session.call = async (name, args, timeout) => {
    if (name === f.session.alias("hub:forms", "form_get")) {
      requested.resolve(String(args.formID));
      await release.promise;
    }
    return call(name, args, timeout);
  };
  f.event("mcpServer/elicitation/request", params, "fixture-request");
  const formID = await requested.promise;
  const read = await f.root.call("form_get", { formID });
  assert.ok(read.state === "done");
  const form = Form.parse(read.value);
  for (const answers of [
    {},
    { [form.fields[0].name]: "Accept", [form.fields[2].name]: "not a boolean" },
    { [form.fields[0].name]: "Accept", [form.fields[3].name]: "" },
  ]) {
    const rejected = await f.root.call("form_respond", {
      formID,
      expectedRevision: form.revision,
      answers,
    });
    assert.notEqual(rejected.state, "done");
    const unchanged = await f.root.call("form_get", { formID });
    assert.ok(unchanged.state === "done");
    assert.equal(Form.parse(unchanged.value).status, "open");
    assert.equal(Object.hasOwn(Form.parse(unchanged.value).responses, f.hub.rootId), false);
    assert.equal(f.answers.length, 0);
    assert.equal(
      Object.values(f.bootstrap.approvals ?? {}).some((b) => b.answerAttempt),
      false,
    );
  }
  const accepted = await f.root.call("form_respond", {
    formID,
    expectedRevision: form.revision,
    answers: { [form.fields[0].name]: "Accept" },
  });
  assert.ok(accepted.state === "done");
  release.resolve();
  await f.routed();
  assert.deepEqual(f.answers, [
    { id: "fixture-request", response: { action: "accept", content: {}, _meta: null } },
  ]);
});

test("requester ask cancellation is not an MCP cancel response", {
  timeout: 10_000,
}, async (t) => {
  const release = deferred<void>(),
    requested = deferred<string>();
  t.after(() => release.resolve());
  const f = await nativeFormFixture(t),
    call = f.session.call.bind(f.session);
  f.session.call = async (name, args, timeout) => {
    if (name === f.session.alias("hub:forms", "form_get")) {
      requested.resolve(String(args.formID));
      await release.promise;
    }
    return call(name, args, timeout);
  };
  f.event("mcpServer/elicitation/request", params, "fixture-request");
  const formID = await requested.promise;
  const read = await f.root.call("form_get", { formID });
  assert.ok(read.state === "done");
  const form = Form.parse(read.value);
  const closed = await call(f.session.alias("hub:forms", "form_close"), {
    formID,
    expectedRevision: form.revision,
    status: "cancelled",
    resolution: "No input response",
  });
  assert.equal(!!closed.isError, false);
  release.resolve();
  await f.routed();
  assert.equal(f.answers.length, 0);
  assert.equal(
    Object.values(f.bootstrap.approvals ?? {}).some((b) => b.answerAttempt),
    false,
  );
});
