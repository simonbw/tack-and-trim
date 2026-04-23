import { V } from "../../../core/Vector";
import type { BoatConfig } from "../BoatConfig";

/**
 * Scales all geometric parameters in a BoatConfig by the given factors.
 * Physics parameters (mass, inertia, righting moments, damage thresholds, etc.)
 * are NOT scaled — override them with createBoatConfig() after scaling.
 *
 * @param base   Source config to scale
 * @param sx     Scale along hull length (+X, bow-stern)
 * @param sy     Scale across beam (+Y, port-starboard)
 * @param sz     Scale for vertical dimensions (+Z, up-down)
 */
export function scaleBoatConfig(
  base: BoatConfig,
  sx: number,
  sy: number,
  sz: number,
): BoatConfig {
  const h = base.hull;
  const k = base.keel;
  const r = base.rudder;
  const rig = base.rig;
  const a = base.anchor;
  const ms = base.mainsheet;
  const js = base.jibSheet;
  const ll = base.lifelines;
  const bp = base.bowsprit;

  return {
    hull: {
      ...h,
      vertices: h.vertices.map((v) => V(v[0] * sx, v[1] * sy)),
      shape: {
        ...h.shape,
        stations: h.shape.stations.map((s) => ({
          x: s.x * sx,
          profile: s.profile.map(([y, z]) => [y * sy, z * sz] as const),
        })),
      },
      deckPlan: h.deckPlan
        ? {
            zones: h.deckPlan.zones.map((zone) => ({
              ...zone,
              outline: zone.outline.map(([x, y]) => [x * sx, y * sy] as const),
              floorZ: zone.floorZ * sz,
              wallHeight:
                zone.wallHeight !== undefined
                  ? zone.wallHeight * sz
                  : undefined,
            })),
          }
        : undefined,
      draft: h.draft * sz,
      deckHeight: h.deckHeight * sz,
    },
    keel: {
      ...k,
      vertices: k.vertices.map((v) => V(v[0] * sx, v[1] * sy)),
      chord: k.chord * sz,
      // draft intentionally NOT scaled — override per boat with real keel depth
    },
    rudder: {
      ...r,
      position: V(r.position[0] * sx, r.position[1] * sy),
      length: r.length * sy,
      chord: r.chord * sz,
      // draft intentionally NOT scaled — override per boat
    },
    helm: base.helm
      ? {
          ...base.helm,
          position: base.helm.position
            ? V(base.helm.position[0] * sx, base.helm.position[1] * sy)
            : undefined,
          radius:
            base.helm.radius !== undefined
              ? base.helm.radius * Math.min(sx, sy)
              : undefined,
        }
      : undefined,
    rig: {
      ...rig,
      mastPosition: V(rig.mastPosition[0] * sx, rig.mastPosition[1] * sy),
      boomLength: rig.boomLength * sx,
      boomWidth: rig.boomWidth * sy,
      boomMass: rig.boomMass * sx,
      mainsail: {
        ...rig.mainsail,
        zFoot:
          rig.mainsail.zFoot !== undefined
            ? rig.mainsail.zFoot * sz
            : undefined,
        zHead:
          rig.mainsail.zHead !== undefined
            ? rig.mainsail.zHead * sz
            : undefined,
      },
      stays: {
        forestay: V(rig.stays.forestay[0] * sx, rig.stays.forestay[1] * sy),
        portShroud: V(
          rig.stays.portShroud[0] * sx,
          rig.stays.portShroud[1] * sy,
        ),
        starboardShroud: V(
          rig.stays.starboardShroud[0] * sx,
          rig.stays.starboardShroud[1] * sy,
        ),
        backstay: {
          split: V(
            rig.stays.backstay.split[0] * sx,
            rig.stays.backstay.split[1] * sy,
          ),
          splitZ: rig.stays.backstay.splitZ * sz,
          port: V(
            rig.stays.backstay.port[0] * sx,
            rig.stays.backstay.port[1] * sy,
          ),
          starboard: V(
            rig.stays.backstay.starboard[0] * sx,
            rig.stays.backstay.starboard[1] * sy,
          ),
        },
        deckHeight: rig.stays.deckHeight * sz,
      },
    },
    bowsprit: bp
      ? {
          ...bp,
          attachPoint: V(bp.attachPoint[0] * sx, bp.attachPoint[1] * sy),
          size: V(bp.size[0] * sx, bp.size[1] * sy),
        }
      : undefined,
    lifelines: ll
      ? {
          ...ll,
          portStanchions: ll.portStanchions.map(
            ([x, y]) => [x * sx, y * sy] as const,
          ),
          starboardStanchions: ll.starboardStanchions.map(
            ([x, y]) => [x * sx, y * sy] as const,
          ),
          bowPulpit: ll.bowPulpit.map(([x, y]) => [x * sx, y * sy] as const),
          sternPulpit: ll.sternPulpit.map(
            ([x, y]) => [x * sx, y * sy] as const,
          ),
          stanchionHeight: ll.stanchionHeight * sz,
          tubeWidth: ll.tubeWidth * Math.min(sx, sy),
          wireWidth: ll.wireWidth * Math.min(sx, sy),
        }
      : undefined,
    anchor: {
      ...a,
      bowAttachPoint: V(a.bowAttachPoint[0] * sx, a.bowAttachPoint[1] * sy),
      maxRodeLength: a.maxRodeLength * sx,
      anchorSize: a.anchorSize * Math.sqrt(sx * sy),
      anchorMass: a.anchorMass * sx * sy * sz,
      deckHeight: a.deckHeight * sz,
      rodeAttachOffset: [
        a.rodeAttachOffset[0] * sx,
        a.rodeAttachOffset[1] * sy,
        a.rodeAttachOffset[2] * sz,
      ] as readonly [number, number, number],
    },
    jib: base.jib
      ? {
          ...base.jib,
          zFoot: base.jib.zFoot !== undefined ? base.jib.zFoot * sz : undefined,
          zHead: base.jib.zHead !== undefined ? base.jib.zHead * sz : undefined,
        }
      : undefined,
    mainsheet: {
      ...ms,
      hullAttachPoint: V(
        ms.hullAttachPoint[0] * sx,
        ms.hullAttachPoint[1] * sy,
      ),
      winchPoint: ms.winchPoint
        ? V(ms.winchPoint[0] * sx, ms.winchPoint[1] * sy)
        : undefined,
      minLength: (ms.minLength ?? 2) * sx,
      maxLength: (ms.maxLength ?? 12) * sx,
    },
    jibSheet: js
      ? {
          ...js,
          portAttachPoint: V(
            js.portAttachPoint[0] * sx,
            js.portAttachPoint[1] * sy,
          ),
          starboardAttachPoint: V(
            js.starboardAttachPoint[0] * sx,
            js.starboardAttachPoint[1] * sy,
          ),
          portBlockPoint: js.portBlockPoint
            ? V(js.portBlockPoint[0] * sx, js.portBlockPoint[1] * sy)
            : undefined,
          starboardBlockPoint: js.starboardBlockPoint
            ? V(js.starboardBlockPoint[0] * sx, js.starboardBlockPoint[1] * sy)
            : undefined,
          portWinchPoint: js.portWinchPoint
            ? V(js.portWinchPoint[0] * sx, js.portWinchPoint[1] * sy)
            : undefined,
          starboardWinchPoint: js.starboardWinchPoint
            ? V(js.starboardWinchPoint[0] * sx, js.starboardWinchPoint[1] * sy)
            : undefined,
          minLength: (js.minLength ?? 6) * sx,
          maxLength: (js.maxLength ?? 18) * sx,
        }
      : undefined,
    rowing: {
      ...base.rowing,
      force: base.rowing.force * sx * sy,
    },
    initialStationId: base.initialStationId,
    stations: base.stations.map((s) => ({
      ...s,
      position: [s.position[0] * sx, s.position[1] * sy] as const,
    })),
    grounding: {
      keelFriction: base.grounding.keelFriction * sx * sy,
      rudderFriction: base.grounding.rudderFriction * sx * sy,
      hullFriction: base.grounding.hullFriction * sx * sy,
    },
    bilge: {
      ...base.bilge,
      bailBucketSize: base.bilge.bailBucketSize * sx * sy * sz,
    },
    hullDamage: { ...base.hullDamage },
    rudderDamage: { ...base.rudderDamage },
    sailDamage: {
      ...base.sailDamage,
      // Scale the force threshold with sail area (sx * sz) so damage
      // activation stays proportional to the bigger rig's loads.
      overpowerForceThreshold:
        base.sailDamage.overpowerForceThreshold * sx * sz,
    },
    tilt: {
      ...base.tilt,
      zHeights: {
        deck: base.tilt.zHeights.deck * sz,
        boom: base.tilt.zHeights.boom * sz,
        mastTop: base.tilt.zHeights.mastTop * sz,
        keel: base.tilt.zHeights.keel * sz,
        rudder: base.tilt.zHeights.rudder * sz,
        bowsprit: base.tilt.zHeights.bowsprit * sz,
      },
    },
    buoyancy: {
      ...base.buoyancy,
      zHeights: {
        deck: base.buoyancy.zHeights.deck * sz,
        boom: base.buoyancy.zHeights.boom * sz,
        mastTop: base.buoyancy.zHeights.mastTop * sz,
        keel: base.buoyancy.zHeights.keel * sz,
        rudder: base.buoyancy.zHeights.rudder * sz,
        bowsprit: base.buoyancy.zHeights.bowsprit * sz,
      },
    },
  };
}
