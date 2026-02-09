/**
 * Wavefront Mesh debug mode.
 *
 * Visualizes the wavefront marching mesh for wave-terrain interaction.
 * Draws wavefront lines colored by amplitude factor, with direction
 * arrows and terminated vertex markers.
 *
 * Use [ and ] to cycle through wave sources.
 */

import type { GameEventMap } from "../../../core/entity/Entity";
import { on } from "../../../core/entity/handler";
import { WavePhysicsResources } from "../../wave-physics/WavePhysicsResources";
import { WaterResources } from "../../world/water/WaterResources";
import { VERTEX_FLOATS } from "../../wave-physics/WavefrontMesh";
import { DebugRenderMode } from "./DebugRenderMode";

// Dim overlay
const DIM_COLOR = 0x000000;
const DIM_ALPHA = 0.4;

// Draw every Nth wavefront step
const STEP_SKIP = 4;

// Draw direction arrows every Nth vertex
const ARROW_VERTEX_SKIP = 8;
const ARROW_LENGTH = 8;
const ARROW_COLOR = 0xffffff;
const ARROW_ALPHA = 0.6;

// Terminated vertex markers
const TERMINATED_COLOR = 0xff0000;
const TERMINATED_RADIUS = 2;

// Wavefront line settings
const LINE_ALPHA = 0.9;
const LINE_WIDTH = 1.5;

/** Map amplitude factor [0, 1+] to a color */
function amplitudeToColor(amp: number): number {
  if (amp <= 0.0) return 0xff0000; // red - blocked
  if (amp <= 0.5) {
    // red -> yellow
    const t = amp / 0.5;
    const r = 0xff;
    const g = Math.round(0xff * t);
    return (r << 16) | (g << 8);
  }
  if (amp <= 1.0) {
    // yellow -> green
    const t = (amp - 0.5) / 0.5;
    const r = Math.round(0xff * (1 - t));
    const g = 0xff;
    return (r << 16) | (g << 8);
  }
  // green -> cyan (convergence > 1.0)
  const t = Math.min((amp - 1.0) / 0.5, 1.0);
  const g = 0xff;
  const b = Math.round(0xff * t);
  return (g << 8) | b;
}

export class WavefrontMeshDebugMode extends DebugRenderMode {
  layer = "windViz" as const;
  private selectedWaveIndex = -1; // -1 = show all

  @on("render")
  onRender({ draw }: GameEventMap["render"]): void {
    const wavePhysicsResources =
      this.game.entities.tryGetSingleton(WavePhysicsResources);
    const wavePhysicsManager = wavePhysicsResources?.getWavePhysicsManager();

    if (!wavePhysicsManager || !wavePhysicsManager.isInitialized()) return;

    // Draw dim overlay
    const viewport = this.game.camera.getWorldViewport();
    draw.fillRect(
      viewport.left,
      viewport.top,
      viewport.width,
      viewport.height,
      { color: DIM_COLOR, alpha: DIM_ALPHA },
    );

    const meshes = wavePhysicsManager.getMeshes();

    for (let w = 0; w < meshes.length; w++) {
      if (this.selectedWaveIndex >= 0 && this.selectedWaveIndex !== w) continue;

      const mesh = meshes[w];
      const data = mesh.cpuVertexData;
      const vc = mesh.vertexCount;
      const ns = mesh.numSteps;

      // Draw wavefront lines (every Nth step)
      for (let step = 0; step < ns; step += STEP_SKIP) {
        const stepBase = step * vc * VERTEX_FLOATS;

        for (let v = 0; v < vc - 1; v++) {
          const i0 = stepBase + v * VERTEX_FLOATS;
          const i1 = stepBase + (v + 1) * VERTEX_FLOATS;

          const x0 = data[i0 + 0];
          const y0 = data[i0 + 1];
          const amp0 = data[i0 + 2];
          const x1 = data[i1 + 0];
          const y1 = data[i1 + 1];
          const amp1 = data[i1 + 2];

          // Skip if both vertices are terminated
          if (amp0 <= 0 && amp1 <= 0) continue;

          const avgAmp = (amp0 + amp1) / 2;
          const color = amplitudeToColor(avgAmp);

          draw.line(x0, y0, x1, y1, {
            color,
            alpha: LINE_ALPHA,
            width: LINE_WIDTH,
          });
        }
      }

      // Draw terminated vertices and direction arrows
      for (let step = 0; step < ns; step += STEP_SKIP) {
        const stepBase = step * vc * VERTEX_FLOATS;

        for (let v = 0; v < vc; v++) {
          const idx = stepBase + v * VERTEX_FLOATS;
          const x = data[idx + 0];
          const y = data[idx + 1];
          const amp = data[idx + 2];
          const dirOffset = data[idx + 3];

          if (amp <= 0) {
            // Terminated vertex marker
            draw.fillCircle(x, y, TERMINATED_RADIUS, {
              color: TERMINATED_COLOR,
              alpha: 0.8,
            });
          } else if (v % ARROW_VERTEX_SKIP === 0) {
            // Direction arrow
            const baseAngle = Math.atan2(mesh.waveDirY, mesh.waveDirX);
            const angle = baseAngle + dirOffset;
            const dx = Math.cos(angle) * ARROW_LENGTH;
            const dy = Math.sin(angle) * ARROW_LENGTH;
            draw.line(x, y, x + dx, y + dy, {
              color: ARROW_COLOR,
              alpha: ARROW_ALPHA,
              width: 1,
            });
          }
        }
      }
    }
  }

  @on("keyDown")
  onKeyDown({ key }: GameEventMap["keyDown"]): void {
    const waterResources = this.game.entities.tryGetSingleton(WaterResources);
    const numWaves = waterResources?.getNumWaves() ?? 1;

    if (key === "BracketLeft") {
      this.selectedWaveIndex =
        this.selectedWaveIndex <= -1
          ? numWaves - 1
          : this.selectedWaveIndex - 1;
    } else if (key === "BracketRight") {
      this.selectedWaveIndex =
        this.selectedWaveIndex >= numWaves - 1
          ? -1
          : this.selectedWaveIndex + 1;
    }
  }

  getModeName(): string {
    return "Wavefront Mesh";
  }

  getHudInfo(): string | null {
    const wavePhysicsResources =
      this.game.entities.tryGetSingleton(WavePhysicsResources);
    const wavePhysicsManager = wavePhysicsResources?.getWavePhysicsManager();
    if (!wavePhysicsManager) return "No wave physics";

    const meshes = wavePhysicsManager.getMeshes();
    if (meshes.length === 0) return "No wavefront meshes";

    if (this.selectedWaveIndex < 0) {
      return `All waves (${meshes.length} meshes) [/] to cycle`;
    }

    const mesh = meshes[this.selectedWaveIndex];
    if (!mesh) return `Wave ${this.selectedWaveIndex}: not found`;

    const dirDeg = (
      (Math.atan2(mesh.waveDirY, mesh.waveDirX) * 180) /
      Math.PI
    ).toFixed(0);
    return (
      `Wave ${this.selectedWaveIndex}: ` +
      `${mesh.vertexCount} verts x ${mesh.numSteps} steps, ` +
      `\u03BB=${mesh.wavelength}ft, dir=${dirDeg}\u00B0`
    );
  }
}
