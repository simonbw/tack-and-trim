import { CURRENT_SAVE_VERSION, SaveFile } from "./SaveFile";

type Migration = (data: Record<string, unknown>) => Record<string, unknown>;

const MIGRATIONS: Migration[] = [
  // v1 -> v2: Rename old boat IDs to new fleet names
  (data) => {
    const progression = data.progression as Record<string, unknown> | undefined;
    if (!progression) return data;

    // Map old boat IDs to the Kestrel (closest equivalent)
    const oldToNew: Record<string, string> = {
      "starter-dinghy": "kestrel",
      "starter-boat": "kestrel",
    };

    const currentBoatId = progression.currentBoatId as string;
    if (currentBoatId in oldToNew) {
      progression.currentBoatId = oldToNew[currentBoatId];
    }

    const ownedBoats = progression.ownedBoats as
      | { boatId: string; purchasedUpgrades: string[] }[]
      | undefined;
    if (ownedBoats) {
      for (const entry of ownedBoats) {
        if (entry.boatId in oldToNew) {
          entry.boatId = oldToNew[entry.boatId];
        }
        // Rename "deeper-centerboard" upgrade to "deeper-keel"
        const idx = entry.purchasedUpgrades.indexOf("deeper-centerboard");
        if (idx !== -1) {
          entry.purchasedUpgrades[idx] = "deeper-keel";
        }
      }
    }

    return data;
  },
  // v2 -> v3: Add sailor state to boat (defaults to helm)
  (data) => {
    const boat = data.boat as Record<string, unknown> | undefined;
    if (boat && !boat.sailor) {
      boat.sailor = {
        stationId: "helm",
        position: [0, 0],
      };
    }
    return data;
  },
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
