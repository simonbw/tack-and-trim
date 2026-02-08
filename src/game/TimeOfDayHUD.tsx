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
          padding: "8px 12px",
          backgroundColor: "rgba(0, 0, 0, 0.6)",
          color: "white",
          fontFamily: "monospace",
          fontSize: "16px",
          borderRadius: "4px",
          userSelect: "none",
          pointerEvents: "none",
        }}
      >
        {timeString}
      </div>
    );
  }
}
