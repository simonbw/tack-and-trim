import React from "react";
import Entity, { GameEventMap } from "../entity/Entity";
import SpatialHashingBroadphase from "../physics/collision/broadphase/SpatialHashingBroadphase";
import { ReactEntity } from "../ReactEntity";
import { profiler, ProfileStats } from "./Profiler";

const SMOOTHING = 0.95;
const TOP_N_PROFILES = 100;

const MODES = ["closed", "lean", "physics", "profiler", "graphics"] as const;
type Mode = (typeof MODES)[number];

export default class DebugOverlay extends ReactEntity implements Entity {
  persistenceLevel = 100;
  averageDuration: number = 0;
  slowFrameCount: number = 0;
  lastUpdate = performance.now();

  mode: Mode = "closed";
  profilingEnabled = true;

  constructor() {
    super(() => {
      if (this.mode === "closed") {
        return <></>;
      }

      const stats = this.getStats();
      const profileStats = profiler.getTopStats(TOP_N_PROFILES);

      return (
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            zIndex: 1000,
            fontFamily: "monospace",
            fontSize: "11px",
            color: "white",
            backgroundColor: "rgba(0, 0, 0, 0.1)",
            padding: "8px",
            borderRadius: "4px",
          }}
        >
          {/* Lean mode: just FPS */}
          {this.mode === "lean" && (
            <div>
              FPS: {stats.fps} ({stats.fps2})
            </div>
          )}

          {/* Physics mode: body info */}
          {this.mode === "physics" && (
            <>
              <div
                style={{ display: "flex", gap: "16px", marginBottom: "4px" }}
              >
                <span>
                  FPS: {stats.fps} ({stats.fps2})
                </span>
                <span>Entities: {stats.entityCount}</span>
              </div>
              <div style={{ fontSize: "10px", color: "#aaa" }}>
                Bodies: {stats.bodyCount} ({stats.kinematicBodyCount}K /{" "}
                {stats.particleBodyCount}P / {stats.dynamicBodyCount}D /{" "}
                {stats.hugeBodyCount}H) | Collisions: {stats.collisions}
              </div>
            </>
          )}

          {/* Profiler mode: full profiler display */}
          {this.mode === "profiler" && (
            <>
              <div
                style={{ display: "flex", gap: "16px", marginBottom: "8px" }}
              >
                <span>
                  FPS: {stats.fps} ({stats.fps2})
                </span>
                <span>Entities: {stats.entityCount}</span>
                <span>Bodies: {stats.bodyCount}</span>
              </div>

              <div
                style={{ marginBottom: "8px", fontSize: "10px", color: "#aaa" }}
              >
                Bodies: {stats.kinematicBodyCount}K / {stats.particleBodyCount}P
                / {stats.dynamicBodyCount}D / {stats.hugeBodyCount}H |
                Collisions: {stats.collisions}
              </div>

              <div style={{ borderTop: "1px solid #444", paddingTop: "8px" }}>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    marginBottom: "4px",
                  }}
                >
                  <span style={{ fontWeight: "bold" }}>Profiler</span>
                  <span style={{ fontSize: "10px", color: "#888" }}>
                    [R] Reset | [P] {this.profilingEnabled ? "On" : "Off"}
                  </span>
                </div>

                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr 50px 50px 50px 35px",
                    fontSize: "10px",
                    color: "#888",
                    marginBottom: "2px",
                  }}
                >
                  <span>Label</span>
                  <span style={{ textAlign: "right" }}>Calls/s</span>
                  <span style={{ textAlign: "right" }}>Avg</span>
                  <span style={{ textAlign: "right" }}>Max</span>
                  <span style={{ textAlign: "right" }}>%</span>
                </div>

                {profileStats.map((stat, i) => (
                  <ProfileRow
                    key={stat.label}
                    stat={stat}
                    index={i}
                    allStats={profileStats}
                  />
                ))}

                {profileStats.length === 0 && (
                  <div style={{ color: "#666", fontStyle: "italic" }}>
                    No profile data yet
                  </div>
                )}
              </div>
            </>
          )}

          {/* Graphics mode: rendering stats */}
          {this.mode === "graphics" &&
            (() => {
              const gfx = this.getGraphicsStats();
              return (
                <>
                  <div
                    style={{
                      display: "flex",
                      gap: "16px",
                      marginBottom: "8px",
                    }}
                  >
                    <span>
                      FPS: {stats.fps} ({stats.fps2})
                    </span>
                  </div>

                  <div
                    style={{ borderTop: "1px solid #444", paddingTop: "8px" }}
                  >
                    <div style={{ fontWeight: "bold", marginBottom: "8px" }}>
                      Graphics
                    </div>

                    <div
                      style={{ display: "grid", gap: "4px", fontSize: "11px" }}
                    >
                      {/* GPU Timing */}
                      {gfx.gpuTimerSupported ? (
                        <div
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                          }}
                        >
                          <span style={{ color: "#aaa" }}>GPU Time</span>
                          <span
                            style={{
                              color: gfx.gpuAvgMs > 8.33 ? "#ff6666" : "#fff",
                            }}
                          >
                            {gfx.gpuAvgMs.toFixed(2)}ms (
                            {((gfx.gpuAvgMs / 8.33) * 100).toFixed(0)}%)
                          </span>
                        </div>
                      ) : (
                        <div
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                          }}
                        >
                          <span style={{ color: "#aaa" }}>GPU Time</span>
                          <span style={{ color: "#666" }}>not supported</span>
                        </div>
                      )}

                      {/* Draw stats */}
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                        }}
                      >
                        <span style={{ color: "#aaa" }}>Draw Calls</span>
                        <span>{gfx.drawCalls.toLocaleString()}</span>
                      </div>
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                        }}
                      >
                        <span style={{ color: "#aaa" }}>Triangles</span>
                        <span>{gfx.triangles.toLocaleString()}</span>
                      </div>
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                        }}
                      >
                        <span style={{ color: "#aaa" }}>Vertices</span>
                        <span>{gfx.vertices.toLocaleString()}</span>
                      </div>

                      {/* Resources */}
                      <div
                        style={{
                          borderTop: "1px solid #333",
                          marginTop: "4px",
                          paddingTop: "4px",
                          display: "flex",
                          justifyContent: "space-between",
                        }}
                      >
                        <span style={{ color: "#aaa" }}>Textures</span>
                        <span>{gfx.textures}</span>
                      </div>
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                        }}
                      >
                        <span style={{ color: "#aaa" }}>Resolution</span>
                        <span>
                          {gfx.resolution} @{gfx.pixelRatio}x
                        </span>
                      </div>
                    </div>
                  </div>
                </>
              );
            })()}
        </div>
      );
    });
  }

  private cycleMode(direction: 1 | -1) {
    const currentIndex = MODES.indexOf(this.mode);
    const nextIndex = (currentIndex + direction + MODES.length) % MODES.length;
    this.mode = MODES[nextIndex];
  }

  onAdd() {
    super.onAdd();
    this.averageDuration = 1 / 60;
  }

  onRender(renderData: { dt: number }) {
    const now = performance.now();
    const duration = now - this.lastUpdate;
    this.averageDuration =
      SMOOTHING * this.averageDuration + (1.0 - SMOOTHING) * duration;
    this.lastUpdate = now;

    super.onRender(renderData);
  }

  getStats() {
    const world = this.game?.world;
    const broadphase = this.game?.world.broadphase as SpatialHashingBroadphase;
    return {
      fps: Math.ceil(1000 / this.averageDuration),
      fps2: this.game!.getScreenFps(),
      bodyCount: world?.bodies.length ?? 0,
      hugeBodyCount: broadphase.hugeBodies?.size ?? 0,
      dynamicBodyCount: world?.bodies.dynamic.length ?? 0,
      kinematicBodyCount: world?.bodies.kinematic.length ?? 0,
      particleBodyCount: broadphase.particleBodies.size,
      entityCount: this.game?.entities.all.size ?? 0,
      collisions: (this.game?.world.broadphase as SpatialHashingBroadphase)
        .debugData.numCollisions,
    };
  }

  getGraphicsStats() {
    const renderer = this.game?.getRenderer();
    const rendererStats = renderer?.getStats();
    const gpuTimerSupported = this.game?.hasGpuTimerSupport() ?? false;
    const gpuProfileStat = profiler
      .getStats()
      .find((s) => s.label === "gpu" && s.depth === 0);

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
      gpuAvgMs: gpuProfileStat?.avgMs ?? 0,
    };
  }

  onKeyDown({ key, event }: GameEventMap["keyDown"]) {
    if (key === "Backquote") {
      this.cycleMode(event.shiftKey ? -1 : 1);
    }
    // Only handle these keys when in profiler mode
    if (this.mode === "profiler") {
      if (key === "KeyR") {
        profiler.reset();
      }
      if (key === "KeyP") {
        this.profilingEnabled = !this.profilingEnabled;
        profiler.setEnabled(this.profilingEnabled);
      }
    }
  }
}

const SEPARATOR = " > ";

/** Compute tree prefix using box-drawing characters */
function getTreePrefix(
  stat: ProfileStats,
  index: number,
  allStats: ProfileStats[],
): string {
  if (stat.depth === 0) return "";

  const segments = stat.label.split(SEPARATOR);
  let prefix = "";

  // For each ancestor level, determine if we need a vertical line
  for (let level = 0; level < stat.depth - 1; level++) {
    const ancestorPath = segments.slice(0, level + 1).join(SEPARATOR);
    // Check if any later stat shares this ancestor (meaning the line continues)
    const hasLaterSibling = allStats.slice(index + 1).some((s) => {
      const sSegments = s.label.split(SEPARATOR);
      return (
        sSegments.length > level + 1 &&
        sSegments.slice(0, level + 1).join(SEPARATOR) === ancestorPath
      );
    });
    prefix += hasLaterSibling ? "│" : " ";
  }

  // For the current level, determine if this is the last child
  const parentPath = segments.slice(0, stat.depth).join(SEPARATOR);
  const isLastChild = !allStats.slice(index + 1).some((s) => {
    const sSegments = s.label.split(SEPARATOR);
    return (
      sSegments.length > stat.depth &&
      sSegments.slice(0, stat.depth).join(SEPARATOR) === parentPath
    );
  });

  prefix += isLastChild ? "└" : "├";
  return prefix;
}

function ProfileRow({
  stat,
  index,
  allStats,
}: {
  stat: ProfileStats;
  index: number;
  allStats: ProfileStats[];
}) {
  const isFrameMetric = stat.shortLabel === "frame" && stat.depth === 0;
  const isSlow = isFrameMetric && stat.avgMs > 16.67;
  const color = isSlow ? "#ff6666" : "#fff";
  const treePrefix = getTreePrefix(stat, index, allStats);

  // Compute % of parent
  let percentOfParent = "";
  if (stat.depth > 0) {
    const parentPath = stat.label
      .split(SEPARATOR)
      .slice(0, stat.depth)
      .join(SEPARATOR);
    const parent = allStats.find((s) => s.label === parentPath);
    if (parent && parent.msPerSec > 0) {
      const pct = (stat.msPerSec / parent.msPerSec) * 100;
      percentOfParent = pct.toFixed(0) + "%";
    }
  }

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "1fr 50px 50px 50px 35px",
        color,
      }}
    >
      <span>
        {treePrefix}
        {stat.shortLabel}
      </span>
      <span style={{ textAlign: "right" }}>{stat.callsPerSec.toFixed(0)}</span>
      <span style={{ textAlign: "right" }}>{stat.avgMs.toFixed(2)}ms</span>
      <span style={{ textAlign: "right" }}>{stat.maxMs.toFixed(1)}ms</span>
      <span style={{ textAlign: "right" }}>{percentOfParent}</span>
    </div>
  );
}
