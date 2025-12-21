import React, { Fragment, useMemo, useState } from "react";
import { RESOURCES } from "../../../resources/resources";
import { LayerName, LAYERS } from "../../config/layers";
import { EntityDef, ShapeDef, SpriteDef } from "../EntityDef";
import { clamp } from "../util/MathUtil";
import { objectKeys } from "../util/ObjectUtils";

export const PreviewSection: React.FC<{ entityDef: EntityDef }> = ({
  entityDef,
}) => {
  const [zoom, setZoom] = useState(2);
  const viewBox = [-zoom, -zoom, zoom * 2, zoom * 2];

  // Sort the sprites by layer so they overlap properly
  const sortedSprites = useMemo(() => {
    const layerToScore = Object.fromEntries(
      objectKeys(LAYERS).map((key, index) => [key, index])
    ) as Record<LayerName, number>;
    return entityDef.sprites!.toSorted(
      (a, b) => layerToScore[a.layer] - layerToScore[b.layer]
    );
  }, [entityDef.sprites]);

  return (
    <div
      onWheel={(event) => {
        event.preventDefault();
        event.stopPropagation();
        setZoom((z) => z * (1 + event.deltaY / 1000));
      }}
      onScrollCapture={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onScroll={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      style={{
        border: "1px solid var(--pico-muted-border-color)",
        position: "relative",
        height: "100%",
        aspectRatio: "1/1",
      }}
    >
      <div
        className="row gap-1"
        style={{
          position: "absolute",
          top: 0,
          right: 0,
          padding: "0.5rem",
        }}
      >
        <button
          className="outline secondary"
          onClick={() => setZoom((z) => z * 1.05)}
        >
          -
        </button>
        <button
          className="outline secondary"
          onClick={() => setZoom((z) => z * 0.95)}
        >
          +
        </button>
      </div>
      <svg
        viewBox={viewBox.join(" ")}
        style={{
          aspectRatio: "1/1",
          maxHeight: "100%",
          maxWidth: "100%",
        }}
      >
        <Grid zoom={zoom} />
        {sortedSprites.map((spriteDef, i) => (
          <SpriteDefPreview key={i} spriteDef={spriteDef} />
        ))}
        {entityDef.body !== undefined &&
          entityDef.body.shapes.map((shapeDef, i) => (
            <ShapeDefPreview key={i} shapeDef={shapeDef} zoom={zoom} />
          ))}
      </svg>
    </div>
  );
};

const Grid: React.FC<{ zoom: number }> = ({ zoom }) => {
  let min = Math.floor(-(zoom * 10));
  let max = Math.ceil(zoom * 10);

  let lines = [];
  for (let i = min; i <= max; i++) {
    lines.push(i);
  }

  if (zoom > 10) {
    lines = lines.filter((i) => i % 10 === 0);
  }

  if (zoom > 100) {
    lines = lines.filter((i) => i % 100 === 0);
  }

  return (
    <g opacity={0.2} shapeRendering="geometricPresicion">
      {lines.map((i) => {
        const strokeWidth =
          i % 100 === 0
            ? clamp(zoom * 0.01, 0, 0.05)
            : i % 10 === 0
              ? clamp(zoom * 0.005, 0, 0.02)
              : clamp(zoom * 0.0015, 0, 0.005);
        return (
          <Fragment key={i}>
            <line
              x1={i / 10}
              x2={i / 10}
              y1={min / 10}
              y2={max / 10}
              stroke="#fff"
              strokeWidth={strokeWidth}
            />
            <line
              x1={min / 10}
              x2={max / 10}
              y1={i / 10}
              y2={i / 10}
              stroke="#fff"
              strokeWidth={strokeWidth}
            />
          </Fragment>
        );
      })}
    </g>
  );
};

const SpriteDefPreview: React.FC<{ spriteDef: SpriteDef }> = ({
  spriteDef,
}) => {
  const [width, height] = spriteDef.size;
  const x = -spriteDef.anchor[0] * width;
  const y = -spriteDef.anchor[1] * height;
  return (
    <image
      x={x}
      y={y}
      width={width}
      height={height}
      preserveAspectRatio="none"
      href={RESOURCES.images[spriteDef.image]}
    />
  );
};

const ShapeDefPreview: React.FC<{
  shapeDef: ShapeDef;
  zoom: number;
}> = ({ shapeDef, zoom }) => {
  switch (shapeDef.type) {
    case "circle": {
      const { center, radius } = shapeDef;
      return (
        <circle
          cx={center[0]}
          cy={center[1]}
          r={radius}
          strokeWidth={0.01 * zoom}
          stroke={"#f009"}
          fill="none"
        />
      );
    }
    case "box": {
      const { center, size } = shapeDef;
      const [width, height] = size;
      return (
        <rect
          x={center[0] - width / 2}
          y={center[1] - height / 2}
          width={width}
          height={height}
          strokeWidth={0.01 * zoom}
          stroke={"#f009"}
          fill="none"
        />
      );
    }
    case "line": {
      const { start, end } = shapeDef;
      return (
        <line
          x1={start[0]}
          y1={start[1]}
          x2={end[0]}
          y2={end[1]}
          strokeWidth={0.01 * zoom}
          stroke={"#f009"}
        />
      );
    }
    case "convex": {
      const { vertices } = shapeDef;
      return (
        <polygon
          points={vertices.join(" ")}
          strokeWidth={0.01 * zoom}
          stroke={"#f009"}
          fill="none"
        />
      );
    }
  }
};
