import React, { ReactNode } from "react";
import { EntityDef } from "../EntityDef";
import { BodyDefSection } from "./BodyDefSection";
import { SpriteDefsSection } from "./SpriteDefsSection";

export const EditorColumn: React.FC<{
  entityDef: EntityDef;
  updateEntityDef: (newEntityDef: EntityDef) => void;
}> = ({ entityDef, updateEntityDef }) => {
  return (
    <aside
      style={{
        width: "50%",
        minWidth: "24rem",
        maxWidth: "32rem",
        overflowY: "auto",
      }}
    >
      <EditorColumnSection title="Sprites">
        <SpriteDefsSection
          sprites={entityDef.sprites ?? []}
          updateSprites={(newSprites) =>
            updateEntityDef({ ...entityDef, sprites: newSprites })
          }
        />
      </EditorColumnSection>

      <hr />

      <EditorColumnSection title="Body">
        <BodyDefSection
          bodyDef={entityDef.body!}
          updateBody={(newBody) =>
            updateEntityDef({ ...entityDef, body: newBody })
          }
        />
      </EditorColumnSection>

      <hr />

      <EditorColumnSection title="EntityDef">
        <pre>{JSON.stringify(entityDef, null, 2)}</pre>
      </EditorColumnSection>
    </aside>
  );
};

export const EditorColumnSection: React.FC<{
  title: string;
  children: ReactNode;
}> = ({ title, children }) => (
  <details open>
    <summary>
      <h3>{title}</h3>
    </summary>
    <div className="stack gap-2">{children}</div>
  </details>
);
