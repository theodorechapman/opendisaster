import * as THREE from "three";
import { createHydroState, type TsunamiParams } from "./TsunamiTypes.ts";
import { TerrainHeightSampler } from "./TerrainHeightSampler.ts";
import { TsunamiWaveField } from "./TsunamiWaveField.ts";

export class TsunamiSedimentOverlay {
  readonly mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;

  private readonly geometry: THREE.PlaneGeometry;
  private readonly positionAttr: THREE.BufferAttribute;
  private readonly colorAttr: THREE.BufferAttribute;
  private readonly vertexX: Float32Array;
  private readonly vertexZ: Float32Array;
  private readonly baseY: Float32Array;
  private readonly erosion: Float32Array;
  private readonly deposition: Float32Array;
  private readonly scour: Float32Array;
  private readonly structuralCells: number[] = [];
  private readonly hydroScratch = createHydroState();
  private readonly segmentsX: number;
  private readonly segmentsZ: number;
  private totals = { erosion: 0, deposition: 0, scour: 0 };

  constructor(
    root: THREE.Group,
    private readonly terrainSampler: TerrainHeightSampler,
    private readonly waveField: TsunamiWaveField,
    private readonly params: TsunamiParams
  ) {
    const bounds = this.terrainSampler.bounds;
    this.segmentsX = clampInt(Math.round(bounds.width / 5), 56, 128);
    this.segmentsZ = clampInt(Math.round(bounds.depth / 5), 56, 128);

    this.geometry = new THREE.PlaneGeometry(bounds.width, bounds.depth, this.segmentsX, this.segmentsZ);
    this.geometry.rotateX(-Math.PI / 2);
    this.geometry.translate(
      (bounds.xMin + bounds.xMax) * 0.5,
      0,
      (bounds.zMin + bounds.zMax) * 0.5
    );

    this.positionAttr = this.geometry.getAttribute("position") as THREE.BufferAttribute;
    this.vertexX = new Float32Array(this.positionAttr.count);
    this.vertexZ = new Float32Array(this.positionAttr.count);
    this.baseY = new Float32Array(this.positionAttr.count);
    this.erosion = new Float32Array(this.positionAttr.count);
    this.deposition = new Float32Array(this.positionAttr.count);
    this.scour = new Float32Array(this.positionAttr.count);

    const colors = new Float32Array(this.positionAttr.count * 3);
    this.colorAttr = new THREE.BufferAttribute(colors, 3);
    this.geometry.setAttribute("color", this.colorAttr);

    for (let i = 0; i < this.positionAttr.count; i++) {
      const x = this.positionAttr.getX(i);
      const z = this.positionAttr.getZ(i);
      this.vertexX[i] = x;
      this.vertexZ[i] = z;
      this.baseY[i] = this.terrainSampler.sample(x, z) + 0.03;
      this.positionAttr.setY(i, this.baseY[i]!);
      this.colorAttr.setXYZ(i, 0.08, 0.1, 0.12);
    }

    this.positionAttr.needsUpdate = true;
    this.colorAttr.needsUpdate = true;

    const material = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.0,
      depthWrite: false,
    });

    this.mesh = new THREE.Mesh(this.geometry, material);
    this.mesh.renderOrder = 17;
    this.mesh.name = "tsunami-sediment-overlay";
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;

    this.collectStructuralCells(root);
  }

  update(dt: number): void {
    if (dt <= 0) return;

    let sumErosion = 0;
    let sumDeposition = 0;
    let sumScour = 0;

    for (let idx = 0; idx < this.positionAttr.count; idx++) {
      const x = this.vertexX[idx]!;
      const z = this.vertexZ[idx]!;
      const terrainY = this.baseY[idx]! - 0.03;
      const hydro = this.waveField.getHydroStateAt(x, z, terrainY, this.hydroScratch);
      const shear = hydro.speed * hydro.depth;

      if (hydro.phase === "runup" || hydro.phase === "crest") {
        this.erosion[idx] +=
          dt * this.params.sedimentResponse * Math.max(0, shear - 1.2) * 0.016;
      } else if (hydro.phase === "backwash") {
        this.deposition[idx] +=
          dt *
          this.params.sedimentResponse *
          Math.max(0, 2.6 - shear) *
          Math.max(0, hydro.depth - 0.03) *
          0.010;
      }

      this.erosion[idx] *= Math.max(0, 1 - dt * 0.01);
      this.deposition[idx] *= Math.max(0, 1 - dt * 0.004);
      this.scour[idx] *= Math.max(0, 1 - dt * 0.02);

      sumErosion += this.erosion[idx]!;
      sumDeposition += this.deposition[idx]!;
      sumScour += this.scour[idx]!;
    }

    this.applyStructureScour(dt);

    // Recompute totals after scour stamping.
    sumScour = 0;
    for (let idx = 0; idx < this.scour.length; idx++) {
      sumScour += this.scour[idx]!;
    }

    this.totals = {
      erosion: sumErosion,
      deposition: sumDeposition,
      scour: sumScour,
    };

    this.updateColors();
  }

  reset(): void {
    this.erosion.fill(0);
    this.deposition.fill(0);
    this.scour.fill(0);
    this.totals = { erosion: 0, deposition: 0, scour: 0 };
    this.updateColors();
  }

  dispose(): void {
    this.geometry.dispose();
    this.mesh.material.dispose();
  }

  getTotals(): { erosion: number; deposition: number; scour: number } {
    return { ...this.totals };
  }

  private collectStructuralCells(root: THREE.Group): void {
    const buildings = root.getObjectByName("buildings");
    if (!buildings) return;

    const bbox = new THREE.Box3();
    const center = new THREE.Vector3();
    const seen = new Set<number>();

    buildings.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh)) return;
      bbox.setFromObject(obj);
      if (!Number.isFinite(bbox.min.x) || !Number.isFinite(bbox.max.x)) return;
      bbox.getCenter(center);
      const idx = this.worldToVertexIndex(center.x, center.z);
      if (idx < 0 || seen.has(idx)) return;
      seen.add(idx);
      this.structuralCells.push(idx);
    });
  }

  private applyStructureScour(dt: number): void {
    if (this.structuralCells.length === 0) return;

    for (const centerIdx of this.structuralCells) {
      const x = this.vertexX[centerIdx]!;
      const z = this.vertexZ[centerIdx]!;
      const terrainY = this.baseY[centerIdx]! - 0.03;
      const hydro = this.waveField.getHydroStateAt(x, z, terrainY, this.hydroScratch);
      const stress = hydro.speed * hydro.depth * hydro.impulseFactor;
      if (stress <= 1.4) continue;

      const i0 = centerIdx % (this.segmentsX + 1);
      const j0 = Math.floor(centerIdx / (this.segmentsX + 1));
      const radius = 2;

      for (let dj = -radius; dj <= radius; dj++) {
        for (let di = -radius; di <= radius; di++) {
          const i = i0 + di;
          const j = j0 + dj;
          if (i < 0 || i > this.segmentsX || j < 0 || j > this.segmentsZ) continue;
          const idx = j * (this.segmentsX + 1) + i;
          const dist = Math.sqrt(di * di + dj * dj);
          const falloff = Math.max(0, 1 - dist / (radius + 0.5));
          this.scour[idx] +=
            dt * this.params.scourSensitivity * Math.max(0, stress - 1.4) * 0.02 * falloff;
        }
      }
    }
  }

  private updateColors(): void {
    let active = 0;

    for (let i = 0; i < this.colorAttr.count; i++) {
      const erosionN = 1 - Math.exp(-this.erosion[i]! * 1.35);
      const depositionN = 1 - Math.exp(-this.deposition[i]! * 1.25);
      const scourN = 1 - Math.exp(-this.scour[i]! * 1.8);

      if (erosionN > 0.015 || depositionN > 0.015 || scourN > 0.015) {
        active += 1;
      }

      const r = clamp01(0.08 + depositionN * 0.45 + scourN * 0.55);
      const g = clamp01(0.10 + depositionN * 0.35 + erosionN * 0.12);
      const b = clamp01(0.12 + erosionN * 0.46);
      this.colorAttr.setXYZ(i, r, g, b);
    }

    this.colorAttr.needsUpdate = true;

    const activityRatio = active / Math.max(1, this.colorAttr.count);
    this.mesh.material.opacity = THREE.MathUtils.clamp(activityRatio * 2.1, 0, 0.45);
    this.mesh.visible = activityRatio > 0.005;
  }

  private worldToVertexIndex(x: number, z: number): number {
    const bounds = this.terrainSampler.bounds;
    const u = clamp01((x - bounds.xMin) / Math.max(1e-6, bounds.width));
    const v = clamp01((z - bounds.zMin) / Math.max(1e-6, bounds.depth));
    const i = clampInt(Math.round(u * this.segmentsX), 0, this.segmentsX);
    const j = clampInt(Math.round(v * this.segmentsZ), 0, this.segmentsZ);
    return j * (this.segmentsX + 1) + i;
  }
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value | 0));
}
