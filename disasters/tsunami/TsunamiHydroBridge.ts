import type { FloodRaster } from "../flood/FloodTypes.ts";
import type { FloodSurfaceSolverState } from "../flood/FloodWaterSurface.ts";
import { createHydroState } from "./TsunamiTypes.ts";
import { TerrainHeightSampler } from "./TerrainHeightSampler.ts";
import { TsunamiWaveField } from "./TsunamiWaveField.ts";

export class TsunamiHydroBridge implements FloodSurfaceSolverState {
  readonly depth: Float32Array;
  readonly mx: Float32Array;
  readonly my: Float32Array;
  readonly obstacle: Uint8Array;

  private readonly xByCell: Float32Array;
  private readonly zByCell: Float32Array;
  private readonly terrainByCell: Float32Array;
  private readonly impulseVX: Float32Array;
  private readonly impulseVZ: Float32Array;
  private readonly hydroScratch = createHydroState();

  constructor(
    readonly raster: FloodRaster,
    private readonly terrainSampler: TerrainHeightSampler,
    private readonly waveField: TsunamiWaveField
  ) {
    const n = raster.width * raster.height;
    this.depth = new Float32Array(n);
    this.mx = new Float32Array(n);
    this.my = new Float32Array(n);
    this.obstacle = raster.obstacle;
    this.xByCell = new Float32Array(n);
    this.zByCell = new Float32Array(n);
    this.terrainByCell = new Float32Array(n);
    this.impulseVX = new Float32Array(n);
    this.impulseVZ = new Float32Array(n);

    for (let j = 0; j < raster.height; j++) {
      const z = raster.zMin + j * raster.dz;
      for (let i = 0; i < raster.width; i++) {
        const idx = j * raster.width + i;
        const x = raster.xMin + i * raster.dx;
        this.xByCell[idx] = x;
        this.zByCell[idx] = z;
        this.terrainByCell[idx] = raster.terrain[idx] ?? this.terrainSampler.sample(x, z);
      }
    }
  }

  reset(): void {
    this.depth.fill(0);
    this.mx.fill(0);
    this.my.fill(0);
    this.impulseVX.fill(0);
    this.impulseVZ.fill(0);
  }

  update(dt: number): void {
    const damping = Math.exp(-Math.max(0, dt) * 3.5);
    for (let idx = 0; idx < this.depth.length; idx++) {
      if (this.obstacle[idx] !== 0) {
        this.depth[idx] = 0;
        this.mx[idx] = 0;
        this.my[idx] = 0;
        this.impulseVX[idx] *= damping;
        this.impulseVZ[idx] *= damping;
        continue;
      }

      const x = this.xByCell[idx]!;
      const z = this.zByCell[idx]!;
      const terrainY = this.terrainByCell[idx]!;
      const hydro = this.waveField.getHydroStateAt(x, z, terrainY, this.hydroScratch);
      const depth = hydro.depth;

      const vx = hydro.vx + this.impulseVX[idx]!;
      const vz = hydro.vz + this.impulseVZ[idx]!;
      this.depth[idx] = depth;
      this.mx[idx] = vx * depth;
      this.my[idx] = vz * depth;

      this.impulseVX[idx] *= damping;
      this.impulseVZ[idx] *= damping;
    }
  }

  injectMomentumImpulse(
    x: number,
    z: number,
    vx: number,
    vz: number,
    radiusMeters: number,
    strength = 1
  ): void {
    const rCells = Math.max(
      1,
      Math.ceil(radiusMeters / Math.max(1e-6, Math.min(this.raster.dx, this.raster.dz)))
    );
    const ci = clampInt(Math.round((x - this.raster.xMin) / Math.max(1e-6, this.raster.dx)), 0, this.raster.width - 1);
    const cj = clampInt(Math.round((z - this.raster.zMin) / Math.max(1e-6, this.raster.dz)), 0, this.raster.height - 1);
    const r2 = rCells * rCells;

    for (let j = Math.max(0, cj - rCells); j <= Math.min(this.raster.height - 1, cj + rCells); j++) {
      for (let i = Math.max(0, ci - rCells); i <= Math.min(this.raster.width - 1, ci + rCells); i++) {
        const di = i - ci;
        const dj = j - cj;
        const d2 = di * di + dj * dj;
        if (d2 > r2) continue;
        const idx = j * this.raster.width + i;
        if (this.obstacle[idx] !== 0) continue;
        const falloff = Math.exp(-d2 / Math.max(1, r2 * 0.5));
        const w = strength * falloff;
        this.impulseVX[idx] += vx * w;
        this.impulseVZ[idx] += vz * w;
      }
    }
  }
}

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value | 0));
}
