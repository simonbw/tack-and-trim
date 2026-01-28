import { defineConfig } from "@playwright/test";

// Use a random port for benchmarks to allow concurrent runs
// Never use 1234 (dev server) or 1235 (dev server Parcel)
// Range: 3000-9999 to avoid common ports
function getTestPort(): number {
  // Check if PORT is already set (e.g., by a parent process)
  if (process.env.TEST_PORT) {
    return parseInt(process.env.TEST_PORT, 10);
  }

  // Generate random port in range 3000-9999, avoiding dev server ports
  const MIN_PORT = 3000;
  const MAX_PORT = 9999;
  const DEV_PORTS = [1234, 1235];

  let port: number;
  do {
    port = Math.floor(Math.random() * (MAX_PORT - MIN_PORT + 1)) + MIN_PORT;
  } while (DEV_PORTS.includes(port));

  return port;
}

const TEST_PORT = getTestPort();

export default defineConfig({
  testDir: "./tests",
  testMatch: "**/benchmark.spec.ts",
  timeout: 120000,
  use: {
    headless: true,
    baseURL: `http://localhost:${TEST_PORT}`,
    launchOptions: {
      args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan"],
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
