/**
 * Status bar component for the terrain editor.
 *
 * Displays mouse coordinates (world units) and terrain height at the bottom-right.
 */

import "./EditorStyles.css";

export interface StatusBarProps {
  x: number;
  y: number;
  height: number;
}

export function StatusBar({ x, y, height }: StatusBarProps) {
  const isUnderwater = height < 0;
  const heightLabel = isUnderwater ? "Depth" : "Height";
  const heightValue = Math.abs(height).toFixed(1);

  return (
    <div class="editor-status-bar">
      <span class="status-bar-item">
        <span class="status-bar-label">X</span>
        <span class="status-bar-value">{x.toFixed(1)}</span>
      </span>
      <span class="status-bar-item">
        <span class="status-bar-label">Y</span>
        <span class="status-bar-value">{y.toFixed(1)}</span>
      </span>
      <span class="status-bar-item">
        <span
          class={`status-bar-label ${isUnderwater ? "underwater" : "above-water"}`}
        >
          {heightLabel}
        </span>
        <span
          class={`status-bar-value ${isUnderwater ? "underwater" : "above-water"}`}
        >
          {heightValue} ft
        </span>
      </span>
    </div>
  );
}
