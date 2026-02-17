import { ReactEntity } from "../core/ReactEntity";

export class GameInitializingScreen extends ReactEntity {
  constructor() {
    super(() => (
      <div
        style={{
          position: "fixed",
          inset: "0",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background:
            "radial-gradient(ellipse at center, rgba(0, 18, 36, 0.6) 0%, rgba(0, 10, 24, 0.9) 100%)",
          color: "#e8e4d9",
          fontFamily: "Georgia, 'Times New Roman', serif",
          fontSize: "1.4rem",
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          textShadow: "0 2px 8px rgba(0, 0, 0, 0.7)",
          pointerEvents: "none",
        }}
      >
        Initializing...
      </div>
    ));
  }
}
