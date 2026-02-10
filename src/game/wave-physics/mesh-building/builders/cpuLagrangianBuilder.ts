/**
 * CPU Lagrangian wavefront marching mesh builder.
 *
 * Advances a polyline of vertices step-by-step from the upwind edge of the
 * simulation domain. At each step, terrain modifies the base wave (refraction,
 * shoaling, damping). Vertices hitting land continue through with amplitude=0
 * to maintain wavefront integrity. Diffraction is applied at shadow-edge
 * transitions using a Huygens-Fresnel wavelet model. Adaptive insertion and
 * removal keep the mesh dense near terrain and sparse in open ocean.
 *
 * No engine imports — safe for use in web workers.
 */

import type { WaveSource } from "../../../world/water/WaveSource";
import type {
  MeshBuildBounds,
  TerrainDataForWorker,
  WavefrontMeshData,
} from "../MeshBuildTypes";
import { computeTerrainHeight } from "../../cpu/terrainHeight";
import {
  computeWaveSpeed,
  computeRefractionOffset,
  computeWaveTerrainFactor,
} from "../../cpu/wavePhysics";

// =============================================================================
// Constants
// =============================================================================

/** Floats per output vertex: [x, y, amplitude, dirOffset, phaseOffset, blendWeight] */
const VERTEX_FLOATS = 6;

/** Finite-difference delta for depth gradient computation */
const GRADIENT_DELTA = 2.0;

/** Maximum convergence factor to prevent unrealistic energy concentration */
const MAX_CONVERGENCE = 2.0;

/** Maximum recursive insertion depth */
const MAX_INSERT_DEPTH = 0;

/** Maximum vertices allowed on a single wavefront to prevent OOM */
const MAX_WAVEFRONT_VERTICES = 200;

/** Log interval: log wavefront stats every N steps */
const LOG_INTERVAL = 50;

// Adaptive insertion thresholds
const THRESHOLD_AMP = 0.15;
const THRESHOLD_DIR = 0.1;
const THRESHOLD_PHASE = Math.PI / 4;

// Adaptive removal thresholds
const EPSILON_AMP = 0.02;
const EPSILON_DIR = 0.02;
const EPSILON_PHASE = 0.05;

// Diffraction range limit (beyond this, contribution is negligible)
const MAX_DIFFRACTION_VERTICES = 60;

// =============================================================================
// Internal types
// =============================================================================

const enum VertexState {
  ACTIVE = 0,
  ON_LAND = 1,
  SHADOWED = 2,
}

interface MarchVertex {
  x: number;
  y: number;
  dirAngle: number; // absolute propagation direction in radians
  amplitude: number;
  accumulatedPhase: number;
  phaseOffset: number;
  directionOffset: number;
  state: VertexState;
  /** Parametric position along the wavefront [0..1] */
  t: number;
  /** Cached terrain height at (x, y) to avoid recomputation next step */
  terrainH: number;
  /** Blend weight for edge fade-out (0 at domain boundary, 1 interior) */
  blendWeight: number;
}

// =============================================================================
// Main builder
// =============================================================================

export function buildCpuLagrangianMesh(
  waveSource: WaveSource,
  coastlineBounds: MeshBuildBounds | null,
  terrain: TerrainDataForWorker,
  tideHeight: number,
): WavefrontMeshData {
  const wavelength = waveSource.wavelength;
  const baseDir = waveSource.direction;
  const k = (2 * Math.PI) / wavelength;

  // Deep-water speed for adaptive stepping
  const deepSpeed = computeWaveSpeed(wavelength, wavelength); // depth >= wavelength/2

  // Step size
  const baseStepSize = wavelength / 2;

  // Vertex spacing along wavefront
  const vertexSpacing = wavelength;
  const maxSpacing = wavelength * 2;

  // Simulation bounds
  let minX: number, maxX: number, minY: number, maxY: number;
  if (coastlineBounds) {
    const margin = Math.max(2000, wavelength * 3);
    minX = coastlineBounds.minX - margin;
    maxX = coastlineBounds.maxX + margin;
    minY = coastlineBounds.minY - margin;
    maxY = coastlineBounds.maxY + margin;
  } else {
    minX = -500;
    maxX = 500;
    minY = -500;
    maxY = 500;
  }

  // Wave direction vectors
  const waveDx = Math.cos(baseDir);
  const waveDy = Math.sin(baseDir);
  // Perpendicular (left) direction for wavefront line
  const perpDx = -waveDy;
  const perpDy = waveDx;

  // Compute how far we march along the wave direction
  const corners = [
    [minX, minY],
    [maxX, minY],
    [maxX, maxY],
    [minX, maxY],
  ];
  let minProj = Infinity;
  let maxProj = -Infinity;
  let minPerp = Infinity;
  let maxPerp = -Infinity;
  for (const [cx, cy] of corners) {
    const proj = cx * waveDx + cy * waveDy;
    const perp = cx * perpDx + cy * perpDy;
    if (proj < minProj) minProj = proj;
    if (proj > maxProj) maxProj = proj;
    if (perp < minPerp) minPerp = perp;
    if (perp > maxPerp) maxPerp = perp;
  }

  const marchDistance = maxProj - minProj;
  const wavefrontWidth = maxPerp - minPerp;

  // Number of initial vertices along the wavefront
  const numInitialVertices = Math.max(
    3,
    Math.ceil(wavefrontWidth / vertexSpacing) + 1,
  );

  // ==========================================================================
  // Phase 1: Initialize first wavefront
  // ==========================================================================

  let currentWavefront: MarchVertex[] = [];

  for (let i = 0; i < numInitialVertices; i++) {
    const t = i / (numInitialVertices - 1);
    const perpPos = minPerp + t * wavefrontWidth;
    const x = minProj * waveDx + perpPos * perpDx;
    const y = minProj * waveDy + perpPos * perpDy;

    const terrainH = computeTerrainHeight(x, y, terrain);
    const depth = tideHeight - terrainH;
    const onLand = depth <= 0;

    currentWavefront.push({
      x,
      y,
      dirAngle: baseDir,
      amplitude: onLand ? 0 : 1.0,
      accumulatedPhase: 0,
      phaseOffset: 0,
      directionOffset: 0,
      state: onLand ? VertexState.ON_LAND : VertexState.ACTIVE,
      t,
      terrainH,
      blendWeight: 1.0,
    });
  }

  // ==========================================================================
  // Preallocate output buffers (grow as needed)
  // ==========================================================================

  const estimatedSteps = Math.ceil(marchDistance / baseStepSize) + 1;
  const estimatedVerticesPerStep = numInitialVertices * 2; // conservative
  let vertexCapacity = estimatedSteps * estimatedVerticesPerStep;
  let indexCapacity = vertexCapacity * 6;

  let vertices = new Float32Array(vertexCapacity * VERTEX_FLOATS);
  let indices = new Uint32Array(indexCapacity);
  let vertexCount = 0;
  let indexCount = 0;

  // Write initial wavefront to output
  for (const v of currentWavefront) {
    writeVertex(v);
  }

  // ==========================================================================
  // Phase 2-6: March wavefront step-by-step
  // ==========================================================================

  let marched = 0;
  let step = 0;
  const maxSteps = estimatedSteps + 50; // safety margin

  console.log(
    `[CpuLagrangian] Starting march: ${numInitialVertices} initial verts, ` +
      `~${estimatedSteps} steps, marchDist=${marchDistance.toFixed(0)}, ` +
      `wavefrontWidth=${wavefrontWidth.toFixed(0)}`,
  );

  while (marched < marchDistance && step < maxSteps) {
    step++;

    const prevWavefront = currentWavefront;
    const prevBaseIndex = vertexCount - prevWavefront.length;
    const nextWavefront: MarchVertex[] = [];

    // Initial spacing for convergence factor
    const initialSpacing =
      wavefrontWidth / Math.max(1, prevWavefront.length - 1);

    // ------------------------------------------------------------------
    // March each vertex
    // ------------------------------------------------------------------

    for (let i = 0; i < prevWavefront.length; i++) {
      const pv = prevWavefront[i];

      // Use cached terrain height from previous step (avoids recomputation)
      const terrainH = pv.terrainH;
      const depth = tideHeight - terrainH;
      const onLand = depth <= 0;

      // Refraction: skip on land and in deep/very-shallow water where
      // computeRefractionOffset returns 0 anyway
      let newDir = pv.dirAngle;
      if (!onLand) {
        const deepThreshold = wavelength * 0.5;
        const shallowThreshold = wavelength * 0.05;
        if (depth < deepThreshold && depth > shallowThreshold) {
          // Depth gradient via finite differences (only when refraction applies)
          const hPx = computeTerrainHeight(
            pv.x + GRADIENT_DELTA,
            pv.y,
            terrain,
          );
          const hMx = computeTerrainHeight(
            pv.x - GRADIENT_DELTA,
            pv.y,
            terrain,
          );
          const hPy = computeTerrainHeight(
            pv.x,
            pv.y + GRADIENT_DELTA,
            terrain,
          );
          const hMy = computeTerrainHeight(
            pv.x,
            pv.y - GRADIENT_DELTA,
            terrain,
          );
          // depth = tideHeight - terrainHeight, so depthGradient = -terrainGradient
          const gradX = -(hPx - hMx) / (2 * GRADIENT_DELTA);
          const gradY = -(hPy - hMy) / (2 * GRADIENT_DELTA);

          const refrOffset = computeRefractionOffset(
            pv.dirAngle,
            wavelength,
            depth,
            gradX,
            gradY,
          );
          newDir = pv.dirAngle + refrOffset;
        }
      }

      // Adaptive step distance
      const localSpeed = onLand
        ? deepSpeed
        : computeWaveSpeed(wavelength, Math.max(depth, 0.1));
      const stepDist = baseStepSize * (localSpeed / deepSpeed);

      // Advance position
      const newX = pv.x + Math.cos(newDir) * stepDist;
      const newY = pv.y + Math.sin(newDir) * stepDist;

      // Terrain at new position
      const newTerrainH = computeTerrainHeight(newX, newY, terrain);
      const newDepth = tideHeight - newTerrainH;
      const newOnLand = newDepth <= 0;

      // State transition
      let newState: VertexState;
      if (newOnLand) {
        newState = VertexState.ON_LAND;
      } else if (
        pv.state === VertexState.ON_LAND ||
        pv.state === VertexState.SHADOWED
      ) {
        // Re-entering water from land → shadowed
        newState = VertexState.SHADOWED;
      } else {
        newState = VertexState.ACTIVE;
      }

      // Amplitude
      let newAmplitude: number;
      if (newOnLand || newState === VertexState.SHADOWED) {
        newAmplitude = 0;
      } else {
        newAmplitude = computeWaveTerrainFactor(newDepth, wavelength);
      }

      // Phase tracking
      const newAccPhase = pv.accumulatedPhase + k * stepDist;
      const dotProd = (newX * waveDx + newY * waveDy) * k;
      const newPhaseOffset = newAccPhase - dotProd;

      // Convergence/divergence
      if (
        i > 0 &&
        i < prevWavefront.length - 1 &&
        newState === VertexState.ACTIVE
      ) {
        // Measure spacing from neighbors (using previous wavefront positions for stability)
        const prevNeighbor = prevWavefront[i - 1];
        const nextNeighbor = prevWavefront[i + 1];
        const prevSpacing = Math.sqrt(
          (nextNeighbor.x - prevNeighbor.x) ** 2 +
            (nextNeighbor.y - prevNeighbor.y) ** 2,
        );
        if (prevSpacing > 0 && initialSpacing > 0) {
          const convergence = Math.min(
            MAX_CONVERGENCE,
            Math.sqrt(initialSpacing / prevSpacing),
          );
          newAmplitude *= convergence;
        }
      }

      // Cap amplitude
      newAmplitude = Math.min(newAmplitude, MAX_CONVERGENCE);

      // Direction offset
      const newDirOffset = newDir - baseDir;

      nextWavefront.push({
        x: newX,
        y: newY,
        dirAngle: newDir,
        amplitude: newAmplitude,
        accumulatedPhase: newAccPhase,
        phaseOffset: newPhaseOffset,
        directionOffset: newDirOffset,
        state: newState,
        t: pv.t,
        terrainH: newTerrainH,
        blendWeight: 1.0,
      });
    }

    marched += baseStepSize;

    // ------------------------------------------------------------------
    // Phase 5: Diffraction
    // ------------------------------------------------------------------

    applyDiffraction(nextWavefront, wavelength, k);

    // ------------------------------------------------------------------
    // Phase 6: Adaptive detail
    // ------------------------------------------------------------------

    adaptiveInsert(
      nextWavefront,
      terrain,
      tideHeight,
      wavelength,
      k,
      baseDir,
      waveDx,
      waveDy,
      maxSpacing,
    );

    adaptiveRemove(nextWavefront, maxSpacing);

    // Safety cap: prevent runaway wavefront growth
    if (nextWavefront.length > MAX_WAVEFRONT_VERTICES) {
      console.warn(
        `[CpuLagrangian] Step ${step}: wavefront hit cap ` +
          `(${nextWavefront.length} > ${MAX_WAVEFRONT_VERTICES}), truncating`,
      );
      nextWavefront.length = MAX_WAVEFRONT_VERTICES;
    }

    // Periodic logging
    if (step % LOG_INTERVAL === 0 || step === 1) {
      console.log(
        `[CpuLagrangian] Step ${step}/${maxSteps}: ` +
          `wavefront=${nextWavefront.length} verts, ` +
          `totalVerts=${vertexCount}, marched=${marched.toFixed(0)}/${marchDistance.toFixed(0)}`,
      );
    }

    // ------------------------------------------------------------------
    // Phase 3: Triangulation — connect prevWavefront to nextWavefront
    // ------------------------------------------------------------------

    // Ensure we have capacity
    const neededVerts = vertexCount + nextWavefront.length;
    const neededIdx =
      indexCount + (prevWavefront.length + nextWavefront.length) * 3;
    ensureVertexCapacity(neededVerts);
    ensureIndexCapacity(neededIdx);

    // Write next wavefront vertices
    const nextBaseIndex = vertexCount;
    for (const v of nextWavefront) {
      writeVertex(v);
    }

    // Sweep-line triangulation by parametric position t
    triangulate(prevWavefront, nextWavefront, prevBaseIndex, nextBaseIndex);

    currentWavefront = nextWavefront;
  }

  console.log(
    `[CpuLagrangian] Done: ${step} steps, ${vertexCount} total verts, ` +
      `${indexCount / 3} triangles, final wavefront=${currentWavefront.length}`,
  );

  // Set blendWeight=0 for boundary vertices so the mesh fades to open-ocean defaults
  for (let vi = 0; vi < vertexCount; vi++) {
    const base = vi * VERTEX_FLOATS;
    const vx = vertices[base + 0];
    const vy = vertices[base + 1];
    if (
      vx - minX < vertexSpacing ||
      maxX - vx < vertexSpacing ||
      vy - minY < vertexSpacing ||
      maxY - vy < vertexSpacing
    ) {
      vertices[base + 5] = 0.0; // blendWeight
    }
  }

  // Return trimmed buffers
  return {
    vertices: vertices.slice(0, vertexCount * VERTEX_FLOATS),
    indices: indices.slice(0, indexCount),
    vertexCount,
    indexCount,
  };

  // ==========================================================================
  // Helper closures (access builder state via closure)
  // ==========================================================================

  function writeVertex(v: MarchVertex): void {
    ensureVertexCapacity(vertexCount + 1);
    const base = vertexCount * VERTEX_FLOATS;
    vertices[base + 0] = v.x;
    vertices[base + 1] = v.y;
    vertices[base + 2] = v.amplitude;
    vertices[base + 3] = v.directionOffset;
    vertices[base + 4] = v.phaseOffset;
    vertices[base + 5] = v.blendWeight;
    vertexCount++;
  }

  function ensureVertexCapacity(needed: number): void {
    if (needed * VERTEX_FLOATS > vertices.length) {
      const newCap = Math.max(needed * 2, vertexCapacity * 2);
      const newArr = new Float32Array(newCap * VERTEX_FLOATS);
      newArr.set(vertices);
      vertices = newArr;
      vertexCapacity = newCap;
    }
  }

  function ensureIndexCapacity(needed: number): void {
    if (needed > indices.length) {
      const newCap = Math.max(needed * 2, indexCapacity * 2);
      const newArr = new Uint32Array(newCap);
      newArr.set(indices);
      indices = newArr;
      indexCapacity = newCap;
    }
  }

  function triangulate(
    prevWF: MarchVertex[],
    nextWF: MarchVertex[],
    prevBase: number,
    nextBase: number,
  ): void {
    const m = prevWF.length;
    const n = nextWF.length;
    if (m < 2 && n < 2) return;

    let i = 0;
    let j = 0;

    while (i < m - 1 || j < n - 1) {
      if (i >= m - 1) {
        // Only advance j
        emitTri(prevBase + i, nextBase + j, nextBase + j + 1);
        j++;
      } else if (j >= n - 1) {
        // Only advance i
        emitTri(prevBase + i, prevBase + i + 1, nextBase + j);
        i++;
      } else if (prevWF[i + 1].t < nextWF[j + 1].t) {
        emitTri(prevBase + i, prevBase + i + 1, nextBase + j);
        i++;
      } else {
        emitTri(prevBase + i, nextBase + j, nextBase + j + 1);
        j++;
      }
    }
  }

  function emitTri(a: number, b: number, c: number): void {
    ensureIndexCapacity(indexCount + 3);
    indices[indexCount++] = a;
    indices[indexCount++] = b;
    indices[indexCount++] = c;
  }
}

// =============================================================================
// Diffraction
// =============================================================================

function applyDiffraction(
  wavefront: MarchVertex[],
  wavelength: number,
  k: number,
): void {
  const n = wavefront.length;
  if (n < 2) return;

  // Collect shadow-edge locations
  interface DiffractionEdge {
    tipIndex: number;
    tipX: number;
    tipY: number;
    tipAmplitude: number;
    tipPhase: number;
    /** Direction into the shadow zone: +1 = increasing index, -1 = decreasing */
    shadowDir: 1 | -1;
  }

  const edges: DiffractionEdge[] = [];

  for (let i = 0; i < n - 1; i++) {
    const a = wavefront[i];
    const b = wavefront[i + 1];

    const aActive = a.state === VertexState.ACTIVE && a.amplitude > 0.01;
    const bActive = b.state === VertexState.ACTIVE && b.amplitude > 0.01;

    if (aActive && !bActive) {
      edges.push({
        tipIndex: i,
        tipX: a.x,
        tipY: a.y,
        tipAmplitude: a.amplitude,
        tipPhase: a.accumulatedPhase,
        shadowDir: 1,
      });
    } else if (!aActive && bActive) {
      edges.push({
        tipIndex: i + 1,
        tipX: b.x,
        tipY: b.y,
        tipAmplitude: b.amplitude,
        tipPhase: b.accumulatedPhase,
        shadowDir: -1,
      });
    }
  }

  if (edges.length === 0) return;

  // Apply diffraction from each edge into the shadow zone
  for (const edge of edges) {
    const dir = edge.shadowDir;
    let idx = edge.tipIndex + dir;
    let count = 0;

    while (idx >= 0 && idx < n && count < MAX_DIFFRACTION_VERTICES) {
      const v = wavefront[idx];

      // Only modify non-active vertices (shadowed or on-land in water)
      if (v.state !== VertexState.ACTIVE) {
        const dx = v.x - edge.tipX;
        const dy = v.y - edge.tipY;
        const r = Math.sqrt(dx * dx + dy * dy);

        if (r > 0.1) {
          // Angle into shadow zone
          const diffAngle = Math.atan2(dy, dx);
          const baseAngle = Math.atan2(
            wavefront[edge.tipIndex].y -
              (edge.tipIndex - dir >= 0 && edge.tipIndex - dir < n
                ? wavefront[edge.tipIndex - dir].y
                : wavefront[edge.tipIndex].y),
            wavefront[edge.tipIndex].x -
              (edge.tipIndex - dir >= 0 && edge.tipIndex - dir < n
                ? wavefront[edge.tipIndex - dir].x
                : wavefront[edge.tipIndex].x),
          );

          // Relative angle into shadow
          let theta = Math.abs(angleDiff(diffAngle, baseAngle));
          theta = Math.min(theta, Math.PI);

          // Angular distribution: cos(theta/2) for [0, PI]
          const angularFactor = Math.cos(theta / 2);

          // Cylindrical spreading: sqrt(lambda / (2*pi*r))
          const spreading = Math.sqrt(wavelength / (2 * Math.PI * r));

          // Diffracted amplitude
          const diffAmp =
            edge.tipAmplitude * spreading * Math.max(0, angularFactor);

          if (diffAmp > v.amplitude) {
            // Incoherent addition with existing amplitude
            v.amplitude = Math.sqrt(
              v.amplitude * v.amplitude + diffAmp * diffAmp,
            );

            // Direction: from tip toward this vertex
            v.directionOffset =
              diffAngle - wavefront[edge.tipIndex].dirAngle + v.directionOffset;

            // Phase: tip's phase + k * r
            v.phaseOffset += edge.tipPhase + k * r - v.accumulatedPhase;

            // Transition from ON_LAND to SHADOWED if in water
            if (v.state === VertexState.ON_LAND) {
              // Keep ON_LAND state — diffraction still applies the amplitude
            }
          }
        }
      }

      idx += dir;
      count++;
    }
  }
}

// =============================================================================
// Adaptive detail
// =============================================================================

function adaptiveInsert(
  wavefront: MarchVertex[],
  terrain: TerrainDataForWorker,
  tideHeight: number,
  wavelength: number,
  k: number,
  baseDir: number,
  waveDx: number,
  waveDy: number,
  maxSpacing: number,
): void {
  insertPass(
    wavefront,
    terrain,
    tideHeight,
    wavelength,
    k,
    baseDir,
    waveDx,
    waveDy,
    maxSpacing,
    0,
  );
}

function insertPass(
  wavefront: MarchVertex[],
  terrain: TerrainDataForWorker,
  tideHeight: number,
  wavelength: number,
  k: number,
  baseDir: number,
  waveDx: number,
  waveDy: number,
  maxSpacing: number,
  depth: number,
): void {
  if (depth >= MAX_INSERT_DEPTH) return;

  // Minimum spacing to prevent infinite subdivision
  const minSpacing = wavelength / 16;

  // Build a new array instead of splicing (O(n) vs O(n²))
  const result: MarchVertex[] = [];
  let inserted = false;

  for (let i = 0; i < wavefront.length; i++) {
    result.push(wavefront[i]);

    if (
      i < wavefront.length - 1 &&
      result.length + (wavefront.length - i - 1) < MAX_WAVEFRONT_VERTICES
    ) {
      const a = wavefront[i];
      const b = wavefront[i + 1];

      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.sqrt(dx * dx + dy * dy);

      // Don't subdivide below minimum spacing
      if (dist >= minSpacing) {
        const ampDiff = Math.abs(b.amplitude - a.amplitude);
        const dirDiff = Math.abs(
          angleDiff(b.directionOffset, a.directionOffset),
        );
        const phaseDiff = Math.abs(b.phaseOffset - a.phaseOffset);

        const shouldInsert =
          ampDiff > THRESHOLD_AMP ||
          dirDiff > THRESHOLD_DIR ||
          phaseDiff > THRESHOLD_PHASE ||
          dist > maxSpacing;

        if (shouldInsert) {
          const mx = (a.x + b.x) * 0.5;
          const my = (a.y + b.y) * 0.5;
          const mt = (a.t + b.t) * 0.5;

          const terrainH = computeTerrainHeight(mx, my, terrain);
          const mDepth = tideHeight - terrainH;
          const onLand = mDepth <= 0;

          let mState: VertexState;
          if (onLand) {
            mState = VertexState.ON_LAND;
          } else if (
            a.state === VertexState.SHADOWED ||
            b.state === VertexState.SHADOWED
          ) {
            mState = VertexState.SHADOWED;
          } else if (
            a.state === VertexState.ON_LAND &&
            b.state === VertexState.ON_LAND
          ) {
            mState = VertexState.ON_LAND;
          } else {
            mState = VertexState.ACTIVE;
          }

          const mAmp =
            onLand || mState === VertexState.SHADOWED
              ? 0
              : mState === VertexState.ON_LAND
                ? 0
                : computeWaveTerrainFactor(mDepth, wavelength);

          const mDir = (a.dirAngle + b.dirAngle) * 0.5;
          const mAccPhase = (a.accumulatedPhase + b.accumulatedPhase) * 0.5;
          const dotProd = (mx * waveDx + my * waveDy) * k;
          const mPhaseOffset = mAccPhase - dotProd;

          result.push({
            x: mx,
            y: my,
            dirAngle: mDir,
            amplitude: mAmp,
            accumulatedPhase: mAccPhase,
            phaseOffset: mPhaseOffset,
            directionOffset: mDir - baseDir,
            state: mState,
            t: mt,
            terrainH,
            blendWeight: 1.0,
          });
          inserted = true;
        }
      }
    }
  }

  // Copy result back into wavefront array
  wavefront.length = result.length;
  for (let i = 0; i < result.length; i++) {
    wavefront[i] = result[i];
  }

  // Recurse if we inserted anything
  if (inserted && depth < MAX_INSERT_DEPTH - 1) {
    insertPass(
      wavefront,
      terrain,
      tideHeight,
      wavelength,
      k,
      baseDir,
      waveDx,
      waveDy,
      maxSpacing,
      depth + 1,
    );
  }
}

function adaptiveRemove(wavefront: MarchVertex[], maxSpacing: number): void {
  if (wavefront.length < 3) return;

  // Build a filtered array instead of splicing (O(n) vs O(n²))
  const result: MarchVertex[] = [wavefront[0]]; // always keep first

  for (let i = 1; i < wavefront.length - 1; i++) {
    const prev = result[result.length - 1]; // last kept vertex
    const curr = wavefront[i];
    const next = wavefront[i + 1];

    // Don't remove vertices adjacent to shadow-edge transitions
    if (isShadowEdge(prev, curr) || isShadowEdge(curr, next)) {
      result.push(curr);
      continue;
    }

    // Check if removal would create too-wide spacing
    const dx = next.x - prev.x;
    const dy = next.y - prev.y;
    const newSpacing = Math.sqrt(dx * dx + dy * dy);
    if (newSpacing > maxSpacing) {
      result.push(curr);
      continue;
    }

    // Check if linearly interpolating from neighbors would be accurate enough
    const interpAmp = (prev.amplitude + next.amplitude) * 0.5;
    const interpDir = (prev.directionOffset + next.directionOffset) * 0.5;
    const interpPhase = (prev.phaseOffset + next.phaseOffset) * 0.5;

    const ampErr = Math.abs(curr.amplitude - interpAmp);
    const dirErr = Math.abs(angleDiff(curr.directionOffset, interpDir));
    const phaseErr = Math.abs(curr.phaseOffset - interpPhase);

    if (
      ampErr >= EPSILON_AMP ||
      dirErr >= EPSILON_DIR ||
      phaseErr >= EPSILON_PHASE
    ) {
      result.push(curr); // keep — not redundant
    }
    // else: skip — vertex is redundant
  }

  result.push(wavefront[wavefront.length - 1]); // always keep last

  // Copy back
  wavefront.length = result.length;
  for (let i = 0; i < result.length; i++) {
    wavefront[i] = result[i];
  }
}

function isShadowEdge(a: MarchVertex, b: MarchVertex): boolean {
  const aActive = a.state === VertexState.ACTIVE && a.amplitude > 0.01;
  const bActive = b.state === VertexState.ACTIVE && b.amplitude > 0.01;
  return aActive !== bActive;
}

// =============================================================================
// Utility
// =============================================================================

/** Normalize angle difference to [-PI, PI] */
function angleDiff(a: number, b: number): number {
  let d = a - b;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}
