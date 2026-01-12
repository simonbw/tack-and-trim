import React from "react";
import type { ProfileStats } from "./types";

export interface ProfileRowProps {
  stat: ProfileStats;
  frameTotalMs: number;
}

export const ProfileRow: React.FC<ProfileRowProps> = ({
  stat,
  frameTotalMs,
}) => {
  const isFrameMetric = stat.shortLabel === "loop" && stat.depth === 0;
  const isSlow = isFrameMetric && stat.msPerFrame > 16.67;

  // Calculate bar width as percentage of frame time
  const barPercent = Math.min(
    100,
    100 - (stat.msPerFrame / frameTotalMs) * 100
  );

  // Slight bar color variation by depth
  const barColor = `hsl(235, 80%, ${40 + stat.depth * 4}%)`;

  // Display calls per frame if > 1
  const callsDisplay =
    stat.callsPerFrame >= 1
      ? `(x${Math.round(stat.callsPerFrame).toLocaleString()})`
      : "";

  return (
    <div
      className={`profile-row ${isSlow ? "profile-row--slow" : ""}`}
      style={{
        paddingLeft: `${stat.depth * 16}px`,
        background: `linear-gradient(to right, transparent 0% ${barPercent}%, ${barColor} ${barPercent}%)`,
      }}
    >
      <div className="profile-row__label">
        {stat.shortLabel}
        {callsDisplay && (
          <span className="profile-row__calls">{callsDisplay}</span>
        )}
      </div>
      <div className="profile-row__time">
        {stat.msPerFrame.toLocaleString(undefined, {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        })}
        ms
      </div>
    </div>
  );
};
