import { Container } from "pixi.js";
import React from "react";
import Entity, { GameEventMap } from "../entity/Entity";
import SpatialHashingBroadphase from "../physics/collision/broadphase/SpatialHashingBroadphase";
import { ReactEntity } from "../ReactEntity";
import { profiler, ProfileStats } from "./Profiler";

const SMOOTHING = 0.95;
const TOP_N_PROFILES = 8;

const MODES = ["closed", "lean", "physics", "profiler"] as const;
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
                {stats.hugeBodyCount}H) | Sprites: {stats.spriteCount} |
                Collisions: {stats.collisions}
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
                / {stats.dynamicBodyCount}D / {stats.hugeBodyCount}H | Sprites:{" "}
                {stats.spriteCount} | Collisions: {stats.collisions}
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
                    gridTemplateColumns: "100px 50px 60px 50px 50px",
                    fontSize: "10px",
                    color: "#888",
                    marginBottom: "2px",
                  }}
                >
                  <span>Label</span>
                  <span style={{ textAlign: "right" }}>Calls</span>
                  <span style={{ textAlign: "right" }}>Total</span>
                  <span style={{ textAlign: "right" }}>Avg</span>
                  <span style={{ textAlign: "right" }}>Max</span>
                </div>

                {profileStats.map((stat, i) => (
                  <ProfileRow key={stat.label} stat={stat} index={i} />
                ))}

                {profileStats.length === 0 && (
                  <div style={{ color: "#666", fontStyle: "italic" }}>
                    No profile data yet
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      );
    });
  }

  private cycleMode(direction: 1 | -1) {
    const currentIndex = MODES.indexOf(this.mode);
    const nextIndex =
      (currentIndex + direction + MODES.length) % MODES.length;
    this.mode = MODES[nextIndex];
  }

  onAdd() {
    super.onAdd();
    this.averageDuration = 1 / 60;
  }

  onRender() {
    const now = performance.now();
    const duration = now - this.lastUpdate;
    this.averageDuration =
      SMOOTHING * this.averageDuration + (1.0 - SMOOTHING) * duration;
    this.lastUpdate = now;

    super.onRender();
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
      spriteCount: getSpriteCount(this.game!.renderer.stage),
      collisions: (this.game?.world.broadphase as SpatialHashingBroadphase)
        .debugData.numCollisions,
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

function ProfileRow({ stat, index }: { stat: ProfileStats; index: number }) {
  const isFrameMetric = stat.label === "frame";
  const isSlow = isFrameMetric && stat.avgMs > 16.67;
  const color = isSlow ? "#ff6666" : index < 4 ? "#fff" : "#aaa";

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "100px 50px 60px 50px 50px",
        color,
      }}
    >
      <span
        style={{
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {stat.label}
      </span>
      <span style={{ textAlign: "right" }}>{stat.calls}</span>
      <span style={{ textAlign: "right" }}>{stat.totalMs.toFixed(1)}ms</span>
      <span style={{ textAlign: "right" }}>{stat.avgMs.toFixed(2)}</span>
      <span style={{ textAlign: "right" }}>{stat.maxMs.toFixed(1)}</span>
    </div>
  );
}

/** Counts the number of children of a display object. */
function getSpriteCount(root: Container): number {
  let total = 1;

  for (const child of root.children ?? []) {
    total += getSpriteCount(child);
  }

  return total;
}
