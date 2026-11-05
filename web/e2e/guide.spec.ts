import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { AppServerAdapter } from "../../dist/src/codex/index.js";
import { Fault } from "../../dist/src/management/schema.js";
import { startServer } from "../../dist/src/server/index.js";
import { ed25519 } from "../../dist/src/setup/access.js";

let module: Awaited<ReturnType<typeof startServer>>;
let dir: string;
let home: string;
let sshd: Server | undefined;
let port: number;
const native = { desktop: false };

test.beforeEach(async ({ page }) => {
  dir = mkdtempSync(join(tmpdir(), "orgactor-guide-browser-"));
  // A long home with spaces, as under Application Support, so wrapping and quoting are tested.
  home = join(dir, "Users", "a person with a long name", "Application Support", "Provider home");
  mkdirSync(join(home, "bin"), { recursive: true });
  writeFileSync(join(home, "host.pub"), `${ed25519("host").public} root@mac\n`);
  writeFileSync(join(home, "bin", "codex"), "#!/bin/sh\n", { mode: 0o755 });
  const free = createServer();
  await new Promise<void>((done) => free.listen(0, "127.0.0.1", done));
  port = (free.address() as { port: number }).port;
  await new Promise((done) => free.close(done));
  native.desktop = false;
  module = await startServer({
    root: join(dir, "runtime"),
    port: 0,
    mac: {
      platform: "darwin",
      home,
      user: "person",
      shell: "/bin/zsh",
      hostKey: join(home, "host.pub"),
      codex: [join(home, "bin", "codex")],
      sshPort: port,
      desktopState: join(home, ".codex-global-state.json"),
      // Desktop's `codex --version` answers; `ssh -G` is real, since it only reads the config.
      ssh: async (args: string[]) =>
        args[0] === "-G"
          ? { code: 0, stdout: execFileSync("ssh", args, { encoding: "utf8", stdio: "pipe" }) }
          : { code: 0, stdout: "codex-cli 1.2.3\n" },
    },
  });
  // A Hub that admitted this Provider, and a Codex that answers once Desktop connects.
  module.store.data.settings.hub = { url: "http://127.0.0.1:8740", providerId: "codex" };
  module.provider.snapshot = () => ({ enabled: true, connected: true, state: "connected" });
  module.provider.setEnabled = async (enabled: boolean) => {
    module.store.data.providerEnabled = enabled;
  };
  module.actors.launch = () => {};
  const adapter = new AppServerAdapter({
    request: async (method: string, params: any) => {
      if (method === "thread/start") return { thread: { id: "ephemeral" } };
      if (method === "thread/unsubscribe") return { status: "unsubscribed" };
      if (method === "thread/read")
        return { thread: { id: params.threadId, cwd: module.store.data.settings.workspaceRoot } };
      if (method === "mcpServerStatus/list") return { data: [{ name: "org", tools: { t: {} } }] };
      throw new Error(`Unexpected ${method}`);
    },
  } as any);
  module.backend.get = async () => {
    if (!native.desktop) throw new Fault("BACKEND_UNREACHABLE", "Unreachable.", 503);
    return adapter;
  };
  await page.goto(module.url);
  await expect(page.getByRole("heading", { name: "Setup", exact: true })).toBeVisible();
});
test.afterEach(async () => {
  sshd?.close();
  sshd = undefined;
  await module.close();
  rmSync(dir, { recursive: true, force: true });
});
const step = (page: Page, id: string) => page.locator(`#step-${id}`);
/** Desktop's own record of its projects, as Codex Desktop writes it. */
const openInDesktop = (state: object) =>
  writeFileSync(join(home, ".codex-global-state.json"), JSON.stringify(state));
const shot = async (page: Page, name: string) => {
  mkdirSync("evidence/console", { recursive: true });
  await page.evaluate(() => {
    scrollTo(0, 0);
    for (const animation of document.getAnimations()) animation.finish();
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: resolve(`evidence/console/${name}.png`), fullPage: true });
};

test("the guided setup walks a fresh Mac to Ready, writing only what the person reviewed", async ({
  page,
}) => {
  await expect(page.getByText("Next: Remote Login")).toBeVisible();
  await expect(step(page, "login")).toContainText("Remote Login is off");
  await expect(step(page, "access")).toContainText("Waits for remote login.");
  await expect(page.getByText(/Simulate/)).toHaveCount(0);
  await shot(page, "guide-fresh");

  // Remote Login turns on in System Settings; the page notices by itself.
  sshd = createServer((socket) => socket.end());
  await new Promise<void>((done) => sshd?.listen(port, "127.0.0.1", done));
  await expect(page.getByText("Next: SSH access")).toBeVisible({ timeout: 10_000 });

  await page.getByRole("button", { name: "Set up SSH access for this Mac" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText('restrict,from="127.0.0.1,::1",command="exec');
  await expect(dialog).toContainText("Host this-mac");
  await expect(dialog).toContainText("SHA256:");
  await expect(dialog).not.toContainText("PRIVATE KEY");
  expect(existsSync(join(home, ".ssh"))).toBe(false);
  await expect(dialog.getByRole("button", { name: "Write these" })).toBeEnabled();
  await shot(page, "guide-consent");
  await dialog.getByRole("button", { name: "Write these" }).click();
  await expect(step(page, "access")).toContainText("Done");
  expect(readFileSync(join(home, ".ssh", "authorized_keys"), "utf8")).toContain("app-server proxy");

  await expect(page.getByText("Next: Codex Desktop connected")).toBeVisible();
  native.desktop = true;
  await step(page, "desktop").getByRole("button", { name: "Re-check" }).click();
  await expect(page.getByText("Next: Workspace folder")).toBeVisible();

  const trial = join(home, "My Projects", "the person's trial");
  mkdirSync(join(trial, ".codex"), { recursive: true });
  writeFileSync(join(trial, ".codex", "config.toml"), '[mcp_servers.org]\ncommand = "x"\n');
  const suggested = join(home, "agentorg-codex");
  await expect(page.getByLabel("Folder")).toHaveValue(suggested);
  await page.getByLabel("Folder").fill("");
  await expect(page.getByLabel("Folder")).toHaveValue("");
  await page.getByLabel("Folder").fill(trial);
  await page.getByRole("button", { name: "Use this folder" }).click();
  await expect(step(page, "folder")).toContainText("AgentOrg's Codex adapter is connected there");
  await expect(step(page, "folder")).toContainText(
    `agentorg-mcp disconnect codex --project '${trial.replace("'", "'\\''")}'`,
  );
  await expect(page.getByRole("button", { name: `Use ${suggested}` })).toBeEnabled();
  await shot(page, "guide-folder-refused");
  await page.setViewportSize({ width: 390, height: 844 });
  await shot(page, "mobile-guide-folder-refused");
  await page.setViewportSize({ width: 1440, height: 1000 });
  // Re-check leads back to choosing, with the refused folder ready to try again.
  await step(page, "folder").getByRole("button", { name: "Re-check" }).click();
  await expect(page.getByLabel("Folder")).toHaveValue(trial);
  await page.getByRole("button", { name: "Use this folder" }).click();
  await expect(step(page, "folder")).toContainText("AgentOrg's Codex adapter is connected there");
  await page.getByRole("button", { name: `Use ${suggested}` }).click();
  await expect(step(page, "folder")).toContainText("doesn't exist yet");
  await step(page, "folder").getByRole("button", { name: "Create folder" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Create folder" }).click();
  await expect(step(page, "folder")).toContainText("Desktop has no project for");
  await expect(step(page, "folder")).toContainText(
    "Under SSH connections from this Mac, choose Add a remote project on this-mac.",
  );
  expect(existsSync(suggested)).toBe(true);
  // A local project with the folder is named as such; a project on this-mac completes the step.
  openInDesktop({ "local-projects": { p: { name: "Codex Actor", rootPaths: [suggested] } } });
  await step(page, "folder").getByRole("button", { name: "Re-check" }).click();
  await expect(step(page, "folder")).toContainText("as the local project Codex Actor");
  await shot(page, "guide-folder-local-project");
  openInDesktop({
    "remote-projects": [
      { hostId: "remote-ssh-discovered:this-mac", remotePath: suggested, label: "Actor" },
    ],
  });
  await step(page, "folder").getByRole("button", { name: "Re-check" }).click();
  await expect(page.getByText("Next: Actor")).toBeVisible();
  await expect(step(page, "actor").getByLabel("Actor ID")).toBeVisible();

  // The Actor is attached (its Hub isn't part of this test), so its session needs Desktop.
  module.store.data.actors.act = {
    actorId: "act",
    hubUrl: "http://127.0.0.1:8740",
    threadId: "session-thread",
    bridgeToken: "private",
    enabled: true,
    config: { approvalAuthority: "desktop" },
    submissions: [],
  };
  module.store.data.journal["http://127.0.0.1:8740|codex|act"] = {
    fingerprint: "f",
    state: "ready",
    threadId: "session-thread",
  };
  await expect(page.getByText("Next: Session in Desktop")).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: "Actors", exact: true }).click();
  const status = page.getByRole("button", { name: "Waiting for Desktop: confirm the session" });
  await expect(status).toBeVisible();
  await shot(page, "guide-actors-status");
  await status.click();
  await expect(step(page, "session")).toContainText("session-thread");
  await expect(step(page, "session")).toContainText("open the project Actor on this-mac");
  await step(page, "session").getByRole("button", { name: "I see it" }).click();
  await expect(page.getByText("Ready: the Actor works from Codex Desktop.")).toBeVisible();
  expect(module.store.data.probes.desktop?.code).toBe("OPERATOR_CONFIRMED_DESKTOP");
  await shot(page, "guide-ready");
  await page.setViewportSize({ width: 390, height: 844 });
  await shot(page, "mobile-guide");
});

test("Remove SSH access asks first, then removes exactly what was written", async ({ page }) => {
  sshd = createServer((socket) => socket.end());
  await new Promise<void>((done) => sshd?.listen(port, "127.0.0.1", done));
  mkdirSync(join(home, ".ssh"));
  writeFileSync(join(home, ".ssh", "config"), "Host other\n");
  await page.getByRole("button", { name: "Set up SSH access for this Mac" }).click();
  await page.getByRole("button", { name: "Write these" }).click();
  await expect(step(page, "access")).toContainText("Done");
  // Remote Login turns off: the access waits on it, and can still be removed.
  sshd?.close();
  sshd = undefined;
  await step(page, "login").getByRole("button", { name: "Re-check" }).click();
  await expect(step(page, "access")).toContainText("Waiting");
  await step(page, "access").getByRole("button", { name: "Remove SSH access" }).click();
  await expect(page.getByRole("dialog")).toContainText("keeping everything else");
  await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
  expect(readFileSync(join(home, ".ssh", "config"), "utf8")).toContain("Host this-mac");
  await step(page, "access").getByRole("button", { name: "Remove SSH access" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Remove access" }).click();
  await expect(step(page, "access").getByRole("button", { name: "Remove SSH access" })).toHaveCount(
    0,
  );
  expect(readFileSync(join(home, ".ssh", "config"), "utf8")).toBe("Host other\n");
  expect(existsSync(join(home, ".ssh", "authorized_keys"))).toBe(false);
});

test("the Actors Status gives each Actor its own reason", async ({ page }) => {
  sshd = createServer((socket) => socket.end());
  await new Promise<void>((done) => sshd?.listen(port, "127.0.0.1", done));
  native.desktop = true;
  const api = (method: string, path: string, body?: unknown) =>
    fetch(`${module.url}/api${path}`, {
      method,
      ...(body
        ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
        : {}),
    }).then((r) => r.json());
  const plan = await api("POST", "/setup/guide/access/plan");
  await api("PUT", "/setup/guide/access", { planId: plan.id });
  const folder = join(home, "agentorg-codex");
  await api("PUT", "/setup/guide/folder", { path: folder });
  await api("POST", "/setup/guide/folder");
  openInDesktop({
    "remote-projects": [
      { hostId: "remote-ssh-discovered:this-mac", remotePath: folder, label: "Actor" },
    ],
  });
  const actor = (actorId: string, threadId: string, approvalAuthority: "desktop" | "hub") => {
    module.store.data.actors[actorId] = {
      actorId,
      hubUrl: "http://127.0.0.1:8740",
      threadId,
      bridgeToken: "private",
      enabled: !!threadId,
      config: { approvalAuthority },
      submissions: [],
    };
    module.store.data.journal[`http://127.0.0.1:8740|codex|${actorId}`] = threadId
      ? { fingerprint: actorId, state: "ready", threadId }
      : { fingerprint: actorId, state: "failed" };
  };
  actor("failed", "", "desktop");
  actor("answered-by-hub", "hub-thread", "hub");
  actor("answered-in-desktop", "desktop-thread", "desktop");
  await page.getByRole("button", { name: "Actors", exact: true }).click();
  const row = (id: string) => page.getByRole("row").filter({ hasText: id });
  await expect(row("failed")).toContainText("Session creation failed: detach and attach again", {
    timeout: 10_000,
  });
  await expect(row("answered-by-hub")).toContainText("Connecting");
  await expect(row("answered-in-desktop")).toContainText(
    "Waiting for Desktop: confirm the session",
  );
  await shot(page, "guide-actors-own-reasons");
  await row("failed")
    .getByRole("button", { name: /Session creation failed/ })
    .click();
  await expect(step(page, "actor").getByRole("button", { name: "Detach failed" })).toBeVisible();
});
