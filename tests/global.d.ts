declare global {
  interface Window {
    DEBUG: { game: { ticknumber: number; framenumber: number } };
  }
}
export {};
