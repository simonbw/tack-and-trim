export interface PhaseModel {
  phasePerStep: number;
  sourceStepAtRow: (rowIndex: number) => number;
}

export function createIdentityPhaseModel(
  phasePerStep: number = Math.PI,
): PhaseModel {
  return {
    phasePerStep,
    sourceStepAtRow: (rowIndex: number) => rowIndex,
  };
}

/**
 * Build a phase model from decimated row indices.
 *
 * `stepIndices` are the source-row indices returned by decimation.
 * `sourceStepOffset` adjusts those indices into the original marched step
 * space (for example, to account for prepended skirt rows).
 */
export function createIndexedPhaseModel(
  stepIndices: number[],
  phasePerStep: number,
  sourceStepOffset: number = 0,
): PhaseModel {
  return {
    phasePerStep,
    sourceStepAtRow: (rowIndex: number) => stepIndices[rowIndex] + sourceStepOffset,
  };
}
