import BaseEntity from "../core/entity/BaseEntity";
import { GameEventMap } from "../core/entity/Entity";
import { Camera2d } from "../core/graphics/Camera2d";
import { V } from "../core/Vector";
import { Boat } from "./boat/Boat";

const ZOOM_SPEED = 0.75;

export class CameraController extends BaseEntity {
  tickLayer = "camera" as const;
  zTarget: number = 5;
  constructor(
    private boat: Boat,
    private camera: Camera2d,
  ) {
    super();
  }

  onTick(dt: GameEventMap["tick"]) {
    const boatPosition = this.boat.getPosition();
    const boatVelocity = V(this.boat.getVelocity()); // Convert ReadonlyV2d to V2d
    this.camera.smoothCenter(boatPosition, boatVelocity, 0.25);
    this.camera.smoothZoom(this.zTarget);

    if (this.game?.io.isKeyDown("Minus")) {
      this.zTarget -= this.zTarget * dt * ZOOM_SPEED;
    }
    if (this.game?.io.isKeyDown("Equal")) {
      this.zTarget += this.zTarget * dt * ZOOM_SPEED;
    }
  }
}
