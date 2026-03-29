/**
 * Top toolbar for the boat editor.
 * File operations, presets, undo/redo, and view presets.
 */

import type { BoatEditorController } from "../BoatEditorController";
import { BOAT_PRESETS } from "../BoatEditorController";
import "../../editor/ui/EditorStyles.css";

export interface BoatEditorToolbarProps {
  controller: BoatEditorController;
}

export function BoatEditorToolbar({ controller }: BoatEditorToolbarProps) {
  const doc = controller.document;
  const isDirty = doc.isDirty;
  const canUndo = doc.canUndo;
  const canRedo = doc.canRedo;

  return (
    <div class="editor-toolbar">
      <span class="editor-toolbar-title">Boat Editor</span>
      {isDirty && <span class="editor-toolbar-dirty">*</span>}

      <div class="editor-toolbar-group">
        <select
          class="editor-btn"
          onChange={(e) => {
            const name = (e.target as HTMLSelectElement).value;
            if (name) controller.loadPreset(name);
          }}
        >
          <option value="">Load Preset...</option>
          {Object.keys(BOAT_PRESETS).map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
        <button
          class="editor-btn"
          onClick={() => controller.importJSON()}
          title="Import JSON (Ctrl+O)"
        >
          Import
        </button>
        <button
          class="editor-btn editor-btn-primary"
          onClick={() => controller.exportJSON()}
          title="Export JSON (Ctrl+S)"
        >
          Export
        </button>
      </div>

      <div class="editor-toolbar-group">
        <button
          class="editor-btn"
          onClick={() => doc.undo()}
          disabled={!canUndo}
          title="Undo (Ctrl+Z)"
        >
          Undo
        </button>
        <button
          class="editor-btn"
          onClick={() => doc.redo()}
          disabled={!canRedo}
          title="Redo (Ctrl+Shift+Z)"
        >
          Redo
        </button>
      </div>
    </div>
  );
}
