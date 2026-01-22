import { ReadonlyV2d, V, V2d } from "../Vector";
import { BaseEntity } from "../entity/BaseEntity";
import Entity from "../entity/Entity";
import { on } from "../entity/handler";
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
  private _position: V2d;
  private _z: number;
  private _angle: number;
  velocity: V2d;

  paralaxScale = 0.1;

  // Cache for getWorldViewport (set to null to invalidate)
  private _cachedViewport: Viewport | null = null;
  // Cache for viewport dimensions (to detect external resize)
  private _lastViewportWidth: number = 0;
  private _lastViewportHeight: number = 0;
  // Cache for getMatrix with default parallax [1,1] and anchor [0,0]
  private _cachedMatrix: Matrix3 | null = null;

  constructor(
    viewportProvider: ViewportProvider,
    position: V2d = V([0, 0]),
    z = 25.0,
    angle = 0,
  ) {
    super();
    this.viewportProvider = viewportProvider;
    this._position = position;
    this._z = z;
    this._angle = angle;
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

  /** Invalidate caches (called when camera properties change) */
  private invalidateCache(): void {
    this._cachedViewport = null;
    this._cachedMatrix = null;
  }

  /** Read-only access to position. Use x/y setters or setPosition() to modify. */
  get position(): ReadonlyV2d {
    return this._position;
  }

  get x() {
    return this._position[0];
  }

  set x(value) {
    if (!this.isValidPosition(value)) {
      console.warn("Camera2d: Invalid x position rejected:", value);
      return;
    }
    this._position[0] = value;
    this.invalidateCache();
  }

  get y() {
    return this._position[1];
  }

  set y(value) {
    if (!this.isValidPosition(value)) {
      console.warn("Camera2d: Invalid y position rejected:", value);
      return;
    }
    this._position[1] = value;
    this.invalidateCache();
  }

  get z() {
    return this._z;
  }

  set z(value) {
    if (!this.isValidZoom(value)) {
      console.warn("Camera2d: Invalid zoom rejected:", value);
      return;
    }
    this._z = value;
    this.invalidateCache();
  }

  get angle() {
    return this._angle;
  }

  set angle(value) {
    this._angle = value;
    this.invalidateCache();
  }

  /** Set position directly (invalidates cache) */
  setPosition(x: number, y: number): void {
    if (!this.isValidPosition(x) || !this.isValidPosition(y)) {
      console.warn("Camera2d.setPosition: Invalid position rejected:", x, y);
      return;
    }
    this._position[0] = x;
    this._position[1] = y;
    this.invalidateCache();
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

  getPosition(): V2d {
    return this._position;
  }

  @on("tick")
  onTick(dt: number) {
    this.x += this.vx * dt;
    this.y += this.vy * dt;
  }

  /** Center the camera on a position */
  center([x, y]: V2d) {
    this.setPosition(x, y);
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

    const dt = this.game.averageDt;

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

    // Check if viewport dimensions changed (external resize)
    if (
      viewportWidth !== this._lastViewportWidth ||
      viewportHeight !== this._lastViewportHeight
    ) {
      this._cachedViewport = null;
      this._lastViewportWidth = viewportWidth;
      this._lastViewportHeight = viewportHeight;
    }

    // Return cached viewport if valid
    if (this._cachedViewport) {
      return this._cachedViewport;
    }

    // Compute viewport - normalize so top < bottom (top = minY, bottom = maxY)
    const [left, y1] = this.toWorld(V(0, 0));
    const [right, y2] = this.toWorld(this.getViewportSize());
    const top = Math.min(y1, y2);
    const bottom = Math.max(y1, y2);
    const width = right - left;
    const height = bottom - top;

    // Cache and return
    this._cachedViewport = { top, bottom, left, right, width, height };
    return this._cachedViewport;
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
    // Special case: parallax (0,0) means screen-space rendering (HUD)
    // Flip Y to convert from screen coords (Y-down) to match clip space (Y-up)
    if (px === 0 && py === 0) {
      const h = this.viewportProvider.getHeight();
      const matrix = new Matrix3();
      matrix.identity();
      matrix.translate(0, h);
      matrix.scale(1, -1);
      return matrix;
    }

    const [w, h] = this.getViewportSize();

    // Check if viewport dimensions changed (invalidates matrix cache)
    if (w !== this._lastViewportWidth || h !== this._lastViewportHeight) {
      this._cachedMatrix = null;
      this._lastViewportWidth = w;
      this._lastViewportHeight = h;
    }

    // Use cached matrix for default case (parallax [1,1], anchor [0,0])
    const isDefaultCase = px === 1 && py === 1 && ax === 0 && ay === 0;
    if (isDefaultCase && this._cachedMatrix) {
      return this._cachedMatrix;
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
    // 7. Y-flip (convert from Y-up world to Y-down screen)
    // 8. Center on screen (last applied to point)

    // Center on screen (applied last to point)
    matrix.translate(w / 2.0, h / 2.0);
    // Y-flip for screen coordinates (Y increases downward on screen)
    matrix.scale(1, -1);
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

    // Cache for default case
    if (isDefaultCase) {
      this._cachedMatrix = matrix;
    }

    return matrix;
  }

  /**
   * Check if a circle at (x, y) with given radius is visible in the viewport.
   * Uses cached viewport bounds - no allocations.
   * Useful for culling objects before rendering.
   */
  isVisible(x: number, y: number, radius: number): boolean {
    const v = this.getWorldViewport();
    return (
      x + radius >= v.left &&
      x - radius <= v.right &&
      y + radius >= v.top &&
      y - radius <= v.bottom
    );
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
