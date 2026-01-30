/**
 * Editor entry point.
 *
 * Initializes the game engine for the terrain editor and loads
 * the EditorController to manage the editing session.
 */

import { Game } from "../core/Game";
import { EditorController } from "./EditorController";

// Editor-specific debug interface
interface EditorDebug {
  game?: Game;
  editor?: EditorController;
}

async function main() {
  // Create game with standard tick rate
  const game = new Game({ ticksPerSecond: 120 });

  // Initialize with editor-appropriate background color (dark blue-gray)
  await game.init({
    rendererOptions: {
      backgroundColor: 0x1a1a2e,
    },
  });

  // Make the game accessible from the console
  const debug: EditorDebug = { game };
  (window as unknown as { EDITOR_DEBUG: EditorDebug }).EDITOR_DEBUG = debug;

  // Add the editor controller
  const editor = game.addEntity(new EditorController());
  debug.editor = editor;

  // Clean up resources when the page is unloaded
  window.addEventListener("beforeunload", (e) => {
    if (debug.editor?.getDocument().getIsDirty()) {
      e.preventDefault();
    }
    game.destroy();
  });

  console.log(
    "%cLevel Editor Loaded",
    "color: #44aa44; font-weight: bold; font-size: 14px",
  );
  console.log("Controls:");
  console.log("  Pan: Middle-drag or Space+drag");
  console.log("  Zoom: Scroll wheel");
  console.log("  Select point: Click");
  console.log("  Multi-select: Shift+Click");
  console.log("  Move points: Drag selected points");
  console.log("  Add point: Click on spline");
  console.log("  Delete points: Delete/Backspace");
  console.log("  Undo: Ctrl/Cmd+Z");
  console.log("  Redo: Ctrl/Cmd+Shift+Z or Ctrl/Cmd+Y");
  console.log("  Save: Ctrl/Cmd+S");
  console.log("  Open: Ctrl/Cmd+O");
  console.log("  Fit to view: Home");
}

window.addEventListener("load", main);
