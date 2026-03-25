import { SaveFile, SaveSlotInfo } from "./SaveFile";
import { migrateSaveFile } from "./SaveMigrations";

const KEY_PREFIX = "tack-and-trim";
const INDEX_KEY = `${KEY_PREFIX}:save-index`;
const SAVE_KEY_PREFIX = `${KEY_PREFIX}:save:`;

function saveKey(slotId: string): string {
  return `${SAVE_KEY_PREFIX}${slotId}`;
}

function readIndex(): SaveSlotInfo[] {
  try {
    const raw = localStorage.getItem(INDEX_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed;
  } catch {
    return [];
  }
}

function writeIndex(index: SaveSlotInfo[]): void {
  localStorage.setItem(INDEX_KEY, JSON.stringify(index));
}

/**
 * Returns all save slots sorted by lastSaved descending (most recent first).
 */
export function listSaves(): SaveSlotInfo[] {
  const index = readIndex();
  return index.sort((a, b) => b.lastSaved - a.lastSaved);
}

/**
 * Reads and parses a save file from localStorage.
 * Returns null if the slot doesn't exist or the data is corrupted.
 * Automatically runs migrations if the save is from an older version.
 */
export function loadSave(slotId: string): SaveFile | null {
  try {
    const raw = localStorage.getItem(saveKey(slotId));
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw);
    return migrateSaveFile(parsed);
  } catch {
    return null;
  }
}

/**
 * Writes a save file to localStorage and updates the slot index.
 */
export function writeSave(slotId: string, data: SaveFile): void {
  localStorage.setItem(saveKey(slotId), JSON.stringify(data));

  const index = readIndex();
  const existingIndex = index.findIndex((s) => s.slotId === slotId);
  const slotInfo: SaveSlotInfo = {
    slotId,
    saveName: data.saveName,
    lastSaved: data.lastSaved,
    levelId: data.levelId,
  };

  if (existingIndex >= 0) {
    index[existingIndex] = slotInfo;
  } else {
    index.push(slotInfo);
  }

  writeIndex(index);
}

/**
 * Deletes a save from both the index and localStorage.
 */
export function deleteSave(slotId: string): void {
  localStorage.removeItem(saveKey(slotId));

  const index = readIndex();
  const filtered = index.filter((s) => s.slotId !== slotId);
  writeIndex(filtered);
}

/**
 * Creates a new save slot with the given name.
 * Returns the generated slotId.
 */
export function createSlot(saveName: string): string {
  const slotId = Date.now().toString();
  const index = readIndex();
  index.push({
    slotId,
    saveName,
    lastSaved: 0,
    levelId: "",
  });
  writeIndex(index);
  return slotId;
}

/**
 * Returns the most recently saved slot, or null if no saves exist.
 */
export function getMostRecentSave(): SaveSlotInfo | null {
  const saves = listSaves();
  return saves.length > 0 ? saves[0] : null;
}
