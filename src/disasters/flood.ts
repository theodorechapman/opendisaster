import * as THREE from "three";
import { NodeMaterial } from "three/webgpu";
import {
  uniform, attribute, float, vec2, vec3, vec4,
  sin, cos, fract, floor, dot, mix, smoothstep, pow, abs, clamp, length, normalize, cross, reflect, exp, max, min,
  uv, positionLocal, positionWorld, cameraPosition,
  Fn, If, Discard,
  varying,
} from "three/tsl";
import type { LayerData, BuildingFeature } from "../tiles.ts";
import { metersPerDegree } from "../tiles.ts";
import type { EventBus } from "../core/EventBus.ts";
import { sceneGroupRef } from "../layers.ts";

interface FloodInitContext {
  layers: LayerData;
  centerLat: number;
  centerLon: number;
  parent?: THREE.Group | THREE.Scene;
  sunLight?: THREE.DirectionalLight;
}

interface FloodRaster {
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

interface FloodSolverParams {
  gravity: number;
  cfl: number;
  minDt: number;
  maxDt: number;
  maxSubsteps: number;
  manningN: number;
  infiltrationRate: number;
  drainageRate: number;
  wetThreshold: number;
  sourceEnabled: boolean;
  sourceFlowRate: number;
  sourceRadiusCells: number;
  rainRate: number;
}

interface FloodStats {
  wetCellCount: number;
  maxDepth: number;
  totalVolume: number;
  lastDt: number;
}

const DEFAULT_FLOOD_PARAMS: FloodSolverParams = {
  gravity: 9.81,
  cfl: 0.62,
  minDt: 0.001,
  maxDt: 0.05,
  maxSubsteps: 28,
  manningN: 0.0008,
  infiltrationRate: 0,
  drainageRate: 0,
  wetThreshold: 0.001,
  sourceEnabled: true,
  sourceFlowRate: 34,
  sourceRadiusCells: 2,
  rainRate: 0,
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value | 0));
}

// --- Rasterization ---

type PolygonXZ = {
  points: [number, number][];
  xMin: number;
  xMax: number;
  zMin: number;
  zMax: number;
};

function buildFloodRaster(
  ctx: FloodInitContext,
  options: { targetCellSizeMeters?: number; minResolution?: number; maxResolution?: number } = {},
  sourceOverride?: { x: number; z: number },
): FloodRaster {
  const opts = {
    targetCellSizeMeters: 2.0,
    minResolution: 96,
    maxResolution: 320,
    ...options,
  };
  const { layers, centerLat, centerLon } = ctx;
  const mpd = metersPerDegree(centerLat);

  const elev = layers.elevation;
  const xMin = (elev.west - centerLon) * mpd.lon;
  const xMax = (elev.east - centerLon) * mpd.lon;
  const zMin = -((elev.north - centerLat) * mpd.lat);
  const zMax = -((elev.south - centerLat) * mpd.lat);
  const widthMeters = xMax - xMin;
  const heightMeters = zMax - zMin;

  const width = clampInt(
    Math.round(widthMeters / opts.targetCellSizeMeters) + 1,
    opts.minResolution,
    opts.maxResolution,
  );
  const height = clampInt(
    Math.round(heightMeters / opts.targetCellSizeMeters) + 1,
    opts.minResolution,
    opts.maxResolution,
  );

  const dx = widthMeters / (width - 1);
  const dz = heightMeters / (height - 1);

  let minElev = Number.POSITIVE_INFINITY;
  for (const row of elev.values) {
    for (const value of row) {
      if (value < minElev) minElev = value;
    }
  }

  const terrain = new Float32Array(width * height);
  for (let j = 0; j < height; j++) {
    const z = zMin + j * dz;
    for (let i = 0; i < width; i++) {
      const x = xMin + i * dx;
      terrain[j * width + i] = sampleTerrainBilinear(
        elev.values,
        elev.gridSize,
        minElev,
        x,
        z,
        xMin,
        xMax,
        zMin,
        zMax,
      );
    }
  }

  const obstacle = new Uint8Array(width * height);
  const buildingPolys = extractBuildingPolygons(layers.buildings.features, centerLat, centerLon);
  rasterizeObstacles(obstacle, buildingPolys, width, height, xMin, zMin, dx, dz);

  const centerI = Math.floor(width * 0.5);
  const centerJ = Math.floor(height * 0.5);

  let sourceIndex = findMidElevationOpenCell(terrain, obstacle, width, height, centerI, centerJ);

  if (sourceOverride) {
    const i = clampInt(Math.round((sourceOverride.x - xMin) / dx), 0, width - 1);
    const j = clampInt(Math.round((sourceOverride.z - zMin) / dz), 0, height - 1);
    const idx = j * width + i;
    sourceIndex = findNearestOpenCell(obstacle, width, height, i, j, idx);
  }

  const sourceI = sourceIndex % width;
  const sourceJ = Math.floor(sourceIndex / width);
  const sourceX = xMin + sourceI * dx;
  const sourceZ = zMin + sourceJ * dz;
  const sourceY = terrain[sourceIndex]!;

  return {
    width,
    height,
    xMin,
    xMax,
    zMin,
    zMax,
    dx,
    dz,
    terrain,
    obstacle,
    sourceIndex,
    sourceX,
    sourceZ,
    sourceY,
  };
}

function sampleTerrainBilinear(
  values: number[][],
  gridSize: number,
  minElev: number,
  x: number,
  z: number,
  xMin: number,
  xMax: number,
  zMin: number,
  zMax: number,
): number {
  const colFrac = ((x - xMin) / (xMax - xMin)) * (gridSize - 1);
  const rowFrac = ((zMax - z) / (zMax - zMin)) * (gridSize - 1);
  const col0 = clampInt(Math.floor(colFrac), 0, gridSize - 2);
  const row0 = clampInt(Math.floor(rowFrac), 0, gridSize - 2);
  const col1 = col0 + 1;
  const row1 = row0 + 1;
  const ct = colFrac - col0;
  const rt = rowFrac - row0;

  const v00 = values[row0]![col0]! - minElev;
  const v01 = values[row0]![col1]! - minElev;
  const v10 = values[row1]![col0]! - minElev;
  const v11 = values[row1]![col1]! - minElev;

  const top = v00 * (1 - ct) + v01 * ct;
  const bottom = v10 * (1 - ct) + v11 * ct;
  return top * (1 - rt) + bottom * rt;
}

function extractBuildingPolygons(
  features: BuildingFeature[],
  centerLat: number,
  centerLon: number,
): PolygonXZ[] {
  const mpd = metersPerDegree(centerLat);
  const polygons: PolygonXZ[] = [];

  for (const feature of features) {
    const rings = getPolygonRings(feature.geometry);
    for (const polyRings of rings) {
      const outer = polyRings[0];
      if (!outer || outer.length < 3) continue;

      const points: [number, number][] = [];
      let xMin = Number.POSITIVE_INFINITY;
      let xMax = Number.NEGATIVE_INFINITY;
      let zMin = Number.POSITIVE_INFINITY;
      let zMax = Number.NEGATIVE_INFINITY;

      for (const coord of outer) {
        const x = (coord[0]! - centerLon) * mpd.lon;
        const z = -((coord[1]! - centerLat) * mpd.lat);
        points.push([x, z]);
        if (x < xMin) xMin = x;
        if (x > xMax) xMax = x;
        if (z < zMin) zMin = z;
        if (z > zMax) zMax = z;
      }

      polygons.push({ points, xMin, xMax, zMin, zMax });
    }
  }

  return polygons;
}

function getPolygonRings(geometry: BuildingFeature["geometry"]): number[][][][] {
  if (geometry.type === "Polygon") return [geometry.coordinates as number[][][]];
  if (geometry.type === "MultiPolygon") return geometry.coordinates as number[][][][];
  return [];
}

function rasterizeObstacles(
  mask: Uint8Array,
  polygons: PolygonXZ[],
  width: number,
  height: number,
  xMin: number,
  zMin: number,
  dx: number,
  dz: number,
): void {
  for (const polygon of polygons) {
    const iMin = clampInt(Math.floor((polygon.xMin - xMin) / dx), 0, width - 1);
    const iMax = clampInt(Math.ceil((polygon.xMax - xMin) / dx), 0, width - 1);
    const jMin = clampInt(Math.floor((polygon.zMin - zMin) / dz), 0, height - 1);
    const jMax = clampInt(Math.ceil((polygon.zMax - zMin) / dz), 0, height - 1);

    for (let j = jMin; j <= jMax; j++) {
      const z = zMin + j * dz;
      for (let i = iMin; i <= iMax; i++) {
        if (mask[j * width + i] !== 0) continue;
        const x = xMin + i * dx;
        if (pointInPolygon(x, z, polygon.points)) {
          mask[j * width + i] = 1;
        }
      }
    }
  }
}

function pointInPolygon(x: number, z: number, poly: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i]![0];
    const zi = poly[i]![1];
    const xj = poly[j]![0];
    const zj = poly[j]![1];
    const intersect = (zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / ((zj - zi) || 1e-6) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function findNearestOpenCell(
  obstacle: Uint8Array,
  width: number,
  height: number,
  startI: number,
  startJ: number,
  fallbackIdx: number,
): number {
  const i0 = clampInt(startI, 0, width - 1);
  const j0 = clampInt(startJ, 0, height - 1);
  const startIdx = j0 * width + i0;
  if (obstacle[startIdx] === 0) return startIdx;

  const maxRadius = Math.max(width, height);
  for (let r = 1; r <= maxRadius; r++) {
    const iMin = Math.max(0, i0 - r);
    const iMax = Math.min(width - 1, i0 + r);
    const jMin = Math.max(0, j0 - r);
    const jMax = Math.min(height - 1, j0 + r);

    for (let i = iMin; i <= iMax; i++) {
      const topIdx = jMin * width + i;
      if (obstacle[topIdx] === 0) return topIdx;
      const bottomIdx = jMax * width + i;
      if (obstacle[bottomIdx] === 0) return bottomIdx;
    }
    for (let j = jMin + 1; j < jMax; j++) {
      const leftIdx = j * width + iMin;
      if (obstacle[leftIdx] === 0) return leftIdx;
      const rightIdx = j * width + iMax;
      if (obstacle[rightIdx] === 0) return rightIdx;
    }
  }

  return fallbackIdx;
}

function findMidElevationOpenCell(
  terrain: Float32Array,
  obstacle: Uint8Array,
  width: number,
  height: number,
  fallbackI: number,
  fallbackJ: number,
): number {
  let minElev = Number.POSITIVE_INFINITY;
  let maxElev = Number.NEGATIVE_INFINITY;

  for (let idx = 0; idx < terrain.length; idx++) {
    if (obstacle[idx] !== 0) continue;
    const y = terrain[idx]!;
    if (y < minElev) minElev = y;
    if (y > maxElev) maxElev = y;
  }

  if (!Number.isFinite(minElev) || !Number.isFinite(maxElev)) {
    return findNearestOpenCell(obstacle, width, height, fallbackI, fallbackJ, fallbackJ * width + fallbackI);
  }

  const targetElev = (minElev + maxElev) * 0.5;
  let bestIdx = -1;
  let bestElevDelta = Number.POSITIVE_INFINITY;
  let bestCenterDistSq = Number.POSITIVE_INFINITY;

  for (let idx = 0; idx < terrain.length; idx++) {
    if (obstacle[idx] !== 0) continue;
    const y = terrain[idx]!;
    const elevDelta = Math.abs(y - targetElev);
    const i = idx % width;
    const j = Math.floor(idx / width);
    const di = i - fallbackI;
    const dj = j - fallbackJ;
    const centerDistSq = di * di + dj * dj;
    if (
      elevDelta < bestElevDelta - 1e-6 ||
      (Math.abs(elevDelta - bestElevDelta) <= 1e-6 && centerDistSq < bestCenterDistSq)
    ) {
      bestElevDelta = elevDelta;
      bestCenterDistSq = centerDistSq;
      bestIdx = idx;
    }
  }

  if (bestIdx >= 0) return bestIdx;
  return findNearestOpenCell(obstacle, width, height, fallbackI, fallbackJ, fallbackJ * width + fallbackI);
}

// --- Solver ---

class ShallowWaterSolver {
  readonly xMin: number;
  readonly xMax: number;
  readonly zMin: number;
  readonly zMax: number;
  readonly width: number;
  readonly height: number;
  readonly dx: number;
  readonly dz: number;
  readonly terrain: Float32Array;
  readonly obstacle: Uint8Array;

  depth: Float32Array;
  mx: Float32Array;
  my: Float32Array;

  private nextDepth: Float32Array;
  private nextMx: Float32Array;
  private nextMy: Float32Array;

  private fluxX: Float32Array;
  private fluxY: Float32Array;
  private sourceMask: Uint8Array;
  private sourceWeight: Float32Array;
  private sourceDirX: Float32Array;
  private sourceDirY: Float32Array;
  private sourceWeightSum = 0;
  private terrainSlopeX: Float32Array;
  private terrainSlopeY: Float32Array;

  private params: FloodSolverParams;
  private sourceX: number;
  private sourceZ: number;
  private sourceY: number;
  private sourceIndex: number;
  private sourceDepthMeters = 10.0;
  private readonly minSourceDepthMeters = 10.0;
  private readonly slopeForceScale = 0.32;
  private readonly baseEddyViscosity = 0.18;
  private readonly maxFroude = 2.8;

  lastDt = 0;
  elapsed = 0;

  stats: FloodStats = {
    wetCellCount: 0,
    maxDepth: 0,
    totalVolume: 0,
    lastDt: 0,
  };

  constructor(raster: FloodRaster, params: Partial<FloodSolverParams> = {}) {
    this.xMin = raster.xMin;
    this.xMax = raster.xMax;
    this.zMin = raster.zMin;
    this.zMax = raster.zMax;
    this.width = raster.width;
    this.height = raster.height;
    this.dx = raster.dx;
    this.dz = raster.dz;
    this.terrain = raster.terrain;
    this.obstacle = raster.obstacle;

    this.depth = new Float32Array(this.width * this.height);
    this.mx = new Float32Array(this.width * this.height);
    this.my = new Float32Array(this.width * this.height);
    this.nextDepth = new Float32Array(this.width * this.height);
    this.nextMx = new Float32Array(this.width * this.height);
    this.nextMy = new Float32Array(this.width * this.height);

    this.fluxX = new Float32Array((this.width + 1) * this.height * 3);
    this.fluxY = new Float32Array(this.width * (this.height + 1) * 3);
    this.terrainSlopeX = new Float32Array(this.width * this.height);
    this.terrainSlopeY = new Float32Array(this.width * this.height);

    this.sourceMask = new Uint8Array(this.width * this.height);
    this.sourceWeight = new Float32Array(this.width * this.height);
    this.sourceDirX = new Float32Array(this.width * this.height);
    this.sourceDirY = new Float32Array(this.width * this.height);
    this.params = { ...DEFAULT_FLOOD_PARAMS, ...params };

    this.sourceX = raster.sourceX;
    this.sourceZ = raster.sourceZ;
    this.sourceY = raster.sourceY;
    this.sourceIndex = raster.sourceIndex;
    this.computeTerrainSlopes();
    this.rebuildSourceMask();
    this.reset();
  }

  reset(): void {
    this.depth.fill(0);
    this.mx.fill(0);
    this.my.fill(0);
    this.nextDepth.fill(0);
    this.nextMx.fill(0);
    this.nextMy.fill(0);
    this.lastDt = 0;
    this.elapsed = 0;
    this.stats = {
      wetCellCount: 0,
      maxDepth: 0,
      totalVolume: 0,
      lastDt: 0,
    };

    this.applySourceDepthFloor();
    this.stats = this.computeStats();
    this.stats.lastDt = this.lastDt;
  }

  setSourceEnabled(enabled: boolean): void {
    this.params.sourceEnabled = enabled;
  }

  setSourceFlowRate(flowM3PerSec: number): void {
    this.params.sourceFlowRate = Math.max(0, flowM3PerSec);
  }

  setSourceDepthMeters(depthMeters: number): void {
    this.sourceDepthMeters = Math.max(this.minSourceDepthMeters, depthMeters);
    this.applySourceDepthFloor();
    this.stats = this.computeStats();
    this.stats.lastDt = this.lastDt;
  }

  setRainRateMmPerHour(mmPerHour: number): void {
    this.params.rainRate = Math.max(0, mmPerHour) / 1000 / 3600;
  }

  getSourcePosition(): { x: number; z: number; y: number } {
    return { x: this.sourceX, z: this.sourceZ, y: this.sourceY };
  }

  cellIndexToWorld(idx: number): { x: number; z: number } {
    const i = idx % this.width;
    const j = Math.floor(idx / this.width);
    return { x: this.xMin + i * this.dx, z: this.zMin + j * this.dz };
  }

  sampleStateAtWorld(
    x: number,
    z: number,
    preferOpen = true,
    searchRadiusCells = 2,
  ): {
    idx: number;
    depth: number;
    u: number;
    v: number;
    terrainY: number;
    surfaceY: number;
    obstacle: boolean;
  } {
    const i = clampInt(Math.round((x - this.xMin) / Math.max(1e-6, this.dx)), 0, this.width - 1);
    const j = clampInt(Math.round((z - this.zMin) / Math.max(1e-6, this.dz)), 0, this.height - 1);
    let idx = j * this.width + i;

    if (preferOpen && this.obstacle[idx] !== 0) {
      idx = this.findNearestOpenCell(i, j, searchRadiusCells, idx);
    }

    const depth = this.depth[idx]!;
    const obstacle = this.obstacle[idx] !== 0;
    const u = !obstacle && depth > this.params.wetThreshold ? this.mx[idx]! / depth : 0;
    const v = !obstacle && depth > this.params.wetThreshold ? this.my[idx]! / depth : 0;
    const terrainY = this.terrain[idx]!;
    const surfaceY = terrainY + depth;
    return { idx, depth, u, v, terrainY, surfaceY, obstacle };
  }

  clearObstaclesInAabb(minX: number, maxX: number, minZ: number, maxZ: number): void {
    const iMin = clampInt(Math.floor((Math.min(minX, maxX) - this.xMin) / this.dx), 0, this.width - 1);
    const iMax = clampInt(Math.ceil((Math.max(minX, maxX) - this.xMin) / this.dx), 0, this.width - 1);
    const jMin = clampInt(Math.floor((Math.min(minZ, maxZ) - this.zMin) / this.dz), 0, this.height - 1);
    const jMax = clampInt(Math.ceil((Math.max(minZ, maxZ) - this.zMin) / this.dz), 0, this.height - 1);
    for (let j = jMin; j <= jMax; j++) {
      for (let i = iMin; i <= iMax; i++) {
        this.obstacle[j * this.width + i] = 0;
      }
    }
  }

  injectMomentumImpulse(
    x: number,
    z: number,
    vx: number,
    vz: number,
    radiusMeters: number,
    strength = 1,
  ): void {
    const rCells = Math.max(1, Math.ceil(radiusMeters / Math.max(1e-6, Math.min(this.dx, this.dz))));
    const ci = clampInt(Math.round((x - this.xMin) / this.dx), 0, this.width - 1);
    const cj = clampInt(Math.round((z - this.zMin) / this.dz), 0, this.height - 1);
    const r2 = rCells * rCells;

    for (let j = Math.max(0, cj - rCells); j <= Math.min(this.height - 1, cj + rCells); j++) {
      for (let i = Math.max(0, ci - rCells); i <= Math.min(this.width - 1, ci + rCells); i++) {
        const di = i - ci;
        const dj = j - cj;
        const d2 = di * di + dj * dj;
        if (d2 > r2) continue;
        const idx = j * this.width + i;
        if (this.obstacle[idx] !== 0) continue;
        const w = Math.exp(-d2 / Math.max(1, r2 * 0.5)) * strength;
        const d = Math.max(this.depth[idx]!, this.params.wetThreshold);
        this.mx[idx] = (this.mx[idx] ?? 0) + vx * w * d;
        this.my[idx] = (this.my[idx] ?? 0) + vz * w * d;
      }
    }
  }

  step(frameDt: number): void {
    let remaining = Math.max(0, frameDt);
    let substeps = 0;

    while (remaining > 1e-6 && substeps < this.params.maxSubsteps) {
      const cflDt = this.computeCflDt();
      const dt = Math.min(remaining, cflDt, this.params.maxDt);
      if (dt < this.params.minDt * 0.25) break;
      this.advance(dt);
      this.elapsed += dt;
      this.lastDt = dt;
      remaining -= dt;
      substeps++;
    }

    this.stats = this.computeStats();
    this.stats.lastDt = this.lastDt;
  }

  private rebuildSourceMask(): void {
    this.sourceMask.fill(0);
    this.sourceWeight.fill(0);
    this.sourceDirX.fill(0);
    this.sourceDirY.fill(0);
    const r = Math.max(0, this.params.sourceRadiusCells | 0);
    const sx = this.sourceIndex % this.width;
    const sy = Math.floor(this.sourceIndex / this.width);
    let totalWeight = 0;

    for (let j = sy - r; j <= sy + r; j++) {
      if (j < 0 || j >= this.height) continue;
      for (let i = sx - r; i <= sx + r; i++) {
        if (i < 0 || i >= this.width) continue;
        const dd = (i - sx) * (i - sx) + (j - sy) * (j - sy);
        if (dd > r * r) continue;
        const idx = j * this.width + i;
        if (this.obstacle[idx] !== 0) continue;
        this.sourceMask[idx] = 1;
        const dist = Math.sqrt(dd);
        const radius = Math.max(1e-6, r + 0.35);
        const edge = Math.max(0, 1 - dist / radius);
        const weight = edge * edge * (3 - 2 * edge);
        if (weight <= 0) continue;
        totalWeight += weight;
        this.sourceWeight[idx] = weight;
        if (dd > 1e-6) {
          const invLen = 1 / dist;
          this.sourceDirX[idx] = (i - sx) * invLen;
          this.sourceDirY[idx] = (j - sy) * invLen;
        }
      }
    }

    if (totalWeight <= 0 && this.obstacle[this.sourceIndex] === 0) {
      this.sourceMask[this.sourceIndex] = 1;
      this.sourceWeight[this.sourceIndex] = 1;
      totalWeight = 1;
    }
    this.sourceWeightSum = Math.max(1e-6, totalWeight);
  }

  private sourceDepthRate(): number {
    if (!this.params.sourceEnabled || this.params.sourceFlowRate <= 0) return 0;
    const cellArea = this.dx * this.dz;
    return this.params.sourceFlowRate / (cellArea * this.sourceWeightSum);
  }

  private findNearestOpenCell(i0: number, j0: number, maxRadius: number, fallbackIdx: number): number {
    if (this.obstacle[fallbackIdx] === 0) return fallbackIdx;

    for (let r = 1; r <= Math.max(1, maxRadius); r++) {
      const iMin = Math.max(0, i0 - r);
      const iMax = Math.min(this.width - 1, i0 + r);
      const jMin = Math.max(0, j0 - r);
      const jMax = Math.min(this.height - 1, j0 + r);

      for (let i = iMin; i <= iMax; i++) {
        const topIdx = jMin * this.width + i;
        if (this.obstacle[topIdx] === 0) return topIdx;
        const bottomIdx = jMax * this.width + i;
        if (this.obstacle[bottomIdx] === 0) return bottomIdx;
      }
      for (let j = jMin + 1; j < jMax; j++) {
        const leftIdx = j * this.width + iMin;
        if (this.obstacle[leftIdx] === 0) return leftIdx;
        const rightIdx = j * this.width + iMax;
        if (this.obstacle[rightIdx] === 0) return rightIdx;
      }
    }
    return fallbackIdx;
  }

  private computeTerrainSlopes(): void {
    const w = this.width;
    const h = this.height;
    const inv2dx = 1 / Math.max(1e-6, 2 * this.dx);
    const inv2dz = 1 / Math.max(1e-6, 2 * this.dz);
    for (let j = 0; j < h; j++) {
      const jm = j > 0 ? j - 1 : j;
      const jp = j < h - 1 ? j + 1 : j;
      for (let i = 0; i < w; i++) {
        const im = i > 0 ? i - 1 : i;
        const ip = i < w - 1 ? i + 1 : i;
        const idx = j * w + i;
        const zl = this.terrain[j * w + im]!;
        const zr = this.terrain[j * w + ip]!;
        const zb = this.terrain[jm * w + i]!;
        const zt = this.terrain[jp * w + i]!;
        this.terrainSlopeX[idx] = (zr - zl) * inv2dx;
        this.terrainSlopeY[idx] = (zt - zb) * inv2dz;
      }
    }
  }

  private velocityAt(idx: number): { u: number; v: number } {
    const d = this.depth[idx]!;
    if (d <= this.params.wetThreshold) return { u: 0, v: 0 };
    return { u: this.mx[idx]! / d, v: this.my[idx]! / d };
  }

  private sourceTargetDepthAt(idx: number): number {
    const w = this.sourceWeight[idx]!;
    if (w <= 0) return 0;
    return this.minSourceDepthMeters + (this.sourceDepthMeters - this.minSourceDepthMeters) * w;
  }

  private sourceJetSpeed(sourceRateMetersPerSec: number): number {
    return Math.min(8.5, 2.8 + Math.sqrt(Math.max(0, sourceRateMetersPerSec)));
  }

  private applySourceDepthFloor(): void {
    for (let idx = 0; idx < this.sourceMask.length; idx++) {
      if (this.sourceMask[idx] !== 0 && this.obstacle[idx] === 0 && this.sourceWeight[idx]! > 0) {
        const targetDepth = this.sourceTargetDepthAt(idx);
        this.depth[idx] = Math.max(this.depth[idx]!, targetDepth);
      }
    }
  }

  private computeCflDt(): number {
    const g = this.params.gravity;
    const eps = this.params.wetThreshold;
    let maxSpeed = 0;

    for (let idx = 0; idx < this.depth.length; idx++) {
      if (this.obstacle[idx] !== 0) continue;
      const h = this.depth[idx]!;
      if (h <= eps) continue;
      const u = this.mx[idx]! / h;
      const v = this.my[idx]! / h;
      const c = Math.sqrt(g * h);
      const speed = Math.max(Math.abs(u) + c, Math.abs(v) + c);
      if (speed > maxSpeed) maxSpeed = speed;
    }

    if (maxSpeed < 1e-6) return this.params.maxDt;
    const minCell = Math.min(this.dx, this.dz);
    return Math.max(this.params.minDt, this.params.cfl * minCell / maxSpeed);
  }

  private advance(dt: number): void {
    const w = this.width;
    const h = this.height;
    const invDx = dt / this.dx;
    const invDz = dt / this.dz;
    const invDx2 = 1 / Math.max(1e-6, this.dx * this.dx);
    const invDz2 = 1 / Math.max(1e-6, this.dz * this.dz);
    const sourceRate = this.sourceDepthRate();
    const g = this.params.gravity;
    const eps = this.params.wetThreshold;
    const sourceJet = this.sourceJetSpeed(sourceRate);

    for (let j = 0; j < h; j++) {
      for (let xi = 0; xi <= w; xi++) {
        const off = (j * (w + 1) + xi) * 3;

        let lIdx = -1;
        let rIdx = -1;
        if (xi > 0) lIdx = j * w + (xi - 1);
        if (xi < w) rIdx = j * w + xi;

        const lObstacle = lIdx >= 0 ? this.obstacle[lIdx] !== 0 : false;
        const rObstacle = rIdx >= 0 ? this.obstacle[rIdx] !== 0 : false;
        if (lObstacle || rObstacle) {
          this.fluxX[off] = 0;
          this.fluxX[off + 1] = 0;
          this.fluxX[off + 2] = 0;
          continue;
        }

        const lz = lIdx >= 0 ? this.terrain[lIdx]! : this.terrain[rIdx]!;
        const rz = rIdx >= 0 ? this.terrain[rIdx]! : this.terrain[lIdx]!;
        const lh = lIdx >= 0 ? this.depth[lIdx]! : 0;
        const rh = rIdx >= 0 ? this.depth[rIdx]! : 0;
        const lmx = lIdx >= 0 ? this.mx[lIdx]! : 0;
        const lmy = lIdx >= 0 ? this.my[lIdx]! : 0;
        const rmx = rIdx >= 0 ? this.mx[rIdx]! : 0;
        const rmy = rIdx >= 0 ? this.my[rIdx]! : 0;

        this.computeFluxX(off, lh, lmx, lmy, lz, rh, rmx, rmy, rz, g, eps);
      }
    }

    for (let yi = 0; yi <= h; yi++) {
      for (let i = 0; i < w; i++) {
        const off = (yi * w + i) * 3;

        let bIdx = -1;
        let tIdx = -1;
        if (yi > 0) bIdx = (yi - 1) * w + i;
        if (yi < h) tIdx = yi * w + i;

        const bObstacle = bIdx >= 0 ? this.obstacle[bIdx] !== 0 : false;
        const tObstacle = tIdx >= 0 ? this.obstacle[tIdx] !== 0 : false;
        if (bObstacle || tObstacle) {
          this.fluxY[off] = 0;
          this.fluxY[off + 1] = 0;
          this.fluxY[off + 2] = 0;
          continue;
        }

        const bz = bIdx >= 0 ? this.terrain[bIdx]! : this.terrain[tIdx]!;
        const tz = tIdx >= 0 ? this.terrain[tIdx]! : this.terrain[bIdx]!;
        const bh = bIdx >= 0 ? this.depth[bIdx]! : 0;
        const th = tIdx >= 0 ? this.depth[tIdx]! : 0;
        const bmx = bIdx >= 0 ? this.mx[bIdx]! : 0;
        const bmy = bIdx >= 0 ? this.my[bIdx]! : 0;
        const tmx = tIdx >= 0 ? this.mx[tIdx]! : 0;
        const tmy = tIdx >= 0 ? this.my[tIdx]! : 0;

        this.computeFluxY(off, bh, bmx, bmy, bz, th, tmx, tmy, tz, g, eps);
      }
    }

    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const idx = j * w + i;
        if (this.obstacle[idx] !== 0) {
          this.nextDepth[idx] = 0;
          this.nextMx[idx] = 0;
          this.nextMy[idx] = 0;
          continue;
        }

        const fxL = (j * (w + 1) + i) * 3;
        const fxR = fxL + 3;
        const fyB = (j * w + i) * 3;
        const fyT = fyB + w * 3;

        let nh = this.depth[idx]!;
        let nmx = this.mx[idx]!;
        let nmy = this.my[idx]!;

        nh -= invDx * (this.fluxX[fxR]! - this.fluxX[fxL]!);
        nh -= invDz * (this.fluxY[fyT]! - this.fluxY[fyB]!);
        nmx -= invDx * (this.fluxX[fxR + 1]! - this.fluxX[fxL + 1]!);
        nmx -= invDz * (this.fluxY[fyT + 1]! - this.fluxY[fyB + 1]!);
        nmy -= invDx * (this.fluxX[fxR + 2]! - this.fluxX[fxL + 2]!);
        nmy -= invDz * (this.fluxY[fyT + 2]! - this.fluxY[fyB + 2]!);

        if (sourceRate > 0 && this.sourceMask[idx] !== 0) {
          const sourceWeight = this.sourceWeight[idx]!;
          if (sourceWeight > 0) {
            const addedDepth = sourceRate * sourceWeight * dt;
            nh += addedDepth;
            if (addedDepth > 0) {
              nmx += addedDepth * sourceJet * this.sourceDirX[idx]!;
              nmy += addedDepth * sourceJet * this.sourceDirY[idx]!;
            }
          }
        }

        if (this.params.rainRate > 0) {
          nh += this.params.rainRate * dt;
        }
        if (this.params.infiltrationRate > 0) {
          nh -= this.params.infiltrationRate * dt;
        }
        if (this.params.drainageRate > 0) {
          nh *= Math.max(0, 1 - this.params.drainageRate * dt);
        }

        if (this.params.sourceEnabled && this.sourceMask[idx] !== 0) {
          nh = Math.max(nh, this.sourceTargetDepthAt(idx));
        }

        if (!Number.isFinite(nh) || nh <= eps) {
          this.nextDepth[idx] = 0;
          this.nextMx[idx] = 0;
          this.nextMy[idx] = 0;
          continue;
        }

        let u = nmx / nh;
        let v = nmy / nh;

        u += -g * this.terrainSlopeX[idx]! * dt * this.slopeForceScale;
        v += -g * this.terrainSlopeY[idx]! * dt * this.slopeForceScale;

        const iLf = i > 0 ? i - 1 : i;
        const iRt = i < w - 1 ? i + 1 : i;
        const jDn = j > 0 ? j - 1 : j;
        const jUp = j < h - 1 ? j + 1 : j;
        const idxL = j * w + iLf;
        const idxR = j * w + iRt;
        const idxD = jDn * w + i;
        const idxU = jUp * w + i;
        const velL = this.velocityAt(idxL);
        const velR = this.velocityAt(idxR);
        const velD = this.velocityAt(idxD);
        const velU = this.velocityAt(idxU);
        const lapU = (velL.u - 2 * u + velR.u) * invDx2 + (velD.u - 2 * u + velU.u) * invDz2;
        const lapV = (velL.v - 2 * v + velR.v) * invDx2 + (velD.v - 2 * v + velU.v) * invDz2;
        const speedPreFriction = Math.sqrt(u * u + v * v);
        const eddyNu = this.baseEddyViscosity * (1 + Math.min(1.25, speedPreFriction * 0.25));
        u += eddyNu * lapU * dt;
        v += eddyNu * lapV * dt;

        const hasLeftWall = i > 0 && this.obstacle[idx - 1]! !== 0;
        const hasRightWall = i < w - 1 && this.obstacle[idx + 1]! !== 0;
        const hasBottomWall = j > 0 && this.obstacle[idx - w]! !== 0;
        const hasTopWall = j < h - 1 && this.obstacle[idx + w]! !== 0;
        if (hasLeftWall && u < 0) u = 0;
        if (hasRightWall && u > 0) u = 0;
        if (hasBottomWall && v < 0) v = 0;
        if (hasTopWall && v > 0) v = 0;

        const speed = Math.sqrt(u * u + v * v);
        if (speed > 0) {
          const drag = (g * this.params.manningN * this.params.manningN * speed) /
            Math.pow(Math.max(nh, 0.01), 1.3333333333);
          const damp = Math.max(0, 1 - drag * dt);
          u *= damp;
          v *= damp;
        }

        const maxSpeed = Math.max(1.0, this.maxFroude * Math.sqrt(g * nh));
        const clampedSpeed = Math.sqrt(u * u + v * v);
        if (clampedSpeed > maxSpeed) {
          const s = maxSpeed / clampedSpeed;
          u *= s;
          v *= s;
        }

        nmx = u * nh;
        nmy = v * nh;

        this.nextDepth[idx] = nh;
        this.nextMx[idx] = Number.isFinite(nmx) ? nmx : 0;
        this.nextMy[idx] = Number.isFinite(nmy) ? nmy : 0;
      }
    }

    this.swap();
  }

  private computeFluxX(
    off: number,
    lh: number,
    lmx: number,
    lmy: number,
    lz: number,
    rh: number,
    rmx: number,
    rmy: number,
    rz: number,
    g: number,
    eps: number,
  ): void {
    const etaL = lz + lh;
    const etaR = rz + rh;
    const zStar = Math.max(lz, rz);
    const hL = Math.max(0, etaL - zStar);
    const hR = Math.max(0, etaR - zStar);
    if (hL <= eps && hR <= eps) {
      this.fluxX[off] = 0;
      this.fluxX[off + 1] = 0;
      this.fluxX[off + 2] = 0;
      return;
    }

    const uL = lh > eps ? lmx / lh : 0;
    const vL = lh > eps ? lmy / lh : 0;
    const uR = rh > eps ? rmx / rh : 0;
    const vR = rh > eps ? rmy / rh : 0;

    const huL = hL * uL;
    const hvL = hL * vL;
    const huR = hR * uR;
    const hvR = hR * vR;

    const f0L = huL;
    const f1L = huL * uL + 0.5 * g * hL * hL;
    const f2L = huL * vL;
    const f0R = huR;
    const f1R = huR * uR + 0.5 * g * hR * hR;
    const f2R = huR * vR;

    const a = Math.max(Math.abs(uL) + Math.sqrt(g * hL), Math.abs(uR) + Math.sqrt(g * hR));
    this.fluxX[off] = 0.5 * (f0L + f0R) - 0.5 * a * (hR - hL);
    this.fluxX[off + 1] = 0.5 * (f1L + f1R) - 0.5 * a * (huR - huL);
    this.fluxX[off + 2] = 0.5 * (f2L + f2R) - 0.5 * a * (hvR - hvL);
  }

  private computeFluxY(
    off: number,
    bh: number,
    bmx: number,
    bmy: number,
    bz: number,
    th: number,
    tmx: number,
    tmy: number,
    tz: number,
    g: number,
    eps: number,
  ): void {
    const etaB = bz + bh;
    const etaT = tz + th;
    const zStar = Math.max(bz, tz);
    const hB = Math.max(0, etaB - zStar);
    const hT = Math.max(0, etaT - zStar);
    if (hB <= eps && hT <= eps) {
      this.fluxY[off] = 0;
      this.fluxY[off + 1] = 0;
      this.fluxY[off + 2] = 0;
      return;
    }

    const uB = bh > eps ? bmx / bh : 0;
    const vB = bh > eps ? bmy / bh : 0;
    const uT = th > eps ? tmx / th : 0;
    const vT = th > eps ? tmy / th : 0;

    const huB = hB * uB;
    const hvB = hB * vB;
    const huT = hT * uT;
    const hvT = hT * vT;

    const g0B = hvB;
    const g1B = huB * vB;
    const g2B = hvB * vB + 0.5 * g * hB * hB;
    const g0T = hvT;
    const g1T = huT * vT;
    const g2T = hvT * vT + 0.5 * g * hT * hT;

    const a = Math.max(Math.abs(vB) + Math.sqrt(g * hB), Math.abs(vT) + Math.sqrt(g * hT));
    this.fluxY[off] = 0.5 * (g0B + g0T) - 0.5 * a * (hT - hB);
    this.fluxY[off + 1] = 0.5 * (g1B + g1T) - 0.5 * a * (huT - huB);
    this.fluxY[off + 2] = 0.5 * (g2B + g2T) - 0.5 * a * (hvT - hvB);
  }

  private swap(): void {
    let tmp = this.depth;
    this.depth = this.nextDepth;
    this.nextDepth = tmp;

    tmp = this.mx;
    this.mx = this.nextMx;
    this.nextMx = tmp;

    tmp = this.my;
    this.my = this.nextMy;
    this.nextMy = tmp;
  }

  private computeStats(): FloodStats {
    const eps = this.params.wetThreshold;
    let wetCellCount = 0;
    let maxDepth = 0;
    let totalVolume = 0;
    const cellArea = this.dx * this.dz;

    for (let idx = 0; idx < this.depth.length; idx++) {
      if (this.obstacle[idx] !== 0) continue;
      const d = this.depth[idx]!;
      if (d > eps) {
        wetCellCount++;
        totalVolume += d * cellArea;
        if (d > maxDepth) maxDepth = d;
      }
    }

    return {
      wetCellCount,
      maxDepth,
      totalVolume,
      lastDt: this.lastDt,
    };
  }
}

// --- Surface ---

interface FloodSurfaceSolverState {
  depth: Float32Array;
  mx: Float32Array;
  my: Float32Array;
  obstacle: Uint8Array;
}

type ImpactPulse = {
  x: number;
  z: number;
  strength: number;
  radiusMeters: number;
};

// --- TSL helper functions (replacing GLSL) ---

const hash21 = Fn(({ p_in }: { p_in: any }) => {
  const p = fract(p_in.mul(vec2(123.34, 456.21))).toVar();
  p.addAssign(dot(p, p.add(45.32)));
  return fract(p.x.mul(p.y));
});

const noise2 = Fn(({ p }: { p: any }) => {
  const i = floor(p);
  const f = fract(p);
  const a = hash21({ p_in: i });
  const b = hash21({ p_in: i.add(vec2(1.0, 0.0)) });
  const c = hash21({ p_in: i.add(vec2(0.0, 1.0)) });
  const d = hash21({ p_in: i.add(vec2(1.0, 1.0)) });
  const u = f.mul(f).mul(float(3.0).sub(f.mul(2.0)));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
});

const fbm = Fn(({ p_in }: { p_in: any }) => {
  const v = float(0.0).toVar();
  const a = float(0.5).toVar();
  const p = p_in.toVar();
  // Unrolled 4 iterations
  v.addAssign(a.mul(noise2({ p })));
  p.assign(p.mul(2.03).add(vec2(19.37, -7.11)));
  a.mulAssign(0.5);

  v.addAssign(a.mul(noise2({ p })));
  p.assign(p.mul(2.03).add(vec2(19.37, -7.11)));
  a.mulAssign(0.5);

  v.addAssign(a.mul(noise2({ p })));
  p.assign(p.mul(2.03).add(vec2(19.37, -7.11)));
  a.mulAssign(0.5);

  v.addAssign(a.mul(noise2({ p })));
  return v;
});

const skyColorTSL = Fn(({ dir }: { dir: any }) => {
  const t = clamp(dir.y.mul(0.5).add(0.5), 0.0, 1.0);
  const skyTop = vec3(0.42, 0.63, 0.90);
  const skyHorizon = vec3(0.88, 0.93, 0.99);
  const groundTint = vec3(0.20, 0.24, 0.30);
  return mix(mix(skyHorizon, skyTop, pow(t, 0.7)), groundTint, pow(float(1.0).sub(t), 5.0));
});

class FloodWaterSurface {
  readonly mesh: THREE.Mesh;

  private readonly raster: FloodRaster;
  private readonly positionAttr: THREE.BufferAttribute;
  private readonly depthAttr: THREE.BufferAttribute;
  private readonly velocityAttr: THREE.BufferAttribute;
  private readonly rippleAttr: THREE.BufferAttribute;
  private readonly vertexToCell: Uint32Array;
  private readonly material: NodeMaterial;
  private depthScale = 1;
  private readonly baseYOffset = 0.12;
  private rippleHeight: Float32Array;
  private rippleVelocity: Float32Array;
  private rippleNextHeight: Float32Array;
  private rippleNextVelocity: Float32Array;
  private readonly pendingImpacts: ImpactPulse[] = [];

  // TSL uniform nodes
  private readonly uDepthScale;
  private readonly uLightDir;
  private readonly uSunColor;
  private readonly uSourceXZ;
  private readonly uTime;

  constructor(raster: FloodRaster, sunLight?: THREE.DirectionalLight) {
    this.raster = raster;

    const widthMeters = raster.xMax - raster.xMin;
    const depthMeters = raster.zMax - raster.zMin;
    const geo = new THREE.PlaneGeometry(
      widthMeters,
      depthMeters,
      raster.width - 1,
      raster.height - 1,
    );
    geo.rotateX(-Math.PI / 2);
    geo.translate((raster.xMin + raster.xMax) * 0.5, 0, (raster.zMin + raster.zMax) * 0.5);

    const pos = geo.getAttribute("position") as THREE.BufferAttribute;
    const uv = geo.getAttribute("uv") as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const u = (x - raster.xMin) / widthMeters;
      const v = (z - raster.zMin) / depthMeters;
      uv.setXY(i, u, v);
    }
    uv.needsUpdate = true;

    this.positionAttr = geo.getAttribute("position") as THREE.BufferAttribute;
    this.depthAttr = new THREE.BufferAttribute(new Float32Array(this.positionAttr.count), 1);
    this.velocityAttr = new THREE.BufferAttribute(
      new Float32Array(this.positionAttr.count * 2),
      2,
    );
    this.rippleAttr = new THREE.BufferAttribute(new Float32Array(this.positionAttr.count), 1);
    geo.setAttribute("aDepth", this.depthAttr);
    geo.setAttribute("aVelocity", this.velocityAttr);
    geo.setAttribute("aRipple", this.rippleAttr);
    this.vertexToCell = new Uint32Array(this.positionAttr.count);
    for (let i = 0; i < this.positionAttr.count; i++) {
      const u = uv.getX(i);
      const v = uv.getY(i);
      const ci = clampInt(Math.round(u * (raster.width - 1)), 0, raster.width - 1);
      const cj = clampInt(Math.round(v * (raster.height - 1)), 0, raster.height - 1);
      this.vertexToCell[i] = cj * raster.width + ci;
    }

    const cellCount = raster.width * raster.height;
    this.rippleHeight = new Float32Array(cellCount);
    this.rippleVelocity = new Float32Array(cellCount);
    this.rippleNextHeight = new Float32Array(cellCount);
    this.rippleNextVelocity = new Float32Array(cellCount);

    // --- TSL uniforms ---
    this.uDepthScale = uniform(this.depthScale);
    this.uLightDir = uniform(
      sunLight
        ? sunLight.position.clone().normalize()
        : new THREE.Vector3(0.35, 0.86, 0.36).normalize(),
    );
    this.uSunColor = uniform(new THREE.Color(1.0, 0.95, 0.82));
    this.uSourceXZ = uniform(new THREE.Vector2(0, 0));
    this.uTime = uniform(0.0);

    // --- Build the NodeMaterial ---
    const mat = new NodeMaterial();
    mat.transparent = true;
    mat.depthWrite = false;
    mat.depthTest = true;
    mat.polygonOffset = true;
    mat.polygonOffsetFactor = -2;
    mat.polygonOffsetUnits = -2;

    // Vertex: pass varyings
    const aDepthNode = attribute("aDepth", "float");
    const aVelocityNode = attribute("aVelocity", "vec2");
    const aRippleNode = attribute("aRipple", "float");

    const vDepth = varying(max(float(0.0), aDepthNode.mul(this.uDepthScale)), "vDepth");
    const vVelocity = varying(aVelocityNode, "vVelocity");
    const vRipple = varying(aRippleNode, "vRipple");
    const vUv = varying(uv(), "vUv");
    const vWorldPos = varying(positionWorld, "vWorldPos");

    // Fragment shader as colorNode
    const fragmentColor = Fn(() => {
      // Discard dry pixels
      Discard(vDepth.lessThan(0.01));

      const toPoint = vWorldPos.xz.sub(this.uSourceXZ);
      const radialDist = length(toPoint);
      const radialDir = normalize(toPoint.add(vec2(1e-6, 1e-6)));
      const sourceInfluence = smoothstep(float(140.0), float(0.0), radialDist);

      const physicalFlow = vVelocity;
      const advectFlow = physicalFlow.add(radialDir.mul(float(0.25).mul(sourceInfluence)));
      const flowDir = normalize(advectFlow.add(vec2(1e-6, 1e-6)));
      const flowSpeed = length(physicalFlow);
      const flow = flowDir.mul(float(0.06).add(float(0.14).mul(min(float(5.0), flowSpeed))));

      const uvA = vUv.mul(10.0).add(flow.mul(this.uTime.mul(0.8)));
      const uvB = vUv.mul(22.0).add(vec2(flowDir.y, flowDir.x.negate()).mul(this.uTime.mul(0.9)));
      const e = float(0.0015);

      const hL = fbm({ p_in: uvA.sub(vec2(e, 0.0)) }).mul(0.7).add(fbm({ p_in: uvB.sub(vec2(e, 0.0)) }).mul(0.3));
      const hR = fbm({ p_in: uvA.add(vec2(e, 0.0)) }).mul(0.7).add(fbm({ p_in: uvB.add(vec2(e, 0.0)) }).mul(0.3));
      const hD = fbm({ p_in: uvA.sub(vec2(0.0, e)) }).mul(0.7).add(fbm({ p_in: uvB.sub(vec2(0.0, e)) }).mul(0.3));
      const hU = fbm({ p_in: uvA.add(vec2(0.0, e)) }).mul(0.7).add(fbm({ p_in: uvB.add(vec2(0.0, e)) }).mul(0.3));
      const dHx = hR.sub(hL).div(e.mul(2.0));
      const dHz = hU.sub(hD).div(e.mul(2.0));

      // Normals
      const baseNormal = normalize(cross(vWorldPos.dFdx(), vWorldPos.dFdy()));
      const flowNormal = normalize(vec3(vVelocity.x.mul(-0.02), 1.0, vVelocity.y.mul(-0.02)));
      const microNormal = normalize(vec3(dHx.mul(-0.50), 1.0, dHz.mul(-0.50)));
      const normal = normalize(baseNormal.mul(0.58).add(flowNormal.mul(0.18)).add(microNormal.mul(0.62)));

      const viewDir = normalize(cameraPosition.sub(vWorldPos));
      const lightDir = normalize(this.uLightDir);
      const reflDir = reflect(viewDir.negate(), normal);
      const halfDir = normalize(lightDir.add(viewDir));

      const ndotV = max(dot(normal, viewDir), 0.0);
      const ndotL = max(dot(normal, lightDir), 0.0);
      const fresnel = float(0.02).add(float(0.98).mul(pow(float(1.0).sub(ndotV), 5.0)));

      const depthMix = clamp(vDepth.div(6.0), 0.0, 1.0);
      const absorb = exp(vDepth.mul(-0.55));
      const shallowCol = vec3(0.07, 0.25, 0.44);
      const deepCol = vec3(0.00, 0.03, 0.12);
      const subsurface = mix(deepCol, shallowCol, absorb);
      const refracted = subsurface.mul(float(0.25).add(float(0.75).mul(ndotL))).mul(mix(float(1.0), float(0.82), depthMix));

      const envRefl = skyColorTSL({ dir: reflDir }).toVar();
      const sunRefl = pow(max(dot(reflDir, lightDir), 0.0), 1300.0);
      envRefl.addAssign(this.uSunColor.mul(sunRefl).mul(6.0));

      const color = mix(refracted, envRefl, fresnel).toVar();

      const spec = pow(max(dot(normal, halfDir), 0.0), 190.0).mul(float(0.2).add(float(0.8).mul(ndotL)));
      const glitter = pow(max(dot(normalize(reflDir.add(lightDir)), viewDir), 0.0), 300.0);
      color.addAssign(this.uSunColor.mul(spec.mul(0.85).add(glitter.mul(0.32))));

      // Foam
      const speed = length(vVelocity);
      const vort = abs(vVelocity.y.dFdx().sub(vVelocity.x.dFdy()));
      const rippleEnergy = abs(vRipple);
      const shorelineFoam = float(1.0).sub(smoothstep(float(0.03), float(0.30), vDepth));
      const turbulenceFoam = smoothstep(float(0.9), float(2.7), speed.add(vort.mul(1.8)).add(rippleEnergy.mul(6.5)));
      const foamNoise = fbm({ p_in: vUv.mul(36.0).add(flow.mul(this.uTime).mul(1.5)) });
      const streak = float(0.5).add(float(0.5).mul(sin(dot(vUv.mul(200.0).add(flow.mul(this.uTime).mul(8.0)), vec2(flowDir.y.negate(), flowDir.x)))));
      const foam = clamp(shorelineFoam.mul(0.8).add(turbulenceFoam.mul(0.65)), 0.0, 1.0)
        .mul(foamNoise).mul(float(0.62).add(float(0.38).mul(streak)));
      color.assign(mix(color, vec3(0.94, 0.97, 1.0), foam.mul(0.5)));

      color.assign(clamp(color, vec3(0.0, 0.0, 0.0), vec3(1.0, 1.0, 1.0)));
      const alpha = clamp(float(0.82).add(vDepth.mul(0.05)).add(fresnel.mul(0.02)), 0.84, 0.93);

      return vec4(color, alpha);
    });

    mat.colorNode = fragmentColor();

    this.material = mat;

    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 20;
    this.mesh.name = "flood-water-surface";
  }

  updateFromSolver(solver: FloodSurfaceSolverState, dt: number): void {
    this.updateRippleField(solver, dt);
    const eps = 1e-5;
    let wetCount = 0;
    for (let i = 0; i < this.positionAttr.count; i++) {
      const cell = this.vertexToCell[i]!;
      const terrainY = this.raster.terrain[cell]!;
      const depth = solver.depth[cell]!;
      const ripple = this.rippleHeight[cell]!;
      let vx = 0;
      let vz = 0;
      if (depth > eps) {
        vx = solver.mx[cell]! / depth;
        vz = solver.my[cell]! / depth;
      }
      const scaledDepth = depth * this.depthScale;
      const rippleAmp = Math.min(0.20, 0.02 + scaledDepth * 0.04);
      const wet = depth > eps;
      const rippleOffset = wet ? ripple * rippleAmp : 0;
      const y = wet ? terrainY + scaledDepth + this.baseYOffset + rippleOffset : terrainY;
      if (wet) wetCount++;
      this.positionAttr.setY(i, y);
      this.depthAttr.setX(i, depth);
      this.velocityAttr.setXY(i, vx, vz);
      this.rippleAttr.setX(i, wet ? rippleOffset : 0);
    }
    this.positionAttr.needsUpdate = true;
    this.depthAttr.needsUpdate = true;
    this.velocityAttr.needsUpdate = true;
    this.rippleAttr.needsUpdate = true;
    this.uTime.value += dt;
    this.mesh.visible = wetCount > 0;
  }

  setDepthScale(scale: number): void {
    this.depthScale = Math.max(0.1, Math.min(4, scale));
    this.uDepthScale.value = this.depthScale;
  }

  setLightDirection(dir: THREE.Vector3): void {
    (this.uLightDir.value as THREE.Vector3).copy(dir).normalize();
    const nY = Math.max(0, Math.min(1, dir.clone().normalize().y));
    const warm = new THREE.Color(1.0, 0.95, 0.82);
    const cool = new THREE.Color(0.82, 0.90, 1.0);
    (this.uSunColor.value as THREE.Color).copy(cool).lerp(warm, Math.sqrt(nY));
  }

  setSourcePosition(x: number, z: number): void {
    (this.uSourceXZ.value as THREE.Vector2).set(x, z);
  }

  addImpactAtWorld(x: number, z: number, strength = 1, radiusMeters = 5): void {
    this.pendingImpacts.push({
      x,
      z,
      strength: Math.max(0, strength),
      radiusMeters: Math.max(0.5, radiusMeters),
    });
  }

  private updateRippleField(solver: FloodSurfaceSolverState, dt: number): void {
    const w = this.raster.width;
    const h = this.raster.height;
    const steps = Math.max(1, Math.min(4, Math.round(dt * 120)));
    const stepDt = dt / steps;
    const damping = Math.pow(0.99925, Math.max(1, dt * 60 / steps));
    this.applyPendingImpactsToRipple(solver);

    for (let s = 0; s < steps; s++) {
      for (let j = 0; j < h; j++) {
        const jUp = j > 0 ? j - 1 : j;
        const jDn = j < h - 1 ? j + 1 : j;
        for (let i = 0; i < w; i++) {
          const iLf = i > 0 ? i - 1 : i;
          const iRt = i < w - 1 ? i + 1 : i;
          const idx = j * w + i;

          if (solver.obstacle[idx] !== 0) {
            this.rippleNextHeight[idx] = 0;
            this.rippleNextVelocity[idx] = 0;
            continue;
          }

          const depth = solver.depth[idx]!;
          const dryNeighborhood =
            depth <= 0.01 &&
            solver.depth[j * w + iLf]! <= 0.01 &&
            solver.depth[j * w + iRt]! <= 0.01 &&
            solver.depth[jUp * w + i]! <= 0.01 &&
            solver.depth[jDn * w + i]! <= 0.01;
          if (dryNeighborhood) {
            this.rippleNextHeight[idx] = 0;
            this.rippleNextVelocity[idx] = 0;
            continue;
          }

          let center = this.rippleHeight[idx]!;
          const left = this.rippleHeight[j * w + iLf]!;
          const right = this.rippleHeight[j * w + iRt]!;
          const up = this.rippleHeight[jUp * w + i]!;
          const down = this.rippleHeight[jDn * w + i]!;
          const avg = 0.25 * (left + right + up + down);

          let vel = this.rippleVelocity[idx]! + (avg - center) * 2.0;
          let localDamping = damping;

          if (depth > 0.01) {
            const vx = solver.mx[idx]! / depth;
            const vz = solver.my[idx]! / depth;
            const speed = Math.min(6, Math.sqrt(vx * vx + vz * vz));
            const backI = i - (vx * stepDt) / this.raster.dx;
            const backJ = j - (vz * stepDt) / this.raster.dz;
            const advected = this.sampleBilinear(this.rippleHeight, backI, backJ, w, h);
            center = center * 0.45 + advected * 0.55;
            vel += speed * 0.0035;
            if (depth < 0.45) vel += (0.45 - depth) * 0.005;
            localDamping = Math.min(0.99995, localDamping + speed * 0.00012);
          }

          vel *= localDamping;
          const nextH = (center + vel) * 0.9996;
          this.rippleNextVelocity[idx] = vel;
          this.rippleNextHeight[idx] = Math.max(-1, Math.min(1, nextH));
        }
      }

      let tmpH = this.rippleHeight;
      this.rippleHeight = this.rippleNextHeight;
      this.rippleNextHeight = tmpH;

      let tmpV = this.rippleVelocity;
      this.rippleVelocity = this.rippleNextVelocity;
      this.rippleNextVelocity = tmpV;
    }
  }

  private applyPendingImpactsToRipple(solver: FloodSurfaceSolverState): void {
    if (this.pendingImpacts.length === 0) return;
    const w = this.raster.width;
    const h = this.raster.height;

    for (const impact of this.pendingImpacts) {
      const cx = clampInt(
        Math.round((impact.x - this.raster.xMin) / Math.max(1e-6, this.raster.dx)),
        0,
        w - 1,
      );
      const cy = clampInt(
        Math.round((impact.z - this.raster.zMin) / Math.max(1e-6, this.raster.dz)),
        0,
        h - 1,
      );
      const radiusCells = Math.max(
        1,
        Math.ceil(impact.radiusMeters / Math.max(1e-6, Math.min(this.raster.dx, this.raster.dz))),
      );
      const r2 = radiusCells * radiusCells;

      for (let j = Math.max(0, cy - radiusCells); j <= Math.min(h - 1, cy + radiusCells); j++) {
        for (let i = Math.max(0, cx - radiusCells); i <= Math.min(w - 1, cx + radiusCells); i++) {
          const di = i - cx;
          const dj = j - cy;
          const d2 = di * di + dj * dj;
          if (d2 > r2) continue;
          const idx = j * w + i;
          if (solver.obstacle[idx] !== 0) continue;
          const falloff = Math.exp(-d2 / Math.max(1, r2 * 0.45));
          const amp = impact.strength * falloff;
          this.rippleVelocity[idx] += amp * 0.28;
          this.rippleHeight[idx] += amp * 0.06;
        }
      }
    }

    this.pendingImpacts.length = 0;
  }

  private sampleBilinear(data: Float32Array, x: number, y: number, width: number, height: number): number {
    const cx = Math.max(0, Math.min(width - 1, x));
    const cy = Math.max(0, Math.min(height - 1, y));
    const x0 = Math.floor(cx);
    const y0 = Math.floor(cy);
    const x1 = Math.min(width - 1, x0 + 1);
    const y1 = Math.min(height - 1, y0 + 1);
    const tx = cx - x0;
    const ty = cy - y0;

    const p00 = data[y0 * width + x0]!;
    const p10 = data[y0 * width + x1]!;
    const p01 = data[y1 * width + x0]!;
    const p11 = data[y1 * width + x1]!;
    const a = p00 + (p10 - p00) * tx;
    const b = p01 + (p11 - p01) * tx;
    return a + (b - a) * ty;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}

// --- Environment effects (trees carried by currents) ---

type TreeTarget = {
  trunk: THREE.Mesh;
  canopy?: THREE.Mesh;
  uprooted: boolean;
  depthThreshold: number;
  forceThreshold: number;
  trunkRadius: number;
  height: number;
  submergedTime: number;
  damage: number;
};

type UprootTarget = {
  mesh: THREE.Mesh;
  kind: "small";
  uprooted: boolean;
  depthThreshold: number;
  speedThreshold: number;
};

type DebrisBodyKind = "tree" | "small";

type DebrisBody = {
  object: THREE.Object3D;
  kind: DebrisBodyKind;
  velocity: THREE.Vector3;
  angularVelocity: THREE.Vector3;
  buoyancy: number;
  drag: number;
  angularDrag: number;
  floatOffset: number;
  ttl: number;
  characteristicHeight: number;
  crossSection: number;
  wasInWater: boolean;
  impactCooldown: number;
  disposableGeometries: THREE.BufferGeometry[];
  disposableMaterials: THREE.Material[];
};

const WORLD_UP = new THREE.Vector3(0, 1, 0);

class FloodEnvironmentEffectsRealistic {
  private readonly root: THREE.Group;
  private readonly solver: ShallowWaterSolver;
  private readonly surface: FloodWaterSurface;
  private readonly debrisGroup: THREE.Group;

  private readonly treeTargets: TreeTarget[] = [];
  private readonly uprootTargets: UprootTarget[] = [];
  private readonly debrisBodies: DebrisBody[] = [];

  private checkTimer = 0;
  private wallImpactTimer = 0;

  private readonly tmpBox = new THREE.Box3();
  private readonly tmpSize = new THREE.Vector3();
  private readonly tmpPos = new THREE.Vector3();
  private readonly tmpVecA = new THREE.Vector3();
  private readonly tmpVecB = new THREE.Vector3();
  private readonly tmpVecC = new THREE.Vector3();
  private readonly tmpQuat = new THREE.Quaternion();
  private readonly tmpMat = new THREE.Matrix4();

  constructor(root: THREE.Group, solver: ShallowWaterSolver, surface: FloodWaterSurface) {
    this.root = root;
    this.solver = solver;
    this.surface = surface;

    this.debrisGroup = new THREE.Group();
    this.debrisGroup.name = "flood-debris";
    this.root.add(this.debrisGroup);

    this.collectTreeTargets();
    this.collectSmallUprootTargets();
  }

  update(simDt: number): void {
    this.checkTimer += simDt;
    if (this.checkTimer >= 0.08) {
      this.checkTimer = 0;
      this.evaluateTreeTargets();
      this.evaluateSmallUprootTargets();
    }

    this.emitWallImpacts(simDt);
    this.updateDebrisBodies(simDt);
  }

  reset(): void {
    for (const target of this.treeTargets) {
      target.uprooted = false;
      target.submergedTime = 0;
      target.damage = 0;
      target.trunk.visible = true;
      if (target.canopy) target.canopy.visible = true;
    }
    for (const target of this.uprootTargets) {
      target.uprooted = false;
      target.mesh.visible = true;
    }
    this.clearDebris();
    this.checkTimer = 0;
    this.wallImpactTimer = 0;
  }

  dispose(): void {
    this.clearDebris();
    this.root.remove(this.debrisGroup);
  }

  private collectTreeTargets(): void {
    const trees = this.root.getObjectByName("trees");
    if (!trees) return;

    type TreeCandidate = {
      mesh: THREE.Mesh;
      center: THREE.Vector3;
      size: THREE.Vector3;
    };

    const trunkCandidates: TreeCandidate[] = [];
    const canopyCandidates: TreeCandidate[] = [];
    const allCandidates: TreeCandidate[] = [];

    trees.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh)) return;
      this.tmpBox.setFromObject(obj);
      if (!Number.isFinite(this.tmpBox.min.x) || !Number.isFinite(this.tmpBox.max.x)) return;

      const size = this.tmpBox.getSize(new THREE.Vector3());
      const center = this.tmpBox.getCenter(new THREE.Vector3());
      allCandidates.push({ mesh: obj, center, size });
      const horizontalSize = Math.max(size.x, size.z);
      const slenderness = size.y / Math.max(0.001, horizontalSize);

      if (slenderness >= 2.2 && size.y >= 1.5) {
        trunkCandidates.push({ mesh: obj, center, size });
      } else {
        canopyCandidates.push({ mesh: obj, center, size });
      }
    });

    const usedCanopies = new Set<THREE.Mesh>();
    const claimedMeshes = new Set<THREE.Mesh>();

    for (const trunk of trunkCandidates) {
      let bestCanopy: TreeCandidate | undefined;
      let bestScore = Number.POSITIVE_INFINITY;

      for (const canopy of canopyCandidates) {
        if (usedCanopies.has(canopy.mesh)) continue;

        const dx = canopy.center.x - trunk.center.x;
        const dz = canopy.center.z - trunk.center.z;
        const dy = canopy.center.y - trunk.center.y;
        const horizontalDist2 = dx * dx + dz * dz;
        const maxHorizontal = Math.max(2.4, trunk.size.y * 0.95);
        if (horizontalDist2 > maxHorizontal * maxHorizontal) continue;
        if (dy < trunk.size.y * 0.12 || dy > trunk.size.y * 2.8) continue;

        const score = horizontalDist2 + Math.abs(dy - trunk.size.y * 1.25) * 0.35;
        if (score < bestScore) {
          bestScore = score;
          bestCanopy = canopy;
        }
      }

      if (bestCanopy) {
        usedCanopies.add(bestCanopy.mesh);
        claimedMeshes.add(bestCanopy.mesh);
      }
      claimedMeshes.add(trunk.mesh);

      const trunkRadius = Math.max(0.18, Math.min(1.1, Math.max(trunk.size.x, trunk.size.z) * 0.5));
      const canopyHeight = bestCanopy?.size.y ?? 0;
      const totalHeight = Math.max(2.2, trunk.size.y + canopyHeight * 0.55);
      const depthThreshold = Math.max(0.20, Math.min(0.68, 0.16 + trunkRadius * 0.42));
      const forceThreshold = Math.max(0.18, Math.min(0.90, 0.14 + trunkRadius * 0.46));

      this.treeTargets.push({
        trunk: trunk.mesh,
        canopy: bestCanopy?.mesh,
        uprooted: false,
        depthThreshold,
        forceThreshold,
        trunkRadius,
        height: totalHeight,
        submergedTime: 0,
        damage: 0,
      });
    }

    for (const candidate of allCandidates) {
      if (claimedMeshes.has(candidate.mesh)) continue;
      const fallbackRadius = Math.max(0.16, Math.min(1.25, Math.max(candidate.size.x, candidate.size.z) * 0.5));
      this.treeTargets.push({
        trunk: candidate.mesh,
        canopy: undefined,
        uprooted: false,
        depthThreshold: Math.max(0.18, Math.min(0.72, 0.14 + fallbackRadius * 0.40)),
        forceThreshold: Math.max(0.16, Math.min(0.95, 0.12 + fallbackRadius * 0.46)),
        trunkRadius: fallbackRadius,
        height: Math.max(1.2, candidate.size.y),
        submergedTime: 0,
        damage: 0,
      });
    }
  }

  private collectSmallUprootTargets(): void {
    const barriers = this.root.getObjectByName("barriers");
    if (!barriers) return;

    barriers.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh)) return;
      this.uprootTargets.push({
        mesh: obj,
        kind: "small",
        uprooted: false,
        depthThreshold: 0.7,
        speedThreshold: 1.6,
      });
    });
  }

  private evaluateTreeTargets(): void {
    const evalDt = 0.08;
    for (const target of this.treeTargets) {
      if (target.uprooted || !target.trunk.visible) continue;

      target.trunk.getWorldPosition(this.tmpPos);
      const state = this.solver.sampleStateAtWorld(this.tmpPos.x, this.tmpPos.z, true, 3);
      if (state.obstacle) continue;

      const speed = Math.hypot(state.u, state.v);
      const hydrodynamicForce = state.depth * speed * speed;
      const momentumLoad = state.depth * speed;
      const wet = state.depth > 0.08;

      if (wet) {
        target.submergedTime = Math.min(12, target.submergedTime + evalDt);
      } else {
        target.submergedTime = Math.max(0, target.submergedTime - evalDt * 1.6);
      }

      const damageDecay = wet ? 0.965 : 0.90;
      target.damage =
        target.damage * damageDecay +
        hydrodynamicForce * 0.22 +
        momentumLoad * 0.12 +
        (wet ? 0.035 : 0);

      const depthTrigger = state.depth >= target.depthThreshold;
      const forceTrigger = hydrodynamicForce >= target.forceThreshold;
      const depthSpeedTrigger = depthTrigger && speed >= 0.22;
      const sustainedTrigger =
        target.submergedTime >= 1.2 && state.depth >= target.depthThreshold * 0.65;
      const damageTrigger = target.damage >= target.forceThreshold * 1.65;
      const extremeDepthTrigger = state.depth >= Math.max(1.25, target.depthThreshold * 2.0);

      if (!(forceTrigger || depthSpeedTrigger || sustainedTrigger || damageTrigger || extremeDepthTrigger)) {
        continue;
      }

      target.uprooted = true;
      this.spawnUprootedTree(target, state, speed);

      this.surface.addImpactAtWorld(this.tmpPos.x, this.tmpPos.z, 1.1 + speed * 0.30, 5.6);
      this.solver.injectMomentumImpulse(this.tmpPos.x, this.tmpPos.z, state.u * 0.28, state.v * 0.28, 4.0, 0.6);
    }
  }

  private evaluateSmallUprootTargets(): void {
    for (const target of this.uprootTargets) {
      if (target.uprooted || !target.mesh.visible) continue;

      target.mesh.getWorldPosition(this.tmpPos);
      const state = this.solver.sampleStateAtWorld(this.tmpPos.x, this.tmpPos.z, true, 3);
      if (state.obstacle) continue;

      const speed = Math.hypot(state.u, state.v);
      if (state.depth < target.depthThreshold || speed < target.speedThreshold) continue;

      target.uprooted = true;
      this.spawnSmallDebris(target.mesh, state, speed);

      this.surface.addImpactAtWorld(this.tmpPos.x, this.tmpPos.z, 0.9 + speed * 0.25, 4.2);
      this.solver.injectMomentumImpulse(this.tmpPos.x, this.tmpPos.z, state.u * 0.24, state.v * 0.24, 3.4, 0.5);
    }
  }

  private spawnUprootedTree(
    target: TreeTarget,
    state: ReturnType<ShallowWaterSolver["sampleStateAtWorld"]>,
    speed: number,
  ): void {
    target.trunk.getWorldPosition(this.tmpPos);
    this.tmpBox.setFromObject(target.trunk);
    const baseY = this.tmpBox.min.y + target.trunkRadius * 0.32;

    const treeBody = new THREE.Group();
    treeBody.name = "uprooted-tree";
    treeBody.position.set(this.tmpPos.x, baseY, this.tmpPos.z);
    this.debrisGroup.add(treeBody);

    const trunkClone = this.cloneMeshIntoParent(target.trunk, treeBody);
    trunkClone.castShadow = true;
    trunkClone.receiveShadow = true;

    if (target.canopy) {
      const canopyClone = this.cloneMeshIntoParent(target.canopy, treeBody);
      canopyClone.castShadow = true;
      canopyClone.receiveShadow = true;
    }

    const rootBallGeo = new THREE.IcosahedronGeometry(target.trunkRadius * 1.35, 0);
    const rootBallMat = new THREE.MeshPhongMaterial({ color: 0x4b3522, flatShading: true });
    const rootBall = new THREE.Mesh(rootBallGeo, rootBallMat);
    rootBall.castShadow = true;
    rootBall.receiveShadow = true;
    rootBall.position.set(0, target.trunkRadius * 0.28, 0);
    treeBody.add(rootBall);

    target.trunk.visible = false;
    if (target.canopy) target.canopy.visible = false;

    this.tmpVecA.set(state.u, 0, state.v);
    let flowSpeed = this.tmpVecA.length();
    if (flowSpeed < 1e-4) {
      this.tmpVecA.set(Math.random() - 0.5, 0, Math.random() - 0.5);
      flowSpeed = this.tmpVecA.length();
    }
    if (flowSpeed > 1e-6) this.tmpVecA.multiplyScalar(1 / flowSpeed);

    const launch = 0.65 + speed * 0.55;
    const velocity = new THREE.Vector3(
      this.tmpVecA.x * launch,
      0.35 + Math.min(0.7, speed * 0.16),
      this.tmpVecA.z * launch,
    );

    this.debrisBodies.push({
      object: treeBody,
      kind: "tree",
      velocity,
      angularVelocity: new THREE.Vector3(
        (Math.random() - 0.5) * 0.6,
        (Math.random() - 0.5) * 1.2,
        (Math.random() - 0.5) * 0.6,
      ),
      buoyancy: 5.8,
      drag: 2.9,
      angularDrag: 1.05,
      floatOffset: 0.18,
      ttl: Number.POSITIVE_INFINITY,
      characteristicHeight: Math.max(2.5, target.height),
      crossSection: Math.max(0.35, target.trunkRadius * 2),
      wasInWater: state.depth > 0.03,
      impactCooldown: 0,
      disposableGeometries: [rootBallGeo],
      disposableMaterials: [rootBallMat],
    });
  }

  private spawnSmallDebris(
    sourceMesh: THREE.Mesh,
    state: ReturnType<ShallowWaterSolver["sampleStateAtWorld"]>,
    speed: number,
  ): void {
    this.tmpBox.setFromObject(sourceMesh);
    this.tmpBox.getSize(this.tmpSize);

    const debris = sourceMesh;
    debris.visible = true;
    debris.castShadow = true;
    debris.receiveShadow = true;

    const baseSize = Math.max(this.tmpSize.x, this.tmpSize.y, this.tmpSize.z, 0.2);
    this.debrisBodies.push({
      object: debris,
      kind: "small",
      velocity: new THREE.Vector3(
        state.u * 1.1,
        0.45 + Math.random() * 0.3,
        state.v * 1.1,
      ),
      angularVelocity: new THREE.Vector3(
        (Math.random() - 0.5) * 4.0,
        (Math.random() - 0.5) * 4.0,
        (Math.random() - 0.5) * 4.0,
      ),
      buoyancy: 3.1,
      drag: 2.5,
      angularDrag: 0.88,
      floatOffset: 0.18,
      ttl: Number.POSITIVE_INFINITY,
      characteristicHeight: Math.max(0.3, this.tmpSize.y),
      crossSection: baseSize,
      wasInWater: state.depth > 0.03,
      impactCooldown: 0,
      disposableGeometries: [],
      disposableMaterials: [],
    });
  }

  private updateDebrisBodies(simDt: number): void {
    const rm: DebrisBody[] = [];
    const boundsPad = 90;
    const xMinBound = this.solver.xMin - boundsPad;
    const xMaxBound = this.solver.xMax + boundsPad;
    const zMinBound = this.solver.zMin - boundsPad;
    const zMaxBound = this.solver.zMax + boundsPad;

    for (const body of this.debrisBodies) {
      const removable = body.kind === "small";
      if (removable) {
        body.ttl -= simDt;
      }
      body.impactCooldown = Math.max(0, body.impactCooldown - simDt);
      if (removable && body.ttl <= 0) {
        rm.push(body);
        continue;
      }

      const pos = body.object.position;
      const state = this.solver.sampleStateAtWorld(pos.x, pos.z, true, 3);

      if (body.kind === "tree") {
        this.integrateTreeDebris(body, state, simDt);
      } else {
        this.integrateGenericDebris(body, state, simDt);
      }

      const inWater = state.depth > 0.04 && !state.obstacle;
      if (!body.wasInWater && inWater && Math.abs(body.velocity.y) > 0.45 && body.impactCooldown <= 0) {
        const splashStrength = Math.min(3.0, 0.9 + Math.abs(body.velocity.y) * 0.6 + state.depth * 0.25);
        this.surface.addImpactAtWorld(pos.x, pos.z, splashStrength, 3.4 + Math.min(8, body.crossSection * 2.8));
        body.impactCooldown = 0.55;
      }
      body.wasInWater = inWater;

      if (pos.x < xMinBound || pos.x > xMaxBound || pos.z < zMinBound || pos.z > zMaxBound) {
        if (removable) {
          rm.push(body);
        } else {
          pos.x = Math.max(xMinBound, Math.min(xMaxBound, pos.x));
          pos.z = Math.max(zMinBound, Math.min(zMaxBound, pos.z));
          body.velocity.x = 0;
          body.velocity.z = 0;
        }
      }
    }

    for (const body of rm) this.removeDebrisBody(body);
  }

  private integrateTreeDebris(
    body: DebrisBody,
    state: ReturnType<ShallowWaterSolver["sampleStateAtWorld"]>,
    simDt: number,
  ): void {
    const pos = body.object.position;
    const flowSpeed = Math.hypot(state.u, state.v);
    const submerged = clamp01(
      (state.depth + body.characteristicHeight * 0.08) /
        Math.max(0.8, body.characteristicHeight * 0.72),
    );

    const targetVX = state.u * (1.02 + submerged * 0.38);
    const targetVZ = state.v * (1.02 + submerged * 0.38);
    const align = Math.min(1, body.drag * (0.55 + submerged * 0.8) * simDt);
    body.velocity.x += (targetVX - body.velocity.x) * align;
    body.velocity.z += (targetVZ - body.velocity.z) * align;

    const targetY =
      state.surfaceY +
      body.floatOffset -
      (1 - submerged) * 0.16 * Math.max(1, body.characteristicHeight * 0.35);
    body.velocity.y += (targetY - pos.y) * body.buoyancy * simDt;
    body.velocity.y -= 9.81 * (1 - submerged * 0.92) * simDt;

    const turbulence = Math.min(2.0, flowSpeed * 0.22 + state.depth * 0.08);
    body.velocity.x += (Math.random() - 0.5) * turbulence * simDt;
    body.velocity.z += (Math.random() - 0.5) * turbulence * simDt;

    this.tmpVecA.set(state.u, 0.18 + 0.24 * (1 - submerged), state.v);
    if (this.tmpVecA.lengthSq() < 1e-6) {
      this.tmpVecA.copy(WORLD_UP);
    } else {
      this.tmpVecA.normalize();
    }

    this.tmpVecB.copy(WORLD_UP).applyQuaternion(body.object.quaternion).normalize();
    this.tmpVecC.crossVectors(this.tmpVecB, this.tmpVecA);
    const torqueStrength = (1.8 + flowSpeed * 0.9) * Math.max(0.25, submerged);
    body.angularVelocity.addScaledVector(this.tmpVecC, torqueStrength * simDt);
    body.angularVelocity.y += (Math.random() - 0.5) * (0.08 + flowSpeed * 0.12) * simDt;

    body.object.position.addScaledVector(body.velocity, simDt);
    this.integrateAngular(body, simDt);

    const groundY = state.terrainY + 0.05;
    if (body.object.position.y < groundY) {
      body.object.position.y = groundY;
      if (body.velocity.y < 0) body.velocity.y *= -0.12;
      body.velocity.x *= 0.92;
      body.velocity.z *= 0.92;
    }

    body.angularVelocity.multiplyScalar(Math.max(0, 1 - body.angularDrag * simDt));
  }

  private integrateGenericDebris(
    body: DebrisBody,
    state: ReturnType<ShallowWaterSolver["sampleStateAtWorld"]>,
    simDt: number,
  ): void {
    const pos = body.object.position;
    const speedFlow = Math.hypot(state.u, state.v);

    if (state.depth > 0.02 && !state.obstacle) {
      const targetY =
        state.surfaceY +
        body.floatOffset +
        Math.sin(performance.now() * 0.0013 + pos.x * 0.07) * 0.06;
      body.velocity.y += (targetY - pos.y) * body.buoyancy * simDt;

      const align = Math.min(1, body.drag * simDt);
      body.velocity.x += (state.u * 1.25 - body.velocity.x) * align;
      body.velocity.z += (state.v * 1.25 - body.velocity.z) * align;

      const turbulence = Math.min(1.7, speedFlow * 0.18);
      body.velocity.x += (Math.random() - 0.5) * turbulence * simDt;
      body.velocity.z += (Math.random() - 0.5) * turbulence * simDt;
    } else {
      body.velocity.y -= 9.81 * simDt;
      body.velocity.x *= Math.max(0, 1 - 0.55 * simDt);
      body.velocity.z *= Math.max(0, 1 - 0.55 * simDt);

      const groundY = state.terrainY + 0.08;
      if (pos.y < groundY) {
        pos.y = groundY;
        if (body.velocity.y < 0) body.velocity.y *= -0.18;
        body.velocity.x *= 0.85;
        body.velocity.z *= 0.85;
      }
    }

    body.object.position.addScaledVector(body.velocity, simDt);
    this.integrateAngular(body, simDt);
    body.angularVelocity.multiplyScalar(Math.max(0, 1 - body.angularDrag * simDt));
  }

  private integrateAngular(body: DebrisBody, simDt: number): void {
    const w = body.angularVelocity.length();
    if (w < 1e-6) return;
    this.tmpVecA.copy(body.angularVelocity).multiplyScalar(1 / w);
    this.tmpQuat.setFromAxisAngle(this.tmpVecA, w * simDt);
    body.object.quaternion.premultiply(this.tmpQuat).normalize();
  }

  private emitWallImpacts(simDt: number): void {
    this.wallImpactTimer += simDt;
    if (this.wallImpactTimer < 0.18) return;
    this.wallImpactTimer = 0;

    const total = this.solver.width * this.solver.height;
    for (let n = 0; n < 120; n++) {
      const idx = (Math.random() * total) | 0;
      if (this.solver.obstacle[idx] !== 0) continue;

      const d = this.solver.depth[idx]!;
      if (d < 1.0) continue;
      const mx = this.solver.mx[idx]!;
      const my = this.solver.my[idx]!;
      const speed = d > 1e-5 ? Math.hypot(mx / d, my / d) : 0;
      if (speed < 2.2) continue;

      const i = idx % this.solver.width;
      const j = Math.floor(idx / this.solver.width);
      const nearWall =
        (i > 0 && this.solver.obstacle[idx - 1] !== 0) ||
        (i < this.solver.width - 1 && this.solver.obstacle[idx + 1] !== 0) ||
        (j > 0 && this.solver.obstacle[idx - this.solver.width] !== 0) ||
        (j < this.solver.height - 1 && this.solver.obstacle[idx + this.solver.width] !== 0);
      if (!nearWall) continue;

      const wp = this.solver.cellIndexToWorld(idx);
      const impactStrength = Math.min(2.6, speed * 0.33 + d * 0.14);
      this.surface.addImpactAtWorld(
        wp.x,
        wp.z,
        impactStrength,
        3 + Math.min(5, speed * 0.9),
      );
      this.solver.injectMomentumImpulse(
        wp.x,
        wp.z,
        (mx / Math.max(d, 1e-5)) * 0.2,
        (my / Math.max(d, 1e-5)) * 0.2,
        2.8,
        0.6,
      );
    }
  }

  private cloneMeshIntoParent(source: THREE.Mesh, parent: THREE.Object3D): THREE.Mesh {
    const clone = source.clone(false) as THREE.Mesh;
    clone.geometry = source.geometry;
    clone.material = source.material;
    clone.visible = true;
    parent.add(clone);
    this.copyWorldTransformToParent(source, parent, clone);
    return clone;
  }

  private copyWorldTransformToParent(
    source: THREE.Object3D,
    parent: THREE.Object3D,
    target: THREE.Object3D,
  ): void {
    this.root.updateMatrixWorld(true);
    source.updateMatrixWorld(true);
    parent.updateMatrixWorld(true);
    this.tmpMat.copy(parent.matrixWorld).invert().multiply(source.matrixWorld);
    this.tmpMat.decompose(target.position, target.quaternion, target.scale);
  }

  private clearDebris(): void {
    while (this.debrisBodies.length > 0) {
      const body = this.debrisBodies.pop()!;
      this.destroyDebrisBody(body);
    }
  }

  private removeDebrisBody(body: DebrisBody): void {
    const idx = this.debrisBodies.indexOf(body);
    if (idx >= 0) this.debrisBodies.splice(idx, 1);
    this.destroyDebrisBody(body);
  }

  private destroyDebrisBody(body: DebrisBody): void {
    this.debrisGroup.remove(body.object);
    for (const geo of body.disposableGeometries) geo.dispose();
    for (const mat of body.disposableMaterials) mat.dispose();
  }
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

// --- Public simulator ---

export class FloodSimulator {
  active = false;
  position = new THREE.Vector3();
  maxHeight = 10.0;
  affectedRadiusMeters = 0;

  private scene: THREE.Scene;
  private eventBus: EventBus | null = null;
  private context: FloodInitContext | null = null;
  private solver: ShallowWaterSolver | null = null;
  private surface: FloodWaterSurface | null = null;
  private environment: FloodEnvironmentEffectsRealistic | null = null;
  private running = false;
  private flowSpeed = 3.2;
  private lastEmit = 0;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
  }

  setEventBus(bus: EventBus | null) {
    this.eventBus = bus;
  }

  setTerrainContext(layers: LayerData, centerLat: number, centerLon: number, sunLight?: THREE.DirectionalLight, parent?: THREE.Group | THREE.Scene) {
    this.context = { layers, centerLat, centerLon, sunLight, parent };
  }

  setMaxHeight(meters: number) {
    this.maxHeight = Math.max(10, meters);
    if (this.solver) {
      this.solver.setSourceDepthMeters(this.maxHeight);
    }
  }

  spawn(pos: THREE.Vector3) {
    if (!this.context) return;
    this.position.copy(pos);
    this.disposeInternal();

    const raster = buildFloodRaster(this.context, undefined, { x: pos.x, z: pos.z });
    this.solver = new ShallowWaterSolver(raster, {
      sourceEnabled: true,
      sourceFlowRate: 34,
      sourceRadiusCells: 2,
      cfl: 0.62,
      maxSubsteps: 28,
      manningN: 0.0008,
      infiltrationRate: 0,
      drainageRate: 0,
      rainRate: 0,
    });
    this.solver.setSourceDepthMeters(this.maxHeight);

    const sun = this.context.sunLight;
    this.surface = new FloodWaterSurface(raster, sun);
    this.surface.setSourcePosition(raster.sourceX, raster.sourceZ);
    this.surface.updateFromSolver(this.solver, 0);

    const parent = this.context.parent ?? sceneGroupRef ?? this.scene;
    parent.add(this.surface.mesh);
    this.environment = new FloodEnvironmentEffectsRealistic(parent as THREE.Group, this.solver, this.surface);

    this.active = true;
    this.running = true;
    this.lastEmit = 0;
  }

  despawn() {
    this.active = false;
    this.running = false;
    this.lastEmit = 0;
    this.disposeInternal();
  }

  update(dt: number) {
    if (!this.active || !this.running || !this.solver || !this.surface) return;

    if (this.context?.sunLight) {
      this.surface.setLightDirection(this.context.sunLight.position);
    }

    const simDt = dt * this.flowSpeed;
    this.solver.step(simDt);
    this.surface.updateFromSolver(this.solver, dt);
    if (this.environment) this.environment.update(simDt);

    const stats = this.solver.stats;
    if (stats.wetCellCount > 0) {
      const cellArea = this.solver.dx * this.solver.dz;
      const area = stats.wetCellCount * cellArea;
      this.affectedRadiusMeters = Math.sqrt(area / Math.PI);
    }

    this.lastEmit += dt;
    if (this.eventBus && this.lastEmit >= 0.5) {
      this.lastEmit = 0;
      const src = this.solver.getSourcePosition();
      const state = this.solver.sampleStateAtWorld(src.x, src.z, true, 0);
      this.eventBus.emit({
        type: "FLOOD_LEVEL",
        position: [src.x, state.surfaceY, src.z],
        waterHeight: state.depth,
        velocity: [state.u, 0, state.v],
      });
    }
  }

  private disposeInternal() {
    if (this.environment) {
      this.environment.dispose();
      this.environment = null;
    }
    if (this.surface) {
      const parent = this.context?.parent ?? sceneGroupRef ?? this.scene;
      parent.remove(this.surface.mesh);
      this.surface.dispose();
      this.surface = null;
    }
    this.solver = null;
  }
}
