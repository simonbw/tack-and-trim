import { BaseEntity } from "../core/entity/BaseEntity";
import { GameEventMap } from "../core/entity/Entity";
import { on } from "../core/entity/handler";
import { Camera2d } from "../core/graphics/Camera2d";
import { lerpOrSnap, normalizeAngle } from "../core/util/MathUtil";
import { V } from "../core/Vector";
import { Boat } from "./boat/Boat";

//#tunable { min: 0.1, max: 5 }
let ZOOM_SPEED: number = 1.5;
//#tunable { min: 100, max: 5000 }
let PAN_SPEED: number = 1000;
//#tunable { min: 0.5, max: 20 }
let STIFFNESS: number = 4.0;

export class CameraController extends BaseEntity {
  tickLayer = "camera" as const;
  zTarget: number = 5;
  offset = V(0, 0);
  rotateWithBoat = false;

  constructor(
    private boat: Boat,
    private camera: Camera2d,
  ) {
    super();
  }

  setZoomTarget(z: number) {
    this.zTarget = z;
  }

  @on("keyDown")
  onKeyDown({ key }: GameEventMap["keyDown"]) {
    if (key === "KeyC") {
      this.rotateWithBoat = !this.rotateWithBoat;
    }
  }

  @on("tick")
  onTick({ dt }: GameEventMap["tick"]) {
    const boatPosition = this.boat.getPosition().add(this.offset);
    const boatVelocity = this.boat.getVelocity();
    this.camera.smoothCenter(boatPosition, boatVelocity, STIFFNESS);
    this.camera.smoothZoom(this.zTarget);

    // Smoothly rotate camera to match boat heading (or back to 0)
    // -π/2 - boatAngle makes the boat's forward direction point UP on screen
    const targetAngle = this.rotateWithBoat
      ? -Math.PI / 2 - this.boat.hull.getAngle()
      : 0;
    // Use shortest-path rotation via angle normalization
    const angleDiff = normalizeAngle(targetAngle - this.camera.angle);
    this.camera.angle = lerpOrSnap(
      this.camera.angle,
      this.camera.angle + angleDiff,
      0.9,
      0.001,
    );

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
