import type { VNode } from "preact";
import { profiler, type ProfileStats } from "../../core/util/Profiler";
import type {
  StatsPanel,
  StatsPanelContext,
} from "../../core/util/stats-overlay/StatsPanel";
import { StatsRow } from "../../core/util/stats-overlay/StatsRow";
import { WaterInfo } from "../water/WaterInfo";
import { WindInfo } from "../wind/WindInfo";

interface TileSystemStats {
  activeTiles: number;
  maxTiles: number;
  tileHits: number;
  totalQueries: number;
  tileHitPercent: number;
  gpuTimeMs: number;
  cpuTickMs: number;
  cpuAfterPhysicsMs: number;
}

/**
 * Creates a simulation stats panel showing water and wind tile computation stats.
 */
export function createSimulationStatsPanel(): StatsPanel {
  return {
    id: "simulation",

    render: (ctx) => {
      const waterStats = getWaterStats(ctx);
      const windStats = getWindStats(ctx);

      return (
        <>
          <div className="stats-overlay__header">
            <span>Simulation</span>
          </div>

          {renderSystemSection("Water", waterStats)}
          {renderSystemSection("Wind", windStats)}
        </>
      );
    },
  };
}

function renderSystemSection(
  name: string,
  stats: TileSystemStats | null,
): VNode {
  if (!stats) {
    return (
      <div className="stats-overlay__section">
        <div className="stats-overlay__section-title">{name}</div>
        <div className="stats-overlay__grid">
          <StatsRow label="Status" value="Not initialized" color="muted" />
        </div>
      </div>
    );
  }

  const isMaxedOut = stats.activeTiles >= stats.maxTiles;

  return (
    <div className="stats-overlay__section">
      <div className="stats-overlay__section-title">{name}</div>
      <div className="stats-overlay__grid">
        <StatsRow
          label="Active Tiles"
          value={`${stats.activeTiles} / (${stats.maxTiles})`}
          color={isMaxedOut ? "error" : undefined}
        />
        <StatsRow
          label="Tile Hits"
          value={`${stats.tileHitPercent.toFixed(0)}% (${stats.tileHits}/${stats.totalQueries})`}
          color={
            stats.tileHitPercent > 90
              ? "success"
              : stats.tileHitPercent > 50
                ? "warning"
                : "error"
          }
        />
        <StatsRow
          label="GPU Time"
          value={`${stats.gpuTimeMs.toFixed(2)}ms`}
          color={stats.gpuTimeMs > 2 ? "warning" : undefined}
        />
        <StatsRow
          label="CPU onTick"
          value={`${stats.cpuTickMs.toFixed(2)}ms`}
          color={stats.cpuTickMs > 1 ? "warning" : undefined}
        />
        <StatsRow
          label="CPU onAfterPhysics"
          value={`${stats.cpuAfterPhysicsMs.toFixed(2)}ms`}
          color={stats.cpuAfterPhysicsMs > 1 ? "warning" : undefined}
        />
      </div>
    </div>
  );
}

function getWaterStats(ctx: StatsPanelContext): TileSystemStats | null {
  const waterInfo = ctx.game.entities.getById("waterInfo") as WaterInfo | null;
  if (!waterInfo) return null;

  const tileStats = waterInfo.getTileStats();
  if (!tileStats) return null;

  const totalQueries = tileStats.tileHits + tileStats.cpuFallbacks;
  const tileHitPercent =
    totalQueries > 0 ? (tileStats.tileHits / totalQueries) * 100 : 0;

  const gpuTimeMs = ctx.game.renderer.getGpuMs("tileCompute");
  const profilerStats = profiler.getStats();
  const cpuTickMs = findProfilerMsByShortLabel(
    profilerStats,
    "onTick",
    "WaterInfo",
  );
  const cpuAfterPhysicsMs = findProfilerMsByShortLabel(
    profilerStats,
    "onAfterPhysics",
    "WaterInfo",
  );

  // Reset counters after reading
  waterInfo.resetStatsCounters();

  return {
    activeTiles: tileStats.activeTiles,
    maxTiles: tileStats.maxTiles,
    tileHits: tileStats.tileHits,
    totalQueries,
    tileHitPercent,
    gpuTimeMs,
    cpuTickMs,
    cpuAfterPhysicsMs,
  };
}

function getWindStats(ctx: StatsPanelContext): TileSystemStats | null {
  const windInfo = ctx.game.entities.getById("windInfo") as WindInfo | null;
  if (!windInfo) return null;

  const tileStats = windInfo.getTileStats();
  if (!tileStats) return null;

  const totalQueries = tileStats.tileHits + tileStats.cpuFallbacks;
  const tileHitPercent =
    totalQueries > 0 ? (tileStats.tileHits / totalQueries) * 100 : 0;

  const gpuTimeMs = ctx.game.renderer.getGpuMs("windCompute");
  const profilerStats = profiler.getStats();
  const cpuTickMs = findProfilerMsByShortLabel(
    profilerStats,
    "onTick",
    "WindInfo",
  );
  const cpuAfterPhysicsMs = findProfilerMsByShortLabel(
    profilerStats,
    "onAfterPhysics",
    "WindInfo",
  );

  // Reset counters after reading
  windInfo.resetStatsCounters();

  return {
    activeTiles: tileStats.activeTiles,
    maxTiles: tileStats.maxTiles,
    tileHits: tileStats.tileHits,
    totalQueries,
    tileHitPercent,
    gpuTimeMs,
    cpuTickMs,
    cpuAfterPhysicsMs,
  };
}

/**
 * Find profiler entry by short label (method name) and class name in the full path.
 * Profiler paths look like "Game.loop > tick > WaterInfo.onTick"
 */
function findProfilerMsByShortLabel(
  stats: ProfileStats[],
  methodName: string,
  className: string,
): number {
  const fullMethodName = `${className}.${methodName}`;
  return (
    stats.find(
      (s) =>
        s.shortLabel === fullMethodName || s.label.endsWith(fullMethodName),
    )?.msPerFrame ?? 0
  );
}
