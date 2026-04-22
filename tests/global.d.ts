declare global {
  interface Window {
    DEBUG: { game: { ticknumber: number; framenumber: number } };
    EDITOR_DEBUG: { game?: { ticknumber: number; framenumber: number } };
    BOAT_EDITOR_DEBUG: {
      game?: { ticknumber: number; framenumber: number };
      editor?: { loadPreset(name: string): void };
    };
  }
}
export {};
