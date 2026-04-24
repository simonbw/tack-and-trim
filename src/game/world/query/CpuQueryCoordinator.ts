import { BaseEntity } from "../../../core/entity/BaseEntity";
import { on } from "../../../core/entity/handler";
import { profile } from "../../../core/util/Profiler";
import { CpuQueryManager } from "./CpuQueryManager";
import { defaultQueryWorkerCount, QueryWorkerPool } from "./QueryWorkerPool";
import type { QueryTypeId } from "./query-worker-protocol";
import { WavePhysicsResources } from "../../wave-physics/WavePhysicsResources";
import { TerrainResources } from "../terrain/TerrainResources";
import { TerrainResultLayout } from "../terrain/TerrainQueryResult";
import { createPlaceholderTideMeshBuffer } from "../water/TideMeshPacking";
import { TidalResources } from "../water/TidalResources";
import { WaterResources } from "../water/WaterResources";
import { WaterResultLayout } from "../water/WaterQueryResult";
import { WindResources } from "../wind/WindResources";
import { WindResultLayout } from "../wind/WindQueryResult";

/**
 * Shared buffer sizing per query type. Matches the GPU managers' maxPoints
 * so the CPU path can serve the same peak load without reallocating.
 */
const MAX_POINTS = 2 ** 15;

/**
 * Peer of `GpuQueryCoordinator`: owns a single `QueryWorkerPool` and
 * drives the CPU query managers through one generation bump per frame.
 *
 * Lifecycle:
 *   onAdd — construct the pool, discover all CpuQueryManager instances,
 *     inject the pool into each, mark them coordinated.
 *   afterPhysicsStep — for each manager: write params + collect points.
 *     If any manager has work, submit one batch to the pool.
 *   onDestroy — terminate the pool.
 */
export class CpuQueryCoordinator extends BaseEntity {
  id = "cpuQueryCoordinator";
  tickLayer = "query" as const;

  private pool: QueryWorkerPool | null = null;
  private managers: CpuQueryManager[] = [];

  @on("add")
  onAdd(): void {
    const windResources = this.game.entities.tryGetSingleton(WindResources);
    const windMeshRaw = windResources?.getPackedWindMeshRaw() ?? null;
    const terrainResources =
      this.game.entities.tryGetSingleton(TerrainResources);
    const terrainRaw = terrainResources?.getPackedTerrainRaw() ?? null;
    const waterResources = this.game.entities.tryGetSingleton(WaterResources);
    const modifierSab = waterResources?.getModifierDataSab() ?? null;
    const wavePhysics =
      this.game.entities.tryGetSingleton(WavePhysicsResources);
    const waveMeshRaw = wavePhysics?.getPackedMeshRaw() ?? null;
    const tidalResources = this.game.entities.tryGetSingleton(TidalResources);
    // Mirrors the GPU path: when TidalResources isn't present we fall
    // back to a placeholder (tideLevelCount=0) so the tidal-flow lookup
    // returns zero flow at every point.
    const tideMeshRaw =
      tidalResources?.getPackedTideMeshRaw() ??
      createPlaceholderTideMeshBuffer();

    this.pool = new QueryWorkerPool({
      workerCount: defaultQueryWorkerCount(),
      terrain: {
        maxPoints: MAX_POINTS,
        resultStride: TerrainResultLayout.stride,
        worldState: terrainRaw ? [terrainRaw] : [],
      },
      water: {
        maxPoints: MAX_POINTS,
        resultStride: WaterResultLayout.stride,
        worldState: waveMeshRaw ? [waveMeshRaw, tideMeshRaw] : [],
        frameStateSab: modifierSab,
      },
      wind: {
        maxPoints: MAX_POINTS,
        resultStride: WindResultLayout.stride,
        worldState: windMeshRaw ? [windMeshRaw] : [],
      },
    });

    for (const entity of this.game.entities.getTagged("queryManager")) {
      if (!(entity instanceof CpuQueryManager)) continue;
      entity.coordinated = true;
      entity.setPool(this.pool);
      this.managers.push(entity);
    }
  }

  @on("afterPhysicsStep")
  @profile
  onAfterPhysicsStep(): void {
    if (!this.pool) return;
    if (this.managers.length === 0) return;

    const descriptors: Array<{
      queryType: QueryTypeId;
      pointCount: number;
    }> = [];

    for (const manager of this.managers) {
      manager.writeParamsForFrame();
      const pointCount = manager.collectAndWritePoints();
      if (pointCount > 0) {
        descriptors.push({
          queryType: manager.queryType,
          pointCount,
        });
      }
    }

    if (descriptors.length === 0) return;

    this.pool.submit(descriptors);

    // Tell each manager it has a frame in flight so its onTick knows to
    // poll the pool for completion.
    for (const manager of this.managers) {
      manager.markFrameInFlight();
    }
  }

  @on("destroy")
  onDestroy(): void {
    if (this.pool) {
      this.pool.terminate();
      this.pool = null;
    }
    for (const manager of this.managers) {
      manager.coordinated = false;
    }
    this.managers = [];
  }
}
