import { ReactEntity } from "../core/ReactEntity";
import { TimeOfDay } from "./time/TimeOfDay";

/**
 * HUD element displaying the current game time in the bottom right corner.
 */
export class TimeOfDayHUD extends ReactEntity {
  renderLayer = "hud" as const;

  constructor() {
    super(() => this.renderContent());
  }

  private renderContent() {
    const timeOfDay = this.game.entities.getSingleton(TimeOfDay);
    const hour = timeOfDay.getHour();

    // Format time as HH:MM
    const hours = Math.floor(hour);
    const minutes = Math.floor((hour - hours) * 60);
    const timeString = `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}`;

    return (
      <div
        style={{
          position: "fixed",
          bottom: "20px",
          right: "20px",
          color: "white",
          textShadow: "0 0 2px rgba(0, 0, 0, 0.6)",
          opacity: 0.5,
          fontFamily: "monospace",
          fontSize: "16px",
          userSelect: "none",
          pointerEvents: "none",
        }}
      >
        {timeString}
      </div>
    );
  }
}
