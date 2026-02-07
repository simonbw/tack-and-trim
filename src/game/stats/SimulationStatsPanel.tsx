import type {
  StatsPanel,
  StatsPanelContext,
} from "../../core/util/stats-overlay/StatsPanel";
import { StatsRow } from "../../core/util/stats-overlay/StatsRow";
import { SurfaceRenderer } from "../surface-rendering/SurfaceRenderer";
import { TerrainQuery } from "../world/terrain/TerrainQuery";
import { WaterQuery } from "../world/water/WaterQuery";
import { WindQuery } from "../world/wind/WindQuery";

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

/**
 * Creates a simulation stats panel showing query counts.
 */
export function createSimulationStatsPanel(): StatsPanel {
  return {
    id: "simulation",

    render: (ctx) => {
      const stats = getQueryStats(ctx);
      const terrainCache = getTerrainCacheStats(ctx);

      return (
        <>
          <div className="stats-overlay__header">
            <span>Simulation</span>
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

function getTerrainCacheStats(
  ctx: StatsPanelContext,
): TerrainCacheStats | null {
  const surfaceRenderer = ctx.game.entities.tryGetSingleton(SurfaceRenderer);
  if (!surfaceRenderer) return null;
  return surfaceRenderer.getTerrainTileCacheStats();
}
