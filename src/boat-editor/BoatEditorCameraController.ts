/**
 * Orbit-style camera for the boat editor.
 *
 * Uses the game's tilt projection to simulate 3D orbiting:
 * - Left drag: orbit (adjust yaw and pitch)
 * - Middle drag / Space+drag: pan
 * - Scroll: zoom
 * - Preset buttons can animate to specific angles.
 */

import { BaseEntity } from "../core/entity/BaseEntity";
import { on } from "../core/entity/handler";
import { clamp, lerp } from "../core/util/MathUtil";

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 20;
const ORBIT_SENSITIVITY = 0.008;
const PAN_SENSITIVITY = 1.0;
const ZOOM_FACTOR = 1.08;

export class BoatEditorCameraController extends BaseEntity {
  /** Current orbit angles (yaw = heading, pitch = elevation). */
  yaw = Math.PI * 0.15;
  pitch = 0.6;

  private targetZoom = 6;
  private isPanning = false;
  private isOrbiting = false;
  private lastMouse = { x: 0, y: 0 };
  private spaceDown = false;

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
  onDestroy() {
    const canvas = this.game!.renderer.canvas;
    canvas.removeEventListener("mousedown", this.handleMouseDown);
    canvas.removeEventListener("wheel", this.handleWheel);
    window.removeEventListener("mousemove", this.handleMouseMove);
    window.removeEventListener("mouseup", this.handleMouseUp);
    window.removeEventListener("keydown", this.handleKeyDown);
    window.removeEventListener("keyup", this.handleKeyUp);
  }

  @on("tick")
  onTick() {
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
        this.pitch = 0.6;
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
      this.pitch = clamp(
        this.pitch - dy * ORBIT_SENSITIVITY,
        0,
        Math.PI * 0.48,
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
  };

  private handleKeyUp = (e: KeyboardEvent) => {
    if (e.code === "Space") this.spaceDown = false;
  };
}
