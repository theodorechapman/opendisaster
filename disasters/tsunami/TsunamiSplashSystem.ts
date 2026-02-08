import * as THREE from "three";
import { createHydroState, type TsunamiImpactEvent, type TsunamiParams } from "./TsunamiTypes.ts";
import { TerrainHeightSampler } from "./TerrainHeightSampler.ts";
import { TsunamiWaveField } from "./TsunamiWaveField.ts";

type SplashParticleKind = "sheet" | "spray" | "droplet";

type SplashParticle = {
  mesh: THREE.Mesh;
  kind: SplashParticleKind;
  velocity: THREE.Vector3;
  ttl: number;
  maxTtl: number;
  radius: number;
  energy: number;
};

export class TsunamiSplashSystem {
  readonly group = new THREE.Group();

  private readonly particles: SplashParticle[] = [];
  private readonly buildingColliders: THREE.Box3[] = [];
  private readonly buildingBuckets = new Map<string, number[]>();
  private readonly collisionBucketSize = 18;
  private readonly tmpColliderIndices = new Set<number>();
  private readonly tmpCollisionNormal = new THREE.Vector3();
  private readonly sheetGeometry = new THREE.SphereGeometry(0.12, 6, 5);
  private readonly sprayGeometry = new THREE.SphereGeometry(0.08, 6, 5);
  private readonly dropletGeometry = new THREE.SphereGeometry(0.05, 6, 5);
  private readonly sheetMaterial = new THREE.MeshStandardMaterial({
    color: new THREE.Color("#f3fbff"),
    emissive: new THREE.Color("#1d4f63"),
    transparent: true,
    opacity: 0.86,
    roughness: 0.16,
    metalness: 0.03,
  });
  private readonly sprayMaterial = new THREE.MeshStandardMaterial({
    color: new THREE.Color("#dff6ff"),
    emissive: new THREE.Color("#1f5164"),
    transparent: true,
    opacity: 0.8,
    roughness: 0.25,
    metalness: 0.02,
  });
  private readonly dropletMaterial = new THREE.MeshStandardMaterial({
    color: new THREE.Color("#c8ecff"),
    emissive: new THREE.Color("#0e3347"),
    transparent: true,
    opacity: 0.72,
    roughness: 0.18,
    metalness: 0.0,
  });
  private readonly tmpHydro = createHydroState();

  constructor(
    private readonly root: THREE.Group,
    private readonly terrainSampler: TerrainHeightSampler,
    private readonly waveField: TsunamiWaveField,
    private readonly params: TsunamiParams,
    private readonly onWaterImpact: (x: number, z: number, strength: number, radiusMeters: number) => void
  ) {
    this.group.name = "tsunami-splashes";
    this.collectBuildingColliders();
    this.root.add(this.group);
  }

  update(dt: number): void {
    if (dt <= 0) return;
    this.pruneToCaps();
    const { xMin, xMax, zMin, zMax } = this.terrainSampler.bounds;
    const pad = 80;
    const substeps = clampInt(
      Math.ceil(dt * 60 * (0.65 + 0.35 * Math.max(1, this.params.maxParticleSubsteps))),
      1,
      Math.max(1, Math.floor(this.params.maxParticleSubsteps))
    );
    const subDt = dt / substeps;

    for (let i = this.particles.length - 1; i >= 0; i--) {
      const particle = this.particles[i]!;
      particle.ttl -= dt;
      if (particle.ttl <= 0) {
        this.removeParticle(i);
        continue;
      }

      const pos = particle.mesh.position;
      const gravityScale =
        particle.kind === "sheet" ? 0.48 : particle.kind === "spray" ? 0.74 : 1.0;
      const drag = particle.kind === "sheet" ? 2.9 : particle.kind === "spray" ? 2.1 : 2.4;
      let removeNow = false;

      for (let step = 0; step < substeps; step++) {
        particle.velocity.y -= 9.81 * subDt * gravityScale;
        const decay = Math.max(0, 1 - drag * subDt);
        particle.velocity.multiplyScalar(decay);
        pos.addScaledVector(particle.velocity, subDt);

        const hitBuilding = this.resolveBuildingCollision(particle);
        if (hitBuilding) {
          particle.energy *= particle.kind === "droplet" ? 0.84 : 0.72;
          if (particle.kind === "droplet" && particle.velocity.lengthSq() < 0.2) {
            removeNow = true;
            break;
          }
        }

        const terrainY = this.terrainSampler.sample(pos.x, pos.z);
        const hydro = this.waveField.getHydroStateAt(pos.x, pos.z, terrainY, this.tmpHydro);
        const waterY = hydro.depth > 0.01 ? hydro.surfaceY : terrainY;

        if (pos.y <= waterY && particle.velocity.y <= 0) {
          const speed = particle.velocity.length();
          const strengthBase = particle.kind === "droplet" ? 0.1 : particle.kind === "sheet" ? 0.2 : 0.15;
          const strength =
            strengthBase *
            this.params.splashIntensity *
            this.params.splashEnergyScale *
            (0.6 + speed * 0.35) *
            (0.6 + Math.min(1.8, particle.energy * 0.28));
          const radiusBase = particle.kind === "droplet" ? 0.9 : particle.kind === "sheet" ? 1.8 : 1.4;
          const radius = radiusBase * (1 + Math.min(2.5, speed * 0.2));
          this.onWaterImpact(pos.x, pos.z, strength, radius);
          removeNow = true;
          break;
        }

        if (particle.kind === "droplet" && pos.y <= terrainY + particle.radius * 0.25) {
          pos.y = terrainY + particle.radius * 0.25;
          particle.velocity.y *= -0.18;
          particle.velocity.x *= 0.65;
          particle.velocity.z *= 0.65;
          if (Math.abs(particle.velocity.y) < 0.25) {
            removeNow = true;
            break;
          }
        }
      }

      if (removeNow) {
        this.removeParticle(i);
        continue;
      }

      if (
        pos.x < xMin - pad ||
        pos.x > xMax + pad ||
        pos.z < zMin - pad ||
        pos.z > zMax + pad
      ) {
        this.removeParticle(i);
        continue;
      }

      const lifeT = clamp01(particle.ttl / Math.max(1e-6, particle.maxTtl));
      const energyScale = 0.65 + Math.min(1.6, particle.energy * 0.18);
      const scale = particle.radius * (0.35 + 0.85 * lifeT) * energyScale;
      particle.mesh.scale.setScalar(scale);
    }
  }

  emitImpact(event: TsunamiImpactEvent): void {
    const intensity = Math.max(0, event.intensity);
    if (intensity <= 0) return;

    const flowSpeed = Math.hypot(event.flowX, event.flowZ);
    const characteristicLength = Math.max(0.04, event.radiusMeters * 0.12);
    const sigma = Math.max(0.015, this.params.surfaceTensionProxy);
    const weber = this.params.rhoWater * (0.8 + flowSpeed + intensity * 0.35) ** 2 * characteristicLength / sigma;
    const breakup = clamp01(
      (weber - this.params.weberThreshold) / Math.max(10, this.params.weberThreshold)
    );
    const splashEnergy = this.params.splashIntensity * this.params.splashEnergyScale;

    const desiredSheet = clampInt(
      Math.round((1 + intensity * 1.4) * (1 - breakup * 0.65) * splashEnergy),
      0,
      24
    );
    const desiredSpray = clampInt(
      Math.round((2 + intensity * 3.8) * (0.5 + breakup) * splashEnergy),
      1,
      68
    );
    const desiredDroplets = clampInt(
      Math.round((4 + intensity * 8.4) * (0.45 + breakup * 1.25) * this.params.dropletDensity),
      2,
      220
    );

    const splashCap = Math.max(0, Math.floor(this.params.maxSplashParticles));
    const dropletCap = Math.max(0, Math.floor(this.params.maxDroplets));
    const splashUsed = this.countKind("sheet") + this.countKind("spray");
    const splashFree = Math.max(0, splashCap - splashUsed);
    const sheetCount = Math.min(desiredSheet, splashFree);
    const sprayCount = Math.min(desiredSpray, Math.max(0, splashFree - sheetCount));
    const dropletCount = Math.min(desiredDroplets, Math.max(0, dropletCap - this.countKind("droplet")));
    if (sheetCount <= 0 && sprayCount <= 0 && dropletCount <= 0) return;

    this.ensureCapacity("sheet", sheetCount);
    this.ensureCapacity("spray", sprayCount);
    this.ensureCapacity("droplet", dropletCount);

    const normal = new THREE.Vector3(event.nx, event.ny, event.nz);
    if (normal.lengthSq() < 1e-6) {
      normal.set(0, 1, 0);
    } else {
      normal.normalize();
    }
    const flow = new THREE.Vector3(event.flowX, 0, event.flowZ);
    if (flow.lengthSq() > 1e-6) flow.normalize();
    const basePos = new THREE.Vector3(event.x, event.y, event.z);

    for (let i = 0; i < sheetCount; i++) {
      const tangential = new THREE.Vector3(Math.random() - 0.5, 0, Math.random() - 0.5).normalize();
      const swirl = new THREE.Vector3(-flow.z, 0, flow.x).multiplyScalar((Math.random() - 0.5) * 0.75);
      const v = normal
        .clone()
        .multiplyScalar(1.15 + Math.random() * (1.8 + intensity * 0.9))
        .addScaledVector(flow, 0.95 + Math.random() * (1.15 + intensity * 0.32))
        .addScaledVector(tangential, 0.18 + Math.random() * 0.5)
        .add(swirl);
      const offset = normal.clone().multiplyScalar(0.08 + Math.random() * 0.22);
      const position = basePos.clone().add(offset);
      const ttl = 0.26 + Math.random() * 0.42;
      const radius = 0.12 + Math.random() * 0.14;
      this.spawnParticle("sheet", position, v, ttl, radius);
    }

    for (let i = 0; i < sprayCount; i++) {
      const tangential = new THREE.Vector3(Math.random() - 0.5, 0, Math.random() - 0.5).normalize();
      const swirl = new THREE.Vector3(-flow.z, 0, flow.x).multiplyScalar((Math.random() - 0.5) * 0.95);
      const v = normal
        .clone()
        .multiplyScalar(1.8 + Math.random() * (2.8 + intensity * 1.25))
        .addScaledVector(flow, 0.65 + Math.random() * (1.45 + intensity * 0.4))
        .addScaledVector(tangential, 0.2 + Math.random() * 0.85)
        .add(swirl);
      const position = basePos.clone().addScaledVector(normal, 0.06 + Math.random() * 0.16);
      const ttl = 0.4 + Math.random() * 0.72;
      const radius = 0.06 + Math.random() * 0.1;
      this.spawnParticle("spray", position, v, ttl, radius);
    }

    for (let i = 0; i < dropletCount; i++) {
      const spread = new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.45, Math.random() - 0.5);
      const apicBlend = 0.62 + 0.28 * Math.random();
      const v = normal
        .clone()
        .multiplyScalar(2.1 + Math.random() * (4.0 + intensity * 1.95))
        .addScaledVector(flow, apicBlend * (0.9 + intensity * 0.4))
        .addScaledVector(spread, 1.5 + Math.random() * 2.5);
      const position = basePos.clone().addScaledVector(normal, 0.05 + Math.random() * 0.12);
      const ttl = 0.8 + Math.random() * 1.4;
      const radius = 0.03 + Math.random() * 0.06;
      this.spawnParticle("droplet", position, v, ttl, radius);
    }
  }

  getCounts(): { splash: number; droplets: number; total: number } {
    let splash = 0;
    let droplets = 0;
    for (const particle of this.particles) {
      if (particle.kind === "sheet" || particle.kind === "spray") splash += 1;
      else droplets += 1;
    }
    return {
      splash,
      droplets,
      total: this.particles.length,
    };
  }

  reset(): void {
    for (let i = this.particles.length - 1; i >= 0; i--) {
      this.removeParticle(i);
    }
  }

  dispose(): void {
    this.reset();
    this.root.remove(this.group);
    this.sheetGeometry.dispose();
    this.sprayGeometry.dispose();
    this.dropletGeometry.dispose();
    this.sheetMaterial.dispose();
    this.sprayMaterial.dispose();
    this.dropletMaterial.dispose();
  }

  private spawnParticle(
    kind: SplashParticleKind,
    position: THREE.Vector3,
    velocity: THREE.Vector3,
    ttl: number,
    radius: number
  ): void {
    const geometry =
      kind === "sheet"
        ? this.sheetGeometry
        : kind === "spray"
          ? this.sprayGeometry
          : this.dropletGeometry;
    const material =
      kind === "sheet"
        ? this.sheetMaterial
        : kind === "spray"
          ? this.sprayMaterial
          : this.dropletMaterial;
    const mesh = new THREE.Mesh(
      geometry,
      material
    );
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.position.copy(position);
    mesh.scale.setScalar(radius);
    this.group.add(mesh);

    this.particles.push({
      mesh,
      kind,
      velocity,
      ttl,
      maxTtl: ttl,
      radius,
      energy: velocity.length(),
    });
  }

  private ensureCapacity(kind: SplashParticleKind, incoming: number): void {
    const splashLike = kind === "sheet" || kind === "spray";
    const max = splashLike
      ? Math.max(0, Math.floor(this.params.maxSplashParticles))
      : Math.max(0, Math.floor(this.params.maxDroplets));

    if (max <= 0) {
      for (let i = this.particles.length - 1; i >= 0; i--) {
        const entry = this.particles[i]!;
        if (splashLike ? entry.kind !== "droplet" : entry.kind === "droplet") {
          this.removeParticle(i);
        }
      }
      return;
    }

    let current = 0;
    for (const particle of this.particles) {
      if (splashLike) {
        if (particle.kind !== "droplet") current += 1;
      } else if (particle.kind === "droplet") {
        current += 1;
      }
    }

    let overflow = current + incoming - max;
    if (overflow <= 0) return;

    for (let i = 0; i < this.particles.length && overflow > 0; i++) {
      const entry = this.particles[i]!;
      const matches = splashLike ? entry.kind !== "droplet" : entry.kind === "droplet";
      if (!matches) continue;
      this.removeParticle(i);
      i -= 1;
      overflow -= 1;
    }
  }

  private pruneToCaps(): void {
    this.ensureCapacity("sheet", 0);
    this.ensureCapacity("droplet", 0);
  }

  private countKind(kind: SplashParticleKind): number {
    let count = 0;
    for (const particle of this.particles) {
      if (particle.kind === kind) count += 1;
    }
    return count;
  }

  private removeParticle(index: number): void {
    const particle = this.particles[index];
    if (!particle) return;
    this.group.remove(particle.mesh);
    this.particles.splice(index, 1);
  }

  private collectBuildingColliders(): void {
    const buildings = this.root.getObjectByName("buildings");
    if (!buildings) return;

    const bbox = new THREE.Box3();
    const size = new THREE.Vector3();

    buildings.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh)) return;
      bbox.setFromObject(obj);
      if (!Number.isFinite(bbox.min.x) || !Number.isFinite(bbox.max.x)) return;
      bbox.getSize(size);
      if (size.x < 0.35 || size.y < 0.35 || size.z < 0.35) return;

      const idx = this.buildingColliders.length;
      const collider = bbox.clone();
      this.buildingColliders.push(collider);
      this.insertColliderIntoBuckets(idx, collider);
    });
  }

  private insertColliderIntoBuckets(index: number, bbox: THREE.Box3): void {
    const iMin = Math.floor(bbox.min.x / this.collisionBucketSize);
    const iMax = Math.floor(bbox.max.x / this.collisionBucketSize);
    const jMin = Math.floor(bbox.min.z / this.collisionBucketSize);
    const jMax = Math.floor(bbox.max.z / this.collisionBucketSize);
    for (let j = jMin; j <= jMax; j++) {
      for (let i = iMin; i <= iMax; i++) {
        const key = this.bucketKey(i, j);
        let bucket = this.buildingBuckets.get(key);
        if (!bucket) {
          bucket = [];
          this.buildingBuckets.set(key, bucket);
        }
        bucket.push(index);
      }
    }
  }

  private resolveBuildingCollision(particle: SplashParticle): boolean {
    if (this.buildingColliders.length === 0) return false;

    const pos = particle.mesh.position;
    const radius = Math.max(0.02, particle.radius);
    const iMin = Math.floor((pos.x - radius) / this.collisionBucketSize);
    const iMax = Math.floor((pos.x + radius) / this.collisionBucketSize);
    const jMin = Math.floor((pos.z - radius) / this.collisionBucketSize);
    const jMax = Math.floor((pos.z + radius) / this.collisionBucketSize);

    this.tmpColliderIndices.clear();
    for (let j = jMin; j <= jMax; j++) {
      for (let i = iMin; i <= iMax; i++) {
        const bucket = this.buildingBuckets.get(this.bucketKey(i, j));
        if (!bucket) continue;
        for (const idx of bucket) this.tmpColliderIndices.add(idx);
      }
    }

    for (const idx of this.tmpColliderIndices) {
      const bbox = this.buildingColliders[idx]!;
      if (
        pos.x < bbox.min.x - radius ||
        pos.x > bbox.max.x + radius ||
        pos.y < bbox.min.y - radius ||
        pos.y > bbox.max.y + radius ||
        pos.z < bbox.min.z - radius ||
        pos.z > bbox.max.z + radius
      ) {
        continue;
      }

      const nx = THREE.MathUtils.clamp(pos.x, bbox.min.x, bbox.max.x);
      const ny = THREE.MathUtils.clamp(pos.y, bbox.min.y, bbox.max.y);
      const nz = THREE.MathUtils.clamp(pos.z, bbox.min.z, bbox.max.z);

      this.tmpCollisionNormal.set(pos.x - nx, pos.y - ny, pos.z - nz);
      const distSq = this.tmpCollisionNormal.lengthSq();
      if (distSq > radius * radius) continue;

      let dist = Math.sqrt(Math.max(1e-8, distSq));
      if (dist < 1e-5) {
        this.tmpCollisionNormal.set(0, 1, 0);
        dist = 1e-4;
      } else {
        this.tmpCollisionNormal.multiplyScalar(1 / dist);
      }

      const penetration = radius - dist;
      if (penetration > 0) {
        pos.addScaledVector(this.tmpCollisionNormal, penetration + 1e-3);
      }

      const vn = particle.velocity.dot(this.tmpCollisionNormal);
      if (vn < 0) {
        const restitutionBase = clamp(this.params.restitutionBuilding, 0, 0.95);
        const restitution =
          particle.kind === "droplet"
            ? restitutionBase * 1.08
            : particle.kind === "sheet"
              ? restitutionBase * 0.72
              : restitutionBase * 0.86;
        particle.velocity.addScaledVector(this.tmpCollisionNormal, -(1 + restitution) * vn);
        particle.velocity.multiplyScalar(
          particle.kind === "droplet" ? 0.84 : particle.kind === "sheet" ? 0.68 : 0.75
        );
      }
      return true;
    }

    return false;
  }

  private bucketKey(i: number, j: number): string {
    return `${i}:${j}`;
  }
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value | 0));
}
