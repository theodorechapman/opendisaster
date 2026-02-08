/**
 * TestFire scenario — multi-source stochastic fire spread with wind,
 * custom InstancedMesh + SpriteNodeMaterial particle visuals (flames, smoke, embers),
 * and per-source event emission.
 *
 * Self-contained and easily removable:
 *   1. Delete this file
 *   2. Remove the import + `startTestFire(...)` call in main.ts
 */

import * as THREE from "three";
import { SpriteNodeMaterial } from "three/webgpu";
import {
  instancedBufferAttribute,
  texture,
  mix,
  float,
  vec3,
  vec4,
  smoothstep,
  uniform,
} from "three/tsl";
import type { EventBus } from "../core/EventBus.ts";
import type { HeightSampler } from "../layers.ts";

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
 * Custom particle emitter backed by InstancedMesh + SpriteNodeMaterial.
 * CPU manages particle state; per-instance attributes drive the GPU material.
 */
class FireParticleEmitter {
  readonly mesh: THREE.InstancedMesh;
  private particles: Particle[];
  private config: EmitterConfig;
  private spawnAccumulator = 0;
  currentEmissionRate = 0;
  currentEmitterRadius: number;

  // Per-instance attribute buffers
  private lifeArray: Float32Array;
  private colorArray: Float32Array;   // RGBA per instance
  private scaleArray: Float32Array;

  private lifeAttr: THREE.InstancedBufferAttribute;
  private colorAttr: THREE.InstancedBufferAttribute;
  private scaleAttr: THREE.InstancedBufferAttribute;

  // Wind force override (mutated externally)
  windForce = new THREE.Vector3();

  private static _tmpColor = new THREE.Color();
  private static _tmpMatrix = new THREE.Matrix4();
  private static _tmpVec = new THREE.Vector3();

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

    // Per-instance buffers
    this.lifeArray = new Float32Array(max);
    this.colorArray = new Float32Array(max * 4);
    this.scaleArray = new Float32Array(max);

    this.lifeAttr = new THREE.InstancedBufferAttribute(this.lifeArray, 1);
    this.lifeAttr.setUsage(THREE.DynamicDrawUsage);
    this.colorAttr = new THREE.InstancedBufferAttribute(this.colorArray, 4);
    this.colorAttr.setUsage(THREE.DynamicDrawUsage);
    this.scaleAttr = new THREE.InstancedBufferAttribute(this.scaleArray, 1);
    this.scaleAttr.setUsage(THREE.DynamicDrawUsage);

    // Geometry: unit plane
    const geo = new THREE.PlaneGeometry(1, 1);
    geo.setAttribute("aLife", this.lifeAttr);
    geo.setAttribute("aColor", this.colorAttr);
    geo.setAttribute("aScale", this.scaleAttr);

    // SpriteNodeMaterial with TSL nodes
    const mat = new SpriteNodeMaterial();
    mat.transparent = true;
    mat.depthWrite = false;
    mat.blending = config.blending;
    if (config.renderOrder !== undefined) {
      mat.depthTest = true;
    }

    // TSL: read per-instance attributes
    const iColor = instancedBufferAttribute(this.colorAttr, "vec4");
    const iScale = instancedBufferAttribute(this.scaleAttr, "float");

    // Texture map
    const texNode = texture(config.tex);

    // Color: instance color RGB * texture
    mat.colorNode = vec4(
      vec3(iColor.x, iColor.y, iColor.z).mul(texNode.rgb),
      texNode.a.mul(iColor.w),
    );
    mat.opacityNode = texNode.a.mul(iColor.w);
    mat.scaleNode = iScale;

    // InstancedMesh
    this.mesh = new THREE.InstancedMesh(geo, mat, max);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    if (config.renderOrder !== undefined) {
      this.mesh.renderOrder = config.renderOrder;
    }
  }

  update(dt: number, origin: THREE.Vector3): void {
    const cfg = this.config;
    const tmpColor = FireParticleEmitter._tmpColor;
    const tmpMat = FireParticleEmitter._tmpMatrix;

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
      const finalSize = p.baseSize * sizeScale;

      // Color over life
      lerpColorStops(cfg.colorStops, t, tmpColor);

      // Opacity over life
      const opacity = lerpStops(
        cfg.opacityStops.map((s) => ({ value: s.opacity, t: s.t })),
        t,
      );

      // Write per-instance data
      this.scaleArray[visibleCount] = finalSize;
      const ci = visibleCount * 4;
      this.colorArray[ci] = tmpColor.r;
      this.colorArray[ci + 1] = tmpColor.g;
      this.colorArray[ci + 2] = tmpColor.b;
      this.colorArray[ci + 3] = opacity;
      this.lifeArray[visibleCount] = t;

      // Instance matrix: translation only (SpriteNodeMaterial handles billboard)
      tmpMat.makeTranslation(p.position.x, p.position.y, p.position.z);
      this.mesh.setMatrixAt(visibleCount, tmpMat);

      visibleCount++;
    }

    this.mesh.count = visibleCount;
    if (visibleCount > 0) {
      this.mesh.instanceMatrix.needsUpdate = true;
      this.lifeAttr.needsUpdate = true;
      this.colorAttr.needsUpdate = true;
      this.scaleAttr.needsUpdate = true;
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

  update(dt: number): void {
    // Flame origin slightly above ground
    const flameOrigin = FireParticleGroup._tmpVec.copy(this.origin);
    flameOrigin.y += 1;
    this.flame.update(dt, flameOrigin);

    // Smoke origin higher
    const smokeOrigin = FireParticleGroup._tmpVec2.copy(this.origin);
    smokeOrigin.y += 3;
    this.smoke.update(dt, smokeOrigin);

    // Ember origin mid
    const emberOrigin = FireParticleGroup._tmpVec3.copy(this.origin);
    emberOrigin.y += 2;
    this.ember.update(dt, emberOrigin);
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

const DELAY_SEC = 10;
const EMIT_INTERVAL = 1.0; // seconds between FIRE_SPREAD events per source
const MAX_FIRES = 12;
const SPAWN_CHECK_INTERVAL = 2.0; // seconds between spawn attempts per source
const MIN_FIRE_SEPARATION = 20; // metres
const SPAWN_CANDIDATES = 8;

/* ── Types ─────────────────────────────────────────────────── */

interface FireSource {
  position: THREE.Vector3;
  birthTime: number;       // elapsed seconds since fire system started
  intensity: number;       // 0→1
  radius: number;
  maxIntensity: number;
  maxRadius: number;
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

/* ── FireSourceManager ────────────────────────────────────── */

class FireSourceManager {
  readonly sources: FireSource[] = [];
  private scene: THREE.Scene;
  private eventBus: EventBus;
  private sampler?: HeightSampler;
  private wind: WindState;
  private systemElapsed = 0;
  private maxFires: number;

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
  }

  spawnPrimary(offsetX = 0, offsetZ = 0, maxRadius = 35): void {
    const y = this.sampler ? this.sampler.sample(offsetX, offsetZ) : 0;
    this.spawnFire(new THREE.Vector3(offsetX, y, offsetZ), maxRadius, 0.8, 30);
    console.log(`[TestFire] Primary fire started at (${offsetX.toFixed(1)}, ${offsetZ.toFixed(1)}) radius=${maxRadius}`);
  }

  private spawnFire(pos: THREE.Vector3, maxRadius: number, maxIntensity: number, growthDuration: number): FireSource {
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

  update(dt: number): void {
    this.systemElapsed += dt;
    this.updateWind(dt);

    for (const src of this.sources) {
      if (src.isDead) continue;
      this.updateGrowth(src, dt);
      this.updateVisuals(src, dt);
      this.trySpawnChildren(src, dt);
    }

    // Update all particle groups
    for (const src of this.sources) {
      if (src.isDead) continue;
      src.particles.update(dt);
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

  private trySpawnChildren(src: FireSource, dt: number): void {
    if (this.sources.length >= this.maxFires) return;
    if (src.intensity < 0.3 * src.maxIntensity) return;

    src.spawnTimer += dt;
    if (src.spawnTimer < SPAWN_CHECK_INTERVAL) return;
    src.spawnTimer = 0;

    // Sample candidate positions around perimeter
    const windAngle = Math.atan2(this.wind.direction.y, this.wind.direction.x);

    for (let i = 0; i < SPAWN_CANDIDATES; i++) {
      if (this.sources.length >= this.maxFires) break;

      const candidateAngle = (i / SPAWN_CANDIDATES) * Math.PI * 2;
      const offset = src.radius + 5 + Math.random() * 10;
      const cx = src.position.x + Math.cos(candidateAngle) * offset;
      const cz = src.position.z + Math.sin(candidateAngle) * offset;

      // Wind bias: candidates downwind get +0.3 probability
      const angleDiff = Math.abs(((candidateAngle - windAngle + Math.PI) % (Math.PI * 2)) - Math.PI);
      const windBonus = angleDiff < Math.PI / 2 ? 0.3 : 0;

      const spawnProb = (src.intensity / src.maxIntensity) * 0.15 + windBonus;
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
      const newMaxRadius = 15 + Math.random() * 10;
      const newMaxIntensity = 0.5 + Math.random() * 0.2;
      const newGrowthDuration = 20 + Math.random() * 10;

      this.spawnFire(new THREE.Vector3(cx, y, cz), newMaxRadius, newMaxIntensity, newGrowthDuration);
      console.log(`[TestFire] Secondary fire spawned at (${cx.toFixed(1)}, ${cz.toFixed(1)}) — total fires: ${this.sources.length}`);
    }
  }

  private updateVisuals(src: FireSource, _dt: number): void {
    const age = this.systemElapsed - src.birthTime;
    const t = src.intensity / src.maxIntensity;
    const flicker = 0.85 + 0.15 * Math.sin(age * 12);

    // Scale emission rates with intensity
    src.particles.flame.currentEmissionRate = t * 60;
    src.particles.smoke.currentEmissionRate = t * 15;
    src.particles.ember.currentEmissionRate = t * 12;

    // Scale emitter radius with fire spread
    src.particles.flame.currentEmitterRadius = Math.max(1, src.radius * 0.3);
    src.particles.smoke.currentEmitterRadius = Math.max(1, src.radius * 0.3);
    src.particles.ember.currentEmitterRadius = Math.max(0.5, src.radius * 0.15);

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
}

/* ── Public entry point ──────────────────────────────────── */

export interface FireConfig {
  offsetX: number;      // meters offset from center
  offsetZ: number;      // meters offset from center
  maxRadius: number;    // initial fire max radius (default 35)
  maxFires: number;     // max secondary fires (default 12)
}

export const DEFAULT_FIRE_CONFIG: FireConfig = {
  offsetX: 0,
  offsetZ: 0,
  maxRadius: 35,
  maxFires: 12,
};

export function startTestFire(scene: THREE.Scene, eventBus: EventBus, sampler?: HeightSampler, config?: FireConfig): void {
  const cfg = config ?? DEFAULT_FIRE_CONFIG;
  const manager = new FireSourceManager(scene, eventBus, sampler, cfg.maxFires);

  let started = false;
  let delayElapsed = 0;
  let emitTimer = 0;

  let prev = performance.now();

  function tick() {
    const now = performance.now();
    const dt = (now - prev) / 1000;
    prev = now;

    if (!started) {
      delayElapsed += dt;
      if (delayElapsed >= DELAY_SEC) {
        started = true;
        manager.spawnPrimary(cfg.offsetX, cfg.offsetZ, cfg.maxRadius);
      }
      requestAnimationFrame(tick);
      return;
    }

    manager.update(dt);

    // Emit FIRE_SPREAD events periodically
    emitTimer += dt;
    if (emitTimer >= EMIT_INTERVAL) {
      emitTimer -= EMIT_INTERVAL;
      manager.emitEvents();
    }

    requestAnimationFrame(tick);
  }

  requestAnimationFrame(tick);
}
