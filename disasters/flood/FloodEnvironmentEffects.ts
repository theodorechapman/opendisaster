import * as THREE from "three";
import type { ShallowWaterSolver } from "./ShallowWaterSolver.ts";
import type { FloodWaterSurface } from "./FloodWaterSurface.ts";

type UprootKind = "tree" | "small";

type UprootTarget = {
  mesh: THREE.Mesh;
  kind: UprootKind;
  uprooted: boolean;
  depthThreshold: number;
  speedThreshold: number;
};

type CrushTarget = {
  mesh: THREE.Mesh;
  crushed: boolean;
  bbox: THREE.Box3;
  samplePoints: THREE.Vector3[];
  crushDepth: number;
  crushSpeed: number;
};

type DebrisBody = {
  mesh: THREE.Mesh;
  velocity: THREE.Vector3;
  spin: THREE.Vector3;
  buoyancy: number;
  drag: number;
  angularDrag: number;
  floatOffset: number;
  ttl: number;
};

export class FloodEnvironmentEffects {
  private readonly root: THREE.Group;
  private readonly solver: ShallowWaterSolver;
  private readonly surface: FloodWaterSurface;
  private readonly debrisGroup: THREE.Group;

  private readonly uprootTargets: UprootTarget[] = [];
  private readonly crushTargets: CrushTarget[] = [];
  private readonly debrisBodies: DebrisBody[] = [];

  private checkTimer = 0;
  private wallImpactTimer = 0;

  constructor(root: THREE.Group, solver: ShallowWaterSolver, surface: FloodWaterSurface) {
    this.root = root;
    this.solver = solver;
    this.surface = surface;

    this.debrisGroup = new THREE.Group();
    this.debrisGroup.name = "flood-debris";
    this.root.add(this.debrisGroup);

    this.collectUprootTargets();
    this.collectCrushTargets();
  }

  update(simDt: number): void {
    this.checkTimer += simDt;
    if (this.checkTimer >= 0.08) {
      this.checkTimer = 0;
      this.evaluateUprootTargets();
      this.evaluateCrushTargets();
    }

    this.emitWallImpacts(simDt);
    this.updateDebrisBodies(simDt);
  }

  reset(): void {
    for (const target of this.uprootTargets) {
      target.uprooted = false;
      target.mesh.visible = true;
    }
    for (const target of this.crushTargets) {
      target.crushed = false;
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

  private collectUprootTargets(): void {
    const trees = this.root.getObjectByName("trees");
    if (trees) {
      trees.traverse((obj) => {
        if (!(obj instanceof THREE.Mesh)) return;
        this.uprootTargets.push({
          mesh: obj,
          kind: "tree",
          uprooted: false,
          depthThreshold: 0.9,
          speedThreshold: 1.2,
        });
      });
    }

    const barriers = this.root.getObjectByName("barriers");
    if (barriers) {
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
  }

  private collectCrushTargets(): void {
    const buildings = this.root.getObjectByName("buildings");
    if (!buildings) return;

    const bbox = new THREE.Box3();
    const size = new THREE.Vector3();
    buildings.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh)) return;
      bbox.setFromObject(obj);
      if (!Number.isFinite(bbox.min.x) || !Number.isFinite(bbox.max.x)) return;
      bbox.getSize(size);

      const footprint = size.x * size.z;
      const buildingHeight = size.y;
      if (footprint > 260 || buildingHeight > 24) return;

      const cx = (bbox.min.x + bbox.max.x) * 0.5;
      const cz = (bbox.min.z + bbox.max.z) * 0.5;
      const sx = Math.max(1, size.x * 0.5 + 1.25);
      const sz = Math.max(1, size.z * 0.5 + 1.25);
      const samplePoints = [
        new THREE.Vector3(cx + sx, 0, cz),
        new THREE.Vector3(cx - sx, 0, cz),
        new THREE.Vector3(cx, 0, cz + sz),
        new THREE.Vector3(cx, 0, cz - sz),
        new THREE.Vector3(cx + sx, 0, cz + sz),
        new THREE.Vector3(cx + sx, 0, cz - sz),
        new THREE.Vector3(cx - sx, 0, cz + sz),
        new THREE.Vector3(cx - sx, 0, cz - sz),
      ];

      this.crushTargets.push({
        mesh: obj,
        crushed: false,
        bbox: bbox.clone(),
        samplePoints,
        crushDepth: Math.max(2.5, Math.min(7, 1.8 + buildingHeight * 0.22)),
        crushSpeed: 2.1,
      });
    });
  }

  private evaluateUprootTargets(): void {
    const wp = new THREE.Vector3();
    for (const target of this.uprootTargets) {
      if (target.uprooted || !target.mesh.visible) continue;
      target.mesh.getWorldPosition(wp);
      const state = this.solver.sampleStateAtWorld(wp.x, wp.z, true, 3);
      if (state.obstacle) continue;
      const speed = Math.hypot(state.u, state.v);
      if (state.depth < target.depthThreshold || speed < target.speedThreshold) continue;

      target.uprooted = true;
      target.mesh.visible = false;
      this.spawnDebrisFromMesh(target.mesh, target.kind, state, speed);
      this.surface.addImpactAtWorld(wp.x, wp.z, 0.9 + speed * 0.25, 4.5);
      this.solver.injectMomentumImpulse(wp.x, wp.z, state.u * 0.25, state.v * 0.25, 3.5, 0.55);
    }
  }

  private evaluateCrushTargets(): void {
    for (const target of this.crushTargets) {
      if (target.crushed || !target.mesh.visible) continue;

      let peakDepth = 0;
      let peakSpeed = 0;
      let peakU = 0;
      let peakV = 0;
      for (const sample of target.samplePoints) {
        const state = this.solver.sampleStateAtWorld(sample.x, sample.z, true, 3);
        if (state.obstacle) continue;
        const speed = Math.hypot(state.u, state.v);
        if (state.depth > peakDepth) peakDepth = state.depth;
        if (speed > peakSpeed) {
          peakSpeed = speed;
          peakU = state.u;
          peakV = state.v;
        }
      }

      if (peakDepth < target.crushDepth || peakSpeed < target.crushSpeed) continue;

      target.crushed = true;
      target.mesh.visible = false;
      this.solver.clearObstaclesInAabb(
        target.bbox.min.x - 0.8,
        target.bbox.max.x + 0.8,
        target.bbox.min.z - 0.8,
        target.bbox.max.z + 0.8
      );

      this.spawnBuildingFragments(target, peakU, peakV, peakSpeed);

      const centerX = (target.bbox.min.x + target.bbox.max.x) * 0.5;
      const centerZ = (target.bbox.min.z + target.bbox.max.z) * 0.5;
      this.surface.addImpactAtWorld(centerX, centerZ, 1.8 + peakSpeed * 0.35, 8.0);
      this.solver.injectMomentumImpulse(centerX, centerZ, peakU * 0.5, peakV * 0.5, 6.5, 0.9);
    }
  }

  private spawnDebrisFromMesh(
    sourceMesh: THREE.Mesh,
    kind: UprootKind,
    state: ReturnType<ShallowWaterSolver["sampleStateAtWorld"]>,
    speed: number
  ): void {
    const debris = sourceMesh.clone(false) as THREE.Mesh;
    debris.geometry = sourceMesh.geometry;
    debris.material = sourceMesh.material;
    this.copyWorldTransformToRoot(sourceMesh, debris);
    debris.castShadow = true;
    debris.receiveShadow = true;
    this.debrisGroup.add(debris);

    const boost = kind === "tree" ? 1.2 : 0.8;
    const upward = kind === "tree" ? 0.9 : 0.45;
    this.debrisBodies.push({
      mesh: debris,
      velocity: new THREE.Vector3(
        state.u * (1.05 + boost * 0.15),
        upward + Math.random() * 0.35,
        state.v * (1.05 + boost * 0.15)
      ),
      spin: new THREE.Vector3(
        (Math.random() - 0.5) * 3.5,
        (Math.random() - 0.5) * 3.5,
        (Math.random() - 0.5) * 3.5
      ),
      buoyancy: kind === "tree" ? 4.5 : 3.1,
      drag: kind === "tree" ? 3.0 : 2.4,
      angularDrag: 0.85,
      floatOffset: kind === "tree" ? 0.55 : 0.22,
      ttl: 180 + speed * 25,
    });
  }

  private spawnBuildingFragments(target: CrushTarget, u: number, v: number, speed: number): void {
    const size = new THREE.Vector3();
    target.bbox.getSize(size);
    const footprint = Math.max(1, size.x * size.z);
    const pieceCount = clampInt(Math.round(6 + footprint * 0.04), 6, 26);
    const flowDir = new THREE.Vector3(u, 0, v);
    if (flowDir.lengthSq() < 1e-6) {
      flowDir.set(Math.random() - 0.5, 0, Math.random() - 0.5);
    }
    flowDir.normalize();

    const materials = Array.isArray(target.mesh.material) ? target.mesh.material : [target.mesh.material];
    const baseMaterial = (materials[0] ?? new THREE.MeshPhongMaterial({ color: 0x999999 })) as THREE.Material;

    for (let i = 0; i < pieceCount; i++) {
      const sx = Math.max(0.45, Math.min(3.0, size.x * (0.08 + Math.random() * 0.14)));
      const sy = Math.max(0.35, Math.min(2.6, size.y * (0.06 + Math.random() * 0.16)));
      const sz = Math.max(0.45, Math.min(3.0, size.z * (0.08 + Math.random() * 0.14)));
      const frag = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), baseMaterial);
      frag.castShadow = true;
      frag.receiveShadow = true;
      frag.position.set(
        THREE.MathUtils.lerp(target.bbox.min.x, target.bbox.max.x, Math.random()),
        THREE.MathUtils.lerp(target.bbox.min.y, target.bbox.max.y, Math.random()),
        THREE.MathUtils.lerp(target.bbox.min.z, target.bbox.max.z, Math.random())
      );
      frag.rotation.set(
        Math.random() * Math.PI,
        Math.random() * Math.PI,
        Math.random() * Math.PI
      );
      this.debrisGroup.add(frag);

      const side = new THREE.Vector3(Math.random() - 0.5, 0, Math.random() - 0.5).normalize();
      const along = flowDir.clone().multiplyScalar(1.2 + Math.random() * (1.2 + speed * 0.35));
      const lateral = side.multiplyScalar(0.5 + Math.random() * 1.2);
      this.debrisBodies.push({
        mesh: frag,
        velocity: new THREE.Vector3(
          along.x + lateral.x,
          0.8 + Math.random() * 1.2,
          along.z + lateral.z
        ),
        spin: new THREE.Vector3(
          (Math.random() - 0.5) * 6.5,
          (Math.random() - 0.5) * 6.5,
          (Math.random() - 0.5) * 6.5
        ),
        buoyancy: 2.4,
        drag: 2.0,
        angularDrag: 0.78,
        floatOffset: 0.18,
        ttl: 220 + speed * 30,
      });
    }
  }

  private updateDebrisBodies(simDt: number): void {
    const rm: DebrisBody[] = [];
    const boundsPad = 80;

    for (const body of this.debrisBodies) {
      body.ttl -= simDt;
      if (body.ttl <= 0) {
        rm.push(body);
        continue;
      }

      const pos = body.mesh.position;
      const state = this.solver.sampleStateAtWorld(pos.x, pos.z, true, 3);
      const speedFlow = Math.hypot(state.u, state.v);

      if (state.depth > 0.02 && !state.obstacle) {
        const targetY = state.surfaceY + body.floatOffset + Math.sin(performance.now() * 0.0013 + pos.x * 0.07) * 0.06;
        body.velocity.y += (targetY - pos.y) * body.buoyancy * simDt;
        const align = Math.min(1, body.drag * simDt);
        body.velocity.x += (state.u * 1.25 - body.velocity.x) * align;
        body.velocity.z += (state.v * 1.25 - body.velocity.z) * align;
        const turbulence = Math.min(1.5, speedFlow * 0.16);
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

      pos.addScaledVector(body.velocity, simDt);
      body.mesh.rotation.x += body.spin.x * simDt;
      body.mesh.rotation.y += body.spin.y * simDt;
      body.mesh.rotation.z += body.spin.z * simDt;
      body.spin.multiplyScalar(Math.max(0, 1 - body.angularDrag * simDt));

      if (
        pos.x < this.solver.xMin - boundsPad ||
        pos.x > this.solver.xMax + boundsPad ||
        pos.z < this.solver.zMin - boundsPad ||
        pos.z > this.solver.zMax + boundsPad
      ) {
        rm.push(body);
      }
    }

    for (const body of rm) this.removeDebrisBody(body);
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
      this.surface.addImpactAtWorld(wp.x, wp.z, impactStrength, 3 + Math.min(5, speed * 0.9));
      this.solver.injectMomentumImpulse(wp.x, wp.z, (mx / Math.max(d, 1e-5)) * 0.2, (my / Math.max(d, 1e-5)) * 0.2, 2.8, 0.6);
    }
  }

  private copyWorldTransformToRoot(source: THREE.Mesh, dest: THREE.Mesh): void {
    this.root.updateMatrixWorld(true);
    source.updateMatrixWorld(true);
    const local = new THREE.Matrix4()
      .copy(this.root.matrixWorld)
      .invert()
      .multiply(source.matrixWorld);
    local.decompose(dest.position, dest.quaternion, dest.scale);
  }

  private clearDebris(): void {
    for (const body of this.debrisBodies) {
      this.debrisGroup.remove(body.mesh);
      if (body.mesh.geometry && body.mesh.geometry instanceof THREE.BufferGeometry) {
        if (body.mesh.geometry.type === "BoxGeometry") body.mesh.geometry.dispose();
      }
    }
    this.debrisBodies.length = 0;
  }

  private removeDebrisBody(body: DebrisBody): void {
    const idx = this.debrisBodies.indexOf(body);
    if (idx >= 0) this.debrisBodies.splice(idx, 1);
    this.debrisGroup.remove(body.mesh);
    if (body.mesh.geometry && body.mesh.geometry instanceof THREE.BufferGeometry) {
      if (body.mesh.geometry.type === "BoxGeometry") body.mesh.geometry.dispose();
    }
  }
}

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value | 0));
}
