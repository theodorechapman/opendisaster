/**
 * TestFire scenario — multi-source stochastic fire spread with wind,
 * custom InstancedMesh particle visuals (flames, smoke, embers),
 * and per-source event emission.
 *
 * Self-contained and easily removable:
 *   1. Delete this file
 *   2. Remove the import + `startTestFire(...)` call in main.ts
 */

import * as THREE from "three";
import type { EventBus } from "../core/EventBus.ts";
import type { HeightSampler } from "../layers.ts";
import { buildingRegistry, treeRegistry, terrainBoundsRef, terrainCanvasRef, terrainTextureRef } from "../layers.ts";

/* ── Procedural Textures ──────────────────────────────────── */

/** Soft radial glow — bright center fading to transparent edges */
function makeFlameTexture(size = 128): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d")!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.15, "rgba(255,255,200,0.9)");
  g.addColorStop(0.4, "rgba(255,180,50,0.5)");
  g.addColorStop(0.7, "rgba(255,80,0,0.15)");
  g.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.needsUpdate = true;
  return tex;
}

/** Soft cloud blob — gray center fading out, slightly noisy edges */
function makeSmokeTexture(size = 128): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d")!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, "rgba(180,180,180,0.7)");
  g.addColorStop(0.3, "rgba(140,140,140,0.45)");
  g.addColorStop(0.6, "rgba(100,100,100,0.15)");
  g.addColorStop(1, "rgba(60,60,60,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.needsUpdate = true;
  return tex;
}

/** Tiny bright dot with glow halo */
function makeEmberTexture(size = 64): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d")!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, "rgba(255,255,220,1)");
  g.addColorStop(0.1, "rgba(255,200,80,0.9)");
  g.addColorStop(0.35, "rgba(255,120,20,0.4)");
  g.addColorStop(0.7, "rgba(200,40,0,0.1)");
  g.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.needsUpdate = true;
  return tex;
}

/* ── Particle System ──────────────────────────────────────── */

interface Particle {
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  life: number;     // elapsed seconds
  maxLife: number;   // seconds
  size: number;
  baseSize: number;
  alive: boolean;
}

type ParticleType = "flame" | "smoke" | "ember";

interface EmitterConfig {
  type: ParticleType;
  maxParticles: number;
  emissionRate: number;       // particles per second (scaled by intensity)
  lifeRange: [number, number];
  speedRange: [number, number];
  sizeRange: [number, number];
  emitterRadius: number;      // cone/sphere radius
  emitterShape: "cone" | "sphere";
  coneAngle?: number;         // radians, half angle for cone
  blending: THREE.Blending;
  tex: THREE.Texture;
  // Force: [x, y, z] applied per second
  baseForce: THREE.Vector3;
  // Color gradient: array of [color, t] where t is 0-1 normalized life
  colorStops: Array<{ color: THREE.Color; t: number }>;
  // Opacity gradient
  opacityStops: Array<{ opacity: number; t: number }>;
  // Size curve: array of [scale, t] where scale multiplies baseSize
  sizeStops: Array<{ scale: number; t: number }>;
  renderOrder?: number;
}

function lerpStops<T extends number>(stops: Array<{ value: T; t: number }>, t: number): T {
  if (stops.length === 0) return 0 as T;
  if (t <= stops[0]!.t) return stops[0]!.value;
  if (t >= stops[stops.length - 1]!.t) return stops[stops.length - 1]!.value;
  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i]!;
    const b = stops[i + 1]!;
    if (t >= a.t && t <= b.t) {
      const f = (t - a.t) / (b.t - a.t);
      return (a.value + (b.value - a.value) * f) as T;
    }
  }
  return stops[stops.length - 1]!.value;
}

function lerpColorStops(stops: Array<{ color: THREE.Color; t: number }>, t: number, out: THREE.Color): THREE.Color {
  if (stops.length === 0) return out.setRGB(1, 1, 1);
  if (t <= stops[0]!.t) return out.copy(stops[0]!.color);
  if (t >= stops[stops.length - 1]!.t) return out.copy(stops[stops.length - 1]!.color);
  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i]!;
    const b = stops[i + 1]!;
    if (t >= a.t && t <= b.t) {
      const f = (t - a.t) / (b.t - a.t);
      return out.copy(a.color).lerp(b.color, f);
    }
  }
  return out.copy(stops[stops.length - 1]!.color);
}

/**
 * Custom particle emitter backed by InstancedMesh.
 * CPU manages particle state; per-instance attributes drive the GPU material.
 */
class FireParticleEmitter {
  readonly mesh: THREE.InstancedMesh;
  private particles: Particle[];
  private config: EmitterConfig;
  private spawnAccumulator = 0;
  currentEmissionRate = 0;
  currentEmitterRadius: number;
  currentSizeScale = 1;
  currentOpacityScale = 1;
  currentColorScale = 1;

  // Wind force override (mutated externally)
  windForce = new THREE.Vector3();

  private static _tmpColor = new THREE.Color();
  private static _tmpMatrix = new THREE.Matrix4();
  private static _tmpVec = new THREE.Vector3();
  private static _tmpScale = new THREE.Vector3();

  constructor(config: EmitterConfig) {
    this.config = config;
    this.currentEmitterRadius = config.emitterRadius;
    const max = config.maxParticles;

    // Allocate particle pool
    this.particles = [];
    for (let i = 0; i < max; i++) {
      this.particles.push({
        position: new THREE.Vector3(),
        velocity: new THREE.Vector3(),
        life: 0,
        maxLife: 1,
        size: 1,
        baseSize: 1,
        alive: false,
      });
    }

    // Geometry: unit plane
    const geo = new THREE.PlaneGeometry(1, 1);
    const mat = new THREE.MeshBasicMaterial({
      map: config.tex,
      transparent: true,
      depthWrite: false,
      blending: config.blending,
      side: THREE.DoubleSide,
      vertexColors: true,
    });

    // InstancedMesh
    this.mesh = new THREE.InstancedMesh(geo, mat, max);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    if (config.renderOrder !== undefined) {
      this.mesh.renderOrder = config.renderOrder;
    }
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3);
  }

  update(dt: number, origin: THREE.Vector3, billboardQuat: THREE.Quaternion): void {
    const cfg = this.config;
    const tmpColor = FireParticleEmitter._tmpColor;
    const tmpMat = FireParticleEmitter._tmpMatrix;
    const tmpScale = FireParticleEmitter._tmpScale;

    // Total force = base + wind
    const forceX = cfg.baseForce.x + this.windForce.x;
    const forceY = cfg.baseForce.y + this.windForce.y;
    const forceZ = cfg.baseForce.z + this.windForce.z;

    // Update alive particles
    let visibleCount = 0;
    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i]!;
      if (!p.alive) continue;

      p.life += dt;
      if (p.life >= p.maxLife) {
        p.alive = false;
        continue;
      }

      // Apply force
      p.velocity.x += forceX * dt;
      p.velocity.y += forceY * dt;
      p.velocity.z += forceZ * dt;

      // Integrate position
      p.position.x += p.velocity.x * dt;
      p.position.y += p.velocity.y * dt;
      p.position.z += p.velocity.z * dt;

      // Normalized life
      const t = p.life / p.maxLife;

      // Size over life
      const sizeScale = lerpStops(
        cfg.sizeStops.map((s) => ({ value: s.scale, t: s.t })),
        t,
      );
      const finalSize = p.baseSize * sizeScale * this.currentSizeScale;

      // Color over life
      lerpColorStops(cfg.colorStops, t, tmpColor);

      // Opacity over life
      let opacity = lerpStops(
        cfg.opacityStops.map((s) => ({ value: s.opacity, t: s.t })),
        t,
      );
      opacity *= this.currentOpacityScale;

      // Dim + shrink as opacity falls (MeshBasicMaterial has no per-instance alpha)
      const alphaScale = Math.max(0, Math.min(1, opacity));
      tmpColor.multiplyScalar(alphaScale * this.currentColorScale);
      const scaledSize = Math.max(0.01, finalSize * (0.4 + 0.6 * alphaScale));

      // Instance matrix: billboard towards camera + scale
      tmpScale.set(scaledSize, scaledSize, scaledSize);
      tmpMat.compose(p.position, billboardQuat, tmpScale);
      this.mesh.setMatrixAt(visibleCount, tmpMat);
      this.mesh.setColorAt(visibleCount, tmpColor);

      visibleCount++;
    }

    this.mesh.count = visibleCount;
    if (visibleCount > 0) {
      this.mesh.instanceMatrix.needsUpdate = true;
      if (this.mesh.instanceColor) {
        this.mesh.instanceColor.needsUpdate = true;
      }
    }

    // Spawn new particles
    this.spawnAccumulator += this.currentEmissionRate * dt;
    while (this.spawnAccumulator >= 1) {
      this.spawnAccumulator -= 1;
      this.spawnOne(origin);
    }
  }

  private spawnOne(origin: THREE.Vector3): void {
    // Find dead particle
    let p: Particle | null = null;
    for (const candidate of this.particles) {
      if (!candidate.alive) {
        p = candidate;
        break;
      }
    }
    if (!p) return;

    const cfg = this.config;
    const r = this.currentEmitterRadius;

    // Position within emitter shape
    if (cfg.emitterShape === "cone") {
      const angle = cfg.coneAngle ?? 0.3;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.random() * angle;
      const dist = Math.random() * r;
      p.position.set(
        origin.x + Math.sin(phi) * Math.cos(theta) * dist,
        origin.y,
        origin.z + Math.sin(phi) * Math.sin(theta) * dist,
      );
      // Velocity: upward cone
      const speed = cfg.speedRange[0] + Math.random() * (cfg.speedRange[1] - cfg.speedRange[0]);
      p.velocity.set(
        Math.sin(phi) * Math.cos(theta) * speed * 0.3,
        speed,
        Math.sin(phi) * Math.sin(theta) * speed * 0.3,
      );
    } else {
      // Sphere
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      const dist = Math.random() * r;
      p.position.set(
        origin.x + Math.sin(phi) * Math.cos(theta) * dist,
        origin.y + Math.cos(phi) * dist * 0.5,
        origin.z + Math.sin(phi) * Math.sin(theta) * dist,
      );
      const speed = cfg.speedRange[0] + Math.random() * (cfg.speedRange[1] - cfg.speedRange[0]);
      p.velocity.set(
        Math.sin(phi) * Math.cos(theta) * speed,
        Math.abs(Math.cos(phi)) * speed,
        Math.sin(phi) * Math.sin(theta) * speed,
      );
    }

    p.maxLife = cfg.lifeRange[0] + Math.random() * (cfg.lifeRange[1] - cfg.lifeRange[0]);
    p.life = 0;
    p.baseSize = cfg.sizeRange[0] + Math.random() * (cfg.sizeRange[1] - cfg.sizeRange[0]);
    p.size = p.baseSize;
    p.alive = true;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}

/* ── Fire source particle group ─────────────────────────── */

class FireParticleGroup {
  flame: FireParticleEmitter;
  smoke: FireParticleEmitter;
  ember: FireParticleEmitter;
  readonly group: THREE.Group;

  private origin = new THREE.Vector3();

  constructor(
    flameTex: THREE.Texture,
    smokeTex: THREE.Texture,
    emberTex: THREE.Texture,
  ) {
    this.group = new THREE.Group();

    this.flame = new FireParticleEmitter({
      type: "flame",
      maxParticles: 300,
      emissionRate: 0,
      lifeRange: [0.4, 1.2],
      speedRange: [3, 7],
      sizeRange: [3, 7],
      emitterRadius: 2,
      emitterShape: "cone",
      coneAngle: 0.3,
      blending: THREE.AdditiveBlending,
      tex: flameTex,
      baseForce: new THREE.Vector3(0, 3, 0), // buoyancy
      colorStops: [
        { color: new THREE.Color(1, 1, 0.6), t: 0 },
        { color: new THREE.Color(1, 0.6, 0), t: 0.3 },
        { color: new THREE.Color(1, 0.2, 0), t: 0.6 },
        { color: new THREE.Color(0.6, 0, 0), t: 1 },
      ],
      opacityStops: [
        { opacity: 1, t: 0 },
        { opacity: 1, t: 0.3 },
        { opacity: 0.6, t: 0.7 },
        { opacity: 0, t: 1 },
      ],
      sizeStops: [
        { scale: 0.5, t: 0 },
        { scale: 1, t: 0.3 },
        { scale: 0.8, t: 0.5 },
        { scale: 0, t: 1 },
      ],
    });

    this.smoke = new FireParticleEmitter({
      type: "smoke",
      maxParticles: 200,
      emissionRate: 0,
      lifeRange: [2, 5],
      speedRange: [1, 3],
      sizeRange: [4, 10],
      emitterRadius: 2,
      emitterShape: "sphere",
      blending: THREE.NormalBlending,
      tex: smokeTex,
      baseForce: new THREE.Vector3(0, 1.5, 0), // buoyancy
      colorStops: [
        { color: new THREE.Color(0.15, 0.15, 0.15), t: 0 },
        { color: new THREE.Color(0.3, 0.3, 0.3), t: 0.5 },
        { color: new THREE.Color(0.4, 0.4, 0.4), t: 1 },
      ],
      opacityStops: [
        { opacity: 0.5, t: 0 },
        { opacity: 0.4, t: 0.3 },
        { opacity: 0.2, t: 0.7 },
        { opacity: 0, t: 1 },
      ],
      sizeStops: [
        { scale: 1, t: 0 },
        { scale: 1.5, t: 0.3 },
        { scale: 2, t: 0.6 },
        { scale: 3, t: 1 },
      ],
      renderOrder: -1,
    });

    this.ember = new FireParticleEmitter({
      type: "ember",
      maxParticles: 150,
      emissionRate: 0,
      lifeRange: [1, 3],
      speedRange: [5, 12],
      sizeRange: [0.4, 0.8],
      emitterRadius: 1,
      emitterShape: "sphere",
      blending: THREE.AdditiveBlending,
      tex: emberTex,
      baseForce: new THREE.Vector3(0, -9.8, 0), // gravity
      colorStops: [
        { color: new THREE.Color(1, 0.7, 0.2), t: 0 },
        { color: new THREE.Color(0.8, 0.2, 0), t: 0.5 },
        { color: new THREE.Color(0.3, 0, 0), t: 1 },
      ],
      opacityStops: [
        { opacity: 1, t: 0 },
        { opacity: 0.8, t: 0.5 },
        { opacity: 0, t: 1 },
      ],
      sizeStops: [
        { scale: 1, t: 0 },
        { scale: 0.8, t: 0.3 },
        { scale: 0.4, t: 0.6 },
        { scale: 0, t: 1 },
      ],
    });

    this.group.add(this.flame.mesh);
    this.group.add(this.smoke.mesh);
    this.group.add(this.ember.mesh);
  }

  setOrigin(pos: THREE.Vector3): void {
    this.origin.copy(pos);
  }

  update(dt: number, billboardQuat: THREE.Quaternion): void {
    // Flame origin slightly above ground
    const flameOrigin = FireParticleGroup._tmpVec.copy(this.origin);
    flameOrigin.y += 1;
    this.flame.update(dt, flameOrigin, billboardQuat);

    // Smoke origin higher
    const smokeOrigin = FireParticleGroup._tmpVec2.copy(this.origin);
    smokeOrigin.y += 3;
    this.smoke.update(dt, smokeOrigin, billboardQuat);

    // Ember origin mid
    const emberOrigin = FireParticleGroup._tmpVec3.copy(this.origin);
    emberOrigin.y += 2;
    this.ember.update(dt, emberOrigin, billboardQuat);
  }

  setWindForce(wx: number, wz: number): void {
    // Flame: wind + upward
    this.flame.windForce.set(wx, 0, wz);
    // Smoke: stronger wind drift
    this.smoke.windForce.set(wx * 2, 0, wz * 2);
    // Ember: wind (gravity is in baseForce)
    this.ember.windForce.set(wx, 0, wz);
  }

  dispose(): void {
    this.flame.dispose();
    this.smoke.dispose();
    this.ember.dispose();
  }

  private static _tmpVec = new THREE.Vector3();
  private static _tmpVec2 = new THREE.Vector3();
  private static _tmpVec3 = new THREE.Vector3();
}

/* ── Constants ─────────────────────────────────────────────── */

const EMIT_INTERVAL = 1.0; // seconds between FIRE_SPREAD events per source
const MAX_FIRES = 12;
const SPAWN_CHECK_INTERVAL = 2.0; // seconds between spawn attempts per source
const MIN_FIRE_SEPARATION = 0; // metres
const BRANCH_PUSH_SPEED = 3.2;
const SPAWN_CANDIDATES = 30;
const HEAT_UPDATE_INTERVAL = 0.5;
const BUILDING_HEAT_GAIN = 0.9;
const TREE_HEAT_GAIN = 1.4;
const HEAT_DECAY = 0.5;
const BUILDING_IGNITE_THRESHOLD = 1.2;
const TREE_IGNITE_THRESHOLD = 0.6;
const BUILDING_BIG_FIRE_THRESHOLD = 1.2;
const BUILDING_HEAT_RANGE_PAD = 18;
const TREE_HEAT_RANGE_PAD = 22;
const FLOOR_HEIGHT = 3;
const FLOOR_IGNITE_INTERVAL = 1.4;
const HEAT_DIR_RANGE_BUILDING = 70;
const HEAT_DIR_RANGE_TREE = 55;
const HEAT_DIR_SAMPLE_BUILDINGS = 120;
const HEAT_DIR_SAMPLE_TREES = 80;
const HEAT_DRIFT_SPEED = 1.2;
const GROUND_BURN_INTERVAL = 0.25;
const GROUND_BURN_ALPHA = 0.45;
const GROUND_BURN_RADIUS_SCALE = 0.32;
const BRANCH_STALL_SECONDS = 2.0;
const BRANCH_PAUSE_SECONDS = 1.0;

/* ── Types ─────────────────────────────────────────────────── */

interface FireSource {
  position: THREE.Vector3;
  birthTime: number;       // elapsed seconds since fire system started
  intensity: number;       // 0→1
  radius: number;
  maxIntensity: number;
  maxRadius: number;
  baseMaxRadius: number;
  branchDir: THREE.Vector2;
  anchor?: { type: "building" | "tree" | "ground"; index: number; yOffset: number };
  stallUntil: number;
  lockedDir: boolean;
  stalled: boolean;
  pauseUntil: number;
  paused: boolean;
  distanceSinceCycle: number;
  growthDuration: number;  // seconds to reach max
  growthRate: number;      // 1/growthDuration
  isDead: boolean;
  spawnTimer: number;

  // visual refs
  group: THREE.Group;
  light: THREE.PointLight;
  scorchMesh: THREE.Mesh;
  scorchMat: THREE.MeshBasicMaterial;

  // particle group
  particles: FireParticleGroup;
}

interface WindState {
  direction: THREE.Vector2; // normalized XZ
  speed: number;
  gustTimer: number;
  gustInterval: number;
}

interface BuildingFireState {
  heat: number;
  ignited: boolean;
  floors: number;
  litFloors: number;
  floorTimer: number;
  bigFireSpawned: boolean;
}

interface TreeFireState {
  heat: number;
  ignited: boolean;
}

function applyEmissive(mesh: THREE.Mesh, color: THREE.Color, intensity: number): void {
  const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  for (const mat of mats) {
    if ("emissive" in mat) {
      const m = mat as THREE.MeshPhongMaterial | THREE.MeshStandardMaterial;
      m.emissive.copy(color);
      m.emissiveIntensity = intensity;
      m.needsUpdate = true;
    }
  }
}

let cachedWaterCtx: CanvasRenderingContext2D | null = null;
function isWaterAt(x: number, z: number): boolean {
  if (!terrainCanvasRef || !terrainBoundsRef) return false;
  const b = terrainBoundsRef;
  const u = (x - b.xMin) / b.width;
  const v = (z - b.zMin) / b.depth;
  if (u < 0 || u > 1 || v < 0 || v > 1) return false;
  const tex = terrainCanvasRef.width;
  const px = Math.min(tex - 1, Math.max(0, Math.floor(u * tex)));
  const py = Math.min(tex - 1, Math.max(0, Math.floor(v * tex)));
  if (!cachedWaterCtx) {
    cachedWaterCtx = terrainCanvasRef.getContext("2d", { willReadFrequently: true }) as CanvasRenderingContext2D | null;
  }
  const ctx = cachedWaterCtx;
  if (!ctx) return false;
  const data = ctx.getImageData(px, py, 1, 1).data;
  const r = data[0] ?? 0;
  const g = data[1] ?? 0;
  const bcol = data[2] ?? 0;
  // Water color is painted around #3388cc
  return bcol > 140 && g > 90 && r < 90;
}

function getBuildingIndexAt(x: number, z: number): number {
  for (let i = 0; i < buildingRegistry.length; i++) {
    const b = buildingRegistry[i]!;
    const half = Math.max(3, b.width * 0.5);
    if (Math.abs(x - b.centerX) <= half && Math.abs(z - b.centerZ) <= half) return i;
  }
  return -1;
}

function isInsideBuilding(x: number, z: number): boolean {
  return getBuildingIndexAt(x, z) >= 0;
}

function clampToBuildingEdge(x: number, z: number, b: { centerX: number; centerZ: number; width: number }): { x: number; z: number } {
  const half = Math.max(3, b.width * 0.5);
  const dx = x - b.centerX;
  const dz = z - b.centerZ;
  const absDx = Math.abs(dx);
  const absDz = Math.abs(dz);
  if (absDx <= half && absDz <= half) {
    if (absDx >= absDz) {
      const nx = b.centerX + Math.sign(dx || 1) * (half + 1.5);
      return { x: nx, z };
    }
    const nz = b.centerZ + Math.sign(dz || 1) * (half + 1.5);
    return { x, z: nz };
  }
  return { x, z };
}

function isBlocked(x: number, z: number): boolean {
  return isWaterAt(x, z) || isInsideBuilding(x, z);
}

function nudgeOffWater(x: number, z: number): { x: number; z: number } {
  if (!isWaterAt(x, z)) return { x, z };
  const step = 4;
  for (let i = 0; i < 12; i++) {
    const ang = (i / 12) * Math.PI * 2;
    const nx = x + Math.cos(ang) * step;
    const nz = z + Math.sin(ang) * step;
    if (!isWaterAt(nx, nz)) return { x: nx, z: nz };
  }
  return { x, z };
}

/* ── FireSourceManager ────────────────────────────────────── */

class FireSourceManager {
  readonly sources: FireSource[] = [];
  private scene: THREE.Scene;
  private eventBus: EventBus;
  private sampler?: HeightSampler;
  private wind: WindState;
  private systemElapsed = 0;
  private maxFires: number;
  private billboardQuat = new THREE.Quaternion();
  private heatTimer = 0;
  private burnTimer = 0;
  private buildingStates: BuildingFireState[] = [];
  private treeStates: TreeFireState[] = [];
  private heatDir = new THREE.Vector2(0, 0);
  private heatVec = new THREE.Vector2(0, 0);
  private static _tmpVec = new THREE.Vector3();

  // Shared textures (created once, reused across all fire sources)
  private flameTex: THREE.Texture;
  private smokeTex: THREE.Texture;
  private emberTex: THREE.Texture;

  constructor(scene: THREE.Scene, eventBus: EventBus, sampler?: HeightSampler, maxFires?: number) {
    this.scene = scene;
    this.eventBus = eventBus;
    this.sampler = sampler;
    this.maxFires = maxFires ?? MAX_FIRES;

    // Create procedural textures once
    this.flameTex = makeFlameTexture();
    this.smokeTex = makeSmokeTexture();
    this.emberTex = makeEmberTexture();

    // Initial wind — random direction
    const angle = Math.random() * Math.PI * 2;
    this.wind = {
      direction: new THREE.Vector2(Math.cos(angle), Math.sin(angle)),
      speed: 0.3 + Math.random() * 0.3,
      gustTimer: 0,
      gustInterval: 6 + Math.random() * 6,
    };

    this.buildingStates = buildingRegistry.map((b) => ({
      heat: 0,
      ignited: false,
      floors: Math.max(1, Math.round(b.height / FLOOR_HEIGHT)),
      litFloors: 0,
      floorTimer: 0,
      bigFireSpawned: false,
    }));
    this.treeStates = treeRegistry.map(() => ({ heat: 0, ignited: false }));
  }

  spawnPrimary(offsetX = 0, offsetZ = 0, maxRadius = 35): void {
    const y = this.sampler ? this.sampler.sample(offsetX, offsetZ) : 0;
    const bIdx = getBuildingIndexAt(offsetX, offsetZ);
    let sx = offsetX;
    let sz = offsetZ;
    if (bIdx >= 0) {
      const b = buildingRegistry[bIdx]!;
      const clamped = clampToBuildingEdge(offsetX, offsetZ, b);
      sx = clamped.x;
      sz = clamped.z;
    }
    const nudged = nudgeOffWater(sx, sz);
    sx = nudged.x;
    sz = nudged.z;
    const anchor = { type: "ground" as const, index: -1, yOffset: 0 };
    const spawnY = this.sampler ? this.sampler.sample(sx, sz) : y;
    this.spawnFire(
      new THREE.Vector3(sx, spawnY, sz),
      maxRadius,
      0.8,
      30,
      anchor,
    );
    console.log(`[TestFire] Primary fire started at (${offsetX.toFixed(1)}, ${offsetZ.toFixed(1)}) radius=${maxRadius}`);
  }

  spawnAt(pos: THREE.Vector3, maxRadius: number, maxIntensity = 0.8, growthDuration = 30): FireSource {
    let sx = pos.x;
    let sz = pos.z;
    const bIdx = getBuildingIndexAt(sx, sz);
    if (bIdx >= 0) {
      const b = buildingRegistry[bIdx]!;
      const clamped = clampToBuildingEdge(sx, sz, b);
      sx = clamped.x;
      sz = clamped.z;
    }
    const nudged = nudgeOffWater(sx, sz);
    sx = nudged.x;
    sz = nudged.z;
    const y = this.sampler ? this.sampler.sample(sx, sz) : pos.y;
    return this.spawnFire(new THREE.Vector3(sx, y, sz), maxRadius, maxIntensity, growthDuration, { type: "ground", index: -1, yOffset: 0 });
  }

  private spawnFire(
    pos: THREE.Vector3,
    maxRadius: number,
    maxIntensity: number,
    growthDuration: number,
    anchor?: { type: "building" | "tree" | "ground"; index: number; yOffset: number },
  ): FireSource {
    const group = new THREE.Group();
    group.position.copy(pos);

    // Point light
    const light = new THREE.PointLight(0xff6600, 0, 50);
    light.position.y = 5;
    group.add(light);

    // Ground scorch (disabled — was creating visible circular shadows)
    const scorchMat = new THREE.MeshBasicMaterial({
      color: 0x1a1a1a,
      transparent: true,
      opacity: 0.0,
      side: THREE.DoubleSide,
    });
    const scorchMesh = new THREE.Mesh(new THREE.CircleGeometry(1, 24), scorchMat);
    scorchMesh.visible = false;

    // Particle group
    const particles = new FireParticleGroup(this.flameTex, this.smokeTex, this.emberTex);
    particles.setOrigin(pos);
    // Add particle meshes directly to scene (world space)
    this.scene.add(particles.group);

    this.scene.add(group);

    const source: FireSource = {
      position: pos.clone(),
      birthTime: this.systemElapsed,
      intensity: 0,
      radius: 5,
      maxIntensity,
      maxRadius,
      baseMaxRadius: maxRadius,
      branchDir: new THREE.Vector2((Math.random() - 0.5) * 2, (Math.random() - 0.5) * 2).normalize(),
      anchor,
      stallUntil: this.systemElapsed + BRANCH_STALL_SECONDS,
      lockedDir: false,
      stalled: false,
      pauseUntil: this.systemElapsed + BRANCH_STALL_SECONDS + BRANCH_PAUSE_SECONDS,
      paused: false,
      distanceSinceCycle: 0,
      growthDuration,
      growthRate: 1 / growthDuration,
      isDead: false,
      spawnTimer: 0,
      group,
      light,
      scorchMesh,
      scorchMat,
      particles,
    };

    this.sources.push(source);
    return source;
  }

  private spawnFireAt(
    pos: THREE.Vector3,
    maxRadius: number,
    maxIntensity: number,
    growthDuration: number,
    anchor?: { type: "building" | "tree" | "ground"; index: number; yOffset: number },
  ): FireSource {
    return this.spawnFire(pos, maxRadius, maxIntensity, growthDuration, anchor);
  }

  setBillboardQuaternion(q: THREE.Quaternion): void {
    this.billboardQuat.copy(q);
  }

  update(dt: number): void {
    this.systemElapsed += dt;
    this.updateWind(dt);

    const toRemove: FireSource[] = [];
    for (const src of this.sources) {
      if (src.isDead) continue;
      const isAnchored = !!(src.anchor && src.anchor.type !== "ground");
      if (terrainBoundsRef) {
        const b = terrainBoundsRef;
        if (src.position.x < b.xMin || src.position.x > b.xMax || src.position.z < b.zMin || src.position.z > b.zMax) {
          src.isDead = true;
          toRemove.push(src);
          continue;
        }
      }
      // Anchor fires to flammable objects (no drifting through them)
      if (src.anchor) {
        if (src.anchor.type === "ground") {
          // Keep the fire pinned to its initial ground position
          // (position is already set at spawn; no updates needed)
        } else if (src.anchor.type === "building") {
          const b = buildingRegistry[src.anchor.index];
          if (b) {
            src.position.x = b.centerX;
            src.position.z = b.centerZ;
            src.position.y = b.baseY + src.anchor.yOffset;
          }
        } else {
          const t = treeRegistry[src.anchor.index];
          if (t) {
            src.position.x = t.x;
            src.position.z = t.z;
            src.position.y = t.canopyMesh.position.y + src.anchor.yOffset;
          }
        }
      }

      this.updateGrowth(src, dt);
      this.updateVisuals(src, dt);
      this.trySpawnChildren(src, dt);
      // Push branches outward (only for drifting fires; pause during the branch window)
      if (!isAnchored && !src.stalled && (this.systemElapsed < src.stallUntil || this.systemElapsed >= src.pauseUntil)) {
        const push = BRANCH_PUSH_SPEED * (0.3 + (src.intensity / src.maxIntensity) * 0.7);
        const nx = src.position.x + src.branchDir.x * push * dt;
        const nz = src.position.z + src.branchDir.y * push * dt;
        if (!isBlocked(nx, nz)) {
          const dx = nx - src.position.x;
          const dz = nz - src.position.z;
          src.distanceSinceCycle += Math.hypot(dx, dz);
          src.position.x = nx;
          src.position.z = nz;
        }
        const idx = getBuildingIndexAt(src.position.x, src.position.z);
        if (idx >= 0) {
          const b = buildingRegistry[idx]!;
          const clamped = clampToBuildingEdge(src.position.x, src.position.z, b);
          src.position.x = clamped.x;
          src.position.z = clamped.z;
          src.stalled = true;
        }
        if (isBlocked(nx, nz) && !isAnchored) {
          src.stalled = true;
        }
      }
    }

    if (toRemove.length > 0) {
      for (const src of toRemove) {
        this.scene.remove(src.group);
        this.scene.remove(src.particles.group);
        src.particles.dispose();
      }
      for (const src of toRemove) {
        const idx = this.sources.indexOf(src);
        if (idx >= 0) this.sources.splice(idx, 1);
      }
    }

    this.updateHeat(dt);
    this.paintGroundBurn(dt);

    // Update all particle groups
    for (const src of this.sources) {
      if (src.isDead) continue;
      src.particles.update(dt, this.billboardQuat);
    }
  }

  emitEvents(): void {
    for (const src of this.sources) {
      if (src.isDead || src.intensity <= 0) continue;
      this.eventBus.emit({
        type: "FIRE_SPREAD",
        position: [src.position.x, src.position.y, src.position.z],
        intensity: src.intensity,
        radius: src.radius,
      });
    }
  }

  private updateWind(dt: number): void {
    this.wind.gustTimer += dt;
    if (this.wind.gustTimer >= this.wind.gustInterval) {
      this.wind.gustTimer = 0;
      this.wind.gustInterval = 6 + Math.random() * 6;

      // Shift direction ±36 degrees
      const shift = (Math.random() - 0.5) * (Math.PI / 5) * 2;
      const currentAngle = Math.atan2(this.wind.direction.y, this.wind.direction.x);
      const newAngle = currentAngle + shift;
      this.wind.direction.set(Math.cos(newAngle), Math.sin(newAngle));

      // Vary speed ±0.15
      this.wind.speed = Math.max(0.1, Math.min(0.8, this.wind.speed + (Math.random() - 0.5) * 0.3));
    }
  }

  private updateGrowth(src: FireSource, _dt: number): void {
    const age = this.systemElapsed - src.birthTime;
    const baseT = Math.min(age * src.growthRate, 1);

    // Stochastic noise — oscillating perturbation for organic growth
    const noise = 1.0
      + 0.08 * Math.sin(age * 1.7 + src.birthTime * 3.1)
      + 0.05 * Math.cos(age * 2.9 + src.birthTime * 1.7)
      + 0.03 * Math.sin(age * 5.3);

    const t = Math.min(baseT * noise, 1);
    src.intensity = t * src.maxIntensity;
    src.radius = 5 + t * (src.maxRadius - 5);
  }

  private computeHeatVector(src: FireSource): THREE.Vector2 {
    this.heatVec.set(0, 0);
    let total = 0;

    const maxB = Math.min(buildingRegistry.length, HEAT_DIR_SAMPLE_BUILDINGS);
    for (let i = 0; i < maxB; i++) {
      const idx = Math.floor(Math.random() * buildingRegistry.length);
      const b = buildingRegistry[idx]!;
      const dx = b.centerX - src.position.x;
      const dz = b.centerZ - src.position.z;
      const dist = Math.hypot(dx, dz);
      if (dist > HEAT_DIR_RANGE_BUILDING || dist < 0.001) continue;
      const w = 1 - dist / HEAT_DIR_RANGE_BUILDING;
      this.heatVec.x += (dx / dist) * w;
      this.heatVec.y += (dz / dist) * w;
      total += w;
    }

    const maxT = Math.min(treeRegistry.length, HEAT_DIR_SAMPLE_TREES);
    for (let i = 0; i < maxT; i++) {
      const idx = Math.floor(Math.random() * treeRegistry.length);
      const t = treeRegistry[idx]!;
      const dx = t.x - src.position.x;
      const dz = t.z - src.position.z;
      const dist = Math.hypot(dx, dz);
      if (dist > HEAT_DIR_RANGE_TREE || dist < 0.001) continue;
      const w = 1 - dist / HEAT_DIR_RANGE_TREE;
      this.heatVec.x += (dx / dist) * w * 1.3;
      this.heatVec.y += (dz / dist) * w * 1.3;
      total += w;
    }

    if (total > 0.0001) {
      this.heatVec.multiplyScalar(1 / total);
      return this.heatVec.normalize();
    }

    // fallback to wind direction if no nearby heat targets
    this.heatVec.set(this.wind.direction.x, this.wind.direction.y).normalize();
    return this.heatVec;
  }

  private trySpawnChildren(src: FireSource, dt: number): void {
    if (this.sources.length >= this.maxFires) return;
    if (src.intensity < 0.3 * src.maxIntensity) return;
    if (this.systemElapsed < src.stallUntil) return;
    if (!src.paused && this.systemElapsed >= src.pauseUntil) {
      if (src.distanceSinceCycle < 3) {
        // Not enough movement to spawn new primaries; restart cycle
        src.stallUntil = this.systemElapsed + BRANCH_STALL_SECONDS;
        src.pauseUntil = src.stallUntil + BRANCH_PAUSE_SECONDS;
        return;
      }
      src.paused = true;
      // Spawn a burst of new primaries (branch copies)
      const burst = 3 + Math.floor(Math.random() * 2);
      for (let i = 0; i < burst && this.sources.length < this.maxFires; i++) {
        const angle = Math.random() * Math.PI * 2;
        const jitterR = Math.max(1.5, src.radius * 0.35) + Math.random() * 2.5;
        let cx = src.position.x + Math.cos(angle) * jitterR;
        let cz = src.position.z + Math.sin(angle) * jitterR;
        const bIdx = getBuildingIndexAt(cx, cz);
        if (bIdx >= 0) {
          const b = buildingRegistry[bIdx]!;
          const clamped = clampToBuildingEdge(cx, cz, b);
          cx = clamped.x;
          cz = clamped.z;
        }
        const nudged = nudgeOffWater(cx, cz);
        cx = nudged.x;
        cz = nudged.z;
        if (isBlocked(cx, cz)) continue;
        const y = this.sampler ? this.sampler.sample(cx, cz) : src.position.y;
        const branch = this.spawnFireAt(new THREE.Vector3(cx, y, cz), src.maxRadius * 0.9, 0.7, 20);
        branch.branchDir.set(Math.cos(angle), Math.sin(angle)).normalize();
      }
      // Reset for next cycle
      src.stallUntil = this.systemElapsed + BRANCH_STALL_SECONDS;
      src.pauseUntil = src.stallUntil + BRANCH_PAUSE_SECONDS;
      src.paused = false;
      src.distanceSinceCycle = 0;
    }

    src.spawnTimer += dt;
    if (src.spawnTimer < SPAWN_CHECK_INTERVAL) return;
    src.spawnTimer = 0;

    // Sample candidate positions around perimeter (all directions)
    const windAngle = Math.atan2(this.wind.direction.y, this.wind.direction.x);
    const heatDir = this.computeHeatVector(src);
    if (!src.lockedDir) {
      src.branchDir.copy(heatDir).normalize();
      src.lockedDir = true;
    }

    for (let i = 0; i < SPAWN_CANDIDATES; i++) {
      if (this.sources.length >= this.maxFires) break;

      const baseAngle = Math.atan2(heatDir.y, heatDir.x);
      const jitter = (Math.random() - 0.5) * Math.PI;
      const candidateAngle = baseAngle + jitter;
      // Spawn at origin, then branch outward over time
      const jitterR = 0.5 + Math.random() * 1.0;
      let cx = src.position.x + Math.cos(candidateAngle) * jitterR;
      let cz = src.position.z + Math.sin(candidateAngle) * jitterR;
      const bIdx = getBuildingIndexAt(cx, cz);
      if (bIdx >= 0) {
        const b = buildingRegistry[bIdx]!;
        const clamped = clampToBuildingEdge(cx, cz, b);
        cx = clamped.x;
        cz = clamped.z;
      }
      if (isBlocked(cx, cz)) continue;

      // Wind bias: candidates downwind get +0.3 probability
      const angleDiff = Math.abs(((candidateAngle - windAngle + Math.PI) % (Math.PI * 2)) - Math.PI);
      const windBonus = angleDiff < Math.PI / 2 ? 0.3 : 0;

      const spawnProb = (src.intensity / src.maxIntensity) * 0.28 + windBonus + 0.1;
      if (Math.random() > spawnProb) continue;

      // Check separation from all existing fires
      let tooClose = false;
      for (const other of this.sources) {
        if (other.isDead) continue;
        const dx = cx - other.position.x;
        const dz = cz - other.position.z;
        if (Math.sqrt(dx * dx + dz * dz) < MIN_FIRE_SEPARATION) {
          tooClose = true;
          break;
        }
      }
      if (tooClose) continue;

      const y = this.sampler ? this.sampler.sample(cx, cz) : 0;
      // Heat score to decide branching and size
      let heatScore = 0;
      const rangeB = HEAT_DIR_RANGE_BUILDING * 0.7;
      const rangeT = HEAT_DIR_RANGE_TREE * 0.7;
      for (let j = 0; j < 20 && buildingRegistry.length > 0; j++) {
        const b = buildingRegistry[Math.floor(Math.random() * buildingRegistry.length)]!;
        const dx = b.centerX - cx;
        const dz = b.centerZ - cz;
        const dist = Math.hypot(dx, dz);
        if (dist < rangeB) heatScore += 1 - dist / rangeB;
      }
      for (let j = 0; j < 16 && treeRegistry.length > 0; j++) {
        const t = treeRegistry[Math.floor(Math.random() * treeRegistry.length)]!;
        const dx = t.x - cx;
        const dz = t.z - cz;
        const dist = Math.hypot(dx, dz);
        if (dist < rangeT) heatScore += (1 - dist / rangeT) * 1.3;
      }
      heatScore = Math.min(1.5, heatScore / 6);

      const newMaxRadius = 12 + heatScore * 18 + Math.random() * 6;
      const newMaxIntensity = 0.5 + heatScore * 0.35;
      const newGrowthDuration = 14 + Math.random() * 10;

      const newSource = this.spawnFire(new THREE.Vector3(cx, y, cz), newMaxRadius, newMaxIntensity, newGrowthDuration);
      newSource.branchDir.set(Math.cos(candidateAngle), Math.sin(candidateAngle)).normalize();
      // Branching: creep the parent toward the new hotspot and let it grow larger
      if (!isBlocked(cx, cz)) {
        src.position.lerp(new THREE.Vector3(cx, src.position.y, cz), 0.12);
      }
      src.maxRadius = Math.min(src.baseMaxRadius * 2.0, src.maxRadius * (1.04 + heatScore * 0.08));

      if (heatScore > 0.9 && this.sources.length < this.maxFires) {
        const extraAngle = candidateAngle + (Math.random() - 0.5) * 0.8;
        const ex = src.position.x + Math.cos(extraAngle) * (jitterR * 0.6);
        const ez = src.position.z + Math.sin(extraAngle) * (jitterR * 0.6);
        if (isBlocked(ex, ez)) {
          continue;
        }
        const ey = this.sampler ? this.sampler.sample(ex, ez) : 0;
        const extra = this.spawnFire(new THREE.Vector3(ex, ey, ez), newMaxRadius * 0.9, newMaxIntensity * 0.95, newGrowthDuration);
        extra.branchDir.set(Math.cos(extraAngle), Math.sin(extraAngle)).normalize();
      }
      console.log(`[TestFire] Secondary fire spawned at (${cx.toFixed(1)}, ${cz.toFixed(1)}) — total fires: ${this.sources.length}`);
    }
  }

  private updateVisuals(src: FireSource, _dt: number): void {
    const age = this.systemElapsed - src.birthTime;
    const t = src.intensity / src.maxIntensity;
    const flicker = 0.85 + 0.15 * Math.sin(age * 12);

    // Scale emission rates with intensity
    src.particles.flame.currentEmissionRate = t * 60;
    src.particles.smoke.currentEmissionRate = t * 18;
    src.particles.ember.currentEmissionRate = t * 12;

    // Scale emitter radius with fire spread
    src.particles.flame.currentEmitterRadius = Math.max(1, src.radius * 0.3);
    src.particles.smoke.currentEmitterRadius = Math.max(1, src.radius * 0.3);
    src.particles.ember.currentEmitterRadius = Math.max(0.5, src.radius * 0.15);

    // Smoke size + darkness scale with intensity
    src.particles.smoke.currentSizeScale = 0.9 + t * 1.6;
    src.particles.smoke.currentOpacityScale = 0.5 + t * 0.9;
    src.particles.smoke.currentColorScale = Math.max(0.35, 0.9 - t * 0.45);

    // Update wind force directions
    const wx = this.wind.direction.x * this.wind.speed;
    const wz = this.wind.direction.y * this.wind.speed;
    src.particles.setWindForce(wx, wz);

    // Update origin (in case position changes)
    src.particles.setOrigin(src.position);

    // Light
    src.light.intensity = src.intensity * 80 * flicker;
    src.light.distance = src.radius * 1.8;

    // Ground scorch disabled
  }

  private paintGroundBurn(dt: number): void {
    if (!terrainCanvasRef || !terrainBoundsRef || !terrainTextureRef) return;
    this.burnTimer += dt;
    if (this.burnTimer < GROUND_BURN_INTERVAL) return;
    this.burnTimer = 0;

    const b = terrainBoundsRef;
    const tex = terrainCanvasRef.width;
    const ctx = cachedWaterCtx ?? terrainCanvasRef.getContext("2d", { willReadFrequently: true }) as CanvasRenderingContext2D | null;
    if (!cachedWaterCtx && ctx) cachedWaterCtx = ctx;
    if (!ctx) return;

    for (const src of this.sources) {
      if (src.isDead || src.intensity <= 0.2) continue;
      const u = (src.position.x - b.xMin) / b.width;
      const v = (src.position.z - b.zMin) / b.depth;
      if (u < 0 || u > 1 || v < 0 || v > 1) continue;
      const cx = u * tex;
      const cy = v * tex;
      const r = Math.max(2, (src.radius / b.width) * tex * GROUND_BURN_RADIUS_SCALE);
      ctx.save();
      ctx.globalAlpha = GROUND_BURN_ALPHA * Math.min(1, src.intensity / src.maxIntensity);
      ctx.fillStyle = "#000000";
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
    terrainTextureRef.needsUpdate = true;
  }

  private updateHeat(dt: number): void {
    this.heatTimer += dt;
    if (this.heatTimer < HEAT_UPDATE_INTERVAL) return;
    const step = this.heatTimer;
    this.heatTimer = 0;

    const activeSources = this.sources.filter((s) => !s.isDead && s.intensity > 0.2);

    // Buildings: accumulate heat from nearby fires
    for (let i = 0; i < buildingRegistry.length; i++) {
      const b = buildingRegistry[i]!;
      const state = this.buildingStates[i]!;

      let heatAdd = 0;
      for (const src of activeSources) {
        const dx = b.centerX - src.position.x;
        const dz = b.centerZ - src.position.z;
        const dist = Math.hypot(dx, dz);
        const range = src.radius + BUILDING_HEAT_RANGE_PAD;
        if (dist <= Math.max(3, b.width * 0.5)) {
          // Fire is inside/against the footprint — immediate heating
          heatAdd += 1.8 * src.intensity;
          continue;
        }
        if (dist > range) continue;
        const falloff = 1 - dist / range;
        heatAdd += falloff * src.intensity;
      }

      state.heat = Math.max(0, state.heat - HEAT_DECAY * step * 0.6);
      if (heatAdd > 0) {
        state.heat += heatAdd * BUILDING_HEAT_GAIN * step * 1.4;
      }

      if (!state.ignited && state.heat >= BUILDING_IGNITE_THRESHOLD) {
        state.ignited = true;
        state.floorTimer = 0;
        state.litFloors = 0;
        applyEmissive(b.mesh, new THREE.Color(0x552200), 0.2);
      }

      if (state.ignited) {
        state.floorTimer += step;
        while (state.litFloors < state.floors && state.floorTimer >= FLOOR_IGNITE_INTERVAL) {
          state.floorTimer -= FLOOR_IGNITE_INTERVAL;
          state.litFloors++;

          const y = b.baseY + Math.min(b.height - 1, state.litFloors * FLOOR_HEIGHT - 0.5);
          if (this.sources.length < this.maxFires) {
            this.spawnFireAt(
              new THREE.Vector3(b.centerX, y, b.centerZ),
              10,
              0.55,
              18,
              { type: "building", index: i, yOffset: y - b.baseY },
            );
            // drifting copy
            const drift = this.spawnFireAt(
              new THREE.Vector3(b.centerX, y, b.centerZ),
              8,
              0.45,
              16,
            );
            drift.branchDir.set(Math.random() - 0.5, Math.random() - 0.5).normalize();
          }
          state.ignited = true;
        }
        const ratio = Math.min(1, state.litFloors / Math.max(1, state.floors));
        applyEmissive(b.mesh, new THREE.Color(0x662200), 0.15 + 0.35 * ratio);
      }

      if (!state.bigFireSpawned && state.heat >= BUILDING_BIG_FIRE_THRESHOLD) {
        state.bigFireSpawned = true;
        const base = Math.max(12, b.width * 0.8);
        const bigRadius = Math.min(80, base + b.height * 0.08);
        const y = b.baseY + Math.min(b.height - 1, b.height * 0.5);
        if (this.sources.length < this.maxFires) {
          this.spawnFireAt(
            new THREE.Vector3(b.centerX, y, b.centerZ),
            bigRadius,
            0.95,
            22,
            { type: "building", index: i, yOffset: y - b.baseY },
          );
          const drift = this.spawnFireAt(
            new THREE.Vector3(b.centerX, y, b.centerZ),
            bigRadius * 0.6,
            0.7,
            18,
          );
          drift.branchDir.set(Math.random() - 0.5, Math.random() - 0.5).normalize();
        }
      }
    }

    // Trees: heat up faster, ignite quickly
    for (let i = 0; i < treeRegistry.length; i++) {
      const t = treeRegistry[i]!;
      const state = this.treeStates[i]!;

      let heatAdd = 0;
      for (const src of activeSources) {
        const dx = t.x - src.position.x;
        const dz = t.z - src.position.z;
        const range = src.radius + TREE_HEAT_RANGE_PAD;
        const dist = Math.hypot(dx, dz);
        if (dist > range) continue;
        const falloff = 1 - dist / range;
        heatAdd += falloff * src.intensity;
      }

      state.heat = Math.max(0, state.heat - HEAT_DECAY * step);
      if (heatAdd > 0) {
        state.heat += heatAdd * TREE_HEAT_GAIN * step;
      }

      if (!state.ignited && state.heat >= TREE_IGNITE_THRESHOLD) {
        state.ignited = true;
        t.canopyMesh.material = (t.canopyMesh.material as THREE.MeshPhongMaterial).clone();
        (t.canopyMesh.material as THREE.MeshPhongMaterial).color.set(0x2b2b2b);
        if (this.sources.length < this.maxFires) {
          const y = t.canopyMesh.position.y - 1.5;
          this.spawnFireAt(new THREE.Vector3(t.x, y, t.z), 7, 0.45, 14, { type: "tree", index: i, yOffset: -1.5 });
          const drift = this.spawnFireAt(new THREE.Vector3(t.x, y, t.z), 6, 0.4, 12);
          drift.branchDir.set(Math.random() - 0.5, Math.random() - 0.5).normalize();
        }
      }
    }
  }
}

/* ── Public entry point ──────────────────────────────────── */

const DEFAULT_FIRE_MAX_RADIUS = 35;
const DEFAULT_FIRE_MAX_FIRES = 12;

export class FireSimulator {
  active = false;
  maxRadius = DEFAULT_FIRE_MAX_RADIUS;
  maxFires = DEFAULT_FIRE_MAX_FIRES;

  private scene: THREE.Scene;
  private eventBus: EventBus | null = null;
  private sampler?: HeightSampler;
  private manager: FireSourceManager | null = null;
  private emitTimer = 0;
  private billboardQuat = new THREE.Quaternion();

  constructor(scene: THREE.Scene) {
    this.scene = scene;
  }

  setContext(eventBus: EventBus | null, sampler?: HeightSampler): void {
    this.eventBus = eventBus;
    this.sampler = sampler;
  }

  setBillboardQuaternion(q: THREE.Quaternion): void {
    this.billboardQuat.copy(q);
    if (this.manager) this.manager.setBillboardQuaternion(this.billboardQuat);
  }

  setMaxRadius(radius: number): void {
    this.maxRadius = Math.max(5, radius);
  }

  setMaxFires(count: number): void {
    this.maxFires = Math.max(1, count);
  }

  spawn(position: THREE.Vector3): void {
    if (!this.eventBus) return;
    if (!this.manager) {
      this.manager = new FireSourceManager(this.scene, this.eventBus, this.sampler, this.maxFires);
      this.manager.spawnPrimary(position.x, position.z, this.maxRadius);
      this.active = true;
      this.emitTimer = 0;
      return;
    }
    // Add a new primary without freezing existing fires
    this.manager.spawnAt(position, this.maxRadius, 0.8, 30);
    this.active = true;
  }

  stop(): void {
    this.active = false;
    this.emitTimer = 0;
    this.manager = null;
  }

  update(dt: number): void {
    if (!this.active || !this.manager) return;
    this.manager.setBillboardQuaternion(this.billboardQuat);
    this.manager.update(dt);
    this.emitTimer += dt;
    if (this.emitTimer >= EMIT_INTERVAL) {
      this.emitTimer -= EMIT_INTERVAL;
      this.manager.emitEvents();
    }
  }
}
