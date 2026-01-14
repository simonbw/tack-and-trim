import SpatialHashingBroadphase from "../../physics/collision/broadphase/SpatialHashingBroadphase";
import { asyncProfiler } from "../AsyncProfiler";
import { profiler } from "../Profiler";
import { ProfileRow } from "./ProfileRow";
import type { StatsPanel, StatsPanelContext } from "./StatsPanel";

const TOP_N_PROFILES = 100;
const TOP_N_CHILDREN = 3;

declare global {
  interface PerformanceMemory {
    usedJSHeapSize: number;
    totalJSHeapSize: number;
    jsHeapSizeLimit: number;
  }

  interface Performance {
    /** Non-standard (Chrome-only) memory info. */
    memory?: PerformanceMemory;
  }
}

/**
 * Creates a profiler panel with CPU timing breakdown.
 */
export function createProfilerPanel(): StatsPanel {
  let profilingEnabled = true;

  return {
    id: "profiler",

    render: (ctx) => {
      const profileStats = profiler.getTopStats(TOP_N_PROFILES, TOP_N_CHILDREN);
      const basicStats = getBasicStats(ctx);
      const asyncStats = asyncProfiler.getStats();
      const totalAsyncMs = asyncProfiler.getTotalCallbackMs();

      // Find frame total for bar width calculations
      const frameStat = profileStats.find(
        (s) => s.label === "Game.loop" && s.depth === 0
      );
      const frameTotalMs = frameStat?.msPerFrame ?? 1000 / 120;

      return (
        <>
          <div className="stats-overlay__subheader">
            Entities: {basicStats.entityCount} | Bodies: {basicStats.bodyCount}
          </div>

          <div className="stats-overlay__subheader">
            Bodies: {basicStats.kinematicBodyCount}K /{" "}
            {basicStats.particleBodyCount}P / {basicStats.dynamicBodyCount}D /{" "}
            {basicStats.hugeBodyCount}H | Collisions: {basicStats.collisions}
          </div>

          <div className="stats-overlay__subheader">
            Memory:{" "}
            {performance.memory?.usedJSHeapSize != null
              ? (performance.memory.usedJSHeapSize / 1e6).toLocaleString(
                  undefined,
                  {
                    maximumFractionDigits: 0,
                  }
                )
              : "N/A"}
            {" / "}
            {performance.memory?.totalJSHeapSize != null
              ? (performance.memory.totalJSHeapSize / 1e6).toLocaleString(
                  undefined,
                  {
                    maximumFractionDigits: 0,
                  }
                )
              : "N/A"}
            {" / "}
            {(
              (performance as any).memory?.jsHeapSizeLimit / 1e6
            ).toLocaleString(undefined, {
              maximumFractionDigits: 0,
            }) ?? "N/A"}
            MB
          </div>

          <div className="stats-overlay__section">
            <div className="stats-overlay__section-header">
              <span className="stats-overlay__section-title">Profiler</span>
              <span className="stats-overlay__hint">
                [R] Reset | [P] {profilingEnabled ? "On" : "Off"}
              </span>
            </div>

            {profileStats.map((stat) => (
              <ProfileRow
                key={stat.label}
                stat={stat}
                frameTotalMs={frameTotalMs}
              />
            ))}

            {profileStats.length === 0 && (
              <div className="stats-overlay__empty">No profile data yet</div>
            )}
          </div>

          {asyncStats.length > 0 && (
            <div className="stats-overlay__section">
              <div className="stats-overlay__section-header">
                <span className="stats-overlay__section-title">
                  Async Callbacks
                </span>
                <span className="stats-overlay__hint">
                  Total: {totalAsyncMs.toFixed(2)}ms/frame
                </span>
              </div>

              {asyncStats.map((stat) => (
                <div key={stat.label} className="stats-row">
                  <span className="stats-row__label">{stat.label}</span>
                  <span className="stats-row__value">
                    {stat.callbackMsPerFrame.toFixed(2)}ms{" "}
                    <span className="stats-row__value--muted">
                      x{stat.completionsPerFrame.toFixed(1)}/frame
                      {stat.inFlightCount > 0 &&
                        ` (${stat.inFlightCount} pending)`}
                    </span>
                  </span>
                </div>
              ))}
            </div>
          )}
        </>
      );
    },

    onKeyDown: (_ctx, key) => {
      if (key === "KeyR") {
        profiler.reset();
        asyncProfiler.reset();
        return true;
      }
      if (key === "KeyP") {
        profilingEnabled = !profilingEnabled;
        profiler.setEnabled(profilingEnabled);
        asyncProfiler.setEnabled(profilingEnabled);
        return true;
      }
      return false;
    },
  };
}

function getBasicStats(ctx: StatsPanelContext) {
  const world = ctx.game.world;
  const broadphase = ctx.game.world.broadphase as SpatialHashingBroadphase;
  return {
    entityCount: ctx.game.entities.all.size,
    bodyCount: world.bodies.length,
    hugeBodyCount: broadphase.hugeBodies?.size ?? 0,
    dynamicBodyCount: world.bodies.dynamic.length,
    kinematicBodyCount: world.bodies.kinematic.length,
    particleBodyCount: broadphase.particleBodies.size,
    collisions: broadphase.debugData.numCollisions,
  };
}
