/**
 * Query worker entry point.
 *
 * Each worker instance owns:
 * - An index (0..workerCount-1) used to partition the per-frame work
 *   evenly across workers (round-robin-ish slicing).
 * - Read access to three pairs of SABs (points + results), one pair per
 *   query type.
 * - Read/write access to a shared control SAB driven by atomics.
 *
 * The main loop is a simple wait-dispatch-decrement cycle:
 *   1. `Atomics.wait` on the generation counter until the main thread
 *      bumps it to signal a new frame of work.
 *   2. Read the frame's descriptors (which query types have points, how
 *      many, and what stride).
 *   3. For each descriptor, compute this worker's slice of the points
 *      array and dispatch to the per-type handler.
 *   4. Atomically decrement `remaining`; when the last worker finishes
 *      the frame is complete.
 *
 * Handlers for each query type currently write zeros. They will be
 * replaced with real math (CPU port of the WGSL shaders, or a WASM call)
 * in a follow-up.
 */

import {
  CTRL_DESCRIPTORS_BASE,
  CTRL_DESCRIPTOR_POINT_COUNT,
  CTRL_DESCRIPTOR_STRIDE,
  CTRL_DESCRIPTOR_STRIDE_FIELD,
  CTRL_DESCRIPTOR_TYPE_ID,
  CTRL_GENERATION,
  CTRL_NUM_TYPES,
  CTRL_REMAINING,
  QUERY_TYPE_TERRAIN,
  QUERY_TYPE_WATER,
  QUERY_TYPE_WIND,
  STRIDE_PER_POINT,
  type QueryTypeId,
  type QueryWorkerMessage,
} from "./query-worker-protocol";
import { writeTerrainResult } from "./terrain-math";
import {
  TERRAIN_PARAM_CONTOUR_COUNT,
  TERRAIN_PARAM_DEFAULT_DEPTH,
} from "./terrain-params";
import { writeWaterResult } from "./water-math";
import {
  WATER_PARAM_CONTOUR_COUNT,
  WATER_PARAM_DEFAULT_DEPTH,
  WATER_PARAM_MODIFIER_COUNT,
  WATER_PARAM_NUM_WAVES,
  WATER_PARAM_TIDAL_PHASE,
  WATER_PARAM_TIDAL_STRENGTH,
  WATER_PARAM_TIDE_HEIGHT,
  WATER_PARAM_TIME,
  WATER_PARAM_WAVE_SOURCES_BASE,
} from "./water-params";
import { writeWindResult } from "./wind-math";
import { lookupWindMeshBlended } from "./wind-mesh-math";
import {
  WIND_PARAM_BASE_X,
  WIND_PARAM_BASE_Y,
  WIND_PARAM_INFLUENCE_DIRECTION_OFFSET,
  WIND_PARAM_INFLUENCE_SPEED_FACTOR,
  WIND_PARAM_INFLUENCE_TURBULENCE,
  WIND_PARAM_TIME,
  WIND_PARAM_WEIGHTS_BASE,
  WIND_PARAM_WEIGHTS_COUNT,
} from "./wind-params";

interface ChannelView {
  points: Float32Array;
  results: Float32Array;
  params: Float32Array;
  frameState: Float32Array | null;
  worldState: readonly Uint32Array[];
  resultStride: number;
}

let workerIndex = 0;
let workerCount = 1;
let control: Int32Array | null = null;
let channels: ChannelView[] = [];
let running = false;

self.onmessage = (event: MessageEvent<QueryWorkerMessage>) => {
  const msg = event.data;
  if (msg.type === "init") {
    workerIndex = msg.workerIndex;
    workerCount = msg.workerCount;
    control = new Int32Array(msg.controlSab);
    channels = msg.channels.map((c) => ({
      points: new Float32Array(c.pointsSab),
      results: new Float32Array(c.resultsSab),
      params: new Float32Array(c.paramsSab),
      frameState: c.frameStateSab ? new Float32Array(c.frameStateSab) : null,
      worldState: c.worldState,
      resultStride: c.resultStride,
    }));
    running = true;
    runMainLoop();
  } else if (msg.type === "destroy") {
    running = false;
  }
};

function runMainLoop(): void {
  if (!control) return;
  let lastGeneration = Atomics.load(control, CTRL_GENERATION);

  while (running) {
    // Park until main thread bumps the generation counter.
    const waitResult = Atomics.wait(
      control,
      CTRL_GENERATION,
      lastGeneration,
      /* timeout */ 1000,
    );
    if (!running) return;
    if (waitResult === "timed-out") continue;

    const generation = Atomics.load(control, CTRL_GENERATION);
    if (generation === lastGeneration) continue;
    lastGeneration = generation;

    processFrame();

    // Signal completion. If we're the last worker, the main thread will
    // observe remaining === 0 on its next tick.
    Atomics.sub(control, CTRL_REMAINING, 1);
  }
}

function processFrame(): void {
  if (!control) return;
  const numTypes = Atomics.load(control, CTRL_NUM_TYPES);
  for (let i = 0; i < numTypes; i++) {
    const base = CTRL_DESCRIPTORS_BASE + i * CTRL_DESCRIPTOR_STRIDE;
    const typeId = control[base + CTRL_DESCRIPTOR_TYPE_ID] as QueryTypeId;
    const pointCount = control[base + CTRL_DESCRIPTOR_POINT_COUNT];
    const resultStride = control[base + CTRL_DESCRIPTOR_STRIDE_FIELD];
    if (pointCount === 0) continue;

    const [startPoint, endPoint] = sliceForWorker(pointCount);
    if (startPoint >= endPoint) continue;

    dispatchQuery(typeId, channels, resultStride, startPoint, endPoint);
  }
}

/**
 * Partition [0, total) into `workerCount` near-equal contiguous slices
 * and return this worker's `[start, end)`. The residual (if any) is
 * distributed to low-index workers one each.
 */
function sliceForWorker(total: number): [number, number] {
  const base = Math.floor(total / workerCount);
  const residual = total - base * workerCount;
  const start = base * workerIndex + Math.min(workerIndex, residual);
  const mine = base + (workerIndex < residual ? 1 : 0);
  return [start, start + mine];
}

function dispatchQuery(
  typeId: QueryTypeId,
  channels: ChannelView[],
  resultStride: number,
  startPoint: number,
  endPoint: number,
): void {
  const channel = channels[typeId];
  switch (typeId) {
    case QUERY_TYPE_TERRAIN:
      runTerrainQuery(
        channel.points,
        channel.results,
        channel.params,
        channel.worldState[0] ?? null,
        resultStride,
        startPoint,
        endPoint,
      );
      break;
    case QUERY_TYPE_WATER:
      runWaterQuery(channel, channels, resultStride, startPoint, endPoint);
      break;
    case QUERY_TYPE_WIND:
      runWindQuery(
        channel.points,
        channel.results,
        channel.params,
        channel.worldState[0] ?? null,
        resultStride,
        startPoint,
        endPoint,
      );
      break;
  }
}

function zeroResultSlice(
  results: Float32Array,
  resultStride: number,
  startPoint: number,
  endPoint: number,
): void {
  const floatStart = startPoint * resultStride;
  const floatEnd = endPoint * resultStride;
  for (let i = floatStart; i < floatEnd; i++) {
    results[i] = 0;
  }
}

const _emptyModifiers = new Float32Array(0);
const _emptyWaveMesh = new Uint32Array(0);
const _emptyTerrain = new Uint32Array(0);
const _emptyTideMesh = new Uint32Array(0);

function runWaterQuery(
  channel: ChannelView,
  channels: ChannelView[],
  resultStride: number,
  startPoint: number,
  endPoint: number,
): void {
  const params = channel.params;
  const time = params[WATER_PARAM_TIME];
  const tideHeight = params[WATER_PARAM_TIDE_HEIGHT];
  const defaultDepth = params[WATER_PARAM_DEFAULT_DEPTH];
  const numWaves = params[WATER_PARAM_NUM_WAVES];
  const tidalPhase = params[WATER_PARAM_TIDAL_PHASE];
  const tidalStrength = params[WATER_PARAM_TIDAL_STRENGTH];
  const modifierCount = params[WATER_PARAM_MODIFIER_COUNT] | 0;

  // Wave sources are laid out inline in the params SAB from
  // WATER_PARAM_WAVE_SOURCES_BASE onward, 8 floats per wave source.
  const waveSources = params.subarray(WATER_PARAM_WAVE_SOURCES_BASE);

  const modifiers = channel.frameState ?? _emptyModifiers;
  // Water channel worldState order: [packedWaveMesh, packedTideMesh].
  const packedWaveMesh = channel.worldState[0] ?? _emptyWaveMesh;
  const packedTideMesh = channel.worldState[1] ?? _emptyTideMesh;
  const packedTerrain =
    channels[QUERY_TYPE_TERRAIN].worldState[0] ?? _emptyTerrain;

  const points = channel.points;
  const results = channel.results;
  for (let i = startPoint; i < endPoint; i++) {
    const worldX = points[i * STRIDE_PER_POINT];
    const worldY = points[i * STRIDE_PER_POINT + 1];
    writeWaterResult(
      worldX,
      worldY,
      time,
      tideHeight,
      defaultDepth,
      numWaves,
      tidalPhase,
      tidalStrength,
      packedTerrain,
      packedWaveMesh,
      packedTideMesh,
      modifiers,
      modifierCount,
      waveSources,
      results,
      i * resultStride,
    );
  }
}

function runTerrainQuery(
  points: Float32Array,
  results: Float32Array,
  params: Float32Array,
  worldState: Uint32Array | null,
  resultStride: number,
  startPoint: number,
  endPoint: number,
): void {
  if (!worldState) {
    zeroResultSlice(results, resultStride, startPoint, endPoint);
    return;
  }
  const contourCount = params[TERRAIN_PARAM_CONTOUR_COUNT];
  const defaultDepth = params[TERRAIN_PARAM_DEFAULT_DEPTH];

  for (let i = startPoint; i < endPoint; i++) {
    const worldX = points[i * STRIDE_PER_POINT];
    const worldY = points[i * STRIDE_PER_POINT + 1];
    writeTerrainResult(
      worldX,
      worldY,
      worldState,
      contourCount,
      defaultDepth,
      results,
      i * resultStride,
    );
  }
}

// Reusable scratch for mesh lookup output: [speedFactor, dirOffset, turb, found]
const _windMeshOut = new Float64Array(4);
const _windWeights = new Float32Array(WIND_PARAM_WEIGHTS_COUNT);

function runWindQuery(
  points: Float32Array,
  results: Float32Array,
  params: Float32Array,
  worldState: Uint32Array | null,
  resultStride: number,
  startPoint: number,
  endPoint: number,
): void {
  const time = params[WIND_PARAM_TIME];
  const baseX = params[WIND_PARAM_BASE_X];
  const baseY = params[WIND_PARAM_BASE_Y];
  const fallbackSpeed = params[WIND_PARAM_INFLUENCE_SPEED_FACTOR];
  const fallbackDir = params[WIND_PARAM_INFLUENCE_DIRECTION_OFFSET];
  const fallbackTurb = params[WIND_PARAM_INFLUENCE_TURBULENCE];

  // Copy weights into a stable typed array the mesh lookup can read.
  for (let i = 0; i < WIND_PARAM_WEIGHTS_COUNT; i++) {
    _windWeights[i] = params[WIND_PARAM_WEIGHTS_BASE + i];
  }

  for (let i = startPoint; i < endPoint; i++) {
    const worldX = points[i * STRIDE_PER_POINT];
    const worldY = points[i * STRIDE_PER_POINT + 1];

    let speedFactor = fallbackSpeed;
    let dirOffset = fallbackDir;
    let turb = fallbackTurb;

    if (worldState) {
      lookupWindMeshBlended(
        worldX,
        worldY,
        worldState,
        _windWeights,
        _windMeshOut,
      );
      if (_windMeshOut[3] > 0) {
        speedFactor = _windMeshOut[0];
        dirOffset = _windMeshOut[1];
        turb = _windMeshOut[2];
      }
    }

    writeWindResult(
      worldX,
      worldY,
      time,
      baseX,
      baseY,
      speedFactor,
      dirOffset,
      turb,
      results,
      i * resultStride,
    );
  }
}
