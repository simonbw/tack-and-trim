import {
  parseTreeBuffer,
  TreeFileData,
} from "../../pipeline/mesh-building/TreeFile";

export async function loadTreesFromUrl(url: string): Promise<TreeFileData> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch trees: ${response.status} ${url}`);
  }
  const buffer = await response.arrayBuffer();
  return parseTreeBuffer(buffer);
}
