import * as THREE from "three";
import {
  createHydroState,
  type DestroyableTarget,
  type StructureFragilityParams,
  type TsunamiImpactEvent,
  type TsunamiParams,
} from "./TsunamiTypes.ts";
import { TerrainHeightSampler } from "./TerrainHeightSampler.ts";
import { TsunamiWaveField } from "./TsunamiWaveField.ts";

type DebrisDensityClass = "light" | "heavy";

type DebrisBody = {
  mesh: THREE.Mesh;
  velocity: THREE.Vector3;
  angularVelocity: THREE.Vector3;
  ttl: number;
  floatOffset: number;
  minGroundClearance: number;
  radius: number;
  mass: number;
  volume: number;
  area: number;
  densityClass: DebrisDensityClass;
  groundedTime: number;
  impactCooldown: number;
  ownsGeometry: boolean;
  ownsMaterial: boolean;
  wasInWater: boolean;
};

export interface TsunamiDestructionHooks {
  onImpact?: (event: TsunamiImpactEvent) => void;
  onWaterImpulse?: (
    x: number,
    z: number,
    vx: number,
    vz: number,
    radiusMeters: number,
    strength: number
  ) => void;
}

export class TsunamiDestructionSystem {
  private readonly targets: DestroyableTarget[] = [];
  private readonly buildingAreasSorted: number[] = [];
  private readonly debrisGroup = new THREE.Group();
  private readonly debrisBodies: DebrisBody[] = [];
  private readonly hydroScratch = createHydroState();
  private readonly impactHydroScratch = createHydroState();
  private readonly tmpVecA = new THREE.Vector3();
  private readonly tmpVecB = new THREE.Vector3();
  private readonly tmpVecC = new THREE.Vector3();
  private readonly tmpVecD = new THREE.Vector3();
  private readonly sweepNormal = new THREE.Vector3();
  private readonly sweepPoint = new THREE.Vector3();
  private readonly checkInterval = 0.05;
  private readonly maxDebrisPairChecks = 640;
  private readonly gravity = 9.81;
  private destroyCheckTimer = 0;
  private destroyedCount = 0;
  private entrainedCount = 0;
  private strandedCount = 0;
  private peakDepth = 0;
  private peakSpeed = 0;
  private peakPressure = 0;
  private peakHydroForce = 0;
  private peakImpactImpulse = 0;

  constructor(
    private readonly root: THREE.Group,
    private readonly terrainSampler: TerrainHeightSampler,
    private readonly waveField: TsunamiWaveField,
    private readonly params: TsunamiParams,
    private readonly hooks: TsunamiDestructionHooks = {}
  ) {
    this.debrisGroup.name = "tsunami-debris";
    this.root.add(this.debrisGroup);
    this.collectTargets();
  }

  update(dt: number): void {
    this.destroyCheckTimer += dt;
    while (this.destroyCheckTimer > this.checkInterval) {
      this.destroyCheckTimer -= this.checkInterval;
      this.evaluateDestruction(this.checkInterval);
    }

    this.updateDebris(dt);
  }

  reset(): void {
    for (const target of this.targets) {
      target.destroyed = false;
      target.mesh.visible = target.originalVisible;
      target.damageAccum = 0;
      target.submergedDuration = 0;
      target.debrisImpactAccum = 0;
      target.peakDepth = 0;
      target.peakSpeed = 0;
      target.peakPressure = 0;
      target.impactCooldown = 0;
      target.waveImpactCooldown = 0;
      target.hydroForce = 0;
      target.impactImpulse = 0;
    }

    this.destroyedCount = 0;
    this.entrainedCount = 0;
    this.strandedCount = 0;
    this.peakDepth = 0;
    this.peakSpeed = 0;
    this.peakPressure = 0;
    this.peakHydroForce = 0;
    this.peakImpactImpulse = 0;
    this.destroyCheckTimer = 0;
    this.clearDebris();
  }

  dispose(): void {
    this.clearDebris();
    this.root.remove(this.debrisGroup);
  }

  getDestroyedCount(): number {
    return this.destroyedCount;
  }

  getDebrisCount(): number {
    return this.debrisBodies.length;
  }

  getEntrainedCount(): number {
    return this.entrainedCount;
  }

  getStrandedCount(): number {
    return this.strandedCount;
  }

  getPeakMetrics(): { depth: number; speed: number; pressure: number } {
    return {
      depth: this.peakDepth,
      speed: this.peakSpeed,
      pressure: this.peakPressure,
    };
  }

  getImpactMetrics(): { hydroForce: number; impulse: number } {
    return {
      hydroForce: this.peakHydroForce,
      impulse: this.peakImpactImpulse,
    };
  }

  private collectTargets(): void {
    this.collectTargetsFromGroup("buildings", "building");
    this.collectTargetsFromGroup("trees", "small");
    this.collectTargetsFromGroup("barriers", "small");
    this.refreshBuildingAreaDistribution();
  }

  private collectTargetsFromGroup(groupName: string, kind: "building" | "small"): void {
    const group = this.root.getObjectByName(groupName);
    if (!group) return;

    const bbox = new THREE.Box3();
    const center = new THREE.Vector3();
    const size = new THREE.Vector3();

    group.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh)) return;

      bbox.setFromObject(obj);
      if (!Number.isFinite(bbox.min.x) || !Number.isFinite(bbox.max.x)) return;

      bbox.getSize(size);
      if (size.y < 0.2 || size.x < 0.15 || size.z < 0.15) return;

      bbox.getCenter(center);
      this.targets.push({
        mesh: obj,
        kind,
        bbox: bbox.clone(),
        center: center.clone(),
        size: size.clone(),
        baseArea: Math.max(0.1, size.x * size.z),
        height: size.y,
        destroyed: false,
        originalVisible: obj.visible,
        impactCooldown: 0,
        waveImpactCooldown: 0,
        fragility: deriveFragility(kind, size),
        damageAccum: 0,
        submergedDuration: 0,
        debrisImpactAccum: 0,
        peakDepth: 0,
        peakSpeed: 0,
        peakPressure: 0,
        hydroForce: 0,
        impactImpulse: 0,
        reflectionFactor: kind === "building" ? THREE.MathUtils.lerp(0.32, 0.85, Math.random()) : 0.28,
        localClosureRatio:
          kind === "building"
            ? THREE.MathUtils.clamp(0.72 + Math.min(0.2, size.y / Math.max(1, size.x + size.z)), 0.58, 0.96)
            : 0.45,
      });
    });
  }

  private refreshBuildingAreaDistribution(): void {
    this.buildingAreasSorted.length = 0;
    for (const target of this.targets) {
      if (target.kind !== "building") continue;
      this.buildingAreasSorted.push(target.baseArea);
    }
    this.buildingAreasSorted.sort((a, b) => a - b);
  }

  private evaluateDestruction(dt: number): void {
    const buildingLevel = clamp(this.params.buildingDestructionLevel, 0, 2);
    const buildingAreaLimit = this.getBuildingAreaLimit(buildingLevel);
    const buildingLevelNorm = buildingLevel * 0.5;
    const collisionIntensity = clamp(this.params.buildingCollisionIntensity, 0, 3);

    for (const target of this.targets) {
      if (target.destroyed || !target.mesh.visible) continue;
      target.impactCooldown = Math.max(0, target.impactCooldown - dt);
      target.waveImpactCooldown = Math.max(0, target.waveImpactCooldown - dt);

      const terrainY = this.terrainSampler.sample(target.center.x, target.center.z);
      const hydro = this.waveField.getHydroStateAt(
        target.center.x,
        target.center.z,
        terrainY,
        this.hydroScratch
      );
      this.recordPeaks(hydro.depth, hydro.speed, hydro.dynamicPressure);

      target.peakDepth = Math.max(target.peakDepth, hydro.depth);
      target.peakSpeed = Math.max(target.peakSpeed, hydro.speed);
      target.peakPressure = Math.max(target.peakPressure, hydro.dynamicPressure);

      if (target.kind === "building") {
        this.emitWaveFacadeImpacts(target, hydro, terrainY, collisionIntensity);
      }

      if (target.kind === "building" && !this.isBuildingEligible(target, buildingLevel, buildingAreaLimit)) {
        continue;
      }

      if (hydro.depth > 0.03) {
        target.submergedDuration = Math.min(120, target.submergedDuration + dt);
      } else {
        target.submergedDuration = Math.max(0, target.submergedDuration - dt * 1.8);
      }

      const fragility = target.fragility;
      const depthNorm = hydro.depth / Math.max(0.05, fragility.yieldDepth);
      const velocityNorm = hydro.speed / Math.max(0.05, fragility.yieldVelocity);
      const pressureNorm = hydro.dynamicPressure / 22000;
      const durationNorm = target.submergedDuration * fragility.durationSensitivity;
      const debrisNorm = target.debrisImpactAccum * fragility.debrisSensitivity;
      const forceCapacity = Math.max(1200, target.baseArea * fragility.collapsePressure * 0.11);
      const impulseCapacity = Math.max(220, target.baseArea * fragility.collapsePressure * 0.006);
      const forceNorm = target.hydroForce / forceCapacity;
      const impulseNorm = target.impactImpulse / impulseCapacity;
      const collisionLoad = Math.max(
        0,
        (hydro.dynamicPressure - fragility.collapsePressure * 0.35) /
          Math.max(1, fragility.collapsePressure * 0.65)
      );

      let damageRate =
        0.20 * depthNorm +
        0.24 * velocityNorm +
        0.28 * pressureNorm * hydro.impulseFactor +
        0.09 * durationNorm +
        0.16 * debrisNorm +
        0.20 * forceNorm +
        0.12 * impulseNorm +
        0.20 * collisionLoad * collisionIntensity;

      let collapseDamageThreshold = 1;
      let collapseDepthThreshold = fragility.collapseDepth * this.params.breakThresholdMultiplier;
      let collapseVelocityThreshold = fragility.collapseVelocity;
      let collapsePressureThreshold = fragility.collapsePressure;

      if (target.kind === "building") {
        const vulnerability = THREE.MathUtils.lerp(0.48, 1.75, buildingLevelNorm);
        const thresholdScale = THREE.MathUtils.lerp(1.48, 0.66, buildingLevelNorm);
        damageRate *= vulnerability * THREE.MathUtils.lerp(0.8, 1.25, clamp01(collisionIntensity / 2));
        collapseDamageThreshold *= THREE.MathUtils.lerp(1.24, 0.58, buildingLevelNorm);
        collapseDepthThreshold *= thresholdScale;
        collapseVelocityThreshold *= thresholdScale;
        collapsePressureThreshold *= thresholdScale;

        const boreImpact =
          hydro.phase === "crest" &&
          hydro.depth >= fragility.yieldDepth * 0.52 &&
          hydro.speed >= fragility.yieldVelocity * 0.65;
        if (boreImpact && target.impactCooldown <= 0) {
          const burst = 0.6 + hydro.speed * 0.15 + hydro.depth * 0.12;
          this.emitTargetImpact(target, hydro, burst, 2.2 + hydro.depth * 0.4);
          target.debrisImpactAccum += burst * 0.18;
          target.damageAccum += burst * 0.03;
          target.impactCooldown = 0.2;

          this.hooks.onWaterImpulse?.(
            target.center.x,
            target.center.z,
            hydro.vx * 0.22,
            hydro.vz * 0.22,
            4.5,
            0.55
          );
        }
      }

      target.damageAccum = target.damageAccum * 0.955 + damageRate * dt;
      target.debrisImpactAccum *= 0.89;
      target.hydroForce *= 0.88;
      target.impactImpulse *= 0.8;

      const collapseByDamage = target.damageAccum >= collapseDamageThreshold;
      const collapseByDepth = hydro.depth >= collapseDepthThreshold;
      const collapseByVelocity = hydro.speed >= collapseVelocityThreshold;
      const collapseByPressure = hydro.dynamicPressure >= collapsePressureThreshold;
      const collapseByForce = target.hydroForce >= forceCapacity;
      const collapseByImpulse = target.impactImpulse >= impulseCapacity;

      if (
        !collapseByDamage &&
        !collapseByDepth &&
        !collapseByVelocity &&
        !collapseByPressure &&
        !collapseByForce &&
        !collapseByImpulse
      ) {
        continue;
      }

      target.destroyed = true;
      target.mesh.visible = false;
      this.destroyedCount += 1;
      this.emitTargetImpact(target, hydro, 1.2 + hydro.speed * 0.2, 3.6 + target.size.y * 0.1);
      this.spawnFragments(target, hydro.vx, hydro.vz, hydro.impulseFactor);
    }
  }

  private spawnFragments(
    target: DestroyableTarget,
    flowX: number,
    flowZ: number,
    impulseFactor: number
  ): void {
    const minCount = Math.max(1, Math.floor(this.params.fragmentMin));
    const maxCount = Math.max(minCount, Math.floor(this.params.fragmentMax));
    const count = randomInt(minCount, maxCount);
    const color = readMeshColor(target.mesh);
    const baseMaterial = new THREE.MeshStandardMaterial({
      color,
      roughness: 0.84,
      metalness: 0.05,
    });

    const flowDir = new THREE.Vector3(flowX, 0, flowZ);
    if (flowDir.lengthSq() < 1e-6) {
      flowDir.set(0, 0, -1);
    } else {
      flowDir.normalize();
    }

    for (let i = 0; i < count; i++) {
      const sx = Math.max(0.28, target.size.x * (0.08 + Math.random() * 0.14));
      const sy = Math.max(0.22, target.size.y * (0.08 + Math.random() * 0.14));
      const sz = Math.max(0.28, target.size.z * (0.08 + Math.random() * 0.14));
      const geometry = new THREE.BoxGeometry(sx, sy, sz);
      const material = baseMaterial.clone();
      const fragment = new THREE.Mesh(geometry, material);
      fragment.castShadow = true;
      fragment.receiveShadow = true;
      fragment.position.set(
        THREE.MathUtils.lerp(target.bbox.min.x, target.bbox.max.x, Math.random()),
        THREE.MathUtils.lerp(target.bbox.min.y, target.bbox.max.y, Math.random()),
        THREE.MathUtils.lerp(target.bbox.min.z, target.bbox.max.z, Math.random())
      );
      fragment.rotation.set(
        Math.random() * Math.PI,
        Math.random() * Math.PI,
        Math.random() * Math.PI
      );
      this.debrisGroup.add(fragment);

      const densityClass: DebrisDensityClass = sy < 0.55 || Math.random() < 0.45 ? "light" : "heavy";
      const mass = densityClass === "light" ? 0.8 + sy * 0.3 : 1.5 + sy * 0.6;
      const volume = Math.max(0.01, sx * sy * sz);
      const area = Math.max(0.04, sx * sz);
      const side = new THREE.Vector3(Math.random() - 0.5, 0, Math.random() - 0.5).normalize();
      const forwardStrength = 1.5 + Math.random() * (1.5 + this.params.impactForce * impulseFactor);
      const sideStrength = 0.5 + Math.random() * (0.8 + this.params.turbulence);
      const radius = Math.max(sx, sy, sz) * 0.62;

      const velocity = new THREE.Vector3(
        flowDir.x * forwardStrength + side.x * sideStrength,
        0.9 + Math.random() * 1.2,
        flowDir.z * forwardStrength + side.z * sideStrength
      );

      this.debrisBodies.push({
        mesh: fragment,
        velocity,
        angularVelocity: new THREE.Vector3(
          (Math.random() - 0.5) * 8,
          (Math.random() - 0.5) * 8,
          (Math.random() - 0.5) * 8
        ),
        ttl: 24 + Math.random() * 22,
        floatOffset: Math.max(0.1, sy * 0.32),
        minGroundClearance: Math.max(0.06, sy * 0.22),
        radius,
        mass,
        volume,
        area,
        densityClass,
        groundedTime: 0,
        impactCooldown: 0,
        ownsGeometry: true,
        ownsMaterial: true,
        wasInWater: false,
      });
    }

    baseMaterial.dispose();
  }

  private updateDebris(dt: number): void {
    const remove = new Set<DebrisBody>();
    const { xMin, xMax, zMin, zMax } = this.terrainSampler.bounds;
    const boundsPad = 160;
    const buildingLevel = clamp(this.params.buildingDestructionLevel, 0, 2);
    const buildingAreaLimit = this.getBuildingAreaLimit(buildingLevel);
    const quality = clamp(this.params.solverQuality, 0.4, 2.5);
    const maxSubsteps = clampInt(Math.round(this.params.maxDebrisSubsteps), 1, 10);
    const desiredSubsteps = Math.ceil(Math.max(0, dt) * 70 * (0.65 + 0.45 * quality));
    const substeps = clampInt(desiredSubsteps, 1, maxSubsteps);
    const subDt = dt / substeps;

    this.entrainedCount = 0;
    this.strandedCount = 0;
    for (let step = 0; step < substeps; step++) {
      const isFinalStep = step === substeps - 1;

      for (const body of this.debrisBodies) {
        if (remove.has(body)) continue;

        body.ttl -= subDt;
        body.impactCooldown = Math.max(0, body.impactCooldown - subDt);
        if (body.ttl <= 0) {
          remove.add(body);
          continue;
        }

        const pos = body.mesh.position;
        const terrainY = this.terrainSampler.sample(pos.x, pos.z);
        const hydro = this.waveField.getHydroStateAt(pos.x, pos.z, terrainY, this.hydroScratch);
        this.recordPeaks(hydro.depth, hydro.speed, hydro.dynamicPressure);

        const inWaterNow = hydro.depth > 0.03 && pos.y <= hydro.surfaceY + body.radius * 0.9;
        const entrainmentThreshold = 0.22 * (2.0 - this.params.debrisEntrainment * 0.42);
        const isEntrained = inWaterNow && hydro.speed > entrainmentThreshold;
        const displacedFluidMass = this.params.rhoWater * body.volume * 0.001;
        const effectiveMass = Math.max(
          0.12,
          body.mass + displacedFluidMass * Math.max(0, this.params.addedMassCoeffDebris)
        );

        if (isEntrained) {
          if (isFinalStep) this.entrainedCount += 1;
          body.groundedTime = 0;

          const relVX = hydro.vx - body.velocity.x;
          const relVY = (hydro.surfaceY - pos.y) * 0.42 - body.velocity.y * 0.15;
          const relVZ = hydro.vz - body.velocity.z;
          const relSpeed = Math.hypot(relVX, relVY, relVZ);
          const densityDragScale = body.densityClass === "light" ? 1.05 : 0.86;
          const dragCoeff = Math.max(0.1, this.params.dragCoeffDebris * densityDragScale);
          const dragAccel =
            0.5 *
            this.params.rhoWater *
            dragCoeff *
            body.area *
            relSpeed *
            0.0019 /
            effectiveMass;
          const entrainmentGain = this.params.debrisEntrainment * (body.densityClass === "light" ? 1.06 : 0.88);
          body.velocity.x += relVX * dragAccel * entrainmentGain * subDt;
          body.velocity.y += relVY * dragAccel * entrainmentGain * subDt;
          body.velocity.z += relVZ * dragAccel * entrainmentGain * subDt;

          this.tmpVecA.set(relVX, 0, relVZ);
          if (this.tmpVecA.lengthSq() > 1e-6) {
            this.tmpVecA.normalize();
            this.tmpVecB.set(-this.tmpVecA.z, 0, this.tmpVecA.x);
            const liftSign = Math.sin(pos.x * 0.17 + pos.z * 0.13 + this.destroyCheckTimer * 4.8);
            const liftAccel =
              this.params.liftCoeffDebris *
              dragAccel *
              (0.25 + 0.75 * Math.min(1, hydro.depth)) *
              liftSign;
            body.velocity.x += this.tmpVecB.x * liftAccel * subDt;
            body.velocity.z += this.tmpVecB.z * liftAccel * subDt;
          }

          const submergence = clamp((hydro.surfaceY - (pos.y - body.radius)) / Math.max(1e-6, 2 * body.radius), 0, 1);
          const buoyancyScale = body.densityClass === "light" ? 1.14 : 0.78;
          body.velocity.y += this.gravity * submergence * buoyancyScale * subDt;
          body.velocity.y -= this.gravity * (1 - submergence * 0.88) * subDt;

          const turbulence =
            this.params.turbulence *
            (0.28 + hydro.speed * 0.1) *
            (body.densityClass === "light" ? 1 : 0.7);
          body.velocity.x += (Math.random() - 0.5) * turbulence * subDt;
          body.velocity.y += (Math.random() - 0.5) * turbulence * 0.25 * subDt;
          body.velocity.z += (Math.random() - 0.5) * turbulence * subDt;
        } else {
          body.velocity.y -= this.gravity * subDt;

          if (hydro.depth < 0.02 && hydro.speed < 0.35) {
            body.groundedTime += subDt;
          } else {
            body.groundedTime = Math.max(0, body.groundedTime - subDt);
          }

          const friction = body.groundedTime > 1 ? 1.8 : 0.9;
          body.velocity.x *= Math.max(0, 1 - friction * subDt);
          body.velocity.z *= Math.max(0, 1 - friction * subDt);

          if (isFinalStep && body.groundedTime > 2.5) {
            this.strandedCount += 1;
          }
        }

        if (inWaterNow && !body.wasInWater && body.velocity.y < -0.45) {
          const speed = body.velocity.length();
          const intensity = 0.45 + speed * 0.18;
          this.emitImpact(
            pos.x,
            Math.max(terrainY, hydro.surfaceY),
            pos.z,
            0,
            1,
            0,
            intensity,
            body.velocity.x,
            body.velocity.z,
            Math.max(1.1, body.radius * 2.3)
          );
        }
        body.wasInWater = inWaterNow;

        this.tmpVecA.copy(pos);
        this.tmpVecB.copy(pos).addScaledVector(body.velocity, subDt);

        body.mesh.rotation.x += body.angularVelocity.x * subDt;
        body.mesh.rotation.y += body.angularVelocity.y * subDt;
        body.mesh.rotation.z += body.angularVelocity.z * subDt;
        body.angularVelocity.multiplyScalar(Math.max(0, 1 - (1.6 + 0.3 * quality) * subDt));

        let sweptHit = false;
        if (body.impactCooldown <= 0) {
          sweptHit = this.resolveSweptDebrisTargetCollision(
            body,
            this.tmpVecA,
            this.tmpVecB,
            hydro.impulseFactor,
            buildingLevel,
            buildingAreaLimit
          );
        }
        if (!sweptHit) {
          pos.copy(this.tmpVecB);
        }

        const groundY = this.terrainSampler.sample(pos.x, pos.z) + body.minGroundClearance;
        if (pos.y < groundY) {
          pos.y = groundY;
          if (body.velocity.y < 0) {
            body.velocity.y *= -0.22;
          }
          body.velocity.x *= 0.84;
          body.velocity.z *= 0.84;
        }

        if (body.impactCooldown <= 0) {
          this.resolveDebrisTargetCollision(body, hydro.impulseFactor, buildingLevel, buildingAreaLimit);
        }

        if (
          pos.x < xMin - boundsPad ||
          pos.x > xMax + boundsPad ||
          pos.z < zMin - boundsPad ||
          pos.z > zMax + boundsPad
        ) {
          remove.add(body);
        }
      }

      this.resolveDebrisPairCollisions();
    }

    for (const body of remove) {
      this.removeDebris(body);
    }
  }

  private resolveDebrisTargetCollision(
    body: DebrisBody,
    impulseFactor: number,
    buildingLevel: number,
    buildingAreaLimit: number
  ): void {
    const pos = body.mesh.position;

    for (const target of this.targets) {
      if (target.destroyed || !target.mesh.visible) continue;
      const damageEligible =
        target.kind !== "building" || this.isBuildingEligible(target, buildingLevel, buildingAreaLimit);

      const bbox = target.bbox;
      if (
        pos.x < bbox.min.x - body.radius ||
        pos.x > bbox.max.x + body.radius ||
        pos.y < bbox.min.y - body.radius ||
        pos.y > bbox.max.y + body.radius ||
        pos.z < bbox.min.z - body.radius ||
        pos.z > bbox.max.z + body.radius
      ) {
        continue;
      }

      const nearestX = THREE.MathUtils.clamp(pos.x, bbox.min.x, bbox.max.x);
      const nearestY = THREE.MathUtils.clamp(pos.y, bbox.min.y, bbox.max.y);
      const nearestZ = THREE.MathUtils.clamp(pos.z, bbox.min.z, bbox.max.z);

      const dx = pos.x - nearestX;
      const dy = pos.y - nearestY;
      const dz = pos.z - nearestZ;
      const distSq = dx * dx + dy * dy + dz * dz;
      if (distSq > body.radius * body.radius) continue;

      let nx = 0;
      let ny = 0;
      let nz = 0;
      let dist = Math.sqrt(Math.max(1e-8, distSq));
      if (dist > 1e-5) {
        nx = dx / dist;
        ny = dy / dist;
        nz = dz / dist;
      } else {
        this.tmpVecA.subVectors(pos, target.center);
        this.tmpVecA.y = 0;
        if (this.tmpVecA.lengthSq() < 1e-6) {
          this.tmpVecA.set(1, 0, 0);
        } else {
          this.tmpVecA.normalize();
        }
        nx = this.tmpVecA.x;
        ny = 0.12;
        nz = this.tmpVecA.z;
        dist = 1e-4;
      }

      const penetration = body.radius - dist;
      if (penetration > 0) {
        pos.x += nx * (penetration + 1e-3);
        pos.y += ny * (penetration + 1e-3);
        pos.z += nz * (penetration + 1e-3);
      }

      const vn = body.velocity.x * nx + body.velocity.y * ny + body.velocity.z * nz;
      if (vn >= 0) continue;

      const restitution = clamp(this.params.restitutionBuilding, 0, 0.95);
      const impulse = -(1 + restitution) * vn;
      body.velocity.x += nx * impulse;
      body.velocity.y += ny * impulse;
      body.velocity.z += nz * impulse;

      const tangentialDamping = THREE.MathUtils.lerp(0.72, 0.94, clamp01(this.params.debrisCollisionDamping));
      body.velocity.multiplyScalar(tangentialDamping);

      const impactEnergy =
        Math.abs(vn) *
        body.mass *
        (0.75 + 0.25 * impulseFactor) *
        (0.65 + 0.35 * this.params.buildingCollisionIntensity);
      if (damageEligible) {
        target.debrisImpactAccum += impactEnergy * 0.085;
        target.damageAccum += impactEnergy * 0.0075;
        target.impactImpulse = Math.max(target.impactImpulse, impactEnergy * 0.2);
        this.peakImpactImpulse = Math.max(this.peakImpactImpulse, target.impactImpulse);
        target.impactCooldown = Math.max(target.impactCooldown, 0.1);
      }

      const flowX = body.velocity.x;
      const flowZ = body.velocity.z;
      const intensity = Math.min(4.2, 0.35 + impactEnergy * 0.09);
      this.emitImpact(pos.x, pos.y, pos.z, nx, ny, nz, intensity, flowX, flowZ, Math.max(1.4, body.radius * 2.4));
      this.hooks.onWaterImpulse?.(
        pos.x,
        pos.z,
        flowX * 0.18,
        flowZ * 0.18,
        Math.max(1.8, body.radius * 2.2),
        0.45
      );

      body.impactCooldown = 0.11;
      break;
    }
  }

  private resolveSweptDebrisTargetCollision(
    body: DebrisBody,
    start: THREE.Vector3,
    end: THREE.Vector3,
    impulseFactor: number,
    buildingLevel: number,
    buildingAreaLimit: number
  ): boolean {
    for (const target of this.targets) {
      if (target.destroyed || !target.mesh.visible) continue;

      const bbox = target.bbox;
      const minX = Math.min(start.x, end.x) - body.radius;
      const maxX = Math.max(start.x, end.x) + body.radius;
      const minY = Math.min(start.y, end.y) - body.radius;
      const maxY = Math.max(start.y, end.y) + body.radius;
      const minZ = Math.min(start.z, end.z) - body.radius;
      const maxZ = Math.max(start.z, end.z) + body.radius;
      if (
        maxX < bbox.min.x ||
        minX > bbox.max.x ||
        maxY < bbox.min.y ||
        minY > bbox.max.y ||
        maxZ < bbox.min.z ||
        minZ > bbox.max.z
      ) {
        continue;
      }

      if (!this.segmentIntersectsExpandedBox(start, end, bbox, body.radius, this.sweepPoint, this.sweepNormal)) {
        continue;
      }

      const damageEligible =
        target.kind !== "building" || this.isBuildingEligible(target, buildingLevel, buildingAreaLimit);
      body.mesh.position.copy(this.sweepPoint).addScaledVector(this.sweepNormal, 1e-3);
      const vn = body.velocity.dot(this.sweepNormal);
      if (vn < 0) {
        const restitution = clamp(this.params.restitutionBuilding, 0, 0.95);
        body.velocity.addScaledVector(this.sweepNormal, -(1 + restitution) * vn);
      }

      const tangentialDamping = THREE.MathUtils.lerp(0.7, 0.95, clamp01(this.params.debrisCollisionDamping));
      body.velocity.multiplyScalar(tangentialDamping);
      const impactEnergy =
        Math.abs(vn) *
        body.mass *
        (0.75 + 0.25 * impulseFactor) *
        (0.65 + 0.35 * this.params.buildingCollisionIntensity);

      if (damageEligible) {
        target.debrisImpactAccum += impactEnergy * 0.09;
        target.damageAccum += impactEnergy * 0.0085;
        target.impactImpulse = Math.max(target.impactImpulse, impactEnergy * 0.22);
        this.peakImpactImpulse = Math.max(this.peakImpactImpulse, target.impactImpulse);
        target.impactCooldown = Math.max(target.impactCooldown, 0.1);
      }

      this.emitImpact(
        body.mesh.position.x,
        body.mesh.position.y,
        body.mesh.position.z,
        this.sweepNormal.x,
        this.sweepNormal.y,
        this.sweepNormal.z,
        Math.min(4.4, 0.42 + impactEnergy * 0.095),
        body.velocity.x,
        body.velocity.z,
        Math.max(1.4, body.radius * 2.5)
      );
      this.hooks.onWaterImpulse?.(
        body.mesh.position.x,
        body.mesh.position.z,
        body.velocity.x * 0.2,
        body.velocity.z * 0.2,
        Math.max(1.8, body.radius * 2.2),
        0.5
      );
      body.impactCooldown = 0.12;
      return true;
    }

    return false;
  }

  private segmentIntersectsExpandedBox(
    start: THREE.Vector3,
    end: THREE.Vector3,
    box: THREE.Box3,
    padding: number,
    outPoint: THREE.Vector3,
    outNormal: THREE.Vector3
  ): boolean {
    let tMin = 0;
    let tMax = 1;
    let hitAxis = -1;
    let hitSign = 0;

    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const dz = end.z - start.z;

    if (!clipAxis(start.x, dx, box.min.x - padding, box.max.x + padding, 0)) return false;
    if (!clipAxis(start.y, dy, box.min.y - padding, box.max.y + padding, 1)) return false;
    if (!clipAxis(start.z, dz, box.min.z - padding, box.max.z + padding, 2)) return false;
    if (tMin < 0 || tMin > 1) return false;

    outPoint.set(start.x + dx * tMin, start.y + dy * tMin, start.z + dz * tMin);
    outNormal.set(0, 0, 0);
    if (hitAxis === 0) outNormal.x = hitSign;
    if (hitAxis === 1) outNormal.y = hitSign;
    if (hitAxis === 2) outNormal.z = hitSign;
    if (outNormal.lengthSq() < 1e-6) {
      this.tmpVecD.subVectors(start, outPoint);
      this.tmpVecD.y = 0;
      if (this.tmpVecD.lengthSq() < 1e-6) this.tmpVecD.set(0, 1, 0);
      outNormal.copy(this.tmpVecD.normalize());
    }
    return true;

    function clipAxis(
      startValue: number,
      delta: number,
      minValue: number,
      maxValue: number,
      axis: number
    ): boolean {
      if (Math.abs(delta) < 1e-8) {
        return startValue >= minValue && startValue <= maxValue;
      }

      let t1 = (minValue - startValue) / delta;
      let t2 = (maxValue - startValue) / delta;
      let nearSign = -1;
      if (t1 > t2) {
        const tmp = t1;
        t1 = t2;
        t2 = tmp;
        nearSign = 1;
      }
      if (t1 > tMin) {
        tMin = t1;
        hitAxis = axis;
        hitSign = nearSign;
      }
      if (t2 < tMax) tMax = t2;
      return tMin <= tMax;
    }
  }

  private resolveDebrisPairCollisions(): void {
    let checks = 0;
    const maxChecks =
      this.maxDebrisPairChecks * clampInt(Math.round(this.params.maxCollisionIterations), 1, 8);
    const restitution = clamp(this.params.restitutionDebris, 0, 0.98);

    for (let i = 0; i < this.debrisBodies.length; i++) {
      const a = this.debrisBodies[i]!;
      for (let j = i + 1; j < this.debrisBodies.length; j++) {
        if (checks++ > maxChecks) {
          return;
        }
        const b = this.debrisBodies[j]!;
        if (a.impactCooldown > 0 || b.impactCooldown > 0) continue;

        const pa = a.mesh.position;
        const pb = b.mesh.position;
        const dx = pb.x - pa.x;
        const dy = pb.y - pa.y;
        const dz = pb.z - pa.z;
        const minDist = a.radius + b.radius;
        const distSq = dx * dx + dy * dy + dz * dz;
        if (distSq > minDist * minDist) continue;

        const dist = Math.sqrt(Math.max(1e-8, distSq));
        const nx = dx / dist;
        const ny = dy / dist;
        const nz = dz / dist;

        const penetration = minDist - dist;
        if (penetration > 0) {
          const corr = penetration * 0.5 + 1e-3;
          pa.x -= nx * corr;
          pa.y -= ny * corr;
          pa.z -= nz * corr;
          pb.x += nx * corr;
          pb.y += ny * corr;
          pb.z += nz * corr;
        }

        const rvx = b.velocity.x - a.velocity.x;
        const rvy = b.velocity.y - a.velocity.y;
        const rvz = b.velocity.z - a.velocity.z;
        const vn = rvx * nx + rvy * ny + rvz * nz;
        if (vn >= 0) continue;

        const invMassA = 1 / Math.max(0.15, a.mass);
        const invMassB = 1 / Math.max(0.15, b.mass);
        const impulse = (-(1 + restitution) * vn) / (invMassA + invMassB);
        const ix = impulse * nx;
        const iy = impulse * ny;
        const iz = impulse * nz;

        a.velocity.x -= ix * invMassA;
        a.velocity.y -= iy * invMassA;
        a.velocity.z -= iz * invMassA;
        b.velocity.x += ix * invMassB;
        b.velocity.y += iy * invMassB;
        b.velocity.z += iz * invMassB;

        a.velocity.multiplyScalar(0.985);
        b.velocity.multiplyScalar(0.985);

        const impactStrength = Math.min(2.6, 0.25 + Math.abs(vn) * 0.34);
        const mx = (pa.x + pb.x) * 0.5;
        const my = (pa.y + pb.y) * 0.5;
        const mz = (pa.z + pb.z) * 0.5;
        this.emitImpact(mx, my, mz, nx, ny, nz, impactStrength, rvx, rvz, Math.max(1.0, minDist * 0.8));

        a.impactCooldown = 0.08;
        b.impactCooldown = 0.08;
      }
    }
  }

  private emitWaveFacadeImpacts(
    target: DestroyableTarget,
    centerHydro: ReturnType<TsunamiWaveField["getHydroStateAt"]>,
    terrainY: number,
    collisionIntensity: number
  ): void {
    if (target.waveImpactCooldown > 0) return;
    if (centerHydro.depth < 0.08 || centerHydro.speed < 0.75) return;

    this.tmpVecA.set(centerHydro.vx, 0, centerHydro.vz);
    const flowSpeed = this.tmpVecA.length();
    if (flowSpeed < 0.2) return;
    this.tmpVecA.multiplyScalar(1 / Math.max(1e-6, flowSpeed));

    this.tmpVecB.set(-this.tmpVecA.z, 0, this.tmpVecA.x);
    const halfX = Math.max(0.35, target.size.x * 0.5);
    const halfZ = Math.max(0.35, target.size.z * 0.5);
    const projectedHalf = Math.abs(this.tmpVecA.x) * halfX + Math.abs(this.tmpVecA.z) * halfZ;
    const lateralSpread = Math.max(0.25, Math.min(halfX, halfZ) * 0.7);
    const bandWidth = Math.max(0.55, (projectedHalf * 2.1) / 3);
    const localClosure = clamp(target.localClosureRatio, 0.5, 1);

    const contactBaseX = target.center.x - this.tmpVecA.x * (projectedHalf + 0.3);
    const contactBaseZ = target.center.z - this.tmpVecA.z * (projectedHalf + 0.3);
    const impactY = Math.min(
      target.bbox.max.y - 0.18,
      target.bbox.min.y + Math.max(0.22, Math.min(target.size.y * 0.58, centerHydro.depth * 0.48 + 0.18))
    );
    const localRadius = Math.max(1.2, 1.1 + projectedHalf * 0.55);
    const forceScale = Math.max(1200, target.baseArea * target.fragility.collapsePressure * 0.11);

    let totalForce = 0;
    let totalImpulse = 0;
    let emitted = 0;
    for (let band = -1; band <= 1; band++) {
      const px = contactBaseX + this.tmpVecB.x * lateralSpread * band;
      const pz = contactBaseZ + this.tmpVecB.z * lateralSpread * band;
      const localTerrainY = band === 0 ? terrainY : this.terrainSampler.sample(px, pz);
      const localHydro = this.waveField.getHydroStateAt(px, pz, localTerrainY, this.impactHydroScratch);
      if (localHydro.depth < 0.06 || localHydro.speed < 0.65) continue;

       const wetDepth = Math.min(target.size.y * 0.95, localHydro.depth);
       const wetArea = bandWidth * wetDepth;
       const dragForce =
         0.5 *
         this.params.rhoWater *
         this.params.dragCoeffBuilding *
         wetArea *
         localHydro.speed *
         localHydro.speed;
       const hydrostaticForce =
         0.5 *
         this.params.rhoWater *
         this.gravity *
         wetDepth *
         wetDepth *
         bandWidth *
         0.42;
       const boreBoost =
         1 +
         this.params.impulseCoeffBore *
           clamp01((localHydro.impulseFactor - 1) / Math.max(0.25, this.params.impulseGain));
       const bandForce =
         (dragForce + hydrostaticForce) *
         boreBoost *
         localClosure *
         (0.58 + 0.42 * clamp(collisionIntensity, 0, 3) / 3);
       const bandImpulse = bandForce * this.checkInterval * (0.62 + 0.38 * localHydro.impulseFactor);
       totalForce += bandForce;
       totalImpulse += bandImpulse;

      this.tmpVecC.set(-this.tmpVecA.x, 0.32 + Math.abs(band) * 0.06, -this.tmpVecA.z).normalize();
      const intensity =
        this.params.splashEnergyScale *
        (0.24 +
          Math.pow(Math.max(0, bandForce), 0.25) * 0.11 +
          localHydro.depth * 0.22 +
          localHydro.speed * 0.15) *
        (1.0 + this.params.splashIntensity * 0.3);
      const radius = localRadius * (1 + Math.abs(band) * 0.15);

      this.emitImpact(
        px,
        impactY,
        pz,
        this.tmpVecC.x,
        this.tmpVecC.y,
        this.tmpVecC.z,
        intensity,
        localHydro.vx,
        localHydro.vz,
        radius
      );
      const reflectionGain =
        this.params.reflectionStrength *
        target.reflectionFactor *
        (0.018 + 0.012 * localHydro.depth) *
        (0.7 + 0.3 * localClosure);
      this.hooks.onWaterImpulse?.(
        px,
        pz,
        -this.tmpVecA.x * localHydro.speed * reflectionGain,
        -this.tmpVecA.z * localHydro.speed * reflectionGain,
        radius * 0.8,
        0.28 + 0.22 * bandForce / forceScale
      );
      emitted += 1;
    }

    if (emitted > 0) {
      target.hydroForce = Math.max(target.hydroForce * 0.72, totalForce);
      target.impactImpulse = Math.max(target.impactImpulse * 0.65, totalImpulse);
      this.peakHydroForce = Math.max(this.peakHydroForce, target.hydroForce);
      this.peakImpactImpulse = Math.max(this.peakImpactImpulse, target.impactImpulse);
      target.waveImpactCooldown = Math.max(0.05, 0.09 - Math.min(0.03, centerHydro.speed * 0.004));
    }
  }

  private emitTargetImpact(
    target: DestroyableTarget,
    hydro: ReturnType<TsunamiWaveField["getHydroStateAt"]>,
    intensity: number,
    radiusMeters: number
  ): void {
    this.tmpVecA.set(-hydro.vx, 0, -hydro.vz);
    if (this.tmpVecA.lengthSq() < 1e-6) {
      this.tmpVecA.set(0, 1, 0);
    } else {
      this.tmpVecA.normalize();
    }

    const impactY = Math.min(
      target.bbox.max.y - target.size.y * 0.06,
      target.bbox.min.y + Math.max(0.25, hydro.depth * 0.45)
    );
    this.emitImpact(
      target.center.x,
      impactY,
      target.center.z,
      this.tmpVecA.x,
      Math.max(0.15, this.tmpVecA.y),
      this.tmpVecA.z,
      intensity,
      hydro.vx,
      hydro.vz,
      radiusMeters
    );
  }

  private emitImpact(
    x: number,
    y: number,
    z: number,
    nx: number,
    ny: number,
    nz: number,
    intensity: number,
    flowX: number,
    flowZ: number,
    radiusMeters: number
  ): void {
    this.hooks.onImpact?.({
      x,
      y,
      z,
      nx,
      ny,
      nz,
      intensity: Math.max(0.02, intensity),
      flowX,
      flowZ,
      radiusMeters: Math.max(0.5, radiusMeters),
    });
  }

  private recordPeaks(depth: number, speed: number, pressure: number): void {
    this.peakDepth = Math.max(this.peakDepth, depth);
    this.peakSpeed = Math.max(this.peakSpeed, speed);
    this.peakPressure = Math.max(this.peakPressure, pressure);
  }

  private clearDebris(): void {
    while (this.debrisBodies.length > 0) {
      const body = this.debrisBodies.pop()!;
      this.destroyDebris(body);
    }
  }

  private removeDebris(body: DebrisBody): void {
    const idx = this.debrisBodies.indexOf(body);
    if (idx >= 0) this.debrisBodies.splice(idx, 1);
    this.destroyDebris(body);
  }

  private destroyDebris(body: DebrisBody): void {
    this.debrisGroup.remove(body.mesh);
    if (body.ownsGeometry) {
      body.mesh.geometry.dispose();
    }
    if (body.ownsMaterial) {
      if (Array.isArray(body.mesh.material)) {
        for (const material of body.mesh.material) material.dispose();
      } else {
        body.mesh.material.dispose();
      }
    }
  }

  private isBuildingEligible(
    target: DestroyableTarget,
    buildingLevel: number,
    buildingAreaLimit: number
  ): boolean {
    if (target.kind !== "building") return true;
    if (buildingLevel <= 0.01) return false;
    return target.baseArea <= buildingAreaLimit;
  }

  private getBuildingAreaLimit(buildingLevel: number): number {
    if (this.buildingAreasSorted.length === 0) return Number.POSITIVE_INFINITY;
    const levelNorm = clamp(buildingLevel, 0, 2) * 0.5;
    const quantile = THREE.MathUtils.lerp(0.30, 0.68, levelNorm);
    return quantileValue(this.buildingAreasSorted, quantile);
  }
}

function deriveFragility(kind: "building" | "small", size: THREE.Vector3): StructureFragilityParams {
  const footprint = Math.max(0.5, size.x * size.z);
  const height = Math.max(0.3, size.y);

  if (kind === "small") {
    const scale = Math.max(0.4, Math.sqrt(footprint) * 0.35 + height * 0.2);
    return {
      yieldDepth: 0.28 + scale * 0.25,
      yieldVelocity: 0.9 + scale * 0.55,
      collapseDepth: 0.7 + scale * 0.7,
      collapseVelocity: 2.4 + scale * 1.1,
      collapsePressure: 8000 + scale * 3500,
      debrisSensitivity: 0.22,
      durationSensitivity: 0.16,
    };
  }

  const scale = Math.max(0.8, Math.sqrt(footprint) * 0.08 + height * 0.06);
  return {
    yieldDepth: 0.9 + scale * 0.9,
    yieldVelocity: 1.6 + scale * 1.0,
    collapseDepth: 2.2 + scale * 2.4,
    collapseVelocity: 4.2 + scale * 2.1,
    collapsePressure: 18000 + scale * 9000,
    debrisSensitivity: 0.14,
    durationSensitivity: 0.11,
  };
}

function randomInt(min: number, max: number): number {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

function readMeshColor(mesh: THREE.Mesh): THREE.Color {
  const source = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
  if (source && "color" in source && source.color instanceof THREE.Color) {
    return source.color.clone();
  }
  return new THREE.Color("#8e98a3");
}

function quantileValue(sortedValues: number[], q: number): number {
  if (sortedValues.length === 0) return 0;
  if (sortedValues.length === 1) return sortedValues[0]!;
  const qClamped = clamp(q, 0, 1);
  const pos = qClamped * (sortedValues.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.min(sortedValues.length - 1, lo + 1);
  const t = pos - lo;
  return THREE.MathUtils.lerp(sortedValues[lo]!, sortedValues[hi]!, t);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value | 0));
}
