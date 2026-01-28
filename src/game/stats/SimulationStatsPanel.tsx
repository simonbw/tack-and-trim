import type {
  StatsPanel,
  StatsPanelContext,
} from "../../core/util/stats-overlay/StatsPanel";

/**
 * Creates a simulation stats panel showing water and wind tile computation stats.
 * Stub implementation - no stats available until real world system is implemented.
 */
export function createSimulationStatsPanel(): StatsPanel {
  return {
    id: "simulation",

    render: (_ctx: StatsPanelContext) => {
      return (
        <>
          <div className="stats-overlay__header">
            <span>Simulation (stub)</span>
          </div>
          <div style={{ padding: "8px", opacity: 0.5 }}>
            No simulation stats available (stub implementation)
          </div>
        </>
      );
    },
  };
}
