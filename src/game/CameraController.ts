import BaseEntity from "../core/entity/BaseEntity";
import { Camera2d } from "../core/graphics/Camera2d";
import { Boat } from "./Boat";

export class CameraController extends BaseEntity {
  constructor(
    private boat: Boat,
    private camera: Camera2d
  ) {
    super();
  }

  onTick() {
    const boatPosition = this.boat.getPosition();
    // this.camera.smoothCenter(boatPosition);
    this.camera.smoothZoom(1.0);
  }
}
