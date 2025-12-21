import React from "react";
import { CollisionGroups } from "../../config/CollisionGroups";
import { BoxDef, CircleDef, ConvexDef, LineDef, ShapeDef } from "../EntityDef";
import { collisionGroupToNames } from "../util/CollisionGroupUtils";
import { objectEntries, pick } from "../util/ObjectUtils";
import { CollapsibleCard } from "./CollapsibleCard";
import { PointInput } from "./PointInput";

export const ShapeDefEditor: React.FC<{
  shapeDef: ShapeDef;
  update: (shapeDef: ShapeDef) => void;
  remove: () => void;
}> = ({ shapeDef, update, remove }) => {
  return (
    <CollapsibleCard summary={shapeDef.type} onRemove={remove}>
      <ShapeDefTypeSelect shapeDef={shapeDef} update={update} />
      <div className="stack gap-1">
        <div className="label">
          <span>Collision Group</span>
          <CollisionGroupSelector
            value={shapeDef.collisionGroup ?? CollisionGroups.None}
            onChange={(collisionGroup) =>
              update({ ...shapeDef, collisionGroup })
            }
          />
        </div>
        <div className="label">
          <span>Collision Mask</span>
          <CollisionGroupSelector
            value={shapeDef.collisionMask ?? CollisionGroups.All}
            onChange={(collisionMask) => update({ ...shapeDef, collisionMask })}
          />
        </div>

        {shapeDef.type === "circle" && (
          <CircleDefEditor
            circleDef={shapeDef}
            update={(newDef) => update({ ...shapeDef, ...newDef })}
          />
        )}
        {shapeDef.type === "line" && (
          <LineDefEditor
            lineDef={shapeDef}
            update={(newDef) => update({ ...shapeDef, ...newDef })}
          />
        )}
        {shapeDef.type === "box" && (
          <BoxDefEditor
            boxDef={shapeDef}
            update={(newDef) => update({ ...shapeDef, ...newDef })}
          />
        )}
        {shapeDef.type === "convex" && (
          <ConvexDefEditor
            convexDef={shapeDef}
            update={(newDef) => update({ ...shapeDef, ...newDef })}
          />
        )}
      </div>
    </CollapsibleCard>
  );
};

const CollisionGroupSelector: React.FC<{
  value: number;
  onChange: (value: number) => void;
}> = ({ value, onChange }) => {
  const collisionGroupNames = collisionGroupToNames(value);
  const label =
    collisionGroupNames.length === 0 ? "None" : collisionGroupNames.join(", ");
  return (
    <details className="dropdown" style={{ width: "100%" }}>
      <summary style={{ width: "100%" }}>{label}</summary>
      <ul>
        <li>
          <label>
            <input
              type="checkbox"
              checked={value === CollisionGroups.All}
              onChange={(event) => {
                const checked = event.target.checked;
                const newValue = checked
                  ? CollisionGroups.All
                  : CollisionGroups.None;
                onChange(newValue);
              }}
            />
            All
          </label>
        </li>
        {objectEntries(CollisionGroups).map(([name, group]) => {
          if (name === "All") return null;
          if (name === "None") return null;
          return (
            <li key={name}>
              <label>
                <input
                  type="checkbox"
                  checked={(group & value) !== 0}
                  onChange={(event) => {
                    const checked = event.target.checked;
                    const newValue = checked ? value | group : value & ~group;
                    onChange(newValue);
                  }}
                />
                {name}
              </label>
            </li>
          );
        })}
      </ul>
    </details>
  );
};

const ShapeDefTypeSelect: React.FC<{
  shapeDef: ShapeDef;
  update: (newDef: ShapeDef) => void;
}> = ({ shapeDef, update }) => {
  const common = pick(shapeDef, ["collisionGroup", "collisionMask"]);
  return (
    <label>
      <span>Type</span>
      <select
        value={shapeDef.type}
        onChange={(event) => {
          switch (event.target.value as ShapeDef["type"]) {
            case "line":
              return update({
                ...common,
                type: "line",
                start: [0, 0],
                end: [1, 1],
              });
            case "circle":
              return update({
                ...common,
                type: "circle",
                center: [0, 0],
                radius: 1,
              });
            case "box":
              return update({
                ...common,
                type: "box",
                center: [0, 0],
                size: [1, 1],
                angle: 0,
              });
            case "convex":
              return update({
                ...common,
                type: "convex",
                vertices: [
                  [0, 0],
                  [1, 0],
                  [0, 1],
                ],
              });
          }
        }}
      >
        <option value="line">Line</option>
        <option value="circle">Circle</option>
        <option value="box">Box</option>
        <option value="convex">Convex</option>
      </select>
    </label>
  );
};

const CircleDefEditor: React.FC<{
  circleDef: CircleDef;
  update: (newDef: CircleDef) => void;
}> = ({ circleDef, update }) => {
  return (
    <div>
      <label>
        <span>Center</span>
        <PointInput
          value={circleDef.center}
          onChange={(center) => update({ ...circleDef, center })}
          step={0.01}
        />
      </label>
      <label>
        <span>Radius</span>
        <input
          type="number"
          step={0.01}
          value={circleDef.radius}
          onChange={(event) =>
            update({ ...circleDef, radius: parseFloat(event.target.value) })
          }
          min={0}
        />
      </label>
    </div>
  );
};

const LineDefEditor: React.FC<{
  lineDef: LineDef;
  update: (newDef: LineDef) => void;
}> = ({ lineDef, update }) => {
  return (
    <div>
      <label>
        <span>Start</span>
        <PointInput
          value={lineDef.start}
          onChange={(start) => update({ ...lineDef, start })}
          step={0.01}
        />
      </label>
      <label>
        End
        <PointInput
          value={lineDef.end}
          onChange={(end) => update({ ...lineDef, end })}
          step={0.01}
        />
      </label>
    </div>
  );
};

const BoxDefEditor: React.FC<{
  boxDef: BoxDef;
  update: (newDef: BoxDef) => void;
}> = ({ boxDef, update }) => {
  return (
    <div>
      <label>
        <span>Center</span>
        <PointInput
          value={boxDef.center}
          onChange={(center) => update({ ...boxDef, center })}
          step={0.01}
        />
      </label>
      <label>
        <span>Size</span>
        <PointInput
          value={boxDef.size}
          onChange={(size) => update({ ...boxDef, size })}
          min={[0, 0]}
          step={0.01}
        />
      </label>
      <label>
        <span>Angle</span>
        <input
          type="number"
          step={0.01}
          value={boxDef.angle}
          onChange={(event) =>
            update({ ...boxDef, angle: parseFloat(event.target.value) })
          }
        />
      </label>
    </div>
  );
};

const ConvexDefEditor: React.FC<{
  convexDef: ConvexDef;
  update: (newDef: ConvexDef) => void;
}> = ({ convexDef, update }) => {
  return (
    <div>
      {convexDef.vertices.map((vertex, i) => (
        <label>
          <PointInput
            key={i}
            value={vertex}
            step={0.01}
            onChange={(p) =>
              update({
                ...convexDef,
                vertices: convexDef.vertices.map((v, j) => (i === j ? p : v)),
              })
            }
          />
        </label>
      ))}
      <button
        onClick={() =>
          update({ ...convexDef, vertices: [...convexDef.vertices, [0, 0]] })
        }
      >
        +
      </button>
    </div>
  );
};
