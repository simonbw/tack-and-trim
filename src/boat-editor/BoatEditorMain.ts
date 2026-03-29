/**
 * Boat editor entry point.
 *
 * Initializes the game engine for the boat definition editor and loads
 * the BoatEditorController to manage the editing session.
 */

import { Game } from "../core/Game";
import "../fonts.css";
import { registerManifestFonts } from "../core/resources/fonts";
import { RESOURCES } from "../../resources/resources";
import { BoatEditorController } from "./BoatEditorController";

interface BoatEditorDebug {
  game?: Game;
  editor?: BoatEditorController;
}

async function main() {
  await registerManifestFonts(RESOURCES.fonts);

  const game = new Game({ ticksPerSecond: 120 });

  await game.init({
    rendererOptions: {
      backgroundColor: 0x1a1a2e,
    },
  });

  const debug: BoatEditorDebug = { game };
  (
    window as unknown as { BOAT_EDITOR_DEBUG: BoatEditorDebug }
  ).BOAT_EDITOR_DEBUG = debug;

  const editor = game.addEntity(new BoatEditorController());
  debug.editor = editor;

  window.addEventListener("beforeunload", (e) => {
    if (debug.editor?.document.isDirty) {
      e.preventDefault();
    }
    game.destroy();
  });

  console.log(
    "%cBoat Editor Loaded",
    "color: #44aa44; font-weight: bold; font-size: 14px",
  );
  console.log("Controls:");
  console.log("  Orbit: Left-drag");
  console.log("  Pan: Middle-drag or Space+drag");
  console.log("  Zoom: Scroll wheel");
  console.log("  Undo: Ctrl/Cmd+Z");
  console.log("  Redo: Ctrl/Cmd+Shift+Z or Ctrl/Cmd+Y");
}

window.addEventListener("load", main);
