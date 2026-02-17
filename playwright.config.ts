import { defineConfig } from "@playwright/test";

// Use a different port for tests to avoid conflicts with dev server
// (dev server uses 1234 with Parcel on 1235, so we use 3000+)
const TEST_PORT = 3456;

export default defineConfig({
  testDir: "./tests",
  timeout: 60000,
  // Exclude benchmark tests from normal runs - use `npx playwright test --grep @benchmark` to run them
  testIgnore: ["**/benchmark.spec.ts"],
  use: {
    headless: true,
    baseURL: `http://localhost:${TEST_PORT}`,
    launchOptions: {
      args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan"],
    },
  },
  webServer: {
    command: `PORT=${TEST_PORT} NODE_ENV=test npm run dev-server`,
    url: `http://localhost:${TEST_PORT}`,
    // Always spin up a fresh server for tests
    reuseExistingServer: false,
    timeout: 60000,
  },
});
