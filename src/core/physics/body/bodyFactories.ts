import type { CompatibleVector } from "../../Vector";
import type {
  DynamicPointMass2D,
  DynamicPointMass3D,
  DynamicRigid2D,
  DynamicRigid3D,
  KinematicPointMass2D,
  KinematicPointMass3D,
  KinematicRigid2D,
  KinematicRigid3D,
  MotionMode,
  MotionView,
  PointMass2D,
  PointMass3D,
  Rigid2D,
  Rigid3D,
  StaticPointMass2D,
  StaticPointMass3D,
  StaticRigid2D,
  StaticRigid3D,
} from "./bodyInterfaces";
import { UnifiedBody } from "./UnifiedBody";

// ─────────────────────────────────────────────────────────────────────────
// Per-shape option types, narrowed by a `motion` discriminant
// ─────────────────────────────────────────────────────────────────────────

interface BaseOpts {
  position?: CompatibleVector;
  id?: number;
  collisionResponse?: boolean;
}

interface DynamicCommonOpts extends BaseOpts {
  motion: "dynamic";
  mass: number;
  velocity?: CompatibleVector;
  damping?: number;
  allowSleep?: boolean;
  sleepSpeedLimit?: number;
  sleepTimeLimit?: number;
  ccdSpeedThreshold?: number;
  ccdIterations?: number;
}

interface KinematicCommonOpts extends BaseOpts {
  motion: "kinematic";
  velocity?: CompatibleVector;
}

interface StaticCommonOpts extends BaseOpts {
  motion: "static";
}

// ── PointMass2D ──────────────────────────────────────────────────────────

export type PointMass2DOptions<M extends MotionMode = MotionMode> =
  M extends "dynamic"
    ? DynamicCommonOpts
    : M extends "kinematic"
      ? KinematicCommonOpts
      : StaticCommonOpts;

export function createPointMass2D(
  opts: DynamicCommonOpts,
): UnifiedBody & DynamicPointMass2D;
export function createPointMass2D(
  opts: KinematicCommonOpts,
): UnifiedBody & KinematicPointMass2D;
export function createPointMass2D(
  opts: StaticCommonOpts,
): UnifiedBody & StaticPointMass2D;
export function createPointMass2D(
  opts: PointMass2DOptions,
): UnifiedBody & PointMass2D & MotionView<MotionMode> {
  return new UnifiedBody({
    shape: "pm2d",
    ...opts,
  } as ConstructorParameters<typeof UnifiedBody>[0]) as unknown as UnifiedBody &
    PointMass2D &
    MotionView<MotionMode>;
}

// ── Rigid2D ──────────────────────────────────────────────────────────────

interface Rigid2DDynamicOpts extends DynamicCommonOpts {
  angle?: number;
  angularVelocity?: number;
  angularDamping?: number;
}
interface Rigid2DKinematicOpts extends KinematicCommonOpts {
  angle?: number;
  angularVelocity?: number;
}
interface Rigid2DStaticOpts extends StaticCommonOpts {
  angle?: number;
}

export type Rigid2DOptions<M extends MotionMode = MotionMode> =
  M extends "dynamic"
    ? Rigid2DDynamicOpts
    : M extends "kinematic"
      ? Rigid2DKinematicOpts
      : Rigid2DStaticOpts;

export function createRigid2D(
  opts: Rigid2DDynamicOpts,
): UnifiedBody & DynamicRigid2D;
export function createRigid2D(
  opts: Rigid2DKinematicOpts,
): UnifiedBody & KinematicRigid2D;
export function createRigid2D(
  opts: Rigid2DStaticOpts,
): UnifiedBody & StaticRigid2D;
export function createRigid2D(
  opts: Rigid2DOptions,
): UnifiedBody & Rigid2D & MotionView<MotionMode> {
  return new UnifiedBody({
    shape: "rigid2d",
    ...opts,
  } as ConstructorParameters<typeof UnifiedBody>[0]) as unknown as UnifiedBody &
    Rigid2D &
    MotionView<MotionMode>;
}

// ── PointMass3D ──────────────────────────────────────────────────────────

interface PointMass3DDynamicOpts extends DynamicCommonOpts {
  z?: number;
  zVelocity?: number;
  zDamping?: number;
  zMass?: number;
}
interface PointMass3DKinematicOpts extends KinematicCommonOpts {
  z?: number;
  zVelocity?: number;
}
interface PointMass3DStaticOpts extends StaticCommonOpts {
  z?: number;
}

export type PointMass3DOptions<M extends MotionMode = MotionMode> =
  M extends "dynamic"
    ? PointMass3DDynamicOpts
    : M extends "kinematic"
      ? PointMass3DKinematicOpts
      : PointMass3DStaticOpts;

export function createPointMass3D(
  opts: PointMass3DDynamicOpts,
): UnifiedBody & DynamicPointMass3D;
export function createPointMass3D(
  opts: PointMass3DKinematicOpts,
): UnifiedBody & KinematicPointMass3D;
export function createPointMass3D(
  opts: PointMass3DStaticOpts,
): UnifiedBody & StaticPointMass3D;
export function createPointMass3D(
  opts: PointMass3DOptions,
): UnifiedBody & PointMass3D & MotionView<MotionMode> {
  return new UnifiedBody({
    shape: "pm3d",
    ...opts,
  } as ConstructorParameters<typeof UnifiedBody>[0]) as unknown as UnifiedBody &
    PointMass3D &
    MotionView<MotionMode>;
}

// ── Rigid3D ──────────────────────────────────────────────────────────────

interface Rigid3DDynamicOpts extends DynamicCommonOpts {
  angle?: number;
  angularVelocity?: number;
  angularDamping?: number;
  z?: number;
  zVelocity?: number;
  zDamping?: number;
  rollPitchDamping?: number;
  rollInertia?: number;
  pitchInertia?: number;
  zMass?: number;
}
interface Rigid3DKinematicOpts extends KinematicCommonOpts {
  angle?: number;
  angularVelocity?: number;
  z?: number;
  zVelocity?: number;
}
interface Rigid3DStaticOpts extends StaticCommonOpts {
  angle?: number;
  z?: number;
}

export type Rigid3DOptions<M extends MotionMode = MotionMode> =
  M extends "dynamic"
    ? Rigid3DDynamicOpts
    : M extends "kinematic"
      ? Rigid3DKinematicOpts
      : Rigid3DStaticOpts;

export function createRigid3D(
  opts: Rigid3DDynamicOpts,
): UnifiedBody & DynamicRigid3D;
export function createRigid3D(
  opts: Rigid3DKinematicOpts,
): UnifiedBody & KinematicRigid3D;
export function createRigid3D(
  opts: Rigid3DStaticOpts,
): UnifiedBody & StaticRigid3D;
export function createRigid3D(
  opts: Rigid3DOptions,
): UnifiedBody & Rigid3D & MotionView<MotionMode> {
  return new UnifiedBody({
    shape: "rigid3d",
    ...opts,
  } as ConstructorParameters<typeof UnifiedBody>[0]) as unknown as UnifiedBody &
    Rigid3D &
    MotionView<MotionMode>;
}

// ─────────────────────────────────────────────────────────────────────────
// Convenience aliases for callers that prefer the combined type names
// ─────────────────────────────────────────────────────────────────────────

export type {
  DynamicPointMass2D,
  DynamicPointMass3D,
  DynamicRigid2D,
  DynamicRigid3D,
  KinematicPointMass2D,
  KinematicPointMass3D,
  KinematicRigid2D,
  KinematicRigid3D,
  StaticPointMass2D,
  StaticPointMass3D,
  StaticRigid2D,
  StaticRigid3D,
};
