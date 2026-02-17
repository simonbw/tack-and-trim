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
import { createContour } from "../game/world/terrain/LandMass";
import { DEFAULT_DEPTH } from "../game/world/terrain/TerrainConstants";
import { TerrainResources } from "../game/world/terrain/TerrainResources";
import { TerrainQuery } from "../game/world/terrain/TerrainQuery";
import { TerrainQueryManager } from "../game/world/terrain/TerrainQueryManager";
import { V, V2d } from "../core/Vector";
import { ContourEditor } from "./ContourEditor";
import { ContourRenderer } from "./ContourRenderer";
import {
  DocumentChangeListener,
  EditorDocument,
  PasteContourCommand,
} from "./EditorDocument";
import { EditorCameraController } from "./EditorCameraController";
import {
  EditorContour,
  editorDefinitionToFile,
  editorDefinitionToGameDefinition,
  serializeTerrainFile,
} from "./io/TerrainFileFormat";
import { loadDefaultEditorTerrain } from "./io/TerrainLoader";
import { EditorUI } from "./EditorUI";
import { SurfaceRenderer } from "../game/surface-rendering/SurfaceRenderer";
import { WavePhysicsResources } from "../game/wave-physics/WavePhysicsResources";
import { WaterResources } from "../game/world/water/WaterResources";
import { WaterQueryManager } from "../game/world/water/WaterQueryManager";
import { DebugRenderer } from "../game/debug-renderer/DebugRenderer";
import { computeSplineCentroid } from "../core/util/Spline";

// File System Access API types (not in lib.dom.d.ts by default)
declare global {
  interface Window {
    showSaveFilePicker?: (
      options?: SaveFilePickerOptions,
    ) => Promise<FileSystemFileHandle>;
    showOpenFilePicker?: (
      options?: OpenFilePickerOptions,
    ) => Promise<FileSystemFileHandle[]>;
  }

  interface SaveFilePickerOptions {
    types?: FilePickerAcceptType[];
    suggestedName?: string;
    startIn?: FileSystemHandle | "desktop" | "documents" | "downloads";
  }

  interface OpenFilePickerOptions {
    types?: FilePickerAcceptType[];
    multiple?: boolean;
    startIn?: FileSystemHandle | "desktop" | "documents" | "downloads";
  }

  interface FilePickerAcceptType {
    description?: string;
    accept: Record<string, string[]>;
  }

  interface FileSystemFileHandle {
    requestPermission(options?: {
      mode?: "read" | "readwrite";
    }): Promise<"granted" | "denied" | "prompt">;
  }
}

// ===========================================
// IndexedDB helpers for persisting file handle
// ===========================================

const DB_NAME = "terrain-editor";
const DB_VERSION = 1;
const STORE_NAME = "file-handles";
const FILE_HANDLE_KEY = "lastOpenedFile";

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE_NAME);
    };
  });
}

async function storeFileHandle(handle: FileSystemFileHandle): Promise<void> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const request = store.put(handle, FILE_HANDLE_KEY);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve();
    tx.oncomplete = () => db.close();
  });
}

async function retrieveFileHandle(): Promise<FileSystemFileHandle | null> {
  try {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const store = tx.objectStore(STORE_NAME);
      const request = store.get(FILE_HANDLE_KEY);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result ?? null);
      tx.oncomplete = () => db.close();
    });
  } catch {
    return null;
  }
}

export class EditorController
  extends BaseEntity
  implements DocumentChangeListener
{
  id = "editorController" as const;
  persistenceLevel = 100;

  private document: EditorDocument;
  private terrainResources: TerrainResources | null = null;
  private cameraController: EditorCameraController | null = null;
  private contourRenderer: ContourRenderer | null = null;
  private debugRenderMode = false;
  private fileHandle: FileSystemFileHandle | null = null;
  private clipboardContour: EditorContour | null = null;
  private mouseWorldPosition: V2d | null = null;

  // Terrain query for cursor height display (uses 1-frame latency GPU query)
  private terrainQuery = this.addChild(
    new TerrainQuery(() => this.getTerrainQueryPoints()),
  );

  constructor() {
    super();
    this.document = new EditorDocument();
    this.document.addListener(this);
  }

  /**
   * Get points to query for terrain height (just the cursor position).
   */
  private getTerrainQueryPoints(): V2d[] {
    if (!this.mouseWorldPosition) return [];
    return [this.mouseWorldPosition];
  }

  @on("add")
  onAdd(): void {
    // Load default terrain from bundled resource
    const terrain = loadDefaultEditorTerrain();
    this.document.setTerrainDefinition(terrain);

    // Create TerrainResources for GPU buffers and terrain data storage
    // Convert editor definition to game definition (performs spline sampling)
    this.terrainResources = this.game.addEntity(
      new TerrainResources(
        editorDefinitionToGameDefinition(this.document.getTerrainDefinition()),
      ),
    );

    // Create TerrainQueryManager for GPU-accelerated terrain queries
    this.game.addEntity(new TerrainQueryManager());

    // Add wave physics for shadow-based diffraction
    this.game.addEntity(new WavePhysicsResources());

    // Add water system (tide, modifiers, GPU buffers)
    this.game.addEntity(new WaterResources());
    this.game.addEntity(new WaterQueryManager());

    // Add surface renderer (renders water and terrain visuals)
    this.game.addEntity(new SurfaceRenderer());

    // Add debug visualization
    this.game.addEntity(new DebugRenderer());

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

    // Try to restore file handle from last session, or prompt to open
    this.tryRestoreFileHandle();
  }

  /**
   * Try to restore the file handle from the last session.
   * If successful, reload the file. If not, prompt to open a file.
   */
  private async tryRestoreFileHandle(): Promise<void> {
    if (!this.isFileSystemAccessSupported()) return;

    const handle = await retrieveFileHandle();
    if (handle) {
      try {
        // Request permission to access the file again
        const permission = await handle.requestPermission({
          mode: "readwrite",
        });
        if (permission === "granted") {
          const file = await handle.getFile();
          await this.loadFromFile(file);
          this.fileHandle = handle;
          return;
        }
      } catch (e) {
        // Permission denied or file no longer exists - fall through to prompt
        console.log("Could not restore previous file:", e);
      }
    }

    // No remembered handle or permission denied - prompt to open
    this.promptOpenDefaultTerrain();
  }

  /**
   * Show a prompt asking if the user wants to open the default terrain file.
   */
  private promptOpenDefaultTerrain(): void {
    // Delay slightly to ensure UI is ready
    setTimeout(() => {
      if (
        confirm(
          "Open a terrain file to enable saving?\n\nClick OK to select a file, or Cancel to start with a new terrain.",
        )
      ) {
        this.openFileSystem();
      }
    }, 200);
  }

  // ==========================================
  // DocumentChangeListener implementation
  // ==========================================

  onTerrainChanged(): void {
    // Update TerrainResources with new contours
    if (this.terrainResources) {
      this.terrainResources.setTerrainDefinition({
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
   * In normal mode, filters out invalid contours.
   * In debug mode, includes all contours.
   */
  private getTerrainContours() {
    const contours = this.document.getContours();
    const validationResults = this.document.getValidationResults();

    return contours
      .filter(
        (_, i) =>
          this.debugRenderMode || validationResults[i]?.isValid !== false,
      )
      .map((c) => createContour([...c.controlPoints], c.height));
  }

  /**
   * Get the editor document.
   */
  getDocument(): EditorDocument {
    return this.document;
  }

  /**
   * Get whether debug render mode is enabled.
   */
  getDebugRenderMode(): boolean {
    return this.debugRenderMode;
  }

  /**
   * Get the current mouse position in world coordinates.
   */
  getMouseWorldPosition(): V2d | null {
    return this.mouseWorldPosition;
  }

  /**
   * Get the terrain height at the current mouse position.
   * Uses GPU terrain query with 1-frame latency.
   */
  getTerrainHeightAtMouse(): number | null {
    if (!this.mouseWorldPosition) return null;
    // Get result from GPU query (1-frame latency)
    if (this.terrainQuery.results.length === 0) return null;
    return this.terrainQuery.results[0].height;
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
   * Check if File System Access API is available.
   */
  isFileSystemAccessSupported(): boolean {
    return "showSaveFilePicker" in window;
  }

  /**
   * Check if we have a file handle for the current document.
   */
  hasFileHandle(): boolean {
    return this.fileHandle !== null;
  }

  /**
   * Save to the current file handle, or prompt for Save As if none.
   */
  async saveToFileSystem(): Promise<boolean> {
    if (!this.fileHandle) {
      return this.saveAsToFileSystem();
    }

    try {
      const writable = await this.fileHandle.createWritable();
      await writable.write(this.saveToJson());
      await writable.close();
      this.document.markClean();
      return true;
    } catch (e) {
      console.error("Failed to save:", e);
      return false;
    }
  }

  /**
   * Prompt user for save location and save.
   */
  async saveAsToFileSystem(): Promise<boolean> {
    try {
      const options: SaveFilePickerOptions = {
        types: [
          {
            description: "Terrain Files",
            accept: { "application/json": [".json", ".terrain.json"] },
          },
        ],
        suggestedName: "terrain.json",
      };

      // Start in the same folder as the current file if we have one
      if (this.fileHandle) {
        options.startIn = this.fileHandle;
      }

      const handle = await window.showSaveFilePicker!(options);
      this.fileHandle = handle;

      // Remember this file for next session
      storeFileHandle(handle).catch((e) =>
        console.warn("Failed to store file handle:", e),
      );

      return this.saveToFileSystem();
    } catch (e) {
      if ((e as Error).name !== "AbortError") {
        console.error("Save As failed:", e);
      }
      return false;
    }
  }

  /**
   * Open file using File System Access API (stores handle for later save).
   */
  async openFileSystem(): Promise<boolean> {
    try {
      const options: OpenFilePickerOptions = {
        types: [
          {
            description: "Terrain Files",
            accept: { "application/json": [".json", ".terrain.json"] },
          },
        ],
      };

      // Start in the same folder as the current file if we have one
      if (this.fileHandle) {
        options.startIn = this.fileHandle;
      }

      const [handle] = await window.showOpenFilePicker!(options);
      const file = await handle.getFile();
      await this.loadFromFile(file);
      this.fileHandle = handle;

      // Remember this file for next session
      storeFileHandle(handle).catch((e) =>
        console.warn("Failed to store file handle:", e),
      );

      return true;
    } catch (e) {
      if ((e as Error).name !== "AbortError") {
        console.error("Open failed:", e);
      }
      return false;
    }
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

    // Clear file handle when creating new terrain
    this.fileHandle = null;

    this.document.setTerrainDefinition({
      defaultDepth: DEFAULT_DEPTH,
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

  // ==========================================
  // Clipboard operations
  // ==========================================

  /**
   * Copy the selected contour to the clipboard.
   */
  copySelectedContour(): boolean {
    const contour = this.document.getSelectedContour();
    if (!contour) return false;

    // Deep clone the contour
    this.clipboardContour = {
      ...contour,
      controlPoints: contour.controlPoints.map((p) => V(p.x, p.y)),
    };
    return true;
  }

  /**
   * Paste the clipboard contour at the camera center.
   */
  pasteContour(): boolean {
    if (!this.clipboardContour) return false;

    const camera = this.game.camera;
    const cameraCenter = camera.position;

    // Compute centroid of the clipboard contour
    const centroid = computeSplineCentroid(this.clipboardContour.controlPoints);

    // Offset to place at camera center
    const offset = V(cameraCenter.x - centroid.x, cameraCenter.y - centroid.y);

    const command = new PasteContourCommand(
      this.document,
      this.clipboardContour,
      offset,
    );
    this.document.executeCommand(command);

    // Select the pasted contour
    const pastedIndex = command.getPastedIndex();
    if (pastedIndex >= 0) {
      this.document.selectContour(pastedIndex);
    }

    return true;
  }

  /**
   * Duplicate the selected contour with a small offset.
   */
  duplicateSelectedContour(): boolean {
    const contour = this.document.getSelectedContour();
    if (!contour) return false;

    // Small offset for duplicate
    const offset = V(50, 50);

    const command = new PasteContourCommand(this.document, contour, offset);
    this.document.executeCommand(command);

    // Select the pasted contour
    const pastedIndex = command.getPastedIndex();
    if (pastedIndex >= 0) {
      this.document.selectContour(pastedIndex);
    }

    return true;
  }

  @on("render")
  onRender(): void {
    // Update mouse world position for status bar
    const screenPos = this.game.io.mousePosition;
    this.mouseWorldPosition = this.game.camera.toWorld(screenPos);
  }

  @on("keyDown")
  onKeyDown({ key }: { key: string }): void {
    const io = this.game.io;
    const meta = io.isKeyDown("MetaLeft") || io.isKeyDown("MetaRight");
    const ctrl = io.isKeyDown("ControlLeft") || io.isKeyDown("ControlRight");
    const shift = io.isKeyDown("ShiftLeft") || io.isKeyDown("ShiftRight");
    const modifier = meta || ctrl;

    // Ctrl/Cmd+Shift+S - Save As
    if (key === "KeyS" && modifier && shift) {
      if (this.isFileSystemAccessSupported()) {
        this.saveAsToFileSystem();
      } else {
        this.downloadJson(); // Fallback
      }
      return;
    }

    // Ctrl/Cmd+S - Save
    if (key === "KeyS" && modifier) {
      if (this.isFileSystemAccessSupported()) {
        this.saveToFileSystem();
      } else {
        this.downloadJson(); // Fallback
      }
      return;
    }

    // Ctrl/Cmd+O - Open file
    if (key === "KeyO" && modifier) {
      if (this.isFileSystemAccessSupported()) {
        this.openFileSystem();
      } else {
        this.promptOpenFile(); // Fallback
      }
      return;
    }

    // Ctrl/Cmd+N - New terrain
    if (key === "KeyN" && modifier) {
      this.newTerrain();
      return;
    }

    // B key removed - debug render mode functionality removed from SurfaceRenderer
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
