import { ReactEntity } from "../core/ReactEntity";
import { Boat } from "./boat/Boat";

const FT_PER_SEC_TO_KNOTS = 1 / 1.69;

/**
 * HUD element displaying the boat's speed in knots, positioned below the wind indicator.
 */
export class SpeedReadout extends ReactEntity {
  renderLayer = "hud" as const;

  constructor() {
    super(() => this.renderContent());
  }

  private renderContent() {
    const boat = this.game?.entities.getById("boat") as Boat | undefined;
    if (!boat) return <div />;

    const speed = boat.getVelocity().magnitude;
    const knots = speed * FT_PER_SEC_TO_KNOTS;

    return (
      <div
        style={{
          position: "fixed",
          top: "108px",
          right: "20px",
          color: "white",
          textShadow: "0 0 2px rgba(0, 0, 0, 0.6)",
          opacity: 0.7,
          fontFamily: "monospace",
          fontSize: "14px",
          userSelect: "none",
          pointerEvents: "none",
          textAlign: "center",
          width: "80px",
        }}
      >
        {knots.toFixed(1)} kt
      </div>
    );
  }
}
