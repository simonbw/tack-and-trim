export interface MeshBuildResolutionConfig {
  vertexSpacingFt: number;
  stepSizeFt: number;
}

export interface MeshBuildBoundsConfig {
  upwaveMarginWavelengths: number;
  downwaveMarginWavelengths: number;
  crosswaveMarginWavelengths: number;
  minMarginFt: number;
  fallbackHalfExtentFt: number;
}

export interface MeshBuildRefinementConfig {
  minEnergy: number;
  maxEnergyRatio: number;
  mergeRatio: number;
  baseSplitRatio: number;
  splitEscalation: number;
  maxSplitRatio: number;
  maxSplitsPerSegment: number;
  maxSegmentPoints: number;
  minSplitEnergy: number;
}

export interface MeshBuildPhysicsConfig {
  minSpeedFactor: number;
  maxTurnPerStepRad: number;
  breakingDepthRatio: number;
  breakingDecayRate: number;
  bottomFrictionRate: number;
  refractionDissipation: number;
  turbulenceScale: number;
  turbulenceDecayRate: number;
}

export interface MeshBuildPostConfig {
  maxDiffusionD: number;
  diffractionIterations: number;
  turbulenceDiffusionIterations: number;
  turbulenceDiffusionD: number;
  maxAmplification: number;
}

export interface MeshBuildDecimationConfig {
  tolerance: number;
}

export interface MeshBuildConfig {
  resolution: MeshBuildResolutionConfig;
  bounds: MeshBuildBoundsConfig;
  refinement: MeshBuildRefinementConfig;
  physics: MeshBuildPhysicsConfig;
  post: MeshBuildPostConfig;
  decimation: MeshBuildDecimationConfig;
}

export const DEFAULT_MESH_BUILD_CONFIG: MeshBuildConfig = {
  resolution: {
    vertexSpacingFt: 20,
    stepSizeFt: 10,
  },
  bounds: {
    upwaveMarginWavelengths: 10,
    downwaveMarginWavelengths: 80,
    crosswaveMarginWavelengths: 20,
    minMarginFt: 2000,
    fallbackHalfExtentFt: 500,
  },
  refinement: {
    minEnergy: 0.03,
    maxEnergyRatio: 5,
    mergeRatio: 0.3,
    baseSplitRatio: 1.5,
    splitEscalation: 1.25,
    maxSplitRatio: 16.0,
    maxSplitsPerSegment: 100,
    maxSegmentPoints: 5000,
    minSplitEnergy: 0.1,
  },
  physics: {
    minSpeedFactor: 0.25,
    maxTurnPerStepRad: Math.PI / 8,
    breakingDepthRatio: 0.07,
    breakingDecayRate: 1.2,
    bottomFrictionRate: 0.3,
    refractionDissipation: 1.0,
    turbulenceScale: 8.0,
    turbulenceDecayRate: 2.0,
  },
  post: {
    maxDiffusionD: 0.5,
    diffractionIterations: 10,
    turbulenceDiffusionIterations: 3,
    turbulenceDiffusionD: 0.3,
    maxAmplification: 2.0,
  },
  decimation: {
    tolerance: 0.02,
  },
};

export const TEST_MESH_BUILD_CONFIG: MeshBuildConfig = {
  ...DEFAULT_MESH_BUILD_CONFIG,
  resolution: {
    vertexSpacingFt: 200,
    stepSizeFt: 100,
  },
};

type EnvLike = Record<string, string | undefined>;

interface ConfigOverrideDef {
  env: string;
  apply: (cfg: MeshBuildConfig, value: number) => void;
}

const CONFIG_OVERRIDE_DEFS: ConfigOverrideDef[] = [
  {
    env: "MESH_BUILD_VERTEX_SPACING_FT",
    apply: (cfg, value) => (cfg.resolution.vertexSpacingFt = value),
  },
  {
    env: "MESH_BUILD_STEP_SIZE_FT",
    apply: (cfg, value) => (cfg.resolution.stepSizeFt = value),
  },
  {
    env: "MESH_BUILD_BOUNDS_UPWAVE_MARGIN_WAVELENGTHS",
    apply: (cfg, value) => (cfg.bounds.upwaveMarginWavelengths = value),
  },
  {
    env: "MESH_BUILD_BOUNDS_DOWNWAVE_MARGIN_WAVELENGTHS",
    apply: (cfg, value) => (cfg.bounds.downwaveMarginWavelengths = value),
  },
  {
    env: "MESH_BUILD_BOUNDS_CROSSWAVE_MARGIN_WAVELENGTHS",
    apply: (cfg, value) => (cfg.bounds.crosswaveMarginWavelengths = value),
  },
  {
    env: "MESH_BUILD_BOUNDS_MIN_MARGIN_FT",
    apply: (cfg, value) => (cfg.bounds.minMarginFt = value),
  },
  {
    env: "MESH_BUILD_BOUNDS_FALLBACK_HALF_EXTENT_FT",
    apply: (cfg, value) => (cfg.bounds.fallbackHalfExtentFt = value),
  },
  {
    env: "MESH_BUILD_REFINEMENT_MIN_ENERGY",
    apply: (cfg, value) => (cfg.refinement.minEnergy = value),
  },
  {
    env: "MESH_BUILD_REFINEMENT_MAX_ENERGY_RATIO",
    apply: (cfg, value) => (cfg.refinement.maxEnergyRatio = value),
  },
  {
    env: "MESH_BUILD_REFINEMENT_MERGE_RATIO",
    apply: (cfg, value) => (cfg.refinement.mergeRatio = value),
  },
  {
    env: "MESH_BUILD_REFINEMENT_BASE_SPLIT_RATIO",
    apply: (cfg, value) => (cfg.refinement.baseSplitRatio = value),
  },
  {
    env: "MESH_BUILD_REFINEMENT_SPLIT_ESCALATION",
    apply: (cfg, value) => (cfg.refinement.splitEscalation = value),
  },
  {
    env: "MESH_BUILD_REFINEMENT_MAX_SPLIT_RATIO",
    apply: (cfg, value) => (cfg.refinement.maxSplitRatio = value),
  },
  {
    env: "MESH_BUILD_REFINEMENT_MAX_SPLITS_PER_SEGMENT",
    apply: (cfg, value) => (cfg.refinement.maxSplitsPerSegment = value),
  },
  {
    env: "MESH_BUILD_REFINEMENT_MAX_SEGMENT_POINTS",
    apply: (cfg, value) => (cfg.refinement.maxSegmentPoints = value),
  },
  {
    env: "MESH_BUILD_REFINEMENT_MIN_SPLIT_ENERGY",
    apply: (cfg, value) => (cfg.refinement.minSplitEnergy = value),
  },
  {
    env: "MESH_BUILD_PHYSICS_MIN_SPEED_FACTOR",
    apply: (cfg, value) => (cfg.physics.minSpeedFactor = value),
  },
  {
    env: "MESH_BUILD_PHYSICS_MAX_TURN_PER_STEP_RAD",
    apply: (cfg, value) => (cfg.physics.maxTurnPerStepRad = value),
  },
  {
    env: "MESH_BUILD_PHYSICS_BREAKING_DEPTH_RATIO",
    apply: (cfg, value) => (cfg.physics.breakingDepthRatio = value),
  },
  {
    env: "MESH_BUILD_PHYSICS_BREAKING_DECAY_RATE",
    apply: (cfg, value) => (cfg.physics.breakingDecayRate = value),
  },
  {
    env: "MESH_BUILD_PHYSICS_BOTTOM_FRICTION_RATE",
    apply: (cfg, value) => (cfg.physics.bottomFrictionRate = value),
  },
  {
    env: "MESH_BUILD_PHYSICS_REFRACTION_DISSIPATION",
    apply: (cfg, value) => (cfg.physics.refractionDissipation = value),
  },
  {
    env: "MESH_BUILD_PHYSICS_TURBULENCE_SCALE",
    apply: (cfg, value) => (cfg.physics.turbulenceScale = value),
  },
  {
    env: "MESH_BUILD_PHYSICS_TURBULENCE_DECAY_RATE",
    apply: (cfg, value) => (cfg.physics.turbulenceDecayRate = value),
  },
  {
    env: "MESH_BUILD_POST_MAX_DIFFUSION_D",
    apply: (cfg, value) => (cfg.post.maxDiffusionD = value),
  },
  {
    env: "MESH_BUILD_POST_DIFFRACTION_ITERATIONS",
    apply: (cfg, value) => (cfg.post.diffractionIterations = value),
  },
  {
    env: "MESH_BUILD_POST_TURBULENCE_DIFFUSION_ITERATIONS",
    apply: (cfg, value) => (cfg.post.turbulenceDiffusionIterations = value),
  },
  {
    env: "MESH_BUILD_POST_TURBULENCE_DIFFUSION_D",
    apply: (cfg, value) => (cfg.post.turbulenceDiffusionD = value),
  },
  {
    env: "MESH_BUILD_POST_MAX_AMPLIFICATION",
    apply: (cfg, value) => (cfg.post.maxAmplification = value),
  },
  {
    env: "MESH_BUILD_DECIMATION_TOLERANCE",
    apply: (cfg, value) => (cfg.decimation.tolerance = value),
  },
];

function cloneMeshBuildConfig(config: MeshBuildConfig): MeshBuildConfig {
  return {
    resolution: { ...config.resolution },
    bounds: { ...config.bounds },
    refinement: { ...config.refinement },
    physics: { ...config.physics },
    post: { ...config.post },
    decimation: { ...config.decimation },
  };
}

export function resolveMeshBuildConfig(
  baseConfig: MeshBuildConfig,
  env: EnvLike = process.env,
): { config: MeshBuildConfig; overrides: string[] } {
  const config = cloneMeshBuildConfig(baseConfig);
  const overrides: string[] = [];

  for (const def of CONFIG_OVERRIDE_DEFS) {
    const raw = env[def.env];
    if (raw === undefined || raw === "") continue;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) {
      throw new Error(
        `Invalid mesh build override ${def.env}=${raw}. Expected a finite number.`,
      );
    }
    def.apply(config, parsed);
    overrides.push(`${def.env}=${raw}`);
  }

  return { config, overrides };
}
