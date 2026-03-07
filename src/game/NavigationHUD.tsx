import { GameEventMap } from "../core/entity/Entity";
import { on } from "../core/entity/handler";
import { ReactEntity } from "../core/ReactEntity";
import type { V2d } from "../core/Vector";
import { Boat } from "./boat/Boat";
import "./NavigationHUD.css";
import { TerrainResources } from "./world/terrain/TerrainResources";

const MAP_MAX_POINTS_PER_CONTOUR = 220;
const MAP_PADDING_RATIO = 0.06;
const MIN_MAP_PADDING = 200;
const CARDINAL_DIRECTIONS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];

interface MapContourLine {
  readonly id: string;
  readonly points: string;
}

/**
 * Navigation HUD with a toggled parchment map (M) and a live boat heading compass.
 */
export class NavigationHUD extends ReactEntity {
  id = "navigationHud";
  renderLayer = "hud" as const;

  private isMapOpen = false;

  private terrainRef: TerrainResources | null = null;
  private mapTerrainVersion = -1;
  private mapContours: MapContourLine[] = [];
  private mapViewBox = "0 0 100 100";

  constructor() {
    super(() => this.renderContent());
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

    const boat = this.getBoat();
    const headingDegrees = this.getHeadingDegrees(boat);
    const headingLabel =
      CARDINAL_DIRECTIONS[
        Math.round(headingDegrees / 45) % CARDINAL_DIRECTIONS.length
      ];

    return (
      <div className="navigation-hud">
        <div className="navigation-hud__heading">
          <div className="navigation-hud__heading-ring">
            <span className="navigation-hud__heading-cardinal navigation-hud__heading-cardinal--n">
              N
            </span>
            <span className="navigation-hud__heading-cardinal navigation-hud__heading-cardinal--e">
              E
            </span>
            <span className="navigation-hud__heading-cardinal navigation-hud__heading-cardinal--s">
              S
            </span>
            <span className="navigation-hud__heading-cardinal navigation-hud__heading-cardinal--w">
              W
            </span>
            <div
              className="navigation-hud__heading-needle"
              style={{
                transform: `translate(-50%, -100%) rotate(${headingDegrees.toFixed(1)}deg)`,
                opacity: boat ? 1 : 0.25,
              }}
            />
            <div className="navigation-hud__heading-dot" />
          </div>
          <div className="navigation-hud__heading-label">
            {boat ? `${headingLabel} ${headingDegrees.toFixed(0)}°` : "No boat"}
          </div>
        </div>

        {this.isMapOpen && (
          <div className="navigation-hud__map-overlay">
            <div className="navigation-hud__map-sheet">
              <div className="navigation-hud__map-title">Sea Chart</div>
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
          textAnchor="middle"
        >
          N
        </text>
        <text
          x="79"
          y="54"
          className="navigation-hud__rose-label"
          textAnchor="middle"
        >
          E
        </text>
        <text
          x="50"
          y="87"
          className="navigation-hud__rose-label"
          textAnchor="middle"
        >
          S
        </text>
        <text
          x="21"
          y="54"
          className="navigation-hud__rose-label"
          textAnchor="middle"
        >
          W
        </text>
      </svg>
    );
  }

  private getBoat(): Boat | undefined {
    return this.game?.entities.getById("boat") as Boat | undefined;
  }

  private getHeadingDegrees(boat: Boat | undefined): number {
    if (!boat) return 0;
    const degrees = (boat.hull.body.angle * 180) / Math.PI + 90;
    return ((degrees % 360) + 360) % 360;
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
    const shorelineContours = contours.filter((contour) => contour.height >= 0);
    const visibleContours =
      shorelineContours.length > 0 ? shorelineContours : [...contours];

    const mapContours: MapContourLine[] = [];
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (let i = 0; i < visibleContours.length; i++) {
      const contour = visibleContours[i];
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
