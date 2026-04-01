import { ReactEntity } from "../../core/ReactEntity";
import { radToDeg } from "../../core/util/MathUtil";
import { Boat } from "./Boat";

const FT_PER_SEC_TO_KNOTS = 1 / 1.69;

/**
 * Debug HUD showing boat telemetry: speed, heel, pitch, z-height, bilge water.
 */
export class BoatDebugHUD extends ReactEntity {
  renderLayer = "hud" as const;

  constructor() {
    super(() => this.renderContent());
  }

  private renderContent() {
    const boat = this.game?.entities.getById("boat") as Boat | undefined;
    if (!boat) return <div />;

    const knots = boat.getVelocity().magnitude * FT_PER_SEC_TO_KNOTS;
    const rollDeg = radToDeg(boat.roll);
    const pitchDeg = radToDeg(boat.pitch);
    const zHeight = boat.hull.body.z;
    const waterPct = boat.bilge.getWaterFraction() * 100;
    const wheelLabel = this.game.io.getSteeringWheelDebugLabel();

    return (
      <div
        style={{
          position: "fixed",
          top: "140px",
          right: "20px",
          color: "white",
          textShadow: "0 0 2px rgba(0, 0, 0, 0.6)",
          opacity: 0.7,
          fontFamily: "var(--font-body)",
          fontWeight: "300",
          fontSize: "12px",
          userSelect: "none",
          pointerEvents: "none",
          textAlign: "right",
          lineHeight: "1.4",
        }}
      >
        <div>{knots.toFixed(1)} kt</div>
        <div>heel {rollDeg.toFixed(1)}&deg;</div>
        <div>pitch {pitchDeg.toFixed(1)}&deg;</div>
        <div>z {zHeight.toFixed(2)} ft</div>
        <div>water {waterPct.toFixed(0)}%</div>
        <div>{wheelLabel}</div>
      </div>
    );
  }
}
