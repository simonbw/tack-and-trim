# Real-World Terrain Import Pipeline

Three-stage offline pipeline that downloads real-world bathymetric/topographic elevation data from NOAA and converts it into the game's `.level.json` contour format.

## Region Config

Each region is defined by a `region.json` file in `assets/terrain/<name>/`. This file contains all settings for the import pipeline (bbox, dataset path, contour interval, simplification tolerance, etc.). Large intermediate files (tiles, grid cache) are stored in subdirectories within the region folder and gitignored.

## Usage

### Install command (once)

```bash
ln -sf "$PWD/bin/terrain-import" "$HOME/.local/bin/terrain-import"
```

Make sure `~/.local/bin` is on your `PATH`.

### Enable zsh completion (once)

```bash
echo 'eval "$(terrain-import completion zsh)"' >> ~/.zshrc
source ~/.zshrc
```

`--region` suggestions are loaded dynamically from `assets/terrain/*/region.json`.

### Run the full pipeline

```bash
terrain-import --region san-juan-islands
```

Runs all three steps in sequence. If only one region exists, `--region` can be omitted.

Equivalent explicit form:

```bash
terrain-import import --region san-juan-islands
```

### Individual steps

#### 1. Download tiles

```bash
terrain-import download --region san-juan-islands
```

Downloads GeoTIFF tiles from NOAA's CUDEM dataset to `assets/terrain/<name>/tiles/`. Already-cached tiles are skipped.

#### 2. Build elevation grid

```bash
terrain-import build-grid --region san-juan-islands
```

Reads downloaded tiles, assembles a merged elevation grid, and caches the result to `assets/terrain/<name>/cache/`. Skips if cache is already valid.

#### 3. Extract contours

```bash
terrain-import extract --region san-juan-islands
```

Loads the cached grid, runs marching squares to extract iso-contour rings, simplifies them with Ramer-Douglas-Peucker, and writes the `.level.json` file. This is the fastest step and can be re-run independently to iterate on contour parameters.

## Adding a new region

1. Create `assets/terrain/<name>/region.json` with the region config
2. Configure the data source (see below)
3. Run `terrain-import --region <name>`

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

- `pipeline/terrain-import/src/main.rs` - CLI entrypoint (`download`, `build-grid`, `extract`, `validate`, `import`)
- `pipeline/terrain-import/src/region.rs` - Region discovery, config loading, path helpers
- `pipeline/terrain-import/src/download.rs` - Step 1: fetches GeoTIFF tiles from CUDEM / USACE / EMODnet
- `pipeline/terrain-import/src/build_grid.rs` - Step 2: merges tiles via `gdalwarp`
- `pipeline/terrain-import/src/extract.rs` - Step 3: GDAL raster load → marching squares → simplification → `.level.json`
- `pipeline/terrain-import/src/validate.rs` - Standalone/programmatic `.level.json` validation
- `pipeline/terrain-import/src/marching.rs` - Block index + marching squares + ring tracing
- `pipeline/terrain-import/src/simplify.rs` - RDP + ring geometry helpers
- `pipeline/terrain-import/src/constrained_simplify.rs` - RDP variant constrained by segment intersection checks
- `pipeline/terrain-import/src/segment_index.rs` - Spatial segment index for constrained simplification

Legacy TypeScript files in this directory are retained as reference only.
