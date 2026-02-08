/**
 * TestFire scenario — multi-source stochastic fire spread with wind,
 * three.quarks particle visuals (flames, smoke, embers, scorch),
 * and per-source event emission.
 *
 * Self-contained and easily removable:
 *   1. Delete this file
 *   2. Remove the import + `startTestFire(...)` call in main.ts
 */

import * as THREE from "three";
import {
  ParticleSystem,
  BatchedRenderer,
  ConeEmitter,
  SphereEmitter,
  ConstantValue,
  IntervalValue,
  ConstantColor,
  ColorOverLife,
  SizeOverLife,
  ApplyForce,
  Gradient,
  PiecewiseBezier,
  Bezier,
  RenderMode,
  Vector3 as QVector3,
  Vector4 as QVector4,
} from "three.quarks";
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

  // particle systems
  flameSystem: ParticleSystem;
  smokeSystem: ParticleSystem;
  emberSystem: ParticleSystem;

  // mutable behavior refs for wind updates
  flameForce: ApplyForce;
  smokeForce: ApplyForce;
  emberForce: ApplyForce;
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
  private batchedRenderer: BatchedRenderer;

  // Shared textures (created once, reused across all fire sources)
  private flameTex: THREE.Texture;
  private smokeTex: THREE.Texture;
  private emberTex: THREE.Texture;

  constructor(scene: THREE.Scene, eventBus: EventBus, sampler?: HeightSampler) {
    this.scene = scene;
    this.eventBus = eventBus;
    this.sampler = sampler;

    // BatchedRenderer manages GPU-instanced particle rendering
    this.batchedRenderer = new BatchedRenderer();
    this.scene.add(this.batchedRenderer);

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

  spawnPrimary(): void {
    const y = this.sampler ? this.sampler.sample(0, 0) : 0;
    this.spawnFire(new THREE.Vector3(0, y, 0), 35, 0.8, 30);
    console.log("[TestFire] Primary fire started at scene center!");
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

    // Wind force direction (shared across particle systems, updated per frame)
    const windDir = new QVector3(
      this.wind.direction.x * this.wind.speed,
      0,
      this.wind.direction.y * this.wind.speed,
    );

    // ── Flame particle system ──
    const flameForce = new ApplyForce(
      new QVector3(windDir.x, 1, windDir.z), // upward + wind
      new ConstantValue(3),
    );
    const flameMat = new THREE.MeshBasicMaterial({
      map: this.flameTex,
      color: 0xffffff,
      transparent: true,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const flameSystem = new ParticleSystem({
      duration: 5,
      looping: true,
      worldSpace: true,
      shape: new ConeEmitter({ radius: 2, angle: 0.3 }), // narrow upward cone
      startLife: new IntervalValue(0.4, 1.2),
      startSpeed: new IntervalValue(3, 7),
      startSize: new IntervalValue(3, 7),
      startColor: new ConstantColor(new QVector4(1, 1, 0.7, 1)), // warm yellow-white
      emissionOverTime: new ConstantValue(0), // starts at 0, scaled with intensity
      material: flameMat,
      renderMode: RenderMode.BillBoard,
      behaviors: [
        new ColorOverLife(new Gradient(
          [
            [new QVector3(1, 1, 0.6), 0],    // yellow-white
            [new QVector3(1, 0.6, 0), 0.3],  // orange
            [new QVector3(1, 0.2, 0), 0.6],  // red-orange
            [new QVector3(0.6, 0, 0), 1],    // dark red
          ],
          [
            [1, 0],
            [1, 0.3],
            [0.6, 0.7],
            [0, 1],
          ],
        )),
        new SizeOverLife(new PiecewiseBezier([
          [new Bezier(0.5, 1, 1, 0.8), 0.5],   // grow
          [new Bezier(0.8, 0.6, 0.3, 0), 1],    // shrink
        ])),
        flameForce,
      ],
    });
    flameSystem.emitter.position.set(0, 1, 0);
    group.add(flameSystem.emitter);
    this.batchedRenderer.addSystem(flameSystem);

    // ── Smoke particle system ──
    const smokeForce = new ApplyForce(
      new QVector3(windDir.x * 2, 1.5, windDir.z * 2), // stronger wind drift + buoyancy
      new ConstantValue(2),
    );
    const smokeMat = new THREE.MeshBasicMaterial({
      map: this.smokeTex,
      color: 0x888888,
      transparent: true,
      opacity: 0.8,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const smokeSystem = new ParticleSystem({
      duration: 5,
      looping: true,
      worldSpace: true,
      shape: new SphereEmitter({ radius: 2 }),
      startLife: new IntervalValue(2, 5),
      startSpeed: new IntervalValue(1, 3),
      startSize: new IntervalValue(4, 10),
      startColor: new ConstantColor(new QVector4(0.15, 0.15, 0.15, 0.5)), // dark gray
      emissionOverTime: new ConstantValue(0),
      material: smokeMat,
      renderMode: RenderMode.BillBoard,
      renderOrder: -1, // render behind flames
      behaviors: [
        new ColorOverLife(new Gradient(
          [
            [new QVector3(0.15, 0.15, 0.15), 0],  // dark gray
            [new QVector3(0.3, 0.3, 0.3), 0.5],   // lighter gray
            [new QVector3(0.4, 0.4, 0.4), 1],     // light gray
          ],
          [
            [0.5, 0],
            [0.4, 0.3],
            [0.2, 0.7],
            [0, 1],
          ],
        )),
        new SizeOverLife(new PiecewiseBezier([
          [new Bezier(1, 1.5, 2, 3), 1], // expand over lifetime
        ])),
        smokeForce,
      ],
    });
    smokeSystem.emitter.position.set(0, 3, 0);
    group.add(smokeSystem.emitter);
    this.batchedRenderer.addSystem(smokeSystem);

    // ── Ember particle system ──
    const emberForce = new ApplyForce(
      new QVector3(windDir.x, -9.8, windDir.z), // gravity + wind
      new ConstantValue(1),
    );
    const emberMat = new THREE.MeshBasicMaterial({
      map: this.emberTex,
      color: 0xffffff,
      transparent: true,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const emberSystem = new ParticleSystem({
      duration: 5,
      looping: true,
      worldSpace: true,
      shape: new SphereEmitter({ radius: 1 }),
      startLife: new IntervalValue(1, 3),
      startSpeed: new IntervalValue(5, 12),
      startSize: new IntervalValue(0.4, 0.8),
      startColor: new ConstantColor(new QVector4(1, 0.7, 0.2, 1)), // orange-yellow
      emissionOverTime: new ConstantValue(0),
      material: emberMat,
      renderMode: RenderMode.BillBoard,
      behaviors: [
        new ColorOverLife(new Gradient(
          [
            [new QVector3(1, 0.7, 0.2), 0],   // bright orange
            [new QVector3(0.8, 0.2, 0), 0.5],  // dim red
            [new QVector3(0.3, 0, 0), 1],      // dark red
          ],
          [
            [1, 0],
            [0.8, 0.5],
            [0, 1],
          ],
        )),
        new SizeOverLife(new PiecewiseBezier([
          [new Bezier(1, 0.8, 0.4, 0), 1], // shrink over life
        ])),
        emberForce,
      ],
    });
    emberSystem.emitter.position.set(0, 2, 0);
    group.add(emberSystem.emitter);
    this.batchedRenderer.addSystem(emberSystem);

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
      flameSystem,
      smokeSystem,
      emberSystem,
      flameForce,
      smokeForce,
      emberForce,
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

    // Update all particle systems through the batched renderer
    this.batchedRenderer.update(dt);
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
    if (this.sources.length >= MAX_FIRES) return;
    if (src.intensity < 0.3 * src.maxIntensity) return;

    src.spawnTimer += dt;
    if (src.spawnTimer < SPAWN_CHECK_INTERVAL) return;
    src.spawnTimer = 0;

    // Sample candidate positions around perimeter
    const windAngle = Math.atan2(this.wind.direction.y, this.wind.direction.x);

    for (let i = 0; i < SPAWN_CANDIDATES; i++) {
      if (this.sources.length >= MAX_FIRES) break;

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
    src.flameSystem.emissionOverTime = new ConstantValue(t * 60);
    src.smokeSystem.emissionOverTime = new ConstantValue(t * 15);
    src.emberSystem.emissionOverTime = new ConstantValue(t * 12);

    // Scale emitter radius with fire spread
    const emitterShape = src.flameSystem.emitterShape;
    if (emitterShape instanceof ConeEmitter) {
      emitterShape.radius = Math.max(1, src.radius * 0.3);
    }
    const smokeShape = src.smokeSystem.emitterShape;
    if (smokeShape instanceof SphereEmitter) {
      smokeShape.radius = Math.max(1, src.radius * 0.3);
    }
    const emberShape = src.emberSystem.emitterShape;
    if (emberShape instanceof SphereEmitter) {
      emberShape.radius = Math.max(0.5, src.radius * 0.15);
    }

    // Update wind force directions
    const wx = this.wind.direction.x * this.wind.speed;
    const wz = this.wind.direction.y * this.wind.speed;
    src.flameForce.direction.set(wx, 1, wz);
    src.smokeForce.direction.set(wx * 2, 1.5, wz * 2);
    src.emberForce.direction.set(wx, -9.8, wz);

    // Light
    src.light.intensity = src.intensity * 80 * flicker;
    src.light.distance = src.radius * 1.8;

    // Ground scorch disabled
  }
}

/* ── Public entry point ──────────────────────────────────── */

export function startTestFire(scene: THREE.Scene, eventBus: EventBus, sampler?: HeightSampler): void {
  const manager = new FireSourceManager(scene, eventBus, sampler);

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
        manager.spawnPrimary();
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
