import type { FloodRaster, FloodSolverParams, FloodStats } from "./FloodTypes.ts";
import { DEFAULT_FLOOD_PARAMS } from "./FloodTypes.ts";

export class ShallowWaterSolver {
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

    // Seed source with an initial water depth.
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

  setRainRateMetersPerSec(rate: number): void {
    this.params.rainRate = Math.max(0, rate);
  }

  setRainRateMmPerHour(mmPerHour: number): void {
    this.params.rainRate = Math.max(0, mmPerHour) / 1000 / 3600;
  }

  getSourcePosition(): { x: number; z: number; y: number } {
    return {
      x: this.sourceX,
      z: this.sourceZ,
      y: this.sourceY,
    };
  }

  cellIndexToWorld(idx: number): { x: number; z: number } {
    const i = idx % this.width;
    const j = Math.floor(idx / this.width);
    return {
      x: this.xMin + i * this.dx,
      z: this.zMin + j * this.dz,
    };
  }

  sampleStateAtWorld(
    x: number,
    z: number,
    preferOpen = true,
    searchRadiusCells = 2
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
    strength = 1
  ): void {
    const rCells = Math.max(
      1,
      Math.ceil(radiusMeters / Math.max(1e-6, Math.min(this.dx, this.dz)))
    );
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
    return {
      u: this.mx[idx]! / d,
      v: this.my[idx]! / d,
    };
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

    // X-interface fluxes
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

    // Y-interface fluxes
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

    // Conservative update
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

        // Bed-slope forcing nudges flow downhill even in near-static shallow regions.
        u += -g * this.terrainSlopeX[idx]! * dt * this.slopeForceScale;
        v += -g * this.terrainSlopeY[idx]! * dt * this.slopeForceScale;

        // Mild eddy-viscosity term smooths high-frequency velocity noise.
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

        // Free-slip wall boundary at building faces:
        // remove only the velocity component into the wall and keep tangential flow.
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
          const drag =
            (g * this.params.manningN * this.params.manningN * speed) /
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
    eps: number
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
    eps: number
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

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value | 0));
}
