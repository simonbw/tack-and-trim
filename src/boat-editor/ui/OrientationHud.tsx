/**
 * Corner overlay that shows the current orbit orientation (yaw/pitch/roll)
 * in degrees, plus the key bindings, so it's obvious what's being
 * controlled and what the current state is.
 */

import { useEffect, useState } from "preact/hooks";
import type { BoatEditorCameraController } from "../BoatEditorCameraController";

export interface OrientationHudProps {
  camera: BoatEditorCameraController;
}

export function OrientationHud({ camera }: OrientationHudProps) {
  const [, tick] = useState(0);

  useEffect(() => {
    let raf = 0;
    const loop = () => {
      tick((n) => (n + 1) & 0xffff);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  const fmt = (rad: number) => `${((rad * 180) / Math.PI).toFixed(1)}°`;

  return (
    <div class="orientation-hud">
      <div class="orientation-hud-row">
        <span class="orientation-hud-label">Yaw</span>
        <span class="orientation-hud-value">{fmt(camera.yaw)}</span>
        <span class="orientation-hud-keys">A D</span>
      </div>
      <div class="orientation-hud-row">
        <span class="orientation-hud-label">Pitch</span>
        <span class="orientation-hud-value">{fmt(camera.pitch)}</span>
        <span class="orientation-hud-keys">W S</span>
      </div>
      <div class="orientation-hud-row">
        <span class="orientation-hud-label">Roll</span>
        <span class="orientation-hud-value">{fmt(camera.roll)}</span>
        <span class="orientation-hud-keys">Q E</span>
      </div>
      <div class="orientation-hud-row">
        <span class="orientation-hud-label">Zoom</span>
        <span class="orientation-hud-keys">+ −</span>
      </div>
      <button
        class="orientation-hud-reset"
        onClick={() => {
          camera.yaw = 0;
          camera.pitch = 0;
          camera.roll = 0;
        }}
      >
        Reset
      </button>
    </div>
  );
}
