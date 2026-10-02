import { defineConfig, devices } from "@playwright/test";
import { resolve } from "node:path";

delete process.env.NO_COLOR;

export default defineConfig({
  workers: 1,
  testDir: "./tests",
  testMatch: "**/*.spec.ts",
  use: { baseURL: "http://127.0.0.1:3100", trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npm run dev -- --port 3100",
    url: "http://127.0.0.1:3100",
    reuseExistingServer: false,
    env: { NEXT_DIST_DIR: ".next-e2e", AGENT_MODE: "fixture", DATABASE_PATH: resolve(".data/workspace-e2e.sqlite") },
  },
});
