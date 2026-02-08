import * as THREE from "three";
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
  infiltrationRate: 0.0,
  drainageRate: 0.00015,
  wetThreshold: 0.001,
  sourceEnabled: true,
  sourceFlowRate: 30,
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
    targetCellSizeMeters: 2.4,
    minResolution: 96,
    maxResolution: 220,
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
  private sourceDepthMeters = 2.0;
  private readonly minSourceDepthMeters = 0.5;
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

  sampleStateAtWorld(x: number, z: number): { depth: number; u: number; v: number; terrainY: number; surfaceY: number } {
    const i = clampInt(Math.round((x - this.xMin) / Math.max(1e-6, this.dx)), 0, this.width - 1);
    const j = clampInt(Math.round((z - this.zMin) / Math.max(1e-6, this.dz)), 0, this.height - 1);
    const idx = j * this.width + i;
    const depth = this.depth[idx]!;
    const u = depth > this.params.wetThreshold ? this.mx[idx]! / depth : 0;
    const v = depth > this.params.wetThreshold ? this.my[idx]! / depth : 0;
    const terrainY = this.terrain[idx]!;
    return { depth, u, v, terrainY, surfaceY: terrainY + depth };
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
    return Math.min(8.5, 2.4 + Math.sqrt(Math.max(0, sourceRateMetersPerSec)));
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

class FloodWaterSurface {
  readonly mesh: THREE.Mesh;

  private readonly raster: FloodRaster;
  private readonly positionAttr: THREE.BufferAttribute;
  private readonly depthAttr: THREE.BufferAttribute;
  private readonly velocityAttr: THREE.BufferAttribute;
  private readonly rippleAttr: THREE.BufferAttribute;
  private readonly vertexToCell: Uint32Array;
  private readonly material: THREE.ShaderMaterial;
  private depthScale = 1;
  private readonly baseYOffset = 0.12;
  private rippleHeight: Float32Array;
  private rippleVelocity: Float32Array;
  private rippleNextHeight: Float32Array;
  private rippleNextVelocity: Float32Array;
  private readonly pendingImpacts: ImpactPulse[] = [];

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

    this.material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: true,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
      uniforms: {
        uDepthScale: { value: this.depthScale },
        uLightDir: {
          value: sunLight
            ? sunLight.position.clone().normalize()
            : new THREE.Vector3(0.35, 0.86, 0.36).normalize(),
        },
        uSunColor: { value: new THREE.Color(1.0, 0.95, 0.82) },
        uSourceXZ: { value: new THREE.Vector2(0, 0) },
        uTime: { value: 0 },
      },
      vertexShader: `
        attribute float aDepth;
        attribute vec2 aVelocity;
        attribute float aRipple;
        uniform float uDepthScale;
        varying float vDepth;
        varying vec2 vVelocity;
        varying float vRipple;
        varying vec2 vUv;
        varying vec3 vWorldPos;

        void main() {
          vDepth = max(0.0, aDepth * uDepthScale);
          vVelocity = aVelocity;
          vRipple = aRipple;
          vUv = uv;
          vec4 world = modelMatrix * vec4(position, 1.0);
          vWorldPos = world.xyz;
          gl_Position = projectionMatrix * viewMatrix * world;
        }
      `,
      fragmentShader: `
        precision highp float;
        varying float vDepth;
        varying vec2 vVelocity;
        varying float vRipple;
        varying vec2 vUv;
        varying vec3 vWorldPos;
        uniform vec3 uLightDir;
        uniform vec3 uSunColor;
        uniform vec2 uSourceXZ;
        uniform float uTime;

        float hash21(vec2 p) {
          p = fract(p * vec2(123.34, 456.21));
          p += dot(p, p + 45.32);
          return fract(p.x * p.y);
        }

        float noise2(vec2 p) {
          vec2 i = floor(p);
          vec2 f = fract(p);
          float a = hash21(i);
          float b = hash21(i + vec2(1.0, 0.0));
          float c = hash21(i + vec2(0.0, 1.0));
          float d = hash21(i + vec2(1.0, 1.0));
          vec2 u = f * f * (3.0 - 2.0 * f);
          return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
        }

        float fbm(vec2 p) {
          float v = 0.0;
          float a = 0.5;
          for (int i = 0; i < 4; i++) {
            v += a * noise2(p);
            p = p * 2.03 + vec2(19.37, -7.11);
            a *= 0.5;
          }
          return v;
        }

        vec3 skyColor(vec3 dir) {
          float t = clamp(dir.y * 0.5 + 0.5, 0.0, 1.0);
          vec3 skyTop = vec3(0.42, 0.63, 0.90);
          vec3 skyHorizon = vec3(0.88, 0.93, 0.99);
          vec3 groundTint = vec3(0.20, 0.24, 0.30);
          return mix(mix(skyHorizon, skyTop, pow(t, 0.7)), groundTint, pow(1.0 - t, 5.0));
        }

        void main() {
          if (vDepth < 0.01) discard;

          vec2 toPoint = vWorldPos.xz - uSourceXZ;
          float radialDist = length(toPoint);
          vec2 radialDir = normalize(toPoint + vec2(1e-6));
          float sourceInfluence = smoothstep(140.0, 0.0, radialDist);

          vec2 physicalFlow = vVelocity;
          vec2 advectFlow = physicalFlow + radialDir * (0.25 * sourceInfluence);
          vec2 flowDir = normalize(advectFlow + vec2(1e-6));
          float flowSpeed = length(physicalFlow);
          vec2 flow = flowDir * (0.06 + 0.14 * min(5.0, flowSpeed));

          vec2 uvA = vUv * 10.0 + flow * (uTime * 0.8);
          vec2 uvB = vUv * 22.0 + vec2(flowDir.y, -flowDir.x) * (uTime * 0.9);
          float e = 0.0015;
          float hL = fbm(uvA - vec2(e, 0.0)) * 0.7 + fbm(uvB - vec2(e, 0.0)) * 0.3;
          float hR = fbm(uvA + vec2(e, 0.0)) * 0.7 + fbm(uvB + vec2(e, 0.0)) * 0.3;
          float hD = fbm(uvA - vec2(0.0, e)) * 0.7 + fbm(uvB - vec2(0.0, e)) * 0.3;
          float hU = fbm(uvA + vec2(0.0, e)) * 0.7 + fbm(uvB + vec2(0.0, e)) * 0.3;
          float dHx = (hR - hL) / (2.0 * e);
          float dHz = (hU - hD) / (2.0 * e);

          vec3 baseNormal = normalize(cross(dFdx(vWorldPos), dFdy(vWorldPos)));
          vec3 flowNormal = normalize(vec3(-vVelocity.x * 0.02, 1.0, -vVelocity.y * 0.02));
          vec3 microNormal = normalize(vec3(-dHx * 0.50, 1.0, -dHz * 0.50));
          vec3 normal = normalize(baseNormal * 0.58 + flowNormal * 0.18 + microNormal * 0.62);

          vec3 viewDir = normalize(cameraPosition - vWorldPos);
          vec3 lightDir = normalize(uLightDir);
          vec3 reflDir = reflect(-viewDir, normal);
          vec3 halfDir = normalize(lightDir + viewDir);

          float ndotV = max(dot(normal, viewDir), 0.0);
          float ndotL = max(dot(normal, lightDir), 0.0);
          float fresnel = 0.02 + 0.98 * pow(1.0 - ndotV, 5.0);

          float depthMix = clamp(vDepth / 6.0, 0.0, 1.0);
          float absorb = exp(-vDepth * 0.55);
          vec3 shallowCol = vec3(0.07, 0.25, 0.44);
          vec3 deepCol = vec3(0.00, 0.03, 0.12);
          vec3 subsurface = mix(deepCol, shallowCol, absorb);
          vec3 refracted = subsurface * (0.25 + 0.75 * ndotL) * mix(1.0, 0.82, depthMix);

          vec3 envRefl = skyColor(reflDir);
          float sunRefl = pow(max(dot(reflDir, lightDir), 0.0), 1300.0);
          envRefl += uSunColor * sunRefl * 6.0;

          vec3 color = mix(refracted, envRefl, fresnel);

          float spec = pow(max(dot(normal, halfDir), 0.0), 190.0) * (0.2 + 0.8 * ndotL);
          float glitter = pow(max(dot(normalize(reflDir + lightDir), viewDir), 0.0), 300.0);
          color += uSunColor * (spec * 0.85 + glitter * 0.32);

          float speed = length(vVelocity);
          float vort = abs(dFdx(vVelocity.y) - dFdy(vVelocity.x));
          float rippleEnergy = abs(vRipple);
          float shorelineFoam = 1.0 - smoothstep(0.03, 0.30, vDepth);
          float turbulenceFoam = smoothstep(0.9, 2.7, speed + vort * 1.8 + rippleEnergy * 6.5);
          float foamNoise = fbm(vUv * 36.0 + flow * uTime * 1.5);
          float streak = 0.5 + 0.5 * sin(dot(vUv * 200.0 + flow * uTime * 8.0, vec2(-flowDir.y, flowDir.x)));
          float foam = clamp(shorelineFoam * 0.8 + turbulenceFoam * 0.65, 0.0, 1.0) *
                       foamNoise * (0.62 + 0.38 * streak);
          color = mix(color, vec3(0.94, 0.97, 1.0), foam * 0.5);

          color = clamp(color, vec3(0.0), vec3(1.0));
          float alpha = clamp(0.82 + vDepth * 0.05 + fresnel * 0.02, 0.84, 0.93);
          gl_FragColor = vec4(color, alpha);
        }
      `,
    });

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
    this.material.uniforms.uTime.value += dt;
    this.mesh.visible = wetCount > 0;
  }

  setDepthScale(scale: number): void {
    this.depthScale = Math.max(0.1, Math.min(4, scale));
    this.material.uniforms.uDepthScale.value = this.depthScale;
  }

  setLightDirection(dir: THREE.Vector3): void {
    this.material.uniforms.uLightDir.value.copy(dir).normalize();
    const nY = Math.max(0, Math.min(1, dir.clone().normalize().y));
    const warm = new THREE.Color(1.0, 0.95, 0.82);
    const cool = new THREE.Color(0.82, 0.90, 1.0);
    this.material.uniforms.uSunColor.value.copy(cool).lerp(warm, Math.sqrt(nY));
  }

  setSourcePosition(x: number, z: number): void {
    this.material.uniforms.uSourceXZ.value.set(x, z);
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

// --- Public simulator ---

export class FloodSimulator {
  active = false;
  position = new THREE.Vector3();
  maxHeight = 2.0;
  affectedRadiusMeters = 0;

  private scene: THREE.Scene;
  private eventBus: EventBus | null = null;
  private context: FloodInitContext | null = null;
  private solver: ShallowWaterSolver | null = null;
  private surface: FloodWaterSurface | null = null;
  private running = false;
  private flowSpeed = 3.0;
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
    this.maxHeight = clamp(meters, 0.5, 8.0);
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
      const state = this.solver.sampleStateAtWorld(src.x, src.z);
      this.eventBus.emit({
        type: "FLOOD_LEVEL",
        position: [src.x, state.surfaceY, src.z],
        waterHeight: state.depth,
        velocity: [state.u, 0, state.v],
      });
    }
  }

  private disposeInternal() {
    if (this.surface) {
      const parent = this.context?.parent ?? sceneGroupRef ?? this.scene;
      parent.remove(this.surface.mesh);
      this.surface.dispose();
      this.surface = null;
    }
    this.solver = null;
  }
}
