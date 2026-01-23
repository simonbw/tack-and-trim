/**
 * Contour properties panel component.
 *
 * Side panel showing properties for the selected contour.
 */

import {
  DeleteContourCommand,
  EditorDocument,
  SetContourPropertyCommand,
} from "../EditorDocument";
import { EditorContour } from "../io/TerrainFileFormat";
import "./EditorStyles.css";

export interface ContourPanelProps {
  document: EditorDocument;
}

/**
 * Get contour color based on height.
 */
function getContourColorHex(height: number): string {
  if (height === 0) {
    return "#44aa44";
  } else if (height < 0) {
    const t = Math.min(-height / 50, 1);
    const r = Math.round(50 * (1 - t));
    const g = Math.round(100 + 50 * (1 - t));
    const b = Math.round(180 + 75 * (1 - t));
    return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
  } else {
    const t = Math.min(height / 20, 1);
    const r = Math.round(140 + 60 * t);
    const g = Math.round(100 + 40 * t);
    const b = Math.round(60 + 20 * t);
    return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
  }
}

function ContourList({
  document,
  contours,
  selectedIndex,
}: {
  document: EditorDocument;
  contours: readonly EditorContour[];
  selectedIndex: number | null;
}) {
  if (contours.length === 0) {
    return <div class="contour-panel-empty">No contours</div>;
  }

  return (
    <div class="contour-list">
      {contours.map((contour, index) => (
        <div
          key={index}
          class={`contour-list-item ${selectedIndex === index ? "selected" : ""}`}
          onClick={() => document.selectContour(index)}
        >
          <span
            class="height-swatch"
            style={{ background: getContourColorHex(contour.height) }}
          />
          <span class="contour-list-item-name">
            {contour.name || `Contour ${index + 1}`}
          </span>
          <span class="contour-list-item-height">
            {contour.height === 0
              ? "Shore"
              : contour.height < 0
                ? `${contour.height} ft`
                : `+${contour.height} ft`}
          </span>
        </div>
      ))}
    </div>
  );
}

function ContourProperties({
  document,
  contour,
  contourIndex,
}: {
  document: EditorDocument;
  contour: EditorContour;
  contourIndex: number;
}) {
  const handleNameChange = (e: Event) => {
    const value = (e.target as HTMLInputElement).value;
    const command = new SetContourPropertyCommand(
      document,
      contourIndex,
      "name",
      contour.name,
      value,
    );
    document.executeCommand(command);
  };

  const handleHeightChange = (e: Event) => {
    const value = parseFloat((e.target as HTMLInputElement).value) || 0;
    const command = new SetContourPropertyCommand(
      document,
      contourIndex,
      "height",
      contour.height,
      value,
    );
    document.executeCommand(command);
  };

  const handleHillFrequencyChange = (e: Event) => {
    const value = parseFloat((e.target as HTMLInputElement).value) || 0.01;
    const command = new SetContourPropertyCommand(
      document,
      contourIndex,
      "hillFrequency",
      contour.hillFrequency,
      value,
    );
    document.executeCommand(command);
  };

  const handleHillAmplitudeChange = (e: Event) => {
    const value = parseFloat((e.target as HTMLInputElement).value) || 0;
    const command = new SetContourPropertyCommand(
      document,
      contourIndex,
      "hillAmplitude",
      contour.hillAmplitude,
      value,
    );
    document.executeCommand(command);
  };

  const handleDelete = () => {
    if (confirm(`Delete "${contour.name || `Contour ${contourIndex + 1}`}"?`)) {
      const command = new DeleteContourCommand(document, contourIndex);
      document.executeCommand(command);
      document.clearSelection();
    }
  };

  return (
    <div class="contour-panel-content">
      <div class="contour-panel-row">
        <label class="contour-panel-label">Name</label>
        <input
          type="text"
          class="contour-panel-input"
          value={contour.name || ""}
          placeholder={`Contour ${contourIndex + 1}`}
          onBlur={handleNameChange}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              (e.target as HTMLInputElement).blur();
            }
          }}
        />
      </div>

      <div class="contour-panel-row">
        <div class="contour-panel-row-inline">
          <label class="contour-panel-label">Height (ft)</label>
          <span class="contour-panel-value">{contour.height}</span>
        </div>
        <input
          type="range"
          class="contour-panel-slider"
          min="-50"
          max="20"
          step="1"
          value={contour.height}
          onInput={handleHeightChange}
        />
      </div>

      <div class="contour-panel-row">
        <div class="contour-panel-row-inline">
          <label class="contour-panel-label">Hill Frequency</label>
          <span class="contour-panel-value">
            {contour.hillFrequency.toFixed(3)}
          </span>
        </div>
        <input
          type="range"
          class="contour-panel-slider"
          min="0.001"
          max="0.05"
          step="0.001"
          value={contour.hillFrequency}
          onInput={handleHillFrequencyChange}
        />
      </div>

      <div class="contour-panel-row">
        <div class="contour-panel-row-inline">
          <label class="contour-panel-label">Hill Amplitude</label>
          <span class="contour-panel-value">
            {contour.hillAmplitude.toFixed(2)}
          </span>
        </div>
        <input
          type="range"
          class="contour-panel-slider"
          min="0"
          max="1"
          step="0.05"
          value={contour.hillAmplitude}
          onInput={handleHillAmplitudeChange}
        />
      </div>

      <div class="contour-panel-row">
        <label class="contour-panel-label">Points</label>
        <span>{contour.controlPoints.length} control points</span>
      </div>

      <button
        class="editor-btn"
        style={{ marginTop: "8px", background: "rgba(200, 60, 60, 0.3)" }}
        onClick={handleDelete}
      >
        Delete Contour
      </button>
    </div>
  );
}

export function ContourPanel({ document }: ContourPanelProps) {
  const contours = document.getContours();
  const selection = document.getSelection();
  const selectedContour = document.getSelectedContour();

  return (
    <div class="contour-panel">
      <div class="contour-panel-header">
        <span>Contours</span>
        <span style={{ fontSize: "11px", opacity: 0.6 }}>
          {contours.length} total
        </span>
      </div>

      <ContourList
        document={document}
        contours={contours}
        selectedIndex={selection.contourIndex}
      />

      {selectedContour && selection.contourIndex !== null && (
        <ContourProperties
          document={document}
          contour={selectedContour}
          contourIndex={selection.contourIndex}
        />
      )}

      {!selectedContour && contours.length > 0 && (
        <div class="contour-panel-empty">Select a contour to edit</div>
      )}
    </div>
  );
}
