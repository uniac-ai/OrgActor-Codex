import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectClient } from "@agentorg/cli/actor";
import { BUILTINS } from "@agentorg/cli/contract";
import { startPublicHub } from "../scripts/hub.js";
import { ActorController } from "../src/actors/controller.js";
import { ActorHubSession } from "../src/hub/actor.js";
import { type Bootstrap, RuntimeStore } from "../src/runtime/index.js";

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Real public Hub/Actor SDK with synthetic native history and request delivery. */
export async function nativeFormFixture(t: any) {
  const owned = mkdtempSync(join(tmpdir(), "orgactor-native-form-"));
  const hub = await startPublicHub(join(owned, "hub"), "fixture-provider", "OWNED_FIXTURE");
  let actor: ActorController | undefined;
  let root: Awaited<ReturnType<typeof connectClient>> | undefined;
  let pending = Promise.resolve();
  t.after(async () => {
    await actor?.close();
    await pending.catch(() => {});
    await root?.close();
    await hub.close();
    rmSync(owned, { recursive: true, force: true });
  });
  root = await connectClient({ url: hub.url, actorId: hub.rootId, credential: hub.rootCredential });
  const created = await root.call("actor_create", {
    name: "native-form",
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
  const answers: { id: string | number; response: object }[] = [];
  const adapter = {
    read: async () => ({
      thread: {
        id: bootstrap.threadId,
        sessionId: "fixture-session",
        turns: [{ id: "fixture-turn", status: "inProgress", items: [] }],
      },
    }),
    answer: (id: string | number, response: object) => {
      const saved = JSON.parse(readFileSync(store.file, "utf8"));
      const binding: any = Object.values(saved.actors[child.actor.id].approvals).find(
        (b: any) => b.requestId === String(id),
      );
      assert.deepEqual(binding.answerAttempt.response, response);
      answers.push({ id, response });
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
    pending = route(id);
    return pending;
  };
  const event = (method: string, params: object, id?: string) =>
    (controller as any).observe({
      method,
      params: { threadId: bootstrap.threadId, turnId: "fixture-turn", ...params },
      ...(id ? { id } : {}),
    });
  return {
    owned,
    hub,
    root,
    child,
    store,
    bootstrap,
    actor,
    session,
    answers,
    event,
    routed: () => pending,
  };
}
