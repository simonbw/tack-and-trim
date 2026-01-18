import { h } from "preact";
import BaseEntity from "../../core/entity/BaseEntity";
import { on } from "../../core/entity/handler";
import { V, type ReadonlyV2d } from "../../core/Vector";

export interface WorldLabelOptions {
  /** Offset from the anchor position in pixels (screen space) */
  offset?: ReadonlyV2d;
  /** Distance at which label starts fading (world units) */
  fadeStartDistance?: number;
  /** Distance at which label is fully invisible (world units) */
  fadeEndDistance?: number;
  /** CSS class name for styling */
  className?: string;
  /** Font size in pixels */
  fontSize?: number;
}

const DEFAULT_OPTIONS: Required<WorldLabelOptions> = {
  offset: V(0, -30),
  fadeStartDistance: 100,
  fadeEndDistance: 200,
  className: "world-label",
  fontSize: 14,
};

/**
 * Renders a text label in world space using a positioned DOM element.
 * The label follows a world position but renders as HTML text.
 */
export class WorldLabel extends BaseEntity {
  private el!: HTMLDivElement;
  private options: Required<WorldLabelOptions>;
  private visible: boolean = true;

  constructor(
    private getPosition: () => ReadonlyV2d,
    private getText: () => string,
    options: WorldLabelOptions = {}
  ) {
    super();
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    if (this.el) {
      this.el.style.display = visible ? "block" : "none";
    }
  }

  @on("add")
  onAdd() {
    this.el = document.createElement("div");
    this.el.className = this.options.className;
    this.el.style.cssText = `
      position: fixed;
      pointer-events: none;
      font-family: sans-serif;
      font-size: ${this.options.fontSize}px;
      font-weight: bold;
      color: white;
      text-shadow: 0 0 4px rgba(0,0,0,0.8), 0 0 8px rgba(0,0,0,0.5);
      text-align: center;
      white-space: nowrap;
      transform: translate(-50%, -50%);
      z-index: 100;
      transition: opacity 0.2s;
    `;
    document.body.append(this.el);
  }

  @on("destroy")
  onDestroy() {
    this.el?.remove();
  }

  @on("render")
  onRender() {
    if (!this.visible || !this.game) {
      if (this.el) this.el.style.opacity = "0";
      return;
    }

    const worldPos = this.getPosition();
    const camera = this.game.renderer.camera;

    // Convert world position to screen position
    const screenPos = camera.toScreen(V(worldPos));

    // Check if on screen
    const canvas = this.game.renderer.canvas;
    const margin = 50;
    const isOnScreen =
      screenPos.x >= -margin &&
      screenPos.x <= canvas.width + margin &&
      screenPos.y >= -margin &&
      screenPos.y <= canvas.height + margin;

    if (!isOnScreen) {
      this.el.style.opacity = "0";
      return;
    }

    // Calculate distance-based fade
    const boat = this.game.entities.getById("boat");
    let alpha = 1;

    if (boat && "getPosition" in boat) {
      const boatPos = (boat as { getPosition: () => ReadonlyV2d }).getPosition();
      const distance = V(boatPos).distanceTo(worldPos);

      if (distance > this.options.fadeEndDistance) {
        alpha = 0;
      } else if (distance > this.options.fadeStartDistance) {
        const fadeRange =
          this.options.fadeEndDistance - this.options.fadeStartDistance;
        alpha = 1 - (distance - this.options.fadeStartDistance) / fadeRange;
      }
    }

    // Update element position and text
    const [ox, oy] = this.options.offset;
    this.el.style.left = `${screenPos.x + ox}px`;
    this.el.style.top = `${screenPos.y + oy}px`;
    this.el.style.opacity = String(alpha);
    this.el.textContent = this.getText();
  }
}
