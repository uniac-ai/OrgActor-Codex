import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AppServerAdapter } from "../src/codex/index.js";
import { Fault } from "../src/management/schema.js";
import { CodexProvider } from "../src/provider/index.js";
import { RuntimeStore } from "../src/runtime/index.js";
import { GuideService, hasAdapter } from "../src/setup/guide.js";
import { SetupService } from "../src/setup/index.js";
import { controlSocket, type ThisMac } from "../src/setup/this-mac.js";

const temp = (t: test.TestContext, name: string) => {
  const dir = mkdtempSync(join(tmpdir(), `orgactor-${name}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

function fakeMac(home: string, overrides: Partial<ThisMac> = {}): ThisMac & { starts: number } {
  const codex = join(home, "bin", "codex");
  mkdirSync(join(home, "bin"), { recursive: true });
  writeFileSync(codex, "#!/bin/sh\n", { mode: 0o755 });
  const mac = {
    platform: "darwin" as NodeJS.Platform,
    home,
    codex: [join(home, "absent", "codex"), codex],
    starts: 0,
    startDaemon: async () => {
      mac.starts++;
      return controlSocket(home);
    },
    ...overrides,
  };
  return mac;
}

/** A Codex app server on this Mac: its projects and the Actor's tools. */
function fakeCodex() {
  const native = {
    up: false,
    signedIn: false,
    projects: [] as { id: string; name: string; roots: { path: string }[] }[],
    creates: true,
    refuse: true,
    frames: [] as { method: string; params: any }[],
  };
  const adapter = new AppServerAdapter({
    request: async (method: string, params: any) => {
      native.frames.push({ method, params });
      switch (method) {
        case "account/read":
          return { account: native.signedIn ? { type: "chatgpt" } : null };
        case "account/rateLimits/read":
          return { ordinaryUsageAllowed: true };
        case "project/list":
          return { data: native.projects, nextCursor: null };
        case "project/create": {
          if (!native.creates) throw new Fault("NATIVE_REJECTED", "Codex rejected it.", 422);
          const project = { id: "project", name: params.name, roots: params.roots };
          native.projects.push(project);
          return { project };
        }
        case "thread/start":
          if (native.refuse) throw new Fault("NATIVE_REJECTED", "Codex rejected it.", 422);
          return { thread: { id: params.ephemeral ? "ephemeral" : "created" } };
        case "thread/unsubscribe":
          return { status: "unsubscribed" };
        case "mcpServerStatus/list":
          return { data: [{ name: "org", tools: { t: {} } }] };
      }
      throw new Error(`Unexpected ${method}`);
    },
  } as any);
  const backend = {
    close: () => {},
    get: async () => {
      if (!native.up)
        throw new Fault("BACKEND_UNREACHABLE", "The Codex backend could not be reached.", 503);
      return adapter;
    },
  };
  return { native, adapter, backend };
}

const connected = (store: RuntimeStore) => ({
  snapshot: () => ({ enabled: true, connected: true, state: "connected" as const }),
  setEnabled: async (enabled: boolean) => {
    store.data.providerEnabled = enabled;
  },
});

test("a folder's own Codex config connecting AgentOrg's adapter is recognized", (t) => {
  const root = temp(t, "folder");
  mkdirSync(join(root, ".codex"));
  const config = (text: string) => {
    writeFileSync(join(root, ".codex", "config.toml"), text);
    return hasAdapter(root);
  };
  assert.equal(hasAdapter(root), false);
  for (const text of [
    '[mcp_servers.org]\ncommand = "agentorg-mcp"',
    '[mcp_servers."org"]',
    "  [ mcp_servers.org.env ]",
    'mcp_servers.org.command = "agentorg-mcp"',
  ])
    assert.equal(config(text), true, text);
  for (const text of ["[mcp_servers.organizer]", "# [mcp_servers.org]", "[mcp_servers.other]"])
    assert.equal(config(text), false, text);
});

test("the guide walks only what the Provider needs to run, in order", async (t) => {
  const home = temp(t, "home");
  const mac = fakeMac(home);
  const store = new RuntimeStore(join(temp(t, "runtime"), "runtime"));
  store.data.settings.hub = { url: "http://127.0.0.1:1", providerId: "codex" };
  const { native, backend } = fakeCodex();
  const setup = new SetupService(store, backend as any);
  const guide = new GuideService(store, setup, backend, connected(store), mac);
  guide.bridgeUrl = "http://127.0.0.1:8788/mcp";
  const at = async (id: string) => {
    const report = await guide.check(true);
    const step = report.steps.find((s) => s.id === id);
    assert.ok(step);
    const blocked = report.steps.slice(report.steps.indexOf(step) + 1);
    if (step.state !== "done")
      assert.ok(blocked.every((s) => s.state === "waiting" && s.details?.on === id));
    return step;
  };

  assert.equal((await at("hub")).code, "PROVIDER_ADMITTED");
  assert.deepEqual(await at("codex"), {
    id: "codex",
    state: "missing",
    code: "CODEX_NOT_IN_USE",
    details: { socket: controlSocket(home) },
  });
  await guide.useThisMac();
  assert.equal(mac.starts, 1, "the app server is started before it becomes the backend");
  assert.deepEqual(store.data.settings.backend, {
    kind: "app-server",
    endpoint: `unix://${controlSocket(home)}`,
  });
  assert.equal(store.data.settings.bridgeUrl, "http://127.0.0.1:8788/mcp");
  assert.equal(store.data.providerEnabled, true, "the Provider is resumed after the change");
  assert.equal(guide.inUse, true);
  assert.equal((await at("codex")).code, "CODEX_UNREACHABLE");
  native.up = true;
  assert.equal((await at("codex")).code, "APP_SERVER_INITIALIZED");
  assert.equal((await at("account")).code, "CHATGPT_SIGN_IN_REQUIRED");
  native.signedIn = true;
  assert.equal((await at("account")).code, "PLAN_USAGE_ALLOWED");

  assert.deepEqual((await at("folder")).details, { suggested: join(home, "agentorg-codex") });
  await assert.rejects(guide.admitAttach(), (e: Fault) => e.code === "SETUP_INCOMPLETE");
  const root = join(home, "agentorg-codex");
  await guide.chooseFolder(root);
  assert.equal((await at("folder")).code, "FOLDER_MISSING");
  guide.createFolder();
  // The Provider files the folder as a project itself, so Desktop can list its sessions there.
  assert.equal((await at("folder")).code, "PREFLIGHT_REFUSED");
  assert.deepEqual(native.frames.find((f) => f.method === "project/create")?.params, {
    idempotencyKey: `agentorg:${root}`,
    name: "agentorg-codex",
    roots: [{ path: root }],
  });
  native.refuse = false;
  assert.deepEqual((await at("folder")).details, { path: root, project: "agentorg-codex" });
  assert.equal(native.frames.filter((f) => f.method === "project/create").length, 1);
  const preflight = native.frames.findLast((f) => f.method === "thread/start");
  assert.equal(preflight?.params.ephemeral, true);
  assert.equal(native.frames.at(-1)?.method, "thread/unsubscribe");
  assert.equal((await at("actor")).code, "NO_ACTOR");
  await guide.admitAttach();

  store.data.journal["http://127.0.0.1:1|codex|act"] = {
    fingerprint: "f",
    state: "ready",
    threadId: "thread",
  };
  store.data.actors.act = {
    actorId: "act",
    hubUrl: "http://127.0.0.1:1",
    threadId: "thread",
    bridgeToken: "private",
    enabled: true,
    config: {},
    submissions: [],
  };
  assert.equal((await at("tools")).code, "ACTOR_TOOLS_READY");
  native.up = false;
  assert.equal((await at("codex")).code, "CODEX_UNREACHABLE");

  await assert.rejects(
    guide.chooseFolder(join(home, "other")),
    (e: Fault) => e.code === "EXECUTION_CONFIG_BOUND",
  );
});

test("Codex's app server is started before each connect only while it is the backend", async (t) => {
  const home = temp(t, "home");
  const mac = fakeMac(home);
  const store = new RuntimeStore(join(temp(t, "runtime"), "runtime"));
  const { backend } = fakeCodex();
  const guide = new GuideService(
    store,
    new SetupService(store, backend as any),
    backend,
    connected(store),
    mac,
  );
  await guide.prepare();
  store.data.settings.backend = { kind: "app-server", endpoint: "unix:///elsewhere.sock" };
  await guide.prepare();
  assert.equal(mac.starts, 0);
  store.data.settings.backend = { kind: "app-server", endpoint: guide.endpoint };
  await guide.prepare();
  assert.equal(mac.starts, 1);
});

test("a new session is saved, named and filed under its folder's project at creation", async () => {
  const frames: { method: string; params: any }[] = [];
  const adapter = new AppServerAdapter({
    request: async (method: string, params: any) => {
      frames.push({ method, params });
      if (method === "thread/start") return { thread: { id: "created" } };
      if (method === "project/list")
        return {
          data: [
            { id: "other", name: "Other", roots: [{ path: "/elsewhere" }] },
            { id: "project", name: "Codex Actor", roots: [{ path: "/owned" }] },
          ],
          nextCursor: null,
        };
      return {};
    },
  } as any);
  const id = await adapter.create({
    cwd: "/owned",
    bridgeUrl: "http://127.0.0.1/mcp",
    bridgeToken: "private",
    name: "AgentOrg act",
  });
  assert.equal(id, "created");
  assert.deepEqual(
    frames.slice(1).map((f) => [f.method, f.params]),
    [
      ["thread/name/set", { threadId: "created", name: "AgentOrg act" }],
      ["project/list", { limit: 100 }],
      ["thread/metadata/update", { threadId: "created", projectId: "project" }],
    ],
  );
  // A folder without a project gets one, under a key that makes a retry return the same one.
  frames.length = 0;
  const filing = new AppServerAdapter({
    request: async (method: string, params: any) => {
      frames.push({ method, params });
      if (method === "thread/start") return { thread: { id: "created" } };
      if (method === "project/list") return { data: [], nextCursor: null };
      if (method === "project/create") return { project: { id: "new", name: params.name } };
      return {};
    },
  } as any);
  await filing.create({
    cwd: "/owned/folder",
    bridgeUrl: "http://x/mcp",
    bridgeToken: "p",
    name: "n",
  });
  assert.deepEqual(
    frames.slice(2).map((f) => [f.method, f.params]),
    [
      ["project/list", { limit: 100 }],
      [
        "project/create",
        {
          idempotencyKey: "agentorg:/owned/folder",
          name: "folder",
          roots: [{ path: "/owned/folder" }],
        },
      ],
      ["thread/metadata/update", { threadId: "created", projectId: "new" }],
    ],
  );
  // Placing it is best effort: a refusal leaves the working session as it is.
  const refusing = new AppServerAdapter({
    request: async (method: string) => {
      if (method === "thread/start") return { thread: { id: "created" } };
      throw new Fault("NATIVE_REJECTED", "Codex rejected it.", 422);
    },
  } as any);
  assert.equal(
    await refusing.create({
      cwd: "/owned",
      bridgeUrl: "http://x/mcp",
      bridgeToken: "p",
      name: "n",
    }),
    "created",
  );
});

test("the folder step passes without a project when Codex can't create one", async (t) => {
  const home = temp(t, "home");
  const store = new RuntimeStore(join(temp(t, "runtime"), "runtime"));
  const { native, backend } = fakeCodex();
  Object.assign(native, { up: true, signedIn: true, creates: false, refuse: false });
  const guide = new GuideService(
    store,
    new SetupService(store, backend as any),
    backend,
    connected(store),
    fakeMac(home),
  );
  guide.bridgeUrl = "http://127.0.0.1:8788/mcp";
  await guide.useThisMac();
  const root = join(home, "agentorg-codex");
  await guide.chooseFolder(root);
  guide.createFolder();
  const folder = (await guide.check(true)).steps.find((s) => s.id === "folder");
  assert.deepEqual(folder, {
    id: "folder",
    state: "done",
    code: "FOLDER_READY",
    details: { path: root },
  });
});

test("the guide is offered only on a Mac", async (t) => {
  const home = temp(t, "home");
  const store = new RuntimeStore(join(temp(t, "runtime"), "runtime"));
  const { backend } = fakeCodex();
  const guide = new GuideService(
    store,
    new SetupService(store, backend as any),
    backend,
    connected(store),
    fakeMac(home, { platform: "linux" }),
  );
  const report = await guide.check();
  assert.equal(report.available, false);
  assert.deepEqual(report.steps, []);
  await assert.rejects(guide.useThisMac(), (e: Fault) => e.code === "THIS_MAC_UNAVAILABLE");
  await guide.admitAttach();
});

test("Detach Actor forgets the Actor here and keeps its Hub identity, so setup can change", async (t) => {
  const store = new RuntimeStore(join(temp(t, "runtime"), "runtime"));
  const stopped: string[] = [];
  const provider = new CodexProvider(
    store,
    async () => Promise.reject(new Error("unused")),
    () => {},
    async (id) => {
      stopped.push(id);
    },
  );
  const setup = new SetupService(store, { close: () => {} } as any);
  const bootstrap = (actorId: string, threadId: string) => ({
    actorId,
    hubUrl: "http://hub",
    threadId,
    bridgeToken: "private",
    enabled: true,
    config: {},
    submissions: [],
  });
  store.data.providerEnabled = false;
  store.data.actors.failed = { ...bootstrap("failed", ""), enabled: false };
  store.data.journal["http://hub|codex|failed"] = { fingerprint: "f", state: "failed" };
  store.data.actors.ready = bootstrap("ready", "thread");
  store.data.journal["http://hub|codex|ready"] = {
    fingerprint: "g",
    state: "ready",
    threadId: "thread",
  };
  store.data.journal["http://hub|codex|pending"] = { fingerprint: "h", state: "creating" };
  await assert.rejects(provider.detach("absent"), (e: Fault) => e.code === "ACTOR_NOT_FOUND");
  await assert.rejects(provider.detach("pending"), (e: Fault) => e.code === "CREATION_IN_PROGRESS");

  await provider.detach("failed");
  assert.equal(store.data.actors.failed, undefined);
  assert.equal(store.data.journal["http://hub|codex|failed"], undefined);
  await provider.detach("ready");
  assert.deepEqual(stopped, ["failed", "ready"]);
  assert.throws(
    () => setup.configure({ workspaceRoot: "/elsewhere" }),
    (e: Fault) => e.code === "EXECUTION_CONFIG_BOUND",
  );
  delete store.data.journal["http://hub|codex|pending"];
  setup.configure({ workspaceRoot: "/elsewhere" });
  assert.equal(store.data.settings.workspaceRoot, "/elsewhere");
});

test("folder paths must be in their plain form, and the disconnect command is quoted", async (t) => {
  const home = temp(t, "home");
  const store = new RuntimeStore(join(temp(t, "runtime"), "runtime"));
  const { native, backend } = fakeCodex();
  native.up = true;
  const guide = new GuideService(
    store,
    new SetupService(store, backend as any),
    backend,
    connected(store),
    fakeMac(home),
  );
  for (const path of [`${home}/folder/`, `${home}/a/../folder`, `${home}/fol\nder`, "folder"])
    await assert.rejects(guide.chooseFolder(path), (e: Fault) => e.code === "FOLDER_INVALID", path);
  const trial = join(home, "My Projects", "it's here");
  mkdirSync(join(trial, ".codex"), { recursive: true });
  writeFileSync(join(trial, ".codex", "config.toml"), "[mcp_servers.org]\n");
  await assert.rejects(guide.chooseFolder(trial), (e: Fault) => e.code === "FOLDER_HAS_ADAPTER");
  store.data.settings.workspaceRoot = trial;
  const folder = await (guide as any).folder();
  assert.equal(
    folder.details.disconnect,
    `agentorg-mcp disconnect codex --project '${join(home, "My Projects")}/it'\\''s here'`,
  );
});

test("setup changes run one at a time, so concurrent ones keep each other's settings", async (t) => {
  const home = temp(t, "home");
  const store = new RuntimeStore(join(temp(t, "runtime"), "runtime"));
  store.data.settings.hub = { url: "http://127.0.0.1:1", providerId: "codex" };
  const { backend } = fakeCodex();
  const provider = {
    snapshot: () => ({ enabled: true, connected: true, state: "connected" as const }),
    setEnabled: async (enabled: boolean) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      store.data.providerEnabled = enabled;
    },
  };
  const guide = new GuideService(
    store,
    new SetupService(store, backend as any),
    backend,
    provider,
    fakeMac(home),
  );
  await Promise.all([guide.chooseFolder(join(home, "agentorg-codex")), guide.useThisMac()]);
  assert.equal(store.data.settings.workspaceRoot, join(home, "agentorg-codex"));
  assert.equal(store.data.settings.backend?.endpoint, guide.endpoint);
  assert.equal(store.data.providerEnabled, true);
  assert.equal(
    existsSync(join(home, "agentorg-codex")),
    false,
    "choosing a folder creates nothing",
  );
});
