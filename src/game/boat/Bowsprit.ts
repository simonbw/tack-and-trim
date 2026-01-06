import { Graphics } from "pixi.js";
import BaseEntity from "../../core/entity/BaseEntity";
import { createGraphics, GameSprite } from "../../core/entity/GameSprite";
import { V, V2d } from "../../core/Vector";
import { Hull } from "./Hull";

// Bowsprit dimensions
const BOWSPRIT_LENGTH = 12;
const BOWSPRIT_WIDTH = 1.5;

// Where the bowsprit attaches to the hull (at the bow)
const BOWSPRIT_ATTACH_POINT = 27;

/** The tip of the bowsprit in hull-local coordinates */
export const BOWSPRIT_TIP_POSITION = V(BOWSPRIT_ATTACH_POINT + BOWSPRIT_LENGTH, 0);

export class Bowsprit extends BaseEntity {
  private bowspritSprite: GameSprite & Graphics;

  constructor(readonly hull: Hull) {
    super();

    // Bowsprit visual - a spar extending forward from the bow
    this.bowspritSprite = createGraphics("main");
    this.bowspritSprite
      .rect(0, -BOWSPRIT_WIDTH / 2, BOWSPRIT_LENGTH, BOWSPRIT_WIDTH)
      .fill({ color: 0x997744 })
      .stroke({ color: 0x775533, width: 0.5 });

    this.sprite = this.bowspritSprite;
  }

  onRender() {
    const [x, y] = this.hull.body.toWorldFrame(V(BOWSPRIT_ATTACH_POINT, 0));
    this.bowspritSprite.position.set(x, y);
    this.bowspritSprite.rotation = this.hull.body.angle;
  }
}
