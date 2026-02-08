import * as THREE from "three";
import type { BuildingRecord, TreeRecord, CarRecord } from "../layers.ts";
import {
  getTerrainHeight,
  treeRegistry,
  carRegistry,
  resetCarsToBase,
  terrainCanvasRef,
  terrainTextureRef,
  terrainBoundsRef,
  terrainMeshRef,
  roadLinesRef,
  sceneGroupRef,
} from "../layers.ts";
import type { EventBus } from "../core/EventBus.ts";

// Allen et al. (2012) IPE for active shallow crustal regions (OpenQuake implementation)
const IPE_COEFF = {
  c0: 3.95,
  c1: 0.913,
  c2: -1.107,
  c3: 0.813,
};

function smoothstep(edge0: number, edge1: number, x: number) {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

export class EarthquakeSimulator {
  active = false;
  position = new THREE.Vector3();
  magnitude = 6.0;
  duration = 20;
  time = 0;
  affectedRadiusKm = 0;

  private scene: THREE.Scene;
  private shakeSeed = Math.random() * 100;
  private rubbleGroup: THREE.Group;
  private terrainBasePos: THREE.Vector3 | null = null;
  private sceneBasePos: THREE.Vector3 | null = null;
  private lastPaint = 0;
  private groundShakeY = 0;
  private pileMap = new Map<string, number>();
  private readonly pileCellSize = 1.6;
  private readonly tmpBox = new THREE.Box3();
  private readonly tmpSize = new THREE.Vector3();
  private debris: {
    mesh: THREE.Mesh;
    velocity: THREE.Vector3;
    life: number;
    ttl: number;
    grounded?: boolean;
  }[] = [];
  /** Buildings currently collapsing progressively. */
  private collapsing: {
    building: BuildingRecord;
    progress: number; // 0→1
    cx: number;
    cz: number;
    baseY: number;
    height: number;
    halfX: number;
    halfZ: number;
    nextFragment: number; // progress threshold for next fragment burst
  }[] = [];
  private debrisGeos: THREE.BufferGeometry[];
  private concreteMat: THREE.MeshPhongMaterial;
  private glassMat: THREE.MeshPhongMaterial;
  private crackedRoads = new Set<number>();
  private eventBus: EventBus | null = null;
  private lastEventEmit = 0;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    this.rubbleGroup = new THREE.Group();
    this.rubbleGroup.name = "quake-rubble";
    scene.add(this.rubbleGroup);
    this.debrisGeos = [
      new THREE.BoxGeometry(0.15, 0.02, 0.45), // thin glass shard
      new THREE.BoxGeometry(0.2, 0.03, 0.6),   // thin glass shard (long)
      new THREE.TetrahedronGeometry(0.7),      // jagged concrete
      new THREE.DodecahedronGeometry(0.8, 0),  // jagged concrete
      new THREE.BoxGeometry(1.6, 1.2, 1.4),    // chunk
      new THREE.ConeGeometry(0.9, 1.6, 4),     // wedge/pyramid
    ];
    this.concreteMat = new THREE.MeshPhongMaterial({ color: 0x6b6b6b, emissive: 0x2a2a2a, emissiveIntensity: 0.15 });
    this.glassMat = new THREE.MeshPhongMaterial({ color: 0x88bbee, emissive: 0x223344, emissiveIntensity: 0.25, transparent: true, opacity: 0.85 });
    this.setMagnitude(this.magnitude);
  }

  setEventBus(eb: EventBus | null) {
    this.eventBus = eb;
  }

  setMagnitude(mag: number) {
    this.magnitude = Math.max(4.0, Math.min(9.5, mag));
    this.duration = 8 + (this.magnitude - 4) * 6;
    this.affectedRadiusKm = this.solveRadiusForMMI(4.0);
  }

  getGroundShakeY(): number {
    return this.groundShakeY;
  }

  spawn(pos: THREE.Vector3) {
    this.position.copy(pos);
    this.position.y = getTerrainHeight(pos.x, pos.z);
    this.time = 0;
    this.active = true;
    this.crackedRoads.clear();
    this.pileMap.clear();
    resetCarsToBase();
  }

  despawn() {
    this.active = false;
    resetCarsToBase();
    this.groundShakeY = 0;
    this.pileMap.clear();
    if (sceneGroupRef && this.sceneBasePos) {
      sceneGroupRef.position.copy(this.sceneBasePos);
    } else if (terrainMeshRef && this.terrainBasePos) {
      terrainMeshRef.position.copy(this.terrainBasePos);
    }
  }

  update(dt: number, buildings: BuildingRecord[]) {
    if (this.active) {
      this.time += dt;
      if (this.time > this.duration) {
        this.despawn();
      }
    }

    // Ground shake + effects only while active
    if (this.active) {
      this.updateGroundShake(dt);
      this.paintRoadCracks(dt);
      this.updateBuildings(dt, buildings);
      this.updateTrees(dt);
      this.updateCars(dt);

      // Emit GROUND_SHAKE event for agent damage system
      if (this.eventBus && this.time - this.lastEventEmit >= 0.5) {
        this.lastEventEmit = this.time;
        const shake = this.getShakeVector(this.position.x, this.position.z);
        const pga = shake.length();
        this.eventBus.emit({
          type: "GROUND_SHAKE",
          epicenter: [this.position.x, this.position.y, this.position.z],
          magnitude: this.magnitude,
          pga,
        });
      }
    }

    // Progressive collapses + debris keep running after quake ends
    if (this.collapsing.length > 0) {
      this.updateCollapses(dt);
    }
    if (this.debris.length > 0) {
      this.updateDebris(dt, buildings);
    }
  }

  private getMMIAtDistanceKm(rKm: number): number {
    const { c0, c1, c2, c3 } = IPE_COEFF;
    const term = Math.sqrt(rKm * rKm + Math.pow(1 + c3 * Math.exp(this.magnitude - 5), 2));
    const mmi = c0 + c1 * this.magnitude + c2 * Math.log(term);
    return Math.max(1, Math.min(10, mmi));
  }

  private solveRadiusForMMI(targetMMI: number): number {
    let lo = 0.1;
    let hi = 300;
    for (let i = 0; i < 32; i++) {
      const mid = (lo + hi) / 2;
      if (this.getMMIAtDistanceKm(mid) > targetMMI) {
        lo = mid;
      } else {
        hi = mid;
      }
    }
    return lo;
  }

  private getShakeVector(x: number, z: number): THREE.Vector3 {
    const dx = x - this.position.x;
    const dz = z - this.position.z;
    const rKm = Math.sqrt(dx * dx + dz * dz) / 1000;
    const mmi = this.getMMIAtDistanceKm(rKm);
    if (mmi < 4.5) return new THREE.Vector3();

    const t = this.time / this.duration;
    const env = smoothstep(0.0, 0.12, t) * (1 - smoothstep(0.82, 1.0, t));
    const intensity = (mmi - 4.5) / 5.5;
    const amp = intensity * env * (0.8 + 0.12 * this.magnitude);

    const f1 = 1.2 + 0.08 * this.magnitude;
    const f2 = 2.6 + 0.12 * this.magnitude;
    const phase = this.shakeSeed + x * 0.01 + z * 0.008;

    const sx = Math.sin(this.time * f1 + phase) + 0.45 * Math.sin(this.time * f2 + phase * 1.7);
    const sz = Math.cos(this.time * (f1 * 1.1) + phase * 0.9) + 0.45 * Math.cos(this.time * (f2 * 1.2) + phase * 1.3);
    const sy = 0.28 * Math.sin(this.time * (f1 * 0.5) + phase * 0.7);
    return new THREE.Vector3(sx * amp, sy * amp * 0.6, sz * amp);
  }

  getCameraJitter(): THREE.Vector3 {
    // Tiny high-frequency jitter: noticeable at M5, stronger at M9, never extreme
    const mag = THREE.MathUtils.clamp(this.magnitude, 5, 9);
    const t = (mag - 5) / 4; // 0..1
    const amp = THREE.MathUtils.lerp(0.014, 0.045, t);
    const f = 18 + t * 12;
    return new THREE.Vector3(
      Math.sin(this.time * f + this.shakeSeed) * amp,
      Math.cos(this.time * (f * 0.9) + this.shakeSeed * 0.7) * amp * 0.6,
      Math.sin(this.time * (f * 1.1) + this.shakeSeed * 1.3) * amp,
    );
  }

  private updateGroundShake(dt: number) {
    // Keep rubble in world space; camera-only shake
    if (this.rubbleGroup.parent !== this.scene) {
      this.scene.add(this.rubbleGroup);
    }
    const shake = this.getShakeVector(this.position.x, this.position.z);
    const scale = 0.35 + (this.magnitude - 4) * 0.18;
    this.groundShakeY = shake.y * scale;
  }

  private paintRoadCracks(dt: number) {
    if (!terrainCanvasRef || !terrainTextureRef || !terrainBoundsRef) return;
    this.lastPaint += dt;
    if (this.lastPaint < 0.2) return;
    this.lastPaint = 0;

    const b = terrainBoundsRef;
    const TEX = terrainCanvasRef.width;
    const u = (this.position.x - b.xMin) / b.width;
    const v = (this.position.z - b.zMin) / b.depth;
    if (u < 0 || u > 1 || v < 0 || v > 1) return;

    if (this.magnitude < 7.0) return;

    const rKm = 0.1;
    const mmi = this.getMMIAtDistanceKm(rKm);
    if (mmi < 7.0) return;

    const t = this.time / this.duration;
    const env = smoothstep(0.0, 0.12, t) * (1 - smoothstep(0.82, 1.0, t));
    const intensity = (mmi - 6.0) / 4.0;
    const magScale = Math.min(1.6, 0.7 + (this.magnitude - 5) * 0.2);

    const ctx = terrainCanvasRef.getContext("2d")!;
    const cx = u * TEX;
    const cy = v * TEX;
    const r = (this.affectedRadiusKm * 1000 / b.width) * TEX * 0.25;

    ctx.save();
    // Crack segments along roads only
    const roads = roadLinesRef.filter((r) => !r.isFootpath);
    if (roads.length === 0) return;

    // Rare: only a couple of visible road cracks per quake
    if (Math.random() > 0.08) return;
    const crackCount = 1 + Math.floor(1 * magScale * intensity);
    for (let i = 0; i < crackCount; i++) {
      let roadIdx = Math.floor(Math.random() * roads.length);
      let guard = 0;
      while (this.crackedRoads.has(roadIdx) && guard < 20) {
        roadIdx = Math.floor(Math.random() * roads.length);
        guard++;
      }
      if (this.crackedRoads.has(roadIdx)) break;
      this.crackedRoads.add(roadIdx);

      const road = roads[roadIdx]!;
      if (road.points.length < 2) continue;
      const idx = Math.floor(Math.random() * (road.points.length - 1));
      const p0 = road.points[idx]!;
      const p1 = road.points[idx + 1]!;
      const tL = Math.random();
      const wx = p0[0] + (p1[0] - p0[0]) * tL;
      const wz = p0[1] + (p1[1] - p0[1]) * tL;
      const uu = (wx - b.xMin) / b.width;
      const vv = (wz - b.zMin) / b.depth;
      const x0 = uu * TEX;
      const y0 = vv * TEX;
      const ang = Math.atan2(p1[1] - p0[1], p1[0] - p0[0]) + (Math.random() - 0.5) * 0.6;
      const len = r * (0.3 + Math.random() * 0.6) * magScale;

      ctx.lineWidth = 1.6 + Math.random() * 2.6 * magScale;
      ctx.strokeStyle = "#151515";
      ctx.globalAlpha = 0.20 + intensity * env * 0.35;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      const segs = 5 + Math.floor(Math.random() * 4);
      for (let s = 1; s <= segs; s++) {
        const tSeg = s / segs;
        const wiggle = (Math.random() - 0.5) * 0.8;
        const px = x0 + Math.cos(ang + wiggle) * len * tSeg;
        const py = y0 + Math.sin(ang + wiggle) * len * tSeg;
        ctx.lineTo(px, py);
      }
      ctx.stroke();
    }
    ctx.restore();

    terrainTextureRef.needsUpdate = true;

    // No ground-wide brown overlays; road cracks only.
  }

  private updateBuildings(dt: number, buildings: BuildingRecord[]) {
    for (const b of buildings) {
      if (b.destroyed) continue;
      const dx = b.centerX - this.position.x;
      const dz = b.centerZ - this.position.z;
      const rKm = Math.sqrt(dx * dx + dz * dz) / 1000;
      const mmi = this.getMMIAtDistanceKm(rKm);
      if (mmi < 6.0) continue;

      const prev = b.damageLevel;
      const damageIntensity = Math.pow((mmi - 6.0) / 4.0, 1.4);
      const damageRate = damageIntensity * 0.10 / b.structuralStrength;
      b.damageLevel = Math.min(1, b.damageLevel + damageRate * dt);
      this.applyDamage(b);

      const magFactor = Math.min(1.0, Math.max(0, (this.magnitude - 5.5) / 2.0));
      const quakeFade = 1 - smoothstep(0.35, 1.0, this.time / this.duration);
      const debrisChance = 0.03 * damageIntensity * magFactor * quakeFade;
      // Live bounds (after tilt/cave)
      const bboxLive = new THREE.Box3().setFromObject(b.mesh);
      const centerLive = bboxLive.getCenter(new THREE.Vector3());
      const sizeLive = bboxLive.getSize(new THREE.Vector3());

      if (Math.random() < debrisChance) {
        // Favor higher floors (windows) using live bounds
        const sideY = bboxLive.min.y + (bboxLive.max.y - bboxLive.min.y) * (0.70 + Math.random() * 0.25);
        const count = Math.max(1, Math.floor((3 + 3 * magFactor) * quakeFade));

        // Spawn debris from actual building AABB edges
        const side = Math.random() < 0.5 ? "x" : "z";
        const sign = Math.random() < 0.5 ? -1 : 1;
        const edgeOffset = (side === "x" ? sizeLive.x : sizeLive.z) * 0.5 * sign;

        const dx = side === "x" ? edgeOffset : (Math.random() - 0.5) * sizeLive.x * 0.8;
        const dz = side === "z" ? edgeOffset : (Math.random() - 0.5) * sizeLive.z * 0.8;

        const outward = side === "x" ? { nx: sign, nz: 0 } : { nx: 0, nz: sign };
        const minOffset = 0.3; // spawn just outside the face
        // Early quake: more glass; later: more concrete
        const glassBias = THREE.MathUtils.clamp(0.85 * quakeFade + 0.05, 0.1, 0.9);
        const glassCount = Math.max(1, Math.floor(count * glassBias));
        const concreteCount = Math.max(1, count - glassCount);
        this.chipBuildingToMatchDebris(b, 1.8);
        this.spawnDebrisBurst(centerLive.x + dx, centerLive.z + dz, sideY, concreteCount, this.concreteMat, outward, minOffset);
        if (this.magnitude >= 6.0) {
          this.spawnDebrisBurst(centerLive.x + dx, centerLive.z + dz, sideY, glassCount, this.glassMat, outward, minOffset);
        }
      }

      // Occasional chunk break-off (right pyramid / cube)
      if (this.magnitude >= 6.5 && mmi >= 6.5 && b.damageLevel >= 0.6 && Math.random() < 0.01 * damageIntensity) {
        const side = Math.random() < 0.5 ? "x" : "z";
        const sign = Math.random() < 0.5 ? -1 : 1;
        const edgeOffset = (side === "x" ? sizeLive.x : sizeLive.z) * 0.5 * sign;
        const dx = side === "x" ? edgeOffset : (Math.random() - 0.5) * sizeLive.x * 0.8;
        const dz = side === "z" ? edgeOffset : (Math.random() - 0.5) * sizeLive.z * 0.8;
        const outward = side === "x" ? { nx: sign, nz: 0 } : { nx: 0, nz: sign };
        const minOffset = 0.5;
        const sideY = bboxLive.min.y + (bboxLive.max.y - bboxLive.min.y) * (0.5 + Math.random() * 0.3);
        this.spawnChunkDebris(centerLive.x + dx, centerLive.z + dz, sideY, this.concreteMat, outward, minOffset);
      }

      // Base failure tilt (more common than full collapse) for 6.5+
      if (this.magnitude >= 6.5 && mmi >= 6.5 && b.damageLevel >= 0.35 && Math.random() < 0.05 * damageIntensity) {
        if (b.tiltTargetX === undefined && b.tiltTargetZ === undefined) {
          const tilt = (Math.random() - 0.5) * 0.22;
          if (Math.random() < 0.5) {
            b.tiltTargetX = tilt;
            b.tiltTargetZ = 0;
          } else {
            b.tiltTargetX = 0;
            b.tiltTargetZ = tilt;
          }
        }
      }

      const groundBaseY = b.baseY;
      if (b.tiltTargetX !== undefined || b.tiltTargetZ !== undefined) {
        const targetX = b.tiltTargetX ?? 0;
        const targetZ = b.tiltTargetZ ?? 0;
        b.mesh.rotation.x = THREE.MathUtils.lerp(b.mesh.rotation.x, targetX, 0.05);
        b.mesh.rotation.z = THREE.MathUtils.lerp(b.mesh.rotation.z, targetZ, 0.05);
        // Sink to keep corners grounded (approximate by footprint + tilt)
        const xHalf = sizeLive.x * 0.5;
        const zHalf = sizeLive.z * 0.5;
        const sink = Math.min(0.9,
          Math.abs(Math.sin(b.mesh.rotation.x)) * zHalf +
          Math.abs(Math.sin(b.mesh.rotation.z)) * xHalf
        );
        b.mesh.position.y = groundBaseY - sink - b.height * 0.05;
      }
      // Enforce base anchored to ground after any transforms
      const bboxNow = new THREE.Box3().setFromObject(b.mesh);
      if (bboxNow.min.y > groundBaseY) {
        b.mesh.position.y -= (bboxNow.min.y - groundBaseY);
      } else if (bboxNow.min.y < groundBaseY) {
        b.mesh.position.y += (groundBaseY - bboxNow.min.y);
      }

      // Begin progressive collapse when damage is high enough
      // M6.5+: buildings with 85%+ damage start collapsing
      // M7.5+: 75%+ damage; M8.0+: taller buildings at 70%+
      const collapseThreshold = this.magnitude >= 8.0 ? 0.70
        : this.magnitude >= 7.5 ? 0.75
        : this.magnitude >= 6.5 ? 0.85
        : 1.1; // never for < M6.5
      const alreadyCollapsing = this.collapsing.some((c) => c.building === b);
      if (!alreadyCollapsing && b.damageLevel >= collapseThreshold && mmi >= 6.5 && Math.random() < 0.08 * damageIntensity) {
        this.collapsing.push({
          building: b,
          progress: 0,
          cx: centerLive.x,
          cz: centerLive.z,
          baseY: b.baseY,
          height: b.height,
          halfX: b.halfX,
          halfZ: b.halfZ,
          nextFragment: 0.05,
        });
        this.eventBus?.emit({
          type: "STRUCTURE_COLLAPSE",
          entityId: 0,
          position: [b.centerX, b.baseY, b.centerZ],
          fragmentCount: 16,
        });
      }

      // Strong quakes: tall buildings shower glass and some concrete
      if (this.magnitude >= 7.5 && mmi >= 7.5 && b.height >= 40) {
        const showerChance = 0.06 * damageIntensity * magFactor;
        if (Math.random() < showerChance) {
          const side = Math.random() < 0.5 ? "x" : "z";
          const sign = Math.random() < 0.5 ? -1 : 1;
          const edgeOffset = (side === "x" ? sizeLive.x : sizeLive.z) * 0.5 * sign;
          const dx = side === "x" ? edgeOffset : (Math.random() - 0.5) * sizeLive.x * 0.8;
          const dz = side === "z" ? edgeOffset : (Math.random() - 0.5) * sizeLive.z * 0.8;
          const outward = side === "x" ? { nx: sign, nz: 0 } : { nx: 0, nz: sign };
          const minOffset = 0.3;
          const sideY = bboxLive.min.y + (bboxLive.max.y - bboxLive.min.y) * (0.75 + Math.random() * 0.2);
          this.spawnDebrisBurst(centerLive.x + dx, centerLive.z + dz, sideY, Math.max(3, Math.floor((8 + 6 * magFactor) * quakeFade)), this.glassMat, outward, minOffset);
          if (Math.random() < 0.35) {
            this.spawnDebrisBurst(centerLive.x + dx, centerLive.z + dz, sideY, Math.max(2, Math.floor((3 + 3 * magFactor) * quakeFade)), this.concreteMat, outward, minOffset);
          }
        }
      }
    }

  }

  private applyDamage(b: BuildingRecord) {
    const d = b.damageLevel;
    const matRaw = b.mesh.material;
    const mats = Array.isArray(matRaw) ? matRaw : [matRaw];
    // Apply damage tint to all phong materials that have a settable color
    for (const m of mats) {
      if (!m || !('color' in m) || !(m as any).color || typeof (m as any).color.copy !== 'function') continue;
      const col = (m as THREE.MeshPhongMaterial).color;
      const rubble = new THREE.Color(0x333333);
      const dmgTint = new THREE.Color(0x665544);

      if (d < 0.3) {
        col.copy(b.originalColor).lerp(dmgTint, d * 2.5);
      } else if (d < 0.65) {
        col.lerpColors(dmgTint, rubble, (d - 0.3) / 0.35);
      } else {
        col.copy(rubble);
      }
    }
  }

  private updateCollapses(dt: number) {
    for (let i = this.collapsing.length - 1; i >= 0; i--) {
      const c = this.collapsing[i]!;
      const b = c.building;
      // Collapse over ~3 seconds, accelerating
      const speed = 0.15 + c.progress * 0.5;
      c.progress = Math.min(1, c.progress + speed * dt);

      // Sink building straight down into the ground (no scale — avoids pivot issues)
      const sinkAmount = c.progress * c.height;
      b.mesh.position.y = c.baseY - sinkAmount;

      // Spawn a single large chunk at ~33% and ~66% progress
      if (c.progress >= c.nextFragment) {
        c.nextFragment += 0.5;
        const frontY = c.baseY + c.height * (1 - c.progress);
        const side = Math.floor(Math.random() * 4);
        const isX = side < 2;
        const sign = (side % 2 === 0) ? 1 : -1;
        const ex = isX ? c.halfX * sign : (Math.random() - 0.5) * c.halfX;
        const ez = isX ? (Math.random() - 0.5) * c.halfZ : c.halfZ * sign;
        const outward = isX ? { nx: sign, nz: 0 } : { nx: 0, nz: sign };
        this.spawnChunkDebris(c.cx + ex, c.cz + ez, frontY, this.concreteMat, outward, 0.3);
      }

      // Collapse complete
      if (c.progress >= 1) {
        b.destroyed = true;
        b.mesh.visible = false;
        this.spawnCollapseChunks(c.cx, c.cz, c.baseY + 0.2, 2 + Math.floor(c.height / 20));
        this.collapsing.splice(i, 1);
      }
    }
  }

  private spawnRubble(x: number, z: number, count: number) {
    for (let i = 0; i < count; i++) {
      const geo = Math.random() < 0.5
        ? new THREE.BoxGeometry(1.6 + Math.random() * 1.6, 0.4 + Math.random() * 0.6, 1.2 + Math.random() * 1.8)
        : new THREE.ConeGeometry(0.6 + Math.random() * 0.6, 1.0 + Math.random() * 1.2, 4);
      const mat = new THREE.MeshPhongMaterial({ color: 0x777777, emissive: 0x2b2b2b, emissiveIntensity: 0.15 });
      const mesh = new THREE.Mesh(geo, mat);
      const rx = x + (Math.random() - 0.5) * 10;
      const rz = z + (Math.random() - 0.5) * 10;
      const ry = getTerrainHeight(rx, rz) + 0.05;
      mesh.position.set(rx, ry, rz);
      mesh.rotation.set(Math.random() * 0.6, Math.random() * Math.PI * 2, Math.random() * 0.6);
      this.rubbleGroup.add(mesh);
    }
  }

  private spawnCollapseChunks(x: number, z: number, y: number, count: number) {
    for (let i = 0; i < count; i++) {
      const geo = new THREE.BoxGeometry(3.0 + Math.random() * 3.5, 1.0 + Math.random() * 1.6, 2.5 + Math.random() * 3.0);
      const mat = new THREE.MeshPhongMaterial({ color: 0x707070, emissive: 0x2a2a2a, emissiveIntensity: 0.18 });
      const mesh = new THREE.Mesh(geo, mat);
      const rx = x + (Math.random() - 0.5) * 12;
      const rz = z + (Math.random() - 0.5) * 12;
      const ry = getTerrainHeight(rx, rz) + 0.05;
      mesh.position.set(rx, ry, rz);
      mesh.rotation.set((Math.random() - 0.5) * 0.6, Math.random() * Math.PI * 2, (Math.random() - 0.5) * 0.6);
      this.rubbleGroup.add(mesh);
    }
  }

  private spawnDebrisBurst(
    x: number,
    z: number,
    y: number,
    count: number,
    mat: THREE.MeshPhongMaterial,
    outward?: { nx: number; nz: number },
    minOffset = 0,
  ) {
    for (let i = 0; i < count; i++) {
      const isGlass = mat === this.glassMat;
      const geo = isGlass
        ? (Math.random() < 0.6 ? this.debrisGeos[0]! : this.debrisGeos[1]!)
        : this.debrisGeos[2 + (i % (this.debrisGeos.length - 2))]!;
      const mesh = new THREE.Mesh(geo, mat);
      const outX = outward ? outward.nx * (minOffset + 0.2 + Math.random() * 0.6) : 0;
      const outZ = outward ? outward.nz * (minOffset + 0.2 + Math.random() * 0.6) : 0;
      mesh.position.set(
        x + outX + (Math.random() - 0.5) * 0.8,
        y + (Math.random() - 0.5) * 0.4,
        z + outZ + (Math.random() - 0.5) * 0.8,
      );
      if (isGlass) {
        mesh.rotation.set(
          (Math.random() - 0.5) * 0.4,
          Math.random() * Math.PI,
          (Math.random() - 0.5) * 0.4,
        );
      } else {
        mesh.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);
      }
      mesh.scale.setScalar(0.6 + Math.random() * 1.4);
      this.rubbleGroup.add(mesh);
      this.debris.push({
        mesh,
        velocity: new THREE.Vector3(
          (Math.random() - 0.5) * 6,
          -0.5 + Math.random() * 0.4,
          (Math.random() - 0.5) * 6,
        ),
        life: 0,
        ttl: 6 + Math.random() * 6,
      });
    }
  }

  private chipBuilding(b: BuildingRecord, strength: number) {
    const geom = b.mesh.geometry as THREE.BufferGeometry;
    if (!geom.attributes.position) return;
    geom.computeBoundingBox();
    const bb = geom.boundingBox!;
    const size = new THREE.Vector3();
    bb.getSize(size);
    if (size.x === 0 || size.y === 0 || size.z === 0) return;

    const chipSize = new THREE.Vector3(
      size.x * (0.05 + Math.random() * 0.05),
      size.y * (0.08 + Math.random() * 0.10),
      size.z * (0.05 + Math.random() * 0.05),
    ).multiplyScalar(strength);

    const cornerX = Math.random() < 0.5 ? bb.min.x : bb.max.x - chipSize.x;
    const cornerZ = Math.random() < 0.5 ? bb.min.z : bb.max.z - chipSize.z;
    const cornerY = bb.min.y + size.y * (0.2 + Math.random() * 0.6);

    const cx = (bb.min.x + bb.max.x) / 2;
    const cz = (bb.min.z + bb.max.z) / 2;
    const chipDepth = Math.min(size.x, size.z) * (0.04 + Math.random() * 0.04) * strength;

    const pos = geom.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const vx = pos.getX(i);
      const vy = pos.getY(i);
      const vz = pos.getZ(i);
      if (
        vx >= cornerX && vx <= cornerX + chipSize.x &&
        vy >= cornerY && vy <= cornerY + chipSize.y &&
        vz >= cornerZ && vz <= cornerZ + chipSize.z
      ) {
        const dx = vx - cx;
        const dz = vz - cz;
        const len = Math.hypot(dx, dz) || 1;
        pos.setX(i, vx - (dx / len) * chipDepth);
        pos.setZ(i, vz - (dz / len) * chipDepth);
        pos.setY(i, vy - chipDepth * 0.4);
      }
    }
    pos.needsUpdate = true;
    geom.computeVertexNormals();
  }

  private chipBuildingToMatchDebris(b: BuildingRecord, debrisScale: number) {
    const geom = b.mesh.geometry as THREE.BufferGeometry;
    if (!geom.attributes.position) return;
    geom.computeBoundingBox();
    const bb = geom.boundingBox!;
    const size = new THREE.Vector3();
    bb.getSize(size);
    if (size.x === 0 || size.y === 0 || size.z === 0) return;

    const chipSize = new THREE.Vector3(
      Math.min(size.x * 0.18, debrisScale * 2.5),
      Math.min(size.y * 0.18, debrisScale * 2.0),
      Math.min(size.z * 0.18, debrisScale * 2.5),
    );

    const cornerX = Math.random() < 0.5 ? bb.min.x : bb.max.x - chipSize.x;
    const cornerZ = Math.random() < 0.5 ? bb.min.z : bb.max.z - chipSize.z;
    const cornerY = bb.min.y + size.y * (0.3 + Math.random() * 0.5);

    const cx = (bb.min.x + bb.max.x) / 2;
    const cz = (bb.min.z + bb.max.z) / 2;
    const chipDepth = Math.min(size.x, size.z) * 0.08;

    const pos = geom.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const vx = pos.getX(i);
      const vy = pos.getY(i);
      const vz = pos.getZ(i);
      if (
        vx >= cornerX && vx <= cornerX + chipSize.x &&
        vy >= cornerY && vy <= cornerY + chipSize.y &&
        vz >= cornerZ && vz <= cornerZ + chipSize.z
      ) {
        const dx = vx - cx;
        const dz = vz - cz;
        const len = Math.hypot(dx, dz) || 1;
        pos.setX(i, vx - (dx / len) * chipDepth);
        pos.setZ(i, vz - (dz / len) * chipDepth);
        pos.setY(i, vy - chipDepth * 0.6);
      }
    }
    pos.needsUpdate = true;
    geom.computeVertexNormals();
  }

  private spawnChunkDebris(
    x: number,
    z: number,
    y: number,
    mat: THREE.MeshPhongMaterial,
    outward?: { nx: number; nz: number },
    minOffset = 0,
  ) {
    const geoIdx = 3 + Math.floor(Math.random() * 2); // chunk/wedge
    const geo = this.debrisGeos[geoIdx]!;
    const mesh = new THREE.Mesh(geo, mat);
    const outX = outward ? outward.nx * (minOffset + 0.3 + Math.random() * 0.8) : 0;
    const outZ = outward ? outward.nz * (minOffset + 0.3 + Math.random() * 0.8) : 0;
    mesh.position.set(
      x + outX + (Math.random() - 0.5) * 0.6,
      y + (Math.random() - 0.5) * 0.3,
      z + outZ + (Math.random() - 0.5) * 0.6,
    );
    mesh.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);
    mesh.scale.setScalar(1.0 + Math.random() * 1.2);
    this.rubbleGroup.add(mesh);
    this.debris.push({
      mesh,
      velocity: new THREE.Vector3(
        (Math.random() - 0.5) * 5,
        -0.6 + Math.random() * 0.3,
        (Math.random() - 0.5) * 5,
      ),
      life: 0,
      ttl: 8 + Math.random() * 6,
    });
  }

  private updateDebris(dt: number, buildings?: BuildingRecord[]) {
    for (let i = this.debris.length - 1; i >= 0; i--) {
      const d = this.debris[i]!;
      d.life += dt;
      if (d.life > d.ttl) {
        this.rubbleGroup.remove(d.mesh);
        this.debris.splice(i, 1);
        continue;
      }
      if (d.grounded) continue;
      d.velocity.y += -9.81 * dt;
      d.velocity.multiplyScalar(0.98);
      d.mesh.position.addScaledVector(d.velocity, dt);
      d.mesh.rotation.x += 0.6 * dt;
      d.mesh.rotation.y += 0.8 * dt;

      const groundY = getTerrainHeight(d.mesh.position.x, d.mesh.position.z) + 0.05;
      const isSettled = d.velocity.lengthSq() < 0.0005 && d.mesh.position.y <= groundY + 0.02;

      // Building AABB collision (push out + damp)
      if (buildings && !isSettled) {
        const px = d.mesh.position.x;
        const py = d.mesh.position.y;
        const pz = d.mesh.position.z;
        for (const b of buildings) {
          if (b.destroyed) continue;
          const byMin = b.baseY;
          const byMax = b.baseY + b.height;
          if (py < byMin || py > byMax + 0.5) continue;
          const hx = b.halfX + 0.4; // small margin
          const hz = b.halfZ + 0.4;
          const dx = px - b.centerX;
          const dz = pz - b.centerZ;
          if (Math.abs(dx) < hx && Math.abs(dz) < hz) {
            // Inside AABB — push out along shortest penetration axis
            const overlapX = hx - Math.abs(dx);
            const overlapZ = hz - Math.abs(dz);
            if (overlapX < overlapZ) {
              const sign = dx >= 0 ? 1 : -1;
              d.mesh.position.x = b.centerX + sign * hx;
              d.velocity.x *= -0.25;
              d.velocity.z *= 0.7;
            } else {
              const sign = dz >= 0 ? 1 : -1;
              d.mesh.position.z = b.centerZ + sign * hz;
              d.velocity.z *= -0.25;
              d.velocity.x *= 0.7;
            }
            d.velocity.y *= 0.6;
            break;
          }
        }
        // Car AABB collision
        for (const car of carRegistry) {
          if (car.uprooted) continue;
          const cdx = px - car.x;
          const cdz = pz - car.z;
          // Cars are roughly 2m x 4.5m
          const chx = 1.2, chz = 2.5;
          const cy = car.baseY;
          if (py >= cy && py <= cy + 1.8 && Math.abs(cdx) < chx && Math.abs(cdz) < chz) {
            const ox = chx - Math.abs(cdx);
            const oz = chz - Math.abs(cdz);
            if (ox < oz) {
              d.mesh.position.x = car.x + (cdx >= 0 ? chx : -chx);
              d.velocity.x *= -0.3;
            } else {
              d.mesh.position.z = car.z + (cdz >= 0 ? chz : -chz);
              d.velocity.z *= -0.3;
            }
            d.velocity.y *= 0.5;
            break;
          }
        }
      }
      if (d.mesh.position.y < groundY) {
        const pileY = this.addToPile(d.mesh, groundY);
        d.mesh.position.y = pileY;
        d.velocity.set(0, 0, 0);
        d.grounded = true;
        // Keep grounded debris visible longer for agent perception.
        d.ttl = Math.max(d.ttl, 60 + Math.random() * 40);
      }
    }
  }

  private addToPile(mesh: THREE.Mesh, groundY: number): number {
    const key = this.getPileKey(mesh.position.x, mesh.position.z);
    const current = this.pileMap.get(key) ?? 0;
    this.tmpBox.setFromObject(mesh);
    const size = this.tmpBox.getSize(this.tmpSize);
    const increment = Math.max(0.06, Math.min(0.6, size.y * 0.55));
    const next = current + increment;
    this.pileMap.set(key, next);
    return groundY + current;
  }

  private getPileKey(x: number, z: number): string {
    const s = this.pileCellSize;
    const ix = Math.round(x / s);
    const iz = Math.round(z / s);
    return `${ix},${iz}`;
  }

  private updateTrees(dt: number) {
    for (const tree of treeRegistry as TreeRecord[]) {
      if (tree.uprooted) continue;
      const dx = tree.x - this.position.x;
      const dz = tree.z - this.position.z;
      const rKm = Math.sqrt(dx * dx + dz * dz) / 1000;
      const mmi = this.getMMIAtDistanceKm(rKm);
      if (this.magnitude < 7.0 || mmi < 6.5) continue;

      const sway = 0.03 + (mmi - 5.5) * 0.03;
      tree.trunkMesh.rotation.z = Math.sin(this.time * 3.0 + tree.x * 0.1) * sway;
      tree.trunkMesh.rotation.x = Math.cos(this.time * 2.6 + tree.z * 0.1) * sway;
      tree.canopyMesh.rotation.y += 0.02 * dt;

      if (!tree.broken && mmi >= 7.0 && Math.random() < 0.01 * dt) {
        tree.broken = true;
        const groundY = getTerrainHeight(tree.x, tree.z);
        tree.trunkMesh.scale.y = 0.45;
        tree.trunkMesh.position.y = groundY + 1.0;
        tree.trunkMesh.rotation.z = (Math.random() - 0.5) * 0.8;
        tree.trunkMesh.rotation.x = (Math.random() - 0.5) * 0.6;
        tree.canopyMesh.position.y = groundY + 0.6;
        tree.canopyMesh.rotation.set(
          (Math.random() - 0.5) * 0.8,
          Math.random() * Math.PI * 2,
          (Math.random() - 0.5) * 0.8,
        );
      }
    }
  }

  private updateCars(dt: number) {
    for (const car of carRegistry as CarRecord[]) {
      if (car.uprooted) continue;
      const dx = car.x - this.position.x;
      const dz = car.z - this.position.z;
      const rKm = Math.sqrt(dx * dx + dz * dz) / 1000;
      const mmi = this.getMMIAtDistanceKm(rKm);
      if (mmi < 5.5) continue;

      const shake = this.getShakeVector(car.x, car.z);
      car.x += shake.x * 3 * dt;
      car.z += shake.z * 3 * dt;
      const y = getTerrainHeight(car.x, car.z);
      car.mesh.position.set(car.x, y, car.z);

      if (!car.tipped && mmi >= 7.5 && Math.random() < 0.015 * dt) {
        car.tipped = true;
        car.speed = 0;
        car.mesh.rotation.z = (Math.random() < 0.5 ? -1 : 1) * (Math.PI / 2.2);
      }
    }
  }
}
