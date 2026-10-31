import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./web/e2e",
  workers: 1,
  timeout: 30_000,
  fullyParallel: false,
  use: { headless: true, viewport: { width: 1440, height: 1000 } },
  reporter: "list",
});
