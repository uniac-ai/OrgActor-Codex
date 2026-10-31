import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { BUILTINS, Form } from "@agentorg/cli/contract";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv-provider.js";
import { deferred, nativeFormFixture } from "./native-form-fixture.js";

const validate = (name: string) =>
  new AjvJsonSchemaValidator().getValidator(
    JSON.parse(readFileSync(`test/fixtures/native-input/${name}.json`, "utf8")),
  );
const toolRequest = validate("ToolRequestUserInputParams"),
  toolResponse = validate("ToolRequestUserInputResponse");
const mcpRequest = validate("McpServerElicitationRequestParams"),
  mcpResponse = validate("McpServerElicitationRequestResponse");
const question = (extra: object = {}) => ({
  id: "native-question-choice",
  header: "Plan",
  question: "Choose a plan.",
  isOther: false,
  isSecret: false,
  options: [
    { label: "Small", description: "For a small team" },
    { label: "Large", description: "For a large team" },
  ],
  ...extra,
});
const tool = (questions: object[]) => ({
  threadId: "fixture-thread",
  turnId: "fixture-turn",
  itemId: "fixture-item",
  isBlocking: true,
  questions,
});
const mcp = (requestedSchema: object, mode = "form") => ({
  threadId: "fixture-thread",
  turnId: "fixture-turn",
  serverName: "Fixture",
  mode,
  message: "Choose your settings.",
  requestedSchema,
});
const result = (content: object) => ({ action: "accept", content, _meta: null });
const otherOptions = [
  { label: "Other", description: "The named choice" },
  { label: "Other (custom)", description: "Another named choice" },
];

const cases: {
  name: string;
  params: any;
  method: string;
  fields: number;
  answer: (form: Form) => Record<string, string>;
  expected: object;
}[] = [
  {
    name: "ordinary choice and free text, including no-options Other",
    method: "item/tool/requestUserInput",
    params: tool([
      question(),
      question({
        id: "native-question-text",
        header: "Reason",
        question: "Why this plan?",
        options: null,
        isOther: true,
      }),
    ]),
    fields: 2,
    answer: (f) => ({ [f.fields[0].name]: "Small", [f.fields[1].name]: "Fits our team" }),
    expected: {
      answers: {
        "native-question-choice": { answers: ["Small"] },
        "native-question-text": { answers: ["Fits our team"] },
      },
    },
  },
  {
    name: "Other answer disambiguated from native option labels",
    method: "item/tool/requestUserInput",
    params: tool([question({ isOther: true, options: otherOptions })]),
    fields: 2,
    answer: (f) => {
      assert.equal(f.fields[0].options?.length, 3);
      const custom = f.fields[0].options?.at(-1);
      assert.ok(custom && !otherOptions.some((o) => o.label === custom));
      return { [f.fields[0].name]: custom, [f.fields[1].name]: "A different plan" };
    },
    expected: { answers: { "native-question-choice": { answers: ["A different plan"] } } },
  },
  {
    name: "native option named Other keeps its own meaning",
    method: "item/tool/requestUserInput",
    params: tool([question({ isOther: true, options: otherOptions })]),
    fields: 2,
    answer: (f) => ({ [f.fields[0].name]: "Other", [f.fields[1].name]: "" }),
    expected: { answers: { "native-question-choice": { answers: ["Other"] } } },
  },
  {
    name: "present empty question response maps to the native empty answer array",
    method: "item/tool/requestUserInput",
    params: tool([question({ options: null })]),
    fields: 1,
    answer: () => ({}),
    expected: { answers: { "native-question-choice": { answers: [] } } },
  },
  {
    name: "flat MCP strings, false boolean, integer, number and titled enum",
    method: "mcpServer/elicitation/request",
    params: mcp({
      type: "object",
      properties: {
        name: {
          type: "string",
          title: "Name",
          description: null,
          default: null,
          minLength: 1,
          maxLength: 30,
        },
        enabled: { type: "boolean", title: "Enable", default: true },
        count: { type: "integer", title: "Count", minimum: 1, maximum: 3 },
        ratio: { type: "number", title: "Ratio", minimum: 0, maximum: 1 },
        plan: {
          type: "string",
          title: "Plan",
          oneOf: [
            { const: "a", title: "Alpha" },
            { const: "b", title: "Beta" },
          ],
        },
      },
      required: ["name", "enabled", "count", "ratio", "plan"],
    }),
    fields: 5,
    answer: (f) =>
      Object.fromEntries(
        f.fields.map((field, n) => [field.name, ["Ada", "No", "2", "0.25", "Beta"][n]]),
      ),
    expected: result({ name: "Ada", enabled: false, count: 2, ratio: 0.25, plan: "b" }),
  },
  {
    name: "present empty MCP response remains answered without filling defaults",
    method: "mcpServer/elicitation/request",
    params: mcp({
      type: "object",
      properties: { note: { type: "string", title: "Note", default: "Never inserted" } },
    }),
    fields: 1,
    answer: () => ({}),
    expected: result({}),
  },
  {
    name: "blank optional numeric and constrained text inputs are absent, plain empty text is preserved",
    method: "mcpServer/elicitation/request",
    params: mcp({
      type: "object",
      properties: {
        count: { type: "integer", minimum: 0 },
        ratio: { type: "number" },
        email: { type: "string", format: "email" },
        short: { type: "string", minLength: 1 },
        note: { type: "string" },
      },
    }),
    fields: 5,
    answer: (f) =>
      Object.fromEntries(f.fields.map((field, n) => [field.name, n === 1 ? "  " : ""])),
    expected: result({ note: "" }),
  },
  {
    name: "required formatted text is required and never promises empty input",
    method: "mcpServer/elicitation/request",
    params: mcp({
      type: "object",
      properties: { email: { type: "string", title: "Email", format: "email" } },
      required: ["email"],
    }),
    fields: 1,
    answer: (f) => {
      assert.equal(f.fields[0].required, true);
      assert.doesNotMatch(f.fields[0].label, /empty answer is allowed/);
      return { [f.fields[0].name]: "ada@example.invalid" };
    },
    expected: result({ email: "ada@example.invalid" }),
  },
  {
    name: "required MCP string can explicitly be empty",
    method: "mcpServer/elicitation/request",
    params: mcp({
      type: "object",
      properties: { note: { type: "string", title: "Note" } },
      required: ["note"],
    }),
    fields: 1,
    answer: (f) => ({ [f.fields[0].name]: "" }),
    expected: result({ note: "" }),
  },
  {
    name: "flat native alias and legacy display titles",
    method: "mcpServer/elicitation/request",
    params: mcp(
      {
        type: "object",
        properties: { region: { type: "string", enum: ["eu", "us"], enumNames: ["Europe", "US"] } },
        required: ["region"],
      },
      "openai/form",
    ),
    fields: 1,
    answer: (f) => ({ [f.fields[0].name]: "Europe" }),
    expected: result({ region: "eu" }),
  },
];

for (const c of cases)
  test(`ordinary Form response produces typed native input: ${c.name}`, {
    timeout: 10_000,
  }, async (t) => {
    assert.equal(
      (c.method === "item/tool/requestUserInput" ? toolRequest : mcpRequest)(c.params).valid,
      true,
    );
    const release = deferred<void>(),
      requested = deferred<string>();
    t.after(() => release.resolve());
    const f = await nativeFormFixture(t);
    const call = f.session.call.bind(f.session);
    f.session.call = async (name, args, timeout) => {
      if (name === f.session.alias("hub:forms", "form_get")) {
        requested.resolve(String(args.formID));
        await release.promise;
      }
      return call(name, args, timeout);
    };
    f.event(c.method, c.params, "fixture-request");
    const formID = await requested.promise;
    const read = await f.root.call("form_get", { formID });
    assert.ok(read.state === "done");
    const form = Form.parse(read.value);
    assert.equal(form.workID, undefined);
    assert.equal(form.fields.length, c.fields);
    for (const field of form.fields)
      assert.doesNotMatch(field.label, /native-question-|JSON|threadId|turnId/);
    const answers = c.answer(form);
    const answered = await f.root.call("form_respond", {
      formID,
      expectedRevision: form.revision,
      answers,
    });
    assert.ok(answered.state === "done");
    assert.ok(Object.hasOwn(Form.parse(answered.value).responses, f.hub.rootId));
    release.resolve();
    await f.routed();
    assert.deepEqual(f.answers, [{ id: "fixture-request", response: c.expected }]);
    assert.equal(
      (c.method === "item/tool/requestUserInput" ? toolResponse : mcpResponse)(
        f.answers[0].response,
      ).valid,
      true,
    );
    const stillOpen = await f.root.call("form_get", { formID });
    assert.ok(stillOpen.state === "done");
    assert.equal(Form.parse(stillOpen.value).status, "open");
    const awaiting = await f.root.call("form_list", {
      requesterID: f.child.actor.id,
      awaitingActorID: f.hub.rootId,
    });
    assert.ok(awaiting.state === "done");
    assert.equal(BUILTINS.form_list.response.parse(awaiting.value).items.length, 0);
  });

const unsupportedCases: { name: string; method: string; params: any; diagnostic: RegExp }[] = [
  {
    name: "secret question",
    method: "item/tool/requestUserInput",
    params: tool([question({ isSecret: true })]),
    diagnostic: /questions\.0\.isSecret/,
  },
  {
    name: "too many fields for Workspace",
    method: "item/tool/requestUserInput",
    params: tool(
      Array.from({ length: 101 }, (_, n) =>
        question({ id: `native-question-${n}`, options: null }),
      ),
    ),
    diagnostic: /Form\.fields.*100/,
  },
  {
    name: "too many choices for Workspace",
    method: "item/tool/requestUserInput",
    params: tool([
      question({
        options: Array.from({ length: 101 }, (_, n) => ({
          label: `Choice ${n}`,
          description: "A choice",
        })),
      }),
    ]),
    diagnostic: /options.*100/,
  },
  {
    name: "question label exceeds Workspace text limit",
    method: "item/tool/requestUserInput",
    params: tool([question({ question: "x".repeat(20001), options: null })]),
    diagnostic: /label.*20000/,
  },
  {
    name: "enum title/value arity mismatch",
    method: "mcpServer/elicitation/request",
    params: mcp({
      type: "object",
      properties: {
        choice: { type: "string", enum: ["a", "b"], enumNames: ["First", "Second", "Extra"] },
      },
    }),
    diagnostic: /properties\.choice\.enumNames.*equal title\/value counts/,
  },
  {
    name: "MCP multi-select",
    method: "mcpServer/elicitation/request",
    params: mcp({
      type: "object",
      properties: { tags: { type: "array", items: { type: "string", enum: ["a", "b"] } } },
    }),
    diagnostic: /properties\.tags.*multi-select/,
  },
  {
    name: "nested schema",
    method: "mcpServer/elicitation/request",
    params: mcp(
      {
        type: "object",
        properties: { address: { type: "object", properties: { street: { type: "string" } } } },
      },
      "openaiForm",
    ),
    diagnostic: /properties\.address/,
  },
  {
    name: "unknown raw pattern cannot be silently stripped",
    method: "mcpServer/elicitation/request",
    params: mcp(
      { type: "object", properties: { code: { type: "string", pattern: "^A+$" } } },
      "openai/form",
    ),
    diagnostic: /properties\.code\.pattern/,
  },
  {
    name: "null-valued raw constraint cannot be silently stripped",
    method: "mcpServer/elicitation/request",
    params: mcp(
      { type: "object", properties: { code: { type: "string", const: null } } },
      "openai/form",
    ),
    diagnostic: /properties\.code\.const/,
  },
  {
    name: "unknown constraint inside a titled enum",
    method: "mcpServer/elicitation/request",
    params: mcp(
      {
        type: "object",
        properties: {
          code: { type: "string", oneOf: [{ const: "a", title: "A", pattern: "^a$" }] },
        },
      },
      "openai/form",
    ),
    diagnostic: /properties\.code\.oneOf/,
  },
  {
    name: "open object schema",
    method: "mcpServer/elicitation/request",
    params: mcp(
      { type: "object", properties: { note: { type: "string" } }, additionalProperties: true },
      "openai/form",
    ),
    diagnostic: /requestedSchema\.additionalProperties/,
  },
  {
    name: "minimum answer exceeds the actual Form value limit",
    method: "mcpServer/elicitation/request",
    params: mcp({ type: "object", properties: { note: { type: "string", minLength: 20001 } } }),
    diagnostic: /properties\.note\.minLength.*20000/,
  },
  {
    name: "URL interaction",
    method: "mcpServer/elicitation/request",
    params: {
      threadId: "fixture-thread",
      turnId: "fixture-turn",
      serverName: "Fixture",
      mode: "url",
      elicitationId: "native-url-id",
      url: "https://example.invalid/consent",
      message: "Approve access",
    },
    diagnostic: /URL-based/,
  },
];
for (const c of unsupportedCases)
  test(`unsupported native input stays pending without a Form: ${c.name}`, {
    timeout: 10_000,
  }, async (t) => {
    assert.equal(
      (c.method === "item/tool/requestUserInput" ? toolRequest : mcpRequest)(c.params).valid,
      true,
    );
    const f = await nativeFormFixture(t);
    f.event(c.method, c.params, "fixture-request");
    await f.routed();
    assert.equal(f.answers.length, 0);
    assert.equal(f.actor.snapshot().requests.length, 1);
    assert.match(f.actor.lastError ?? "", c.diagnostic);
    assert.match(f.actor.lastError ?? "", /remains pending for its native input owner/);
    assert.doesNotMatch(f.actor.lastError ?? "", /answer.*Form|JSON/);
    await assert.rejects(
      f.actor.checkRequest("fixture-request"),
      /no bound Form.*native input owner/,
    );
    const forms = await f.root.call("form_list", { requesterID: f.child.actor.id });
    assert.ok(forms.state === "done");
    assert.deepEqual(BUILTINS.form_list.response.parse(forms.value).items, []);
    assert.equal(
      Object.values(f.bootstrap.approvals ?? {}).some((b) => b.answerAttempt),
      false,
    );
  });

test("ordinary MCP response must pass native constraints before any answer attempt", {
  timeout: 10_000,
}, async (t) => {
  const params = mcp({
    type: "object",
    properties: { count: { type: "integer", minimum: 2, title: "Count" } },
    required: ["count"],
  });
  assert.equal(mcpRequest(params).valid, true);
  const release = deferred<void>(),
    requested = deferred<string>(),
    managerReached = deferred<void>(),
    managerRelease = deferred<void>(),
    managerObserved = deferred<void>();
  t.after(() => {
    release.resolve();
    managerRelease.resolve();
  });
  const f = await nativeFormFixture(t),
    call = f.session.call.bind(f.session);
  let submitted = false;
  f.session.call = async (name, args, timeout) => {
    if (name === f.session.alias("hub:forms", "form_get")) {
      requested.resolve(String(args.formID));
      await release.promise;
    }
    const rechecking = submitted && name === f.session.alias("hub:team", "team");
    if (rechecking) {
      managerReached.resolve();
      await managerRelease.promise;
    }
    const result = await call(name, args, timeout);
    if (rechecking) setImmediate(() => managerObserved.resolve());
    return result;
  };
  f.event("mcpServer/elicitation/request", params, "fixture-request");
  const formID = await requested.promise;
  const read = await f.root.call("form_get", { formID });
  assert.ok(read.state === "done");
  const form = Form.parse(read.value);
  const answered = await f.root.call("form_respond", {
    formID,
    expectedRevision: form.revision,
    answers: { [form.fields[0].name]: "1" },
  });
  assert.ok(answered.state === "done");
  submitted = true;
  release.resolve();
  await managerReached.promise;
  assert.equal(f.answers.length, 0);
  assert.equal(
    Object.values(f.bootstrap.approvals ?? {}).some((b) => b.answerAttempt),
    false,
  );
  managerRelease.resolve();
  await managerObserved.promise;
  assert.match(f.actor.lastError ?? "", /Revise the Form response/);
  assert.equal(f.answers.length, 0);
  assert.equal(
    Object.values(f.bootstrap.approvals ?? {}).some((b) => b.answerAttempt),
    false,
  );
});
