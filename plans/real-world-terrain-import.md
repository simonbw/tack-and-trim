# Real-World Terrain Import Pipeline

## Current State

- Terrain is defined as `.terrain.json` files with closed Catmull-Rom spline contours at specified heights (in feet)
- The editor (`src/editor/`) allows hand-drawing contours with mouse interaction
- Files are loaded via browser File API in `EditorController.ts`
- No existing import-from-external-data capability
- Existing bin scripts use `tsx` for execution (e.g., `tsx ./bin/generate-asset-types.ts`)

### Terrain File Format

```json
{
  "version": 1,
  "defaultDepth": -50,
  "contours": [
    { "height": 0, "controlPoints": [[x, y], [x, y], ...] },
    { "height": 10, "controlPoints": [[x, y], [x, y], ...] }
  ]
}
```

Control points define closed Catmull-Rom spline loops. Heights are in feet. Contours nest geometrically (e.g., a `height: 10` contour inside a `height: 0` contour means a hill on an island). World units are feet.

## Desired Changes

Create an offline two-step pipeline for importing real-world terrain:

1. **Download** GeoTIFF topobathy data from NOAA for a given region
2. **Process** the raster data into contours and output a `.terrain.json` file

The pipeline should be general-purpose (any coastal region), with the San Juan Islands as the first target.

## Data Source

**NOAA CUDEM 1/9 arc-second (~3m resolution) topobathy tiles**
- URL: `https://coast.noaa.gov/htdata/raster2/elevation/NCEI_ninth_Topobathy_2014_8483/`
- GeoTIFF format, integrated land elevation + underwater depth
- Negative values = underwater, positive = above water
- NAVD88 vertical datum (effectively meters relative to sea level)
- No account required, direct HTTP download
- Tiles for San Juan Islands area are in `wash_juandefuca/` subfolder

## New Files

### `bin/import-terrain/download.ts` — Step 1: Download

Downloads CUDEM GeoTIFF tiles for a bounding box to local cache.

```
tsx bin/import-terrain/download.ts --region san-juan-islands
tsx bin/import-terrain/download.ts --bbox 48.4,-123.2,48.6,-122.9
```

Responsibilities:
- Predefined regions in a config object (san-juan-islands to start, easy to add more)
- Each region maps to a lat/lon bounding box
- Determines which CUDEM tile files cover the bounding box (tiles are organized by 1°x1° grid cells, named by their SW corner, e.g., `ncei19_n49x00_w123x00_2024v1.tif`)
- Downloads tiles to `data/terrain-cache/` (gitignored)
- Skips already-downloaded tiles (checks file existence)
- Shows download progress

### `bin/import-terrain/process.ts` — Step 2: Process

Reads cached GeoTIFF data and produces a `.terrain.json` file.

```
tsx bin/import-terrain/process.ts \
  --region san-juan-islands \
  --interval 20 \
  --simplify 50 \
  --scale 1 \
  --min-perimeter 500 \
  --output resources/terrain/san-juan-islands.terrain.json
```

Parameters:
- `--region` or `--bbox`: Which area to extract (must match downloaded data)
- `--interval`: Contour height interval in feet (default: 20). E.g., 20 produces contours at ..., -40, -20, 0, 20, 40, ...
- `--simplify`: Ramer-Douglas-Peucker tolerance in feet (default: 50). Higher = fewer points, lower fidelity
- `--scale`: Real-world feet per game-world foot (default: 1, i.e., 1:1). Use >1 to shrink the map
- `--min-perimeter`: Minimum contour perimeter in feet to keep (default: 500). Filters tiny features
- `--min-points`: Minimum control points per contour (default: 4). Contours with fewer points after simplification are dropped
- `--default-depth`: Deep ocean baseline depth in feet (default: -50)
- `--output`: Output file path

Processing steps:
1. **Read GeoTIFF** — Load raster data using `geotiff` npm package, get elevation values + geographic transform
2. **Crop to bounding box** — Extract the sub-region of interest
3. **Convert units** — GeoTIFF elevations are in meters, convert to feet. Geographic coordinates (lat/lon) convert to feet offsets from center of bounding box
4. **Extract contours** — Marching squares at each height level to produce closed polylines
5. **Simplify** — Ramer-Douglas-Peucker to reduce point count
6. **Filter** — Drop contours below minimum perimeter or minimum point count
7. **Scale** — Apply scale factor if not 1:1
8. **Output** — Write `.terrain.json` with the contour data

### `bin/import-terrain/lib/marching-squares.ts` — Contour extraction

Implement marching squares algorithm:
- Input: 2D grid of elevation values, target height
- Output: Array of closed polylines (each is an array of [x, y] points)
- Handles multiple disjoint contours at the same height
- Uses linear interpolation along cell edges for smooth contours

### `bin/import-terrain/lib/simplify.ts` — Polygon simplification

Implement Ramer-Douglas-Peucker:
- Input: Array of [x, y] points, tolerance
- Output: Simplified array of [x, y] points
- Standard recursive implementation

### `bin/import-terrain/lib/geo-utils.ts` — Geographic utilities

- `latLonToFeet(lat, lon, centerLat, centerLon)` — Convert lat/lon to feet offset from center
- `metersToFeet(m)` — Unit conversion
- Region presets object with bounding boxes

### `data/terrain-cache/` — Downloaded tile cache

- Add `data/` to `.gitignore`

## Dependencies to Add (devDependencies)

- `geotiff` — Read GeoTIFF raster files (well-maintained, ~200KB, no native deps)

That's it. Marching squares and RDP simplification are straightforward enough to implement ourselves (~100 lines each), avoiding extra dependencies.

## Files to Modify

- `.gitignore` — Add `data/` directory
- `package.json` — Add `geotiff` devDependency, add npm scripts:
  - `"download-terrain": "tsx bin/import-terrain/download.ts"`
  - `"process-terrain": "tsx bin/import-terrain/process.ts"`

## Execution Order

### Phase 1: Foundation (parallel)
- Create `bin/import-terrain/lib/marching-squares.ts`
- Create `bin/import-terrain/lib/simplify.ts`
- Create `bin/import-terrain/lib/geo-utils.ts`
- Add `data/` to `.gitignore`
- Install `geotiff` dependency

### Phase 2: Scripts (sequential, depends on Phase 1)
1. Create `bin/import-terrain/download.ts`
2. Create `bin/import-terrain/process.ts`
3. Add npm scripts to `package.json`

### Phase 3: Test with San Juan Islands
1. Run download for San Juan Islands region
2. Run process with conservative settings (large interval, high simplification)
3. Open result in terrain editor, iterate on parameters
4. Try progressively higher detail settings

## Notes

- The CUDEM tile naming convention uses the SW corner of each 1°x1° cell. For the San Juan Islands (~48.4°N, ~123°W), the relevant tile would be something like `ncei19_n49x00_w124x00_*.tif`. We'll need to verify the exact naming by listing the directory or checking the tile index.
- Catmull-Rom splines pass through their control points, so the simplified polygon vertices become the control points directly — no conversion needed. The spline will smooth things out, so aggressive simplification is fine as a starting point.
- The coordinate system flip: GeoTIFF has (0,0) at top-left with Y increasing downward. The game likely has Y increasing upward (or down for top-down 2D). We'll need to handle this in the coordinate transform.
- For scale context: San Juan Island itself is roughly 7 miles × 5 miles ≈ 37,000 × 26,000 feet. That's a reasonable game world size at 1:1 scale.
