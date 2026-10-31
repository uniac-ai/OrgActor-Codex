import assert from "node:assert/strict";
import test from "node:test";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { catalogOf } from "../src/hub/catalog.js";

test("Tool aliases use exact metadata and reject obsolete routing or ambiguous offers", () => {
  const tool: Tool = {
    name: "unrelated_call_alias",
    inputSchema: { type: "object" },
    _meta: {
      "agentorg/tool": {
        id: "hub:claims",
        name: "claims",
        interface: "claim",
        one_way: false,
        long_running: false,
      },
    },
  };
  const catalog = catalogOf([tool]);
  assert.equal(catalog.get("hub:claims")?.name, "claims");
  assert.equal(catalog.get("hub:claims")?.interfaces.get("claim"), "unrelated_call_alias");
  assert.throws(() => catalogOf([tool, { ...tool, name: "another_alias" }]));
  assert.throws(() =>
    catalogOf([
      {
        ...tool,
        _meta: { "agentorg/tool": { ...(tool._meta?.["agentorg/tool"] as object), routed: false } },
      },
    ]),
  );
});
