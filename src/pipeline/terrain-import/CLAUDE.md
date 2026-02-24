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

1. Create `assets/terrain/<name>/region.json` with the region config (see `san-juan-islands/region.json` for an example)
2. The `datasetPath` must match a directory under `https://coast.noaa.gov/htdata/raster2/elevation/NCEI_ninth_Topobathy_2014_8483/`
3. Run `npm run import-terrain -- --region <name>`

## File structure

- `download.ts` - Step 1: fetches GeoTIFF tiles from NOAA
- `build-grid.ts` - Step 2: merges tiles into an elevation grid with binary cache
- `extract-contours.ts` - Step 3: marching squares → simplified contours → `.level.json`
- `run-all.ts` - Convenience script that runs all three steps
- `lib/region.ts` - Region discovery and config loading
- `lib/grid-cache.ts` - Grid binary cache format (save/load) and tile metadata
- `lib/geo-utils.ts` - Geographic math (projections, bbox ops, unit conversion)
- `lib/marching-squares.ts` - Marching squares contour extraction from a scalar grid
- `lib/simplify.ts` - Ramer-Douglas-Peucker line simplification for closed rings
