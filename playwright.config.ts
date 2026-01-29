import { defineConfig } from "@playwright/test";

// Use a fixed port for tests to avoid conflicts with dev server
// Dev server uses 1234 (with Parcel on 1235)
// Multiple test workers share a single webServer instance on this port
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
    command: `NODE_OPTIONS="--no-deprecation" PORT=${TEST_PORT} npm run dev-server`,
    url: `http://localhost:${TEST_PORT}`,
    // Always spin up a fresh server for tests
    reuseExistingServer: false,
    timeout: 60000,
  },
});
