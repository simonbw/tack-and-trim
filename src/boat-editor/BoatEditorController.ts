/**
 * Main orchestrator for the boat editor.
 * Creates and wires up the document, camera, preview renderer, and UI.
 */

import { BaseEntity } from "../core/entity/BaseEntity";
import { on } from "../core/entity/handler";
import {
  BoatConfig,
  ShaffS7,
  ShaffS11,
  ShaffS15,
  ShaffS20,
  BhcDaysailer,
  BhcWeekender,
  BhcJourney,
  BhcExpedition,
  MaestroEtude,
  MaestroTrio,
  MaestroFantasia,
  MaestroOpus,
} from "../game/boat/BoatConfig";
import { BoatEditorDocument, BoatDocumentListener } from "./BoatEditorDocument";
import { BoatEditorCameraController } from "./BoatEditorCameraController";
import { BoatPreviewRenderer } from "./BoatPreviewRenderer";
import { BoatEditorUI } from "./BoatEditorUI";

export const BOAT_PRESETS: Record<string, BoatConfig> = {
  "Shaff S-7": ShaffS7,
  "Shaff S-11": ShaffS11,
  "Shaff S-15": ShaffS15,
  "Shaff S-20": ShaffS20,
  "BHC Daysailer": BhcDaysailer,
  "BHC Weekender": BhcWeekender,
  "BHC Journey": BhcJourney,
  "BHC Expedition": BhcExpedition,
  "Maestro Etude": MaestroEtude,
  "Maestro Trio": MaestroTrio,
  "Maestro Fantasia": MaestroFantasia,
  "Maestro Opus": MaestroOpus,
};

export class BoatEditorController
  extends BaseEntity
  implements BoatDocumentListener
{
  readonly document: BoatEditorDocument;
  private camera!: BoatEditorCameraController;
  private preview!: BoatPreviewRenderer;
  private ui!: BoatEditorUI;

  constructor() {
    super();
    this.document = new BoatEditorDocument(ShaffS7);
    this.document.addListener(this);
  }

  @on("add")
  onAdd() {
    this.camera = this.game!.addEntity(new BoatEditorCameraController());
    this.preview = this.game!.addEntity(
      new BoatPreviewRenderer(this.document.config, this.camera),
    );
    this.ui = this.game!.addEntity(new BoatEditorUI(this));

    window.addEventListener("keydown", this.handleKeyDown);
    this.updateTitle();
  }

  @on("destroy")
  onDestroy() {
    window.removeEventListener("keydown", this.handleKeyDown);
    this.document.removeListener(this);
  }

  // --- DocumentListener ---

  onConfigChanged(): void {
    this.preview.setConfig(this.document.config);
  }

  onDirtyChanged(): void {
    this.updateTitle();
  }

  // --- Preset loading ---

  loadPreset(name: string): void {
    const preset = BOAT_PRESETS[name];
    if (preset) {
      this.document.loadConfig(preset);
    }
  }

  // --- Export ---

  exportJSON(): void {
    const json = JSON.stringify(this.document.config, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "boat-config.json";
    a.click();
    URL.revokeObjectURL(url);
    this.document.markSaved();
  }

  async importJSON(): Promise<void> {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      const text = await file.text();
      const config = JSON.parse(text) as BoatConfig;
      this.document.loadConfig(config);
    };
    input.click();
  }

  // --- Keyboard shortcuts ---

  private handleKeyDown = (e: KeyboardEvent) => {
    const mod = e.metaKey || e.ctrlKey;

    if (mod && e.key === "z" && !e.shiftKey) {
      e.preventDefault();
      this.document.undo();
    } else if (mod && e.key === "z" && e.shiftKey) {
      e.preventDefault();
      this.document.redo();
    } else if (mod && e.key === "y") {
      e.preventDefault();
      this.document.redo();
    } else if (mod && e.key === "s") {
      e.preventDefault();
      this.exportJSON();
    } else if (mod && e.key === "o") {
      e.preventDefault();
      this.importJSON();
    }
  };

  private updateTitle(): void {
    const dirty = this.document.isDirty ? " *" : "";
    document.title = `Boat Editor${dirty} - Tack & Trim`;
  }
}
