import * as THREE from "three";
import { createHydroState, type TsunamiBounds } from "./TsunamiTypes.ts";
import { TerrainHeightSampler } from "./TerrainHeightSampler.ts";
import { TsunamiWaveField } from "./TsunamiWaveField.ts";

export class TsunamiWaterSurface {
  readonly mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshPhongMaterial>;

  private readonly geometry: THREE.PlaneGeometry;
  private readonly position: THREE.BufferAttribute;
  private readonly vertexX: Float32Array;
  private readonly vertexZ: Float32Array;
  private readonly baseTerrainY: Float32Array;
  private readonly hydroScratch = createHydroState();
  private normalTimer = 0;

  constructor(
    private readonly bounds: TsunamiBounds,
    private readonly terrainSampler: TerrainHeightSampler,
    private readonly waveField: TsunamiWaveField
  ) {
    const segmentsX = clampInt(Math.round(bounds.width / 3), 80, 220);
    const segmentsZ = clampInt(Math.round(bounds.depth / 3), 80, 220);

    this.geometry = new THREE.PlaneGeometry(bounds.width, bounds.depth, segmentsX, segmentsZ);
    this.geometry.rotateX(-Math.PI / 2);
    this.geometry.translate(
      (bounds.xMin + bounds.xMax) * 0.5,
      0,
      (bounds.zMin + bounds.zMax) * 0.5
    );

    this.position = this.geometry.getAttribute("position") as THREE.BufferAttribute;
    this.vertexX = new Float32Array(this.position.count);
    this.vertexZ = new Float32Array(this.position.count);
    this.baseTerrainY = new Float32Array(this.position.count);

    for (let i = 0; i < this.position.count; i++) {
      const x = this.position.getX(i);
      const z = this.position.getZ(i);
      this.vertexX[i] = x;
      this.vertexZ[i] = z;
      this.baseTerrainY[i] = terrainSampler.sample(x, z);
      this.position.setY(i, this.baseTerrainY[i] - 3);
    }
    this.position.needsUpdate = true;
    this.geometry.computeVertexNormals();

    const material = new THREE.MeshPhongMaterial({
      color: new THREE.Color("#2a9dc7"),
      emissive: new THREE.Color("#0d3040"),
      transparent: true,
      opacity: 0.72,
      shininess: 110,
      specular: new THREE.Color("#b8ecff"),
      depthWrite: false,
    });

    this.mesh = new THREE.Mesh(this.geometry, material);
    this.mesh.renderOrder = 18;
    this.mesh.name = "tsunami-water-surface";
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
  }

  update(dt = 1 / 60): void {
    let wetVertices = 0;
    let maxDepth = 0;

    for (let i = 0; i < this.position.count; i++) {
      const x = this.vertexX[i]!;
      const z = this.vertexZ[i]!;
      const terrainY = this.baseTerrainY[i]!;
      const hydro = this.waveField.getHydroStateAt(x, z, terrainY, this.hydroScratch);

      if (hydro.depth > 0.02) {
        const crestLift = (hydro.impulseFactor - 1) * 0.12;
        const chop =
          Math.sin((x + z) * 0.065 + performance.now() * 0.0017) *
          0.03 *
          Math.min(1, hydro.speed / 6);
        this.position.setY(i, terrainY + hydro.depth + crestLift + chop);
        wetVertices += 1;
        maxDepth = Math.max(maxDepth, hydro.depth);
      } else {
        this.position.setY(i, terrainY - 3);
      }
    }

    this.position.needsUpdate = true;
    this.normalTimer += dt;
    if (this.normalTimer > 0.08) {
      this.normalTimer = 0;
      this.geometry.computeVertexNormals();
    }

    this.mesh.visible = wetVertices > 0;
    this.mesh.material.opacity = THREE.MathUtils.clamp(0.46 + maxDepth * 0.018, 0.46, 0.86);
  }

  setLightDirection(direction: THREE.Vector3): void {
    const nY = THREE.MathUtils.clamp(direction.clone().normalize().y, 0, 1);
    const color = new THREE.Color("#1f92bb").lerp(new THREE.Color("#56bde0"), Math.sqrt(nY));
    const emissive = new THREE.Color("#0a2230").lerp(new THREE.Color("#13445b"), nY);
    this.mesh.material.color.copy(color);
    this.mesh.material.emissive.copy(emissive);
  }

  dispose(): void {
    this.geometry.dispose();
    this.mesh.material.dispose();
  }
}

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value | 0));
}
