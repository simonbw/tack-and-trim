# wavemesh-builder

Rust pipeline for building wave propagation meshes from terrain data. Replaces the TS mesh-building pipeline with significantly faster execution.

## Building

```sh
npm run build-wavemesh
```

This builds the release binary and runs it against all levels in `resources/levels/`.

## Profiling

See [pipeline/PROFILING.md](../PROFILING.md) for setup and usage. Quick start:

```sh
npm run profile-wavemesh:samply
```
