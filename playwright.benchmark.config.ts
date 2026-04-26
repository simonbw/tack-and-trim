import { defineConfig } from "@playwright/test";

// Use a different port for tests to avoid conflicts with dev server
// (dev server uses 1234 with Parcel on 1235, so we use 3000+)
const TEST_PORT = 3456;

export default defineConfig({
  testDir: "./tests",
  testMatch: "**/*benchmark.spec.ts",
  timeout: 120000,
  use: {
    // Use Chrome's "new headless" (a real browser instance with GPU) rather
    // than the legacy headless_shell, which falls back to software WebGPU.
    headless: false,
    baseURL: `http://localhost:${TEST_PORT}`,
    launchOptions: {
      args: [
        "--headless=new",
        "--enable-unsafe-webgpu",
        "--enable-features=Vulkan",
        "--ignore-gpu-blocklist",
        "--use-angle=metal",
      ],
    },
  },
  webServer: {
    command: `PORT=${TEST_PORT} npm run dev-server`,
    url: `http://localhost:${TEST_PORT}`,
    // Always spin up a fresh server for tests
    reuseExistingServer: false,
    timeout: 60000,
  },
});
