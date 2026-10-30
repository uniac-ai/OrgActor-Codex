import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { startServer } from "../../dist/src/server/index.js";

let module: Awaited<ReturnType<typeof startServer>>;
let dir: string;
test.beforeEach(async ({ page }) => {
  dir = mkdtempSync(join(tmpdir(), "orgactor-browser-"));
  module = await startServer({ root: dir, port: 0 });
  const invitation = module.auth.issue();
  await page.goto(`${module.url}/#sign-in=${invitation}`);
  await expect(page.getByRole("heading", { name: "Setup", exact: true })).toBeVisible();
});
test.afterEach(async () => {
  await module.close();
  rmSync(dir, { recursive: true, force: true });
});
const screenshot = async (page: any, name: string) => {
  mkdirSync("evidence/console", { recursive: true });
  await page.evaluate(() => scrollTo(0, 0));
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
  const sidebar = page.locator('[data-slot="sidebar-container"]');
  if (await sidebar.isVisible())
    expect(
      await sidebar.evaluate((element: HTMLElement) => element.getBoundingClientRect().top),
    ).toBe(0);
  expect(
    await page.evaluate(
      () =>
        [
          ...document.querySelectorAll('[data-slot="card"], [data-slot="dialog-content"], .stack'),
        ].filter(
          (element) =>
            element.scrollHeight > element.clientHeight + 2 &&
            getComputedStyle(element).overflowY === "hidden",
        ).length,
    ),
  ).toBe(0);
  await page.screenshot({ path: resolve(`evidence/console/${name}.png`), fullPage: true });
};

test("one-time sign-in removes URL token and sign-out closes operator access", async ({ page }) => {
  expect(page.url()).not.toContain("sign-in");
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { name: "Operator sign-in" })).toBeVisible();
  await screenshot(page, "sign-in");
  await page.getByLabel("Sign-in token").fill("expired");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("expired or was already used");
});
test("setup saves real ManagementApi configuration and probes factual missing prerequisites", async ({
  page,
}) => {
  await page.getByRole("button", { name: "Check Codex connection" }).click();
  await expect(page.getByText("backend unconfigured", { exact: true })).toBeVisible();
  await page.getByLabel("Connection", { exact: true }).click();
  await page.getByRole("option", { name: "Co-located app server" }).click();
  await page.getByLabel("App server endpoint").fill("unix:///owned/codex.sock");
  await page.getByLabel("Workspace root").fill("/owned/workspace");
  await page.getByRole("button", { name: "Save connections" }).click();
  await expect(page.getByLabel("App server endpoint")).toHaveValue("unix:///owned/codex.sock");
  expect(module.store.data.settings.backend?.kind).toBe("app-server");
  expect(module.store.data.probes).toEqual({});
  await screenshot(page, "setup");
});
test("SSH credentials are write-only and never rehydrate into forms", async ({ page }) => {
  await page.getByLabel("Host", { exact: true }).fill("127.0.0.1");
  await page.getByLabel("SSH user").fill("operator");
  await page.getByLabel("SSH private key").fill("PRIVATE_KEY_SENTINEL");
  await page.getByLabel("Verified known-host entry").fill("HOST_SENTINEL");
  await page.getByLabel("Hub URL").fill("http://127.0.0.1:8740");
  await page.getByLabel("Provider ID").fill("provider");
  await page.getByLabel("Provider credential").fill("PROVIDER_SENTINEL");
  await page.getByRole("button", { name: "Save connections" }).click();
  await expect(page.getByLabel("SSH private key")).toHaveValue("");
  await expect(page.getByLabel("Provider credential")).toHaveValue("");
  await expect(page.getByText("A key is stored. Leave blank to keep it.")).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("SSH private key")).toHaveValue("");
  expect(await page.content()).not.toContain("PRIVATE_KEY_SENTINEL");
});
test("Provider and backend surfaces render their real unconfigured states", async ({ page }) => {
  await page.getByRole("button", { name: "Provider", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Provider", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Enable Provider" })).toBeDisabled();
  await screenshot(page, "provider");
  await page.getByRole("button", { name: "Codex backend", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Codex backend", exact: true })).toBeVisible();
  await screenshot(page, "backend");
});
test("Actors has a truthful empty state and an Attach Actor flow", async ({ page }) => {
  await page.getByRole("button", { name: "Actors", exact: true }).click();
  await expect(page.getByRole("heading", { name: "No Actors attached" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Attach Actor", exact: true })).toBeDisabled();
  await screenshot(page, "actors-empty");
});
test("operator controls use actor-scoped API routes and separate interrupt from terminal stop", async ({
  page,
}) => {
  const calls: string[] = [];
  let queued = 0;
  let active: string | null = "turn";
  let terminals = [{ processId: "native-terminal", command: "sleep 20", cwd: "/owned" }];
  const bootstrap = {
    actorId: "act_browser_fixture",
    hubUrl: "http://hub",
    config: { approvalAuthority: "desktop" as const },
    threadId: "browser-fixture-session",
    bridgeToken: "PRIVATE_FIXTURE_CAPABILITY",
    enabled: true,
    submissions: [],
  };
  module.store.data.actors.act_browser_fixture = bootstrap;
  const actor = {
    bootstrap,
    snapshot: () => ({
      actorId: bootstrap.actorId,
      threadId: bootstrap.threadId,
      enabled: true,
      connected: true,
      connectionState: "connected",
      observation: "available",
      observedAt: new Date().toISOString(),
      turnId: active,
      queued,
      approvalAuthority: "desktop",
      requests: [],
      output: "Browser test fixture output.",
    }),
    enqueue: () => {
      calls.push("input");
      queued++;
      return { state: "queued" };
    },
    steer: async () => {
      calls.push("steer");
      return { status: "accepted" };
    },
    interrupt: async () => {
      calls.push("interrupt");
      active = null;
      return { requested: true };
    },
    adapter: {
      terminals: async () => terminals,
      terminate: async (_: string, id: string) => {
        calls.push(`terminate:${id}`);
        terminals = [];
        return true;
      },
    },
    close: async () => {},
  };
  module.actors.actors.set(bootstrap.actorId, actor as any);
  await page.getByRole("button", { name: "Actors", exact: true }).click();
  await page.getByRole("button", { name: bootstrap.actorId, exact: true }).click();
  await page.getByLabel("Task input").fill("Owned task");
  await page.getByRole("button", { name: "Queue task" }).click();
  await expect(page.getByLabel("Task input")).toHaveValue("");
  expect(calls).toEqual(["input"]);
  await page.getByLabel("Task input").fill("Additional context");
  await page.getByRole("button", { name: "Steer turn" }).click();
  await expect(page.getByLabel("Task input")).toHaveValue("");
  await page.getByRole("button", { name: "Interrupt", exact: true }).click();
  await expect(page.getByRole("button", { name: "Interrupt", exact: true })).toBeDisabled();
  await screenshot(page, "actors-controls-fixture");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await screenshot(page, "mobile-actors-fixture");
  await page.getByRole("button", { name: "Background terminals" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "Stop terminal" }).click();
  await expect(
    page.getByText("No running background terminals were reported for this session."),
  ).toBeVisible();
  expect(calls).toEqual(["input", "steer", "interrupt", "terminate:native-terminal"]);
});
test("mobile navigation and setup remain reachable without clipping", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("heading", { name: "Setup", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await screenshot(page, "mobile-setup");
  await page.getByRole("button", { name: "Toggle Sidebar" }).click();
  await page.getByRole("button", { name: "Actors", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("heading", { name: "Actors", exact: true })).toBeVisible();
});
