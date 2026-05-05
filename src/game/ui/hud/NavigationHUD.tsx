import { GameEventMap } from "../../../core/entity/Entity";
import { on } from "../../../core/entity/handler";
import { ReactEntity } from "../../../core/ReactEntity";
import type { V2d } from "../../../core/Vector";
import { Boat } from "../../boat/Boat";
import type { CompassPalette } from "../../boat/BoatConfig";
import { Port } from "../../port/Port";
import { MissionManager } from "../../mission/MissionManager";
import "./NavigationHUD.css";
import { TerrainResources } from "../../world/terrain/TerrainResources";

function hexToCss(color: number): string {
  return `#${color.toString(16).padStart(6, "0")}`;
}

const FALLBACK_COMPASS: CompassPalette = {
  bezel: 0xffffff,
  face: 0x0a1424,
  ink: 0xfafafa,
  inkSoft: 0x9aa6b8,
  north: 0xe8463c,
  rayNorth: 0xe8463c,
  rayCardinal: 0x9aa6b8,
  lubber: 0xffc45a,
  label: 0xfafafa,
};

const MAP_MAX_POINTS_PER_CONTOUR = 220;
const MAP_PADDING_RATIO = 0.06;
const MIN_MAP_PADDING = 200;
const CARDINAL_DIRECTIONS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];

type CompassLabelKind = "north" | "cardinal" | "intercardinal";
const COMPASS_LABELS: ReadonlyArray<{
  bearing: number;
  text: string;
  kind: CompassLabelKind;
}> = [
  { bearing: 0, text: "N", kind: "north" },
  { bearing: 45, text: "NE", kind: "intercardinal" },
  { bearing: 90, text: "E", kind: "cardinal" },
  { bearing: 135, text: "SE", kind: "intercardinal" },
  { bearing: 180, text: "S", kind: "cardinal" },
  { bearing: 225, text: "SW", kind: "intercardinal" },
  { bearing: 270, text: "W", kind: "cardinal" },
  { bearing: 315, text: "NW", kind: "intercardinal" },
];

const COMPASS_TICKS: ReadonlyArray<{ bearing: number; major: boolean }> =
  Array.from({ length: 36 }, (_, i) => ({
    bearing: i * 10,
    major: (i * 10) % 30 === 0,
  }));

function formatLevelName(levelName: string): string {
  const spaced = levelName.replace(/([A-Z])/g, " $1");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

interface MapContourLine {
  readonly id: string;
  readonly points: string;
}

/**
 * Navigation HUD with a toggled parchment map (M) and a live boat heading compass.
 */
export class NavigationHUD extends ReactEntity {
  id = "navigationHud";

  private isMapOpen = false;
  private mapTitle: string;

  private terrainRef: TerrainResources | null = null;
  private mapTerrainVersion = -1;
  private mapContours: MapContourLine[] = [];
  private mapViewBox = "0 0 100 100";

  constructor(levelName?: string) {
    super(() => this.renderContent());
    this.mapTitle = levelName ? formatLevelName(levelName) : "Sea Chart";
  }

  @on("keyDown")
  onKeyDown({ key, event }: GameEventMap["keyDown"]): void {
    if (key !== "KeyM") return;
    event.preventDefault();
    this.isMapOpen = !this.isMapOpen;
    this.reactRender();
  }

  private renderContent() {
    this.updateMapCache();

    const headingDegrees = this.getHeadingDegrees();
    const headingLabel =
      CARDINAL_DIRECTIONS[
        Math.round(headingDegrees / 45) % CARDINAL_DIRECTIONS.length
      ];

    const headingText = headingDegrees.toFixed(0).padStart(3, "0");

    const compass = this.getCompassPalette();
    const showRose =
      compass.rayNorth !== undefined && compass.rayCardinal !== undefined;
    const compassStyle: Record<string, string> = {
      "--compass-bezel": hexToCss(compass.bezel),
      "--compass-face": hexToCss(compass.face),
      "--compass-ink": hexToCss(compass.ink),
      "--compass-ink-soft": hexToCss(compass.inkSoft),
      "--compass-north": hexToCss(compass.north),
      "--compass-lubber": hexToCss(compass.lubber),
      "--compass-label": hexToCss(compass.label),
      "--compass-font": compass.font ?? "var(--font-body)",
      "--compass-font-weight": String(compass.fontWeight ?? 700),
    };
    if (showRose) {
      compassStyle["--compass-ray-north"] = hexToCss(compass.rayNorth!);
      compassStyle["--compass-ray-cardinal"] = hexToCss(compass.rayCardinal!);
    }

    return (
      <div className="navigation-hud">
        <div className="navigation-hud__heading" style={compassStyle}>
          <div className="navigation-hud__heading-label">
            {`${headingText}° ${headingLabel}`}
          </div>
          <svg
            className="navigation-hud__compass"
            viewBox="0 0 100 100"
            aria-label={`Heading ${headingText} degrees ${headingLabel}`}
          >
            <circle
              cx="50"
              cy="50"
              r="48"
              className="navigation-hud__compass-bezel"
            />
            <circle
              cx="50"
              cy="50"
              r="45"
              className="navigation-hud__compass-face"
            />
            <g
              transform={`rotate(${(-headingDegrees).toFixed(2)} 50 50)`}
              className="navigation-hud__compass-card"
            >
              {showRose && (
                <>
                  <polygon
                    points="70,50 50,47 30,50 50,53"
                    className="navigation-hud__compass-ray navigation-hud__compass-ray--cardinal"
                  />
                  <polygon
                    points="50,30 53,50 50,70 47,50"
                    className="navigation-hud__compass-ray navigation-hud__compass-ray--north"
                  />
                </>
              )}
              {COMPASS_TICKS.map((tick) => (
                <line
                  key={`tick-${tick.bearing}`}
                  x1="50"
                  y1="6"
                  x2="50"
                  y2={tick.major ? "12" : "9.5"}
                  transform={`rotate(${tick.bearing} 50 50)`}
                  className={
                    tick.major
                      ? "navigation-hud__compass-tick navigation-hud__compass-tick--major"
                      : "navigation-hud__compass-tick navigation-hud__compass-tick--minor"
                  }
                />
              ))}
              {COMPASS_LABELS.map((label) => (
                <text
                  key={`label-${label.text}`}
                  x="50"
                  y="24"
                  text-anchor="middle"
                  dominant-baseline="central"
                  transform={`rotate(${label.bearing} 50 50)`}
                  className={`navigation-hud__compass-label navigation-hud__compass-label--${label.kind}`}
                >
                  {label.text}
                </text>
              ))}
            </g>
            <polygon
              points="46,0.5 54,0.5 50,7"
              className="navigation-hud__compass-lubber"
            />
            <circle
              cx="50"
              cy="50"
              r="1.6"
              className="navigation-hud__compass-pivot"
            />
          </svg>
        </div>

        {this.isMapOpen && (
          <div className="navigation-hud__map-overlay">
            <div className="navigation-hud__map-sheet">
              <div className="navigation-hud__map-title">{this.mapTitle}</div>
              {this.mapContours.length > 0 ? (
                <svg
                  className="navigation-hud__map-svg"
                  viewBox={this.mapViewBox}
                  preserveAspectRatio="xMidYMid meet"
                  aria-label="Map overlay"
                >
                  {this.mapContours.map((line) => (
                    <polygon
                      key={line.id}
                      points={line.points}
                      className="navigation-hud__map-line"
                    />
                  ))}
                  {this.renderMapMarkers()}
                </svg>
              ) : (
                <div className="navigation-hud__map-empty">
                  No shoreline data available
                </div>
              )}
              <div className="navigation-hud__map-tip">Press M to close</div>
              <div className="navigation-hud__map-rose">
                {this.renderCompassRose()}
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  private renderCompassRose() {
    return (
      <svg viewBox="0 0 100 100" aria-hidden="true">
        <circle cx="50" cy="50" r="42" className="navigation-hud__rose-ring" />
        <line
          x1="50"
          y1="11"
          x2="50"
          y2="89"
          className="navigation-hud__rose-axis"
        />
        <line
          x1="11"
          y1="50"
          x2="89"
          y2="50"
          className="navigation-hud__rose-axis"
        />
        <line
          x1="22"
          y1="22"
          x2="78"
          y2="78"
          className="navigation-hud__rose-axis navigation-hud__rose-axis--minor"
        />
        <line
          x1="78"
          y1="22"
          x2="22"
          y2="78"
          className="navigation-hud__rose-axis navigation-hud__rose-axis--minor"
        />
        <polygon
          points="50,8 56,26 50,22 44,26"
          className="navigation-hud__rose-north"
        />
        <text
          x="50"
          y="23"
          className="navigation-hud__rose-label"
          text-anchor="middle"
        >
          N
        </text>
        <text
          x="79"
          y="54"
          className="navigation-hud__rose-label"
          text-anchor="middle"
        >
          E
        </text>
        <text
          x="50"
          y="87"
          className="navigation-hud__rose-label"
          text-anchor="middle"
        >
          S
        </text>
        <text
          x="21"
          y="54"
          className="navigation-hud__rose-label"
          text-anchor="middle"
        >
          W
        </text>
      </svg>
    );
  }

  private renderMapMarkers() {
    const ports = this.game?.entities.getTagged("port") ?? [];
    const missionManager =
      this.game?.entities.tryGetSingleton(MissionManager) ?? null;
    const activeMission = missionManager?.getActiveMission() ?? null;
    const destinationPortId =
      activeMission?.def.type === "delivery"
        ? activeMission.def.destinationPortId
        : null;

    // Scale marker sizes relative to the map — read viewBox dimensions
    const vbParts = this.mapViewBox.split(" ").map(Number);
    const vbSize = Math.max(vbParts[2] ?? 100, vbParts[3] ?? 100);
    const markerR = vbSize * 0.003;
    const fontSize = vbSize * 0.022;

    return (
      <>
        {[...ports].map((entity) => {
          const port = entity as Port;
          const pos = port.getPosition();
          const isDestination = port.getId() === destinationPortId;
          return (
            <g key={port.getId()}>
              <circle
                cx={pos.x.toFixed(1)}
                cy={pos.y.toFixed(1)}
                r={markerR}
                className={`navigation-hud__map-port ${isDestination ? "navigation-hud__map-port--destination" : ""}`}
              />
              <text
                x={pos.x.toFixed(1)}
                y={(pos.y - markerR * 2.2).toFixed(1)}
                text-anchor="middle"
                className="navigation-hud__map-port-label"
                style={{ fontSize: `${fontSize}px` }}
              >
                {port.getName()}
              </text>
            </g>
          );
        })}
      </>
    );
  }

  private getHeadingDegrees(): number {
    const boat = this.game?.entities.getById("boat") as Boat | undefined;
    if (!boat) return 0;
    const degrees = (boat.hull.body.angle * 180) / Math.PI + 90;
    return ((degrees % 360) + 360) % 360;
  }

  private getCompassPalette(): CompassPalette {
    const boat = this.game?.entities.getById("boat") as Boat | undefined;
    return boat?.config.compass ?? FALLBACK_COMPASS;
  }

  private updateMapCache(): void {
    const terrain = this.game?.entities.tryGetSingleton(TerrainResources);

    if (!terrain) {
      this.terrainRef = null;
      this.mapTerrainVersion = -1;
      this.mapContours = [];
      this.mapViewBox = "0 0 100 100";
      return;
    }

    const terrainVersion = terrain.getVersion();
    if (
      this.terrainRef === terrain &&
      this.mapTerrainVersion === terrainVersion
    ) {
      return;
    }

    this.terrainRef = terrain;
    this.mapTerrainVersion = terrainVersion;

    const contours = terrain.getContours();
    const coastlineContours = contours.filter(
      (contour) => contour.height === 0,
    );

    const mapContours: MapContourLine[] = [];
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (let i = 0; i < coastlineContours.length; i++) {
      const contour = coastlineContours[i];
      const sampled = this.simplifyContour(contour.sampledPolygon);
      if (sampled.length < 3) continue;

      for (const point of sampled) {
        if (point.x < minX) minX = point.x;
        if (point.y < minY) minY = point.y;
        if (point.x > maxX) maxX = point.x;
        if (point.y > maxY) maxY = point.y;
      }

      mapContours.push({
        id: `${i}-${contour.height}`,
        points: sampled
          .map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`)
          .join(" "),
      });
    }

    this.mapContours = mapContours;

    if (
      !isFinite(minX) ||
      !isFinite(minY) ||
      !isFinite(maxX) ||
      !isFinite(maxY)
    ) {
      this.mapViewBox = "0 0 100 100";
      return;
    }

    const width = Math.max(maxX - minX, 1);
    const height = Math.max(maxY - minY, 1);
    const padding = Math.max(
      Math.max(width, height) * MAP_PADDING_RATIO,
      MIN_MAP_PADDING,
    );

    this.mapViewBox = `${(minX - padding).toFixed(1)} ${(minY - padding).toFixed(1)} ${(width + padding * 2).toFixed(1)} ${(height + padding * 2).toFixed(1)}`;
  }

  private simplifyContour(points: readonly V2d[]): V2d[] {
    if (points.length <= MAP_MAX_POINTS_PER_CONTOUR) {
      return [...points];
    }

    const stride = Math.ceil(points.length / MAP_MAX_POINTS_PER_CONTOUR);
    const result: V2d[] = [];
    for (let i = 0; i < points.length; i += stride) {
      result.push(points[i]);
    }
    return result;
  }
}
