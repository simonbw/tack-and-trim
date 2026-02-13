# Wave Terrain Mesh — Design

## Problem

Waves in the real world interact with terrain in complex, continuous ways. As a wave approaches a coastline, it slows down in shallow water, bends toward shore (refraction), loses energy to the seabed (damping), and grows taller as it compresses (shoaling). Behind islands, waves diffract around obstacles and create sheltered zones. All of these effects vary smoothly across space.

Our current system approximates these interactions with two independent mechanisms:

1. **Shadow polygons** — binary regions cast behind terrain that attenuate wave energy. These produce hard-edged shadows with no smooth falloff and no diffraction.
2. **Per-pixel analytical refraction** — each pixel independently computes a refraction offset based on the local depth gradient. This captures local bending but doesn't account for the cumulative path the wave has traveled, so it can't produce correct phase shifts or wavefront convergence/divergence.

These mechanisms are computed separately and combined, which leads to visible artifacts:

- **Hard shadow edges** — abrupt transitions between full-energy and zero-energy zones behind obstacles
- **No diffraction** — waves don't bend around obstacles into shadow zones
- **Incorrect phase** — refraction changes where wave crests are, but per-pixel computation can't track the accumulated phase along a curved path
- **No convergence/divergence** — when refraction focuses wave energy (e.g. at a headland), amplitude should increase; when it spreads energy, amplitude should decrease. Per-pixel refraction doesn't capture this.
- **Hard coastline boundaries** — waves terminate abruptly at the shore instead of gradually losing energy

## Goal

Replace the shadow polygon + per-pixel refraction system with a single unified structure that captures all terrain-wave interactions: blocking, refraction, shoaling, damping, convergence/divergence, phase accumulation, and (eventually) diffraction. The structure should produce smooth, continuous results everywhere — no hard edges, no grid artifacts, no discontinuities.

## Solution: The Wave Terrain Mesh

For each wave source, we construct a triangle mesh that covers the playable area. Each vertex stores how terrain modifies the base wave at that location. To find the terrain's influence on a wave at any point, we find the containing triangle and interpolate the vertex attributes — the GPU does this automatically during rasterization, and the query shader does it explicitly for physics lookups.

The Gerstner wave model still defines each wave's base amplitude, wavelength, period, and direction. The mesh only encodes how terrain modifies those properties. Areas outside the mesh (or outside any triangle) default to unmodified open ocean.

### Per-Vertex Data

Each vertex stores a world-space position and three modification values relative to the base wave:

| Field             | Default | Meaning                                                                                      |
| ----------------- | ------- | -------------------------------------------------------------------------------------------- |
| `amplitudeFactor` | 1.0     | Multiplier on wave amplitude. 0 = fully blocked, 1 = open ocean, >1 = focused by convergence |
| `directionOffset` | 0.0     | Change in propagation direction (radians) from refraction                                    |
| `phaseOffset`     | 0.0     | Correction to phase from the curved propagation path                                         |

The default `(1.0, 0.0, 0.0)` means "unmodified open ocean." This is a useful property: any region the mesh doesn't cover automatically behaves as if no terrain interaction exists.

### Why These Three Values

**Amplitude factor** is straightforward — terrain blocks, damps, and focuses wave energy, all of which change the wave's height.

**Direction offset** captures refraction. Waves bend toward shallower water because the shallow side of the wavefront travels slower than the deep side. This cumulative bending can't be computed per-pixel because each pixel doesn't know the wave's history — it only sees the local depth gradient. The mesh captures the accumulated direction change along the wave's actual path.

**Phase offset** is subtler. Without it, the renderer computes phase as `dot(position, waveDirection * k)`, which assumes the wave traveled in a straight line from the source. When refraction bends the wavefront, the actual phase at a point depends on the integral of wavenumber along the curved path. Without correction, wave crests appear discontinuous where refraction is strong. The stored `phaseOffset` is the difference between the true accumulated phase and the straight-line prediction.

## Mesh Construction (Open Question)

During level initialization, we build one mesh per wave source. The current approach is wavefront marching on the GPU — advancing a line of vertices step by step from the upwind edge, letting terrain influence each step. See `wavefront-mesh-system.md` for the detailed construction algorithm.

The construction method is the part of this system most likely to evolve. The important contract is that construction produces a triangle mesh with the per-vertex data described above, covering the playable area with enough resolution to capture terrain effects. The consumers (rendering and queries) don't care how the mesh was built.

### Traits we'd like the mesh to have

- Sparse where terrain effects are minimal or unchanging. We don't want to be wasting memory or compute on open ocean
- Dense where terrain is causing rapidly changing effects. Near shorelines in particular
- Models basic blocking, diffraction, refraction, shoaling, and damping. We should be able to see all these effects. So for example we want to see:
  - Islands have a wave shadow on their leeward side. Waves from the edges of the island will
- We should be able to fit 8 of them in graphics memory. I think this means we should try to keep the memory footprint of an individual finalized mesh to 128MB or less.

## Rendering

Each frame, the mesh is rasterized to a screen-space texture using a render pass with a vertex and fragment shader. The vertex shader transforms world-space positions to clip space. The fragment shader outputs the three modification values. The GPU hardware interpolates attributes across triangles — smooth and artifact-free.

The water height compute shader then samples this texture instead of computing shadow polygons and per-pixel refraction. A single texture lookup per wave source replaces the current per-pixel shadow evaluation + refraction computation + shoaling/damping calculation.

One texture layer per wave source, cleared to `(1.0, 0.0, 0.0)` (unmodified) before rasterization. One draw call per wave source per frame. The mesh is static, so the per-frame cost is just the draw calls with trivial shaders plus the texture samples in the water height shader.

## Queries

The boat and other game entities need wave field values at specific world positions for physics. The query compute shader finds the mesh triangle containing the query point and interpolates the vertex attributes using barycentric coordinates.

This gives exact consistency with the rendered result — the boat feels the same waves it sees, computed from the same mesh data. The lookup is fast because the mesh has a known structure that allows estimating the containing cell directly from the query point's position, then searching a small neighborhood.

## Properties

**Smooth everywhere.** Triangle interpolation produces continuous values across the entire mesh. Amplitude transitions smoothly from open ocean to blocked zones. Coastlines are soft because damping drives amplitude toward zero before the wave reaches land.

**Unified.** All terrain-wave interactions are captured in a single structure. There's no need to combine independent systems and hope they produce consistent results.

**Static after construction.** The mesh is built once at level load. Per-frame cost is purely rasterization and lookup.

**One mesh per wave source.** Each wave source gets its own mesh. The rendering and query systems compose the per-wave results into the final wave field, same as they do today.

**Resolution where needed.** The mesh can provide more geometric detail near terrain where wave properties change rapidly, and less in open ocean where everything is uniform.

## Scope and Boundaries

Things the mesh does:

- Encode how static terrain modifies each wave source's amplitude, direction, and phase
- Provide smooth, continuous values at any point via triangle interpolation

Things the mesh does not do:

- **Wave generation** — Gerstner waves define the base wave. The mesh only modifies.
- **Wave-wave interaction** — each wave source has an independent mesh
- **Dynamic obstacles** — the mesh is built against static terrain only
- **Time variation** — the mesh is constant during gameplay (tidal variation would require rebuilding)

## Future Enhancements

**Diffraction.** Vertices at the boundary between active wavefront and blocked terrain are natural diffraction source points. Additional geometry can fan wave energy into shadow zones, replacing the current Fresnel approximation with geometric wavefront spreading.

**Mesh simplification.** In open ocean, most vertices have values near the default `(1.0, 0.0, 0.0)`. Edge-collapse simplification can reduce triangle count significantly without visible quality loss.

**Tidal variation.** Building meshes at 2-3 tide levels and interpolating based on current tide would capture coastline shifts without per-frame reconstruction.
