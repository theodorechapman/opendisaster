import { metersPerDegree } from "../../src/tiles.ts";
import type { BuildingFeature } from "../../src/tiles.ts";
import type { FloodInitContext, FloodRaster } from "./FloodTypes.ts";

interface FloodRasterOptions {
  targetCellSizeMeters?: number;
  minResolution?: number;
  maxResolution?: number;
}

type PolygonXZ = {
  points: [number, number][];
  xMin: number;
  xMax: number;
  zMin: number;
  zMax: number;
};

const DEFAULT_OPTIONS: Required<FloodRasterOptions> = {
  targetCellSizeMeters: 2,
  minResolution: 96,
  maxResolution: 320,
};

export function buildFloodRaster(
  ctx: FloodInitContext,
  options: FloodRasterOptions = {}
): FloodRaster {
  const opts = { ...DEFAULT_OPTIONS, ...options };
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
    opts.maxResolution
  );
  const height = clampInt(
    Math.round(heightMeters / opts.targetCellSizeMeters) + 1,
    opts.minResolution,
    opts.maxResolution
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
        zMax
      );
    }
  }

  const buildingMask = new Uint8Array(width * height);
  const buildingPolys = extractBuildingPolygons(layers.buildings.features, centerLat, centerLon);
  rasterizeObstacles(buildingMask, buildingPolys, width, height, xMin, zMin, dx, dz);
  const obstacle = buildingMask;

  // Flood source starts at the highest terrain point that is not inside a building.
  const centerI = Math.floor(width * 0.5);
  const centerJ = Math.floor(height * 0.5);
  const sourceIndex = findHighestOpenCell(terrain, buildingMask, width, height, centerI, centerJ);
  const sourceY = terrain[sourceIndex]!;

  const sourceI = sourceIndex % width;
  const sourceJ = Math.floor(sourceIndex / width);
  const sourceX = xMin + sourceI * dx;
  const sourceZ = zMin + sourceJ * dz;

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

function extractBuildingPolygons(
  features: BuildingFeature[],
  centerLat: number,
  centerLon: number
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
  if (geometry.type === "Polygon") {
    return [geometry.coordinates as number[][][]];
  }
  if (geometry.type === "MultiPolygon") {
    return geometry.coordinates as number[][][][];
  }
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
  dz: number
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


function sampleTerrainBilinear(
  values: number[][],
  gridSize: number,
  minElev: number,
  x: number,
  z: number,
  xMin: number,
  xMax: number,
  zMin: number,
  zMax: number
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

function pointInPolygon(x: number, z: number, poly: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i]![0];
    const zi = poly[i]![1];
    const xj = poly[j]![0];
    const zj = poly[j]![1];
    const intersect =
      (zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / ((zj - zi) || 1e-6) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value | 0));
}

function findNearestOpenCell(
  obstacle: Uint8Array,
  width: number,
  height: number,
  startI: number,
  startJ: number
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

  return startIdx;
}

function findHighestOpenCell(
  terrain: Float32Array,
  obstacle: Uint8Array,
  width: number,
  height: number,
  fallbackI: number,
  fallbackJ: number
): number {
  let bestIdx = -1;
  let bestElev = Number.NEGATIVE_INFINITY;

  for (let idx = 0; idx < terrain.length; idx++) {
    if (obstacle[idx] !== 0) continue;
    const y = terrain[idx]!;
    if (y > bestElev) {
      bestElev = y;
      bestIdx = idx;
    }
  }

  if (bestIdx >= 0) return bestIdx;
  return findNearestOpenCell(obstacle, width, height, fallbackI, fallbackJ);
}
