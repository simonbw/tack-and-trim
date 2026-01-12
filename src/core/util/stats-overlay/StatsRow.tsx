import React from "react";

export interface StatsRowProps {
  label: string;
  value: string | number;
  color?: "warning" | "error" | "success" | "muted" | "dim";
  indent?: boolean;
}

export const StatsRow: React.FC<StatsRowProps> = ({
  label,
  value,
  color,
  indent,
}) => {
  const rowClass = indent ? "stats-row stats-row--indent" : "stats-row";
  const valueClass = color
    ? `stats-row__value stats-row__value--${color}`
    : "stats-row__value";

  return (
    <div className={rowClass}>
      <span className="stats-row__label">{label}</span>
      <span className={valueClass}>{value}</span>
    </div>
  );
};
