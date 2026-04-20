import { chromium } from "@playwright/test";

interface ProfileStats {
  label: string;
  shortLabel: string;
  depth: number;
  callsPerFrame: number;
  msPerFrame: number;
  maxMs: number;
}

interface Options {
  url: string;
  duration: number;
  warmup: number;
  level: string | null;
  boat: string | null;
  json: boolean;
  headless: boolean;
  gameStartTimeout: number;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    url: "http://localhost:1234",
    duration: 5,
    warmup: 1,
    level: null,
    boat: null,
    json: false,
    headless: true,
    gameStartTimeout: 60,
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

Options:
  --url <baseUrl>              Dev server base URL (default: http://localhost:1234)
  --duration <seconds>         Sampling duration after warmup (default: 5)
  --warmup <seconds>           Discard startup spikes before sampling (default: 1)
  --level <id>                 Level name override (default: "default")
  --boat <id>                  Boat id override (default: "shaff-s7")
  --game-start-timeout <sec>   How long to wait for the game to start (default: 60)
  --json                       Emit JSON instead of a formatted table
  --headed                     Show the browser window (default: headless)
  -h, --help                   Show this help
`,
  );
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
      `Dev server not reachable at ${url} (${msg}). Start it with \`npm start\` in another terminal.`,
    );
  }
}

function buildUrl(opts: Options): string {
  const params = new URLSearchParams({ profile: "1" });
  if (opts.level) params.set("level", opts.level);
  if (opts.boat) params.set("boat", opts.boat);
  return `${opts.url.replace(/\/$/, "")}/?${params.toString()}`;
}

function formatTable(stats: ProfileStats[]): string {
  const lines = ["=== Profiler Report ==="];
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
  lines.push("========================");
  return lines.join("\n");
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  await checkServer(opts.url);

  const args = [
    "--enable-unsafe-webgpu",
    "--enable-features=Vulkan",
    "--ignore-gpu-blocklist",
    "--use-angle=metal",
    // Keep the render loop running at full rate when not focused.
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
    "--disable-background-timer-throttling",
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

    const target = buildUrl(opts);
    console.error(`Navigating to ${target}`);
    await page.goto(target);

    await page.waitForFunction(() => window.DEBUG?.gameStarted === true, null, {
      timeout: opts.gameStartTimeout * 1000,
    });
    console.error(
      `Game started. Warming up for ${opts.warmup}s, then sampling ${opts.duration}s...`,
    );

    await page.waitForTimeout(opts.warmup * 1000);
    await page.evaluate(() => (window as any).profiler?.reset());

    await page.waitForTimeout(opts.duration * 1000);

    const stats = await page.evaluate(
      () => (window as any).profiler?.getStats() ?? [],
    );

    if (opts.json) {
      process.stdout.write(JSON.stringify(stats, null, 2) + "\n");
    } else {
      process.stdout.write(formatTable(stats) + "\n");
    }
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
