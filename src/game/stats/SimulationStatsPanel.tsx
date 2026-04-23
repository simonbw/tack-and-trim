import type {
  StatsPanel,
  StatsPanelContext,
} from "../../core/util/stats-overlay/StatsPanel";
import { StatsRow } from "../../core/util/stats-overlay/StatsRow";
import { SurfaceRenderer } from "../surface-rendering/SurfaceRenderer";
import { TerrainQuery } from "../world/terrain/TerrainQuery";
import { WaterModifierType } from "../world/water/WaterModifierBase";
import { WaterQuery } from "../world/water/WaterQuery";
import { MAX_MODIFIERS, WaterResources } from "../world/water/WaterResources";
import { WindQuery } from "../world/wind/WindQuery";

interface PhysicsStats {
  equations: number;
  islands: number;
  iterations: number;
  maxIterations: number;
  bodies: number;
  constraints: number;
}

interface QueryStats {
  waterPoints: number;
  waterQueries: number;
  terrainPoints: number;
  terrainQueries: number;
  windPoints: number;
  windQueries: number;
}

interface TerrainCacheStats {
  cachedTiles: number;
  readyTiles: number;
  currentLOD: number;
  worldUnitsPerTile: number;
}

interface ModifierStats {
  total: number;
  wake: number;
  foam: number;
  other: number;
}

/**
 * Creates a simulation stats panel showing query counts.
 */
export function createSimulationStatsPanel(): StatsPanel {
  return {
    id: "simulation",

    render: (ctx) => {
      const physics = getPhysicsStats(ctx);
      const stats = getQueryStats(ctx);
      const terrainCache = getTerrainCacheStats(ctx);
      const modifiers = getModifierStats(ctx);

      return (
        <>
          <div className="stats-overlay__header">
            <span>Simulation</span>
          </div>

          <div className="stats-overlay__section">
            <div className="stats-overlay__section-title">Physics</div>
            <div className="stats-overlay__grid">
              <StatsRow label="Bodies" value={physics.bodies} />
              <StatsRow label="Constraints" value={physics.constraints} />
              <StatsRow label="Equations" value={physics.equations} />
              <StatsRow label="Islands" value={physics.islands || "off"} />
              <StatsRow
                label="Iterations"
                value={`${physics.iterations} (max ${physics.maxIterations})`}
                color={physics.maxIterations >= 10 ? "warning" : undefined}
              />
            </div>
          </div>

          <div className="stats-overlay__section">
            <div className="stats-overlay__section-title">Queries</div>
            <div className="stats-overlay__grid">
              <StatsRow
                label="Water"
                value={`${stats.waterPoints.toLocaleString()} (${stats.waterQueries})`}
              />
              <StatsRow
                label="Terrain"
                value={`${stats.terrainPoints.toLocaleString()} (${stats.terrainQueries})`}
              />
              <StatsRow
                label="Wind"
                value={`${stats.windPoints.toLocaleString()} (${stats.windQueries})`}
              />
            </div>
          </div>

          {modifiers && (
            <div className="stats-overlay__section">
              <div className="stats-overlay__section-title">
                Water Modifiers
              </div>
              <div className="stats-overlay__grid">
                <StatsRow
                  label="Total"
                  value={`${modifiers.total.toLocaleString()} / ${MAX_MODIFIERS.toLocaleString()}`}
                  color={
                    modifiers.total >= MAX_MODIFIERS ? "warning" : undefined
                  }
                />
                <StatsRow
                  label="Wake"
                  value={modifiers.wake.toLocaleString()}
                />
                <StatsRow
                  label="Foam"
                  value={modifiers.foam.toLocaleString()}
                />
                {modifiers.other > 0 && (
                  <StatsRow
                    label="Other"
                    value={modifiers.other.toLocaleString()}
                  />
                )}
              </div>
            </div>
          )}

          {terrainCache && (
            <div className="stats-overlay__section">
              <div className="stats-overlay__section-title">Terrain Cache</div>
              <div className="stats-overlay__grid">
                <StatsRow
                  label="LOD"
                  value={`${terrainCache.currentLOD} (${terrainCache.worldUnitsPerTile}u/tile)`}
                />
                <StatsRow
                  label="Tiles"
                  value={`${terrainCache.readyTiles}/${terrainCache.cachedTiles}`}
                />
              </div>
            </div>
          )}
        </>
      );
    },
  };
}

function getPhysicsStats(ctx: StatsPanelContext): PhysicsStats {
  const world = ctx.game.world;
  return {
    equations: world.solverEquationCount,
    islands: world.solverIslandCount,
    iterations: world.solverIterations,
    maxIterations: world.solverMaxIterations,
    bodies: world.bodies.dynamic.length,
    constraints: world.constraints.length,
  };
}

function getQueryStats(ctx: StatsPanelContext): QueryStats {
  const waterQueries = [...ctx.game.entities.byConstructor(WaterQuery)];
  const terrainQueries = [...ctx.game.entities.byConstructor(TerrainQuery)];
  const windQueries = [...ctx.game.entities.byConstructor(WindQuery)];

  return {
    waterPoints: waterQueries.reduce((sum, q) => sum + q.results.length, 0),
    waterQueries: waterQueries.length,
    terrainPoints: terrainQueries.reduce((sum, q) => sum + q.results.length, 0),
    terrainQueries: terrainQueries.length,
    windPoints: windQueries.reduce((sum, q) => sum + q.results.length, 0),
    windQueries: windQueries.length,
  };
}

function getModifierStats(ctx: StatsPanelContext): ModifierStats | null {
  const waterResources = ctx.game.entities.tryGetSingleton(WaterResources);
  if (!waterResources) return null;

  let wake = 0;
  let foam = 0;
  let other = 0;
  for (const mod of waterResources.getCachedModifiers()) {
    switch (mod.data.type) {
      case WaterModifierType.Wake:
        wake++;
        break;
      case WaterModifierType.Foam:
        foam++;
        break;
      default:
        other++;
        break;
    }
  }

  return {
    total: wake + foam + other,
    wake,
    foam,
    other,
  };
}

function getTerrainCacheStats(
  ctx: StatsPanelContext,
): TerrainCacheStats | null {
  const surfaceRenderer = ctx.game.entities.tryGetSingleton(SurfaceRenderer);
  if (!surfaceRenderer) return null;
  return surfaceRenderer.getTerrainTileCacheStats();
}
