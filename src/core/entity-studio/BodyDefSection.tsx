import { CollisionGroups } from "../../config/CollisionGroups";
import { BodyDef, ShapeDef } from "../EntityDef";
import { ShapeDefEditor } from "./ShapeDefEditor";

interface BodyDefSectionProps {
  bodyDef: BodyDef;
  updateBody: (newBody: BodyDef) => void;
}

export const BodyDefSection = ({
  bodyDef,
  updateBody,
}: BodyDefSectionProps) => {
  return (
    <>
      <article>
        <label>
          <span>Mass</span>
          <input
            type="number"
            value={bodyDef?.mass ?? 1}
            onChange={(event) =>
              updateBody({
                ...bodyDef,
                mass: parseFloat((event.target as HTMLInputElement).value),
              })
            }
          />
        </label>
      </article>

      {bodyDef.shapes.length > 0 && <h4>Shapes</h4>}
      <ShapeDefsSection
        shapes={bodyDef.shapes}
        updateShapes={(newShapes) =>
          updateBody({ ...bodyDef, shapes: newShapes })
        }
      />
    </>
  );
};

interface ShapeDefsSectionProps {
  shapes: ReadonlyArray<ShapeDef>;
  updateShapes: (newShapes: ShapeDef[]) => void;
}

export const ShapeDefsSection = ({
  shapes,
  updateShapes,
}: ShapeDefsSectionProps) => {
  return (
    <>
      {shapes.map((shapeDef, i) => (
        <ShapeDefEditor
          key={i}
          shapeDef={shapeDef}
          update={(newShape) =>
            updateShapes(shapes.map((shape, j) => (i === j ? newShape : shape)))
          }
          remove={() => {
            updateShapes(shapes.filter((_, j) => i !== j));
          }}
        />
      ))}

      <button
        onClick={() =>
          updateShapes([
            ...shapes,
            shapes.at(-1) ?? {
              type: "circle",
              center: [0, 0],
              radius: 1,
              collisionGroup: CollisionGroups.Environment,
              collisionMask: CollisionGroups.All,
            },
          ])
        }
      >
        Add Shape
      </button>
    </>
  );
};
