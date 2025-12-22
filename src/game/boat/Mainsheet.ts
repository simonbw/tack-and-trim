import { Graphics } from "pixi.js";
import BaseEntity from "../../core/entity/BaseEntity";
import { createGraphics, GameSprite } from "../../core/entity/GameSprite";
import RopeSpring from "../../core/physics/RopeSpring";
import { V } from "../../core/Vector";
import { Hull } from "./Hull";
import { Rig } from "./Rig";

const MAINSHEET_BOOM_ATTACH_RATIO = 0.8; // attach near end of boom
const MAINSHEET_HULL_ATTACH = V(-5, 0); // cockpit area on hull
const MAINSHEET_LENGTH = 20;
const MAINSHEET_STIFFNESS = 500;
const MAINSHEET_DAMPING = 10;

export class Mainsheet extends BaseEntity {
  private mainsheetSprite: GameSprite & Graphics;
  private spring: RopeSpring;
  private boomAttachLocal: ReturnType<typeof V>;

  constructor(
    private hull: Hull,
    private rig: Rig
  ) {
    super();

    this.mainsheetSprite = createGraphics("main");
    this.sprite = this.mainsheetSprite;

    // Calculate boom attach point from rig's boom length
    this.boomAttachLocal = V(-this.rig.getBoomLength() * MAINSHEET_BOOM_ATTACH_RATIO, 0);

    this.spring = new RopeSpring(this.rig.body, this.hull.body, {
      localAnchorA: [this.boomAttachLocal.x, this.boomAttachLocal.y],
      localAnchorB: [MAINSHEET_HULL_ATTACH.x, MAINSHEET_HULL_ATTACH.y],
      restLength: MAINSHEET_LENGTH,
      stiffness: MAINSHEET_STIFFNESS,
      damping: MAINSHEET_DAMPING,
    });

    this.springs = [this.spring];
  }

  onRender() {
    const [x, y] = this.hull.body.position;
    const [mx, my] = this.rig.getMastWorldPosition();

    const boomAttachWorld = this.boomAttachLocal
      .rotate(this.rig.body.angle)
      .iadd([mx, my]);
    const hullAttachWorld = MAINSHEET_HULL_ATTACH.rotate(
      this.hull.body.angle
    ).iadd([x, y]);

    this.mainsheetSprite.clear();
    this.mainsheetSprite
      .moveTo(boomAttachWorld.x, boomAttachWorld.y)
      .lineTo(hullAttachWorld.x, hullAttachWorld.y)
      .stroke({ color: 0x444444, width: 1 });
  }
}
