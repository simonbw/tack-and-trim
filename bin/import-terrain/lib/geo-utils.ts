/**
 * Geographic coordinate utilities and region presets for terrain import.
 */

/** Bounding box in lat/lon coordinates */
export interface LatLonBBox {
  south: number;
  west: number;
  north: number;
  east: number;
}

/** A CUDEM tile reference with its subfolder and filename. */
export interface TileRef {
  subfolder: string;
  filename: string;
}

/** Region definition with bounding box and tile references. */
export interface RegionDef {
  bbox: LatLonBBox;
  tiles: TileRef[];
}

const S3_BASE =
  "https://noaa-nos-coastal-lidar-pds.s3.amazonaws.com/dem/NCEI_ninth_Topobathy_2014_8483";

/**
 * Predefined regions with bounding boxes and exact CUDEM tile paths.
 *
 * CUDEM tiles are 0.25° × 0.25°, named by their SW corner
 * (e.g. ncei19_n48x25_w123x00 covers 48.25-48.50°N, 123.00-122.75°W).
 * Tiles live in regional subdirectories with varying year/version suffixes,
 * so we enumerate them explicitly per region.
 */
export const REGIONS: Record<string, RegionDef> = {
  "san-juan-islands": {
    bbox: {
      south: 48.4,
      west: -123.2,
      north: 48.7,
      east: -122.75,
    },
    tiles: [
      // Row: 48.25°N - 48.50°N
      {
        subfolder: "wash_juandefuca",
        filename: "ncei19_n48x25_w123x25_2021v1.tif",
      },
      {
        subfolder: "wash_juandefuca",
        filename: "ncei19_n48x25_w123x00_2024v2.tif",
      },
      // Row: 48.50°N - 48.75°N
      {
        subfolder: "wash_bellingham",
        filename: "ncei19_n48x50_w123x25_2024v1.tif",
      },
      {
        subfolder: "wash_bellingham",
        filename: "ncei19_n48x50_w123x00_2024v1.tif",
      },
    ],
  },
};

/** Get the full download URL for a tile. */
export function getTileUrl(tile: TileRef): string {
  return `${S3_BASE}/${tile.subfolder}/${tile.filename}`;
}

const FEET_PER_METER = 3.28084;

/** Average Earth radius in feet */
const EARTH_RADIUS_FEET = 20_902_231;

/** Convert meters to feet. */
export function metersToFeet(m: number): number {
  return m * FEET_PER_METER;
}

/**
 * Convert lat/lon to feet offset from a center point.
 * Uses equirectangular projection (accurate enough for small regions).
 */
export function latLonToFeet(
  lat: number,
  lon: number,
  centerLat: number,
  centerLon: number,
): [number, number] {
  const latRadCenter = (centerLat * Math.PI) / 180;

  // Y: latitude difference in radians × Earth radius
  const dy = ((lat - centerLat) * Math.PI) / 180;
  const yFeet = dy * EARTH_RADIUS_FEET;

  // X: longitude difference, adjusted for latitude
  const dx = ((lon - centerLon) * Math.PI) / 180;
  const xFeet = dx * Math.cos(latRadCenter) * EARTH_RADIUS_FEET;

  return [xFeet, yFeet];
}

/**
 * Parse a bounding box from a string like "48.4,-123.2,48.7,-122.75"
 */
export function parseBBox(str: string): LatLonBBox {
  const parts = str.split(",").map(Number);
  if (parts.length !== 4 || parts.some(isNaN)) {
    throw new Error(
      `Invalid bounding box: "${str}". Expected: south,west,north,east`,
    );
  }
  return { south: parts[0], west: parts[1], north: parts[2], east: parts[3] };
}
