import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { AppServerAdapter } from "../../dist/src/codex/index.js";
import { Fault } from "../../dist/src/management/schema.js";
import { startServer } from "../../dist/src/server/index.js";
import { controlSocket } from "../../dist/src/setup/this-mac.js";

let module: Awaited<ReturnType<typeof startServer>>;
let dir: string;
let home: string;
/** Codex on this Mac, as the console sees it through the app server. */
const native = {
  up: false,
  signedIn: false,
  starts: 0,
  projects: [] as { id: string; name: string; roots: { path: string }[] }[],
};

test.beforeEach(async ({ page }) => {
  dir = mkdtempSync(join(tmpdir(), "orgactor-guide-browser-"));
  // A long home with spaces, as under Application Support, so wrapping and quoting are tested.
  home = join(dir, "Users", "a person with a long name", "Application Support", "Provider home");
  mkdirSync(join(home, "bin"), { recursive: true });
  writeFileSync(join(home, "bin", "codex"), "#!/bin/sh\n", { mode: 0o755 });
  Object.assign(native, {
    up: false,
    signedIn: false,
    starts: 0,
    projects: [],
  });
  module = await startServer({
    root: join(dir, "runtime"),
    port: 0,
    mac: {
      platform: "darwin",
      home,
      codex: [join(home, "bin", "codex")],
      startDaemon: async () => {
        native.starts++;
        return controlSocket(home);
      },
    },
  });
  // A Hub that admitted this Provider, and Codex's app server once it answers.
  module.store.data.settings.hub = { url: "http://127.0.0.1:8740", providerId: "codex" };
  module.provider.snapshot = () => ({ enabled: true, connected: true, state: "connected" });
  module.provider.setEnabled = async (enabled: boolean) => {
    module.store.data.providerEnabled = enabled;
  };
  module.actors.launch = () => {};
  const adapter = new AppServerAdapter({
    request: async (method: string, params: any) => {
      switch (method) {
        case "account/read":
          return { account: native.signedIn ? { type: "chatgpt" } : null };
        case "account/rateLimits/read":
          return { ordinaryUsageAllowed: true };
        case "project/list":
          return { data: native.projects, nextCursor: null };
        case "project/create": {
          const project = { id: "project", name: params.name, roots: params.roots };
          native.projects.push(project);
          return { project };
        }
        case "thread/start":
          return { thread: { id: "ephemeral" } };
        case "thread/unsubscribe":
          return { status: "unsubscribed" };
        case "mcpServerStatus/list":
          return { data: [{ name: "org", tools: { t: {} } }] };
      }
      throw new Error(`Unexpected ${method}`);
    },
  } as any);
  module.backend.get = async () => {
    if (!native.up) throw new Fault("BACKEND_UNREACHABLE", "Unreachable.", 503);
    return adapter;
  };
  await page.goto(module.url);
  await expect(page.getByRole("heading", { name: "Setup", exact: true })).toBeVisible();
});
test.afterEach(async () => {
  await module.close();
  rmSync(dir, { recursive: true, force: true });
});
const step = (page: Page, id: string) => page.locator(`#step-${id}`);
const shot = async (page: Page, name: string) => {
  mkdirSync("evidence/console", { recursive: true });
  await page.evaluate(() => {
    scrollTo(0, 0);
    for (const animation of document.getAnimations()) animation.finish();
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: resolve(`evidence/console/${name}.png`), fullPage: true });
};
const attach = (actorId: string, threadId: string, approvalAuthority: "desktop" | "hub") => {
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

test("the guided setup walks a fresh Mac to Ready through Codex on this Mac", async ({ page }) => {
  await expect(page.getByText("Next: Codex on this Mac")).toBeVisible();
  await expect(step(page, "codex")).toContainText("doesn't use Codex on this Mac yet");
  await expect(step(page, "account")).toContainText("Waits for codex on this mac.");
  await expect(page.getByText(/SSH|Remote Login|this-mac/)).toHaveCount(0);
  await shot(page, "guide-fresh");

  await page.getByRole("button", { name: "Use Codex on this Mac" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("codex app-server daemon start");
  await expect(dialog).toContainText(controlSocket(home));
  expect(module.store.data.settings.backend).toBeUndefined();
  await shot(page, "guide-consent");
  await dialog.getByRole("button", { name: "Use Codex on this Mac" }).click();
  await expect(step(page, "codex")).toContainText("doesn't answer");
  expect(native.starts).toBe(1);
  expect(module.store.data.settings.backend).toEqual({
    kind: "app-server",
    endpoint: `unix://${controlSocket(home)}`,
  });
  native.up = true;
  await step(page, "codex").getByRole("button", { name: "Re-check" }).click();
  await expect(page.getByText("Next: ChatGPT account")).toBeVisible();
  await expect(step(page, "account")).toContainText("isn't signed in to ChatGPT");
  await expect(
    step(page, "account").getByRole("button", { name: "Open Codex backend" }),
  ).toBeVisible();
  native.signedIn = true;
  await step(page, "account").getByRole("button", { name: "Re-check" }).click();
  await expect(page.getByText("Next: Workspace folder")).toBeVisible();

  const trial = join(home, "My Projects", "the person's trial");
  mkdirSync(join(trial, ".codex"), { recursive: true });
  writeFileSync(join(trial, ".codex", "config.toml"), '[mcp_servers.org]\ncommand = "x"\n');
  const suggested = join(home, "agentorg-codex");
  await expect(page.getByLabel("Folder")).toHaveValue(suggested);
  await page.getByLabel("Folder").fill(trial);
  await page.getByRole("button", { name: "Use this folder" }).click();
  await expect(step(page, "folder")).toContainText("AgentOrg's Codex adapter is connected there");
  await expect(step(page, "folder")).toContainText(
    `agentorg-mcp disconnect codex --project '${trial.replace("'", "'\\''")}'`,
  );
  await shot(page, "guide-folder-refused");
  await page.setViewportSize({ width: 390, height: 844 });
  await shot(page, "mobile-guide-folder-refused");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("button", { name: `Use ${suggested}` }).click();
  await expect(step(page, "folder")).toContainText("doesn't exist yet");
  await step(page, "folder").getByRole("button", { name: "Create folder" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Create folder" }).click();
  // The Provider files the folder as a Codex project itself; nothing is asked of Codex Desktop.
  await expect(page.getByText("Next: Actor")).toBeVisible();
  expect(existsSync(suggested)).toBe(true);
  await expect(step(page, "folder")).toContainText("filed under its Codex project agentorg-codex");
  await expect(page.getByText(/Codex Desktop,/)).toHaveCount(0);
  await shot(page, "guide-folder-local-project");
  await expect(step(page, "actor").getByLabel("Actor ID")).toBeVisible();

  // The Actor is attached (its Hub isn't part of this test).
  attach("act", "session-thread", "desktop");
  await expect(page.getByText("Ready: the Actor works through Codex on this Mac.")).toBeVisible({
    timeout: 10_000,
  });
  await expect(step(page, "session")).toHaveCount(0);
  await shot(page, "guide-ready");
  await page.setViewportSize({ width: 390, height: 844 });
  await shot(page, "mobile-guide");
  await page.setViewportSize({ width: 1440, height: 1000 });

  // A break shows on the Actor as its one reason, linking the step that says what to do.
  native.up = false;
  await page.getByRole("button", { name: "Actors", exact: true }).click();
  const status = page.getByRole("button", { name: "Codex not reachable" });
  await expect(status).toBeVisible({ timeout: 10_000 });
  await shot(page, "guide-actors-status");
  await status.click();
  await expect(step(page, "codex")).toContainText("doesn't answer");
});

test("the Actors Status gives each Actor its own reason", async ({ page }) => {
  native.up = true;
  native.signedIn = true;
  const api = (method: string, path: string, body?: unknown) =>
    fetch(`${module.url}/api${path}`, {
      method,
      ...(body
        ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
        : {}),
    }).then((r) => r.json());
  await api("PUT", "/setup/guide/codex");
  const folder = join(home, "agentorg-codex");
  await api("PUT", "/setup/guide/folder", { path: folder });
  await api("POST", "/setup/guide/folder");
  attach("failed", "", "desktop");
  attach("answered-by-hub", "hub-thread", "hub");
  attach("answered-in-desktop", "desktop-thread", "desktop");
  await page.getByRole("button", { name: "Actors", exact: true }).click();
  const row = (id: string) => page.getByRole("row").filter({ hasText: id });
  await expect(row("failed")).toContainText("Session creation failed: detach and attach again", {
    timeout: 10_000,
  });
  await expect(row("answered-by-hub")).toContainText("Connecting");
  await shot(page, "guide-actors-own-reasons");
  await row("failed")
    .getByRole("button", { name: /Session creation failed/ })
    .click();
  await expect(step(page, "actor").getByRole("button", { name: "Detach failed" })).toBeVisible();
});
