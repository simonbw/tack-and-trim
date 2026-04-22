/**
 * Boat editor UI entity.
 * Renders toolbar and property panels using Preact.
 */

import { ReactEntity } from "../core/ReactEntity";
import type { BoatEditorCameraController } from "./BoatEditorCameraController";
import type { BoatEditorController } from "./BoatEditorController";
import { BoatEditorToolbar } from "./ui/BoatEditorToolbar";
import { BoatPropertyPanels } from "./ui/BoatPropertyPanels";
import { OrientationHud } from "./ui/OrientationHud";
import { h, Fragment } from "preact";

export class BoatEditorUI extends ReactEntity {
  constructor(
    private controller: BoatEditorController,
    private camera: BoatEditorCameraController,
  ) {
    super(() => {
      return h(
        Fragment,
        null,
        h(BoatEditorToolbar, { controller: this.controller }),
        h(BoatPropertyPanels, { controller: this.controller }),
        h(OrientationHud, { camera: this.camera }),
      );
    }, true);
  }
}
