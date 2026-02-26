declare module "geotiff" {
  export interface GeoTIFFImage {
    getBoundingBox(): [number, number, number, number];
    getWidth(): number;
    getHeight(): number;
    getGDALNoData(): string | null;
    readRasters(options?: {
      samples?: number[];
      interleave?: boolean;
      window?: [number, number, number, number];
    }): Promise<TypedArray>;
  }

  export interface GeoTIFF {
    getImage(index?: number): Promise<GeoTIFFImage>;
  }

  export type TypedArray =
    | Uint8Array
    | Uint16Array
    | Uint32Array
    | Int8Array
    | Int16Array
    | Int32Array
    | Float32Array
    | Float64Array;

  export function fromFile(filePath: string): Promise<GeoTIFF>;
}
