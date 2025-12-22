import BaseEntity from "../core/entity/BaseEntity";
import { createGraphics } from "../core/entity/GameSprite";

export class Water extends BaseEntity {
  constructor() {
    super();

    const graphics = createGraphics("water");

    graphics.rect(-10000, -10000, 20000, 20000).fill({ color: 0x3399ff });

    this.sprite = graphics;
  }
}
