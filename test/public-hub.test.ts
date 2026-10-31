import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout } from "node:timers/promises";
import { connectClient } from "@agentorg/cli/actor";
import { BUILTINS } from "@agentorg/cli/contract";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { WebSocketServer } from "ws";
import { startPublicHub } from "../scripts/hub.js";
import { startServer } from "../src/server/index.js";

async function until(read: () => boolean) {
  for (let i = 0; i < 500; i++) {
    if (read()) return;
    await setTimeout(10);
  }
  assert.fail("The owned public protocol fixture did not settle");
}

for (const delayed of ["item", "turn-and-item"])
  test(`packaged public Hub and Provider complete inbox work when native ${delayed} observation arrives after HTTP`, {
    timeout: 20_000,
  }, async (t) => {
    const owned = mkdtempSync(join(tmpdir(), "orgactor-public-hub-"));
    const hub = await startPublicHub(
      join(owned, "hub"),
      "fixture-provider",
      "OWNED_PROVIDER_CREDENTIAL",
    );
    const native = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(native, "listening");
    const mcp = new Client({ name: "owned-native-fixture", version: "1" });
    const state = {
      discovery: false,
      nativeStarts: 0,
      answers: [] as unknown[],
      guardReached: false,
      responseReleased: false,
      failure: undefined as unknown,
      teamDescription: undefined as string | undefined,
    };
    const metadata = () => ({
      id: "native-thread",
      sessionId: "native-session",
      historyMode: "legacy",
      status: { type: "idle" },
      preview: "",
      name: null,
      cwd: "/owned",
      modelProvider: "openai",
      turns: [],
    });
    native.on("connection", (socket) =>
      socket.on("message", (raw) => {
        const m = JSON.parse(String(raw));
        if (m.id === undefined) return;
        const reply = (result: any) => socket.send(JSON.stringify({ id: m.id, result }));
        const event = (method: string, params: any) =>
          socket.send(JSON.stringify({ method, params: { threadId: "native-thread", ...params } }));
        if (m.id === "native-input" && !m.method) {
          state.answers.push(m.result);
          event("serverRequest/resolved", { requestId: m.id });
        } else if (m.method === "initialize") reply({});
        else if (m.method === "thread/start") {
          void (async () => {
            const actor = Object.values(runtime.store.data.actors)[0];
            assert.equal(actor.threadId, "");
            const config = m.params.config["mcp_servers.org"];
            await mcp.connect(
              new StreamableHTTPClientTransport(new URL(config.url), {
                requestInit: { headers: config.http_headers },
              }),
            );
            const list = await mcp.listTools();
            assert.equal(list.tools.length, 23);
            assert.equal(
              list.tools.find((tool) => tool.name === "team")?.description,
              state.teamDescription,
            );
            for (const tool of list.tools)
              assert.deepEqual(
                Object.keys(tool._meta?.["agentorg/tool"] as object).sort(),
                ["id", "name", "interface", "one_way", "long_running"].sort(),
              );
            assert.equal(actor.threadId, "");
            await assert.rejects(
              mcp.callTool({ name: "team", arguments: {}, _meta: { threadId: "" } }),
            );
            state.discovery = true;
            reply({ thread: metadata() });
          })().catch((error) => {
            state.failure = error;
            socket.send(
              JSON.stringify({
                id: m.id,
                error: { code: -32602, message: "Owned fixture failed" },
              }),
            );
          });
        } else if (m.method === "thread/read") reply({ thread: metadata() });
        else if (m.method === "account/read") reply({ account: { type: "chatgpt" } });
        else if (m.method === "account/rateLimits/read") reply({ ordinaryUsageAllowed: true });
        else if (m.method === "mcpServerStatus/list")
          reply({ data: [{ name: "org", tools: { team: {} } }] });
        else if (m.method === "turn/start") {
          state.nativeStarts++;
          void (async () => {
            const actor = [...runtime.actors.actors.values()][0];
            const wait = actor.waitForToolCall.bind(actor);
            actor.waitForToolCall = (...args) => {
              const pending = wait(...args);
              state.guardReached = true;
              return pending;
            };
            const started = () => event("turn/started", { turn: { id: "native-turn" } });
            if (delayed === "item") started();
            let settled = false;
            const call = mcp
              .callTool({
                name: "team",
                arguments: { depth: 0 },
                _meta: {
                  threadId: "native-thread",
                  sessionId: "native-session",
                  callId: "native-call",
                },
              })
              .finally(() => {
                settled = true;
              });
            await until(() => state.guardReached);
            assert.equal(settled, false);
            assert.equal(runtime.bridge.requests, 0);
            assert.equal(state.responseReleased, false);
            if (delayed === "turn-and-item") started();
            event("item/started", {
              turnId: "native-turn",
              item: { id: "native-call", type: "mcpToolCall", server: "org", tool: "team" },
            });
            const result = await call;
            assert.equal(result.isError, undefined);
            const team = BUILTINS.team.response.parse(result.structuredContent);
            assert.equal(team.positions[0].id, actor.bootstrap.actorId);
            assert.equal(state.responseReleased, false);
            reply({ turn: { id: "native-turn" } });
            state.responseReleased = true;
            event("item/completed", {
              turnId: "native-turn",
              item: { type: "userMessage", clientId: m.params.clientUserMessageId },
            });
            event("item/completed", {
              turnId: "native-turn",
              item: { id: "native-call", type: "mcpToolCall", server: "org", tool: "team" },
            });
            event("turn/completed", {
              turn: {
                id: "native-turn",
                status: "completed",
                items: [
                  { type: "userMessage", clientId: m.params.clientUserMessageId },
                  { type: "agentMessage", text: "OWNED_FIXTURE_COMPLETE" },
                ],
              },
            });
          })().catch((error) => {
            state.failure = error;
          });
        } else {
          state.failure = new Error(`Unexpected owned native operation: ${m.method}`);
          reply({});
        }
      }),
    );
    const runtime = await startServer({
      root: join(owned, "provider"),
      port: 0,
      hub: {
        url: hub.url,
        providerId: "fixture-provider",
        credential: "OWNED_PROVIDER_CREDENTIAL",
      },
    });
    const root = await connectClient({
      url: hub.url,
      actorId: hub.rootId,
      credential: hub.rootCredential,
    });
    t.after(async () => {
      await mcp.close();
      await root.close();
      await runtime.close();
      for (const socket of native.clients) socket.terminate();
      await new Promise<void>((resolve) => native.close(() => resolve()));
      await hub.close();
      rmSync(owned, { recursive: true, force: true });
    });
    await runtime.provider.setEnabled(false);
    runtime.setup.configure({
      backend: {
        kind: "app-server",
        endpoint: `ws://127.0.0.1:${(native.address() as { port: number }).port}`,
      },
      workspaceRoot: "/owned",
      bridgeUrl: `${runtime.url}/mcp`,
    });
    await runtime.provider.setEnabled(true);
    await until(() => runtime.provider.snapshot().connected);
    const publicTools = await root.available();
    assert.equal(publicTools.length, 9);
    state.teamDescription = publicTools
      .find((tool) => tool.id === "hub:team")
      ?.interfaces.find((offer) => offer.interface.name === "team")?.interface.description;
    assert.ok(state.teamDescription);
    const created = await root.call("actor_create", {
      name: "owned-provider-proof",
      purpose: "Model-free public protocol fixture",
      execution: { providerId: "fixture-provider", config: {} },
    });
    assert.equal(state.failure, undefined);
    assert.equal(created.state, "done");
    assert.ok(created.state === "done");
    const value = BUILTINS.actor_create.response.parse(created.value);
    assert.equal(value.execution?.status, "ready");
    assert.equal("interfaces" in value.actor, false);
    assert.equal("created_at_attach" in value.actor, false);
    assert.equal(state.discovery, true);
    const actor = runtime.actors.get(value.actor.id);
    await until(() => actor.snapshot().observation === "available");
    for (const name of ["owned-provider-proof.run", `${value.actor.id}.status`, "call_withdraw"]) {
      const refused = await root.call(name, {});
      assert.equal(refused.state, "refused");
      assert.deepEqual(Object.keys(refused).sort(), ["state", "code", "message"].sort());
    }
    assert.equal(state.nativeStarts, 0);
    assert.equal((await root.available()).flatMap((tool) => tool.interfaces).length, 23);
    for (const name of [
      "messages",
      "message_read",
      "message_acknowledge",
      "message_handle",
      "question_ask",
      "question_answer",
      "questions",
      "progress",
      "progress_set",
    ])
      assert.equal((await root.call(name, {})).state, "refused");
    const message = await root.call("message_send", {
      recipientID: value.actor.id,
      text: "Owned inbox decision",
    });
    assert.ok(message.state === "done");
    const sent = BUILTINS.message_send.response.parse(message.value);
    await until(() => !!state.failure || actor.bootstrap.submissions[0]?.state === "done");
    assert.equal(state.failure, undefined);
    const input = actor.bootstrap.submissions[0];
    assert.equal(input.id, `message:${sent.messageID}`);
    assert.equal(input.from, hub.rootId);
    assert.equal(input.cause, null);
    assert.equal(input.result?.output, "OWNED_FIXTURE_COMPLETE");
    assert.equal(actor.enqueue(input.id, input.text, input.from), input);
    assert.equal(actor.bootstrap.submissions.length, 1);
    assert.equal(state.nativeStarts, 1);
    assert.equal(runtime.bridge.requests, 1);
    await assert.rejects(
      mcp.callTool({
        name: "team",
        arguments: {},
        _meta: { threadId: "native-thread", sessionId: "native-session", callId: "native-call" },
      }),
    );
    assert.equal(runtime.bridge.requests, 1);
    const outsiderCreated = await root.call("actor_create", {
      name: "outsider",
      purpose: "Owned role fixture",
    });
    assert.ok(outsiderCreated.state === "done");
    const outsiderValue = BUILTINS.actor_create.response.parse(outsiderCreated.value);
    const outsider = await connectClient({
      url: hub.url,
      actorId: outsiderValue.actor.id,
      credential: outsiderValue.credential,
    });
    t.after(() => outsider.close());
    const emptyCreated = await outsider.call("form_create", {
      respondentIDs: [hub.rootId],
      fields: [{ name: "optional", label: "Optional", required: false }],
    });
    assert.ok(emptyCreated.state === "done");
    const emptyForm = BUILTINS.form_create.response.parse(emptyCreated.value);
    const awaitingBefore = await root.call("form_list", { awaitingActorID: hub.rootId });
    assert.ok(awaitingBefore.state === "done");
    assert.ok(
      BUILTINS.form_list.response
        .parse(awaitingBefore.value)
        .items.some((f) => f.formID === emptyForm.formID),
    );
    const emptyAnswered = await root.call("form_respond", {
      formID: emptyForm.formID,
      expectedRevision: emptyForm.revision,
      answers: {},
    });
    assert.ok(emptyAnswered.state === "done");
    const emptyResponse = BUILTINS.form_respond.response.parse(emptyAnswered.value);
    assert.ok(Object.hasOwn(emptyResponse.responses, hub.rootId));
    assert.deepEqual(emptyResponse.responses[hub.rootId], {});
    const awaitingAfter = await root.call("form_list", { awaitingActorID: hub.rootId });
    assert.ok(awaitingAfter.state === "done");
    assert.equal(
      BUILTINS.form_list.response
        .parse(awaitingAfter.value)
        .items.some((f) => f.formID === emptyForm.formID),
      false,
    );

    const configured = await fetch(`${runtime.url}/api/actors/${value.actor.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approvalAuthority: "hub" }),
    });
    assert.equal(configured.status, 200);
    const formReads: string[] = [];
    assert.ok(actor.hub);
    const call = actor.hub.call.bind(actor.hub);
    actor.hub.call = async (name, args, timeout) => {
      if (name === "form_list")
        assert.fail("A known private Form must not scan organization Forms");
      if (name === "form_get") formReads.push(String(args.formID));
      return call(name, args, timeout);
    };
    const socket = [...native.clients][0];
    socket.send(
      JSON.stringify({
        method: "turn/started",
        params: { threadId: "native-thread", turn: { id: "input-turn" } },
      }),
    );
    socket.send(
      JSON.stringify({
        id: "native-input",
        method: "item/tool/requestUserInput",
        params: {
          threadId: "native-thread",
          turnId: "input-turn",
          questions: [
            {
              id: "choice",
              header: "Choice",
              question: "Proceed?",
              isOther: false,
              isSecret: false,
              options: [{ label: "yes", description: "Proceed" }],
            },
          ],
        },
      }),
    );
    await until(() => Object.values(actor.bootstrap.approvals ?? {}).some((b) => !!b.formId));
    const binding = Object.values(actor.bootstrap.approvals ?? {})[0];
    const shared = await outsider.call("form_get", { formID: binding.formId });
    assert.ok(shared.state === "done");
    const nativeForm = BUILTINS.form_get.response.parse(shared.value);
    assert.equal(nativeForm.workID, undefined);
    assert.equal(nativeForm.requesterID, actor.bootstrap.actorId);
    assert.deepEqual(nativeForm.respondentIDs, [hub.rootId]);
    const answers = {
      decision: "accept",
      input: JSON.stringify({ answers: { choice: { answers: ["yes"] } } }),
    };
    assert.equal(
      (
        await outsider.call("form_respond", {
          formID: nativeForm.formID,
          expectedRevision: nativeForm.revision,
          answers,
        })
      ).state,
      "refused",
    );
    assert.equal(
      (
        await root.call("form_close", {
          formID: nativeForm.formID,
          expectedRevision: nativeForm.revision,
          status: "resolved",
          resolution: "approve",
        })
      ).state,
      "refused",
    );
    assert.equal(
      (
        await root.call("form_respond", {
          formID: nativeForm.formID,
          expectedRevision: nativeForm.revision,
          answers,
        })
      ).state,
      "done",
    );
    await until(() => state.answers.length === 1);
    assert.deepEqual(state.answers, [{ answers: { choice: { answers: ["yes"] } } }]);
    assert.ok(formReads.length > 0 && formReads.every((id) => id === nativeForm.formID));
    assert.ok(binding.answerAttempt);
    const stillOpen = await root.call("form_get", { formID: nativeForm.formID });
    assert.ok(stillOpen.state === "done");
    assert.equal(BUILTINS.form_get.response.parse(stillOpen.value).status, "open");
  });
