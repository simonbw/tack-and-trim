import { CURRENT_SAVE_VERSION, SaveFile } from "./SaveFile";

type Migration = (data: Record<string, unknown>) => Record<string, unknown>;

const MIGRATIONS: Migration[] = [
  // Future migrations go here: v1->v2, v2->v3, etc.
  // Index 0 = migration from v1 to v2, index 1 = v2 to v3, etc.
];

/**
 * Migrate a raw save data object to the current SaveFile version.
 * Runs all necessary migrations sequentially from the data's version
 * up to CURRENT_SAVE_VERSION.
 *
 * Data with no version field is treated as version 1.
 * Throws if the data version is newer than the current version.
 */
export function migrateSaveFile(data: unknown): SaveFile {
  if (data === null || data === undefined || typeof data !== "object") {
    throw new Error("Invalid save data: expected an object");
  }

  const record = data as Record<string, unknown>;
  let version = typeof record.version === "number" ? record.version : 1;

  if (version > CURRENT_SAVE_VERSION) {
    throw new Error(
      `Save version ${version} is newer than supported version ${CURRENT_SAVE_VERSION}`,
    );
  }

  let migrated = { ...record };

  while (version < CURRENT_SAVE_VERSION) {
    const migrationIndex = version - 1;
    const migration = MIGRATIONS[migrationIndex];
    if (!migration) {
      throw new Error(
        `Missing migration from version ${version} to ${version + 1}`,
      );
    }
    migrated = migration(migrated);
    version++;
  }

  migrated.version = CURRENT_SAVE_VERSION;

  return migrated as unknown as SaveFile;
}
