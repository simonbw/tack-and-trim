import { ReactEntity } from "../../../core/ReactEntity";
import type { Boat } from "../Boat";
import type { Sailor } from "./Sailor";
import type { AxisControl, StationDef } from "./StationConfig";

/** Human-readable labels for axis controls. */
const AXIS_LABELS: Record<AxisControl, string> = {
  rudder: "Rudder",
  mainsheet: "Mainsheet",
  mainHoist: "Main Hoist",
  jibSheets: "Jib Sheets",
  jibHoistFurl: "Jib Hoist",
};

/** Key labels for each input axis. */
const AXIS_KEYS: Record<"steer" | "primary" | "secondary", string> = {
  steer: "A/D",
  primary: "W/S",
  secondary: "Q/E",
};

/**
 * Always-visible HUD showing the sailor's current station and available
 * controls, or a transit indicator while moving between stations.
 */
export class StationHUD extends ReactEntity {
  constructor() {
    super(() => this.renderContent());
  }

  private renderContent() {
    const boat = this.game?.entities.getById("boat") as Boat | undefined;
    const sailor = boat?.sailor;
    if (!boat || !sailor) return null;

    return (
      <div
        style={{
          position: "fixed",
          bottom: "20px",
          left: "20px",
          color: "white",
          textShadow: "0 0 4px rgba(0, 0, 0, 0.8)",
          fontFamily: "var(--font-body)",
          fontWeight: "300",
          fontSize: "14px",
          userSelect: "none",
          pointerEvents: "none",
          lineHeight: "1.5",
        }}
      >
        {sailor.state.kind === "transit"
          ? this.renderTransit(boat, sailor)
          : this.renderStation(boat, sailor)}
      </div>
    );
  }

  private renderTransit(boat: Boat, sailor: Sailor) {
    const state = sailor.state;
    if (state.kind !== "transit") return null;
    const target = boat.config.stations.find(
      (s) => s.id === state.targetStationId,
    );
    if (!target) return null;

    return (
      <div>
        <div
          style={{
            fontSize: "16px",
            fontWeight: "600",
            marginBottom: "4px",
            color: "#ff8800",
          }}
        >
          → {target.name}
        </div>
        {this.renderBindingList(this.stationCycleBindings(boat, sailor))}
      </div>
    );
  }

  private renderStation(boat: Boat, sailor: Sailor) {
    const station = sailor.getCurrentStation();
    if (!station) return null;

    return (
      <div>
        <div
          style={{
            fontSize: "16px",
            fontWeight: "600",
            marginBottom: "4px",
            color: "#ff8800",
          }}
        >
          {station.name}
        </div>
        {this.renderBindings(boat, sailor, station)}
      </div>
    );
  }

  private renderBindings(boat: Boat, sailor: Sailor, station: StationDef) {
    const bindings: Array<{ keys: string; label: string }> = [];

    if (station.steerAxis) {
      bindings.push({
        keys: AXIS_KEYS.steer,
        label: AXIS_LABELS[station.steerAxis],
      });
    }
    if (station.primaryAxis) {
      bindings.push({
        keys: AXIS_KEYS.primary,
        label: AXIS_LABELS[station.primaryAxis],
      });
    }
    if (station.secondaryAxis) {
      bindings.push({
        keys: AXIS_KEYS.secondary,
        label: AXIS_LABELS[station.secondaryAxis],
      });
    }
    if (station.actions?.includes("anchor")) {
      bindings.push({ keys: "R", label: "Raise Anchor" });
      bindings.push({ keys: "G", label: "Lower Anchor" });
    }
    if (station.actions?.includes("mooring")) {
      bindings.push({ keys: "M", label: "Dock" });
    }
    if (station.actions?.includes("bail")) {
      bindings.push({ keys: "B", label: "Bail" });
    }
    bindings.push(...this.stationCycleBindings(boat, sailor));

    return this.renderBindingList(bindings);
  }

  /** Z/X bindings labelled with the neighbor station's name; hidden at endpoints. */
  private stationCycleBindings(
    boat: Boat,
    sailor: Sailor,
  ): Array<{ keys: string; label: string }> {
    const stations = boat.config.stations;
    const state = sailor.state;
    const currentId =
      state.kind === "atStation" ? state.stationId : state.targetStationId;
    const idx = stations.findIndex((s) => s.id === currentId);
    if (idx < 0) return [];

    const out: Array<{ keys: string; label: string }> = [];
    if (idx > 0) {
      out.push({ keys: "Z", label: `Go to ${stations[idx - 1].name}` });
    }
    if (idx < stations.length - 1) {
      out.push({ keys: "X", label: `Go to ${stations[idx + 1].name}` });
    }
    return out;
  }

  private renderBindingList(bindings: Array<{ keys: string; label: string }>) {
    if (bindings.length === 0) return null;
    return (
      <div style={{ opacity: 0.7 }}>
        {bindings.map((b) => (
          <div key={b.keys}>
            <span
              style={{
                display: "inline-block",
                minWidth: "52px",
                fontWeight: "600",
                opacity: 0.9,
              }}
            >
              {b.keys}
            </span>{" "}
            {b.label}
          </div>
        ))}
      </div>
    );
  }
}
