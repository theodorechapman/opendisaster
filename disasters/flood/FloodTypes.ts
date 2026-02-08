import type { LayerData } from "../../src/tiles.ts";

export interface FloodRaster {
  width: number;
  height: number;
  xMin: number;
  xMax: number;
  zMin: number;
  zMax: number;
  dx: number;
  dz: number;
  terrain: Float32Array;
  obstacle: Uint8Array;
  sourceIndex: number;
  sourceX: number;
  sourceZ: number;
  sourceY: number;
}

export interface FloodInitContext {
  layers: LayerData;
  centerLat: number;
  centerLon: number;
}

export interface FloodSolverParams {
  gravity: number;
  cfl: number;
  minDt: number;
  maxDt: number;
  maxSubsteps: number;
  manningN: number;
  infiltrationRate: number; // m/s
  drainageRate: number; // 1/s
  wetThreshold: number;
  sourceEnabled: boolean;
  sourceFlowRate: number; // m^3/s
  sourceRadiusCells: number;
  rainRate: number; // m/s
}

export interface FloodStats {
  wetCellCount: number;
  maxDepth: number;
  totalVolume: number;
  lastDt: number;
}

export const DEFAULT_FLOOD_PARAMS: FloodSolverParams = {
  gravity: 9.81,
  cfl: 0.45,
  minDt: 0.001,
  maxDt: 0.05,
  maxSubsteps: 12,
  manningN: 0.03,
  infiltrationRate: 0.000001,
  drainageRate: 0.0005,
  wetThreshold: 0.001,
  sourceEnabled: true,
  sourceFlowRate: 6,
  sourceRadiusCells: 2,
  rainRate: 0,
};
