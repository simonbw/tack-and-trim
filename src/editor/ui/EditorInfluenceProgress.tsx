/**
 * Progress indicator for influence field computation.
 *
 * Shows a simple percentage while influence fields are being computed.
 */

import { InfluenceFieldManager } from "../../game/world-data/influence/InfluenceFieldManager";

export interface EditorInfluenceProgressProps {
  manager: InfluenceFieldManager;
}

export function EditorInfluenceProgress({
  manager,
}: EditorInfluenceProgressProps) {
  const progress = manager.getProgress();
  const pct = Math.round(progress.wind * 100);

  return (
    <div class="editor-influence-progress">
      <span>Computing: {pct}%</span>
    </div>
  );
}
