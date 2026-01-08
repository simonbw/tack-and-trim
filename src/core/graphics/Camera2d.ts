import { V, V2d } from "../Vector";
import BaseEntity from "../entity/BaseEntity";
import Entity from "../entity/Entity";
import { lerpOrSnap } from "../util/MathUtil";
import { Matrix3 } from "./Matrix3";

// Bounds for camera position/velocity validation
const MAX_CAMERA_POSITION = 100000;
const MAX_CAMERA_VELOCITY = 10000;
const MAX_CAMERA_ZOOM = 1000;

export interface Viewport {
  readonly top: number;
  readonly bottom: number;
  readonly left: number;
  readonly right: number;
  readonly width: number;
  readonly height: number;
}

/** Interface for getting viewport dimensions */
export interface ViewportProvider {
  getWidth(): number;
  getHeight(): number;
}

/** Controls the viewport.
 * Uses Matrix3 for transforms instead of Pixi.Matrix.
 */
export class Camera2d extends BaseEntity implements Entity {
  tags = ["camera"];
  persistenceLevel = 100;

  viewportProvider: ViewportProvider;
  position: V2d;
  z: number;
  angle: number;
  velocity: V2d;

  paralaxScale = 0.1;

  // Cache for getWorldViewport
  private _cachedViewport: Viewport | null = null;
  private _viewportCacheInputs: {
    x: number;
    y: number;
    z: number;
    angle: number;
    viewportWidth: number;
    viewportHeight: number;
  } | null = null;

  constructor(
    viewportProvider: ViewportProvider,
    position: V2d = V([0, 0]),
    z = 25.0,
    angle = 0,
  ) {
    super();
    this.viewportProvider = viewportProvider;
    this.position = position;
    this.z = z;
    this.angle = angle;
    this.velocity = V([0, 0]);
  }

  /** Check if a value is valid (finite and within bounds) */
  private isValidPosition(value: number): boolean {
    return isFinite(value) && Math.abs(value) <= MAX_CAMERA_POSITION;
  }

  private isValidVelocity(value: number): boolean {
    return isFinite(value) && Math.abs(value) <= MAX_CAMERA_VELOCITY;
  }

  private isValidZoom(value: number): boolean {
    return isFinite(value) && value > 0 && value <= MAX_CAMERA_ZOOM;
  }

  get x() {
    return this.position[0];
  }

  set x(value) {
    if (!this.isValidPosition(value)) {
      console.warn("Camera2d: Invalid x position rejected:", value);
      return;
    }
    this.position[0] = value;
  }

  get y() {
    return this.position[1];
  }

  set y(value) {
    if (!this.isValidPosition(value)) {
      console.warn("Camera2d: Invalid y position rejected:", value);
      return;
    }
    this.position[1] = value;
  }

  get vx() {
    return this.velocity[0];
  }

  set vx(value) {
    if (!this.isValidVelocity(value)) {
      console.warn("Camera2d: Invalid vx velocity rejected:", value);
      return;
    }
    this.velocity[0] = value;
  }

  get vy() {
    return this.velocity[1];
  }

  set vy(value) {
    if (!this.isValidVelocity(value)) {
      console.warn("Camera2d: Invalid vy velocity rejected:", value);
      return;
    }
    this.velocity[1] = value;
  }

  getPosition() {
    return this.position;
  }

  onTick(dt: number) {
    this.x += this.vx * dt;
    this.y += this.vy * dt;
  }

  /** Center the camera on a position */
  center([x, y]: V2d) {
    if (!this.isValidPosition(x) || !this.isValidPosition(y)) {
      console.warn("Camera2d.center: Invalid position rejected:", x, y);
      return;
    }
    this.position[0] = x;
    this.position[1] = y;
  }

  /** Move the camera toward being centered on a position, with a target velocity */
  smoothCenter(
    [x, y]: V2d,
    [vx, vy]: V2d = V([0, 0]),
    stiffness: number = 1.0,
    damping: number = 1.0,
  ) {
    if (!this.isValidPosition(x) || !this.isValidPosition(y)) {
      console.warn("Camera2d.smoothCenter: Invalid position rejected:", x, y);
      return;
    }
    if (!this.isValidVelocity(vx) || !this.isValidVelocity(vy)) {
      console.warn("Camera2d.smoothCenter: Invalid velocity rejected:", vx, vy);
      return;
    }

    const dx = x - this.x;
    const dy = y - this.y;

    const dt = this.game!.averageDt;

    this.vx += (stiffness * dx - damping * (this.vx - vx)) * dt;
    this.vy += (stiffness * dy - damping * (this.vy - vy)) * dt;
  }

  smoothSetVelocity([vx, vy]: V2d, stiffness: number = 0.9) {
    if (!this.isValidVelocity(vx) || !this.isValidVelocity(vy)) {
      console.warn(
        "Camera2d.smoothSetVelocity: Invalid velocity rejected:",
        vx,
        vy,
      );
      return;
    }
    this.vx = lerpOrSnap(this.vx, vx, stiffness, 0.001);
    this.vy = lerpOrSnap(this.vy, vy, stiffness, 0.001);
  }

  /** Move the camera part of the way to the desired zoom. */
  smoothZoom(z: number, smooth: number = 0.9) {
    if (!this.isValidZoom(z)) {
      console.warn("Camera2d.smoothZoom: Invalid zoom rejected:", z);
      return;
    }
    this.z = smooth * this.z + (1 - smooth) * z;
  }

  /** Returns [width, height] of the viewport in pixels */
  getViewportSize(): V2d {
    return V(
      this.viewportProvider.getWidth(),
      this.viewportProvider.getHeight(),
    );
  }

  /**
   * Calculates the world coordinate bounds of the current camera viewport.
   * Useful for culling, bounds checking, and viewport-relative positioning.
   * Results are cached and only recomputed when camera or viewport changes.
   */
  getWorldViewport(): Viewport {
    const viewportWidth = this.viewportProvider.getWidth();
    const viewportHeight = this.viewportProvider.getHeight();

    // Check if cache is valid
    if (
      this._cachedViewport &&
      this._viewportCacheInputs &&
      this._viewportCacheInputs.x === this.x &&
      this._viewportCacheInputs.y === this.y &&
      this._viewportCacheInputs.z === this.z &&
      this._viewportCacheInputs.angle === this.angle &&
      this._viewportCacheInputs.viewportWidth === viewportWidth &&
      this._viewportCacheInputs.viewportHeight === viewportHeight
    ) {
      return this._cachedViewport;
    }

    // Compute viewport
    const [left, top] = this.toWorld(V(0, 0));
    const [right, bottom] = this.toWorld(this.getViewportSize());
    const width = right - left;
    const height = bottom - top;
    const viewport = { top, bottom, left, right, width, height };

    // Cache the result
    this._cachedViewport = viewport;
    this._viewportCacheInputs = {
      x: this.x,
      y: this.y,
      z: this.z,
      angle: this.angle,
      viewportWidth,
      viewportHeight,
    };

    return viewport;
  }

  /** Convert screen coordinates to world coordinates */
  toWorld([x, y]: V2d, parallax = V(1.0, 1.0)): V2d {
    const matrix = this.getMatrix(parallax);
    return matrix.applyInverse(V(x, y));
  }

  /** Convert world coordinates to screen coordinates */
  toScreen([x, y]: V2d, parallax = V(1.0, 1.0)): V2d {
    const matrix = this.getMatrix(parallax);
    return matrix.apply(V(x, y));
  }

  /** Creates a transformation matrix to go from world space to screen space. */
  getMatrix(
    [px, py]: [number, number] = [1, 1],
    [ax, ay]: V2d = V(0, 0),
  ): Matrix3 {
    const [w, h] = this.getViewportSize();

    // Special case: parallax (0,0) means screen-space rendering (HUD)
    // Return identity - coordinates are already in screen pixels
    if (px === 0 && py === 0) {
      return new Matrix3().identity();
    }

    const { x: cx, y: cy, z, angle } = this;

    const matrix = new Matrix3();

    // With right-multiplication (this = this * T), operations are applied to
    // points in reverse order from how they're coded. So we code them in
    // reverse order of desired application:
    //
    // Desired application order to point:
    // 1. Align anchor with camera (first applied to point)
    // 2. Move camera to world origin
    // 3. Scale (zoom with parallax)
    // 4. Rotate
    // 5. Restore anchor position
    // 6. Undo parallax scale
    // 7. Center on screen (last applied to point)

    // Center on screen (applied last to point)
    matrix.translate(w / 2.0, h / 2.0);
    // Undo parallax scale
    matrix.scale(1 / px, 1 / py);
    // Restore anchor position
    matrix.translate(-ax * z, -ay * z);
    // Rotate
    matrix.rotate(angle);
    // Scale (zoom with parallax)
    matrix.scale(z * px, z * py);
    // Move camera to world origin
    matrix.translate(-cx * px, -cy * py);
    // Align anchor with camera (applied first to point)
    matrix.translate(ax * px, ay * py);

    return matrix;
  }
}

export function viewportContains(viewport: Viewport, point: V2d): boolean {
  return (
    point.x >= viewport.left &&
    point.x <= viewport.right &&
    point.y >= viewport.top &&
    point.y <= viewport.bottom
  );
}
