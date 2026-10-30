import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ActorHubSession } from "../src/hub/actor.js";
import { CodexProvider } from "../src/provider/index.js";
import { hash, token } from "../src/runtime/index.js";
import { startServer } from "../src/server/index.js";

// This opt-in test uses existing ChatGPT authentication; it never reads authentication tokens.
const hubRoot = resolve(process.env.HUB_ROOT ?? ".e2e/hub");
const sshRoot = process.env.CODEX_SSH_PROOF_ROOT;
assert.ok(sshRoot, "Set CODEX_SSH_PROOF_ROOT to the authorized SSH backend proof directory");
const setupOnly = process.argv.includes("--setup-only");
const retainProof = process.argv.includes("--retain-proof");
mkdirSync(".e2e", { recursive: true });
const owned = mkdtempSync(resolve(".e2e/real-"));
chmodSync(owned, 0o700);
const evidence: any = {
  hubRevision: "58dbececc84289f378f658b35504371106a7c760",
  owned,
  startedAt: new Date().toISOString(),
  setupOnly,
  desktop: { catalog: "pending", renderedPixels: "unverified" },
  steps: [],
};
const save = () =>
  writeFileSync(join(owned, "evidence.json"), JSON.stringify(evidence, null, 2), { mode: 0o600 });
const { startCore } = await import(pathToFileURL(join(hubRoot, "dist/src/server/index.js")).href);
const { SqliteStore } = await import(
  pathToFileURL(join(hubRoot, "dist/src/storage/sqlite/index.js")).href
);
const database = new SqliteStore(join(owned, "hub.db"));
const providerCredential = token();
const providerId = `codex-${randomUUID().slice(0, 8)}`;
const hub = await startCore(database, {
  port: 0,
  providers: [{ providerId, credentialHash: hash(providerCredential) }],
});
const rootIdentity = await hub.organization.registry.createRoot();
const root = new ActorHubSession(hub.url, []);
const module = await startServer({ root: join(owned, "runtime"), port: 0 });
let native: any;
const threads = new Set<string>();
async function until<T>(
  label: string,
  fn: () => Promise<T> | T,
  accept: (x: T) => boolean = Boolean,
  ms = 45_000,
): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await fn();
    if (accept(value)) return value;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`${label} did not settle`);
}
async function inventory() {
  return (await native.protocol.request("thread/loaded/list", {})).data as string[];
}
async function quota() {
  const r = await native.protocol.request("account/rateLimits/read");
  return {
    ordinaryUsageAllowed: r.ordinaryUsageAllowed,
    rateLimits: r.rateLimits,
    rateLimitsByLimitId: r.rateLimitsByLimitId,
  };
}
try {
  module.setup.configure({
    backend: {
      kind: "ssh",
      host: "127.0.0.1",
      port: 58509,
      user: "andrewshi",
      privateKey: readFileSync(join(sshRoot, "keys/client"), "utf8"),
      knownHosts: readFileSync(join(sshRoot, "keys/known_hosts"), "utf8"),
    },
    workspaceRoot: sshRoot,
    bridgeUrl: `${module.url}/mcp`,
    hub: { url: hub.url, providerId, credential: providerCredential },
  });
  native = await module.backend.get();
  evidence.before = { loadedThreadIds: await inventory(), quota: await quota() };
  assert.equal(evidence.before.quota.ordinaryUsageAllowed, true);
  save();
  assert.equal((await module.setup.probe("backend")).state, "ready");
  assert.equal((await module.setup.probe("account")).state, "ready");
  evidence.bridgeReachability = await module.setup.probe("bridge");
  // Hold Actor launch completely: native setup and private handoff must finish independently.
  const offline = new CodexProvider(
    module.store,
    () => module.backend.get(),
    () => {},
  );
  const offlineId = `offline-${randomUUID()}`;
  await offline.create({ actorId: offlineId, credential: token(), config: {} });
  const offlineBootstrap = module.store.data.actors[offlineId];
  threads.add(offlineBootstrap.threadId);
  assert.ok(offlineBootstrap.threadId);
  assert.equal(module.actors.actors.has(offlineId), false);
  evidence.offlineProvisioning = {
    actorId: offlineId,
    threadId: offlineBootstrap.threadId,
    nativeSessionCreated: true,
    privateHandoff: true,
    actorAdmission: false,
    modelTurns: 0,
  };
  offlineBootstrap.enabled = false;
  module.store.save();
  await native.protocol.request("thread/archive", { threadId: offlineBootstrap.threadId });
  await root.open(rootIdentity.root.id, rootIdentity.credential);
  await module.provider.setEnabled(true);
  await until("Provider admission", () => module.provider.snapshot().connected);
  const providerConnection = module.provider.connection?.connectionId;
  for (let n = 0; n < 3; n++) assert.equal((await module.setup.probe("hub")).state, "ready");
  assert.equal(module.provider.connection?.connectionId, providerConnection);
  const created = await root.call(root.alias("hub:actors", "actor_create"), {
    name: `test-${randomUUID().slice(0, 6)}`,
    purpose: "Owned OrgActor-Codex end-to-end verification.",
    execution: { providerId, config: {} },
  });
  assert.equal(created.isError, undefined);
  const result = created.structuredContent as any;
  assert.equal(result.execution.status, "ready");
  evidence.admissionProbePreservesFactory = {
    sameConnection: module.provider.connection?.connectionId === providerConnection,
    describesAndCreates: true,
  };
  const actorId = result.actor.id;
  const bootstrap = module.store.data.actors[actorId];
  threads.add(bootstrap.threadId);
  await native.protocol.request("thread/name/set", {
    threadId: bootstrap.threadId,
    name: `OrgActor-Codex E2E ${actorId}`,
  });
  const actor = await until(
    "Actor session",
    () => module.actors.actors.get(actorId),
    (a) => !!a?.hub?.connection.connected && !!a.adapter,
  );
  evidence.actor = {
    actorId,
    threadId: bootstrap.threadId,
    title: `OrgActor-Codex E2E ${actorId}`,
  };
  save();
  evidence.nativeMcpReady = await until("Thread-specific org MCP", async () => {
    const status = await native.protocol.request("mcpServerStatus/list", {
      threadId: bootstrap.threadId,
      serverName: "org",
      detail: "toolsAndAuthOnly",
    });
    evidence.mcpObservation = status.data?.map((s: any) => ({
      name: s.name,
      runtimeStatus: s.runtimeStatus,
      tools: Object.keys(s.tools ?? {}),
      toolsError:
        typeof s.toolsError === "string"
          ? s.toolsError.replaceAll(bootstrap.bridgeToken, "[redacted]")
          : null,
    }));
    evidence.bridgeObservations = module.bridge.observations;
    save();
    return native.bridgeReady(bootstrap.threadId);
  });
  const actorTools = await actor!.hub!.refreshTools();
  evidence.actorCatalog = actorTools.map((t) => ({
    call: t.name,
    metadata: t._meta?.["agentorg/tool"],
  }));
  assert.ok(actorTools.some((t) => (t._meta?.["agentorg/tool"] as any)?.id === "hub:activity"));
  if (!setupOnly) {
    await root.refreshTools();
    const runAlias = root.tools.find(
      (t) => (t._meta?.["agentorg/tool"] as any)?.interface === "run",
    )?.name;
    assert.ok(runAlias);
    const reply = await root.call(runAlias, {
      text: "Use the org MCP team and activity tools once each, then reply exactly ORGACTOR_MCP_OK. Do not run commands or modify files.",
    });
    const receipt = (reply._meta?.["agentorg/call"] as any)?.id;
    if (receipt)
      await until(
        "Hub execution result",
        async () =>
          (await root.call(root.alias("hub:calls", "call_result"), { call: receipt, wait: 5 }))
            .structuredContent as any,
        (r) => r.state === "done",
        120_000,
      );
    await until(
      "Native model output",
      () => actor!.snapshot().output,
      (text) => text.includes("ORGACTOR_MCP_OK"),
    );
    assert.ok(
      module.bridge.requests >= 2,
      "The actual native model must dispatch real Hub MCP calls",
    );
    evidence.nativeRoundtrip = {
      marker: "ORGACTOR_MCP_OK",
      dispatchedCalls: module.bridge.requests,
      nativeTurnStatus:
        bootstrap.submissions.find((s) => s.id === receipt)?.result?.status ?? "completed",
    };
    save();
    actor!.enqueue(
      `control-${randomUUID()}`,
      "Run exactly one command: python3 -c 'import time; time.sleep(8)'. After it returns reply CONTROL_DONE. Do not modify files.",
    );
    const turnId = await until("Control turn", () => actor!.turnId);
    await until("Control command started", async () =>
      (await native.read(bootstrap.threadId)).thread.turns
        .find((t: any) => t.id === turnId)
        ?.items.some((i: any) => i.type === "commandExecution" && i.status === "inProgress"),
    );
    const steerId = `steer-${randomUUID()}`;
    const steering = await actor!.steer(
      steerId,
      turnId as string,
      "After the wait reply STEER_APPLIED instead. Do not run any other command.",
    );
    const steered = await until(
      "Steered native turn completed",
      async () =>
        (await native.read(bootstrap.threadId)).thread.turns.find((t: any) => t.id === turnId),
      (turn) => turn?.status === "completed",
      90_000,
    );
    assert.ok(steered.items.some((i: any) => i.type === "userMessage" && i.clientId === steerId));
    assert.ok(
      steered.items.some((i: any) => i.type === "agentMessage" && i.text.includes("STEER_APPLIED")),
    );
    actor!.enqueue(
      `interrupt-${randomUUID()}`,
      "Run exactly one command: python3 -c 'import time; time.sleep(20)'. After it returns reply INTERRUPT_NOT_APPLIED. Do not modify files.",
    );
    const interruptTurnId = await until(
      "Interrupt turn",
      () => actor!.turnId,
      (id) => !!id && id !== turnId,
    );
    await until("Interrupt command started", async () =>
      (await native.read(bootstrap.threadId)).thread.turns
        .find((t: any) => t.id === interruptTurnId)
        ?.items.some((i: any) => i.type === "commandExecution" && i.status === "inProgress"),
    );
    await actor!.interrupt(interruptTurnId as string);
    await until(
      "Native interrupted status",
      async () =>
        (await native.read(bootstrap.threadId)).thread.turns.find(
          (t: any) => t.id === interruptTurnId,
        )?.status,
      (s) => s === "interrupted",
    );
    evidence.control = {
      turnId,
      steering,
      steerClientIdObserved: true,
      steerMarker: "STEER_APPLIED",
      interruptTurnId,
      interrupted: true,
    };
    for (const terminal of await native.terminals(bootstrap.threadId))
      await native.terminate(bootstrap.threadId, terminal.processId);
    const before = bootstrap.submissions.length;
    await module.actors.setEnabled(actorId, false);
    await module.actors.setEnabled(actorId, true);
    await until(
      "Actor reconnect",
      () => module.actors.actors.get(actorId)?.hub?.connection.connected,
    );
    await until("Native recovery", () => module.actors.actors.get(actorId)?.adapter);
    assert.equal(module.store.data.actors[actorId].submissions.length, before);
    evidence.reconnect = { threadId: bootstrap.threadId, duplicateInputs: 0 };
  }
  evidence.steps.push(
    "Provider factory over actual Hub socket",
    "independent Actor MCP admission",
    "thread-specific native MCP discovery",
    "offline native provisioning",
  );
  evidence.success = true;
} catch (e) {
  evidence.success = false;
  evidence.failure = { name: (e as Error).name, message: (e as Error).message };
  process.exitCode = 1;
} finally {
  if (native) {
    for (const threadId of threads) {
      try {
        if (!(await inventory()).includes(threadId)) continue;
        const read = await native.read(threadId);
        const active = read.thread.turns?.find((t: any) => t.status === "inProgress");
        if (active) {
          await native.interrupt(threadId, active.id);
          await until(
            "Cleanup interrupted turn",
            async () =>
              (await native.read(threadId)).thread.turns?.find((t: any) => t.id === active.id)
                ?.status,
            (s) => s !== "inProgress",
          );
        }
        for (const terminal of await native.terminals(threadId))
          await native.terminate(threadId, terminal.processId);
        assert.deepEqual(await native.terminals(threadId), []);
        if (retainProof && evidence.success && !setupOnly && threadId === evidence.actor?.threadId)
          evidence.retainedProof = {
            threadId,
            reason:
              "One idle proof session retained for manager review; no active turn or background terminal.",
          };
        else await native.protocol.request("thread/archive", { threadId });
      } catch {
        evidence.cleanupIncomplete = true;
      }
    }
    try {
      evidence.after = { loadedThreadIds: await inventory(), quota: await quota() };
      evidence.ownedThreadsStillLoaded = evidence.after.loadedThreadIds.filter((id: string) =>
        threads.has(id),
      );
    } catch {
      evidence.cleanupIncomplete = true;
    }
  }
  await root.close();
  await module.close();
  await hub.close();
  database.close();
  evidence.finishedAt = new Date().toISOString();
  save();
  console.log(
    JSON.stringify({
      success: evidence.success,
      evidence: join(owned, "evidence.json"),
      failure: evidence.failure,
      cleanupIncomplete: evidence.cleanupIncomplete,
    }),
  );
}
