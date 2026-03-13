import { isStatsProvider, type StatsSection } from "./StatsProvider";
import { StatsRow } from "./StatsRow";
import type { StatsPanel, StatsPanelContext } from "./StatsPanel";

/** Convert camelCase to Title Case: "waterQuery" → "Water Query" */
function formatCamelCase(key: string): string {
  return key
    .replace(/([A-Z])/g, " $1")
    .replace(/^./, (s) => s.toUpperCase())
    .trim();
}

interface GpuSectionGroup {
  prefix: string;
  items: Array<{ key: string; label: string; value: number }>;
  total: number;
}

/** Group GPU sections by prefix (before the dot) and sort by time */
function groupAndSortGpuSections(
  sections: Record<string, number>,
): GpuSectionGroup[] {
  const groups = new Map<string, GpuSectionGroup>();
  const measuredTotals = new Map<string, number>();

  for (const [key, value] of Object.entries(sections)) {
    const dotIndex = key.indexOf(".");
    const prefix = dotIndex >= 0 ? key.substring(0, dotIndex) : key;
    const suffix = dotIndex >= 0 ? key.substring(dotIndex + 1) : "";

    if (!groups.has(prefix)) {
      groups.set(prefix, { prefix, items: [], total: 0 });
    }

    if (suffix === "") {
      // Group-level measurement (e.g. "surface", "query") or standalone section (e.g. "render")
      measuredTotals.set(prefix, value);
    } else {
      groups.get(prefix)!.items.push({ key, label: suffix, value });
    }
  }

  // Compute totals: use measured GPU total when available, otherwise sum items.
  // For standalone sections (measured total, no items), add as a single item.
  for (const group of groups.values()) {
    const measured = measuredTotals.get(group.prefix);
    if (measured !== undefined && group.items.length === 0) {
      // Standalone section (e.g. "render") — show as single item
      group.items.push({
        key: group.prefix,
        label: formatCamelCase(group.prefix),
        value: measured,
      });
      group.total = measured;
    } else if (measured !== undefined) {
      // Group with real GPU measurement spanning all passes
      group.total = measured;
    } else {
      // No group-level measurement — sum individual items
      group.total = group.items.reduce((sum, item) => sum + item.value, 0);
    }
  }

  // Sort groups by total time (high to low)
  const sortedGroups = Array.from(groups.values()).sort(
    (a, b) => b.total - a.total,
  );

  // Sort items within each group by time (high to low)
  for (const group of sortedGroups) {
    group.items.sort((a, b) => b.value - a.value);
  }

  return sortedGroups;
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
                  {gfx.gpuSectionGroups.map((group) => (
                    <div key={group.prefix}>
                      {/* Group header for multi-item groups */}
                      {group.items.length > 1 && (
                        <StatsRow
                          label={formatCamelCase(group.prefix)}
                          value={`${group.total.toFixed(2)}ms`}
                          indent={1}
                          color="muted"
                        />
                      )}
                      {/* Items within group */}
                      {group.items.map((item) => (
                        <StatsRow
                          key={item.key}
                          label={
                            group.items.length > 1
                              ? `.${item.label}`
                              : formatCamelCase(item.key)
                          }
                          value={`${item.value.toFixed(2)}ms`}
                          indent={group.items.length > 1 ? 2 : 1}
                          color="muted"
                        />
                      ))}
                    </div>
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
    gpuSectionGroups: gpuAllMs ? groupAndSortGpuSections(gpuAllMs) : [],
  };
}

function getCustomSections(ctx: StatsPanelContext): StatsSection[] {
  const sections: StatsSection[] = [];

  for (const entity of ctx.game.entities.getTagged("statsProvider")) {
    if (isStatsProvider(entity)) {
      const section = entity.getStatsSection();
      if (section) {
        sections.push(section);
      }
      entity.resetStatsCounters?.();
    }
  }

  return sections;
}
