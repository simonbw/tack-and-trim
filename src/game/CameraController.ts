import { BaseEntity } from "../core/entity/BaseEntity";
import { GameEventMap } from "../core/entity/Entity";
import { on } from "../core/entity/handler";
import { Camera2d } from "../core/graphics/Camera2d";
import { V } from "../core/Vector";
import { Boat } from "./boat/Boat";

//#tunable { min: 0.1, max: 3 }
let ZOOM_SPEED: number = 0.75;
//#tunable { min: 100, max: 5000 }
let PAN_SPEED: number = 1000;
//#tunable { min: 0.5, max: 20 }
let STIFFNESS: number = 4.0;

export class CameraController extends BaseEntity {
  tickLayer = "camera" as const;
  zTarget: number = 5;
  offset = V(0, 0);

  constructor(
    private boat: Boat,
    private camera: Camera2d,
  ) {
    super();
  }

  setZoomTarget(z: number) {
    this.zTarget = z;
  }

  @on("tick")
  onTick({ dt }: GameEventMap["tick"]) {
    const boatPosition = this.boat.getPosition().add(this.offset);
    const boatVelocity = this.boat.getVelocity(); // Convert ReadonlyV2d to V2d
    this.camera.smoothCenter(boatPosition, boatVelocity, STIFFNESS);
    this.camera.smoothZoom(this.zTarget);

    if (this.game.io.isKeyDown("Minus")) {
      this.zTarget -= this.zTarget * dt * ZOOM_SPEED;
    }
    if (this.game.io.isKeyDown("Equal")) {
      this.zTarget += this.zTarget * dt * ZOOM_SPEED;
    }

    const panAmount = (PAN_SPEED * dt) / this.camera.z;

    if (this.game.io.isKeyDown("ArrowDown")) {
      this.offset.y += panAmount;
    }
    if (this.game.io.isKeyDown("ArrowUp")) {
      this.offset.y -= panAmount;
    }
    if (this.game.io.isKeyDown("ArrowLeft")) {
      this.offset.x -= panAmount;
    }
    if (this.game.io.isKeyDown("ArrowRight")) {
      this.offset.x += panAmount;
    }
  }
}
