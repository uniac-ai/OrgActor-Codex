import assert from "node:assert/strict";
import test from "node:test";
import { cleanupOwned } from "../scripts/cleanup.js";

test("E2E cleanup failure records the exact owned resource and continues independent cleanup", async () => {
  const archived: string[] = [];
  const result = await cleanupOwned(
    {
      loaded: async () => ["failed"],
      read: async () => ({ thread: { turns: [] } }),
      interrupt: async () => {},
      terminals: async () => [],
      terminate: async () => true,
      archive: async (id) => {
        if (id === "failed") throw new Error("Archive response lost");
        archived.push(id);
      },
    },
    ["failed", "other"],
  );
  assert.equal(result.success, false);
  assert.deepEqual(result.unresolved, [{ threadId: "failed", operation: "archive" }]);
  assert.deepEqual(archived, ["other"]);
});
test("one explicit idle proof retention is separate from unresolved native resources", async () => {
  const result = await cleanupOwned(
    {
      loaded: async () => ["proof", "unrelated"],
      read: async () => ({ thread: { turns: [] } }),
      interrupt: async () => {},
      terminals: async () => [],
      terminate: async () => true,
      archive: async () => assert.fail("The explicit proof must be retained"),
    },
    ["proof"],
    { retained: "proof" },
  );
  assert.equal(result.success, true);
  assert.deepEqual(result.retained, ["proof"]);
  assert.deepEqual(result.unresolved, []);
});
