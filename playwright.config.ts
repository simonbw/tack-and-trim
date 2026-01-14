import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  timeout: 60000,
  use: {
    headless: true,
    launchOptions: {
      args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan"],
    },
  },
  webServer: {
    command: "npm run dev-server",
    url: "http://localhost:1234",
    reuseExistingServer: !process.env.CI,
    timeout: 60000,
  },
});
