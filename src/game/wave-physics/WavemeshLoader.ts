/**
 * Browser-side loader for prebuilt .wavemesh binary files.
 */

import type { WavefrontMeshData } from "../../pipeline/mesh-building/MeshBuildTypes";
import { parseWavemeshBuffer } from "../../pipeline/mesh-building/WavemeshFile";

/**
 * Fetch and parse a .wavemesh file from a URL.
 * Returns the parsed mesh data array, or throws on fetch/parse failure.
 */
export async function loadWavemeshFromUrl(
  url: string,
): Promise<WavefrontMeshData[]> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch wavemesh: ${response.status} ${url}`);
  }
  const buffer = await response.arrayBuffer();
  const { meshes } = parseWavemeshBuffer(buffer);
  return meshes;
}
