import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ActorController } from "../src/actors/controller.js";
import { AppServerAdapter, SshAdapter } from "../src/codex/index.js";
import { RuntimeStore } from "../src/runtime/index.js";
import { startServer } from "../src/server/index.js";
import { SetupService } from "../src/setup/index.js";

for (const binding of ["ssh", "app-server"] as const)
  test(`${binding} execution rechecks live ChatGPT/plan admission before any native model start`, async (t) => {
    const root = mkdtempSync(join(tmpdir(), "orgactor-admission-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const store = new RuntimeStore(root);
    let accountType: string | null = "apiKey";
    let included: boolean | null = true;
    let provider = "openai";
    let starts = 0;
    const setupFrames: any[] = [];
    const protocol = {
      request: async (method: string, params: any) => {
        if (method === "account/read")
          return { account: accountType ? { type: accountType } : null };
        if (method === "account/rateLimits/read") return { ordinaryUsageAllowed: included };
        if (method === "thread/read") {
          assert.equal(
            params.includeTurns,
            false,
            "admission needs metadata, not history hydration",
          );
          return { thread: { modelProvider: provider } };
        }
        if (method === "thread/start") {
          setupFrames.push(params);
          return { thread: { id: "native-session" } };
        }
        if (method === "turn/start") {
          starts++;
          return { turn: { id: "native-turn" } };
        }
        throw new Error("Unexpected native call");
      },
    };
    const native =
      binding === "ssh" ? new SshAdapter(protocol as any) : new AppServerAdapter(protocol as any);
    const setup = new SetupService(store, { get: async () => native } as any);
    const execution = await setup.executionAdapter();
    await execution.create({
      cwd: "/owned",
      bridgeUrl: "http://127.0.0.1/mcp",
      bridgeToken: "private",
    });

    assert.equal(setupFrames[0].modelProvider, "openai");
    assert.equal(setupFrames[0].config.forced_login_method, "chatgpt");
    assert.equal(setupFrames[0].allowProviderModelFallback, false);
    for (const denied of ["apiKey", null]) {
      accountType = denied;
      await assert.rejects(
        execution.start("native-session", "task", "id"),
        (error: any) => error.code === "EXECUTION_NOT_ADMITTED",
      );
    }
    assert.equal(starts, 0);
    accountType = "chatgpt";
    assert.equal(await execution.start("native-session", "task", "id"), "native-turn");
    assert.equal(starts, 1);
    assert.equal((await setup.probe("account")).state, "ready");
    accountType = "apiKey";
    await assert.rejects(execution.start("native-session", "task", "next"));
    assert.equal(starts, 1);
    accountType = "chatgpt";
    included = null;
    await assert.rejects(execution.start("native-session", "task", "no-quota-observation"));
    included = true;
    provider = "custom-api";
    await assert.rejects(execution.start("native-session", "task", "wrong-provider"));
    assert.equal(starts, 1);
  });

test("server composition supplies the Setup-owned guard to the actual Supervisor launch path", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "orgactor-composed-admission-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const server = await startServer({ root, port: 0 });
  t.after(() => server.close());
  let starts = 0;
  const native = new AppServerAdapter({
    request: async (method: string) => {
      if (method === "account/read") return { account: { type: "apiKey" } };
      if (method === "turn/start") {
        starts++;
        return { turn: { id: "would-bill" } };
      }
      throw new Error("Unexpected call");
    },
  } as any);
  server.backend.get = async () => native;
  const original = ActorController.prototype.open;
  t.after(() => {
    ActorController.prototype.open = original;
  });
  let resolve!: (code: string) => void;
  const observed = new Promise<string>((r) => {
    resolve = r;
  });
  ActorController.prototype.open = async function () {
    const adapter = await (this as any).getAdapter();
    try {
      await adapter.start("thread", "task", "input");
      resolve("started");
    } catch (error) {
      resolve((error as any).code);
    }
  };
  server.store.data.actors.actor = {
    actorId: "actor",
    hubUrl: "http://unused",
    threadId: "thread",
    bridgeToken: "private",
    enabled: true,
    config: { approvalAuthority: "desktop" },
    submissions: [],
  };
  server.actors.launch("actor");
  assert.equal(await observed, "EXECUTION_NOT_ADMITTED");
  assert.equal(starts, 0);
});
