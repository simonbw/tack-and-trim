import React from "react";
import { SpriteDef } from "../EntityDef";
import { SpriteDefEditor } from "./SpriteDefEditor";
import { EditorColumnSection } from "./EditorColumn";

export const SpriteDefsSection: React.FC<{
  sprites: ReadonlyArray<SpriteDef>;
  updateSprites: (newSprites: SpriteDef[]) => void;
}> = ({ sprites, updateSprites }) => {
  return (
    <>
      {sprites.map((spriteDef, i) => (
        <SpriteDefEditor
          key={i}
          spriteDef={spriteDef}
          update={(newSprite) =>
            updateSprites(
              sprites.map((sprite, j) => (i === j ? newSprite : sprite))
            )
          }
          remove={() => {
            updateSprites(sprites.filter((_, j) => i !== j));
          }}
        />
      ))}

      {/* <button
        onClick={() =>
          updateSprites([
            ...sprites,
            {
              anchor: [0.5, 0.5],
              image: "orange",
              layer: "main",
              size: [1, 1],
            },
          ])
        }
      >
        Add Sprite
      </button> */}
    </>
  );
};
