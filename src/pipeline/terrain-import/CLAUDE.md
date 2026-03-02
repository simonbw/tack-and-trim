# Real-World Terrain Import Pipeline

Three-stage offline pipeline that downloads real-world bathymetric/topographic elevation data from NOAA and converts it into the game's `.level.json` contour format.

## Region Config

Each region is defined by a `region.json` file in `assets/terrain/<name>/`. This file contains all settings for the import pipeline (bbox, dataset path, contour interval, simplification tolerance, etc.). Large intermediate files (tiles, grid cache) are stored in subdirectories within the region folder and gitignored.

## Usage

### Run the full pipeline

```bash
npm run import-terrain -- --region san-juan-islands
```

Runs all three steps in sequence. If only one region exists, `--region` can be omitted.

### Individual steps

#### 1. Download tiles

```bash
npm run download-terrain -- --region san-juan-islands
```

Downloads GeoTIFF tiles from NOAA's CUDEM dataset to `assets/terrain/<name>/tiles/`. Already-cached tiles are skipped.

#### 2. Build elevation grid

```bash
npm run build-terrain-grid -- --region san-juan-islands
```

Reads downloaded tiles, assembles a merged elevation grid, and caches the result to `assets/terrain/<name>/cache/`. Skips if cache is already valid.

#### 3. Extract contours

```bash
npm run extract-terrain-contours -- --region san-juan-islands
```

Loads the cached grid, runs marching squares to extract iso-contour rings, simplifies them with Ramer-Douglas-Peucker, and writes the `.level.json` file. This is the fastest step and can be re-run independently to iterate on contour parameters.

## Adding a new region

1. Create `assets/terrain/<name>/region.json` with the region config
2. Configure the data source (see below)
3. Run `npm run import-terrain -- --region <name>`

### Data sources

Each region specifies where to download elevation tiles via a `dataSource` field in `region.json`. Two source types are supported:

**NOAA CUDEM** (U.S. ocean coastlines, ~3m resolution):
```json
{
  "dataSource": { "type": "cudem", "datasetPath": "wash_bellingham/" }
}
```
The `datasetPath` must match a directory under `https://coast.noaa.gov/htdata/raster2/elevation/NCEI_ninth_Topobathy_2014_8483/`. Tiles are filtered by bbox using the CUDEM filename convention. For backward compatibility, a top-level `datasetPath` field (without `dataSource`) is also accepted.

**USACE S3** (e.g. Lake Superior DEM, ~1m resolution):
```json
{
  "dataSource": {
    "type": "usace-s3",
    "baseUrl": "https://noaa-nos-coastal-lidar-pds.s3.us-east-1.amazonaws.com/dem/USACE_Superior_DEM_2019_9185/",
    "statePrefix": "wi/",
    "urlList": "urllist9185.txt"
  }
}
```
Downloads all tiles matching the state prefix from the S3 bucket's URL list file. Spatial clipping is handled by `gdalwarp` in the build-grid step.

**EMODnet WCS** (European seas bathymetry, ~115m resolution):
```json
{
  "dataSource": { "type": "emodnet-wcs", "coverageId": "emodnet__mean" }
}
```
Downloads a single GeoTIFF via a WCS GetCoverage request from `https://ows.emodnet-bathymetry.eu/wcs`, cropped to the region bbox. Covers all European sea areas. The `coverageId` is typically `emodnet__mean` for the latest composite bathymetry.

## File structure

- `download.ts` - Step 1: fetches GeoTIFF tiles from NOAA
- `build-grid.ts` - Step 2: merges tiles into an elevation grid with binary cache
- `extract-contours.ts` - Step 3: marching squares → simplified contours → `.level.json`
- `run-all.ts` - Convenience script that runs all three steps
- `util/region.ts` - Region discovery and config loading
- `util/grid-cache.ts` - Grid binary cache format (save/load) and tile metadata
- `util/geo-utils.ts` - Geographic math (projections, bbox ops, unit conversion)
- `util/simplify.ts` - Ramer-Douglas-Peucker line simplification for closed rings
- `util/constrained-simplify.ts` - RDP variant that avoids crossing existing contours
- `util/segment-index.ts` - Spatial grid for fast segment intersection queries
- `worker/marching-squares.ts` - Marching squares types, ring tracer, and block index
- `worker/worker-pool.ts` - Distributes marching squares work across worker threads
- `worker/contour-worker.ts` - Worker thread: block index + marching squares algorithm
