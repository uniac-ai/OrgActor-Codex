import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { WebSocketServer } from "ws";
import { ActorHubSession } from "../src/hub/actor.js";

test("Actor Hub peer consumes the Hub catalog and rejects reverse interface requests", async (t) => {
  const hub = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(hub, "listening");
  const session = new ActorHubSession(
    `http://127.0.0.1:${(hub.address() as { port: number }).port}`,
  );
  const answers = new Map<string, any>();
  let peer: any;
  hub.on("connection", (socket) => {
    peer = socket;
    socket.on("message", (raw) => {
      const m = JSON.parse(String(raw));
      const reply = (result: any) =>
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }));
      if (!m.method) {
        answers.set(m.id, m);
        return;
      }
      if (m.method === "connection.connect") reply({ connectionId: "consumer" });
      else if (m.method === "initialize") {
        assert.deepEqual(m.params.capabilities, {});
        reply({
          protocolVersion: m.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "hub", version: "1" },
        });
      } else if (m.method === "tools/list")
        reply({
          tools: [
            {
              name: "actual_inbox_alias",
              inputSchema: { type: "object" },
              _meta: {
                "agentorg/tool": {
                  id: "hub:messages",
                  name: "messages",
                  interface: "messages",
                  one_way: false,
                  long_running: false,
                },
              },
            },
          ],
        });
      else if (m.method === "tools/call") {
        assert.equal(m.params.name, "actual_inbox_alias");
        assert.deepEqual(m.params.arguments, { unread: true, wait: 0 });
        reply({ content: [], structuredContent: { messages: [], cursor: 0 } });
      }
    });
  });
  t.after(async () => {
    await session.close();
    for (const socket of hub.clients) socket.terminate();
    await new Promise<void>((resolve) => hub.close(() => resolve()));
  });
  await session.open("reader", "FAKE_ACTOR_CREDENTIAL");
  assert.equal(session.alias("hub:messages", "messages"), "actual_inbox_alias");
  assert.deepEqual(
    (await session.call(session.alias("hub:messages", "messages"), { unread: true, wait: 0 }))
      .structuredContent,
    { messages: [], cursor: 0 },
  );
  for (const [index, request] of [
    {
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "rogue", version: "1" },
      },
    },
    { method: "tools/list", params: {} },
    ...["run", "status", "steer", "interrupt", "approval", "terminal"].map((name) => ({
      method: "tools/call",
      params: { name, arguments: {} },
    })),
  ].entries()) {
    const id = `reverse-${index}`;
    peer.send(JSON.stringify({ jsonrpc: "2.0", id, ...request }));
    for (let tries = 0; tries < 100 && !answers.has(id); tries++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(answers.get(id)?.error?.code, -32601);
  }
});
