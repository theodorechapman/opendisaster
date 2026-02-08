import type { Box3, Mesh, Vector3 } from "three";

export type TsunamiPhase = "dry" | "runup" | "crest" | "backwash";
export type TsunamiAccuracyMode = "realtime" | "enhanced";

export interface TsunamiParams {
  waveHeight: number;
  waveSpeed: number;
  waveWidth: number;
  turbulence: number;
  impactForce: number;
  buildingCollisionIntensity: number;
  fragmentMin: number;
  fragmentMax: number;
  debrisDrag: number;
  debrisCollisionDamping: number;
  splashIntensity: number;
  dropletDensity: number;
  maxSplashParticles: number;
  maxDroplets: number;
  breakThresholdMultiplier: number;
  buildingDestructionLevel: number;
  numWaves: number;
  wavePeriodSec: number;
  backwashStrength: number;
  impulseGain: number;
  debrisEntrainment: number;
  sedimentResponse: number;
  scourSensitivity: number;
  solverQuality: number;
  accuracyMode: TsunamiAccuracyMode;
  rhoWater: number;
  dragCoeffBuilding: number;
  impulseCoeffBore: number;
  addedMassCoeffDebris: number;
  dragCoeffDebris: number;
  liftCoeffDebris: number;
  surfaceTensionProxy: number;
  weberThreshold: number;
  restitutionBuilding: number;
  restitutionDebris: number;
  splashEnergyScale: number;
  maxDebrisSubsteps: number;
  maxParticleSubsteps: number;
  maxCollisionIterations: number;
  reflectionStrength: number;
  nonHydrostaticBoost: number;
}

export const DEFAULT_TSUNAMI_PARAMS: TsunamiParams = {
  waveHeight: 14,
  waveSpeed: 22,
  waveWidth: 55,
  turbulence: 1.4,
  impactForce: 1.0,
  buildingCollisionIntensity: 1.0,
  fragmentMin: 10,
  fragmentMax: 20,
  debrisDrag: 1.8,
  debrisCollisionDamping: 0.55,
  splashIntensity: 1.45,
  dropletDensity: 1.35,
  maxSplashParticles: 1100,
  maxDroplets: 2000,
  breakThresholdMultiplier: 1.0,
  buildingDestructionLevel: 1.0,
  numWaves: 3,
  wavePeriodSec: 120,
  backwashStrength: 0.45,
  impulseGain: 1.5,
  debrisEntrainment: 1.0,
  sedimentResponse: 1.0,
  scourSensitivity: 1.2,
  solverQuality: 1.15,
  accuracyMode: "enhanced",
  rhoWater: 1025,
  dragCoeffBuilding: 1.32,
  impulseCoeffBore: 1.1,
  addedMassCoeffDebris: 0.7,
  dragCoeffDebris: 1.08,
  liftCoeffDebris: 0.24,
  surfaceTensionProxy: 0.074,
  weberThreshold: 55,
  restitutionBuilding: 0.24,
  restitutionDebris: 0.38,
  splashEnergyScale: 1.1,
  maxDebrisSubsteps: 6,
  maxParticleSubsteps: 4,
  maxCollisionIterations: 4,
  reflectionStrength: 0.45,
  nonHydrostaticBoost: 0.38,
};

export interface TsunamiBounds {
  xMin: number;
  xMax: number;
  zMin: number;
  zMax: number;
  width: number;
  depth: number;
}

export interface TsunamiHydroState {
  depth: number;
  surfaceY: number;
  vx: number;
  vz: number;
  speed: number;
  froude: number;
  dynamicPressure: number;
  impulseFactor: number;
  phase: TsunamiPhase;
}

export interface TsunamiImpactEvent {
  x: number;
  y: number;
  z: number;
  nx: number;
  ny: number;
  nz: number;
  intensity: number;
  flowX: number;
  flowZ: number;
  radiusMeters: number;
}

export interface StructureFragilityParams {
  yieldDepth: number;
  yieldVelocity: number;
  collapseDepth: number;
  collapseVelocity: number;
  collapsePressure: number;
  debrisSensitivity: number;
  durationSensitivity: number;
}

export type TargetKind = "building" | "small";

export interface DestroyableTarget {
  mesh: Mesh;
  kind: TargetKind;
  bbox: Box3;
  center: Vector3;
  size: Vector3;
  baseArea: number;
  height: number;
  destroyed: boolean;
  originalVisible: boolean;
  impactCooldown: number;
  waveImpactCooldown: number;
  fragility: StructureFragilityParams;
  damageAccum: number;
  submergedDuration: number;
  debrisImpactAccum: number;
  peakDepth: number;
  peakSpeed: number;
  peakPressure: number;
  hydroForce: number;
  impactImpulse: number;
  reflectionFactor: number;
  localClosureRatio: number;
}

export interface SedimentCellState {
  erosion: number;
  deposition: number;
  scourRisk: number;
}

export function createHydroState(): TsunamiHydroState {
  return {
    depth: 0,
    surfaceY: 0,
    vx: 0,
    vz: 0,
    speed: 0,
    froude: 0,
    dynamicPressure: 0,
    impulseFactor: 1,
    phase: "dry",
  };
}
