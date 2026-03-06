import type { WindMeshFileData } from "../../pipeline/mesh-building/WindmeshFile";
import { parseWindmeshBuffer } from "../../pipeline/mesh-building/WindmeshFile";

export async function loadWindmeshFromUrl(
  url: string,
): Promise<WindMeshFileData> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch windmesh: ${response.status} ${url}`);
  }
  const buffer = await response.arrayBuffer();
  return parseWindmeshBuffer(buffer);
}
