import type { StatsProvider, StatsSection } from "./StatsProvider";
import { StatsRow } from "./StatsRow";
import type { StatsPanel, StatsPanelContext } from "./StatsPanel";

/** Convert camelCase GPU section names to Title Case labels */
function formatGpuSectionName(key: string): string {
  return key
    .replace(/([A-Z])/g, " $1")
    .replace(/^./, (s) => s.toUpperCase())
    .trim();
}

/**
 * Creates a graphics panel with GPU timing and draw call stats.
 * Also displays custom sections from StatsProvider entities.
 */
export function createGraphicsPanel(): StatsPanel {
  return {
    id: "graphics",

    render: (ctx) => {
      const gfx = getGraphicsStats(ctx);
      const customSections = getCustomSections(ctx);

      // Determine GPU time color
      const gpuColor = gfx.gpuAvgMs > 8.33 ? "error" : undefined;
      const gpuPercent = ((gfx.gpuAvgMs / 8.33) * 100).toFixed(0);

      return (
        <>
          <div className="stats-overlay__section">
            <div className="stats-overlay__section-title">Graphics</div>

            <div className="stats-overlay__grid">
              {/* GPU Timing */}
              {gfx.gpuTimerSupported ? (
                <>
                  <StatsRow
                    label="GPU Time"
                    value={`${gfx.gpuAvgMs.toFixed(2)}ms (${gpuPercent}%)`}
                    color={gpuColor}
                  />
                  {gfx.gpuSections &&
                    Object.entries(gfx.gpuSections).map(([key, value]) => (
                      <StatsRow
                        key={key}
                        label={formatGpuSectionName(key)}
                        value={`${value.toFixed(2)}ms`}
                        indent
                        color="muted"
                      />
                    ))}
                </>
              ) : (
                <StatsRow label="GPU Time" value="not supported" color="dim" />
              )}

              {/* Draw stats */}
              <StatsRow
                label="Draw Calls"
                value={gfx.drawCalls.toLocaleString()}
              />
              <StatsRow
                label="Triangles"
                value={gfx.triangles.toLocaleString()}
              />
              <StatsRow
                label="Vertices"
                value={gfx.vertices.toLocaleString()}
              />

              {/* Resources */}
              <div className="stats-overlay__divider">
                <StatsRow label="Textures" value={gfx.textures} />
                <StatsRow
                  label="Resolution"
                  value={`${gfx.resolution} @${gfx.pixelRatio}x`}
                />
              </div>
            </div>
          </div>

          {/* Custom sections from StatsProviders */}
          {customSections.map((section, i) => (
            <div key={i} className="stats-overlay__section">
              <div className="stats-overlay__section-title">
                {section.title}
              </div>
              <div className="stats-overlay__grid">
                {section.items.map((item, j) => (
                  <StatsRow
                    key={j}
                    label={item.label}
                    value={item.value}
                    color={item.color}
                    indent={item.indent}
                  />
                ))}
              </div>
            </div>
          ))}
        </>
      );
    },
  };
}

function getGraphicsStats(ctx: StatsPanelContext) {
  const renderer = ctx.game.getRenderer();
  const rendererStats = renderer?.getStats();
  const gpuTimerSupported = ctx.game.hasGpuTimerSupport();
  const gpuMs = ctx.game.renderer.getGpuMs();
  const gpuAllMs = ctx.game.renderer.getAllGpuMs();

  return {
    drawCalls: rendererStats?.drawCalls ?? 0,
    triangles: rendererStats?.triangles ?? 0,
    vertices: rendererStats?.vertices ?? 0,
    textures: rendererStats?.textures ?? 0,
    resolution: rendererStats
      ? `${rendererStats.canvasWidth}x${rendererStats.canvasHeight}`
      : "N/A",
    pixelRatio: rendererStats?.pixelRatio ?? 1,
    gpuTimerSupported,
    gpuAvgMs: gpuMs,
    gpuSections: gpuAllMs,
  };
}

function getCustomSections(ctx: StatsPanelContext): StatsSection[] {
  const providers = (ctx.game.entities.getTagged("statsProvider") ??
    []) as unknown as StatsProvider[];
  const sections: StatsSection[] = [];

  for (const provider of providers) {
    const section = provider.getStatsSection?.();
    if (section) {
      sections.push(section);
    }
    provider.resetStatsCounters?.();
  }

  return sections;
}
