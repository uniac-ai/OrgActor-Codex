import assert from "node:assert/strict";
import test from "node:test";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { catalogOf } from "../src/hub/catalog.js";

test("semantic Tool reconstruction preserves explicit aliases, local names, schemas and annotations", () => {
  const own = {
    type: "object",
    properties: { result: { $ref: "#/$defs/Result" } },
    required: ["result"],
  };
  const tool: Tool = {
    name: "unrelated_call_alias",
    title: "Readable title",
    description: "Actual interface",
    inputSchema: { type: "object" },
    outputSchema: {
      type: "object",
      $defs: { Result: { type: "string" } },
      anyOf: [
        own,
        {
          type: "object",
          properties: { call: { type: "string" }, state: { const: "pending" } },
          required: ["call", "state"],
        },
      ],
    },
    annotations: { readOnlyHint: true },
    _meta: {
      "agentorg/tool": {
        id: "actor:stable",
        name: "named-position",
        interface: "run",
        routed: true,
        one_way: false,
        long_running: true,
      },
    },
  };
  const catalog = catalogOf([tool]);
  assert.equal(catalog[0].id, "actor:stable");
  assert.equal(catalog[0].interfaces[0].call, "unrelated_call_alias");
  assert.equal(catalog[0].interfaces[0].interface.name, "run");
  assert.equal(catalog[0].interfaces[0].read_only, true);
  assert.deepEqual(catalog[0].interfaces[0].interface.output, {
    ...own,
    $defs: { Result: { type: "string" } },
  });
  assert.throws(() => catalogOf([tool, { ...tool, name: "another_alias" }]));
  assert.throws(() =>
    catalogOf([{ ...tool, outputSchema: { type: "object", anyOf: [own, { type: "object" }] } }]),
  );
});
