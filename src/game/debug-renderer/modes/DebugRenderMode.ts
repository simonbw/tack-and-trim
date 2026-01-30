import { JSX } from "preact";
import { BaseEntity } from "../../../core/entity/BaseEntity";

/** Base class for all debug modes */
export abstract class DebugRenderMode extends BaseEntity {
  /** Get the display name of this debug mode */
  abstract getModeName(): JSX.Element | string | null;
  /** Get HUD info content for this debug mode */
  getHudInfo(): JSX.Element | string | null {
    return null;
  }
  /** Get cursor info content for this debug mode */
  getCursorInfo(): JSX.Element | string | null {
    return null;
  }
}
