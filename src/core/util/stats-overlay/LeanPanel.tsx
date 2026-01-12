import React from "react";
import type { StatsPanel } from "./StatsPanel";

/**
 * Creates a minimal FPS display panel.
 */
export function createLeanPanel(): StatsPanel {
  return {
    id: "lean",
    render: (ctx) => (
      <div>
        FPS: {ctx.fps} ({ctx.fps2})
      </div>
    ),
  };
}
