/**
 * Interface for entities that want to provide custom stats sections
 * to the StatsOverlay. Implement this interface and add the "statsProvider"
 * tag to your entity to have your stats displayed in the graphics panel.
 */
export interface StatsSection {
  title: string;
  items: Array<{
    label: string;
    value: string | number;
    color?: "warning" | "error" | "success" | "muted";
    indent?: boolean;
  }>;
}

export interface StatsProvider {
  /** Return the stats section to display, or null if no stats available */
  getStatsSection(): StatsSection | null;

  /** Optional: Reset any per-frame tracking counters after reading */
  resetStatsCounters?(): void;
}
