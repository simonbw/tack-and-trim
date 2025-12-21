import React from "react";

export const PointInput: React.FC<{
  value: [number, number];
  min?: [number, number];
  max?: [number, number];
  step?: number | "any";
  onChange: (value: [number, number]) => void;
}> = ({ value, onChange, min, max, step = "any" }) => {
  return (
    <div role="group">
      <input
        type="number"
        value={value[0]}
        onChange={(event) => onChange([Number(event.target.value), value[1]])}
        min={min ? min[0] : undefined}
        max={max ? max[0] : undefined}
        step={step}
      />
      <input
        type="number"
        value={value[1]}
        onChange={(event) => onChange([value[0], Number(event.target.value)])}
        min={min ? min[1] : undefined}
        max={max ? max[1] : undefined}
        step={step}
      />
    </div>
  );
};
