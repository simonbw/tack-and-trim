/**
 * Cache for wave mesh build results.
 *
 * Stores built meshes in localStorage keyed by a hash of the inputs
 * (terrain, wave sources, tide height), so subsequent page loads can
 * skip the expensive worker-based mesh building.
 */

import type { TerrainCPUData } from "../../world/terrain/TerrainCPUData";
import type { WaveSource } from "../../world/water/WaveSource";
import type {
  CoverageQuad,
  MeshBuildBounds,
  MeshBuilderType,
  WavefrontMeshData,
} from "./MeshBuildTypes";

/** Bump this when mesh building logic changes to invalidate old caches */
const CACHE_VERSION = 1;

const KEY_PREFIX = `wavemesh-v${CACHE_VERSION}-`;

// ─── Hashing ────────────────────────────────────────────────────────

/** FNV-1a hash over arbitrary bytes, returns hex string */
function fnv1aHash(parts: ArrayBuffer[]): string {
  let h = 0x811c9dc5; // FNV offset basis (32-bit)
  for (const buf of parts) {
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.length; i++) {
      h ^= bytes[i];
      h = Math.imul(h, 0x01000193); // FNV prime
    }
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** Encode a number as 8 bytes (Float64) for hashing */
function numberToBuffer(n: number): ArrayBuffer {
  const buf = new ArrayBuffer(8);
  new Float64Array(buf)[0] = n;
  return buf;
}

/**
 * Compute a cache key from all inputs that affect mesh output.
 */
export function computeCacheKey(
  waveSources: WaveSource[],
  terrain: TerrainCPUData,
  coastlineBounds: MeshBuildBounds | null,
  tideHeight: number,
  builderTypes: MeshBuilderType[],
): string {
  const parts: ArrayBuffer[] = [
    // Terrain data
    terrain.vertexData.buffer as ArrayBuffer,
    terrain.contourData as ArrayBuffer,
    terrain.childrenData.buffer as ArrayBuffer,
    numberToBuffer(terrain.contourCount),
    numberToBuffer(terrain.defaultDepth),
    // Tide
    numberToBuffer(tideHeight),
  ];

  // Wave sources - only fields that affect mesh building
  for (const ws of waveSources) {
    parts.push(numberToBuffer(ws.wavelength));
    parts.push(numberToBuffer(ws.direction));
    parts.push(numberToBuffer(ws.amplitude));
    parts.push(numberToBuffer(ws.sourceDist));
    parts.push(numberToBuffer(ws.sourceOffsetX));
    parts.push(numberToBuffer(ws.sourceOffsetY));
  }

  // Coastline bounds
  if (coastlineBounds) {
    parts.push(numberToBuffer(coastlineBounds.minX));
    parts.push(numberToBuffer(coastlineBounds.minY));
    parts.push(numberToBuffer(coastlineBounds.maxX));
    parts.push(numberToBuffer(coastlineBounds.maxY));
  }

  // Builder types
  const typeStr = builderTypes.join(",");
  const enc = new TextEncoder();
  parts.push(enc.encode(typeStr).buffer);

  return KEY_PREFIX + fnv1aHash(parts);
}

// ─── Serialization ──────────────────────────────────────────────────

interface SerializedMeshData {
  vertices: string; // base64
  indices: string; // base64
  vertexCount: number;
  indexCount: number;
  coverageQuad: CoverageQuad | null;
}

interface CacheEntry {
  /** Map from builder type to array of serialized mesh data */
  meshSets: Record<string, SerializedMeshData[]>;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

function serializeMeshData(mesh: WavefrontMeshData): SerializedMeshData {
  return {
    vertices: arrayBufferToBase64(
      (mesh.vertices.buffer as ArrayBuffer).slice(
        mesh.vertices.byteOffset,
        mesh.vertices.byteOffset + mesh.vertexCount * 6 * 4,
      ),
    ),
    indices: arrayBufferToBase64(
      (mesh.indices.buffer as ArrayBuffer).slice(
        mesh.indices.byteOffset,
        mesh.indices.byteOffset + mesh.indexCount * 4,
      ),
    ),
    vertexCount: mesh.vertexCount,
    indexCount: mesh.indexCount,
    coverageQuad: mesh.coverageQuad,
  };
}

function deserializeMeshData(s: SerializedMeshData): WavefrontMeshData {
  const verticesBuf = base64ToArrayBuffer(s.vertices);
  const indicesBuf = base64ToArrayBuffer(s.indices);
  return {
    vertices: new Float32Array(verticesBuf),
    indices: new Uint32Array(indicesBuf),
    vertexCount: s.vertexCount,
    indexCount: s.indexCount,
    coverageQuad: s.coverageQuad,
  };
}

// ─── localStorage Read/Write ────────────────────────────────────────

/** Remove all old wavemesh cache entries */
function clearOldEntries(keepKey?: string): void {
  const keysToRemove: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.startsWith("wavemesh-") && key !== keepKey) {
      keysToRemove.push(key);
    }
  }
  for (const key of keysToRemove) {
    localStorage.removeItem(key);
  }
}

/**
 * Try to load cached mesh data. Returns null on miss or error.
 */
export function loadFromCache(
  cacheKey: string,
  builderTypes: MeshBuilderType[],
): Map<MeshBuilderType, WavefrontMeshData[]> | null {
  try {
    const raw = localStorage.getItem(cacheKey);
    if (!raw) return null;

    const entry: CacheEntry = JSON.parse(raw);

    const result = new Map<MeshBuilderType, WavefrontMeshData[]>();
    for (const bt of builderTypes) {
      const serialized = entry.meshSets[bt];
      if (!serialized) return null; // incomplete cache
      result.set(bt, serialized.map(deserializeMeshData));
    }

    return result;
  } catch {
    return null;
  }
}

/**
 * Store mesh data in cache. Clears any previous entries first.
 */
export function saveToCache(
  cacheKey: string,
  meshSets: Map<MeshBuilderType, WavefrontMeshData[]>,
): void {
  try {
    const entry: CacheEntry = { meshSets: {} };
    for (const [bt, meshes] of meshSets) {
      entry.meshSets[bt] = meshes.map(serializeMeshData);
    }

    const json = JSON.stringify(entry);
    clearOldEntries(cacheKey);
    localStorage.setItem(cacheKey, json);
  } catch {
    // localStorage full or unavailable — silently skip
  }
}
