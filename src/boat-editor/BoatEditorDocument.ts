/**
 * State management for the boat editor.
 * Wraps a BoatConfig with undo/redo via the Command pattern.
 */

import { V, V2d } from "../core/Vector";
import { BoatConfig, ShaffS7 } from "../game/boat/BoatConfig";

// ============================================
// Command Pattern
// ============================================

export interface BoatEditorCommand {
  execute(): void;
  undo(): void;
  readonly description: string;
}

// ============================================
// Listener
// ============================================

export interface BoatDocumentListener {
  onConfigChanged(): void;
  onDirtyChanged(isDirty: boolean): void;
}

// ============================================
// Document
// ============================================

export class BoatEditorDocument {
  private _config: BoatConfig;
  private _savedConfig: BoatConfig; // snapshot at last save
  private undoStack: BoatEditorCommand[] = [];
  private redoStack: BoatEditorCommand[] = [];
  private listeners: BoatDocumentListener[] = [];

  constructor(config?: BoatConfig) {
    this._config = config ?? ShaffS7;
    this._savedConfig = jsonClone(this._config);
  }

  // --- Config access ---

  get config(): BoatConfig {
    return this._config;
  }

  get isDirty(): boolean {
    return JSON.stringify(this._config) !== JSON.stringify(this._savedConfig);
  }

  markSaved(): void {
    this._savedConfig = jsonClone(this._config);
    this.notifyDirtyChanged();
  }

  // --- Undo/Redo ---

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  executeCommand(cmd: BoatEditorCommand): void {
    cmd.execute();
    this.undoStack.push(cmd);
    this.redoStack.length = 0;
    this.notifyConfigChanged();
  }

  undo(): void {
    const cmd = this.undoStack.pop();
    if (cmd) {
      cmd.undo();
      this.redoStack.push(cmd);
      this.notifyConfigChanged();
    }
  }

  redo(): void {
    const cmd = this.redoStack.pop();
    if (cmd) {
      cmd.execute();
      this.undoStack.push(cmd);
      this.notifyConfigChanged();
    }
  }

  // --- Load ---

  loadConfig(config: BoatConfig): void {
    this._config = jsonClone(config);
    this._savedConfig = jsonClone(config);
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.notifyConfigChanged();
    this.notifyDirtyChanged();
  }

  // --- Listeners ---

  addListener(listener: BoatDocumentListener): void {
    this.listeners.push(listener);
  }

  removeListener(listener: BoatDocumentListener): void {
    const i = this.listeners.indexOf(listener);
    if (i >= 0) this.listeners.splice(i, 1);
  }

  private notifyConfigChanged(): void {
    for (const l of this.listeners) l.onConfigChanged();
    this.notifyDirtyChanged();
  }

  private notifyDirtyChanged(): void {
    const dirty = this.isDirty;
    for (const l of this.listeners) l.onDirtyChanged(dirty);
  }
}

// ============================================
// Commands
// ============================================

/**
 * Generic command for setting a single property at a given path in the config.
 * The path is a dot-separated string like "hull.mass" or "rudder.maxSteerAngle".
 */
export class SetPropertyCommand implements BoatEditorCommand {
  private oldValue: unknown;
  readonly description: string;

  constructor(
    private doc: BoatEditorDocument,
    private path: string,
    private newValue: unknown,
  ) {
    this.oldValue = getNestedValue(doc.config, path);
    const shortPath = path.split(".").slice(-1)[0];
    this.description = `Set ${shortPath} to ${newValue}`;
  }

  execute(): void {
    setNestedValue(
      this.doc.config as unknown as Record<string, unknown>,
      this.path,
      this.newValue,
    );
  }

  undo(): void {
    setNestedValue(
      this.doc.config as unknown as Record<string, unknown>,
      this.path,
      this.oldValue,
    );
  }
}

// --- Helpers ---

function getNestedValue(obj: unknown, path: string): unknown {
  const keys = path.split(".");
  let current: unknown = obj;
  for (const key of keys) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function setNestedValue(
  obj: Record<string, unknown>,
  path: string,
  value: unknown,
): void {
  const keys = path.split(".");
  let current: Record<string, unknown> = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    current = current[keys[i]] as Record<string, unknown>;
  }
  current[keys[keys.length - 1]] = value;
}

/** Deep clone that preserves V2d instances (needed because the Boat
 * constructor calls V2d methods like .add() on config vectors). */
function jsonClone(obj: BoatConfig): BoatConfig {
  return deepClone(obj) as BoatConfig;
}

function deepClone(x: unknown): unknown {
  if (x === null || typeof x !== "object") return x;
  if (x instanceof V2d) return V(x[0], x[1]);
  if (Array.isArray(x)) return x.map(deepClone);
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(x as Record<string, unknown>)) {
    out[k] = deepClone((x as Record<string, unknown>)[k]);
  }
  return out;
}
