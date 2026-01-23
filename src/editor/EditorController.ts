/**
 * Main editor controller entity.
 *
 * Orchestrates the terrain editor:
 * - Loads terrain from JSON on startup
 * - Adds editor entities (ContourEditor, UI panels, camera controller)
 * - Manages document state and terrain visualization
 */

import { BaseEntity } from "../core/entity/BaseEntity";
import { on } from "../core/entity/handler";
import { createContour } from "../game/world-data/terrain/LandMass";
import { TerrainInfo } from "../game/world-data/terrain/TerrainInfo";
import { V } from "../core/Vector";
import { ContourEditor } from "./ContourEditor";
import { ContourRenderer } from "./ContourRenderer";
import { DocumentChangeListener, EditorDocument } from "./EditorDocument";
import { EditorCameraController } from "./EditorCameraController";
import {
  editorDefinitionToFile,
  serializeTerrainFile,
} from "./io/TerrainFileFormat";
import { loadDefaultEditorTerrain } from "./io/TerrainLoader";
import { EditorUI } from "./EditorUI";
import { EditorSurfaceRenderer } from "./EditorSurfaceRenderer";
import { WaterInfo } from "../game/world-data/water/WaterInfo";

export class EditorController
  extends BaseEntity
  implements DocumentChangeListener
{
  persistenceLevel = 100;

  private document: EditorDocument;
  private terrainInfo: TerrainInfo | null = null;
  private cameraController: EditorCameraController | null = null;
  private contourRenderer: ContourRenderer | null = null;

  constructor() {
    super();
    this.document = new EditorDocument();
    this.document.addListener(this);
  }

  @on("add")
  onAdd(): void {
    // Load default terrain from bundled resource
    const terrain = loadDefaultEditorTerrain();
    this.document.setTerrainDefinition(terrain);

    // Create TerrainInfo for rendering (without InfluenceFieldManager)
    this.terrainInfo = this.game.addEntity(
      new TerrainInfo(this.getTerrainContours()),
    );

    // Add WaterInfo for wave simulation (uses fallback influence - uniform waves)
    this.game.addEntity(new WaterInfo());

    // Add surface renderer (renders water and terrain visuals)
    this.game.addEntity(new EditorSurfaceRenderer());

    // Add camera controller
    this.cameraController = this.game.addEntity(
      new EditorCameraController(this.game.camera),
    );
    this.cameraController.setTerrainDefinition(
      this.document.getTerrainDefinition(),
    );

    // Fit camera to show all terrain
    // Delay to ensure camera is ready
    setTimeout(() => {
      this.cameraController?.fitToTerrain();
    }, 100);

    // Add contour renderer (renders control points and splines)
    this.contourRenderer = this.game.addEntity(
      new ContourRenderer(this.document),
    );

    // Add contour editor (handles mouse interaction)
    this.game.addEntity(new ContourEditor(this.document, this.contourRenderer));

    // Add UI (toolbar and panels)
    this.game.addEntity(new EditorUI(this.document, this));
  }

  // ==========================================
  // DocumentChangeListener implementation
  // ==========================================

  onTerrainChanged(): void {
    // Update TerrainInfo with new contours
    if (this.terrainInfo) {
      this.terrainInfo.setTerrainDefinition({
        contours: this.getTerrainContours(),
        defaultDepth: this.document.getDefaultDepth(),
      });
    }

    // Update camera controller
    if (this.cameraController) {
      this.cameraController.setTerrainDefinition(
        this.document.getTerrainDefinition(),
      );
    }
  }

  onSelectionChanged(): void {
    // UI panels will react to this
  }

  onDirtyChanged(isDirty: boolean): void {
    // Update window title or show save indicator
    const title = isDirty ? "* Terrain Editor" : "Terrain Editor";
    document.title = title;
  }

  // ==========================================
  // Helper methods
  // ==========================================

  /**
   * Convert editor contours to game contours.
   */
  private getTerrainContours() {
    return this.document.getContours().map((c) =>
      createContour([...c.controlPoints], c.height, {
        hillFrequency: c.hillFrequency,
        hillAmplitude: c.hillAmplitude,
      }),
    );
  }

  /**
   * Get the editor document.
   */
  getDocument(): EditorDocument {
    return this.document;
  }

  // ==========================================
  // File operations
  // ==========================================

  /**
   * Save terrain to a JSON string.
   */
  saveToJson(): string {
    const file = editorDefinitionToFile(this.document.getTerrainDefinition());
    return serializeTerrainFile(file);
  }

  /**
   * Download terrain as a JSON file.
   */
  downloadJson(filename: string = "terrain.json"): void {
    const json = this.saveToJson();
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);

    this.document.markClean();
  }

  /**
   * Copy terrain JSON to clipboard.
   */
  async copyToClipboard(): Promise<void> {
    const json = this.saveToJson();
    await navigator.clipboard.writeText(json);
    this.document.markClean();
  }

  /**
   * Load terrain from a File object.
   */
  async loadFromFile(file: File): Promise<void> {
    const { loadTerrainFromFile } = await import("./io/TerrainLoader");
    const terrain = await loadTerrainFromFile(file);
    this.document.setTerrainDefinition(terrain);
    this.cameraController?.fitToTerrain();
  }

  /**
   * Create a new empty terrain.
   */
  newTerrain(): void {
    if (this.document.getIsDirty()) {
      if (
        !confirm(
          "You have unsaved changes. Are you sure you want to start a new terrain?",
        )
      ) {
        return;
      }
    }

    this.document.setTerrainDefinition({
      defaultDepth: -50,
      contours: [],
    });
  }

  /**
   * Add a new contour with a default shape.
   */
  addNewContour(): void {
    const camera = this.game.camera;
    const center = camera.position;
    const size = 200 / camera.z;

    // Create a simple square contour at shore level
    const newContour = {
      name: `Contour ${this.document.getContours().length + 1}`,
      height: 0,
      hillFrequency: 0.008,
      hillAmplitude: 0.25,
      controlPoints: [
        V(center.x - size, center.y - size),
        V(center.x + size, center.y - size),
        V(center.x + size, center.y + size),
        V(center.x - size, center.y + size),
      ],
    };

    const { AddContourCommand } = require("./EditorDocument");
    const command = new AddContourCommand(this.document, newContour);
    this.document.executeCommand(command);

    // Select the new contour
    const newIndex = this.document.getContours().length - 1;
    this.document.selectContour(newIndex);
  }

  @on("keyDown")
  onKeyDown({ key }: { key: string }): void {
    const io = this.game.io;
    const meta = io.isKeyDown("MetaLeft") || io.isKeyDown("MetaRight");
    const ctrl = io.isKeyDown("ControlLeft") || io.isKeyDown("ControlRight");
    const modifier = meta || ctrl;

    // Ctrl/Cmd+S - Save (download)
    if (key === "KeyS" && modifier) {
      this.downloadJson();
      return;
    }

    // Ctrl/Cmd+O - Open file
    if (key === "KeyO" && modifier) {
      this.promptOpenFile();
      return;
    }

    // Ctrl/Cmd+N - New terrain
    if (key === "KeyN" && modifier) {
      this.newTerrain();
      return;
    }
  }

  private promptOpenFile(): void {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,.terrain.json";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (file) {
        try {
          await this.loadFromFile(file);
        } catch (error) {
          console.error("Failed to load terrain file:", error);
          alert(`Failed to load terrain file: ${error}`);
        }
      }
    };
    input.click();
  }
}
