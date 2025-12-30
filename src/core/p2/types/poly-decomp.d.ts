declare module "poly-decomp" {
  export class Polygon {
    vertices: number[][];
    makeCCW(): void;
    removeCollinearPoints(threshold: number): void;
    isSimple(): boolean;
    decomp(): Polygon[];
    quickDecomp(): Polygon[];
  }
  export function makeCCW(polygon: number[][]): void;
  export function removeCollinearPoints(
    polygon: number[][],
    threshold: number
  ): number[][];
  export function isSimple(polygon: number[][]): boolean;
  export function decomp(polygon: number[][]): number[][][];
  export function quickDecomp(polygon: number[][]): number[][][];
}
