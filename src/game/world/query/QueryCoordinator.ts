import { BaseEntity } from "../../../core/entity/BaseEntity";
import { on } from "../../../core/entity/handler";
import { profile } from "../../../core/util/Profiler";
import { QueryManager } from "./QueryManager";

/**
 * Batches all QueryManager GPU dispatches onto a single command encoder
 * with a single queue.submit() call, reducing CPU overhead from three
 * separate submits.
 *
 * Note: WebGPU compute passes are implicit synchronization barriers,
 * so this does not enable GPU parallelism between query dispatches.
 * Each manager still creates its own compute pass with its own GPU
 * timestamps for profiling.
 */
export class QueryCoordinator extends BaseEntity {
  id = "queryCoordinator";
  tickLayer = "query" as const;

  private managers: QueryManager[] = [];

  @on("add")
  onAdd(): void {
    for (const entity of this.game.entities.getTagged("queryManager")) {
      const manager = entity as QueryManager;
      manager.coordinated = true;
      this.managers.push(manager);
    }
  }

  @on("afterPhysicsStep")
  @profile
  onAfterPhysicsStep(): void {
    // Phase 1: Collect and upload points for all managers
    const counts: number[] = [];
    let anyPoints = false;
    for (const manager of this.managers) {
      const count = manager.collectAndUploadPoints();
      counts.push(count);
      if (count > 0) anyPoints = true;
    }

    if (!anyPoints) return;

    // Phase 2: Record all compute dispatches and copies on one encoder
    const device = this.game.getWebGPUDevice();
    const commandEncoder = device.createCommandEncoder({
      label: "QueryCoordinator Batch",
    });

    for (let i = 0; i < this.managers.length; i++) {
      if (counts[i] > 0) {
        this.managers[i].dispatchCompute(counts[i], commandEncoder);
      }
    }

    for (let i = 0; i < this.managers.length; i++) {
      if (counts[i] > 0) {
        this.managers[i].recordCopyToReadback(counts[i], commandEncoder);
      }
    }

    // Single submit
    device.queue.submit([commandEncoder.finish()]);

    // Phase 3: Start all mapAsync readbacks
    for (let i = 0; i < this.managers.length; i++) {
      if (counts[i] > 0) {
        this.managers[i].startReadback(counts[i]);
      }
    }
  }

  @on("destroy")
  onDestroy(): void {
    for (const manager of this.managers) {
      manager.coordinated = false;
    }
    this.managers = [];
  }
}
