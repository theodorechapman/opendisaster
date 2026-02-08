import * as THREE from "three";
import type { ShallowWaterSolver } from "./ShallowWaterSolver.ts";
import type { FloodWaterSurface } from "./FloodWaterSurface.ts";

type UprootKind = "small";

type TreeTarget = {
  trunk: THREE.Mesh;
  canopy?: THREE.Mesh;
  uprooted: boolean;
  depthThreshold: number;
  forceThreshold: number;
  trunkRadius: number;
  height: number;
  submergedTime: number;
  damage: number;
};

type UprootTarget = {
  mesh: THREE.Mesh;
  kind: UprootKind;
  uprooted: boolean;
  depthThreshold: number;
  speedThreshold: number;
};

type SmallBuildingTarget = {
  mesh: THREE.Mesh;
  uprooted: boolean;
  bbox: THREE.Box3;
  samplePoints: THREE.Vector3[];
  depthThreshold: number;
  speedThreshold: number;
  forceThreshold: number;
  submergedTime: number;
  damage: number;
  initialPosition: THREE.Vector3;
  initialQuaternion: THREE.Quaternion;
  initialScale: THREE.Vector3;
};

type CrushTarget = {
  mesh: THREE.Mesh;
  crushed: boolean;
  bbox: THREE.Box3;
  samplePoints: THREE.Vector3[];
  crushDepth: number;
  crushSpeed: number;
};

type DebrisBodyKind = "tree" | "small" | "fragment" | "building";

type DebrisBody = {
  object: THREE.Object3D;
  kind: DebrisBodyKind;
  velocity: THREE.Vector3;
  angularVelocity: THREE.Vector3;
  buoyancy: number;
  drag: number;
  angularDrag: number;
  floatOffset: number;
  ttl: number;
  characteristicHeight: number;
  crossSection: number;
  wasInWater: boolean;
  impactCooldown: number;
  disposableGeometries: THREE.BufferGeometry[];
  disposableMaterials: THREE.Material[];
};

const WORLD_UP = new THREE.Vector3(0, 1, 0);
const SMALL_BUILDING_VOLUME_THRESHOLD = 1600;

export class FloodEnvironmentEffectsRealistic {
  private readonly root: THREE.Group;
  private readonly solver: ShallowWaterSolver;
  private readonly surface: FloodWaterSurface;
  private readonly debrisGroup: THREE.Group;

  private readonly treeTargets: TreeTarget[] = [];
  private readonly uprootTargets: UprootTarget[] = [];
  private readonly smallBuildingTargets: SmallBuildingTarget[] = [];
  private readonly crushTargets: CrushTarget[] = [];
  private readonly debrisBodies: DebrisBody[] = [];

  private checkTimer = 0;
  private wallImpactTimer = 0;

  private readonly tmpBox = new THREE.Box3();
  private readonly tmpSize = new THREE.Vector3();
  private readonly tmpPos = new THREE.Vector3();
  private readonly tmpVecA = new THREE.Vector3();
  private readonly tmpVecB = new THREE.Vector3();
  private readonly tmpVecC = new THREE.Vector3();
  private readonly tmpQuat = new THREE.Quaternion();
  private readonly tmpMat = new THREE.Matrix4();

  constructor(root: THREE.Group, solver: ShallowWaterSolver, surface: FloodWaterSurface) {
    this.root = root;
    this.solver = solver;
    this.surface = surface;

    this.debrisGroup = new THREE.Group();
    this.debrisGroup.name = "flood-debris";
    this.root.add(this.debrisGroup);

    this.collectTreeTargets();
    this.collectSmallUprootTargets();
    // Buildings remain static and unaffected by flood impacts.
  }

  update(simDt: number): void {
    this.checkTimer += simDt;
    if (this.checkTimer >= 0.08) {
      this.checkTimer = 0;
      this.evaluateTreeTargets();
      this.evaluateSmallUprootTargets();
    }

    this.emitWallImpacts(simDt);
    this.updateDebrisBodies(simDt);
  }

  reset(): void {
    for (const target of this.treeTargets) {
      target.uprooted = false;
      target.submergedTime = 0;
      target.damage = 0;
      target.trunk.visible = true;
      if (target.canopy) target.canopy.visible = true;
    }
    for (const target of this.uprootTargets) {
      target.uprooted = false;
      target.mesh.visible = true;
    }
    for (const target of this.smallBuildingTargets) {
      target.uprooted = false;
      target.submergedTime = 0;
      target.damage = 0;
      target.mesh.position.copy(target.initialPosition);
      target.mesh.quaternion.copy(target.initialQuaternion);
      target.mesh.scale.copy(target.initialScale);
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

  private collectTreeTargets(): void {
    const trees = this.root.getObjectByName("trees");
    if (!trees) return;

    type TreeCandidate = {
      mesh: THREE.Mesh;
      center: THREE.Vector3;
      size: THREE.Vector3;
    };

    const trunkCandidates: TreeCandidate[] = [];
    const canopyCandidates: TreeCandidate[] = [];
    const allCandidates: TreeCandidate[] = [];

    trees.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh)) return;
      this.tmpBox.setFromObject(obj);
      if (!Number.isFinite(this.tmpBox.min.x) || !Number.isFinite(this.tmpBox.max.x)) return;

      const size = this.tmpBox.getSize(new THREE.Vector3());
      const center = this.tmpBox.getCenter(new THREE.Vector3());
      allCandidates.push({ mesh: obj, center, size });
      const horizontalSize = Math.max(size.x, size.z);
      const slenderness = size.y / Math.max(0.001, horizontalSize);

      if (slenderness >= 2.2 && size.y >= 1.5) {
        trunkCandidates.push({ mesh: obj, center, size });
      } else {
        canopyCandidates.push({ mesh: obj, center, size });
      }
    });

    const usedCanopies = new Set<THREE.Mesh>();
    const claimedMeshes = new Set<THREE.Mesh>();

    for (const trunk of trunkCandidates) {
      let bestCanopy: TreeCandidate | undefined;
      let bestScore = Number.POSITIVE_INFINITY;

      for (const canopy of canopyCandidates) {
        if (usedCanopies.has(canopy.mesh)) continue;

        const dx = canopy.center.x - trunk.center.x;
        const dz = canopy.center.z - trunk.center.z;
        const dy = canopy.center.y - trunk.center.y;
        const horizontalDist2 = dx * dx + dz * dz;
        const maxHorizontal = Math.max(2.4, trunk.size.y * 0.95);
        if (horizontalDist2 > maxHorizontal * maxHorizontal) continue;
        if (dy < trunk.size.y * 0.12 || dy > trunk.size.y * 2.8) continue;

        const score = horizontalDist2 + Math.abs(dy - trunk.size.y * 1.25) * 0.35;
        if (score < bestScore) {
          bestScore = score;
          bestCanopy = canopy;
        }
      }

      if (bestCanopy) {
        usedCanopies.add(bestCanopy.mesh);
        claimedMeshes.add(bestCanopy.mesh);
      }
      claimedMeshes.add(trunk.mesh);

      const trunkRadius = Math.max(0.18, Math.min(1.1, Math.max(trunk.size.x, trunk.size.z) * 0.5));
      const canopyHeight = bestCanopy?.size.y ?? 0;
      const totalHeight = Math.max(2.2, trunk.size.y + canopyHeight * 0.55);
      const depthThreshold = Math.max(0.20, Math.min(0.68, 0.16 + trunkRadius * 0.42));
      const forceThreshold = Math.max(0.18, Math.min(0.90, 0.14 + trunkRadius * 0.46));

      this.treeTargets.push({
        trunk: trunk.mesh,
        canopy: bestCanopy?.mesh,
        uprooted: false,
        depthThreshold,
        forceThreshold,
        trunkRadius,
        height: totalHeight,
        submergedTime: 0,
        damage: 0,
      });
    }

    // Fallback path for places where trees are represented differently:
    // any unmatched mesh in `trees` still becomes uprootable.
    for (const candidate of allCandidates) {
      if (claimedMeshes.has(candidate.mesh)) continue;
      const fallbackRadius = Math.max(
        0.16,
        Math.min(1.25, Math.max(candidate.size.x, candidate.size.z) * 0.5)
      );
      this.treeTargets.push({
        trunk: candidate.mesh,
        canopy: undefined,
        uprooted: false,
        depthThreshold: Math.max(0.18, Math.min(0.72, 0.14 + fallbackRadius * 0.40)),
        forceThreshold: Math.max(0.16, Math.min(0.95, 0.12 + fallbackRadius * 0.46)),
        trunkRadius: fallbackRadius,
        height: Math.max(1.2, candidate.size.y),
        submergedTime: 0,
        damage: 0,
      });
    }
  }

  private collectSmallUprootTargets(): void {
    const barriers = this.root.getObjectByName("barriers");
    if (!barriers) return;

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

  private collectSmallBuildingTargets(): void {
    const buildings = this.root.getObjectByName("buildings");
    if (!buildings) return;

    const bbox = new THREE.Box3();
    const size = new THREE.Vector3();
    buildings.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh)) return;
      bbox.setFromObject(obj);
      if (!Number.isFinite(bbox.min.x) || !Number.isFinite(bbox.max.x)) return;
      bbox.getSize(size);

      const volume = size.x * size.y * size.z;
      if (volume <= 0 || volume > SMALL_BUILDING_VOLUME_THRESHOLD) return;

      const cx = (bbox.min.x + bbox.max.x) * 0.5;
      const cz = (bbox.min.z + bbox.max.z) * 0.5;
      const sx = Math.max(0.8, size.x * 0.42 + 0.25);
      const sz = Math.max(0.8, size.z * 0.42 + 0.25);
      const samplePoints = [
        new THREE.Vector3(cx, 0, cz),
        new THREE.Vector3(cx + sx, 0, cz),
        new THREE.Vector3(cx - sx, 0, cz),
        new THREE.Vector3(cx, 0, cz + sz),
        new THREE.Vector3(cx, 0, cz - sz),
      ];

      const scale = Math.cbrt(volume);
      this.smallBuildingTargets.push({
        mesh: obj,
        uprooted: false,
        bbox: bbox.clone(),
        samplePoints,
        depthThreshold: Math.max(0.22, Math.min(1.20, 0.18 + scale * 0.14)),
        speedThreshold: Math.max(0.22, Math.min(1.20, 0.20 + scale * 0.06)),
        forceThreshold: Math.max(0.24, Math.min(1.90, 0.18 + scale * 0.45)),
        submergedTime: 0,
        damage: 0,
        initialPosition: obj.position.clone(),
        initialQuaternion: obj.quaternion.clone(),
        initialScale: obj.scale.clone(),
      });
    });
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

  private evaluateTreeTargets(): void {
    const evalDt = 0.08;
    for (const target of this.treeTargets) {
      if (target.uprooted || !target.trunk.visible) continue;

      target.trunk.getWorldPosition(this.tmpPos);
      const state = this.solver.sampleStateAtWorld(this.tmpPos.x, this.tmpPos.z, true, 3);
      if (state.obstacle) continue;

      const speed = Math.hypot(state.u, state.v);
      const hydrodynamicForce = state.depth * speed * speed;
      const momentumLoad = state.depth * speed;
      const wet = state.depth > 0.08;

      if (wet) {
        target.submergedTime = Math.min(12, target.submergedTime + evalDt);
      } else {
        target.submergedTime = Math.max(0, target.submergedTime - evalDt * 1.6);
      }

      const damageDecay = wet ? 0.965 : 0.90;
      target.damage =
        target.damage * damageDecay +
        hydrodynamicForce * 0.22 +
        momentumLoad * 0.12 +
        (wet ? 0.035 : 0);

      const depthTrigger = state.depth >= target.depthThreshold;
      const forceTrigger = hydrodynamicForce >= target.forceThreshold;
      const depthSpeedTrigger = depthTrigger && speed >= 0.22;
      const sustainedTrigger =
        target.submergedTime >= 1.2 && state.depth >= target.depthThreshold * 0.65;
      const damageTrigger = target.damage >= target.forceThreshold * 1.65;
      const extremeDepthTrigger = state.depth >= Math.max(1.25, target.depthThreshold * 2.0);

      if (
        !(
          forceTrigger ||
          depthSpeedTrigger ||
          sustainedTrigger ||
          damageTrigger ||
          extremeDepthTrigger
        )
      ) {
        continue;
      }

      target.uprooted = true;
      this.spawnUprootedTree(target, state, speed);

      this.surface.addImpactAtWorld(this.tmpPos.x, this.tmpPos.z, 1.1 + speed * 0.30, 5.6);
      this.solver.injectMomentumImpulse(this.tmpPos.x, this.tmpPos.z, state.u * 0.28, state.v * 0.28, 4.0, 0.6);
    }
  }

  private evaluateSmallUprootTargets(): void {
    for (const target of this.uprootTargets) {
      if (target.uprooted || !target.mesh.visible) continue;

      target.mesh.getWorldPosition(this.tmpPos);
      const state = this.solver.sampleStateAtWorld(this.tmpPos.x, this.tmpPos.z, true, 3);
      if (state.obstacle) continue;

      const speed = Math.hypot(state.u, state.v);
      if (state.depth < target.depthThreshold || speed < target.speedThreshold) continue;

      target.uprooted = true;
      this.spawnSmallDebris(target.mesh, state, speed);

      this.surface.addImpactAtWorld(this.tmpPos.x, this.tmpPos.z, 0.9 + speed * 0.25, 4.2);
      this.solver.injectMomentumImpulse(this.tmpPos.x, this.tmpPos.z, state.u * 0.24, state.v * 0.24, 3.4, 0.5);
    }
  }

  private evaluateSmallBuildingTargets(): void {
    const evalDt = 0.08;
    for (const target of this.smallBuildingTargets) {
      if (target.uprooted || !target.mesh.visible) continue;

      let peakDepth = 0;
      let peakSpeed = 0;
      let peakU = 0;
      let peakV = 0;
      for (const sample of target.samplePoints) {
        const state = this.solver.sampleStateAtWorld(sample.x, sample.z, true, 4);
        if (state.obstacle) continue;
        const speed = Math.hypot(state.u, state.v);
        if (state.depth > peakDepth) peakDepth = state.depth;
        if (speed > peakSpeed) {
          peakSpeed = speed;
          peakU = state.u;
          peakV = state.v;
        }
      }

      const hydroForce = peakDepth * peakSpeed * peakSpeed;
      const momentumLoad = peakDepth * peakSpeed;
      const wet = peakDepth > 0.08;

      if (wet) {
        target.submergedTime = Math.min(14, target.submergedTime + evalDt);
      } else {
        target.submergedTime = Math.max(0, target.submergedTime - evalDt * 1.5);
      }

      const damageDecay = wet ? 0.968 : 0.90;
      target.damage =
        target.damage * damageDecay +
        hydroForce * 0.20 +
        momentumLoad * 0.11 +
        (wet ? 0.03 : 0);

      const depthTrigger = peakDepth >= target.depthThreshold;
      const forceTrigger = hydroForce >= target.forceThreshold;
      const depthSpeedTrigger = depthTrigger && peakSpeed >= target.speedThreshold;
      const sustainedTrigger =
        target.submergedTime >= 1.35 && peakDepth >= target.depthThreshold * 0.68;
      const damageTrigger = target.damage >= target.forceThreshold * 1.65;
      const extremeDepthTrigger = peakDepth >= Math.max(1.35, target.depthThreshold * 2.2);

      if (
        !(
          forceTrigger ||
          depthSpeedTrigger ||
          sustainedTrigger ||
          damageTrigger ||
          extremeDepthTrigger
        )
      ) {
        continue;
      }

      target.uprooted = true;
      this.solver.clearObstaclesInAabb(
        target.bbox.min.x - 0.7,
        target.bbox.max.x + 0.7,
        target.bbox.min.z - 0.7,
        target.bbox.max.z + 0.7
      );
      this.spawnSmallBuildingDebris(target, peakU, peakV, peakDepth, peakSpeed);

      const centerX = (target.bbox.min.x + target.bbox.max.x) * 0.5;
      const centerZ = (target.bbox.min.z + target.bbox.max.z) * 0.5;
      this.surface.addImpactAtWorld(centerX, centerZ, 1.2 + peakSpeed * 0.27, 6.8);
      this.solver.injectMomentumImpulse(centerX, centerZ, peakU * 0.3, peakV * 0.3, 4.6, 0.65);
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
      this.surface.addImpactAtWorld(centerX, centerZ, 1.9 + peakSpeed * 0.34, 8.0);
      this.solver.injectMomentumImpulse(centerX, centerZ, peakU * 0.5, peakV * 0.5, 6.5, 0.9);
    }
  }

  private spawnUprootedTree(
    target: TreeTarget,
    state: ReturnType<ShallowWaterSolver["sampleStateAtWorld"]>,
    speed: number
  ): void {
    target.trunk.getWorldPosition(this.tmpPos);
    this.tmpBox.setFromObject(target.trunk);
    const baseY = this.tmpBox.min.y + target.trunkRadius * 0.32;

    const treeBody = new THREE.Group();
    treeBody.name = "uprooted-tree";
    treeBody.position.set(this.tmpPos.x, baseY, this.tmpPos.z);
    this.debrisGroup.add(treeBody);

    const trunkClone = this.cloneMeshIntoParent(target.trunk, treeBody);
    trunkClone.castShadow = true;
    trunkClone.receiveShadow = true;

    if (target.canopy) {
      const canopyClone = this.cloneMeshIntoParent(target.canopy, treeBody);
      canopyClone.castShadow = true;
      canopyClone.receiveShadow = true;
    }

    const rootBallGeo = new THREE.IcosahedronGeometry(target.trunkRadius * 1.35, 0);
    const rootBallMat = new THREE.MeshPhongMaterial({ color: 0x4b3522, flatShading: true });
    const rootBall = new THREE.Mesh(rootBallGeo, rootBallMat);
    rootBall.castShadow = true;
    rootBall.receiveShadow = true;
    rootBall.position.set(0, target.trunkRadius * 0.28, 0);
    treeBody.add(rootBall);

    target.trunk.visible = false;
    if (target.canopy) target.canopy.visible = false;

    this.tmpVecA.set(state.u, 0, state.v);
    let flowSpeed = this.tmpVecA.length();
    if (flowSpeed < 1e-4) {
      this.tmpVecA.set(Math.random() - 0.5, 0, Math.random() - 0.5);
      flowSpeed = this.tmpVecA.length();
    }
    if (flowSpeed > 1e-6) this.tmpVecA.multiplyScalar(1 / flowSpeed);

    const launch = 0.65 + speed * 0.55;
    const velocity = new THREE.Vector3(
      this.tmpVecA.x * launch,
      0.35 + Math.min(0.7, speed * 0.16),
      this.tmpVecA.z * launch
    );

    this.debrisBodies.push({
      object: treeBody,
      kind: "tree",
      velocity,
      angularVelocity: new THREE.Vector3(
        (Math.random() - 0.5) * 0.6,
        (Math.random() - 0.5) * 1.2,
        (Math.random() - 0.5) * 0.6
      ),
      buoyancy: 5.8,
      drag: 2.9,
      angularDrag: 1.05,
      floatOffset: 0.18,
      ttl: Number.POSITIVE_INFINITY,
      characteristicHeight: Math.max(2.5, target.height),
      crossSection: Math.max(0.35, target.trunkRadius * 2),
      wasInWater: state.depth > 0.03,
      impactCooldown: 0,
      disposableGeometries: [rootBallGeo],
      disposableMaterials: [rootBallMat],
    });
  }

  private spawnSmallDebris(
    sourceMesh: THREE.Mesh,
    state: ReturnType<ShallowWaterSolver["sampleStateAtWorld"]>,
    speed: number
  ): void {
    this.tmpBox.setFromObject(sourceMesh);
    this.tmpBox.getSize(this.tmpSize);

    const debris = sourceMesh;
    debris.visible = true;
    debris.castShadow = true;
    debris.receiveShadow = true;

    const baseSize = Math.max(this.tmpSize.x, this.tmpSize.y, this.tmpSize.z, 0.2);
    this.debrisBodies.push({
      object: debris,
      kind: "small",
      velocity: new THREE.Vector3(
        state.u * 1.1,
        0.45 + Math.random() * 0.3,
        state.v * 1.1
      ),
      angularVelocity: new THREE.Vector3(
        (Math.random() - 0.5) * 4.0,
        (Math.random() - 0.5) * 4.0,
        (Math.random() - 0.5) * 4.0
      ),
      buoyancy: 3.1,
      drag: 2.5,
      angularDrag: 0.88,
      floatOffset: 0.18,
      ttl: Number.POSITIVE_INFINITY,
      characteristicHeight: Math.max(0.3, this.tmpSize.y),
      crossSection: baseSize,
      wasInWater: state.depth > 0.03,
      impactCooldown: 0,
      disposableGeometries: [],
      disposableMaterials: [],
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

    const materials = Array.isArray(target.mesh.material)
      ? target.mesh.material
      : [target.mesh.material];
    const baseMaterial = (materials[0] ??
      new THREE.MeshPhongMaterial({ color: 0x999999 })) as THREE.Material;

    for (let i = 0; i < pieceCount; i++) {
      const sx = Math.max(0.45, Math.min(3.0, size.x * (0.08 + Math.random() * 0.14)));
      const sy = Math.max(0.35, Math.min(2.6, size.y * (0.06 + Math.random() * 0.16)));
      const sz = Math.max(0.45, Math.min(3.0, size.z * (0.08 + Math.random() * 0.14)));

      const fragGeo = new THREE.BoxGeometry(sx, sy, sz);
      const frag = new THREE.Mesh(fragGeo, baseMaterial);
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
        object: frag,
        kind: "fragment",
        velocity: new THREE.Vector3(
          along.x + lateral.x,
          0.8 + Math.random() * 1.2,
          along.z + lateral.z
        ),
        angularVelocity: new THREE.Vector3(
          (Math.random() - 0.5) * 6.5,
          (Math.random() - 0.5) * 6.5,
          (Math.random() - 0.5) * 6.5
        ),
        buoyancy: 2.3,
        drag: 2.1,
        angularDrag: 0.8,
        floatOffset: 0.12,
        ttl: 220 + speed * 30,
        characteristicHeight: Math.max(0.3, sy),
        crossSection: Math.max(sx, sz),
        wasInWater: false,
        impactCooldown: 0,
        disposableGeometries: [fragGeo],
        disposableMaterials: [],
      });
    }
  }

  private spawnSmallBuildingDebris(
    target: SmallBuildingTarget,
    u: number,
    v: number,
    depth: number,
    speed: number
  ): void {
    const debris = target.mesh;
    debris.visible = true;
    debris.castShadow = true;
    debris.receiveShadow = true;

    this.tmpBox.copy(target.bbox);
    this.tmpBox.getSize(this.tmpSize);
    const planar = Math.max(1, this.tmpSize.x, this.tmpSize.z);

    this.debrisBodies.push({
      object: debris,
      kind: "building",
      velocity: new THREE.Vector3(
        u * 0.92,
        0.10 + Math.min(0.42, depth * 0.08 + speed * 0.06),
        v * 0.92
      ),
      angularVelocity: new THREE.Vector3(0, 0, 0),
      buoyancy: 2.65,
      drag: 1.95,
      angularDrag: 1.02,
      floatOffset: Math.max(0.05, this.tmpSize.y * 0.08),
      ttl: Number.POSITIVE_INFINITY,
      characteristicHeight: Math.max(1.0, this.tmpSize.y),
      crossSection: planar,
      wasInWater: depth > 0.03,
      impactCooldown: 0,
      disposableGeometries: [],
      disposableMaterials: [],
    });
  }

  private updateDebrisBodies(simDt: number): void {
    const rm: DebrisBody[] = [];
    const boundsPad = 90;
    const xMinBound = this.solver.xMin - boundsPad;
    const xMaxBound = this.solver.xMax + boundsPad;
    const zMinBound = this.solver.zMin - boundsPad;
    const zMaxBound = this.solver.zMax + boundsPad;

    for (const body of this.debrisBodies) {
      const removable = body.kind === "fragment";
      if (removable) {
        body.ttl -= simDt;
      }
      body.impactCooldown = Math.max(0, body.impactCooldown - simDt);
      if (removable && body.ttl <= 0) {
        rm.push(body);
        continue;
      }

      const pos = body.object.position;
      const state =
        body.kind === "building"
          ? this.solver.sampleStateAtWorld(pos.x, pos.z, false, 0)
          : this.solver.sampleStateAtWorld(pos.x, pos.z, true, 3);

      if (body.kind === "tree") {
        this.integrateTreeDebris(body, state, simDt);
      } else if (body.kind === "building") {
        this.integrateBuildingDebris(body, simDt);
      } else {
        this.integrateGenericDebris(body, state, simDt);
      }

      const inWater = state.depth > 0.04 && !state.obstacle;
      if (!body.wasInWater && inWater && Math.abs(body.velocity.y) > 0.45 && body.impactCooldown <= 0) {
        const splashStrength = Math.min(3.0, 0.9 + Math.abs(body.velocity.y) * 0.6 + state.depth * 0.25);
        this.surface.addImpactAtWorld(pos.x, pos.z, splashStrength, 3.4 + Math.min(8, body.crossSection * 2.8));
        body.impactCooldown = 0.55;
      }
      body.wasInWater = inWater;

      if (pos.x < xMinBound || pos.x > xMaxBound || pos.z < zMinBound || pos.z > zMaxBound) {
        if (removable) {
          rm.push(body);
        } else {
          // Keep persistent structures in-scene: clamp to domain edge instead of removing.
          pos.x = Math.max(xMinBound, Math.min(xMaxBound, pos.x));
          pos.z = Math.max(zMinBound, Math.min(zMaxBound, pos.z));
          body.velocity.x = 0;
          body.velocity.z = 0;
        }
      }
    }

    for (const body of rm) this.removeDebrisBody(body);
  }

  private integrateTreeDebris(
    body: DebrisBody,
    state: ReturnType<ShallowWaterSolver["sampleStateAtWorld"]>,
    simDt: number
  ): void {
    const pos = body.object.position;
    const flowSpeed = Math.hypot(state.u, state.v);
    const submerged = clamp01(
      (state.depth + body.characteristicHeight * 0.08) /
        Math.max(0.8, body.characteristicHeight * 0.72)
    );

    const targetVX = state.u * (1.02 + submerged * 0.38);
    const targetVZ = state.v * (1.02 + submerged * 0.38);
    const align = Math.min(1, body.drag * (0.55 + submerged * 0.8) * simDt);
    body.velocity.x += (targetVX - body.velocity.x) * align;
    body.velocity.z += (targetVZ - body.velocity.z) * align;

    const targetY =
      state.surfaceY +
      body.floatOffset -
      (1 - submerged) * 0.16 * Math.max(1, body.characteristicHeight * 0.35);
    body.velocity.y += (targetY - pos.y) * body.buoyancy * simDt;
    body.velocity.y -= 9.81 * (1 - submerged * 0.92) * simDt;

    const turbulence = Math.min(2.0, flowSpeed * 0.22 + state.depth * 0.08);
    body.velocity.x += (Math.random() - 0.5) * turbulence * simDt;
    body.velocity.z += (Math.random() - 0.5) * turbulence * simDt;

    this.tmpVecA.set(state.u, 0.18 + 0.24 * (1 - submerged), state.v);
    if (this.tmpVecA.lengthSq() < 1e-6) {
      this.tmpVecA.copy(WORLD_UP);
    } else {
      this.tmpVecA.normalize();
    }

    this.tmpVecB.copy(WORLD_UP).applyQuaternion(body.object.quaternion).normalize();
    this.tmpVecC.crossVectors(this.tmpVecB, this.tmpVecA);
    const torqueStrength = (1.8 + flowSpeed * 0.9) * Math.max(0.25, submerged);
    body.angularVelocity.addScaledVector(this.tmpVecC, torqueStrength * simDt);
    body.angularVelocity.y += (Math.random() - 0.5) * (0.08 + flowSpeed * 0.12) * simDt;

    body.object.position.addScaledVector(body.velocity, simDt);
    this.integrateAngular(body, simDt);

    const groundY = state.terrainY + 0.05;
    if (body.object.position.y < groundY) {
      body.object.position.y = groundY;
      if (body.velocity.y < 0) body.velocity.y *= -0.12;
      body.velocity.x *= 0.92;
      body.velocity.z *= 0.92;
    }

    body.angularVelocity.multiplyScalar(Math.max(0, 1 - body.angularDrag * simDt));
  }

  private integrateGenericDebris(
    body: DebrisBody,
    state: ReturnType<ShallowWaterSolver["sampleStateAtWorld"]>,
    simDt: number
  ): void {
    const pos = body.object.position;
    const speedFlow = Math.hypot(state.u, state.v);

    if (state.depth > 0.02 && !state.obstacle) {
      const targetY =
        state.surfaceY +
        body.floatOffset +
        Math.sin(performance.now() * 0.0013 + pos.x * 0.07) * 0.06;
      body.velocity.y += (targetY - pos.y) * body.buoyancy * simDt;

      const align = Math.min(1, body.drag * simDt);
      body.velocity.x += (state.u * 1.25 - body.velocity.x) * align;
      body.velocity.z += (state.v * 1.25 - body.velocity.z) * align;

      const turbulence = Math.min(1.7, speedFlow * 0.18);
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

    body.object.position.addScaledVector(body.velocity, simDt);
    this.integrateAngular(body, simDt);
    body.angularVelocity.multiplyScalar(Math.max(0, 1 - body.angularDrag * simDt));
  }

  private integrateBuildingDebris(body: DebrisBody, simDt: number): void {
    const pos = body.object.position;
    const steps = Math.max(1, Math.min(8, Math.ceil(simDt / 0.02)));
    const stepDt = simDt / steps;

    for (let s = 0; s < steps; s++) {
      const state = this.solver.sampleStateAtWorld(pos.x, pos.z, false, 0);
      if (state.depth > 0.01 && !state.obstacle) {
        // Deterministic advection: the building follows the local shallow-water velocity field.
        body.velocity.x = state.u;
        body.velocity.z = state.v;
        pos.x += state.u * stepDt;
        pos.z += state.v * stepDt;

        const targetY = state.surfaceY + body.floatOffset;
        pos.y += (targetY - pos.y) * Math.min(1, 8.0 * stepDt);
        body.velocity.y = (targetY - pos.y) / Math.max(stepDt, 1e-6);

        const flowSpeed = Math.hypot(state.u, state.v);
        if (flowSpeed > 0.02) {
          this.tmpVecA.set(state.u, 0, state.v).normalize();
          const yaw = Math.atan2(this.tmpVecA.x, this.tmpVecA.z);
          this.tmpQuat.setFromAxisAngle(WORLD_UP, yaw);
          body.object.quaternion.slerp(this.tmpQuat, Math.min(1, 3.0 * stepDt));
        }
      } else {
        body.velocity.y -= 9.81 * stepDt;
        body.velocity.x *= Math.max(0, 1 - 2.8 * stepDt);
        body.velocity.z *= Math.max(0, 1 - 2.8 * stepDt);
        pos.addScaledVector(body.velocity, stepDt);
        const groundY = state.terrainY + 0.02;
        if (pos.y < groundY) {
          pos.y = groundY;
          if (body.velocity.y < 0) body.velocity.y = 0;
        }
      }
    }
  }

  private integrateAngular(body: DebrisBody, simDt: number): void {
    const w = body.angularVelocity.length();
    if (w < 1e-6) return;
    this.tmpVecA.copy(body.angularVelocity).multiplyScalar(1 / w);
    this.tmpQuat.setFromAxisAngle(this.tmpVecA, w * simDt);
    body.object.quaternion.premultiply(this.tmpQuat).normalize();
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
      this.surface.addImpactAtWorld(
        wp.x,
        wp.z,
        impactStrength,
        3 + Math.min(5, speed * 0.9)
      );
      this.solver.injectMomentumImpulse(
        wp.x,
        wp.z,
        (mx / Math.max(d, 1e-5)) * 0.2,
        (my / Math.max(d, 1e-5)) * 0.2,
        2.8,
        0.6
      );
    }
  }

  private cloneMeshIntoParent(source: THREE.Mesh, parent: THREE.Object3D): THREE.Mesh {
    const clone = source.clone(false) as THREE.Mesh;
    clone.geometry = source.geometry;
    clone.material = source.material;
    clone.visible = true;
    parent.add(clone);
    this.copyWorldTransformToParent(source, parent, clone);
    return clone;
  }

  private copyWorldTransformToParent(
    source: THREE.Object3D,
    parent: THREE.Object3D,
    target: THREE.Object3D
  ): void {
    this.root.updateMatrixWorld(true);
    source.updateMatrixWorld(true);
    parent.updateMatrixWorld(true);
    this.tmpMat.copy(parent.matrixWorld).invert().multiply(source.matrixWorld);
    this.tmpMat.decompose(target.position, target.quaternion, target.scale);
  }

  private clearDebris(): void {
    while (this.debrisBodies.length > 0) {
      const body = this.debrisBodies.pop()!;
      this.destroyDebrisBody(body);
    }
  }

  private removeDebrisBody(body: DebrisBody): void {
    const idx = this.debrisBodies.indexOf(body);
    if (idx >= 0) this.debrisBodies.splice(idx, 1);
    this.destroyDebrisBody(body);
  }

  private destroyDebrisBody(body: DebrisBody): void {
    this.debrisGroup.remove(body.object);
    for (const geo of body.disposableGeometries) geo.dispose();
    for (const mat of body.disposableMaterials) mat.dispose();
  }
}

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value | 0));
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
