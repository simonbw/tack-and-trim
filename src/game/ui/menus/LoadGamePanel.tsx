import type { SaveSlotInfo } from "../../persistence/SaveFile";
import { formatLevelName, formatTimestamp } from "../../menuFormatting";

interface Props {
  saves: SaveSlotInfo[];
  pendingDeleteSlotId: string | null;
  onBack: () => void;
  onLoad: (slotId: string) => void;
  onRequestDelete: (slotId: string) => void;
  onConfirmDelete: (slotId: string) => void;
  onCancelDelete: () => void;
}

export function LoadGamePanel(props: Props) {
  return (
    <>
      <div class="main-menu__page-title">Load Game</div>

      {props.saves.length === 0 ? (
        <div class="main-menu__empty">No saved games.</div>
      ) : (
        <div class="main-menu__levels">
          {props.saves.map((save) =>
            props.pendingDeleteSlotId === save.slotId
              ? renderConfirm(save, props)
              : renderSave(save, props),
          )}
        </div>
      )}

      <button class="main-menu__back" onClick={props.onBack}>
        ← Back
      </button>
    </>
  );
}

function renderSave(save: SaveSlotInfo, props: Props) {
  return (
    <div class="main-menu__save-entry">
      <button
        class="main-menu__card main-menu__card--save"
        onClick={() => props.onLoad(save.slotId)}
        onKeyDown={(e) => {
          if (e.key === "Delete" || e.key === "Backspace") {
            e.preventDefault();
            props.onRequestDelete(save.slotId);
          }
        }}
      >
        <div class="main-menu__save-name">{save.saveName}</div>
        <div class="main-menu__save-details">
          {formatLevelName(save.levelId)} · {formatTimestamp(save.lastSaved)}
        </div>
      </button>
      <button
        class="main-menu__delete"
        tabIndex={-1}
        aria-label={`Delete save "${save.saveName}"`}
        onClick={(e) => {
          e.stopPropagation();
          props.onRequestDelete(save.slotId);
        }}
      >
        ×
      </button>
    </div>
  );
}

function renderConfirm(save: SaveSlotInfo, props: Props) {
  return (
    <div class="main-menu__card main-menu__card--confirm">
      <div class="main-menu__confirm-prompt">Delete “{save.saveName}”?</div>
      <div class="main-menu__confirm-actions">
        <button
          class="main-menu__confirm-button main-menu__confirm-button--danger"
          onClick={() => props.onConfirmDelete(save.slotId)}
        >
          Delete
        </button>
        <button
          class="main-menu__confirm-button"
          onClick={props.onCancelDelete}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
