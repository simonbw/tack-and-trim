import type { ComponentChildren } from "preact";
import { EntityDef } from "../EntityDef";
import { BodyDefSection } from "./BodyDefSection";
import { SpriteDefsSection } from "./SpriteDefsSection";

interface EditorColumnProps {
  entityDef: EntityDef;
  updateEntityDef: (newEntityDef: EntityDef) => void;
}

export const EditorColumn = ({
  entityDef,
  updateEntityDef,
}: EditorColumnProps) => {
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

interface EditorColumnSectionProps {
  title: string;
  children: ComponentChildren;
}

export const EditorColumnSection = ({
  title,
  children,
}: EditorColumnSectionProps) => (
  <details open>
    <summary>
      <h3>{title}</h3>
    </summary>
    <div className="stack gap-2">{children}</div>
  </details>
);
