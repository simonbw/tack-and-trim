---
name: profile-game
description: Measure runtime performance of the game by running it headless under Playwright and reading back profiler stats. Use when the user asks to profile the game, measure frame time, find hot spots, compare perf before/after a change, or check whether something regressed. Also invoked via /profile-game.
argument-hint: [--level <name>] [--duration <sec>] [--compare] [extra profile-game flags]
allowed-tools: Bash, Read, Grep, Glob, Edit
---

# Profile Game

Runs `bin/profile-game.ts` — a headless Chromium harness that loads the game via `?quickstart=true`, waits for gameplay to start, samples `profiler.getStats()` for N seconds, and prints a table of per-label `ms/frame`, `calls/frame`, and `max`.

## When to use

- "Is this slow?" / "profile X" / "why is the frame time high?"
- Comparing performance before vs after a change (stash → run → unstash → run)
- Finding hot spots by level (some levels stress different systems)
- Verifying a perf-sensitive change (wave mesh, surface rendering, physics substeps, rope solver, etc.) didn't regress

## Basic invocation

```bash
npm run profile-game
```

That's it — by default it spawns its own isolated dev server on a free port (safe in worktrees and when the user already has `npm start` running). It prints the profile table to stdout and server logs to stderr prefixed with `[server]`.

## Common flags

| Flag | Purpose |
|---|---|
| `--level <name>` | Level to load. Must match a camelCase key in `RESOURCES.levels` — `apostleIslands`, `sanJuanIslands`, `islesOfScilly`, `vendoviIsland`, `default`. (The kebab-case file slugs under `resources/levels/` will *not* work — the loader keys directly off the camelCase resource map.) Default: `default`. |
| `--boat <id>` | Boat catalog id. Default: `shaff-s7`. |
| `--duration <sec>` | Sample window after warmup. Default 5. Use 10+ for noisy signals. |
| `--warmup <sec>` | Settle time before sampling (discards startup spikes). Default 1. |
| `--json` | Emit JSON instead of the formatted table (useful for programmatic comparison). |
| `--headed` | Show the browser window (for debugging the harness itself). |
| `--url <baseUrl>` | Reuse an existing dev server (e.g. `http://localhost:1234`) instead of spawning. |
| `--port <n>` | Force the spawned server to a specific port. |
| `--game-start-timeout <sec>` | Raise if gameplay takes >60s to initialize (large levels, cold cache). |

Run `npm run profile-game -- --help` for the full list.

## Reading the output

The table is hierarchical (indented by depth). The auto-instrumented top-level scopes to skim first:

- `frame` — total wall time per frame. This is the number that matters.
- `render` — GPU submission + all render-layer work.
- `tick` — one physics tick's dispatch cost (there may be multiple ticks/frame at 120 Hz; see `calls/frame`).
- `physics` — world.step cost.
- `tick-loop` — total time spent in all ticks for a frame.
- `layer.<name>` — per render-layer cost (surface, boat, ui, ...).
- `tick.<name>` — per tick-layer cost.
- `surface.terrain` / `surface.rasterize` / `surface.water` / `surface.wetness` — GPU pass timings from the surface renderer (requires `setGpuTimingEnabled(true)`, already on in `src/game/index.tsx`).
- Individual entity class names appear under `layer.<name>` — that's how you find a specific render hot spot.

Interpret:
- `ms/frame` = total time spent in that label each frame (summed across all calls).
- `calls/frame` = how often it ran.
- `max` = worst single-call duration observed in the sample window — useful for catching spikes the average hides.
- `(count only)` labels are `profiler.count()` calls — no timing, just a rate.

## Comparing before/after a change

For any perf-sensitive diff, capture both sides and diff the tables:

```bash
# After change
npm run profile-game -- --level sanJuanIslands --duration 10 --json > /tmp/after.json

# Roll back to the baseline (git stash or checkout the parent commit) and run again
git stash
npm run profile-game -- --level sanJuanIslands --duration 10 --json > /tmp/before.json
git stash pop
```

Then diff or skim side by side. Keep every variable constant (level, duration, warmup) between runs, and close other CPU-heavy apps — thermal throttling and background work introduce a lot of noise. Run each side twice if the delta you're chasing is small.

## Drilling into a specific system

The profile labels come from `profiler.measure(...)` / `profiler.count(...)` / the `@profile` decorator scattered through the code. If the user is investigating a specific subsystem and the existing labels aren't granular enough:

1. `Grep` for `profiler\.` in the relevant directory to see what's already instrumented.
2. If you need more detail, add `profiler.measure("subsystem.step", () => { ... })` around the suspect code.
3. Re-run profile-game.
4. Remove the temporary measurements before committing (or keep them if they're reasonable permanent instrumentation — ask first).

## Gotchas

- First-run startup can be slow while Parcel does an initial cold build — bump `--server-start-timeout` if the spawn times out.
- WebGPU must be available; on macOS this uses `--use-angle=metal`. No action needed, just be aware if it fails on a different platform.
- The profiler resets right after warmup, so `--warmup 0` will include load spikes in the sample.
- `calls/frame` is averaged over the sample — a value <1 means that label didn't run every frame.
- If the user cares about GPU-bound work, make sure `surface.*` rows show non-zero `ms/frame`; if they're `0.00` then GPU timing wasn't enabled for that run.

### Headless on Apple Silicon under-reports CPU-bound work

Default `--headless=new` runs much slower than `--headed` on Apple Silicon Macs — observed ~1.8× longer frame times concentrated entirely in CPU-worker scopes (`QueryWorkerPool.awaitFrameComplete` and the per-manager `onTick` rows). Both modes report the same `navigator.hardwareConcurrency` and spawn the same worker count, so it isn't a thread-count issue. The cause is macOS QoS scheduling: headless Chrome is launched at a lower QoS and its workers get bin-packed onto the **efficiency cores** instead of the **performance cores**, roughly halving per-thread throughput on math-heavy kernels (Gerstner sincos, IDW terrain queries, simplex wind).

Implications:
- **Treat headless absolute numbers as a worst-case scheduling floor for CPU-bound work** — they do not reflect the user's real-world frame time. The same level that profiles at 20 ms/frame headless can run at ~12 ms/frame headed.
- **GPU-bound scopes are unaffected** — `surface.*` and other GPU work doesn't go through worker threads, so headless numbers there are representative.
- **Relative comparisons (before/after) remain valid in either mode** since both sides hit the same scheduler. Just don't mix modes between baseline and post-change.
- **When the question is "is this fast enough on the user's machine?"**, run with `--headed`. When the question is "did my change make it faster?", either mode is fine as long as you're consistent.
