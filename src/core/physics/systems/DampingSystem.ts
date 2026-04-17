import type { UnifiedBody } from "../body/UnifiedBody";

/** Apply linear damping to a 2D point mass. */
export function applyDampingPointMass2D(body: UnifiedBody, dt: number): void {
  const f = Math.pow(1 - body.damping, dt);
  body.velocity.x *= f;
  body.velocity.y *= f;
}

/** Apply linear + yaw damping to a 2D rigid body. */
export function applyDampingRigid2D(body: UnifiedBody, dt: number): void {
  const lf = Math.pow(1 - body.damping, dt);
  body.velocity.x *= lf;
  body.velocity.y *= lf;
  body.angularVelocity3[2] *= Math.pow(1 - body.angularDamping, dt);
}

/** Apply linear + z damping to a 3D point mass. */
export function applyDampingPointMass3D(body: UnifiedBody, dt: number): void {
  const lf = Math.pow(1 - body.damping, dt);
  body.velocity.x *= lf;
  body.velocity.y *= lf;
  body.zVelocity *= Math.pow(1 - body.zDamping, dt);
}

/** Apply linear + z + roll/pitch/yaw damping to a 3D rigid body. */
export function applyDampingRigid3D(body: UnifiedBody, dt: number): void {
  const lf = Math.pow(1 - body.damping, dt);
  body.velocity.x *= lf;
  body.velocity.y *= lf;
  body.zVelocity *= Math.pow(1 - body.zDamping, dt);

  const rpDamp = Math.pow(1 - body.rollPitchDamping, dt);
  body.angularVelocity3[0] *= rpDamp;
  body.angularVelocity3[1] *= rpDamp;
  body.angularVelocity3[2] *= Math.pow(1 - body.angularDamping, dt);
}

/**
 * Top-level driver. Iterate an arbitrary bag of bodies and dispatch damping
 * by shape. Filters to dynamic bodies; static and kinematic bodies never
 * damp.
 */
export function applyDamping(bodies: Iterable<UnifiedBody>, dt: number): void {
  for (const body of bodies) {
    if (body.motion !== "dynamic") continue;
    switch (body.shape) {
      case "pm2d":
        applyDampingPointMass2D(body, dt);
        break;
      case "rigid2d":
        applyDampingRigid2D(body, dt);
        break;
      case "pm3d":
        applyDampingPointMass3D(body, dt);
        break;
      case "rigid3d":
        applyDampingRigid3D(body, dt);
        break;
    }
  }
}
