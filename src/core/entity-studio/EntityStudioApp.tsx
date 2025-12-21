import React from "react";
import { EntityDef } from "../EntityDef";
import { EditorColumn } from "./EditorColumn";
import { PreviewSection } from "./PreviewSection";

function loadEntityDef(): EntityDef {
  const entityDef = localStorage.getItem("entityDef");
  if (entityDef) {
    return JSON.parse(entityDef);
  }
  return {
    sprites: [],
    body: {
      mass: 0,
      shapes: [],
    },
  };
}

function saveEntityDef(entityDef: EntityDef) {
  localStorage.setItem("entityDef", JSON.stringify(entityDef));
}

export const EntityStudioApp: React.FC = () => {
  const [entityDef, setEntityDef] = React.useState<EntityDef>(() =>
    loadEntityDef()
  );

  return (
    <main
      data-theme="dark"
      className="container-fluid"
      style={{
        height: "100vh",
        padding: "2rem",
        overflow: "hidden",
      }}
    >
      <h1>Entity Studio</h1>

      <div
        style={{
          display: "flex",
          gap: "2rem",
          overflow: "hidden",
          height: "100%",
          paddingBlock: "2rem",
        }}
      >
        <EditorColumn
          entityDef={entityDef}
          updateEntityDef={(newEntityDef: EntityDef) => {
            setEntityDef(newEntityDef);
            saveEntityDef(newEntityDef);
          }}
        />
        <PreviewSection entityDef={entityDef} />
      </div>
    </main>
  );
};
