import type { WavefrontMeshData } from "../../MeshBuildTypes";
import type { WavePoint } from "./types";
import { VERTEX_FLOATS } from "./types";

/** Convert a list of wavefronts into triangulated mesh data. */
export function buildMeshData(
  wavefronts: WavePoint[][],
  wavelength: number,
  waveDx: number,
  waveDy: number,
): WavefrontMeshData {
  const vertices: number[] = [];
  const indices: number[] = [];
  const wavefrontOffsets: number[] = [];
  const k = (2 * Math.PI) / wavelength;

  for (let wi = 0; wi < wavefronts.length; wi++) {
    const wf = wavefronts[wi];
    wavefrontOffsets.push(vertices.length / VERTEX_FLOATS);
    const phase = wi * Math.PI;
    for (const p of wf) {
      // Actual phase from marching minus expected phase from base direction
      const phaseOffset = phase - k * (p.x * waveDx + p.y * waveDy);
      // [x, y, amplitude, dirOffset, phaseOffset, blendWeight]
      vertices.push(p.x, p.y, 1.0, 0, phaseOffset, 1.0);
    }
  }

  for (let wi = 0; wi < wavefronts.length - 1; wi++) {
    triangulateAdjacent(
      wavefronts[wi],
      wavefronts[wi + 1],
      wavefrontOffsets[wi],
      wavefrontOffsets[wi + 1],
      indices,
    );
  }

  return {
    vertices: new Float32Array(vertices),
    indices: new Uint32Array(indices),
    vertexCount: vertices.length / VERTEX_FLOATS,
    indexCount: indices.length,
  };
}

/**
 * Triangulate between two adjacent wavefronts using a sweep over
 * parametric t values. Handles wavefronts with different vertex counts.
 */
function triangulateAdjacent(
  prevWF: WavePoint[],
  nextWF: WavePoint[],
  prevBase: number,
  nextBase: number,
  indices: number[],
): void {
  let i = 0;
  let j = 0;
  while (i < prevWF.length - 1 || j < nextWF.length - 1) {
    if (i >= prevWF.length - 1) {
      indices.push(prevBase + i, nextBase + j, nextBase + j + 1);
      j++;
    } else if (j >= nextWF.length - 1) {
      indices.push(prevBase + i, prevBase + i + 1, nextBase + j);
      i++;
    } else if (prevWF[i + 1].t < nextWF[j + 1].t) {
      indices.push(prevBase + i, prevBase + i + 1, nextBase + j);
      i++;
    } else {
      indices.push(prevBase + i, nextBase + j, nextBase + j + 1);
      j++;
    }
  }
}
