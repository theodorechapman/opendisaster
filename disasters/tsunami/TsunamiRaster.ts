import * as THREE from "three";
import type { FloodRaster } from "../flood/FloodTypes.ts";
import { TerrainHeightSampler } from "./TerrainHeightSampler.ts";

interface TsunamiRasterOptions {
  targetCellSizeMeters?: number;
  minResolution?: number;
  maxResolution?: number;
}

const DEFAULT_OPTIONS: Required<TsunamiRasterOptions> = {
  targetCellSizeMeters: 2.5,
  minResolution: 96,
  maxResolution: 320,
};

export function buildTsunamiRaster(
  root: THREE.Group,
  terrainSampler: TerrainHeightSampler,
  options: TsunamiRasterOptions = {}
): FloodRaster {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const { xMin, xMax, zMin, zMax, width: widthMeters, depth: depthMeters } = terrainSampler.bounds;

  const width = clampInt(
    Math.round(widthMeters / opts.targetCellSizeMeters) + 1,
    opts.minResolution,
    opts.maxResolution
  );
  const height = clampInt(
    Math.round(depthMeters / opts.targetCellSizeMeters) + 1,
    opts.minResolution,
    opts.maxResolution
  );
  const dx = widthMeters / Math.max(1, width - 1);
  const dz = depthMeters / Math.max(1, height - 1);

  const terrain = new Float32Array(width * height);
  for (let j = 0; j < height; j++) {
    const z = zMin + j * dz;
    for (let i = 0; i < width; i++) {
      const x = xMin + i * dx;
      terrain[j * width + i] = terrainSampler.sample(x, z);
    }
  }

  const obstacle = new Uint8Array(width * height);
  const buildings = root.getObjectByName("buildings");
  if (buildings) {
    rasterizeBuildingObstacles(buildings, obstacle, width, height, xMin, zMin, dx, dz);
  }

  const sourceI = clampInt(Math.round(width * 0.5), 0, width - 1);
  const sourceJ = clampInt(Math.round(height * 0.92), 0, height - 1);
  const sourceIndex = findNearestOpenCell(obstacle, width, height, sourceI, sourceJ);
  const sourceX = xMin + (sourceIndex % width) * dx;
  const sourceZ = zMin + Math.floor(sourceIndex / width) * dz;
  const sourceY = terrain[sourceIndex] ?? 0;

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

function rasterizeBuildingObstacles(
  root: THREE.Object3D,
  obstacle: Uint8Array,
  width: number,
  height: number,
  xMin: number,
  zMin: number,
  dx: number,
  dz: number
): void {
  const bbox = new THREE.Box3();
  const size = new THREE.Vector3();
  const padMeters = 0.35;

  root.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    bbox.setFromObject(obj);
    if (!Number.isFinite(bbox.min.x) || !Number.isFinite(bbox.max.x)) return;

    bbox.getSize(size);
    if (size.x < 0.45 || size.z < 0.45 || size.y < 0.25) return;

    const iMin = clampInt(Math.floor((bbox.min.x - padMeters - xMin) / Math.max(1e-6, dx)), 0, width - 1);
    const iMax = clampInt(Math.ceil((bbox.max.x + padMeters - xMin) / Math.max(1e-6, dx)), 0, width - 1);
    const jMin = clampInt(Math.floor((bbox.min.z - padMeters - zMin) / Math.max(1e-6, dz)), 0, height - 1);
    const jMax = clampInt(Math.ceil((bbox.max.z + padMeters - zMin) / Math.max(1e-6, dz)), 0, height - 1);

    for (let j = jMin; j <= jMax; j++) {
      const row = j * width;
      for (let i = iMin; i <= iMax; i++) {
        obstacle[row + i] = 1;
      }
    }
  });
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

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value | 0));
}
