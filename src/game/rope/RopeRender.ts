/**
 * Rope render sampler.
 *
 * Converts a capstan-network rope's abstract state (node positions + scalar
 * section lengths/tensions) into a per-section polyline suitable for
 * `tessellateRopeStrip`.
 *
 * Each section is decorated with a small Verlet/PBD particle chain that
 * lives between the section's two anchor points (or, for sections adjacent
 * to a winch/block drum, between the precomputed tangent points on the
 * drums). Gravity makes the chain droop, distance constraints keep its arc
 * length close to the section's current rest length, and a deck-height
 * constraint stops the chain from sinking through the hull. The chain is
 * strictly visual — no physics feedback into the rope network.
 */
import type { Body } from "../../core/physics/body/Body";
import type { HullBoundaryData } from "../../core/physics/constraints/DeckContactConstraint";
import { profiler } from "../../core/util/Profiler";
import type { RopeNetwork } from "./RopeNetwork";
import type { FloorFn, ReferenceVelocityFn } from "./RopeParticleChain";
import { RopeParticleChain } from "./RopeParticleChain";

/** Number of particles per foot of section (clamped). Stable for a given network. */
const PARTICLES_PER_FOOT = 4;
const MIN_PARTICLES_PER_SECTION = 8;
const MAX_PARTICLES_PER_SECTION = 48;

/** Small number treated as zero. */
const EPS = 1e-6;

/**
 * Render-time Laplacian smoothing passes applied to each chain's particles
 * before they feed the renderer's Catmull-Rom spline. Catmull-Rom passes
 * exactly through its input, so small PBD position jitter would otherwise
 * show through as wiggles — pre-smoothing irons those out without disturbing
 * the PBD state (smoothing runs on a scratch copy). Endpoints are kept
 * fixed so the emitted polyline still meets each drum arc exactly.
 */
const RENDER_SMOOTH_PASSES = 5;
const RENDER_SMOOTH_LAMBDA = 0.5;

/** Softplus smoothing strength for the deck-floor clamp on emitted samples (ft). */
const FLOOR_SOFTNESS = 0.02;

/** Distance (ft) outside the deck polygon over which the floor tapers to -∞. */
const FLOOR_EDGE_TAPER = 0.5;

/**
 * Fixed wrap side for winches. The rope always tangents the drum on the
 * +perp side of the chord (looking down at the drum in its body frame),
 * which visually corresponds to a consistent clockwise spool. Flip to -1
 * if the wrap reads backwards for a given configuration.
 */
const WINCH_WRAP_SIGN = 1;

export interface RopeRenderConfig {
  /** Hull body — floor queries are done in this body's local frame. */
  hullBody?: Body;
  /** Deck-height lookup in hull-local coords; null = no deck at that point. */
  getDeckHeight?: (localX: number, localY: number) => number | null;
  /** Pre-computed hull boundary used for inside-polygon tests and edge taper. */
  hullBoundary?: HullBoundaryData;
  /** Rope radius for clamp offset (ft). Default 0.025. */
  ropeRadius?: number;
  /**
   * PBD iteration count per chain section. Higher = straighter rope under
   * tension (halyards). The default (unset) uses RopeParticleChain's own
   * default, which is tuned for sheet-style catenary droop.
   */
  chainIterations?: number;
  /**
   * Gravity scale applied to chain particles. 1 (default) = full catenary
   * droop (sheets, anchor rode). 0 = no gravity — for ropes that should
   * read as taut lines (halyards). Values in between model partial load.
   */
  chainGravityScale?: number;
  /**
   * Override the per-section particle count. When unset, count scales
   * with section length. Set low (e.g. 4–6) for ropes that should read
   * as taut straight lines — PBD's Gauss-Seidel convergence rate is
   * roughly (1 − 2π²/N²) per iteration, so dropping N shrinks residual
   * sag dramatically regardless of iteration count.
   */
  particlesPerSection?: number;
  /**
   * Visual drum radius for winch nodes (ft). Sections adjacent to a winch
   * leave/enter tangent to this drum, and the rope wraps around the drum
   * between sections. 0 disables (rope passes through node center). Default 0.
   */
  winchRadius?: number;
  /**
   * Visual sheave radius for block nodes (ft). Same semantics as
   * `winchRadius` but for free-running blocks. Default 0.
   */
  blockRadius?: number;
}

export class RopeRender {
  private readonly network: RopeNetwork;
  private readonly config: RopeRenderConfig;
  private readonly chains: RopeParticleChain[];
  private readonly floorFn: FloorFn;
  /**
   * Reference-frame velocity function: chain damping pulls rope motion
   * toward this velocity (the hull's velocity at the sample point, when a
   * hull body is configured) instead of toward zero world velocity, so the
   * rope rides with the boat rather than lagging behind it.
   */
  private readonly refVelFn: ReferenceVelocityFn | null;
  /**
   * Per-chain scratch buffer holding a smoothed copy of chain.pos used only
   * for sample emission. Keeping this separate from chain.pos means the PBD
   * state stays authoritative and unsmoothed.
   */
  private readonly smoothScratch: Float64Array[] = [];

  // Tangent-point caches reused across update + computeSamples each tick.
  // World-space leave/enter points per node — degenerate to node center
  // when the node has no drum radius.
  private readonly leaveWX: number[] = [];
  private readonly leaveWY: number[] = [];
  private readonly leaveWZ: number[] = [];
  private readonly enterWX: number[] = [];
  private readonly enterWY: number[] = [];
  private readonly enterWZ: number[] = [];
  // Body-local tangent coords, kept around so the drum arc step in
  // computeSamples can compute sweep angles in the drum's own frame.
  private readonly leaveLX: number[] = [];
  private readonly leaveLY: number[] = [];
  private readonly enterLX: number[] = [];
  private readonly enterLY: number[] = [];

  // Output buffers reused across frames.
  private points: [number, number][] = [];
  private z: number[] = [];
  private vCoords: number[] = [];

  constructor(network: RopeNetwork, config: RopeRenderConfig = {}) {
    this.network = network;
    this.config = config;
    this.floorFn = (x, y, z) => this.ropeFloor(x, y, z);
    this.refVelFn = config.hullBody
      ? buildHullVelocityFn(config.hullBody)
      : null;
    this.chains = [];
    this.refreshTangentPoints();
    for (let i = 0; i < network.getSectionCount(); i++) {
      this.chains.push(this.createChainForSection(i));
    }
  }

  /** Total render samples across all sections. Stable for a given network. */
  getTotalSampleCount(): number {
    let total = 0;
    for (let i = 0; i < this.chains.length; i++) {
      total += i === 0 ? this.chains[i].count : this.chains[i].count - 1;
    }
    return total;
  }

  /**
   * Step every PBD chain forward one tick. Called each tick by the owning
   * Sheet/Anchor. Pure render-state update — no body forces applied.
   */
  update(dt: number): void {
    profiler.start("rope.render.update");
    const n = this.network.getSectionCount();
    while (this.chains.length < n) {
      this.chains.push(this.createChainForSection(this.chains.length));
    }

    this.refreshTangentPoints();

    for (let i = 0; i < n; i++) {
      const chain = this.chains[i];
      const section = this.network.getSection(i);
      chain.setEndpoints(
        this.leaveWX[i],
        this.leaveWY[i],
        this.leaveWZ[i],
        this.enterWX[i + 1],
        this.enterWY[i + 1],
        this.enterWZ[i + 1],
      );
      chain.update(section.length, dt, this.floorFn, this.refVelFn);
    }
    profiler.end("rope.render.update");
  }

  /** Compute the rope polyline for this frame. Returns re-used buffers. */
  computeSamples(): {
    points: [number, number][];
    z: number[];
    vPerPoint: number[];
  } {
    profiler.start("rope.render.samples");
    const result = this.computeSamplesInner();
    profiler.end("rope.render.samples");
    return result;
  }

  private computeSamplesInner(): {
    points: [number, number][];
    z: number[];
    vPerPoint: number[];
  } {
    this.points.length = 0;
    this.z.length = 0;
    this.vCoords.length = 0;

    const network = this.network;
    const sectionCount = network.getSectionCount();
    if (sectionCount === 0) {
      return { points: this.points, z: this.z, vPerPoint: this.vCoords };
    }

    // Refresh tangent points so render geometry tracks any sub-tick body
    // movement. Chain endpoints are also pinned to the fresh values so the
    // emitted polyline meets each drum arc exactly.
    this.refreshTangentPoints();

    const nodeCount = network.getNodeCount();
    const winchR = this.config.winchRadius ?? 0;
    const blockR = this.config.blockRadius ?? 0;
    const radius: number[] = new Array(nodeCount);
    for (let i = 0; i < nodeCount; i++) {
      const n = network.getNode(i);
      radius[i] = n.kind === "winch" ? winchR : n.kind === "block" ? blockR : 0;
    }

    let vStart = 0;
    let firstSample = true;
    for (let si = 0; si < sectionCount; si++) {
      const section = network.getSection(si);
      const chain = this.chains[si];
      const L = section.length;

      // Copy chain positions into a smoothing scratch, snap endpoints to
      // current tangent points, and run a few Laplacian passes to remove
      // PBD-induced jitter before the renderer's Catmull-Rom subdivision
      // interpolates through these points.
      const ax = this.leaveWX[si];
      const ay = this.leaveWY[si];
      const az = this.leaveWZ[si];
      const bx = this.enterWX[si + 1];
      const by = this.enterWY[si + 1];
      const bz = this.enterWZ[si + 1];
      const smoothed = this.getSmoothScratch(si, chain.count);
      smoothed.set(chain.pos);
      smoothed[0] = ax;
      smoothed[1] = ay;
      smoothed[2] = az;
      const lastIdx = (chain.count - 1) * 3;
      smoothed[lastIdx] = bx;
      smoothed[lastIdx + 1] = by;
      smoothed[lastIdx + 2] = bz;
      laplacianSmooth(
        smoothed,
        chain.count,
        RENDER_SMOOTH_PASSES,
        RENDER_SMOOTH_LAMBDA,
      );

      // Emit particle positions. Skip the duplicate shared endpoint at si > 0
      // (already emitted by the previous section's drum arc, or its last
      // particle if no drum sat between them).
      const startI = firstSample ? 0 : 1;
      const N = chain.count;
      const segLen = L / (N - 1);
      let v = vStart + startI * segLen;
      for (let i = startI; i < N; i++) {
        const o = i * 3;
        const px = smoothed[o];
        const py = smoothed[o + 1];
        const pz = this.clampToFloor(px, py, smoothed[o + 2]);
        this.points.push([px, py]);
        this.z.push(pz);
        this.vCoords.push(v);
        v += segLen;
      }
      vStart += L;
      firstSample = false;

      // Wrap arc around drum at node si+1 (if interior drum). The arc is
      // generated in the drum body's local xy plane at the anchor z and
      // transformed to world, so it coincides exactly with the hull-local
      // cheek disks drawn in BoatRenderer regardless of heel.
      const drumIdx = si + 1;
      if (
        drumIdx < nodeCount - 1 &&
        radius[drumIdx] > 0 &&
        si + 1 < sectionCount
      ) {
        const drumNode = network.getNode(drumIdx);
        const la = drumNode.localAnchor;
        const r = radius[drumIdx];
        const ain = Math.atan2(
          this.enterLY[drumIdx] - la[1],
          this.enterLX[drumIdx] - la[0],
        );
        const aout = Math.atan2(
          this.leaveLY[drumIdx] - la[1],
          this.leaveLX[drumIdx] - la[0],
        );
        let delta = aout - ain;
        while (delta > Math.PI) delta -= 2 * Math.PI;
        while (delta < -Math.PI) delta += 2 * Math.PI;
        const arcLen = Math.abs(delta) * r;
        const nArc = 8;
        for (let i = 1; i <= nArc; i++) {
          const t = i / nArc;
          const a = ain + delta * t;
          const lx = la[0] + r * Math.cos(a);
          const ly = la[1] + r * Math.sin(a);
          const w = drumNode.body.toWorldFrame3D(lx, ly, la[2]);
          const pz = this.clampToFloor(w[0], w[1], w[2]);
          this.points.push([w[0], w[1]]);
          this.z.push(pz);
          this.vCoords.push(vStart + t * arcLen);
        }
        vStart += arcLen;
      }
    }

    return { points: this.points, z: this.z, vPerPoint: this.vCoords };
  }

  // ─── Internals ───────────────────────────────────────────────────

  private getSmoothScratch(idx: number, count: number): Float64Array {
    const existing = this.smoothScratch[idx];
    if (existing && existing.length === count * 3) return existing;
    const buf = new Float64Array(count * 3);
    this.smoothScratch[idx] = buf;
    return buf;
  }

  private createChainForSection(idx: number): RopeParticleChain {
    const section = this.network.getSection(idx);
    const count =
      this.config.particlesPerSection ?? particleCountFor(section.length);
    const chain = new RopeParticleChain(
      count,
      this.leaveWX[idx],
      this.leaveWY[idx],
      this.leaveWZ[idx],
      this.enterWX[idx + 1],
      this.enterWY[idx + 1],
      this.enterWZ[idx + 1],
      section.length,
    );
    if (this.config.chainIterations !== undefined) {
      chain.iterations = this.config.chainIterations;
    }
    if (this.config.chainGravityScale !== undefined) {
      chain.gravityScale = this.config.chainGravityScale;
    }
    return chain;
  }

  /**
   * Recompute every node's leave/enter tangent points (world + body-local)
   * from the current node world positions and configured drum radii. Nodes
   * without a drum degenerate to the node's own world position.
   */
  private refreshTangentPoints(): void {
    const network = this.network;
    const nodeCount = network.getNodeCount();
    const sectionCount = network.getSectionCount();
    const winchR = this.config.winchRadius ?? 0;
    const blockR = this.config.blockRadius ?? 0;

    // Resize caches on demand.
    while (this.leaveWX.length < nodeCount) {
      this.leaveWX.push(0);
      this.leaveWY.push(0);
      this.leaveWZ.push(0);
      this.enterWX.push(0);
      this.enterWY.push(0);
      this.enterWZ.push(0);
      this.leaveLX.push(0);
      this.leaveLY.push(0);
      this.enterLX.push(0);
      this.enterLY.push(0);
    }

    const nodeX: number[] = new Array(nodeCount);
    const nodeY: number[] = new Array(nodeCount);
    const nodeZ: number[] = new Array(nodeCount);
    const radius: number[] = new Array(nodeCount);
    for (let i = 0; i < nodeCount; i++) {
      const n = network.getNode(i);
      nodeX[i] = n.worldPos[0];
      nodeY[i] = n.worldPos[1];
      nodeZ[i] = n.worldPos[2];
      radius[i] = n.kind === "winch" ? winchR : n.kind === "block" ? blockR : 0;
      // Default the tangent points to the node center.
      this.leaveWX[i] = nodeX[i];
      this.leaveWY[i] = nodeY[i];
      this.leaveWZ[i] = nodeZ[i];
      this.enterWX[i] = nodeX[i];
      this.enterWY[i] = nodeY[i];
      this.enterWZ[i] = nodeZ[i];
    }

    // Wrap sign per interior drum: which side of the chord the rope tangents.
    //   - Winches: fixed sign so the wrap stays visually consistent as the
    //     sail clew swings; otherwise tiny geometry shifts flip it.
    //   - Blocks: derived from incoming/outgoing chord cross product, so a
    //     free-running block wraps whichever way the rope actually bends.
    const wrapSign: number[] = new Array(nodeCount).fill(0);
    for (let i = 1; i < nodeCount - 1; i++) {
      if (radius[i] <= 0) continue;
      const node = network.getNode(i);
      if (node.kind === "winch") {
        wrapSign[i] = WINCH_WRAP_SIGN;
        continue;
      }
      const body = node.body;
      const la = body.toLocalFrame3D(nodeX[i - 1], nodeY[i - 1], nodeZ[i - 1]);
      const lb = body.toLocalFrame3D(nodeX[i], nodeY[i], nodeZ[i]);
      const lc = body.toLocalFrame3D(nodeX[i + 1], nodeY[i + 1], nodeZ[i + 1]);
      const dxIn = lb[0] - la[0];
      const dyIn = lb[1] - la[1];
      const dxOut = lc[0] - lb[0];
      const dyOut = lc[1] - lb[1];
      const cross = dxIn * dyOut - dyIn * dxOut;
      wrapSign[i] = cross > EPS ? -1 : cross < -EPS ? 1 : 0;
    }

    for (let si = 0; si < sectionCount; si++) {
      const a = si;
      const b = si + 1;
      const rA = radius[a];
      const rB = radius[b];
      if (rA <= 0 && rB <= 0) continue;

      const nA = network.getNode(a);
      const nB = network.getNode(b);
      const laA = nA.localAnchor;
      const laB = nB.localAnchor;
      const sA = wrapSign[a];
      const sB = wrapSign[b];

      if (rA > 0 && rB > 0 && nA.body === nB.body) {
        // Two drums on the same body: proper circle-to-circle tangent in
        // the shared body's xy plane.
        const res = computeCircleTangent(
          laA[0],
          laA[1],
          rA,
          sA,
          laB[0],
          laB[1],
          rB,
          sB,
        );
        if (res) {
          this.leaveLX[a] = res.tax;
          this.leaveLY[a] = res.tay;
          const wA = nA.body.toWorldFrame3D(res.tax, res.tay, laA[2]);
          this.leaveWX[a] = wA[0];
          this.leaveWY[a] = wA[1];
          this.leaveWZ[a] = wA[2];
          this.enterLX[b] = res.tbx;
          this.enterLY[b] = res.tby;
          const wB = nB.body.toWorldFrame3D(res.tbx, res.tby, laB[2]);
          this.enterWX[b] = wB[0];
          this.enterWY[b] = wB[1];
          this.enterWZ[b] = wB[2];
        }
        continue;
      }

      // Per-drum point-to-circle tangent in each drum's body frame.
      // (Also the two-drum different-body fallback.) computePointTangent's
      // `u` points from the external point toward the drum; for the enter
      // tangent that matches rope travel, but for the leave tangent the
      // rope travels drum→next, so we negate the sign to keep both tangent
      // points on the same side of the rope path.
      if (rA > 0) {
        const pLocal = nA.body.toLocalFrame3D(nodeX[b], nodeY[b], nodeZ[b]);
        const tp = computePointTangent(
          pLocal[0],
          pLocal[1],
          laA[0],
          laA[1],
          rA,
          -(sA !== 0 ? sA : 1),
        );
        this.leaveLX[a] = tp.tx;
        this.leaveLY[a] = tp.ty;
        const w = nA.body.toWorldFrame3D(tp.tx, tp.ty, laA[2]);
        this.leaveWX[a] = w[0];
        this.leaveWY[a] = w[1];
        this.leaveWZ[a] = w[2];
      }
      if (rB > 0) {
        const pLocal = nB.body.toLocalFrame3D(nodeX[a], nodeY[a], nodeZ[a]);
        const tp = computePointTangent(
          pLocal[0],
          pLocal[1],
          laB[0],
          laB[1],
          rB,
          sB !== 0 ? sB : 1,
        );
        this.enterLX[b] = tp.tx;
        this.enterLY[b] = tp.ty;
        const w = nB.body.toWorldFrame3D(tp.tx, tp.ty, laB[2]);
        this.enterWX[b] = w[0];
        this.enterWY[b] = w[1];
        this.enterWZ[b] = w[2];
      }
    }
  }

  /** Clamp a world-space z-value up to the rope floor at (x, y, z). */
  private clampToFloor(x: number, y: number, z: number): number {
    const floor = this.ropeFloor(x, y, z);
    if (!isFinite(floor)) return z;
    // Softplus: smoothly transitions between z and floor.
    return softplusAbove(z, floor, FLOOR_SOFTNESS);
  }

  /**
   * World-space z-value below which a rope sample at world (x, y, z) must
   * not dip. Returns -∞ where there is no floor.
   *
   * The hull body tilts in 3D (heel + pitch), so a yaw-only inverse to
   * hull-local (lx, ly) places the deck lookup at the wrong point and the
   * returned floor is too low — the rope visibly sinks into the deck. Use
   * the body's full 3D rotation matrix instead, matching the convention
   * `DeckContactConstraint` uses for the same query.
   */
  private ropeFloor(x: number, y: number, z: number): number {
    const hb = this.config.hullBoundary;
    const gd = this.config.getDeckHeight;
    const hull = this.config.hullBody;
    if (!hb || !gd || !hull || hb.levels.length === 0) return -Infinity;

    const R = hull.orientation;
    const dx = x - hull.position[0];
    const dy = y - hull.position[1];
    const dz = z - hull.z;
    const lx = R[0] * dx + R[3] * dy + R[6] * dz;
    const ly = R[1] * dx + R[4] * dy + R[7] * dz;
    const ropeRadius = this.config.ropeRadius ?? 0.025;

    // Use the topmost level (the deck outline at z = deckHeight).
    const deckLevel = hb.levels[hb.levels.length - 1];

    if (pointInBoundary(deckLevel.vx, deckLevel.vy, lx, ly)) {
      const localFloor = gd(lx, ly);
      if (localFloor == null) return -Infinity;
      return hull.worldZ(lx, ly, localFloor + ropeRadius);
    }
    // Outside the deck polygon but close — taper the floor down rapidly so
    // rope drapes over the gunwale without a hard cliff.
    const edge = nearestBoundaryPoint(deckLevel.vx, deckLevel.vy, lx, ly);
    if (!edge || edge.distance >= FLOOR_EDGE_TAPER) return -Infinity;
    const localFloor = gd(edge.x, edge.y);
    if (localFloor == null) return -Infinity;
    const edgeWorldZ = hull.worldZ(edge.x, edge.y, localFloor + ropeRadius);
    const fade = 1 - edge.distance / FLOOR_EDGE_TAPER;
    return edgeWorldZ - (1 - fade) * 1000;
  }
}

/**
 * Build a closure that fills `out` with the hull body's world-frame velocity
 * at the given world point — linear + angular contribution (ω × r). Used as
 * the PBD damping reference frame so a rope on a moving/yawing/heeling boat
 * stays visually attached to the deck instead of lagging in world space.
 */
function buildHullVelocityFn(hull: Body): ReferenceVelocityFn {
  return (x, y, z, out) => {
    const w = hull.angularVelocity3;
    const rx = x - hull.position[0];
    const ry = y - hull.position[1];
    const rz = z - hull.z;
    // v = v_linear + ω × r
    out[0] = hull.velocity[0] + w[1] * rz - w[2] * ry;
    out[1] = hull.velocity[1] + w[2] * rx - w[0] * rz;
    out[2] = hull.zVelocity + w[0] * ry - w[1] * rx;
  };
}

/**
 * In-place Laplacian smoothing on a flat [x0,y0,z0,x1,y1,z1,…] buffer of
 * `count` particles. Endpoints (i=0 and i=count-1) are held fixed. Uses
 * Gauss-Seidel (single forward pass per iteration) since the shift bias
 * relative to Jacobi is imperceptible for visual rope smoothing.
 */
function laplacianSmooth(
  buf: Float64Array,
  count: number,
  passes: number,
  lambda: number,
): void {
  if (count < 3 || passes <= 0) return;
  const keep = 1 - lambda;
  const half = lambda * 0.5;
  for (let p = 0; p < passes; p++) {
    for (let i = 1; i < count - 1; i++) {
      const o = i * 3;
      buf[o] = keep * buf[o] + half * (buf[o - 3] + buf[o + 3]);
      buf[o + 1] = keep * buf[o + 1] + half * (buf[o - 2] + buf[o + 4]);
      buf[o + 2] = keep * buf[o + 2] + half * (buf[o - 1] + buf[o + 5]);
    }
  }
}

function particleCountFor(length: number): number {
  return clampInt(
    Math.round(length * PARTICLES_PER_FOOT),
    MIN_PARTICLES_PER_SECTION,
    MAX_PARTICLES_PER_SECTION,
  );
}

/**
 * Tangent point from external point (px, py) to circle centered at (cx, cy)
 * with radius r, on side `s` (+1 or -1). Returned in the same 2D frame as
 * the inputs.
 */
function computePointTangent(
  px: number,
  py: number,
  cx: number,
  cy: number,
  r: number,
  s: number,
): { tx: number; ty: number } {
  const dx = cx - px;
  const dy = cy - py;
  const d = Math.sqrt(dx * dx + dy * dy);
  if (d <= r) return { tx: cx, ty: cy };
  const ux = dx / d;
  const uy = dy / d;
  const perpX = -uy; // 90° CCW of u
  const perpY = ux;
  const cosB = r / d;
  const sinB = Math.sqrt(1 - cosB * cosB);
  return {
    tx: cx + r * (s * sinB * perpX - cosB * ux),
    ty: cy + r * (s * sinB * perpY - cosB * uy),
  };
}

/**
 * Tangent between two circles (A, rA, sA) and (B, rB, sB) where sA/sB are
 * each ±1 for the drum's wrap side. Chooses external vs internal tangent
 * from the signs. Returns null if the drums overlap.
 */
function computeCircleTangent(
  ax: number,
  ay: number,
  rA: number,
  sA: number,
  bx: number,
  by: number,
  rB: number,
  sB: number,
): { tax: number; tay: number; tbx: number; tby: number } | null {
  const dx = bx - ax;
  const dy = by - ay;
  const c = Math.sqrt(dx * dx + dy * dy);
  if (c < EPS) return null;
  const ux = dx / c;
  const uy = dy / c;
  const perpX = -uy;
  const perpY = ux;
  // Zero sign (shouldn't happen for a radius-bearing drum in normal
  // geometry) falls back to external with the other end's sign.
  const effA = sA !== 0 ? sA : sB !== 0 ? sB : 1;
  const effB = sB !== 0 ? sB : effA;
  const crossed = effA * effB < 0;
  const sinAlpha = (rA - (crossed ? -rB : rB)) / c;
  if (Math.abs(sinAlpha) >= 1) return null;
  const cosAlpha = Math.sqrt(1 - sinAlpha * sinAlpha);
  const nx = sinAlpha * ux + cosAlpha * perpX;
  const ny = sinAlpha * uy + cosAlpha * perpY;
  const signB = crossed ? -effA : effB;
  return {
    tax: ax + rA * effA * nx,
    tay: ay + rA * effA * ny,
    tbx: bx + rB * signB * nx,
    tby: by + rB * signB * ny,
  };
}

/** softplus: max(a, b) smoothed with scale ε. */
function softplusAbove(a: number, b: number, eps: number): number {
  // b + ε * log(1 + exp((a - b) / ε)); avoids overflow for large a-b.
  const diff = (a - b) / eps;
  if (diff > 30) return a;
  if (diff < -30) return b;
  return b + eps * Math.log(1 + Math.exp(diff));
}

function clampInt(n: number, lo: number, hi: number): number {
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

/** Standard ray-casting point-in-polygon on separate x/y arrays. */
function pointInBoundary(
  vx: Float64Array,
  vy: Float64Array,
  x: number,
  y: number,
): boolean {
  let inside = false;
  const n = vx.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = vx[i];
    const yi = vy[i];
    const xj = vx[j];
    const yj = vy[j];
    const intersect =
      yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi + EPS) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/** Nearest point on any polygon edge (separate x/y arrays). */
function nearestBoundaryPoint(
  vx: Float64Array,
  vy: Float64Array,
  x: number,
  y: number,
): { x: number; y: number; distance: number } | null {
  const n = vx.length;
  if (n < 2) return null;
  let bestX = 0;
  let bestY = 0;
  let bestD = Infinity;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const ax = vx[j];
    const ay = vy[j];
    const bx = vx[i];
    const by = vy[i];
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    if (len2 < EPS) continue;
    let t = ((x - ax) * dx + (y - ay) * dy) / len2;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
    const cx = ax + dx * t;
    const cy = ay + dy * t;
    const ex = x - cx;
    const ey = y - cy;
    const d = Math.sqrt(ex * ex + ey * ey);
    if (d < bestD) {
      bestD = d;
      bestX = cx;
      bestY = cy;
    }
  }
  return isFinite(bestD) ? { x: bestX, y: bestY, distance: bestD } : null;
}
