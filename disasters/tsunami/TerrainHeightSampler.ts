import * as THREE from "three";
import type { TsunamiBounds } from "./TsunamiTypes.ts";

export class TerrainHeightSampler {
  readonly bounds: TsunamiBounds;

  private readonly widthSegments: number;
  private readonly heightSegments: number;
  private readonly heights: Float32Array;
  private readonly rowSize: number;

  constructor(terrainMesh: THREE.Mesh) {
    if (!(terrainMesh.geometry instanceof THREE.BufferGeometry)) {
      throw new Error("Terrain mesh must use BufferGeometry.");
    }

    const geometry = terrainMesh.geometry;
    const position = geometry.getAttribute("position");
    if (!(position instanceof THREE.BufferAttribute)) {
      throw new Error("Terrain position attribute is missing.");
    }

    const params = geometry as THREE.PlaneGeometry;
    const guessedWidth = Math.max(1, Math.round(Math.sqrt(position.count)) - 1);
    this.widthSegments = params.parameters?.widthSegments ?? guessedWidth;
    this.heightSegments = params.parameters?.heightSegments ?? guessedWidth;
    this.rowSize = this.widthSegments + 1;

    this.heights = new Float32Array(position.count);
    for (let i = 0; i < position.count; i++) {
      this.heights[i] = position.getY(i);
    }

    const bbox = new THREE.Box3().setFromObject(terrainMesh);
    this.bounds = {
      xMin: bbox.min.x,
      xMax: bbox.max.x,
      zMin: bbox.min.z,
      zMax: bbox.max.z,
      width: Math.max(1e-6, bbox.max.x - bbox.min.x),
      depth: Math.max(1e-6, bbox.max.z - bbox.min.z),
    };
  }

  sample(x: number, z: number): number {
    const u = clamp01((x - this.bounds.xMin) / this.bounds.width);
    const v = clamp01((z - this.bounds.zMin) / this.bounds.depth);

    const fx = u * this.widthSegments;
    const fz = v * this.heightSegments;
    const x0 = clampInt(Math.floor(fx), 0, this.widthSegments);
    const z0 = clampInt(Math.floor(fz), 0, this.heightSegments);
    const x1 = clampInt(x0 + 1, 0, this.widthSegments);
    const z1 = clampInt(z0 + 1, 0, this.heightSegments);
    const tx = fx - x0;
    const tz = fz - z0;

    const h00 = this.heights[this.idx(x0, z0)] ?? 0;
    const h10 = this.heights[this.idx(x1, z0)] ?? 0;
    const h01 = this.heights[this.idx(x0, z1)] ?? 0;
    const h11 = this.heights[this.idx(x1, z1)] ?? 0;

    const hx0 = h00 * (1 - tx) + h10 * tx;
    const hx1 = h01 * (1 - tx) + h11 * tx;
    return hx0 * (1 - tz) + hx1 * tz;
  }

  private idx(i: number, j: number): number {
    return j * this.rowSize + i;
  }
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value | 0));
}
