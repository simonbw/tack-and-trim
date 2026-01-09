import DynamicBody from "../body/DynamicBody";
import { FullscreenShader } from "../../graphics/FullscreenShader";
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
 * Maximum number of equations supported by the GPU solver.
 * Limited by texture size and uniform array limits.
 */
const MAX_EQUATIONS = 512;

/**
 * Maximum number of bodies supported by the GPU solver.
 */
const MAX_BODIES = 256;

/**
 * Default configuration for GPU Jacobi solver.
 */
const DEFAULT_GPU_JACOBI_CONFIG: SolverConfig = {
  ...DEFAULT_SOLVER_CONFIG,
  iterations: 20,
};

/**
 * Fragment shader for Jacobi constraint solving.
 *
 * Each pixel represents one body. The shader:
 * 1. Iterates over all equations
 * 2. For equations involving this body, computes velocity contribution
 * 3. Outputs accumulated velocity delta
 *
 * This is O(bodies × equations) but fully parallel across bodies.
 */
const JACOBI_FRAGMENT_SHADER = /*glsl*/ `#version 300 es
precision highp float;

in vec2 v_position;
out vec4 fragColor;

// Body data: [invMass, invInertia, unused, unused] per body
uniform sampler2D u_bodyData;

// Equation data packed into textures
// Each equation uses 4 pixels (16 floats):
//   Pixel 0: G[0..3] (first 4 Jacobian components)
//   Pixel 1: G[4..5], B, invC
//   Pixel 2: epsilon, minForce*dt, maxForce*dt, lambda
//   Pixel 3: bodyAIndex, bodyBIndex, unused, unused
uniform sampler2D u_equationData;

// Previous iteration velocities: [vx, vy, omega, unused] per body
uniform sampler2D u_vlambdaOld;

// Solver parameters
uniform int u_numEquations;
uniform int u_numBodies;
uniform float u_omega;  // SOR relaxation factor
uniform vec2 u_bodyTexSize;
uniform vec2 u_equationTexSize;

// Output new lambda values (written back to CPU)
// We output: [vx, vy, omega, unused]

vec4 texelFetchBody(int bodyIndex) {
  int x = bodyIndex;
  return texelFetch(u_bodyData, ivec2(x, 0), 0);
}

vec4 texelFetchVelocity(int bodyIndex) {
  int x = bodyIndex;
  return texelFetch(u_vlambdaOld, ivec2(x, 0), 0);
}

vec4 texelFetchEquation(int eqIndex, int component) {
  // Equations are laid out as 4 consecutive pixels per equation
  int x = eqIndex * 4 + component;
  return texelFetch(u_equationData, ivec2(x, 0), 0);
}

void main() {
  // Determine which body this pixel represents
  vec2 uv = v_position * 0.5 + 0.5;
  int bodyIndex = int(uv.x * u_bodyTexSize.x);

  if (bodyIndex >= u_numBodies) {
    fragColor = vec4(0.0);
    return;
  }

  // Get this body's mass properties
  vec4 bodyData = texelFetchBody(bodyIndex);
  float invMass = bodyData.x;
  float invInertia = bodyData.y;

  // Accumulate velocity deltas from all equations involving this body
  vec3 vlambdaDelta = vec3(0.0);

  for (int eqIdx = 0; eqIdx < MAX_EQUATIONS; eqIdx++) {
    if (eqIdx >= u_numEquations) break;

    // Read equation data
    vec4 eq0 = texelFetchEquation(eqIdx, 0);  // G[0..3]
    vec4 eq1 = texelFetchEquation(eqIdx, 1);  // G[4..5], B, invC
    vec4 eq2 = texelFetchEquation(eqIdx, 2);  // epsilon, minF*dt, maxF*dt, lambda
    vec4 eq3 = texelFetchEquation(eqIdx, 3);  // bodyAIdx, bodyBIdx, unused, unused

    int bodyAIdx = int(eq3.x);
    int bodyBIdx = int(eq3.y);

    // Check if this body is involved in this equation
    bool isBodyA = (bodyIndex == bodyAIdx);
    bool isBodyB = (bodyIndex == bodyBIdx);

    if (!isBodyA && !isBodyB) continue;

    // Unpack Jacobian
    float G0 = eq0.x, G1 = eq0.y, G2 = eq0.z, G3 = eq0.w;
    float G4 = eq1.x, G5 = eq1.y;
    float B = eq1.z;
    float invC = eq1.w;
    float epsilon = eq2.x;
    float minForceDt = eq2.y;
    float maxForceDt = eq2.z;
    float lambda = eq2.w;

    // Compute GWlambda from old velocities
    vec4 velA = texelFetchVelocity(bodyAIdx);
    vec4 velB = texelFetchVelocity(bodyBIdx);

    float GWlambda = G0 * velA.x + G1 * velA.y + G2 * velA.z
                   + G3 * velB.x + G4 * velB.y + G5 * velB.z;

    // Compute delta lambda
    float deltalambda = invC * (B - GWlambda - epsilon * lambda);
    deltalambda *= u_omega;  // SOR relaxation

    // Clamp to force bounds
    float newLambda = lambda + deltalambda;
    if (newLambda < minForceDt) {
      deltalambda = minForceDt - lambda;
    } else if (newLambda > maxForceDt) {
      deltalambda = maxForceDt - lambda;
    }

    // Accumulate velocity contribution for this body
    if (isBodyA) {
      vlambdaDelta.x += invMass * G0 * deltalambda;
      vlambdaDelta.y += invMass * G1 * deltalambda;
      vlambdaDelta.z += invInertia * G2 * deltalambda;
    }
    if (isBodyB) {
      vlambdaDelta.x += invMass * G3 * deltalambda;
      vlambdaDelta.y += invMass * G4 * deltalambda;
      vlambdaDelta.z += invInertia * G5 * deltalambda;
    }
  }

  fragColor = vec4(vlambdaDelta, 1.0);
}
`.replace("MAX_EQUATIONS", String(MAX_EQUATIONS));

/**
 * GPU-accelerated Jacobi constraint solver using WebGL2 render-to-texture.
 *
 * Architecture:
 * 1. Pack body/equation data into textures on CPU
 * 2. Run Jacobi iteration shader (all bodies computed in parallel)
 * 3. Read back velocity results
 * 4. Repeat for N iterations
 * 5. Update lambda values and apply to bodies
 *
 * This provides parallelism across bodies. For large body counts (100+),
 * the GPU overhead is amortized and provides speedup over CPU.
 *
 * Limitations:
 * - MAX_EQUATIONS equations per solve (limited by shader loop)
 * - MAX_BODIES bodies per solve (limited by texture width)
 * - Requires WebGL2 context
 * - Read-back latency can negate gains for small systems
 */
export default class GPUJacobiSolver implements Solver {
  readonly config: SolverConfig;

  private gl: WebGL2RenderingContext;
  private shader: FullscreenShader;
  private omega: number;

  // Textures
  private bodyDataTexture: WebGLTexture;
  private equationDataTexture: WebGLTexture;
  private vlambdaTextures: [WebGLTexture, WebGLTexture]; // Ping-pong
  private currentVlambdaIndex: number = 0;

  // Framebuffer for render-to-texture
  private framebuffer: WebGLFramebuffer;

  // CPU-side buffers for data packing
  private bodyDataBuffer: Float32Array;
  private equationDataBuffer: Float32Array;
  private vlambdaBuffer: Float32Array;
  private readbackBuffer: Float32Array;

  // Track if we should fall back to CPU
  private useCPUFallback: boolean = false;

  constructor(
    gl: WebGL2RenderingContext,
    config: Partial<SolverConfig> = {},
    omega: number = 0.7
  ) {
    this.gl = gl;
    this.config = { ...DEFAULT_GPU_JACOBI_CONFIG, ...config };
    this.omega = omega;

    // Check for required extensions
    const floatTexExt = gl.getExtension("EXT_color_buffer_float");
    if (!floatTexExt) {
      console.warn(
        "GPUJacobiSolver: EXT_color_buffer_float not supported, falling back to CPU"
      );
      this.useCPUFallback = true;
    }

    // Allocate CPU buffers
    this.bodyDataBuffer = new Float32Array(MAX_BODIES * 4);
    this.equationDataBuffer = new Float32Array(MAX_EQUATIONS * 16);
    this.vlambdaBuffer = new Float32Array(MAX_BODIES * 4);
    this.readbackBuffer = new Float32Array(MAX_BODIES * 4);

    // Create textures
    this.bodyDataTexture = this.createDataTexture(MAX_BODIES, 1);
    this.equationDataTexture = this.createDataTexture(MAX_EQUATIONS * 4, 1);
    this.vlambdaTextures = [
      this.createDataTexture(MAX_BODIES, 1),
      this.createDataTexture(MAX_BODIES, 1),
    ];

    // Create framebuffer
    this.framebuffer = gl.createFramebuffer()!;

    // Create shader
    this.shader = new FullscreenShader(gl, {
      fragmentSource: JACOBI_FRAGMENT_SHADER,
      uniforms: {
        u_numEquations: { type: "1i", value: 0 },
        u_numBodies: { type: "1i", value: 0 },
        u_omega: { type: "1f", value: omega },
        u_bodyTexSize: { type: "2f", value: [MAX_BODIES, 1] },
        u_equationTexSize: { type: "2f", value: [MAX_EQUATIONS * 4, 1] },
      },
      textures: ["u_bodyData", "u_equationData", "u_vlambdaOld"],
    });
  }

  private createDataTexture(width: number, height: number): WebGLTexture {
    const gl = this.gl;
    const texture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA32F,
      width,
      height,
      0,
      gl.RGBA,
      gl.FLOAT,
      null
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return texture;
  }

  solveEquations(
    equations: readonly Equation[],
    dynamicBodies: Iterable<DynamicBody>,
    h: number
  ): SolverResult {
    // Filter disabled equations
    equations = equations.filter((eq) => eq.enabled);
    const bodiesArray = Array.from(dynamicBodies);

    const Neq = equations.length;
    const Nbodies = bodiesArray.length;

    if (Neq === 0 || Nbodies === 0) {
      return { usedIterations: 0 };
    }

    // Fall back to CPU for small systems or if GPU not supported
    if (this.useCPUFallback || Neq > MAX_EQUATIONS || Nbodies > MAX_BODIES) {
      return this.solveCPU(equations, bodiesArray, h);
    }

    return this.solveGPU(equations, bodiesArray, h);
  }

  private solveGPU(
    equations: readonly Equation[],
    bodies: DynamicBody[],
    h: number
  ): SolverResult {
    const gl = this.gl;
    const { iterations, tolerance } = this.config;
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

    // Pack body data into texture
    for (let i = 0; i < Nbodies; i++) {
      const body = bodies[i];
      const base = i * 4;
      this.bodyDataBuffer[base + 0] = body[SOLVER_INV_MASS];
      this.bodyDataBuffer[base + 1] = body[SOLVER_INV_INERTIA];
      this.bodyDataBuffer[base + 2] = 0;
      this.bodyDataBuffer[base + 3] = 0;
    }

    // Upload body data
    gl.bindTexture(gl.TEXTURE_2D, this.bodyDataTexture);
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      0,
      0,
      Nbodies,
      1,
      gl.RGBA,
      gl.FLOAT,
      this.bodyDataBuffer.subarray(0, Nbodies * 4)
    );

    // Pre-compute equation constants and pack into texture
    const lambda = new Float32Array(Neq);

    for (let i = 0; i < Neq; i++) {
      const eq = equations[i];
      if (eq.timeStep !== h || eq.needsUpdate) {
        eq.timeStep = h;
        eq.update();
      }

      const G = eq.G;
      const B = eq.computeB(eq.a, eq.b, h);
      const invC = eq.computeInvC(eq.epsilon);

      const bodyAIdx = bodyIndexMap.get(eq.bodyA as DynamicBody) ?? -1;
      const bodyBIdx = bodyIndexMap.get(eq.bodyB as DynamicBody) ?? -1;

      // Pack into 4 pixels (16 floats) per equation
      const base = i * 16;
      // Pixel 0: G[0..3]
      this.equationDataBuffer[base + 0] = G[0];
      this.equationDataBuffer[base + 1] = G[1];
      this.equationDataBuffer[base + 2] = G[2];
      this.equationDataBuffer[base + 3] = G[3];
      // Pixel 1: G[4..5], B, invC
      this.equationDataBuffer[base + 4] = G[4];
      this.equationDataBuffer[base + 5] = G[5];
      this.equationDataBuffer[base + 6] = B;
      this.equationDataBuffer[base + 7] = invC;
      // Pixel 2: epsilon, minF*dt, maxF*dt, lambda
      this.equationDataBuffer[base + 8] = eq.epsilon;
      this.equationDataBuffer[base + 9] = eq.minForce * h;
      this.equationDataBuffer[base + 10] = eq.maxForce * h;
      this.equationDataBuffer[base + 11] = 0; // lambda starts at 0
      // Pixel 3: bodyAIdx, bodyBIdx, unused, unused
      this.equationDataBuffer[base + 12] = bodyAIdx;
      this.equationDataBuffer[base + 13] = bodyBIdx;
      this.equationDataBuffer[base + 14] = 0;
      this.equationDataBuffer[base + 15] = 0;
    }

    // Upload equation data
    gl.bindTexture(gl.TEXTURE_2D, this.equationDataTexture);
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      0,
      0,
      Neq * 4,
      1,
      gl.RGBA,
      gl.FLOAT,
      this.equationDataBuffer.subarray(0, Neq * 16)
    );

    // Clear velocity textures
    this.vlambdaBuffer.fill(0);
    for (const tex of this.vlambdaTextures) {
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        0,
        0,
        Nbodies,
        1,
        gl.RGBA,
        gl.FLOAT,
        this.vlambdaBuffer.subarray(0, Nbodies * 4)
      );
    }

    // Reset body constraint velocities
    for (const body of bodies) {
      body[SOLVER_RESET_VELOCITY]();
    }

    // Run iterations
    let usedIterations = 0;
    this.currentVlambdaIndex = 0;

    // Save current viewport
    const viewport = gl.getParameter(gl.VIEWPORT);

    for (let iter = 0; iter < iterations; iter++) {
      // Set up render to next vlambda texture
      const readTex = this.vlambdaTextures[this.currentVlambdaIndex];
      const writeTex = this.vlambdaTextures[1 - this.currentVlambdaIndex];

      gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
      gl.framebufferTexture2D(
        gl.FRAMEBUFFER,
        gl.COLOR_ATTACHMENT0,
        gl.TEXTURE_2D,
        writeTex,
        0
      );

      gl.viewport(0, 0, Nbodies, 1);

      // Render Jacobi iteration
      // @ts-ignore - accessing protected uniforms for setting values
      this.shader["uniforms"].u_numEquations.value = Neq;
      // @ts-ignore
      this.shader["uniforms"].u_numBodies.value = Nbodies;
      // @ts-ignore
      this.shader["uniforms"].u_omega.value = this.omega;

      // @ts-ignore - using render with textures
      this.shader.render({
        u_bodyData: this.bodyDataTexture,
        u_equationData: this.equationDataTexture,
        u_vlambdaOld: readTex,
      });

      usedIterations++;
      this.currentVlambdaIndex = 1 - this.currentVlambdaIndex;

      // TODO: Check convergence (would need readback, expensive)
    }

    // Restore viewport
    gl.viewport(viewport[0], viewport[1], viewport[2], viewport[3]);

    // Read back final velocities
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      this.vlambdaTextures[this.currentVlambdaIndex],
      0
    );
    gl.readPixels(0, 0, Nbodies, 1, gl.RGBA, gl.FLOAT, this.readbackBuffer);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    // Apply results to bodies
    for (let i = 0; i < Nbodies; i++) {
      const body = bodies[i];
      const base = i * 4;
      body[SOLVER_VLAMBDA][0] = this.readbackBuffer[base];
      body[SOLVER_VLAMBDA][1] = this.readbackBuffer[base + 1];
      body[SOLVER_WLAMBDA] = this.readbackBuffer[base + 2];
    }

    // Apply constraint velocities
    for (const body of bodies) {
      body[SOLVER_ADD_VELOCITY]();
    }

    // Update multipliers (approximate - we didn't track lambda on GPU)
    // For accurate multipliers, would need separate lambda tracking
    for (let i = 0; i < Neq; i++) {
      equations[i].multiplier = 0; // Approximate
    }

    return { usedIterations };
  }

  /**
   * CPU fallback solver (same as JacobiSolver).
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

        let B = useZeroRHS ? 0 : Bs[j];
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

    updateMultipliers(equations, lambda, 1 / h);

    return { usedIterations };
  }

  solveIsland(island: Island, h: number): SolverResult {
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
    const gl = this.gl;
    gl.deleteTexture(this.bodyDataTexture);
    gl.deleteTexture(this.equationDataTexture);
    gl.deleteTexture(this.vlambdaTextures[0]);
    gl.deleteTexture(this.vlambdaTextures[1]);
    gl.deleteFramebuffer(this.framebuffer);
    this.shader.destroy();
  }
}

// --- Helper Functions ---

function updateMultipliers(
  equations: readonly Equation[],
  lambda: ArrayLike<number>,
  invDt: number
): void {
  for (let i = equations.length - 1; i >= 0; i--) {
    equations[i].multiplier = lambda[i] * invDt;
  }
}
