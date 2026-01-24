/**
 * Contour properties panel component.
 *
 * Side panel showing properties for the selected contour.
 */

import { Fragment } from "preact";
import {
  DeleteContourCommand,
  EditorDocument,
  SetContourPropertyCommand,
} from "../EditorDocument";
import { EditorContour } from "../io/TerrainFileFormat";
import { ContourValidationResult } from "../../game/world-data/terrain/ContourValidation";
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

  const validationResults = document.getValidationResults();
  const hierarchy = document.buildHierarchy();

  const renderContourNode = (index: number, depth: number) => {
    const contour = contours[index];
    if (!contour) return null;

    const isInvalid = !validationResults[index]?.isValid;
    const children = hierarchy.childrenMap.get(index) ?? [];

    return (
      <Fragment key={index}>
        <div
          class={`contour-list-item ${selectedIndex === index ? "selected" : ""} ${isInvalid ? "contour-invalid" : ""}`}
          style={{ paddingLeft: `${12 + depth * 16}px` }}
          onClick={() => document.selectContour(index)}
        >
          <span
            class="height-swatch"
            style={{
              background: isInvalid
                ? "#cc4444"
                : getContourColorHex(contour.height),
            }}
          />
          <span class="contour-list-item-name">
            {contour.name || `Contour ${index + 1}`}
            {isInvalid && " \u26a0\ufe0f"}
          </span>
          <span class="contour-list-item-height">
            {contour.height === 0
              ? "Shore"
              : contour.height < 0
                ? `${contour.height} ft`
                : `+${contour.height} ft`}
          </span>
        </div>
        {children.map((childIndex) => renderContourNode(childIndex, depth + 1))}
      </Fragment>
    );
  };

  return (
    <div class="contour-list">
      {hierarchy.roots.map((rootIndex) => renderContourNode(rootIndex, 0))}
    </div>
  );
}

function ValidationErrors({
  validation,
  document,
}: {
  validation: ContourValidationResult;
  document: EditorDocument;
}) {
  const contours = document.getContours();

  return (
    <div class="contour-validation-errors">
      <div class="contour-validation-header">Validation Errors</div>
      {validation.selfIntersections.length > 0 && (
        <div class="contour-validation-item">
          {validation.selfIntersections.length} self-intersection
          {validation.selfIntersections.length > 1 ? "s" : ""}
        </div>
      )}
      {validation.intersectsWithContours.length > 0 && (
        <div class="contour-validation-item">
          Intersects with:{" "}
          {validation.intersectsWithContours
            .map((i) => contours[i]?.name || `Contour ${i + 1}`)
            .join(", ")}
        </div>
      )}
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
  const validationResults = document.getValidationResults();
  const validation = validationResults[contourIndex];
  const isInvalid = validation && !validation.isValid;
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
          key={`name-${contourIndex}-${contour.name}`}
          defaultValue={contour.name || ""}
          placeholder={`Contour ${contourIndex + 1}`}
          onBlur={handleNameChange}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              (e.target as HTMLInputElement).blur();
            }
            e.stopPropagation();
          }}
        />
      </div>

      <div class="contour-panel-row">
        <div class="contour-panel-row-inline">
          <label class="contour-panel-label">Height (ft)</label>
          <input
            type="number"
            class="contour-panel-height-input"
            key={`height-${contourIndex}-${contour.height}`}
            defaultValue={contour.height}
            step="0.1"
            onBlur={handleHeightChange}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                (e.target as HTMLInputElement).blur();
              }
              e.stopPropagation();
            }}
          />
        </div>
        <input
          type="range"
          class="contour-panel-slider"
          min="-50"
          max="20"
          step="0.1"
          value={contour.height}
          onInput={handleHeightChange}
        />
      </div>

      <div class="contour-panel-row">
        <label class="contour-panel-label">Points</label>
        <span>{contour.controlPoints.length} control points</span>
      </div>

      {isInvalid && (
        <ValidationErrors validation={validation} document={document} />
      )}

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
