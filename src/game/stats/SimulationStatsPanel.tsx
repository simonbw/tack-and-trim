import type { VNode } from "preact";
import { profiler, type ProfileStats } from "../../core/util/Profiler";
import type {
  StatsPanel,
  StatsPanelContext,
} from "../../core/util/stats-overlay/StatsPanel";
import { StatsRow } from "../../core/util/stats-overlay/StatsRow";
import { WaterResources } from "../world/water/WaterResources";
import { WavePhysicsResources } from "../wave-physics/WavePhysicsResources";

interface WaterSystemStats {
  modifierCount: number;
  tideHeight: number;
  shadowsInitialized: boolean;
  cpuTickMs: number;
}

/**
 * Creates a simulation stats panel showing water system stats.
 * Displays modifier count, tide height, and performance metrics.
 */
export function createSimulationStatsPanel(): StatsPanel {
  return {
    id: "simulation",

    render: (ctx) => {
      const waterStats = getWaterStats(ctx);

      return (
        <>
          <div className="stats-overlay__header">
            <span>Simulation</span>
          </div>

          {renderWaterSection(waterStats)}
        </>
      );
    },
  };
}

function renderWaterSection(stats: WaterSystemStats | null): VNode {
  if (!stats) {
    return (
      <div className="stats-overlay__section">
        <div className="stats-overlay__section-title">Water</div>
        <div className="stats-overlay__grid">
          <StatsRow label="Status" value="Not initialized" color="muted" />
        </div>
      </div>
    );
  }

  return (
    <div className="stats-overlay__section">
      <div className="stats-overlay__section-title">Water</div>
      <div className="stats-overlay__grid">
        <StatsRow
          label="Modifiers"
          value={`${stats.modifierCount}`}
          color={stats.modifierCount > 1000 ? "warning" : undefined}
        />
        <StatsRow
          label="Tide Height"
          value={`${stats.tideHeight.toFixed(2)} ft`}
        />
        <StatsRow
          label="Shadows"
          value={stats.shadowsInitialized ? "Ready" : "Initializing"}
          color={stats.shadowsInitialized ? "success" : "warning"}
        />
        <StatsRow
          label="CPU onTick"
          value={`${stats.cpuTickMs.toFixed(2)}ms`}
          color={stats.cpuTickMs > 1 ? "warning" : undefined}
        />
      </div>
    </div>
  );
}

function getWaterStats(ctx: StatsPanelContext): WaterSystemStats | null {
  const waterResources = ctx.game.entities.tryGetSingleton(WaterResources);
  if (!waterResources) return null;

  const wavePhysicsResources =
    ctx.game.entities.tryGetSingleton(WavePhysicsResources);

  const profilerStats = profiler.getStats();
  const cpuTickMs = findProfilerMsByShortLabel(
    profilerStats,
    "onTick",
    "WaterResources",
  );

  return {
    modifierCount: waterResources.getModifierCount(),
    tideHeight: waterResources.getTideHeight(),
    shadowsInitialized: wavePhysicsResources?.isInitialized() ?? false,
    cpuTickMs,
  };
}

/**
 * Find profiler entry by short label (method name) and class name in the full path.
 * Profiler paths look like "Game.loop > tick > WaterResources.onTick"
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
