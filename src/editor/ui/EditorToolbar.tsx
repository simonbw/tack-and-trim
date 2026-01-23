/**
 * Editor toolbar component.
 *
 * Top bar with file operations, tools, and undo/redo.
 */

import { EditorDocument } from "../EditorDocument";
import { EditorController } from "../EditorController";
import "./EditorStyles.css";

export interface EditorToolbarProps {
  document: EditorDocument;
  controller: EditorController;
}

export function EditorToolbar({
  document: editorDoc,
  controller,
}: EditorToolbarProps) {
  const isDirty = editorDoc.getIsDirty();
  const canUndo = editorDoc.canUndo();
  const canRedo = editorDoc.canRedo();

  return (
    <div class="editor-toolbar">
      <span class="editor-toolbar-title">Terrain Editor</span>
      {isDirty && <span class="editor-toolbar-dirty">*</span>}

      <div class="editor-toolbar-group">
        <button
          class="editor-btn"
          onClick={() => controller.newTerrain()}
          title="New terrain (Ctrl+N)"
        >
          New
        </button>
        <button
          class="editor-btn"
          onClick={() => {
            const input = document.createElement("input");
            input.type = "file";
            input.accept = ".json,.terrain.json";
            input.onchange = async () => {
              const file = input.files?.[0];
              if (file) {
                try {
                  await controller.loadFromFile(file);
                } catch (error) {
                  alert(`Failed to load: ${error}`);
                }
              }
            };
            input.click();
          }}
          title="Open file (Ctrl+O)"
        >
          Open
        </button>
        <button
          class="editor-btn editor-btn-primary"
          onClick={() => controller.downloadJson()}
          title="Save file (Ctrl+S)"
        >
          Save
        </button>
        <button
          class="editor-btn"
          onClick={async () => {
            await controller.copyToClipboard();
            alert("Terrain JSON copied to clipboard!");
          }}
          title="Copy JSON to clipboard"
        >
          Copy
        </button>
      </div>

      <div class="editor-toolbar-group">
        <button
          class="editor-btn"
          onClick={() => editorDoc.undo()}
          disabled={!canUndo}
          title={
            canUndo
              ? `Undo: ${editorDoc.getUndoDescription()}`
              : "Nothing to undo"
          }
        >
          Undo
        </button>
        <button
          class="editor-btn"
          onClick={() => editorDoc.redo()}
          disabled={!canRedo}
          title={
            canRedo
              ? `Redo: ${editorDoc.getRedoDescription()}`
              : "Nothing to redo"
          }
        >
          Redo
        </button>
      </div>

      <div class="editor-toolbar-group">
        <button
          class="editor-btn"
          onClick={() => controller.addNewContour()}
          title="Add a new contour"
        >
          + Contour
        </button>
      </div>
    </div>
  );
}
