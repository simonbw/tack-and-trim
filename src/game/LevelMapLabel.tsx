import { LevelName } from "../../resources/resources";
import { ReactEntity } from "../core/ReactEntity";

function formatLevelName(levelName: string): string {
  const spaced = levelName.replace(/([A-Z])/g, " $1");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export class LevelMapLabel extends ReactEntity {
  renderLayer = "hud" as const;

  constructor(levelName: LevelName) {
    const label = formatLevelName(levelName);

    super(() => (
      <div
        style={{
          position: "fixed",
          top: "18px",
          left: "50%",
          transform: "translateX(-50%)",
          color: "#e8dcc4",
          textShadow: "0 2px 8px rgba(0, 0, 0, 0.75)",
          fontFamily: "var(--font-map)",
          fontSize: "2.6rem",
          fontWeight: "700",
          letterSpacing: "0.04em",
          lineHeight: "1",
          pointerEvents: "none",
          userSelect: "none",
        }}
      >
        {label}
      </div>
    ));
  }
}
