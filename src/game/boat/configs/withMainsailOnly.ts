import type { BoatConfig } from "../BoatConfig";

/**
 * Strip jib, jib sheets, bowsprit, and jib-related sailor station bindings
 * from a BoatConfig. Use for entry-level boats that carry only a mainsail.
 * The forestay is unaffected — the mast still gets fore-aft support from
 * the bow stem.
 */
export function withMainsailOnly(base: BoatConfig): BoatConfig {
  return {
    ...base,
    jib: undefined,
    jibSheet: undefined,
    bowsprit: undefined,
    stations: base.stations.map((s) => ({
      ...s,
      primaryAxis: s.primaryAxis === "jibHoistFurl" ? undefined : s.primaryAxis,
      secondaryAxis:
        s.secondaryAxis === "jibSheets" ? undefined : s.secondaryAxis,
    })),
  };
}
