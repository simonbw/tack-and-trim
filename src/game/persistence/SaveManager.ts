import { BaseEntity } from "../../core/entity/BaseEntity";
import { on } from "../../core/entity/handler";
import type { LevelName } from "../../../resources/resources";
import { collectSaveData } from "./SaveSerializer";
import { applySaveData } from "./SaveDeserializer";
import { loadSave, writeSave } from "./SaveStorage";
import type { SaveFile } from "./SaveFile";

/**
 * Singleton entity that orchestrates save/load operations.
 *
 * Persists across scene clears (persistenceLevel = 100) so it can
 * coordinate the load flow: store pending data, trigger level reload,
 * then apply saved state once entities are recreated.
 */
export class SaveManager extends BaseEntity {
  id = "saveManager";
  persistenceLevel = 100;

  /** The slot currently being used for saves. */
  private currentSlotId: string = "slot-0";

  /** The level that is currently active (tracked via levelSelected events). */
  private currentLevelId: LevelName | null = null;

  /** Pending save data waiting to be applied after a level reload. */
  pendingSave: SaveFile | null = null;

  /** Save current game state to the current slot. */
  save(saveName?: string): void {
    if (!this.currentLevelId) {
      console.warn("SaveManager.save: no level is active, skipping save");
      return;
    }

    const name = saveName ?? this.generateSaveName();
    const saveFile = collectSaveData(this.game, name, this.currentLevelId);
    writeSave(this.currentSlotId, saveFile);
  }

  /** Quick-save to the current slot with an auto-generated name. */
  quickSave(): void {
    this.save();
  }

  /**
   * Load a save from a slot. This triggers a full level reload:
   * 1. Read save data from storage
   * 2. Store as pending
   * 3. Dispatch boatSelected directly (skipping BoatSelectionScreen) with
   *    the boat the player was using when the save was written
   * 4. On gameStart, apply the pending save data
   */
  loadFromSlot(slotId: string): void {
    const save = loadSave(slotId);
    if (!save) {
      console.warn(
        `SaveManager.loadFromSlot: no save found in slot "${slotId}"`,
      );
      return;
    }

    this.pendingSave = save;
    this.currentSlotId = slotId;

    const levelName = save.levelId as LevelName;
    const boatId = save.progression.currentBoatId;
    // currentLevelId is normally updated via the levelSelected event, but
    // loads skip that path to avoid showing the boat selection screen.
    this.currentLevelId = levelName;

    this.game.clearScene(99);
    this.game.dispatch("boatSelected", { boatId, levelName });
  }

  /** Set which slot to use for subsequent saves. */
  setCurrentSlot(slotId: string): void {
    this.currentSlotId = slotId;
  }

  /** Get the current slot ID. */
  getCurrentSlotId(): string {
    return this.currentSlotId;
  }

  // -- Event handlers --

  @on("levelSelected")
  onLevelSelected({ levelName }: { levelName: LevelName }): void {
    this.currentLevelId = levelName;
  }

  /** Consume the pending save (called by GameController after constructing entities). */
  consumePendingSave(): SaveFile | null {
    const save = this.pendingSave;
    this.pendingSave = null;
    return save;
  }

  @on("boatMoored")
  onBoatMoored(): void {
    this.save("Auto-save (moored)");
  }

  @on("missionAccepted")
  onMissionAccepted(): void {
    this.save("Auto-save (mission accepted)");
  }

  private generateSaveName(): string {
    const now = new Date();
    const date = now.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
    });
    const time = now.toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
    });
    return `${date} ${time}`;
  }
}
