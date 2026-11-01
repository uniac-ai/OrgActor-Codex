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
  { label: "Local", description: "Use local execution" },
  { label: "Other", description: "The named choice" },
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
    answer: (f) => {
      assert.deepEqual(f.fields[0].options, [
        { value: "Small", detail: "For a small team" },
        { value: "Large", detail: "For a large team" },
      ]);
      assert.equal(f.fields[1].options, undefined);
      return { [f.fields[0].name]: "Small", [f.fields[1].name]: "Fits our team" };
    },
    expected: {
      answers: {
        "native-question-choice": { answers: ["Small"] },
        "native-question-text": { answers: ["Fits our team"] },
      },
    },
  },
  ...[
    { name: "a choice label", value: "Local", expected: ["Local"] },
    {
      name: "custom text with a choice label",
      value: "Local with custom settings",
      expected: ["Local with custom settings"],
    },
    { name: "literal Other without secondary text", value: "Other", expected: ["Other"] },
    { name: "an omitted value", expected: [] },
    { name: "an explicitly empty value", value: "", expected: [""] },
  ].map((c) => ({
    name: `Other-enabled question accepts ${c.name}`,
    method: "item/tool/requestUserInput",
    params: tool([question({ isOther: true, options: otherOptions })]),
    fields: 1,
    answer: (f: Form) => {
      const field = f.fields[0];
      assert.equal(field.options, undefined);
      assert.equal(field.required, false);
      assert.match(field.label, /Enter a choice label or your own answer/);
      for (const option of otherOptions)
        assert.ok(field.label.includes(`${option.label}: ${option.description}`));
      return c.value === undefined ? {} : { [field.name]: c.value };
    },
    expected: { answers: { "native-question-choice": { answers: c.expected } } },
  })),
  {
    name: "present empty question response maps to the native empty answer array",
    method: "item/tool/requestUserInput",
    params: tool([question({ options: null })]),
    fields: 1,
    answer: () => ({}),
    expected: { answers: { "native-question-choice": { answers: [] } } },
  },
  {
    name: "optional MCP text, false boolean and titled enum",
    method: "mcpServer/elicitation/request",
    params: mcp({
      type: "object",
      properties: {
        name: {
          type: "string",
          title: "Name",
          description: null,
          default: null,
          minLength: 0,
          maxLength: 20000,
        },
        enabled: { type: "boolean", title: "Enable", default: true },
        plan: {
          type: "string",
          title: "Plan",
          oneOf: [
            { const: "a", title: "Alpha" },
            { const: "b", title: "Beta" },
          ],
        },
      },
      required: [],
    }),
    fields: 3,
    answer: (f) =>
      Object.fromEntries(f.fields.map((field, n) => [field.name, ["Ada", "No", "Beta"][n]])),
    expected: result({ name: "Ada", enabled: false, plan: "b" }),
  },
  {
    name: "MCP Accept without data does not fill defaults",
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
    name: "omitted optional choices are absent, plain empty text is preserved",
    method: "mcpServer/elicitation/request",
    params: mcp({
      type: "object",
      properties: {
        enabled: { type: "boolean" },
        plan: { type: "string", enum: ["a", "b"] },
        note: { type: "string" },
      },
    }),
    fields: 3,
    answer: (f) => ({ [f.fields[2].name]: "" }),
    expected: result({ note: "" }),
  },
  {
    name: "flat native alias and legacy display titles",
    method: "mcpServer/elicitation/request",
    params: mcp(
      {
        type: "object",
        properties: { region: { type: "string", enum: ["eu", "us"], enumNames: ["Europe", "US"] } },
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
    assert.equal(form.approval, true);
    assert.ok(form.title.length > 0 && form.title.length <= 120);
    const isMcp = c.method === "mcpServer/elicitation/request";
    const dataForm = isMcp ? { ...form, fields: form.fields.slice(1) } : form;
    assert.equal(dataForm.fields.length, c.fields);
    if (isMcp) {
      assert.deepEqual(
        form.fields[0].options?.map((option) => option.value),
        ["Accept", "Decline", "Cancel"],
      );
      assert.equal(form.fields[0].required, true);
      assert.ok(dataForm.fields.every((field) => !field.required));
    }
    for (const field of form.fields)
      assert.doesNotMatch(field.label, /native-question-|JSON|threadId|turnId/);
    const answers = {
      ...c.answer(dataForm),
      ...(isMcp ? { [form.fields[0].name]: "Accept" } : {}),
    };
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
    assert.deepEqual(
      Object.values(f.bootstrap.approvals ?? {})[0].answerAttempt?.response,
      c.expected,
    );
    assert.doesNotMatch(f.actor.lastError ?? "", /Revise|does not match/);
    assert.equal(
      (c.method === "item/tool/requestUserInput" ? toolResponse : mcpResponse)(
        f.answers[0].response,
      ).valid,
      true,
    );
    const resolved = await f.root.call("form_get", { formID });
    assert.ok(resolved.state === "done");
    assert.equal(Form.parse(resolved.value).status, "resolved");
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
  ...[{ type: "string" }, { type: "boolean" }, { type: "string", enum: ["a", "b"] }].map(
    (property) => ({
      name: `required MCP ${property.type}${"enum" in property ? " enum" : ""}`,
      method: "mcpServer/elicitation/request",
      params: mcp({ type: "object", properties: { value: property }, required: ["value"] }),
      diagnostic: /requestedSchema\.required\.0 \(value\).*only for Accept/,
    }),
  ),
  ...["integer", "number"].map((type) => ({
    name: `MCP ${type} cannot validate ordinary text`,
    method: "mcpServer/elicitation/request",
    params: mcp({ type: "object", properties: { value: { type, minimum: 2 } } }),
    diagnostic: /properties\.value\.type.*numeric text/,
  })),
  ...["email", "uri", "date", "date-time"].map((format) => ({
    name: `MCP ${format} cannot validate ordinary text`,
    method: "mcpServer/elicitation/request",
    params: mcp({ type: "object", properties: { value: { type: "string", format } } }),
    diagnostic: /properties\.value\.format.*before accepting a response/,
  })),
  ...[{ minLength: 1 }, { maxLength: 19999 }].map((limit) => ({
    name: `MCP ${Object.keys(limit)[0]} exceeds public validation`,
    method: "mcpServer/elicitation/request",
    params: mcp({ type: "object", properties: { value: { type: "string", ...limit } } }),
    diagnostic: /properties\.value\.(minLength|maxLength).*before accepting a response/,
  })),
  {
    name: "MCP decision counts toward Workspace field limit",
    method: "mcpServer/elicitation/request",
    params: mcp({
      type: "object",
      properties: Object.fromEntries(
        Array.from({ length: 100 }, (_, n) => [`value${n}`, { type: "string" }]),
      ),
    }),
    diagnostic: /Form\.fields.*100/,
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
      /no bound ask.*native input owner/,
    );
    const forms = await f.root.call("form_list", { requesterID: f.child.actor.id });
    assert.ok(forms.state === "done");
    assert.deepEqual(BUILTINS.form_list.response.parse(forms.value).items, []);
    assert.equal(
      Object.values(f.bootstrap.approvals ?? {}).some((b) => b.answerAttempt),
      false,
    );
  });
