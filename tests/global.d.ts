interface ParityFieldDiff {
  field: string;
  maxAbs: number;
  meanAbs: number;
  worstIndex: number;
  worstGpu: number;
  worstCpu: number;
  worstPoint: { x: number; y: number };
}

interface ParityPerTypeReport {
  pointCount: number;
  fields: ParityFieldDiff[];
}

interface ParityReport {
  pointCount: number;
  terrain: ParityPerTypeReport;
  water: ParityPerTypeReport;
  wind: ParityPerTypeReport;
  windMeshCpuHits: number;
}

declare global {
  interface Window {
    DEBUG: {
      game: { ticknumber: number; framenumber: number; paused?: boolean };
      gameStarted?: boolean;
      toggleMSAA?: () => void;
      runQueryParityCheck?: () => Promise<ParityReport>;
    };
    EDITOR_DEBUG: { game?: { ticknumber: number; framenumber: number } };
    BOAT_EDITOR_DEBUG: {
      game?: { ticknumber: number; framenumber: number };
      editor?: { loadPreset(name: string): void };
    };
  }
}
export {};
