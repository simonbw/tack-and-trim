/**
 * Wavefront Mesh Builder
 *
 * Orchestrates GPU compute to construct a wavefront mesh for a single wave source.
 * The mesh represents how a wavefront propagates across the terrain, bending
 * due to refraction and losing/gaining amplitude due to shoaling, damping,
 * and convergence/divergence.
 *
 * Build process:
 * A. Compute grid dimensions from coastline bounds
 * B. Create GPU buffers (mesh vertices, ping-pong state, uniforms)
 * C. Initialize first wavefront row on CPU
 * D. Create and init compute shader
 * E. Dispatch loop: march one step per dispatch
 * F. Generate index buffer for triangle mesh
 * G. Readback CPU data for debug visualization
 * H. Clean up temporary buffers
 */

import { getWebGPU } from "../../core/graphics/webgpu/WebGPUDevice";
import type { WaveSource } from "../world/water/WaveSource";
import type { AABB } from "./CoastlineManager";
import { WavefrontMesh, VERTEX_FLOATS } from "./WavefrontMesh";
import {
  createWavefrontMarchShader,
  MarchParams,
} from "./WavefrontMarchShader";

/** Number of floats per march state entry (dirX, dirY, terminated, accPhase, pad) */
const STATE_FLOATS = 5;

/** Minimum number of vertices per wavefront row */
const MIN_VERTEX_COUNT = 8;

/** Minimum number of marching steps */
const MIN_STEPS = 4;

export class WavefrontMeshBuilder {
  /**
   * Build a wavefront mesh for a single wave source.
   *
   * @param waveSource - Wave source configuration
   * @param packedTerrainBuffer - GPU buffer with packed terrain data
   * @param contourCount - Number of terrain contours
   * @param defaultDepth - Default terrain depth (ocean floor)
   * @param tideHeight - Current tide height
   * @param coastlineBounds - AABB of all coastlines (null if no coastlines)
   */
  async build(
    waveSource: WaveSource,
    packedTerrainBuffer: GPUBuffer,
    contourCount: number,
    defaultDepth: number,
    tideHeight: number,
    coastlineBounds: AABB | null,
  ): Promise<WavefrontMesh> {
    const device = getWebGPU().device;
    const startTime = performance.now();

    // Step A: Compute grid dimensions
    const waveDirX = Math.cos(waveSource.direction);
    const waveDirY = Math.sin(waveSource.direction);
    const perpDirX = -waveDirY;
    const perpDirY = waveDirX;
    const wavelength = waveSource.wavelength;
    const vertexSpacing = wavelength / 4;
    const baseStepSize = wavelength / 4;

    // Compute deep water speed for adaptive stepping
    const g = 32.174; // ft/s^2
    const deepSpeed = Math.sqrt((g * wavelength) / (2 * Math.PI));

    // Compute wave number
    const k = (2 * Math.PI) / wavelength;

    // Determine mesh extent from coastline bounds (or use a default area)
    let meshMinX: number, meshMaxX: number, meshMinY: number, meshMaxY: number;
    if (coastlineBounds) {
      const margin = wavelength * 3;
      meshMinX = coastlineBounds.minX - margin;
      meshMaxX = coastlineBounds.maxX + margin;
      meshMinY = coastlineBounds.minY - margin;
      meshMaxY = coastlineBounds.maxY + margin;
    } else {
      // No coastlines: create a small default mesh
      meshMinX = -500;
      meshMaxX = 500;
      meshMinY = -500;
      meshMaxY = 500;
    }

    // Project AABB corners onto wave direction and perpendicular
    const corners = [
      [meshMinX, meshMinY],
      [meshMaxX, meshMinY],
      [meshMinX, meshMaxY],
      [meshMaxX, meshMaxY],
    ];

    let minAlong = Infinity,
      maxAlong = -Infinity;
    let minPerp = Infinity,
      maxPerp = -Infinity;
    for (const [cx, cy] of corners) {
      const along = cx * waveDirX + cy * waveDirY;
      const perp = cx * perpDirX + cy * perpDirY;
      minAlong = Math.min(minAlong, along);
      maxAlong = Math.max(maxAlong, along);
      minPerp = Math.min(minPerp, perp);
      maxPerp = Math.max(maxPerp, perp);
    }

    const alongExtent = maxAlong - minAlong;
    const perpExtent = maxPerp - minPerp;

    const vertexCount = Math.max(
      MIN_VERTEX_COUNT,
      Math.ceil(perpExtent / vertexSpacing) + 1,
    );
    const numSteps = Math.max(
      MIN_STEPS,
      Math.ceil(alongExtent / baseStepSize) + 1,
    );

    // Mesh origin: upwind edge, centered perpendicular
    const meshOriginX =
      minAlong * waveDirX + ((minPerp + maxPerp) / 2) * perpDirX;
    const meshOriginY =
      minAlong * waveDirY + ((minPerp + maxPerp) / 2) * perpDirY;

    console.log(
      `[WavefrontMeshBuilder] Grid: ${vertexCount} vertices x ${numSteps} steps ` +
        `(${(vertexCount * numSteps).toLocaleString()} total), ` +
        `wavelength=${wavelength}ft, spacing=${vertexSpacing.toFixed(1)}ft`,
    );

    // Step B: Create GPU buffers
    const totalVertices = vertexCount * numSteps;
    const meshVerticesSize = VERTEX_FLOATS * totalVertices * 4;
    const stateSize = STATE_FLOATS * vertexCount * 4;

    const meshVerticesBuffer = device.createBuffer({
      size: meshVerticesSize,
      usage:
        GPUBufferUsage.STORAGE |
        GPUBufferUsage.VERTEX |
        GPUBufferUsage.COPY_SRC |
        GPUBufferUsage.COPY_DST,
      label: "Wavefront Mesh Vertices",
    });

    const stateABuffer = device.createBuffer({
      size: stateSize,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      label: "Wavefront March State A",
    });

    const stateBBuffer = device.createBuffer({
      size: stateSize,
      usage: GPUBufferUsage.STORAGE,
      label: "Wavefront March State B",
    });

    const uniformBuffer = device.createBuffer({
      size: MarchParams.byteSize,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      label: "Wavefront March Params",
    });

    // Step C: Initialize first wavefront row
    const firstRow = new Float32Array(VERTEX_FLOATS * vertexCount);
    const firstState = new Float32Array(STATE_FLOATS * vertexCount);
    const perpStart = minPerp;

    for (let i = 0; i < vertexCount; i++) {
      const perpOffset = perpStart + i * vertexSpacing;
      const posX = minAlong * waveDirX + perpOffset * perpDirX;
      const posY = minAlong * waveDirY + perpOffset * perpDirY;

      // Vertex: posX, posY, amplitude=1, dirOffset=0, phaseOffset=0
      firstRow[i * VERTEX_FLOATS + 0] = posX;
      firstRow[i * VERTEX_FLOATS + 1] = posY;
      firstRow[i * VERTEX_FLOATS + 2] = 1.0;
      firstRow[i * VERTEX_FLOATS + 3] = 0.0;
      firstRow[i * VERTEX_FLOATS + 4] = 0.0;

      // State: dirX, dirY, terminated=0, accPhase=0, pad=0
      firstState[i * STATE_FLOATS + 0] = waveDirX;
      firstState[i * STATE_FLOATS + 1] = waveDirY;
      firstState[i * STATE_FLOATS + 2] = 0.0;
      firstState[i * STATE_FLOATS + 3] = 0.0;
      firstState[i * STATE_FLOATS + 4] = 0.0;
    }

    device.queue.writeBuffer(meshVerticesBuffer, 0, firstRow);
    device.queue.writeBuffer(stateABuffer, 0, firstState);

    // Step D: Create and init compute shader
    const marchShader = createWavefrontMarchShader();
    await marchShader.init();

    // Step E: Dispatch loop - one step per dispatch
    const uniforms = MarchParams.create();

    for (let step = 1; step < numSteps; step++) {
      const prevStepOffset = (step - 1) * vertexCount * VERTEX_FLOATS;
      const outStepOffset = step * vertexCount * VERTEX_FLOATS;
      const pingPong = (step - 1) % 2;

      uniforms.set.prevStepOffset(prevStepOffset);
      uniforms.set.outStepOffset(outStepOffset);
      uniforms.set.vertexCount(vertexCount);
      uniforms.set.stepIndex(step);
      uniforms.set.baseStepSize(baseStepSize);
      uniforms.set.wavelength(wavelength);
      uniforms.set.tideHeight(tideHeight);
      uniforms.set.k(k);
      uniforms.set.initialSpacing(vertexSpacing);
      uniforms.set.deepSpeed(deepSpeed);
      uniforms.set.baseWaveDirX(waveDirX);
      uniforms.set.baseWaveDirY(waveDirY);
      uniforms.set.contourCount(contourCount);
      uniforms.set.defaultDepth(defaultDepth);
      uniforms.set.pingPong(pingPong);
      uniforms.uploadTo(uniformBuffer);

      const bindGroup = marchShader.createBindGroup({
        params: { buffer: uniformBuffer },
        meshVertices: { buffer: meshVerticesBuffer },
        stateA: { buffer: stateABuffer },
        stateB: { buffer: stateBBuffer },
        packedTerrain: { buffer: packedTerrainBuffer },
      });

      const commandEncoder = device.createCommandEncoder({
        label: `Wavefront March Step ${step}`,
      });

      const computePass = commandEncoder.beginComputePass({
        label: `Wavefront March Step ${step}`,
      });

      marchShader.dispatch(computePass, bindGroup, vertexCount, 1);
      computePass.end();

      device.queue.submit([commandEncoder.finish()]);
    }

    // Step F: Generate index buffer
    const quadsPerRow = vertexCount - 1;
    const rowPairs = numSteps - 1;
    const indexCount = rowPairs * quadsPerRow * 6; // 2 triangles per quad, 3 indices each
    const indices = new Uint32Array(indexCount);
    let idx = 0;

    for (let row = 0; row < rowPairs; row++) {
      const rowBase = row * vertexCount;
      const nextRowBase = (row + 1) * vertexCount;

      for (let col = 0; col < quadsPerRow; col++) {
        const tl = rowBase + col;
        const tr = rowBase + col + 1;
        const bl = nextRowBase + col;
        const br = nextRowBase + col + 1;

        // Triangle 1: tl, bl, tr
        indices[idx++] = tl;
        indices[idx++] = bl;
        indices[idx++] = tr;

        // Triangle 2: tr, bl, br
        indices[idx++] = tr;
        indices[idx++] = bl;
        indices[idx++] = br;
      }
    }

    const indexBuffer = device.createBuffer({
      size: indices.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
      label: "Wavefront Mesh Index Buffer",
    });
    device.queue.writeBuffer(indexBuffer, 0, indices);

    // Step G: Readback CPU data
    const stagingBuffer = device.createBuffer({
      size: meshVerticesSize,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
      label: "Wavefront Mesh Readback",
    });

    const copyEncoder = device.createCommandEncoder({
      label: "Wavefront Mesh Copy",
    });
    copyEncoder.copyBufferToBuffer(
      meshVerticesBuffer,
      0,
      stagingBuffer,
      0,
      meshVerticesSize,
    );
    device.queue.submit([copyEncoder.finish()]);

    await stagingBuffer.mapAsync(GPUMapMode.READ);
    const cpuVertexData = new Float32Array(
      stagingBuffer.getMappedRange().slice(0),
    );
    stagingBuffer.unmap();
    stagingBuffer.destroy();

    // Step H: Clean up temporary buffers
    stateABuffer.destroy();
    stateBBuffer.destroy();
    uniformBuffer.destroy();
    marchShader.destroy();

    await device.queue.onSubmittedWorkDone();

    const elapsed = performance.now() - startTime;
    console.log(`[WavefrontMeshBuilder] Built mesh in ${elapsed.toFixed(0)}ms`);

    return new WavefrontMesh({
      vertexBuffer: meshVerticesBuffer,
      indexBuffer,
      cpuVertexData,
      numSteps,
      vertexCount,
      meshOriginX,
      meshOriginY,
      waveDirX,
      waveDirY,
      perpDirX,
      perpDirY,
      avgStepDistance: baseStepSize,
      vertexSpacing,
      wavelength,
    });
  }
}
