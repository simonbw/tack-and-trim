export interface BoundingBox {
  minLat: number;
  minLon: number;
  maxLat: number;
  maxLon: number;
}

export interface RegionPreset {
  name: string;
  datasetPath: string;
  bbox: BoundingBox;
}

export const FEET_PER_METER = 3.280839895013123;
const EARTH_RADIUS_METERS = 6_378_137;

export const REGION_PRESETS: Record<string, RegionPreset> = {
  "san-juan-islands": {
    name: "San Juan Islands",
    datasetPath: "wash_juandefuca/",
    bbox: {
      minLat: 48.4,
      minLon: -123.35,
      maxLat: 48.75,
      maxLon: -122.75,
    },
  },
};

export function metersToFeet(meters: number): number {
  return meters * FEET_PER_METER;
}

export function feetToMeters(feet: number): number {
  return feet / FEET_PER_METER;
}

export function normalizeBbox(bbox: BoundingBox): BoundingBox {
  return {
    minLat: Math.min(bbox.minLat, bbox.maxLat),
    minLon: Math.min(bbox.minLon, bbox.maxLon),
    maxLat: Math.max(bbox.minLat, bbox.maxLat),
    maxLon: Math.max(bbox.minLon, bbox.maxLon),
  };
}

export function bboxCenter(bbox: BoundingBox): { lat: number; lon: number } {
  return {
    lat: (bbox.minLat + bbox.maxLat) * 0.5,
    lon: (bbox.minLon + bbox.maxLon) * 0.5,
  };
}

export function latLonToFeet(
  lat: number,
  lon: number,
  centerLat: number,
  centerLon: number,
): [number, number] {
  const latRad = (lat * Math.PI) / 180;
  const centerLatRad = (centerLat * Math.PI) / 180;
  const dLatRad = ((lat - centerLat) * Math.PI) / 180;
  const dLonRad = ((lon - centerLon) * Math.PI) / 180;

  const yMeters = dLatRad * EARTH_RADIUS_METERS;
  const xMeters = dLonRad * EARTH_RADIUS_METERS * Math.cos((latRad + centerLatRad) * 0.5);

  return [metersToFeet(xMeters), metersToFeet(yMeters)];
}

export function parseBboxArg(raw: string): BoundingBox {
  const values = raw
    .split(",")
    .map((v) => Number(v.trim()))
    .filter((v) => Number.isFinite(v));

  if (values.length !== 4) {
    throw new Error(
      `Invalid --bbox value: "${raw}". Expected "minLat,minLon,maxLat,maxLon"`,
    );
  }

  return normalizeBbox({
    minLat: values[0],
    minLon: values[1],
    maxLat: values[2],
    maxLon: values[3],
  });
}

export function resolveBbox(
  regionName: string | undefined,
  bboxArg: string | undefined,
): { bbox: BoundingBox; region: RegionPreset | null } {
  if (regionName && bboxArg) {
    throw new Error("Provide either --region or --bbox, not both");
  }

  if (!regionName && !bboxArg) {
    throw new Error("Provide one of --region or --bbox");
  }

  if (regionName) {
    const region = REGION_PRESETS[regionName];
    if (!region) {
      const valid = Object.keys(REGION_PRESETS)
        .sort()
        .join(", ");
      throw new Error(`Unknown region "${regionName}". Valid regions: ${valid}`);
    }
    return { bbox: normalizeBbox(region.bbox), region };
  }

  return { bbox: parseBboxArg(bboxArg!), region: null };
}

export function bboxIntersects(a: BoundingBox, b: BoundingBox): boolean {
  return !(a.maxLat <= b.minLat || a.minLat >= b.maxLat || a.maxLon <= b.minLon || a.minLon >= b.maxLon);
}

export function parseTileCoverageFromName(
  name: string,
): BoundingBox | null {
  const match = /_([ns])(\d{1,2})x(\d{2})_([ew])(\d{1,3})x(\d{2})_/i.exec(name);
  if (!match) {
    return null;
  }

  const latValue =
    (Number(match[2]) + Number(match[3]) / 100) *
    (match[1].toLowerCase() === "s" ? -1 : 1);
  const lonValue =
    (Number(match[5]) + Number(match[6]) / 100) *
    (match[4].toLowerCase() === "w" ? -1 : 1);

  // CUDEM ninth-arcsecond filenames encode quarter-degree-ish tile corners.
  // In this dataset, latitude token indicates the northern edge; longitude token
  // indicates the western edge.
  const tileSpanDegrees = 0.2505;
  const edgePaddingDegrees = 0.0005;

  return {
    minLat: latValue - tileSpanDegrees,
    maxLat: latValue + edgePaddingDegrees,
    minLon: lonValue - edgePaddingDegrees,
    maxLon: lonValue + tileSpanDegrees,
  };
}
