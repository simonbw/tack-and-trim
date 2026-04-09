import type { TideMeshFileData } from "../../../pipeline/mesh-building/TidemeshFile";
import { parseTidemeshBuffer } from "../../../pipeline/mesh-building/TidemeshFile";

export async function loadTidemeshFromUrl(
  url: string,
): Promise<TideMeshFileData> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Failed to fetch tidemesh: ${response.status} ${response.statusText}`,
    );
  }
  const buffer = await response.arrayBuffer();
  return parseTidemeshBuffer(buffer);
}
