import type { StatsPanel } from "./StatsPanel";

/**
 * Creates a minimal panel with just the FPS header (no additional content).
 */
export function createLeanPanel(): StatsPanel {
  return {
    id: "lean",
    render: () => <></>,
  };
}
