import React from "react";
import { ImageName, RESOURCES } from "../../../resources/resources";
import { LayerName, LAYERS } from "../../config/layers";
import { SpriteDef } from "../EntityDef";
import { objectKeys } from "../util/ObjectUtils";
import { PointInput } from "./PointInput";
import { CollapsibleCard } from "./CollapsibleCard";

export const SpriteDefEditor: React.FC<{
  spriteDef: SpriteDef;
  update: (spriteDef: SpriteDef) => void;
  remove: () => void;
}> = ({ spriteDef, update, remove }) => {
  return (
    <CollapsibleCard
      summary={
        <span className="row gap-1">
          <img
            src={RESOURCES.images[spriteDef.image]}
            alt={spriteDef.image}
            width={128}
            style={{ maxWidth: 24, maxHeight: 24 }}
          />
        </span>
      }
      onRemove={remove}
    >
      <div className="grid">
        <div className="stack gap-1">
          <label>
            <span>Image</span>
            <select
              onChange={(event) => {
                update({
                  ...spriteDef,
                  image: event.target.value as ImageName,
                });
              }}
              value={spriteDef.image}
            >
              {objectKeys(RESOURCES.images).map((image) => (
                <option key={image}>{image}</option>
              ))}
            </select>
          </label>
          <label>
            <span>Layer</span>
            <select
              value={spriteDef.layer}
              onChange={(event) => {
                update({
                  ...spriteDef,
                  layer: event.target.value as LayerName,
                });
              }}
            >
              {objectKeys(LAYERS).map((layer) => (
                <option key={layer}>{layer}</option>
              ))}
            </select>
          </label>

          <label>
            <span>Anchor</span>
            <PointInput
              value={spriteDef.anchor}
              onChange={(anchor) => update({ ...spriteDef, anchor })}
              min={[0, 0]}
              max={[1, 1]}
              step={0.01}
            />
          </label>
          <label>
            <span>Size</span>
            <PointInput
              value={spriteDef.size}
              onChange={(size) => update({ ...spriteDef, size })}
              min={[0, 0]}
              step={0.01}
            />
          </label>
        </div>
        <div
          style={{
            display: "flex",
            justifyContent: "center",
            alignItems: "center",
          }}
        >
          <img
            src={RESOURCES.images[spriteDef.image]}
            alt={spriteDef.image}
            width={128}
            style={{
              maxWidth: 128,
              maxHeight: 128,
              background: "var(--pico-background-color)",
            }}
          />
        </div>
      </div>
    </CollapsibleCard>
  );
};
