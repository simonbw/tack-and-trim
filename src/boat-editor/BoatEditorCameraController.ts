/**
 * Turntable-style orbit camera for the boat editor.
 *
 * Three DOF: yaw (unbounded, rotates around world-up), pitch (clamped
 * between near-top-down and near-side-view so "up" always stays up),
 * and zoom. No roll — the camera keeps world Z pointing upward on
 * screen at every orientation.
 *
 * - Left drag: orbit
 * - Middle drag / Space+drag: pan
 * - Scroll / +/−: zoom
 * - WASD: orbit (W arcs higher over the boat, S drops toward horizon)
 */

import { BaseEntity } from "../core/entity/BaseEntity";
import type { GameEventMap } from "../core/entity/Entity";
import { on } from "../core/entity/handler";
import { clamp, lerp } from "../core/util/MathUtil";

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 20;
const ORBIT_SENSITIVITY = 0.008;
const PAN_SENSITIVITY = 1.0;
const ZOOM_FACTOR = 1.08;
/** Keyboard orbit rate (rad/s). */
const KEY_ORBIT_SPEED = 1.5;
/** Keyboard zoom rate (factor/s: zoom multiplies by this^dt). */
const KEY_ZOOM_SPEED = 3.0;
/** Pitch ∈ [0, π/2 − ε]. 0 is straight down; π/2 is a side view. */
const PITCH_EPS = 0.01;
const PITCH_MIN = 0;
const PITCH_MAX = Math.PI / 2 - PITCH_EPS;

const ORBIT_ZOOM_KEYS = new Set([
  "KeyA",
  "KeyD",
  "KeyW",
  "KeyS",
  "Equal",
  "Minus",
  "NumpadAdd",
  "NumpadSubtract",
]);

export class BoatEditorCameraController extends BaseEntity {
  /** Orbit around world-up. Unbounded. */
  yaw = 0;
  /** Tilt from top-down (0) toward port (+π/2) or starboard (−π/2). */
  pitch = 0;

  private targetZoom = 6;
  private isPanning = false;
  private isOrbiting = false;
  private lastMouse = { x: 0, y: 0 };
  private spaceDown = false;
  private heldKeys = new Set<string>();

  @on("add")
  onAdd() {
    this.game!.camera.z = this.targetZoom;

    const canvas = this.game!.renderer.canvas;
    canvas.addEventListener("mousedown", this.handleMouseDown);
    canvas.addEventListener("wheel", this.handleWheel, { passive: false });
    window.addEventListener("mousemove", this.handleMouseMove);
    window.addEventListener("mouseup", this.handleMouseUp);
    window.addEventListener("keydown", this.handleKeyDown);
    window.addEventListener("keyup", this.handleKeyUp);
  }

  @on("destroy")
  onDestroy({ game }: GameEventMap["destroy"]) {
    const canvas = game.renderer.canvas;
    canvas.removeEventListener("mousedown", this.handleMouseDown);
    canvas.removeEventListener("wheel", this.handleWheel);
    window.removeEventListener("mousemove", this.handleMouseMove);
    window.removeEventListener("mouseup", this.handleMouseUp);
    window.removeEventListener("keydown", this.handleKeyDown);
    window.removeEventListener("keyup", this.handleKeyUp);
  }

  @on("tick")
  onTick({ dt }: GameEventMap["tick"]) {
    const keys = this.heldKeys;
    const orbit = KEY_ORBIT_SPEED * dt;
    if (keys.has("KeyA")) this.yaw -= orbit;
    if (keys.has("KeyD")) this.yaw += orbit;
    // S orbits toward one side (default: port), W toward the other.
    if (keys.has("KeyW")) this.pitch -= orbit;
    if (keys.has("KeyS")) this.pitch += orbit;
    const zoomStep = Math.pow(KEY_ZOOM_SPEED, dt);
    if (keys.has("Equal") || keys.has("NumpadAdd")) {
      this.targetZoom = Math.min(this.targetZoom * zoomStep, MAX_ZOOM);
    }
    if (keys.has("Minus") || keys.has("NumpadSubtract")) {
      this.targetZoom = Math.max(this.targetZoom / zoomStep, MIN_ZOOM);
    }
    this.pitch = clamp(this.pitch, PITCH_MIN, PITCH_MAX);

    const cam = this.game!.camera;
    cam.z = lerp(cam.z, this.targetZoom, 0.15);
  }

  setPreset(name: "top" | "side" | "bow" | "quarter") {
    switch (name) {
      case "top":
        this.yaw = 0;
        this.pitch = 0;
        break;
      case "side":
        this.yaw = 0;
        this.pitch = Math.PI * 0.4;
        break;
      case "bow":
        this.yaw = Math.PI * 0.5;
        this.pitch = Math.PI * 0.25;
        break;
      case "quarter":
        this.yaw = Math.PI * 0.15;
        this.pitch = 0.5;
        break;
    }
  }

  private handleMouseDown = (e: MouseEvent) => {
    this.lastMouse = { x: e.clientX, y: e.clientY };

    if (e.button === 1 || (e.button === 0 && this.spaceDown)) {
      this.isPanning = true;
      e.preventDefault();
    } else if (e.button === 0) {
      this.isOrbiting = true;
      e.preventDefault();
    }
  };

  private handleMouseMove = (e: MouseEvent) => {
    const dx = e.clientX - this.lastMouse.x;
    const dy = e.clientY - this.lastMouse.y;
    this.lastMouse = { x: e.clientX, y: e.clientY };

    if (this.isOrbiting) {
      this.yaw += dx * ORBIT_SENSITIVITY;
      // Drag down → pitch increases (toward horizon). Matches drag-sky-
      // down-to-horizon mental model of a turntable camera.
      this.pitch = clamp(
        this.pitch + dy * ORBIT_SENSITIVITY,
        PITCH_MIN,
        PITCH_MAX,
      );
    } else if (this.isPanning) {
      const cam = this.game!.camera;
      const scale = PAN_SENSITIVITY / cam.z;
      cam.setPosition(
        cam.position[0] - dx * scale,
        cam.position[1] - dy * scale,
      );
    }
  };

  private handleMouseUp = (e: MouseEvent) => {
    if (e.button === 0) {
      this.isOrbiting = false;
      this.isPanning = false;
    }
    if (e.button === 1) {
      this.isPanning = false;
    }
  };

  private handleWheel = (e: WheelEvent) => {
    e.preventDefault();
    if (e.deltaY < 0) {
      this.targetZoom = Math.min(this.targetZoom * ZOOM_FACTOR, MAX_ZOOM);
    } else {
      this.targetZoom = Math.max(this.targetZoom / ZOOM_FACTOR, MIN_ZOOM);
    }
  };

  private handleKeyDown = (e: KeyboardEvent) => {
    if (e.code === "Space") this.spaceDown = true;
    // Don't steal keys while the user is editing a form field.
    const target = e.target as HTMLElement | null;
    if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
    if (ORBIT_ZOOM_KEYS.has(e.code)) {
      this.heldKeys.add(e.code);
      e.preventDefault();
    }
  };

  private handleKeyUp = (e: KeyboardEvent) => {
    if (e.code === "Space") this.spaceDown = false;
    this.heldKeys.delete(e.code);
  };
}
