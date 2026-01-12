import React from "react";
import SpatialHashingBroadphase from "../../physics/collision/broadphase/SpatialHashingBroadphase";
import { profiler } from "../Profiler";
import { ProfileRow } from "./ProfileRow";
import type { StatsPanel, StatsPanelContext } from "./StatsPanel";

const TOP_N_PROFILES = 100;
const TOP_N_CHILDREN = 3;

/**
 * Creates a profiler panel with CPU timing breakdown.
 */
export function createProfilerPanel(): StatsPanel {
  let profilingEnabled = true;

  return {
    id: "profiler",

    render: (ctx) => {
      const profileStats = profiler.getTopStats(TOP_N_PROFILES, TOP_N_CHILDREN);
      const basicStats = getBasicStats(ctx);

      // Find frame total for bar width calculations
      const frameStat = profileStats.find(
        (s) => s.label === "Game.loop" && s.depth === 0
      );
      const frameTotalMs = frameStat?.msPerFrame ?? 1;

      return (
        <>
          <div className="stats-overlay__header">
            <span>
              FPS:{" "}
              {ctx.fps.toLocaleString(undefined, { maximumFractionDigits: 0 })}{" "}
              (
              {ctx.fps2.toLocaleString(undefined, { maximumFractionDigits: 0 })}
              )
            </span>
            <span>Entities: {basicStats.entityCount}</span>
            <span>Bodies: {basicStats.bodyCount}</span>
          </div>

          <div className="stats-overlay__subheader">
            Bodies: {basicStats.kinematicBodyCount}K /{" "}
            {basicStats.particleBodyCount}P / {basicStats.dynamicBodyCount}D /{" "}
            {basicStats.hugeBodyCount}H | Collisions: {basicStats.collisions}
          </div>

          <div className="stats-overlay__section">
            <div className="stats-overlay__section-header">
              <span className="stats-overlay__section-title">Profiler</span>
              <span className="stats-overlay__hint">
                [R] Reset | [P] {profilingEnabled ? "On" : "Off"}
              </span>
            </div>

            {profileStats.map((stat) => (
              <ProfileRow
                key={stat.label}
                stat={stat}
                frameTotalMs={frameTotalMs}
              />
            ))}

            {profileStats.length === 0 && (
              <div className="stats-overlay__empty">No profile data yet</div>
            )}
          </div>
        </>
      );
    },

    onKeyDown: (_ctx, key) => {
      if (key === "KeyR") {
        profiler.reset();
        return true;
      }
      if (key === "KeyP") {
        profilingEnabled = !profilingEnabled;
        profiler.setEnabled(profilingEnabled);
        return true;
      }
      return false;
    },
  };
}

function getBasicStats(ctx: StatsPanelContext) {
  const world = ctx.game.world;
  const broadphase = ctx.game.world.broadphase as SpatialHashingBroadphase;
  return {
    entityCount: ctx.game.entities.all.size,
    bodyCount: world.bodies.length,
    hugeBodyCount: broadphase.hugeBodies?.size ?? 0,
    dynamicBodyCount: world.bodies.dynamic.length,
    kinematicBodyCount: world.bodies.kinematic.length,
    particleBodyCount: broadphase.particleBodies.size,
    collisions: broadphase.debugData.numCollisions,
  };
}
