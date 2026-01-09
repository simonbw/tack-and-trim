import DynamicBody from "../body/DynamicBody";
import type Equation from "../equations/Equation";
import FrictionEquation from "../equations/FrictionEquation";
import {
  SOLVER_ADD_VELOCITY,
  SOLVER_INV_INERTIA,
  SOLVER_INV_MASS,
  SOLVER_RESET_VELOCITY,
  SOLVER_UPDATE_MASS,
  SOLVER_VLAMBDA,
  SOLVER_WLAMBDA,
} from "../internal";
import type { Island } from "../world/Island";
import {
  DEFAULT_SOLVER_CONFIG,
  type Solver,
  type SolverConfig,
  type SolverResult,
} from "./Solver";

/**
 * Maximum equations supported (can be increased, affects buffer size).
 */
const MAX_EQUATIONS = 1024;

/**
 * Maximum bodies supported.
 */
const MAX_BODIES = 512;

/**
 * Workgroup size for compute shaders.
 */
const WORKGROUP_SIZE = 64;

/**
 * WGSL compute shader for Jacobi constraint solving.
 *
 * This shader uses a two-pass approach:
 * 1. Equation pass: Compute delta_lambda for each equation
 * 2. Body pass: Each body gathers velocity contributions from equations
 *
 * This avoids the need for f32 atomics (which WebGPU doesn't have in core).
 */
const JACOBI_SHADER = /*wgsl*/ `
struct SolverParams {
  numEquations: u32,
  numBodies: u32,
  omega: f32,
  dt: f32,
}

struct BodyData {
  invMass: f32,
  invInertia: f32,
  _pad0: f32,
  _pad1: f32,
}

struct EquationData {
  // Jacobian: G[0..5] for bodyA (0,1,2) and bodyB (3,4,5)
  G0: f32, G1: f32, G2: f32, G3: f32, G4: f32, G5: f32,
  // Precomputed values
  B: f32,
  invC: f32,
  epsilon: f32,
  minForceDt: f32,
  maxForceDt: f32,
  lambda: f32,
  // Body indices
  bodyAIdx: u32,
  bodyBIdx: u32,
  _pad0: u32,
  _pad1: u32,
}

struct VelocityDelta {
  // Velocity contribution for bodyA
  dvxA: f32, dvyA: f32, dwA: f32,
  // Velocity contribution for bodyB
  dvxB: f32, dvyB: f32, dwB: f32,
  // Delta lambda (for updating equation state)
  deltaLambda: f32,
  _pad: f32,
}

@group(0) @binding(0) var<uniform> params: SolverParams;
@group(0) @binding(1) var<storage, read> bodies: array<BodyData>;
@group(0) @binding(2) var<storage, read_write> equations: array<EquationData>;
@group(0) @binding(3) var<storage, read> vlambdaIn: array<vec4<f32>>;
@group(0) @binding(4) var<storage, read_write> vlambdaOut: array<vec4<f32>>;
@group(0) @binding(5) var<storage, read_write> eqDeltas: array<VelocityDelta>;

// ============================================================================
// Pass 1: Compute delta_lambda for each equation
// ============================================================================
@compute @workgroup_size(${WORKGROUP_SIZE})
fn computeDeltas(@builtin(global_invocation_id) gid: vec3<u32>) {
  let eqIdx = gid.x;
  if (eqIdx >= params.numEquations) {
    return;
  }

  var eq = equations[eqIdx];

  // Read old velocities for both bodies
  let velA = vlambdaIn[eq.bodyAIdx];
  let velB = vlambdaIn[eq.bodyBIdx];

  // Compute G · vlambda (constraint velocity)
  let GWlambda = eq.G0 * velA.x + eq.G1 * velA.y + eq.G2 * velA.z
               + eq.G3 * velB.x + eq.G4 * velB.y + eq.G5 * velB.z;

  // Compute delta lambda
  var deltalambda = eq.invC * (eq.B - GWlambda - eq.epsilon * eq.lambda);
  deltalambda *= params.omega;  // SOR relaxation

  // Clamp to force bounds
  let newLambda = eq.lambda + deltalambda;
  if (newLambda < eq.minForceDt) {
    deltalambda = eq.minForceDt - eq.lambda;
  } else if (newLambda > eq.maxForceDt) {
    deltalambda = eq.maxForceDt - eq.lambda;
  }

  // Update lambda in equation (for next iteration)
  equations[eqIdx].lambda = eq.lambda + deltalambda;

  // Get body mass properties
  let bodyA = bodies[eq.bodyAIdx];
  let bodyB = bodies[eq.bodyBIdx];

  // Compute velocity contributions: v_delta = inv(M) * G * delta_lambda
  var delta: VelocityDelta;
  delta.dvxA = bodyA.invMass * eq.G0 * deltalambda;
  delta.dvyA = bodyA.invMass * eq.G1 * deltalambda;
  delta.dwA = bodyA.invInertia * eq.G2 * deltalambda;
  delta.dvxB = bodyB.invMass * eq.G3 * deltalambda;
  delta.dvyB = bodyB.invMass * eq.G4 * deltalambda;
  delta.dwB = bodyB.invInertia * eq.G5 * deltalambda;
  delta.deltaLambda = deltalambda;

  eqDeltas[eqIdx] = delta;
}

// ============================================================================
// Pass 2: Each body gathers velocity contributions from all equations
// ============================================================================
@compute @workgroup_size(${WORKGROUP_SIZE})
fn gatherVelocities(@builtin(global_invocation_id) gid: vec3<u32>) {
  let bodyIdx = gid.x;
  if (bodyIdx >= params.numBodies) {
    return;
  }

  // Accumulate velocity deltas from all equations involving this body
  var vx: f32 = 0.0;
  var vy: f32 = 0.0;
  var w: f32 = 0.0;

  for (var eqIdx: u32 = 0u; eqIdx < params.numEquations; eqIdx++) {
    let eq = equations[eqIdx];
    let delta = eqDeltas[eqIdx];

    if (eq.bodyAIdx == bodyIdx) {
      vx += delta.dvxA;
      vy += delta.dvyA;
      w += delta.dwA;
    }
    if (eq.bodyBIdx == bodyIdx) {
      vx += delta.dvxB;
      vy += delta.dvyB;
      w += delta.dwB;
    }
  }

  vlambdaOut[bodyIdx] = vec4<f32>(vx, vy, w, 0.0);
}
`;

/**
 * WebGPU-accelerated Jacobi constraint solver.
 *
 * Uses compute shaders for parallel constraint solving:
 * - Pass 1: Each equation computes its delta_lambda (parallel over equations)
 * - Pass 2: Each body gathers velocity contributions (parallel over bodies)
 *
 * Advantages over WebGL2 approach:
 * - Real compute shaders (no render-to-texture hacks)
 * - Storage buffers (no texture packing)
 * - Cleaner code and better performance
 * - Proper workgroup parallelism
 */
export default class WebGPUJacobiSolver implements Solver {
  readonly config: SolverConfig;
  private omega: number;

  // WebGPU resources
  private device: GPUDevice;
  private computeDeltasPipeline: GPUComputePipeline;
  private gatherVelocitiesPipeline: GPUComputePipeline;

  // Buffers
  private paramsBuffer: GPUBuffer;
  private bodiesBuffer: GPUBuffer;
  private equationsBuffer: GPUBuffer;
  private vlambdaBuffers: [GPUBuffer, GPUBuffer]; // Ping-pong
  private eqDeltasBuffer: GPUBuffer;
  private readbackBuffer: GPUBuffer;

  // Bind groups (recreated when buffer sizes change)
  private bindGroup: GPUBindGroup | null = null;
  private bindGroupLayout: GPUBindGroupLayout;

  // CPU-side staging buffers
  private bodiesData: Float32Array;
  private equationsData: Float32Array;
  private vlambdaData: Float32Array;

  // Track current ping-pong index
  private currentVlambdaIndex: number = 0;

  // Initialization promise
  private ready: Promise<void>;
  private isReady: boolean = false;

  constructor(config: Partial<SolverConfig> = {}, omega: number = 0.7) {
    this.config = {
      ...DEFAULT_SOLVER_CONFIG,
      iterations: 20, // Jacobi needs more iterations
      ...config,
    };
    this.omega = omega;

    // Allocate CPU staging buffers
    this.bodiesData = new Float32Array(MAX_BODIES * 4);
    this.equationsData = new Float32Array(MAX_EQUATIONS * 16);
    this.vlambdaData = new Float32Array(MAX_BODIES * 4);

    // Initialize WebGPU asynchronously
    this.ready = this.initWebGPU();
  }

  private async initWebGPU(): Promise<void> {
    // Request adapter and device
    const adapter = await navigator.gpu?.requestAdapter();
    if (!adapter) {
      throw new Error("WebGPU not supported: no adapter found");
    }

    this.device = await adapter.requestDevice();

    // Create shader module
    const shaderModule = this.device.createShaderModule({
      code: JACOBI_SHADER,
    });

    // Create bind group layout
    this.bindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: "uniform" },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: "read-only-storage" },
        },
        {
          binding: 2,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: "storage" },
        },
        {
          binding: 3,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: "read-only-storage" },
        },
        {
          binding: 4,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: "storage" },
        },
        {
          binding: 5,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: "storage" },
        },
      ],
    });

    const pipelineLayout = this.device.createPipelineLayout({
      bindGroupLayouts: [this.bindGroupLayout],
    });

    // Create compute pipelines
    this.computeDeltasPipeline = this.device.createComputePipeline({
      layout: pipelineLayout,
      compute: {
        module: shaderModule,
        entryPoint: "computeDeltas",
      },
    });

    this.gatherVelocitiesPipeline = this.device.createComputePipeline({
      layout: pipelineLayout,
      compute: {
        module: shaderModule,
        entryPoint: "gatherVelocities",
      },
    });

    // Create buffers
    this.paramsBuffer = this.device.createBuffer({
      size: 16, // 4 x f32/u32
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.bodiesBuffer = this.device.createBuffer({
      size: MAX_BODIES * 16, // 4 x f32 per body
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    this.equationsBuffer = this.device.createBuffer({
      size: MAX_EQUATIONS * 64, // 16 x f32 per equation
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    this.vlambdaBuffers = [
      this.device.createBuffer({
        size: MAX_BODIES * 16, // vec4 per body
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      }),
      this.device.createBuffer({
        size: MAX_BODIES * 16,
        usage:
          GPUBufferUsage.STORAGE |
          GPUBufferUsage.COPY_DST |
          GPUBufferUsage.COPY_SRC,
      }),
    ];

    this.eqDeltasBuffer = this.device.createBuffer({
      size: MAX_EQUATIONS * 32, // 8 x f32 per equation
      usage: GPUBufferUsage.STORAGE,
    });

    this.readbackBuffer = this.device.createBuffer({
      size: MAX_BODIES * 16,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });

    this.isReady = true;
  }

  async solveEquations(
    equations: readonly Equation[],
    dynamicBodies: Iterable<DynamicBody>,
    h: number
  ): Promise<SolverResult> {
    // Wait for WebGPU initialization
    if (!this.isReady) {
      await this.ready;
    }

    // Filter disabled equations
    equations = equations.filter((eq) => eq.enabled);
    const bodiesArray = Array.from(dynamicBodies);

    const Neq = equations.length;
    const Nbodies = bodiesArray.length;

    if (Neq === 0 || Nbodies === 0) {
      return { usedIterations: 0 };
    }

    // Fall back to CPU if too many equations/bodies
    if (Neq > MAX_EQUATIONS || Nbodies > MAX_BODIES) {
      console.warn(
        `WebGPUJacobiSolver: Too many equations (${Neq}) or bodies (${Nbodies}), falling back to CPU`
      );
      return this.solveCPU(equations, bodiesArray, h);
    }

    return this.solveGPU(equations, bodiesArray, h);
  }

  private async solveGPU(
    equations: readonly Equation[],
    bodies: DynamicBody[],
    h: number
  ): Promise<SolverResult> {
    const { iterations } = this.config;
    const Neq = equations.length;
    const Nbodies = bodies.length;

    // Update mass properties
    for (const body of bodies) {
      body[SOLVER_UPDATE_MASS]();
    }

    // Build body index map
    const bodyIndexMap = new Map<DynamicBody, number>();
    for (let i = 0; i < Nbodies; i++) {
      bodyIndexMap.set(bodies[i], i);
    }

    // Pack body data
    for (let i = 0; i < Nbodies; i++) {
      const body = bodies[i];
      const base = i * 4;
      this.bodiesData[base + 0] = body[SOLVER_INV_MASS];
      this.bodiesData[base + 1] = body[SOLVER_INV_INERTIA];
      this.bodiesData[base + 2] = 0;
      this.bodiesData[base + 3] = 0;
    }

    // Pack equation data
    for (let i = 0; i < Neq; i++) {
      const eq = equations[i];
      if (eq.timeStep !== h || eq.needsUpdate) {
        eq.timeStep = h;
        eq.update();
      }

      const G = eq.G;
      const B = eq.computeB(eq.a, eq.b, h);
      const invC = eq.computeInvC(eq.epsilon);
      const bodyAIdx = bodyIndexMap.get(eq.bodyA as DynamicBody) ?? 0;
      const bodyBIdx = bodyIndexMap.get(eq.bodyB as DynamicBody) ?? 0;

      const base = i * 16;
      // G[0..5]
      this.equationsData[base + 0] = G[0];
      this.equationsData[base + 1] = G[1];
      this.equationsData[base + 2] = G[2];
      this.equationsData[base + 3] = G[3];
      this.equationsData[base + 4] = G[4];
      this.equationsData[base + 5] = G[5];
      // B, invC, epsilon
      this.equationsData[base + 6] = B;
      this.equationsData[base + 7] = invC;
      this.equationsData[base + 8] = eq.epsilon;
      // Force bounds
      this.equationsData[base + 9] = eq.minForce * h;
      this.equationsData[base + 10] = eq.maxForce * h;
      // Lambda (starts at 0)
      this.equationsData[base + 11] = 0;
      // Body indices (as float, will be cast in shader)
      this.equationsData[base + 12] = bodyAIdx;
      this.equationsData[base + 13] = bodyBIdx;
      this.equationsData[base + 14] = 0;
      this.equationsData[base + 15] = 0;
    }

    // Upload data to GPU
    this.device.queue.writeBuffer(
      this.paramsBuffer,
      0,
      new Uint32Array([Neq, Nbodies]),
    );
    this.device.queue.writeBuffer(
      this.paramsBuffer,
      8,
      new Float32Array([this.omega, h])
    );
    this.device.queue.writeBuffer(
      this.bodiesBuffer,
      0,
      this.bodiesData.subarray(0, Nbodies * 4)
    );
    this.device.queue.writeBuffer(
      this.equationsBuffer,
      0,
      this.equationsData.subarray(0, Neq * 16)
    );

    // Clear velocity buffers
    this.vlambdaData.fill(0);
    this.device.queue.writeBuffer(
      this.vlambdaBuffers[0],
      0,
      this.vlambdaData.subarray(0, Nbodies * 4)
    );
    this.device.queue.writeBuffer(
      this.vlambdaBuffers[1],
      0,
      this.vlambdaData.subarray(0, Nbodies * 4)
    );

    // Reset body constraint velocities
    for (const body of bodies) {
      body[SOLVER_RESET_VELOCITY]();
    }

    // Calculate workgroup counts
    const eqWorkgroups = Math.ceil(Neq / WORKGROUP_SIZE);
    const bodyWorkgroups = Math.ceil(Nbodies / WORKGROUP_SIZE);

    // Run iterations
    this.currentVlambdaIndex = 0;

    for (let iter = 0; iter < iterations; iter++) {
      const readBuffer = this.vlambdaBuffers[this.currentVlambdaIndex];
      const writeBuffer = this.vlambdaBuffers[1 - this.currentVlambdaIndex];

      // Create bind group for this iteration
      const bindGroup = this.device.createBindGroup({
        layout: this.bindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: this.paramsBuffer } },
          { binding: 1, resource: { buffer: this.bodiesBuffer } },
          { binding: 2, resource: { buffer: this.equationsBuffer } },
          { binding: 3, resource: { buffer: readBuffer } },
          { binding: 4, resource: { buffer: writeBuffer } },
          { binding: 5, resource: { buffer: this.eqDeltasBuffer } },
        ],
      });

      const commandEncoder = this.device.createCommandEncoder();

      // Pass 1: Compute deltas for each equation
      const deltasPass = commandEncoder.beginComputePass();
      deltasPass.setPipeline(this.computeDeltasPipeline);
      deltasPass.setBindGroup(0, bindGroup);
      deltasPass.dispatchWorkgroups(eqWorkgroups);
      deltasPass.end();

      // Pass 2: Gather velocities for each body
      const gatherPass = commandEncoder.beginComputePass();
      gatherPass.setPipeline(this.gatherVelocitiesPipeline);
      gatherPass.setBindGroup(0, bindGroup);
      gatherPass.dispatchWorkgroups(bodyWorkgroups);
      gatherPass.end();

      this.device.queue.submit([commandEncoder.finish()]);

      // Swap buffers
      this.currentVlambdaIndex = 1 - this.currentVlambdaIndex;
    }

    // Read back final velocities
    const resultBuffer = this.vlambdaBuffers[this.currentVlambdaIndex];
    const copyEncoder = this.device.createCommandEncoder();
    copyEncoder.copyBufferToBuffer(
      resultBuffer,
      0,
      this.readbackBuffer,
      0,
      Nbodies * 16
    );
    this.device.queue.submit([copyEncoder.finish()]);

    // Map and read
    await this.readbackBuffer.mapAsync(GPUMapMode.READ);
    const readbackData = new Float32Array(
      this.readbackBuffer.getMappedRange().slice(0)
    );
    this.readbackBuffer.unmap();

    // Apply results to bodies
    for (let i = 0; i < Nbodies; i++) {
      const body = bodies[i];
      const base = i * 4;
      body[SOLVER_VLAMBDA][0] = readbackData[base];
      body[SOLVER_VLAMBDA][1] = readbackData[base + 1];
      body[SOLVER_WLAMBDA] = readbackData[base + 2];
    }

    // Apply constraint velocities
    for (const body of bodies) {
      body[SOLVER_ADD_VELOCITY]();
    }

    // Read back lambda values for multipliers
    // (Would need another readback from equations buffer for accurate values)
    // For now, approximate
    for (let i = 0; i < Neq; i++) {
      equations[i].multiplier = 0;
    }

    return { usedIterations: iterations };
  }

  /**
   * CPU fallback for when GPU can't be used.
   */
  private solveCPU(
    equations: readonly Equation[],
    bodies: DynamicBody[],
    h: number
  ): SolverResult {
    const { iterations, tolerance, useZeroRHS } = this.config;
    const Neq = equations.length;
    const Nbodies = bodies.length;

    const tolSquared = (tolerance * Neq) ** 2;
    let usedIterations = 0;

    for (const body of bodies) {
      body[SOLVER_UPDATE_MASS]();
    }

    const lambda = new Float32Array(Neq);
    const Bs = new Float32Array(Neq);
    const invCs = new Float32Array(Neq);

    for (let i = 0; i < Neq; i++) {
      const eq = equations[i];
      if (eq.timeStep !== h || eq.needsUpdate) {
        eq.timeStep = h;
        eq.update();
      }
      Bs[i] = eq.computeB(eq.a, eq.b, h);
      invCs[i] = eq.computeInvC(eq.epsilon);
    }

    const bodyIndexMap = new Map<DynamicBody, number>();
    for (let i = 0; i < Nbodies; i++) {
      bodyIndexMap.set(bodies[i], i);
    }

    for (const body of bodies) {
      body[SOLVER_RESET_VELOCITY]();
    }

    const vlambdaOld = new Float32Array(Nbodies * 3);
    const vlambdaNew = new Float32Array(Nbodies * 3);

    for (let iter = 0; iter < iterations; iter++) {
      vlambdaNew.fill(0);
      let deltalambdaTot = 0;

      for (let j = 0; j < Neq; j++) {
        const eq = equations[j];
        const G = eq.G;

        const bodyA = eq.bodyA as DynamicBody;
        const bodyB = eq.bodyB as DynamicBody;
        const idxA = bodyIndexMap.get(bodyA);
        const idxB = bodyIndexMap.get(bodyB);

        let GWlambda = 0;
        if (idxA !== undefined) {
          const baseA = idxA * 3;
          GWlambda +=
            G[0] * vlambdaOld[baseA] +
            G[1] * vlambdaOld[baseA + 1] +
            G[2] * vlambdaOld[baseA + 2];
        }
        if (idxB !== undefined) {
          const baseB = idxB * 3;
          GWlambda +=
            G[3] * vlambdaOld[baseB] +
            G[4] * vlambdaOld[baseB + 1] +
            G[5] * vlambdaOld[baseB + 2];
        }

        const B = useZeroRHS ? 0 : Bs[j];
        let deltalambda =
          invCs[j] * (B - GWlambda - eq.epsilon * lambda[j]) * this.omega;

        const lambdaj_plus = lambda[j] + deltalambda;
        if (lambdaj_plus < eq.minForce * h) {
          deltalambda = eq.minForce * h - lambda[j];
        } else if (lambdaj_plus > eq.maxForce * h) {
          deltalambda = eq.maxForce * h - lambda[j];
        }

        lambda[j] += deltalambda;
        deltalambdaTot += Math.abs(deltalambda);

        if (idxA !== undefined) {
          const invMassA = bodyA[SOLVER_INV_MASS];
          const invInertiaA = bodyA[SOLVER_INV_INERTIA];
          const baseA = idxA * 3;
          vlambdaNew[baseA] += invMassA * G[0] * deltalambda;
          vlambdaNew[baseA + 1] += invMassA * G[1] * deltalambda;
          vlambdaNew[baseA + 2] += invInertiaA * G[2] * deltalambda;
        }
        if (idxB !== undefined) {
          const invMassB = bodyB[SOLVER_INV_MASS];
          const invInertiaB = bodyB[SOLVER_INV_INERTIA];
          const baseB = idxB * 3;
          vlambdaNew[baseB] += invMassB * G[3] * deltalambda;
          vlambdaNew[baseB + 1] += invMassB * G[4] * deltalambda;
          vlambdaNew[baseB + 2] += invInertiaB * G[5] * deltalambda;
        }
      }

      vlambdaOld.set(vlambdaNew);
      usedIterations++;

      if (deltalambdaTot * deltalambdaTot <= tolSquared) {
        break;
      }
    }

    for (let i = 0; i < Nbodies; i++) {
      const body = bodies[i];
      const base = i * 3;
      body[SOLVER_VLAMBDA][0] = vlambdaNew[base];
      body[SOLVER_VLAMBDA][1] = vlambdaNew[base + 1];
      body[SOLVER_WLAMBDA] = vlambdaNew[base + 2];
    }

    for (const body of bodies) {
      body[SOLVER_ADD_VELOCITY]();
    }

    for (let i = 0; i < Neq; i++) {
      equations[i].multiplier = lambda[i] / h;
    }

    return { usedIterations };
  }

  solveIsland(island: Island, h: number): SolverResult | Promise<SolverResult> {
    const dynamicBodies: DynamicBody[] = [];
    for (const body of island.bodies) {
      if (body instanceof DynamicBody) {
        dynamicBodies.push(body);
      }
    }
    return this.solveEquations(
      island.equations as Equation[],
      dynamicBodies,
      h
    );
  }

  dispose(): void {
    if (this.isReady) {
      this.paramsBuffer?.destroy();
      this.bodiesBuffer?.destroy();
      this.equationsBuffer?.destroy();
      this.vlambdaBuffers[0]?.destroy();
      this.vlambdaBuffers[1]?.destroy();
      this.eqDeltasBuffer?.destroy();
      this.readbackBuffer?.destroy();
    }
  }
}
