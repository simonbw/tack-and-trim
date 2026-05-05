import { LevelName, RESOURCES } from "../../../../resources/resources";
import type {
  LevelDisplayInfo,
  LevelFileJSON,
} from "../../../editor/io/LevelFileFormat";
import { formatLevelName } from "../../menuFormatting";

interface LevelEntry {
  name: LevelName;
  displayName: string;
  info: LevelDisplayInfo | undefined;
}

const DIFFICULTY_LABEL: Record<
  NonNullable<LevelDisplayInfo["difficulty"]>,
  string
> = {
  beginner: "Beginner",
  intermediate: "Intermediate",
  expert: "Expert",
};

const DIFFICULTY_ORDER: Record<
  NonNullable<LevelDisplayInfo["difficulty"]>,
  number
> = {
  beginner: 0,
  intermediate: 1,
  expert: 2,
};

function buildEntries(): LevelEntry[] {
  const names = Object.keys(RESOURCES.levels) as LevelName[];
  return names
    .map((name) => {
      const file = RESOURCES.levels[name] as LevelFileJSON;
      return {
        name,
        displayName: file.name ?? formatLevelName(name),
        info: file.displayInfo,
      };
    })
    .sort((a, b) => {
      const da = a.info?.difficulty;
      const db = b.info?.difficulty;
      const oa = da ? DIFFICULTY_ORDER[da] : Infinity;
      const ob = db ? DIFFICULTY_ORDER[db] : Infinity;
      if (oa !== ob) return oa - ob;
      return a.displayName.localeCompare(b.displayName);
    });
}

const ENTRIES = buildEntries();

interface Props {
  focusedIndex: number;
  onFocusLevel: (index: number) => void;
  onSelectLevel: (name: LevelName) => void;
  onBack: () => void;
}

export function NewGamePanel({
  focusedIndex,
  onFocusLevel,
  onSelectLevel,
  onBack,
}: Props) {
  const focused = ENTRIES[focusedIndex];
  return (
    <>
      <div class="main-menu__page-title">New Game</div>

      <div class="main-menu__split">
        <div class="main-menu__levels">
          {ENTRIES.map((entry, i) => (
            <button
              class="main-menu__card"
              onClick={() => onSelectLevel(entry.name)}
              onFocus={() => onFocusLevel(i)}
              onMouseEnter={() => onFocusLevel(i)}
            >
              {entry.displayName}
            </button>
          ))}
        </div>

        {focused && (
          <div class="main-menu__detail">
            <div class="main-menu__detail-name">{focused.displayName}</div>
            {focused.info?.difficulty && (
              <div
                class={`main-menu__badge main-menu__badge--${focused.info.difficulty}`}
              >
                {DIFFICULTY_LABEL[focused.info.difficulty]}
              </div>
            )}
            {focused.info?.description && (
              <div class="main-menu__detail-desc">
                {focused.info.description}
              </div>
            )}
          </div>
        )}
      </div>

      <button class="main-menu__back" onClick={onBack}>
        ← Back
      </button>
    </>
  );
}
