import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import WebSocket from "ws";
import { CodexBackend } from "../src/codex/index.js";
import { RuntimeStore } from "../src/runtime/index.js";
import { SetupService } from "../src/setup/index.js";

class HeldPeer extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  initializeId?: number;
  closes = 0;
  kills = 0;
  constructor(readonly endpoint: string) {
    super();
  }
  send(raw: string, callback?: (error?: Error) => void) {
    const frame = JSON.parse(raw);
    if (frame.method === "initialize") this.initializeId = frame.id;
    else if (frame.id)
      queueMicrotask(() =>
        this.emit(
          "message",
          JSON.stringify({ id: frame.id, result: { thread: { id: this.endpoint } } }),
        ),
      );
    callback?.();
  }
  release() {
    this.emit("message", JSON.stringify({ id: this.initializeId, result: {} }));
  }
  close() {
    this.closes++;
    this.readyState = WebSocket.CLOSING;
    // Hold the close event too: an in-flight initialize reply can still arrive late.
  }
}

for (const order of ["old-first", "new-first"])
  test(`Setup replaces a held backend initialization without reusing or overwriting it (${order})`, async (t) => {
    const root = mkdtempSync(join(tmpdir(), "orgactor-backend-"));
    const store = new RuntimeStore(root);
    const backend = new CodexBackend(store);
    const setup = new SetupService(store, backend);
    const peers: HeldPeer[] = [];
    (backend as any).transport = (config: { endpoint: string }) => {
      const peer = new HeldPeer(config.endpoint);
      peers.push(peer);
      return { ws: peer, process: { kill: () => peer.kills++ } };
    };
    t.after(() => {
      backend.close();
      for (const peer of peers) {
        peer.release();
        peer.emit("close");
      }
      rmSync(root, { recursive: true, force: true });
    });
    const a = "ws://127.0.0.1:1111";
    const b = "ws://127.0.0.1:2222";
    setup.configure({ backend: { kind: "app-server", endpoint: a } });
    const oldProbe = setup.probe("backend");
    const oldOutcome = backend.get().then(
      (value) => ({ value, error: undefined }),
      (error) => ({ value: undefined, error }),
    );
    await new Promise(setImmediate);
    assert.equal(peers.length, 1);
    assert.ok(peers[0].initializeId);
    const oldRevision = store.data.revision;
    setup.configure({ backend: { kind: "app-server", endpoint: b } });
    assert.equal(peers[0].closes, 1);
    assert.equal(peers[0].kills, 1);
    const currentProbe = setup.probe("backend");
    const current = backend.get();
    await new Promise(setImmediate);
    assert.equal(peers.length, 2);
    assert.equal(peers[1].endpoint, b);
    const settleOld = async () => {
      peers[0].release();
      assert.equal((await oldOutcome).error?.code, "BACKEND_UNREACHABLE");
      assert.equal((await oldProbe).revision, oldRevision);
    };
    const settleCurrent = async () => {
      peers[1].release();
      assert.equal((await current).protocol.ws, peers[1]);
      assert.equal((await currentProbe).state, "ready");
    };
    if (order === "old-first") {
      await settleOld();
      const sharedCurrent = backend.get();
      assert.equal(peers.length, 2, "old completion must not clear the new pending connection");
      await settleCurrent();
      assert.equal(await sharedCurrent, await current);
    } else {
      await settleCurrent();
      await settleOld();
    }
    assert.equal(peers[1].closes, 0);
    assert.equal(peers[1].kills, 0);
    assert.equal(await backend.get(), await current);
    assert.equal(peers.length, 2);
    const execution = await setup.executionAdapter();
    assert.equal((await execution.read("owned")).thread.id, b);
    assert.equal(store.data.probes.backend?.revision, oldRevision + 1);
    assert.equal(store.data.probes.backend?.state, "ready");
    assert.equal(peers[0].closes, 1);
    backend.close();
    assert.equal(peers[1].closes, 1);
    assert.equal(peers[1].kills, 1);
  });
