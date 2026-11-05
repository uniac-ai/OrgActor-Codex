import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AppServerAdapter } from "../src/codex/index.js";
import { Fault } from "../src/management/schema.js";
import { CodexProvider } from "../src/provider/index.js";
import { RuntimeStore } from "../src/runtime/index.js";
import { ed25519, type ThisMac, ThisMacAccess } from "../src/setup/access.js";
import { desktopProject, GuideService, hasAdapter } from "../src/setup/guide.js";
import { SetupService } from "../src/setup/index.js";

const temp = (t: test.TestContext, name: string) => {
  const dir = mkdtempSync(join(tmpdir(), `orgactor-${name}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

/** Desktop's `codex --version` answers; `ssh -G` is real, since it only reads the config. */
const fakeSsh = async (args: string[]) =>
  args[0] === "-G"
    ? { code: 0, stdout: execFileSync("ssh", args, { encoding: "utf8", stdio: "pipe" }) }
    : { code: 0, stdout: "codex-cli 1.2.3\n" };

function fakeMac(home: string, overrides: Partial<ThisMac> = {}): ThisMac {
  const hostKey = join(home, "ssh_host_ed25519_key.pub");
  writeFileSync(hostKey, `${ed25519("host").public} root@mac\n`);
  const codex = join(home, "bin", "codex");
  mkdirSync(join(home, "bin"));
  writeFileSync(codex, "#!/bin/sh\n", { mode: 0o755 });
  return {
    platform: "darwin",
    home,
    user: "person",
    shell: "/bin/zsh",
    hostKey,
    codex: [join(home, "absent", "codex"), codex],
    sshPort: 22,
    desktopState: join(home, ".codex-global-state.json"),
    ssh: fakeSsh,
    ...overrides,
  };
}

test("a guided key is OpenSSH's own: ssh-keygen derives its public key and fingerprint", (t) => {
  const dir = temp(t, "key");
  const key = ed25519("orgactor-codex test");
  writeFileSync(join(dir, "key"), key.private, { mode: 0o600 });
  const derived = execFileSync("ssh-keygen", ["-y", "-f", join(dir, "key")], { encoding: "utf8" });
  assert.equal(derived.trim().split(" ").slice(0, 2).join(" "), key.public);
  const listed = execFileSync("ssh-keygen", ["-l", "-f", join(dir, "key")], { encoding: "utf8" });
  assert.equal(listed.split(" ")[1], key.fingerprint);
});

for (const start of ["existing", "none"] as const)
  test(`SSH access is written only from its review and removed exactly (${start} ~/.ssh)`, (t) => {
    const home = temp(t, "home");
    const root = join(temp(t, "runtime"), "runtime");
    const mac = fakeMac(home);
    const ssh = join(home, ".ssh");
    const before = {
      config: "Host other\n  User someone",
      authorizedKeys: "ssh-ed25519 AAAAexisting person@laptop\n",
    };
    if (start === "existing") {
      mkdirSync(ssh, { mode: 0o700 });
      writeFileSync(join(ssh, "config"), before.config);
      writeFileSync(join(ssh, "authorized_keys"), before.authorizedKeys, { mode: 0o600 });
    }
    const store = new RuntimeStore(root);
    const access = new ThisMacAccess(store, mac);
    const plan = access.plan();
    assert.equal(existsSync(join(root, "ssh")), false, "a review writes nothing");
    assert.doesNotMatch(JSON.stringify(plan), /PRIVATE KEY/);
    const actions = plan.writes.map((w) => w.action);
    assert.deepEqual(
      actions,
      start === "existing"
        ? ["key", "file", "key", "file", "file", "append", "backup", "append", "backend"]
        : ["key", "file", "key", "file", "file", "directory", "append", "append", "backend"],
    );
    const authorized = plan.writes.find(
      (w) => w.action === "append" && w.path.endsWith("authorized_keys"),
    );
    assert.ok(authorized?.action === "append");
    assert.match(
      authorized.lines[1],
      new RegExp(
        `^restrict,from="127.0.0.1,::1",command="exec ${mac.codex[1]} app-server proxy" ssh-ed25519 `,
      ),
    );
    assert.match(
      authorized.lines[2],
      /no-agent-forwarding,no-port-forwarding,no-X11-forwarding,no-user-rc,command=/,
    );

    const backend = access.apply(plan.id);
    assert.throws(
      () => access.apply(plan.id),
      (e: Fault) => e.code === "PLAN_STALE",
    );
    assert.match(backend.privateKey, /BEGIN OPENSSH PRIVATE KEY/);
    assert.match(backend.knownHosts, /^127\.0\.0\.1 ssh-ed25519 /);
    const config = readFileSync(join(ssh, "config"), "utf8");
    const keys = readFileSync(join(ssh, "authorized_keys"), "utf8");
    if (start === "existing") {
      // Before the first Host line, so no earlier block takes this-mac's options first.
      assert.ok(config.startsWith(`# BEGIN OrgActor-Codex ${root}\nHost this-mac\n`));
      assert.ok(config.endsWith(`# END OrgActor-Codex ${root}\n${before.config}`));
      assert.ok(keys.startsWith(before.authorizedKeys));
      const backup = plan.writes.find((w) => w.action === "backup");
      assert.ok(backup && readFileSync(backup.path, "utf8") === before.config);
    } else assert.equal(statSync(ssh).mode & 0o777, 0o700);
    assert.equal(statSync(join(ssh, "authorized_keys")).mode & 0o777, 0o600);
    assert.equal(statSync(join(root, "ssh", "desktop")).mode & 0o777, 0o600);
    assert.equal(statSync(join(root, "ssh", "desktop-shell")).mode & 0o777, 0o700);
    // The Provider's own key and known host, which its SSH backend connects with, are in the review.
    assert.equal(statSync(join(root, "ssh-key")).mode & 0o777, 0o600);
    assert.equal(statSync(join(root, "known-hosts")).mode & 0o777, 0o600);
    assert.deepEqual(access.inspect().present, {
      authorizedKeys: true,
      config: true,
      files: true,
      backend: false,
    });
    assert.throws(
      () => access.plan(),
      (e: Fault) => e.code === "ACCESS_PRESENT",
    );

    // The person's own line after the block is kept.
    if (start === "existing") writeFileSync(join(ssh, "config"), `${config}\nHost later\n`);
    access.remove();
    assert.equal(store.data.access, undefined);
    for (const left of ["ssh", "ssh-key", "known-hosts"])
      assert.equal(existsSync(join(root, left)), false, left);
    if (start === "existing") {
      assert.equal(readFileSync(join(ssh, "config"), "utf8"), `${before.config}\nHost later\n`);
      assert.equal(readFileSync(join(ssh, "authorized_keys"), "utf8"), before.authorizedKeys);
    } else assert.equal(existsSync(ssh), false, "the folder it created goes too");
  });

test("removing access right after writing it restores ~/.ssh byte for byte and drops the backup", (t) => {
  const home = temp(t, "home");
  const store = new RuntimeStore(join(temp(t, "runtime"), "runtime"));
  const access = new ThisMacAccess(store, fakeMac(home));
  mkdirSync(join(home, ".ssh"));
  writeFileSync(join(home, ".ssh", "config"), "Include extra");
  const plan = access.plan();
  access.apply(plan.id);
  access.remove();
  assert.equal(readFileSync(join(home, ".ssh", "config"), "utf8"), "Include extra");
  assert.equal(existsSync(join(home, ".ssh", "authorized_keys")), false);
  const backup = plan.writes.find((w) => w.action === "backup");
  assert.ok(backup && !existsSync(backup.path));
});

test("a this-mac host the guide didn't write is a conflict, and nothing is planned over it", (t) => {
  const home = temp(t, "home");
  const access = new ThisMacAccess(
    new RuntimeStore(join(temp(t, "runtime"), "runtime")),
    fakeMac(home),
  );
  mkdirSync(join(home, ".ssh"));
  writeFileSync(join(home, ".ssh", "config"), "Host laptop this-mac\n  HostName 10.0.0.2\n");
  assert.equal(access.inspect().conflict, join(home, ".ssh", "config"));
  assert.throws(
    () => access.plan(),
    (e: Fault) => e.code === "ACCESS_UNAVAILABLE",
  );
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

test("the guide walks the steps in order, each waiting on the one before", async (t) => {
  const home = temp(t, "home");
  const root = join(temp(t, "runtime"), "runtime");
  const closed = createServer();
  await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
  const port = (closed.address() as any).port as number;
  await new Promise((resolve) => closed.close(resolve));
  const mac = fakeMac(home, { sshPort: port });
  const store = new RuntimeStore(root);
  store.data.settings.hub = { url: "http://127.0.0.1:1", providerId: "codex" };
  const frames: { method: string; params: any }[] = [];
  const native = { desktop: false, open: [] as string[], refuse: true };
  const adapter = new AppServerAdapter({
    request: async (method: string, params: any) => {
      frames.push({ method, params });
      if (method === "project/list")
        return { data: native.open.map((path) => ({ roots: [{ path }] })), nextCursor: null };
      if (method === "thread/start") {
        if (native.refuse) throw new Fault("NATIVE_REJECTED", "Codex rejected the operation.", 422);
        return { thread: { id: "ephemeral" } };
      }
      if (method === "thread/unsubscribe") return { status: "unsubscribed" };
      if (method === "mcpServerStatus/list") return { data: [{ name: "org", tools: { t: {} } }] };
      throw new Error(`Unexpected ${method}`);
    },
  } as any);
  const backend = {
    close: () => {},
    get: async () => {
      if (!native.desktop)
        throw new Fault("BACKEND_UNREACHABLE", "The Codex backend could not be reached.", 503);
      return adapter;
    },
  };
  const provider = {
    snapshot: () => ({ enabled: true, connected: true, state: "connected" as const }),
    setEnabled: async (enabled: boolean) => {
      store.data.providerEnabled = enabled;
    },
  };
  const setup = new SetupService(store, backend as any);
  const guide = new GuideService(store, setup, backend, provider, mac);
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
  assert.equal((await at("login")).code, "REMOTE_LOGIN_OFF");
  const sshd = createServer((socket) => socket.end());
  await new Promise<void>((resolve) => sshd.listen(port, "127.0.0.1", resolve));
  t.after(() => sshd.close());
  assert.equal((await at("access")).code, "ACCESS_MISSING");

  await guide.applyAccess(guide.planAccess().id);
  assert.equal(store.data.providerEnabled, true, "the Provider is resumed after the change");
  assert.equal(store.data.settings.backend?.kind, "ssh");
  assert.equal(store.data.settings.bridgeUrl, "http://127.0.0.1:8788/mcp");
  assert.equal(guide.inUse, true);
  assert.deepEqual(await at("access"), {
    id: "access",
    state: "done",
    code: "ACCESS_READY",
    details: { alias: "this-mac", user: "person", codex: "codex-cli 1.2.3" },
  });
  assert.equal((await at("desktop")).code, "DESKTOP_NOT_CONNECTED");
  native.desktop = true;
  assert.deepEqual((await at("folder")).details, { suggested: join(home, "agentorg-codex") });
  await assert.rejects(guide.admitAttach(), (e: Fault) => e.code === "SETUP_INCOMPLETE");

  const trial = join(home, "trial");
  mkdirSync(join(trial, ".codex"), { recursive: true });
  writeFileSync(
    join(trial, ".codex", "config.toml"),
    '[mcp_servers.org]\ncommand = "agentorg-mcp"\n',
  );
  await assert.rejects(guide.chooseFolder(trial), (e: Fault) => e.code === "FOLDER_HAS_ADAPTER");
  assert.equal(store.data.settings.workspaceRoot, undefined);
  const dedicated = join(home, "agentorg-codex");
  await guide.chooseFolder(dedicated);
  assert.equal((await at("folder")).code, "FOLDER_MISSING");
  guide.createFolder();
  // Before Desktop's records can be read, the step can't tell, rather than calling it missing.
  assert.deepEqual(await at("folder"), {
    id: "folder",
    state: "broken",
    code: "DESKTOP_PROJECTS_UNKNOWN",
    details: { path: dedicated, alias: "this-mac", state: mac.desktopState },
  });
  writeFileSync(mac.desktopState, JSON.stringify({ "remote-projects": [] }));
  assert.equal((await at("folder")).code, "FOLDER_NOT_IN_DESKTOP");
  // A local project in Desktop doesn't count: the Actor's session runs on this-mac's Codex.
  const desktop = (state: object) => writeFileSync(mac.desktopState, JSON.stringify(state));
  desktop({
    "remote-projects": [],
    "local-projects": { p: { name: "Codex Actor", rootPaths: [dedicated] } },
  });
  assert.deepEqual(await at("folder"), {
    id: "folder",
    state: "missing",
    code: "FOLDER_LOCAL_PROJECT",
    details: { path: dedicated, alias: "this-mac", project: "Codex Actor" },
  });
  desktop({
    "codex-managed-remote-connections": [{ hostId: "ssh:7", alias: "this-mac" }],
    "remote-projects": [{ hostId: "ssh:7", remotePath: `${dedicated}/`, label: "Actor" }],
  });
  assert.equal((await at("folder")).code, "PREFLIGHT_REFUSED");
  native.refuse = false;
  assert.deepEqual((await at("folder")).details, {
    path: dedicated,
    alias: "this-mac",
    project: "Actor",
  });
  const preflight = frames.findLast((f) => f.method === "thread/start");
  assert.equal(preflight?.params.ephemeral, true);
  assert.equal(preflight?.params.cwd, dedicated);
  assert.equal(preflight?.params.config["mcp_servers.org"].url, "http://127.0.0.1:8788/mcp");
  assert.equal(frames.at(-1)?.method, "thread/unsubscribe");
  assert.equal((await at("actor")).code, "NO_ACTOR");
  await guide.admitAttach();

  store.data.journal["http://127.0.0.1:1|codex|act"] = { fingerprint: "f", state: "failed" };
  assert.deepEqual((await at("actor")).details, { actorId: "act", outcome: "failed" });
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
    config: { approvalAuthority: "desktop" },
    submissions: [],
  };
  assert.deepEqual((await at("session")).details, {
    alias: "this-mac",
    path: dedicated,
    project: "Actor",
    actorId: "act",
    threadId: "thread",
  });
  store.data.probes.desktop = {
    state: "ready",
    code: "OPERATOR_CONFIRMED_DESKTOP",
    revision: store.data.revision,
    checkedAt: new Date().toISOString(),
    details: { threadId: "thread" },
  };
  const ready = await guide.check(true);
  assert.deepEqual(
    ready.steps.map((s) => s.code),
    [
      "PROVIDER_ADMITTED",
      "REMOTE_LOGIN_ON",
      "ACCESS_READY",
      "APP_SERVER_INITIALIZED",
      "FOLDER_READY",
      "ACTOR_ATTACHED",
      "SESSION_CONFIRMED",
      "ACTOR_TOOLS_READY",
    ],
  );
  await assert.rejects(guide.removeAccess(), (e: Fault) => e.code === "EXECUTION_CONFIG_BOUND");
  await assert.rejects(guide.chooseFolder(trial), (e: Fault) => e.code === "FOLDER_HAS_ADAPTER");
  await assert.rejects(
    guide.chooseFolder(join(home, "other")),
    (e: Fault) => e.code === "EXECUTION_CONFIG_BOUND",
  );

  delete store.data.actors.act;
  store.data.journal = {};
  await guide.removeAccess();
  assert.equal(store.data.settings.backend, undefined);
  assert.equal(store.data.settings.workspaceRoot, dedicated);
  assert.equal(existsSync(join(home, ".ssh")), false);
  assert.equal((await at("access")).code, "ACCESS_MISSING");
});

test("the guide is offered only on a Mac", async (t) => {
  const home = temp(t, "home");
  const store = new RuntimeStore(join(temp(t, "runtime"), "runtime"));
  const backend = { close: () => {}, get: async () => Promise.reject(new Error("unused")) };
  const provider = {
    snapshot: () => ({ enabled: true, connected: false, state: "unconfigured" as const }),
    setEnabled: async () => {},
  };
  const guide = new GuideService(
    store,
    new SetupService(store, backend as any),
    backend as any,
    provider,
    fakeMac(home, { platform: "linux" }),
  );
  const report = await guide.check();
  assert.equal(report.available, false);
  assert.deepEqual(report.steps, []);
  assert.throws(
    () => guide.planAccess(),
    (e: Fault) => e.code === "THIS_MAC_UNAVAILABLE",
  );
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
    config: { approvalAuthority: "desktop" as const },
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
  store.data.probes.desktop = {
    state: "ready",
    code: "OPERATOR_CONFIRMED_DESKTOP",
    revision: store.data.revision,
    checkedAt: new Date().toISOString(),
    details: { threadId: "thread" },
  };
  await assert.rejects(provider.detach("absent"), (e: Fault) => e.code === "ACTOR_NOT_FOUND");
  await assert.rejects(provider.detach("pending"), (e: Fault) => e.code === "CREATION_IN_PROGRESS");

  await provider.detach("failed");
  assert.equal(store.data.actors.failed, undefined);
  assert.equal(store.data.journal["http://hub|codex|failed"], undefined);
  assert.equal(store.data.probes.desktop?.code, "OPERATOR_CONFIRMED_DESKTOP");
  await provider.detach("ready");
  assert.deepEqual(stopped, ["failed", "ready"]);
  assert.equal(store.data.probes.desktop, undefined, "its session's confirmation goes with it");
  assert.throws(
    () => setup.configure({ workspaceRoot: "/elsewhere" }),
    (e: Fault) => e.code === "EXECUTION_CONFIG_BOUND",
  );
  delete store.data.journal["http://hub|codex|pending"];
  setup.configure({ workspaceRoot: "/elsewhere" });
  assert.equal(store.data.settings.workspaceRoot, "/elsewhere");
});

test("a review goes stale when ~/.ssh changes before the person confirms", (t) => {
  const home = temp(t, "home");
  const store = new RuntimeStore(join(temp(t, "runtime"), "runtime"));
  const access = new ThisMacAccess(store, fakeMac(home));
  mkdirSync(join(home, ".ssh"));
  writeFileSync(join(home, ".ssh", "config"), "Host other\n");
  const plan = access.plan();
  writeFileSync(join(home, ".ssh", "config"), "Host this-mac\n  HostName elsewhere\n");
  assert.throws(
    () => access.apply(plan.id),
    (e: Fault) => e.code === "PLAN_STALE",
  );
  assert.equal(
    readFileSync(join(home, ".ssh", "config"), "utf8"),
    "Host this-mac\n  HostName elsewhere\n",
  );
  assert.equal(existsSync(join(home, ".ssh", "authorized_keys")), false);
  assert.equal(store.data.access, undefined);
});

test("without its record, removal takes the blocks naming this runtime, so setup can start over", async (t) => {
  const home = temp(t, "home");
  const root = join(temp(t, "runtime"), "runtime");
  const mac = fakeMac(home);
  mkdirSync(join(home, ".ssh"));
  const before = { config: "Host other\n  User someone\n", keys: "ssh-ed25519 AAAAexisting a@b\n" };
  writeFileSync(join(home, ".ssh", "config"), before.config);
  writeFileSync(join(home, ".ssh", "authorized_keys"), before.keys);
  const first = new ThisMacAccess(new RuntimeStore(root), mac);
  first.apply(first.plan().id);
  // The runtime is moved aside and a fresh one starts at the same path, with no record.
  renameSync(root, `${root}-moved`);
  const store = new RuntimeStore(root);
  const backend = { close: () => {}, get: async () => Promise.reject(new Error("unused")) };
  const provider = {
    snapshot: () => ({ enabled: true, connected: true, state: "connected" as const }),
    setEnabled: async () => {},
  };
  const guide = new GuideService(
    store,
    new SetupService(store, backend as any),
    backend,
    provider,
    mac,
  );
  const sshd = createServer((socket) => socket.end());
  await new Promise<void>((resolve) => sshd.listen(0, "127.0.0.1", resolve));
  t.after(() => sshd.close());
  (mac as { sshPort: number }).sshPort = (sshd.address() as any).port;
  const access = (await guide.check(true)).steps.find((s) => s.id === "access");
  assert.equal(access?.code, "ACCESS_INCOMPLETE");
  assert.throws(
    () => guide.planAccess(),
    (e: Fault) => e.code === "ACCESS_PRESENT",
  );
  await guide.removeAccess();
  assert.equal(readFileSync(join(home, ".ssh", "config"), "utf8"), before.config);
  assert.equal(readFileSync(join(home, ".ssh", "authorized_keys"), "utf8"), before.keys);
  assert.equal(
    (await guide.check(true)).steps.find((s) => s.id === "access")?.code,
    "ACCESS_MISSING",
  );
  assert.ok(guide.planAccess().writes.length);
});

for (const earlier of ["Host *", "global"] as const)
  test(`an earlier ${earlier} option for this-mac is ${earlier === "Host *" ? "placed after the block" : "reported as overriding it"}`, async (t) => {
    const home = temp(t, "home");
    const store = new RuntimeStore(join(temp(t, "runtime"), "runtime"));
    const sshd = createServer((socket) => socket.end());
    await new Promise<void>((resolve) => sshd.listen(0, "127.0.0.1", resolve));
    t.after(() => sshd.close());
    const access = new ThisMacAccess(
      store,
      fakeMac(home, { sshPort: (sshd.address() as any).port }),
    );
    mkdirSync(join(home, ".ssh"));
    const overrides = "  StrictHostKeyChecking no\n  UserKnownHostsFile /dev/null\n";
    writeFileSync(
      join(home, ".ssh", "config"),
      earlier === "Host *"
        ? `Host *\n${overrides}`
        : `${overrides.replaceAll("  ", "")}Host *\n  User x\n`,
    );
    const plan = access.plan();
    const block = plan.writes.find((w) => w.action === "append" && w.path.endsWith("config"));
    assert.equal(block?.action === "append" && block.before, "Host *");
    const written = access.apply(plan.id);
    store.data.settings.backend = {
      kind: "ssh",
      host: "127.0.0.1",
      port: written.port,
      user: written.user,
      privateKey: written.privateKey,
      knownHosts: written.knownHosts,
    };
    const tested = await access.test();
    const overridden = earlier === "Host *" ? [] : ["stricthostkeychecking", "userknownhostsfile"];
    assert.deepEqual(tested.overridden, overridden);
    if (!overridden.length) return;
    const backend = { close: () => {}, get: async () => Promise.reject(new Error("unused")) };
    const provider = {
      snapshot: () => ({ enabled: true, connected: true, state: "connected" as const }),
      setEnabled: async () => {},
    };
    const guide = new GuideService(
      store,
      new SetupService(store, backend as any),
      backend,
      provider,
      access.mac,
    );
    const step = (await guide.check(true)).steps.find((s) => s.id === "access");
    assert.deepEqual(step, {
      id: "access",
      state: "broken",
      code: "ACCESS_OVERRIDDEN",
      details: { path: join(home, ".ssh", "config"), options: overridden },
    });
  });

test("folder paths must be in their plain form, and the disconnect command is quoted", async (t) => {
  const home = temp(t, "home");
  const store = new RuntimeStore(join(temp(t, "runtime"), "runtime"));
  const backend = { close: () => {}, get: async () => Promise.reject(new Error("unused")) };
  const provider = {
    snapshot: () => ({ enabled: true, connected: true, state: "connected" as const }),
    setEnabled: async () => {},
  };
  const guide = new GuideService(
    store,
    new SetupService(store, backend as any),
    backend,
    provider,
    fakeMac(home),
  );
  for (const path of [`${home}/folder/`, `${home}/a/../folder`, `${home}/fol\nder`, "folder"])
    await assert.rejects(guide.chooseFolder(path), (e: Fault) => e.code === "FOLDER_INVALID", path);
  const trial = join(home, "My Projects", "it's here");
  mkdirSync(join(trial, ".codex"), { recursive: true });
  writeFileSync(join(trial, ".codex", "config.toml"), "[mcp_servers.org]\n");
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
  const backend = { close: () => {}, get: async () => Promise.reject(new Error("unused")) };
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
  const plan = guide.planAccess();
  await Promise.all([guide.chooseFolder(join(home, "agentorg-codex")), guide.applyAccess(plan.id)]);
  assert.equal(store.data.settings.workspaceRoot, join(home, "agentorg-codex"));
  assert.equal(store.data.settings.backend?.kind, "ssh");
  assert.equal(store.data.providerEnabled, true);
});

test("only a project on this-mac's own connection counts as open in Desktop", (t) => {
  const dir = temp(t, "desktop");
  const state = join(dir, "state.json");
  const root = "/Users/person/agentorg-codex";
  assert.deepEqual(desktopProject(join(dir, "absent.json"), root), { known: false });
  writeFileSync(
    state,
    JSON.stringify({
      "remote-projects": [
        { hostId: "remote-ssh-discovered:elsewhere", remotePath: root, label: "Other host" },
        {
          hostId: "remote-ssh-discovered:this-mac",
          remotePath: `${root}-2`,
          label: "Other folder",
        },
      ],
      "local-projects": { a: { name: "Local", rootPaths: ["/x", root] } },
    }),
  );
  assert.deepEqual(desktopProject(state, root), { known: true, local: "Local" });
  writeFileSync(
    state,
    JSON.stringify({
      "remote-projects": [
        { hostId: "remote-ssh-discovered:this-mac", remotePath: root, label: "Trial" },
      ],
    }),
  );
  assert.deepEqual(desktopProject(state, root), { known: true, remote: "Trial" });
  // Desktop's records are private: missing, unreadable or another form means nothing is known.
  for (const unknown of [
    "{ not json",
    "{}",
    JSON.stringify({ "remote-projects": { a: { hostId: "x", remotePath: root } } }),
    JSON.stringify({ "remote-projects": [{ host: "remote-ssh-discovered:this-mac", path: root }] }),
    JSON.stringify({ "remote-projects": [], "local-projects": [root] }),
  ]) {
    writeFileSync(state, unknown);
    assert.deepEqual(desktopProject(state, root), { known: false }, unknown);
  }
  writeFileSync(state, JSON.stringify({ "remote-projects": [] }));
  assert.deepEqual(desktopProject(state, root), { known: true });
});
