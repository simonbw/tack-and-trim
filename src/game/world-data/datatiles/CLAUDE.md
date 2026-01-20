# Data Tiles (GPU Compute)

Spatial data computation using GPU with CPU fallback.

## Purpose

Wind and Water need to query spatial data (wind vector at position, water height at position). This system:

1. Renders data to GPU textures covering viewport tiles
2. Reads back to CPU for game logic queries
3. Falls back to CPU compute for out-of-viewport queries

## Architecture

- **DataTileManager** - Manages tile grid, handles viewport changes
- **WebGL/WebGPU backends** - Platform-specific GPU compute
- **Readback buffers** - Async GPU→CPU data transfer

## Used By

- `WindInfo` - Wind direction/speed field
- `WaterInfo` - Water height, normals, currents

## Performance Notes

- Tiles are computed per-frame for visible viewport
- CPU fallback is slower but necessary for queries outside view
- Readback is async to avoid GPU stalls
