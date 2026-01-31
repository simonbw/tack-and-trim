import http from "http";
import httpProxy from "http-proxy";
import { spawn } from "child_process";

// Allow PORT override from environment for test isolation
const PROXY_PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 1234;
const PARCEL_PORT = PROXY_PORT + 1;

// Start Parcel on a different port - serve both game and editor
const parcel = spawn(
  "npx",
  [
    "parcel",
    "--no-hmr",
    "--port",
    String(PARCEL_PORT),
    "src/index.html",
    "src/editor.html",
  ],
  {
    // Suppress Parcel output in CI to avoid /dev/tty errors
    stdio: process.env.CI ? "ignore" : "inherit",
    shell: true,
  },
);

parcel.on("error", (err) => {
  console.error("Failed to start Parcel:", err);
  process.exit(1);
});

// Create proxy server that adds COOP/COEP headers for high-resolution timers
const proxy = httpProxy.createProxyServer({
  target: `http://localhost:${PARCEL_PORT}`,
});

const server = http.createServer((req, res) => {
  // Add cross-origin isolation headers for high-resolution performance.now()
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");

  proxy.web(req, res);
});

proxy.on("error", (err, req, res) => {
  // Parcel might not be ready yet, just wait
  if ("writeHead" in res) {
    res.writeHead(502, { "Content-Type": "text/plain" });
    res.end("Waiting for Parcel to start...");
  }
});

server.listen(PROXY_PORT, () => {
  console.log(`\n🎮 Dev server running at http://localhost:${PROXY_PORT}`);
  console.log(
    `   (proxying Parcel on port ${PARCEL_PORT} with COOP/COEP headers)\n`,
  );
});

// Cleanup on exit
process.on("SIGINT", () => {
  parcel.kill();
  server.close();
  process.exit();
});

process.on("SIGTERM", () => {
  parcel.kill();
  server.close();
  process.exit();
});
