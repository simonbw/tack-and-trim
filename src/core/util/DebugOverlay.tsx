import React from "react";
import Entity, { GameEventMap } from "../entity/Entity";
import SpatialHashingBroadphase from "../physics/collision/broadphase/SpatialHashingBroadphase";
import { ReactEntity } from "../ReactEntity";
import { profiler, ProfileStats } from "./Profiler";

const SMOOTHING = 0.95;
const TOP_N_PROFILES = 100;

// TODO: Support custom debug modes or extensible stats providers so game-specific
// stats (like water readback) don't need to be hardcoded in the core engine.
const MODES = ["closed", "lean", "profiler", "graphics"] as const;
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
      const profileStats = profiler.getTopStats(TOP_N_PROFILES, 3);

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

                {(() => {
                  const frameStat = profileStats.find(
                    (s) => s.label === "Game.loop" && s.depth === 0,
                  );
                  const frameTotalMs = frameStat?.msPerFrame ?? 1;
                  return profileStats.map((stat) => (
                    <ProfileRow
                      key={stat.label}
                      stat={stat}
                      allStats={profileStats}
                      frameTotalMs={frameTotalMs}
                    />
                  ));
                })()}

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
                        <>
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
                          {/* GPU Section Breakdown */}
                          {gfx.gpuSections && (
                            <>
                              <div
                                style={{
                                  display: "flex",
                                  justifyContent: "space-between",
                                  paddingLeft: "12px",
                                }}
                              >
                                <span style={{ color: "#666" }}>Render</span>
                                <span style={{ color: "#888" }}>
                                  {gfx.gpuSections.render.toFixed(2)}ms
                                </span>
                              </div>
                              <div
                                style={{
                                  display: "flex",
                                  justifyContent: "space-between",
                                  paddingLeft: "12px",
                                }}
                              >
                                <span style={{ color: "#666" }}>
                                  Water Compute
                                </span>
                                <span style={{ color: "#888" }}>
                                  {gfx.gpuSections.waterCompute.toFixed(2)}ms
                                </span>
                              </div>
                              <div
                                style={{
                                  display: "flex",
                                  justifyContent: "space-between",
                                  paddingLeft: "12px",
                                }}
                              >
                                <span style={{ color: "#666" }}>Readback</span>
                                <span style={{ color: "#888" }}>
                                  {gfx.gpuSections.readback.toFixed(2)}ms
                                </span>
                              </div>
                            </>
                          )}
                        </>
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

                      {/* Water readback stats (game-specific) */}
                      {gfx.waterReadback && (
                        <>
                          <div
                            style={{
                              borderTop: "1px solid #333",
                              marginTop: "4px",
                              paddingTop: "4px",
                              display: "flex",
                              justifyContent: "space-between",
                            }}
                          >
                            <span style={{ color: "#aaa" }}>Water Res</span>
                            <span
                              style={{
                                color:
                                  gfx.waterReadback.resolution >= 2
                                    ? "#66ff66"
                                    : gfx.waterReadback.resolution >= 1
                                      ? "#ffff66"
                                      : "#ff6666",
                              }}
                            >
                              {gfx.waterReadback.resolution.toFixed(1)} px/ft
                            </span>
                          </div>
                          <div
                            style={{
                              display: "flex",
                              justifyContent: "space-between",
                            }}
                          >
                            <span style={{ color: "#aaa" }}>
                              Water GPU Hits
                            </span>
                            <span
                              style={{
                                color:
                                  gfx.waterReadback.gpuPercent > 90
                                    ? "#66ff66"
                                    : gfx.waterReadback.gpuPercent > 50
                                      ? "#ffff66"
                                      : "#ff6666",
                              }}
                            >
                              {gfx.waterReadback.gpuPercent.toFixed(0)}% (
                              {gfx.waterReadback.gpuHits}/
                              {gfx.waterReadback.total})
                            </span>
                          </div>
                          {(gfx.waterReadback.lowResFallbacks > 0 ||
                            gfx.waterReadback.outOfBoundsFallbacks > 0) && (
                            <div
                              style={{
                                display: "flex",
                                justifyContent: "space-between",
                                paddingLeft: "12px",
                              }}
                            >
                              <span style={{ color: "#666" }}>Fallbacks</span>
                              <span style={{ color: "#888" }}>
                                {gfx.waterReadback.lowResFallbacks > 0 &&
                                  `${gfx.waterReadback.lowResFallbacks} low-res`}
                                {gfx.waterReadback.lowResFallbacks > 0 &&
                                  gfx.waterReadback.outOfBoundsFallbacks > 0 &&
                                  " / "}
                                {gfx.waterReadback.outOfBoundsFallbacks > 0 &&
                                  `${gfx.waterReadback.outOfBoundsFallbacks} OOB`}
                              </span>
                            </div>
                          )}
                        </>
                      )}
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
    const gpuMs = this.game?.renderer.getGpuMs() ?? 0;
    const gpuAllMs = this.game?.renderer.getAllGpuMs() ?? null;

    // Get water readback stats (game-specific, may not exist)
    // TODO: This couples core to game code - should use extensible stats system
    const waterInfo = this.game?.entities.getById("waterInfo") as
      | {
          getReadbackStats?: () => {
            gpuHits: number;
            cpuFallbacks: number;
            lowResolutionFallbacks: number;
            outOfBoundsFallbacks: number;
            currentResolution: number;
          } | null;
        }
      | undefined;
    const readbackStats = waterInfo?.getReadbackStats?.();
    let waterReadback: {
      gpuHits: number;
      total: number;
      gpuPercent: number;
      lowResFallbacks: number;
      outOfBoundsFallbacks: number;
      resolution: number;
    } | null = null;
    if (readbackStats) {
      const total = readbackStats.gpuHits + readbackStats.cpuFallbacks;
      waterReadback = {
        gpuHits: readbackStats.gpuHits,
        total,
        gpuPercent: total > 0 ? (readbackStats.gpuHits / total) * 100 : 0,
        lowResFallbacks: readbackStats.lowResolutionFallbacks,
        outOfBoundsFallbacks: readbackStats.outOfBoundsFallbacks,
        resolution: readbackStats.currentResolution,
      };
      // Reset stats each frame for per-frame tracking
      readbackStats.gpuHits = 0;
      readbackStats.cpuFallbacks = 0;
      readbackStats.lowResolutionFallbacks = 0;
      readbackStats.outOfBoundsFallbacks = 0;
    }

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
      waterReadback,
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

function ProfileRow({
  stat,
  frameTotalMs,
}: {
  stat: ProfileStats;
  allStats: ProfileStats[];
  frameTotalMs: number;
}) {
  const isFrameMetric = stat.shortLabel === "frame" && stat.depth === 0;
  const isSlow = isFrameMetric && stat.msPerFrame > 16.67;
  const color = isSlow ? "#ff6666" : "#fff";

  // Calculate bar width as percentage of frame time
  const barPercent = Math.min(
    100,
    100 - (stat.msPerFrame / frameTotalMs) * 100,
  );

  // Slight bar color variation by depth
  const barColor = `hsl(235, 80%, ${40 + stat.depth * 4}%)`;

  // Display calls per frame if > 1
  const callsDisplay =
    stat.callsPerFrame >= 1 ? `(x${Math.round(stat.callsPerFrame)})` : "";

  return (
    <div
      style={{
        padding: "1px 0",
        paddingLeft: `${stat.depth * 16}px`,
        background: `linear-gradient(to right, transparent 0% ${barPercent}%, ${barColor} ${barPercent}%)`,
        fontFamily: "monospace",
        color,
      }}
    >
      {stat.shortLabel}
      {callsDisplay && (
        <span style={{ color: "#888", marginLeft: "8px" }}>{callsDisplay}</span>
      )}
    </div>
  );
}
