/**
 * Rope render sampler.
 *
 * Converts a capstan-network rope's abstract state (node positions + scalar
 * section lengths/tensions) into a per-section polyline suitable for
 * `tessellateRopeStrip`. Layers: straight-chord / parabolic sag baseline,
 * optional per-section lateral oscillator (decorative liveliness), and
 * a softplus-clamped deck floor so the rope doesn't dip through the hull.
 *
 * Strictly visual — no physics feedback. Owned by Sheet/Anchor alongside
 * the RopeNetwork.
 */

import type { Body } from "../../core/physics/body/Body";
import type { HullBoundaryData } from "../../core/physics/constraints/DeckContactConstraint";
import { V3d } from "../../core/Vector3";
import type { RopeNetwork } from "./RopeNetwork";

/** Real-world gravity magnitude for catenary sag (ft/s²). */
const GRAVITY = 32.2;

/** Number of render samples per foot of section length (pre-clamp). */
const SAMPLES_PER_FOOT = 4;
const MIN_SAMPLES_PER_SECTION = 8;
const MAX_SAMPLES_PER_SECTION = 48;

/** Small number treated as zero. */
const EPS = 1e-6;

/** Softplus smoothing strength for the deck-floor clamp (feet). */
const FLOOR_SOFTNESS = 0.02;

/** Distance (ft) outside the deck polygon over which the floor tapers to -∞. */
const FLOOR_EDGE_TAPER = 0.5;

/** Oscillator stiffness coefficients: k = LENGTH_K * length + TENSION_K * tension. */
const OSC_LENGTH_K = 2;
const OSC_TENSION_K = 0.15;

/** Oscillator damping (1/s). Target ~critical damping for typical tensions. */
const OSC_DAMPING = 3.0;

/** Max oscillator ω·dt. Above this, state is frozen to prevent blow-ups. */
const OSC_MAX_WDT = 0.3;

export interface RopeRenderConfig {
  /** Hull body — floor queries are done in this body's local frame. */
  hullBody?: Body;
  /** Deck-height lookup in hull-local coords; null = no deck at that point. */
  getDeckHeight?: (localX: number, localY: number) => number | null;
  /** Pre-computed hull boundary used for inside-polygon tests and edge taper. */
  hullBoundary?: HullBoundaryData;
  /** Rope radius for clamp offset (ft). Default 0.025. */
  ropeRadius?: number;
}

interface SectionRenderState {
  /** Lateral oscillator displacement (world-space 3D). */
  oscPos: V3d;
  oscVel: V3d;
  /** Stable sample count for this section, set at construction. */
  sampleCount: number;
}

function makeState(initialLength: number): SectionRenderState {
  const sampleCount = clampInt(
    Math.round(initialLength * SAMPLES_PER_FOOT),
    MIN_SAMPLES_PER_SECTION,
    MAX_SAMPLES_PER_SECTION,
  );
  return {
    oscPos: new V3d(0, 0, 0),
    oscVel: new V3d(0, 0, 0),
    sampleCount,
  };
}

export class RopeRender {
  private readonly network: RopeNetwork;
  private readonly config: RopeRenderConfig;
  private readonly states: SectionRenderState[];

  // Output buffers reused across frames.
  private points: [number, number][] = [];
  private z: number[] = [];
  private vCoords: number[] = [];

  constructor(network: RopeNetwork, config: RopeRenderConfig = {}) {
    this.network = network;
    this.config = config;
    this.states = [];
    for (let i = 0; i < network.getSectionCount(); i++) {
      const section = network.getSection(i);
      this.states.push(makeState(section.length));
    }
  }

  /** Total render samples across all sections. Stable for a given network. */
  getTotalSampleCount(): number {
    let total = 0;
    for (let i = 0; i < this.states.length; i++) {
      // Section 0 contributes full count; subsequent sections skip the shared
      // first sample (already emitted as previous section's last sample).
      total +=
        i === 0 ? this.states[i].sampleCount : this.states[i].sampleCount - 1;
    }
    return total;
  }

  /**
   * Integrate per-section oscillator state. Called each tick by the owner
   * (Sheet/Anchor). Pure render-state update — no body forces applied.
   */
  update(dt: number): void {
    const n = this.network.getSectionCount();
    while (this.states.length < n) {
      this.states.push(
        makeState(this.network.getSection(this.states.length).length),
      );
    }

    for (let i = 0; i < n; i++) {
      const section = this.network.getSection(i);
      const state = this.states[i];
      const L = Math.max(0.01, section.length);

      // Spring stiffness grows with tension and length.
      const k = OSC_LENGTH_K * L + OSC_TENSION_K * section.tension;
      const mass = 1.0; // lumped; absolute value is calibrated via k,c
      const omega = Math.sqrt(k / mass);
      if (omega * dt > OSC_MAX_WDT) {
        // Frozen-amplitude regime: reads as "rope goes stiff under shock".
        state.oscPos[0] = 0;
        state.oscPos[1] = 0;
        state.oscPos[2] = 0;
        state.oscVel[0] = 0;
        state.oscVel[1] = 0;
        state.oscVel[2] = 0;
        continue;
      }

      // Gravity pull perpendicular to chord contributes to the restoring target.
      const nA = this.network.getNode(i);
      const nB = this.network.getNode(i + 1);
      const dx = nB.worldPos[0] - nA.worldPos[0];
      const dy = nB.worldPos[1] - nA.worldPos[1];
      const dz = nB.worldPos[2] - nA.worldPos[2];
      const chord = Math.sqrt(dx * dx + dy * dy + dz * dz);
      // Force on the lumped midpoint: restoring spring + damping + gravity perp.
      // Target equilibrium is zero displacement (catenary baseline handles sag).
      const ax = -k * state.oscPos[0] - OSC_DAMPING * state.oscVel[0];
      const ay = -k * state.oscPos[1] - OSC_DAMPING * state.oscVel[1];
      // Z gets a small gravity nudge proportional to chord-perpendicular factor,
      // exciting oscillations when the rope is slack or wind drops.
      const slackFactor = Math.max(0, L - chord) / (L + EPS);
      const az =
        -k * state.oscPos[2] -
        OSC_DAMPING * state.oscVel[2] -
        GRAVITY * mass * 0.05 * slackFactor;
      state.oscVel[0] += ax * dt;
      state.oscVel[1] += ay * dt;
      state.oscVel[2] += az * dt;
      state.oscPos[0] += state.oscVel[0] * dt;
      state.oscPos[1] += state.oscVel[1] * dt;
      state.oscPos[2] += state.oscVel[2] * dt;
    }
  }

  /** Compute the rope polyline for this frame. Returns re-used buffers. */
  computeSamples(): {
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

    let vStart = 0;
    for (let si = 0; si < sectionCount; si++) {
      const section = network.getSection(si);
      const state = this.states[si];
      const nA = network.getNode(si);
      const nB = network.getNode(si + 1);

      const ax = nA.worldPos[0];
      const ay = nA.worldPos[1];
      const az = nA.worldPos[2];
      const bx = nB.worldPos[0];
      const by = nB.worldPos[1];
      const bz = nB.worldPos[2];
      const chord = section.chord;
      const L = section.length;

      // Taut threshold: chord ≥ length * 0.995 → render as straight line.
      const taut = chord >= L * 0.995 || chord < EPS;

      // Sag magnitude using a parabolic arc-length approximation:
      // for a parabola y = 4h·t(1-t) spanning chord c, arc length ≈ c + 8h²/(3c),
      // so h ≈ sqrt(3c(L-c)/8). Far more realistic than a V-shape for small
      // slack, and doesn't explode when L is many times the chord.
      // Cap sag at chord × 1.2 to prevent tail-coil sections (huge L/c ratio)
      // from producing absurd V-shapes that the deck clamp can't mask cleanly.
      let sagMag = 0;
      if (!taut) {
        const slack = L - chord;
        if (slack > 0) {
          sagMag = Math.sqrt((3 * chord * slack) / 8);
          const cap = chord * 1.2;
          if (sagMag > cap) sagMag = cap;
        }
      }

      const nSamples = state.sampleCount;

      // Skip the duplicate shared node at si > 0 (already emitted as previous
      // section's last sample).
      const startI = si === 0 ? 0 : 1;
      for (let i = startI; i < nSamples; i++) {
        const t = i / (nSamples - 1);
        // Chord-interpolated base position.
        let px = ax + (bx - ax) * t;
        let py = ay + (by - ay) * t;
        let pz = az + (bz - az) * t;
        // Parabolic sag (down in world z).
        if (sagMag > EPS) {
          const peak = 4 * t * (1 - t); // 0 at ends, 1 at midpoint
          pz -= sagMag * peak;
        }
        // Oscillator displacement: smooth peak at section midpoint.
        const oscWeight = 4 * t * (1 - t);
        px += state.oscPos[0] * oscWeight;
        py += state.oscPos[1] * oscWeight;
        pz += state.oscPos[2] * oscWeight;

        // Deck-floor clamp (render-only).
        pz = this.clampToFloor(px, py, pz);

        this.points.push([px, py]);
        this.z.push(pz);
        this.vCoords.push(vStart + t * L);
      }

      vStart += L;
    }

    return { points: this.points, z: this.z, vPerPoint: this.vCoords };
  }

  /** Clamp a world-space z-value up to the rope floor at (x, y). */
  private clampToFloor(x: number, y: number, z: number): number {
    const floor = this.ropeFloor(x, y);
    if (!isFinite(floor)) return z;
    const ropeRadius = this.config.ropeRadius ?? 0.025;
    const floorPlus = floor + ropeRadius;
    // Softplus: smoothly transitions between z and floor+r.
    return softplusAbove(z, floorPlus, FLOOR_SOFTNESS);
  }

  /**
   * World-space z-value below which rope samples must not dip. Returns -∞
   * where there is no floor.
   */
  private ropeFloor(x: number, y: number): number {
    const hb = this.config.hullBoundary;
    const gd = this.config.getDeckHeight;
    const hull = this.config.hullBody;
    if (!hb || !gd || !hull || hb.levels.length === 0) return -Infinity;

    // Transform to hull-local frame.
    const lx = this.hullLocalX(hull, x, y);
    const ly = this.hullLocalY(hull, x, y);

    // Use the topmost level (the deck outline at z = deckHeight).
    const deckLevel = hb.levels[hb.levels.length - 1];

    if (pointInBoundary(deckLevel.vx, deckLevel.vy, lx, ly)) {
      const localFloor = gd(lx, ly);
      if (localFloor == null) return -Infinity;
      return hull.worldZ(lx, ly, localFloor);
    }
    // Outside the deck polygon but close — taper the floor down rapidly so
    // rope drapes over the gunwale without a hard cliff.
    const edge = nearestBoundaryPoint(deckLevel.vx, deckLevel.vy, lx, ly);
    if (!edge || edge.distance >= FLOOR_EDGE_TAPER) return -Infinity;
    const localFloor = gd(edge.x, edge.y);
    if (localFloor == null) return -Infinity;
    const edgeWorldZ = hull.worldZ(edge.x, edge.y, localFloor);
    const fade = 1 - edge.distance / FLOOR_EDGE_TAPER;
    return edgeWorldZ - (1 - fade) * 1000;
  }

  /** Hull-local X from world (x, y) using the hull body's inverse frame. */
  private hullLocalX(hull: Body, x: number, y: number): number {
    const hx = hull.position[0];
    const hy = hull.position[1];
    const ca = Math.cos(-hull.angle);
    const sa = Math.sin(-hull.angle);
    return (x - hx) * ca - (y - hy) * sa;
  }

  private hullLocalY(hull: Body, x: number, y: number): number {
    const hx = hull.position[0];
    const hy = hull.position[1];
    const ca = Math.cos(-hull.angle);
    const sa = Math.sin(-hull.angle);
    return (x - hx) * sa + (y - hy) * ca;
  }
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
