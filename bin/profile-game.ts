import { chromium } from "@playwright/test";
import { ChildProcess, spawn } from "child_process";
import net from "net";

interface ProfileStats {
  label: string;
  shortLabel: string;
  depth: number;
  callsPerFrame: number;
  msPerFrame: number;
  maxMs: number;
}

interface GpuSectionStat {
  label: string;
  shortLabel: string;
  depth: number;
  msPerFrame: number;
}

interface Options {
  // When set, reuse an existing server at this URL. When null, spawn our own.
  url: string | null;
  // When set, spawn our own server on this port. When null, pick a free one.
  port: number | null;
  duration: number;
  warmup: number;
  level: string | null;
  boat: string | null;
  json: boolean;
  headless: boolean;
  gameStartTimeout: number;
  serverStartTimeout: number;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    url: null,
    port: null,
    duration: 5,
    warmup: 1,
    level: null,
    boat: null,
    json: false,
    headless: true,
    gameStartTimeout: 60,
    serverStartTimeout: 60,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) {
        throw new Error(`Missing value for ${arg}`);
      }
      return v;
    };
    switch (arg) {
      case "--url":
        opts.url = next();
        break;
      case "--port":
        opts.port = Number(next());
        break;
      case "--duration":
        opts.duration = Number(next());
        break;
      case "--warmup":
        opts.warmup = Number(next());
        break;
      case "--level":
        opts.level = next();
        break;
      case "--boat":
        opts.boat = next();
        break;
      case "--game-start-timeout":
        opts.gameStartTimeout = Number(next());
        break;
      case "--server-start-timeout":
        opts.serverStartTimeout = Number(next());
        break;
      case "--json":
        opts.json = true;
        break;
      case "--headed":
        opts.headless = false;
        break;
      case "-h":
      case "--help":
        printHelp();
        process.exit(0);
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return opts;
}

function printHelp() {
  console.log(
    `Usage: npm run profile-game -- [options]

By default, spawns its own dev-server on a free port (isolated — safe for
worktrees and parallel runs). Pass --url to reuse a server you already have
running (e.g. \`npm start\`).

Options:
  --url <baseUrl>              Reuse an existing dev server at this URL
                               (default: spawn our own)
  --port <number>              Port for the spawned dev server
                               (default: pick a free one)
  --duration <seconds>         Sampling duration after warmup (default: 5)
  --warmup <seconds>           Discard startup spikes before sampling (default: 1)
  --level <id>                 Level name override (default: "default")
  --boat <id>                  Boat id override (default: "shaff-s7")
  --game-start-timeout <sec>   How long to wait for the game to start (default: 60)
  --server-start-timeout <sec> How long to wait for the spawned server (default: 60)
  --json                       Emit JSON instead of a formatted table
  --headed                     Show the browser window (default: headless)
  -h, --help                   Show this help
`,
  );
}

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, () => {
      const address = server.address();
      if (typeof address === "object" && address) {
        const port = address.port;
        server.close(() => resolve(port));
      } else {
        server.close();
        reject(new Error("Failed to find a free port"));
      }
    });
  });
}

async function checkServer(url: string): Promise<void> {
  try {
    const response = await fetch(url);
    if (!response.ok && response.status !== 304) {
      throw new Error(`HTTP ${response.status}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Dev server not reachable at ${url} (${msg}). Start it with \`npm start\` or omit --url to spawn one.`,
    );
  }
}

async function waitForServer(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok || response.status === 304) return;
      lastErr = new Error(`HTTP ${response.status}`);
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
  throw new Error(
    `Dev server at ${url} did not become ready within ${timeoutMs / 1000}s: ${msg}`,
  );
}

interface ServerHandle {
  url: string;
  port: number;
  kill: () => Promise<void>;
}

async function startOwnServer(port: number): Promise<ServerHandle> {
  const url = `http://localhost:${port}`;
  // detached: true puts the child in its own process group so we can signal
  // the whole tree (dev-server spawns Parcel as a child) via process.kill(-pid).
  const child: ChildProcess = spawn("npm", ["run", "dev-server"], {
    env: { ...process.env, PORT: String(port), NODE_ENV: "development" },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const prefix = (stream: NodeJS.WritableStream) => (chunk: Buffer) => {
    const text = chunk.toString();
    for (const line of text.split("\n")) {
      if (line.length > 0) stream.write(`[server] ${line}\n`);
    }
  };
  child.stdout?.on("data", prefix(process.stderr));
  child.stderr?.on("data", prefix(process.stderr));

  let exited = false;
  child.on("exit", () => {
    exited = true;
  });

  const kill = async (): Promise<void> => {
    if (exited || child.pid === undefined) return;
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      // Process may already be gone
    }
    await new Promise<void>((resolve) => {
      if (exited) return resolve();
      const timer = setTimeout(() => {
        if (child.pid !== undefined) {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {}
        }
        resolve();
      }, 5000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  };

  return { url, port, kill };
}

function buildUrl(base: string, opts: Options): string {
  const params = new URLSearchParams({ quickstart: "true" });
  if (opts.level) params.set("level", opts.level);
  if (opts.boat) params.set("boat", opts.boat);
  return `${base.replace(/\/$/, "")}/?${params.toString()}`;
}

function formatTable(stats: ProfileStats[]): string {
  const lines = ["=== CPU Profiler Report ==="];
  for (const stat of stats) {
    const indent = "  ".repeat(stat.depth);
    const prefix = stat.depth > 0 ? "- " : "";
    const label = (indent + prefix + stat.shortLabel).padEnd(30);
    if (stat.msPerFrame > 0) {
      lines.push(
        `${label} calls/frame: ${stat.callsPerFrame.toFixed(1).padStart(6)}  ` +
          `ms/frame: ${stat.msPerFrame.toFixed(2).padStart(7)}  ` +
          `max: ${stat.maxMs.toFixed(2).padStart(7)}ms`,
      );
    } else {
      lines.push(
        `${label} calls/frame: ${stat.callsPerFrame.toFixed(1).padStart(6)}  (count only)`,
      );
    }
  }
  lines.push("===========================");
  return lines.join("\n");
}

function buildGpuStats(raw: Record<string, number> | null): GpuSectionStat[] {
  if (!raw) return [];
  // Section names use dot separators to imply hierarchy
  // (e.g. "surface" / "surface.water"). Preserve the order returned by the
  // profiler so parents come before children.
  return Object.entries(raw).map(([label, msPerFrame]) => {
    const parts = label.split(".");
    return {
      label,
      shortLabel: parts[parts.length - 1],
      depth: parts.length - 1,
      msPerFrame,
    };
  });
}

function formatGpuTable(stats: GpuSectionStat[]): string {
  const lines = ["=== GPU Profiler Report ==="];
  if (stats.length === 0) {
    lines.push("(GPU timing unavailable — timestamp queries not supported)");
  } else {
    for (const stat of stats) {
      const indent = "  ".repeat(stat.depth);
      const prefix = stat.depth > 0 ? "- " : "";
      const label = (indent + prefix + stat.shortLabel).padEnd(30);
      lines.push(
        `${label} ms/frame: ${stat.msPerFrame.toFixed(2).padStart(7)}`,
      );
    }
  }
  lines.push("===========================");
  return lines.join("\n");
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  let server: ServerHandle | null = null;
  let baseUrl: string;

  if (opts.url) {
    baseUrl = opts.url;
    await checkServer(baseUrl);
  } else {
    const port = opts.port ?? (await findFreePort());
    console.error(`Starting dev server on port ${port}...`);
    server = await startOwnServer(port);
    baseUrl = server.url;
    // Install signal handlers so Ctrl+C tears the server down cleanly.
    const onSignal = async () => {
      await server?.kill();
      process.exit(130);
    };
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);

    try {
      await waitForServer(baseUrl, opts.serverStartTimeout * 1000);
    } catch (err) {
      await server.kill();
      throw err;
    }
    console.error(`Dev server ready at ${baseUrl}`);
  }

  try {
    const args = [
      "--enable-unsafe-webgpu",
      "--enable-features=Vulkan",
      "--ignore-gpu-blocklist",
      "--use-angle=metal",
      // Keep the render loop running at full rate when not focused.
      "--disable-renderer-backgrounding",
      "--disable-backgrounding-occluded-windows",
      "--disable-background-timer-throttling",
      "--mute-audio",
    ];
    // Use Chrome's "new headless" mode (a real browser instance with GPU),
    // not the legacy headless_shell (software-only WebGPU).
    if (opts.headless) args.push("--headless=new");
    const browser = await chromium.launch({ headless: false, args });
    try {
      const context = await browser.newContext();
      const page = await context.newPage();

      page.on("pageerror", (err) => {
        console.error(`[browser error] ${err.message}`);
      });
      page.on("console", (msg) => {
        if (msg.type() === "error") {
          console.error(`[browser console.error] ${msg.text()}`);
        }
      });

      const target = buildUrl(baseUrl, opts);
      console.error(`Navigating to ${target}`);
      await page.goto(target);

      await page.waitForFunction(
        () => window.DEBUG?.gameStarted === true,
        null,
        {
          timeout: opts.gameStartTimeout * 1000,
        },
      );
      console.error(
        `Game started. Warming up for ${opts.warmup}s, then sampling ${opts.duration}s...`,
      );

      await page.waitForTimeout(opts.warmup * 1000);
      await page.evaluate(() => {
        (window as any).profiler?.reset();
        (window as any).gpuProfiler?.reset();
      });

      await page.waitForTimeout(opts.duration * 1000);

      const { cpu, gpu } = await page.evaluate(() => ({
        cpu: (window as any).profiler?.getStats() ?? [],
        gpu: (window as any).gpuProfiler?.getAllMs() ?? null,
      }));
      const gpuStats = buildGpuStats(gpu);

      if (opts.json) {
        process.stdout.write(
          JSON.stringify({ cpu, gpu: gpuStats }, null, 2) + "\n",
        );
      } else {
        process.stdout.write(formatTable(cpu) + "\n");
        process.stdout.write(formatGpuTable(gpuStats) + "\n");
      }
    } finally {
      await browser.close();
    }
  } finally {
    if (server) {
      console.error("Shutting down dev server...");
      await server.kill();
    }
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
