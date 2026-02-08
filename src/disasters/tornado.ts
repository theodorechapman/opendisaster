/**
 * Tornado Simulator — Rankine vortex wind field, progressive building damage,
 * tree uprooting, debris capture & orbit physics, and particle-based funnel.
 *
 * Physics references:
 *   - Rankine vortex: inner solid-body rotation, outer irrotational flow
 *   - Enhanced Fujita Scale (EF0-EF5) wind speed thresholds
 *   - Progressive failure: roof covering → roof structure → walls → collapse
 *   - Debris flight: drag-coupled to vortex wind, captured items orbit funnel
 *   - Tree uprooting threshold ≈ 35 m/s (EF1+)
 */

import * as THREE from "three";
import { SpriteNodeMaterial, MeshBasicNodeMaterial } from "three/webgpu";
import {
  uniform, attribute,
  float, vec2, vec3, vec4,
  sin, cos, fract, floor, dot, mix, smoothstep, pow, abs, clamp, length,
  uv, positionLocal, cameraProjectionMatrix, modelViewMatrix, modelWorldMatrix,
  Fn, Discard,
  varying,
} from "three/tsl";
import type { BuildingRecord, TreeRecord, CarRecord } from "../layers.ts";
import {
  getTerrainHeight,
  terrainCanvasRef,
  terrainTextureRef,
  terrainBoundsRef,
  treeRegistry,
  carRegistry,
} from "../layers.ts";

// ─── Enhanced Fujita Scale ──────────────────────────────────────────────────

export const EF_SCALE = [
  { rating: 0, speedMs: 38,  minMph: 65,  maxMph: 85,  label: "EF0", desc: "Light Damage" },
  { rating: 1, speedMs: 49,  minMph: 86,  maxMph: 110, label: "EF1", desc: "Moderate Damage" },
  { rating: 2, speedMs: 60,  minMph: 111, maxMph: 135, label: "EF2", desc: "Significant Damage" },
  { rating: 3, speedMs: 74,  minMph: 136, maxMph: 165, label: "EF3", desc: "Severe Damage" },
  { rating: 4, speedMs: 89,  minMph: 166, maxMph: 200, label: "EF4", desc: "Devastating Damage" },
  { rating: 5, speedMs: 135, minMph: 201, maxMph: 318, label: "EF5", desc: "Incredible Damage" },
];

// Median tornado path widths by EF rating (yards), based on NWS Chicago
// 1950–2024 climatology (used to scale the simulated vortex size).
const EF_PATH_WIDTH_YARDS = [50, 90, 77, 233, 310, 600];
const YARDS_TO_METERS = 0.9144;

// Wind speed thresholds for progressive structural failure (m/s)
const DMG = {
  roofCovering:    30,
  roofStructure:   45,
  wallPanels:      60,
  partialCollapse: 75,
  totalCollapse:   90,
};

const TREE_UPROOT_SPEED = 35; // m/s — EF1 uproots most trees

// ─── Visual / simulation constants ──────────────────────────────────────────

const FUNNEL_PARTICLES = 12000;
const MAX_DEBRIS       = 350;
const FUNNEL_HEIGHT    = 280;

// ─── TSL noise helpers ──────────────────────────────────────────────────────

/** hash21: vec2 → float (value noise hash) */
const hash21_tsl = /*#__PURE__*/ Fn(([p_immutable]: [any]) => {
  const p = vec2(p_immutable);
  return fract(sin(dot(p, vec2(127.1, 311.7))).mul(43758.5453));
});

/** noise2d: vec2 → float (value noise) */
const noise2d_tsl = /*#__PURE__*/ Fn(([p_immutable]: [any]) => {
  const p = vec2(p_immutable);
  const i = floor(p);
  const f = fract(p);
  const a = hash21_tsl(i);
  const b = hash21_tsl(i.add(vec2(1.0, 0.0)));
  const c = hash21_tsl(i.add(vec2(0.0, 1.0)));
  const d = hash21_tsl(i.add(vec2(1.0, 1.0)));
  const u = f.mul(f).mul(float(3.0).sub(f.mul(2.0)));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
});

/** hash22: vec2 → vec2 (gradient noise hash) */
const hash22_tsl = /*#__PURE__*/ Fn(([p_immutable]: [any]) => {
  const p = vec2(p_immutable);
  const px = dot(p, vec2(127.1, 311.7));
  const py = dot(p, vec2(269.5, 183.3));
  return fract(sin(vec2(px, py)).mul(43758.5453)).mul(2.0).sub(1.0);
});

/** gradient noise2d for funnel mesh */
const gradNoise2d_tsl = /*#__PURE__*/ Fn(([p_immutable]: [any]) => {
  const p = vec2(p_immutable);
  const i = floor(p);
  const f = fract(p);
  const u = f.mul(f).mul(float(3.0).sub(f.mul(2.0)));
  const a = dot(hash22_tsl(i), f);
  const b = dot(hash22_tsl(i.add(vec2(1.0, 0.0))), f.sub(vec2(1.0, 0.0)));
  const c = dot(hash22_tsl(i.add(vec2(0.0, 1.0))), f.sub(vec2(0.0, 1.0)));
  const d = dot(hash22_tsl(i.add(vec2(1.0, 1.0))), f.sub(vec2(1.0, 1.0)));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
});

/** fbm: 4-octave fractal Brownian motion */
const fbm_tsl = /*#__PURE__*/ Fn(([p_immutable]: [any]) => {
  let p = vec2(p_immutable);
  const v0 = gradNoise2d_tsl(p).mul(0.5);
  const p1 = p.mul(2.1);
  const v1 = gradNoise2d_tsl(p1).mul(0.25);
  const p2 = p1.mul(2.1);
  const v2 = gradNoise2d_tsl(p2).mul(0.125);
  const p3 = p2.mul(2.1);
  const v3 = gradNoise2d_tsl(p3).mul(0.0625);
  return v0.add(v1).add(v2).add(v3);
});

// ─── Internal types ─────────────────────────────────────────────────────────

interface FunnelParticle {
  baseRadius: number;
  height: number;
  angle: number;
  angularSpeed: number;
  radOscAmp: number;
  radOscFreq: number;
  radOscPhase: number;
  vertOscAmp: number;
  vertOscFreq: number;
  vertOscPhase: number;
}

interface DebrisPiece {
  mesh: THREE.Object3D;
  velocity: THREE.Vector3;
  angularVel: THREE.Vector3;
  life: number;
  grounded: boolean;
  /** True when debris is held aloft inside the vortex. */
  captured: boolean;
  /** If true, stays captured regardless of distance (used for whole buildings). */
  lockCaptured?: boolean;
  /** Optional TTL override (seconds) for airborne debris. */
  ttl?: number;
  orbitRadius?: number;
  orbitHeight?: number;
  orbitDrift?: number;
  radius?: number;
  allowSpinOut?: boolean;
  /** Lower mass = easier to capture & loft (0.1 very light, 1.0 heavy). */
  mass: number;
}

// ─── Tornado Simulator ─────────────────────────────────────────────────────

export class TornadoSimulator {
  /* ── public state ── */
  active = false;
  position = new THREE.Vector3();
  buildingsDamaged = 0;
  buildingsDestroyed = 0;

  /* ── tuneable parameters ── */
  private efRating = 3;
  private maxWindSpeed = 74;
  private coreRadius = 50;
  private outerRadius = 200;
  private translationSpeed = 15;
  private heading = 0;

  /* ── Three.js scene objects ── */
  private scene: THREE.Scene;
  private tornadoGroup: THREE.Group;
  private debrisGroup: THREE.Group;
  private cloudGroup!: THREE.Group;
  private funnelPoints!: THREE.InstancedMesh;
  private funnelMat!: SpriteNodeMaterial;
  private coneMesh!: THREE.Mesh;
  private coneMat!: MeshBasicNodeMaterial;
  private innerConeMesh!: THREE.Mesh;
  private innerConeMat!: MeshBasicNodeMaterial;
  // TSL uniform nodes for funnel mesh shaders
  private coneTimeUniform = uniform(0.0);
  private coneDarknessUniform = uniform(0.0);
  private coneOpacityUniform = uniform(1.0);
  private coneBendDirUniform = uniform(new THREE.Vector2(1, 0));
  private coneBendStrengthUniform = uniform(0.0);
  private coneTopFadeUniform = uniform(0.92);
  private innerConeTimeUniform = uniform(0.0);
  private innerConeDarknessUniform = uniform(0.0);
  private innerConeOpacityUniform = uniform(1.0);
  private innerConeBendDirUniform = uniform(new THREE.Vector2(1, 0));
  private innerConeBendStrengthUniform = uniform(0.0);
  private innerConeTopFadeUniform = uniform(0.72);
  // TSL uniform for particle system
  private particleTimeUniform = uniform(0.0);
  private cloudScale = 1;
  private pathWidthMeters = 0;
  private bendDir = new THREE.Vector2(1, 0);
  private bendTarget = new THREE.Vector2(1, 0);
  private bendStrength = 0;
  private bendSeedA = Math.random() * 10;
  private bendSeedB = Math.random() * 10;
  private ropeSeed = Math.random() * 10;
  private leanTimer = 0;
  private leanDir = new THREE.Vector2(1, 0);
  private leanStrength = 0;

  /* ── particles ── */
  private funnelData: FunnelParticle[] = [];

  /* ── debris ── */
  private debris: DebrisPiece[] = [];
  private debrisGeos: THREE.BufferGeometry[];
  private dirtGeo!: THREE.BufferGeometry;
  private dirtMat!: THREE.MeshPhongMaterial;
  private rubbleMat!: THREE.MeshPhongMaterial;
  private stumpMat!: THREE.MeshPhongMaterial;

  /* ── timing ── */
  private time = 0;
  private lastDirtSpawn = 0;

  // ─────────────────────────────────────────────────────────────────────────
  // Constructor
  // ─────────────────────────────────────────────────────────────────────────

  constructor(scene: THREE.Scene) {
    this.scene = scene;

    this.tornadoGroup = new THREE.Group();
    this.tornadoGroup.name = "tornado";
    this.tornadoGroup.visible = false;
    scene.add(this.tornadoGroup);

    this.debrisGroup = new THREE.Group();
    this.debrisGroup.name = "tornado-debris";
    scene.add(this.debrisGroup);

    this.funnelPoints = this.createFunnelSystem();
    this.tornadoGroup.add(this.funnelPoints);

    // Smooth LatheGeometry funnel meshes — procedural wind-texture shader
    const outer = this.createFunnelMesh(1.1, this.efOpacityOuter(), this.coneTimeUniform, this.coneDarknessUniform, this.coneOpacityUniform, this.coneBendDirUniform, this.coneBendStrengthUniform, this.coneTopFadeUniform);
    this.coneMesh = outer.mesh;
    this.coneMat  = outer.mat;
    this.coneTopFadeUniform.value = 0.92;
    this.tornadoGroup.add(this.coneMesh);

    const inner = this.createFunnelMesh(0.55, this.efOpacityInner(), this.innerConeTimeUniform, this.innerConeDarknessUniform, this.innerConeOpacityUniform, this.innerConeBendDirUniform, this.innerConeBendStrengthUniform, this.innerConeTopFadeUniform);
    this.innerConeMesh = inner.mesh;
    this.innerConeMat  = inner.mat;
    this.innerConeTopFadeUniform.value = 0.72;
    this.tornadoGroup.add(this.innerConeMesh);

    // Storm cloud base at the top of the funnel
    this.cloudGroup = this.createCloudBase();
    this.tornadoGroup.add(this.cloudGroup);

    // Shared debris geometries — irregular shapes for organic look
    this.debrisGeos = [
      new THREE.TetrahedronGeometry(1.2),              // 0 sharp shard
      new THREE.DodecahedronGeometry(1.0, 0),          // 1 chunky rock
      new THREE.OctahedronGeometry(1.3),               // 2 angular piece
      new THREE.BoxGeometry(3.5, 0.6, 1.0),            // 3 plank / beam
      new THREE.IcosahedronGeometry(0.9, 0),            // 4 rubble chunk
    ];

    // Shared materials for earth/rubble (avoids per-instance allocation)
    this.dirtGeo  = new THREE.DodecahedronGeometry(1.0, 0);
    this.dirtMat  = new THREE.MeshPhongMaterial({ color: 0x4a3520, emissive: 0x3a2510, emissiveIntensity: 0.25 });
    this.rubbleMat = new THREE.MeshPhongMaterial({ color: 0x555555 });
    this.stumpMat  = new THREE.MeshPhongMaterial({ color: 0x3a2a15 });

    // Align initial size with EF rating defaults
    this.applyEfRadius();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────────────────────────────────────

  setEFRating(rating: number) {
    this.efRating = Math.max(0, Math.min(5, Math.round(rating)));
    this.maxWindSpeed = EF_SCALE[this.efRating]!.speedMs;
    this.applyEfRadius();
    this.updateFunnelAppearance();
    if (this.active) this.initFunnel();
  }

  /** Push EF-dependent darkness & opacity into funnel shader uniforms + clouds. */
  private updateFunnelAppearance() {
    const d = this.efDarkness();
    if (this.coneMat) {
      this.coneDarknessUniform.value = d;
      this.coneOpacityUniform.value  = this.efOpacityOuter();
    }
    if (this.innerConeMat) {
      this.innerConeDarknessUniform.value = d;
      this.innerConeOpacityUniform.value  = this.efOpacityInner();
    }
    // Cloud darkness/opacity scale with EF
    if (this.cloudOuterMat) {
      const grey = Math.max(0.10, 0.38 - this.efRating * 0.05);
      this.cloudOuterMat.color.setRGB(grey, grey, grey + 0.01);
      this.cloudOuterMat.opacity = 0.62 + this.efRating * 0.05;
    }
    if (this.cloudInnerMat) {
      const grey = Math.max(0.06, 0.26 - this.efRating * 0.04);
      this.cloudInnerMat.color.setRGB(grey, grey, grey + 0.01);
      this.cloudInnerMat.opacity = 0.70 + this.efRating * 0.05;
    }
  }

  setCoreRadius(radius: number, reinit = true) {
    const old = this.coreRadius;
    this.coreRadius = Math.max(5, Math.min(200, radius));
    this.outerRadius = this.coreRadius * 4;
    const ratio = this.coreRadius / old;
    this.coneMesh.scale.x *= ratio;
    this.coneMesh.scale.z *= ratio;
    this.innerConeMesh.scale.x *= ratio;
    this.innerConeMesh.scale.z *= ratio;
    this.cloudScale = this.getCloudScale();
    this.applyCloudScaleNow();
    if (this.active && reinit) this.initFunnel();
  }

  setTranslationSpeed(speed: number) {
    this.translationSpeed = Math.max(0, Math.min(60, speed));
  }

  getCoreRadius(): number {
    return this.coreRadius;
  }

  /** Median damage-path width associated with the current EF rating (meters). */
  getPathWidthMeters(): number {
    return this.pathWidthMeters;
  }

  /** Approximate top of the wall-cloud base for camera bounding. */
  getCloudCeilingY(): number {
    return this.position.y + FUNNEL_HEIGHT + 90 * this.cloudScale;
  }

  spawn(pos: THREE.Vector3) {
    this.position.copy(pos);
    this.position.y = getTerrainHeight(pos.x, pos.z);
    this.heading = Math.random() * Math.PI * 2;
    this.active = true;
    this.time = 0;
    this.buildingsDamaged = 0;
    this.buildingsDestroyed = 0;
    this.tornadoGroup.visible = true;
    this.tornadoGroup.position.copy(this.position);
    this.updateFunnelAppearance();
    this.initFunnel();
  }

  despawn() {
    this.active = false;
    this.tornadoGroup.visible = false;
    // Remove airborne debris, keep grounded (they'll TTL out)
    for (let i = this.debris.length - 1; i >= 0; i--) {
      if (!this.debris[i]!.grounded) this.removeDebris(i);
    }
  }

  reset() {
    this.despawn();
    // Remove ALL remaining debris (including grounded)
    while (this.debris.length > 0) this.removeDebris(0);
    this.buildingsDamaged = 0;
    this.buildingsDestroyed = 0;
  }

  /** Main tick. */
  update(dt: number, buildings: BuildingRecord[]) {
    if (!this.active) return;
    this.time += dt;
    this.updateMovement(dt);
    this.updateFunnel(dt);
    this.updateTrees();
    this.updateCars();
    this.updateBuildings(dt, buildings);
    this.updateDebris(dt, buildings);
    // Spawn dirt chunks from the earth being ripped up
    if (this.time - this.lastDirtSpawn > 0.25) {
      this.spawnDirtDebris();
      this.lastDirtSpawn = this.time;
    }
    if (Math.floor(this.time * 15) % 4 === 0) this.paintGround();
  }

  getWindSpeedAtGround(x: number, z: number): number {
    if (!this.active) return 0;
    const dx = x - this.position.x;
    const dz = z - this.position.z;
    const r = Math.sqrt(dx * dx + dz * dz);
    if (r < 0.1) return this.maxWindSpeed * 0.7;
    let vTan: number;
    if (r <= this.coreRadius) {
      vTan = this.maxWindSpeed * (r / this.coreRadius);
    } else {
      vTan = this.maxWindSpeed * (this.coreRadius / r);
    }
    const inflowFactor = r <= this.coreRadius ? 0.2 : 0.4 * (this.coreRadius / r);
    const vRad = vTan * inflowFactor;
    return Math.sqrt(vTan * vTan + vRad * vRad);
  }

  getCameraShake(camPos: THREE.Vector3): THREE.Vector3 {
    if (!this.active) return new THREE.Vector3();
    const dist = camPos.distanceTo(this.position);
    const maxDist = this.outerRadius * 2;
    if (dist > maxDist) return new THREE.Vector3();
    const intensity = Math.pow(1 - dist / maxDist, 2) * 2.0;
    return new THREE.Vector3(
      (Math.random() - 0.5) * intensity,
      (Math.random() - 0.5) * intensity * 0.5,
      (Math.random() - 0.5) * intensity,
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Wind field (Rankine vortex + inflow + updraft)
  // ─────────────────────────────────────────────────────────────────────────

  private getWindVector(x: number, y: number, z: number): THREE.Vector3 {
    const dx = x - this.position.x;
    const dz = z - this.position.z;
    const r = Math.sqrt(dx * dx + dz * dz);

    if (r < 0.1) return new THREE.Vector3(0, this.maxWindSpeed * 0.5, 0);

    let vTan: number;
    if (r <= this.coreRadius) {
      vTan = this.maxWindSpeed * (r / this.coreRadius);
    } else {
      vTan = this.maxWindSpeed * (this.coreRadius / r);
    }

    const nx = dx / r;
    const nz = dz / r;
    const tx = -nz;
    const tz = nx;

    // Gentler inflow so captured debris orbits longer before spiralling in
    const inflowFactor = r <= this.coreRadius ? 0.15 : 0.35;
    const vRad = -vTan * inflowFactor;

    // Stronger updraft in core (keeps debris aloft)
    let vUp: number;
    if (r <= this.coreRadius) {
      vUp = this.maxWindSpeed * 0.6 * (1 - r * 0.5 / this.coreRadius);
    } else {
      vUp = this.maxWindSpeed * 0.15 * (this.coreRadius / r);
    }

    const hFactor = Math.max(0, 1 - y / (FUNNEL_HEIGHT * 1.5));

    return new THREE.Vector3(
      (tx * vTan + nx * vRad) * hFactor + this.translationSpeed * Math.cos(this.heading),
      vUp * hFactor,
      (tz * vTan + nz * vRad) * hFactor + this.translationSpeed * Math.sin(this.heading),
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Funnel particle system
  // ─────────────────────────────────────────────────────────────────────────

  private createFunnelSystem(): THREE.InstancedMesh {
    // Use a small quad as base geometry for each particle (replaces GL_POINTS)
    const quadGeo = new THREE.PlaneGeometry(1, 1);

    // Per-instance attributes
    const positionAttr = new THREE.InstancedBufferAttribute(new Float32Array(FUNNEL_PARTICLES * 3), 3);
    const pSizeAttr    = new THREE.InstancedBufferAttribute(new Float32Array(FUNNEL_PARTICLES), 1);
    const pAlphaAttr   = new THREE.InstancedBufferAttribute(new Float32Array(FUNNEL_PARTICLES), 1);
    const pColorAttr   = new THREE.InstancedBufferAttribute(new Float32Array(FUNNEL_PARTICLES * 3), 3);

    quadGeo.setAttribute("instancePosition", positionAttr);
    quadGeo.setAttribute("pSize",            pSizeAttr);
    quadGeo.setAttribute("pAlpha",           pAlphaAttr);
    quadGeo.setAttribute("pColor",           pColorAttr);

    const uTime = this.particleTimeUniform;

    // TSL material
    this.funnelMat = new SpriteNodeMaterial();
    this.funnelMat.transparent = true;
    this.funnelMat.depthWrite = false;
    this.funnelMat.blending = THREE.NormalBlending;

    // Read per-instance attributes
    const instPos   = attribute("instancePosition");
    const instSize  = attribute("pSize");
    const instAlpha = attribute("pAlpha");
    const instColor = attribute("pColor");

    // Vertex: billboard quad scaled by pSize with pulse and distance attenuation
    const pulse = float(1.0).add(float(0.18).mul(sin(uTime.mul(3.5).add(instPos.y.mul(0.06)).add(instPos.x.mul(0.12)))));
    const mvPos = modelViewMatrix.mul(vec4(instPos, 1.0));
    const dist = length(mvPos.xyz);
    const rawSize = instSize.mul(pulse).mul(float(400.0).div(dist.max(40.0)));
    const finalSize = clamp(rawSize, 1.5, 140.0);

    // SpriteNodeMaterial uses scaleNode to control sprite size
    this.funnelMat.scaleNode = vec2(finalSize, finalSize);

    // Pass varyings to fragment
    const vAlpha = varying(instAlpha.mul(pulse), "vAlpha");
    const vColor = varying(instColor, "vColor");

    // Position node: use instanced position
    this.funnelMat.positionNode = instPos;

    // Fragment: radial falloff, noise grain, color modulation
    const uvCoord = uv();
    const d = length(uvCoord.sub(vec2(0.5, 0.5)));
    const edge = smoothstep(0.5, 0.0, d);
    const grain = noise2d_tsl(uvCoord.mul(8.0).add(vColor.xy.mul(10.0)));
    const alpha = vAlpha.mul(edge).mul(float(0.75).add(grain.mul(0.4)));
    const col = vColor.mul(float(0.85).add(grain.mul(0.3)));

    // Discard pixels outside the circle
    Discard(d.greaterThan(0.5));

    this.funnelMat.colorNode = col;
    this.funnelMat.opacityNode = alpha;

    const mesh = new THREE.InstancedMesh(quadGeo, this.funnelMat, FUNNEL_PARTICLES);
    mesh.frustumCulled = false;
    return mesh;
  }

  /** Smooth LatheGeometry funnel with procedural wind-texture TSL shader. */
  private createFunnelMesh(
    radiusScale: number, opacity: number,
    uTime: ReturnType<typeof uniform>, uDarkness: ReturnType<typeof uniform>,
    uOpacity: ReturnType<typeof uniform>, uBendDir: ReturnType<typeof uniform>,
    uBendStrength: ReturnType<typeof uniform>, uTopFade: ReturnType<typeof uniform>,
  ): { mesh: THREE.Mesh; mat: MeshBasicNodeMaterial } {
    const pts: THREE.Vector2[] = [];
    const segs = 48;
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const r = this.coreRadius * radiusScale * (0.04 + 0.96 * Math.pow(t, 0.38));
      pts.push(new THREE.Vector2(r, t * FUNNEL_HEIGHT));
    }
    const geo = new THREE.LatheGeometry(pts, 128);

    const darkness = this.efDarkness();
    uDarkness.value = darkness;
    uOpacity.value = opacity;

    const mat = new MeshBasicNodeMaterial();
    mat.transparent = true;
    mat.depthWrite = false;
    mat.side = THREE.DoubleSide;

    // ── Vertex: bend offset based on height ──
    const uvNode = uv();
    const heightNorm = uvNode.y; // 0→1 bottom→top in LatheGeometry
    const bendAmount = pow(heightNorm, 1.6).mul(uBendStrength);
    const pos = positionLocal.toVar();
    const bentPos = vec3(
      pos.x.add(uBendDir.x.mul(bendAmount)),
      pos.y,
      pos.z.add(uBendDir.y.mul(bendAmount)),
    );
    mat.positionNode = bentPos;

    // ── Fragment: FBM noise wind patterns ──
    const h = heightNorm;
    const angle = uvNode.x.mul(6.2832); // 0→2π around circumference
    const windU = angle.mul(1.5).add(uTime.mul(2.5)).add(h.mul(3.0));
    const windV = h.mul(8.0).sub(uTime.mul(1.8));

    // Multi-octave noise for turbulent wind texture
    const n1 = fbm_tsl(vec2(windU, windV).mul(0.8));
    const n2 = fbm_tsl(vec2(windU.mul(1.3).add(5.0), windV.mul(0.7).add(3.0)).mul(1.2));
    const n3 = noise2d_tsl(vec2(windU.mul(2.0), windV.mul(1.5)).add(uTime.mul(0.5)));

    const windPattern = n1.mul(0.5).add(n2.mul(0.3)).add(n3.mul(0.2));
    const streak = abs(sin(windU.mul(1.6).add(windV.mul(0.8))));
    const detail = mix(float(0.7), float(1.2), streak).mul(float(0.8).add(windPattern.mul(0.2)));

    // Colour: dark core with lighter wind streaks
    const baseBright = float(0.08).add(float(1.0).sub(uDarkness).mul(0.25));
    const streaks = baseBright.add(windPattern.mul(float(0.12).add(float(1.0).sub(uDarkness).mul(0.08)))).mul(detail);
    // Slight blue-grey tint
    const col = vec3(streaks, streaks, streaks.add(0.03));

    // Alpha: solid at base, fading toward top; wind bands modulate
    const baseAlpha = mix(float(0.9), float(0.3), h.mul(h));
    const windAlpha = float(1.0).add(windPattern.mul(0.3)).mul(float(0.85).add(detail.mul(0.35)));
    const groundBoost = smoothstep(0.0, 0.15, h).mul(float(1.0).sub(h));
    const alpha = baseAlpha.mul(windAlpha).mul(uOpacity).mul(float(1.0).add(groundBoost.mul(0.35)));
    // Edge softening
    const finalAlpha = alpha.mul(smoothstep(0.0, 0.06, h)).mul(smoothstep(1.0, uTopFade, h));

    mat.colorNode = col;
    mat.opacityNode = clamp(finalAlpha, 0.0, 1.0);

    return { mesh: new THREE.Mesh(geo, mat), mat };
  }

  /** EF-dependent darkness: 0=light wispy, 1=near-black. */
  private efDarkness(): number {
    // EF0 0.15, EF1 0.30, EF2 0.50, EF3 0.65, EF4 0.80, EF5 0.95
    return 0.15 + this.efRating * 0.16;
  }
  /** EF-dependent base opacity for the outer funnel. */
  private efOpacityOuter(): number {
    return 0.30 + this.efRating * 0.08;
  }
  /** EF-dependent base opacity for the inner funnel. */
  private efOpacityInner(): number {
    return 0.45 + this.efRating * 0.10;
  }

  /** Create a cluster of dark, overlapping cloud blobs at the funnel top. */
  private cloudOuterMat!: THREE.MeshPhongMaterial;
  private cloudInnerMat!: THREE.MeshPhongMaterial;

  private createCloudBase(): THREE.Group {
    const group = new THREE.Group();
    const cloudGeo = new THREE.SphereGeometry(1, 28, 20);
    const initialScale = this.getCloudScale();
    const zMul = 1.6;
    const yMul = 1.35;
    this.cloudOuterMat = new THREE.MeshPhongMaterial({
      color: 0x3f3f46,
      emissive: 0x0f1012,
      emissiveIntensity: 0.22,
      shininess: 8,
      transparent: true,
      opacity: 0.68,
      depthWrite: false,
    });
    // Dense, dark inner layer
    this.cloudInnerMat = new THREE.MeshPhongMaterial({
      color: 0x2b2b33,
      emissive: 0x0b0c0e,
      emissiveIntensity: 0.38,
      shininess: 6,
      transparent: true,
      opacity: 0.82,
      depthWrite: false,
    });
    const cloudMat = this.cloudOuterMat;
    const innerMat = this.cloudInnerMat;

    // Layout: a dense 3D cloud base with vertical depth & coverage
    const cloudDefs: { x: number; z: number; y: number; sx: number; sy: number; sz: number; mat: THREE.Material }[] = [];
    // Core mass
    cloudDefs.push({ x: 0, z: 0, y: 4,  sx: 170, sy: 40 * yMul, sz: 170 * zMul, mat: innerMat });
    cloudDefs.push({ x: 0, z: 0, y: 18, sx: 150, sy: 32 * yMul, sz: 150 * zMul, mat: cloudMat });
    cloudDefs.push({ x: 0, z: 0, y: -8, sx: 120, sy: 45 * yMul, sz: 120 * zMul, mat: innerMat });

    // Thick ring around the core
    const ringR = 170;
    const ringCount = 30;
    for (let i = 0; i < ringCount; i++) {
      const a = (i / ringCount) * Math.PI * 2;
      const rr = ringR + (Math.random() - 0.5) * 30;
      cloudDefs.push({
        x: Math.cos(a) * rr,
        z: Math.sin(a) * rr,
        y: 6 + (Math.random() - 0.5) * 16,
        sx: 120 + Math.random() * 40,
        sy: (24 + Math.random() * 18) * yMul,
        sz: (110 + Math.random() * 40) * zMul,
        mat: cloudMat,
      });
    }

    // Outer fringe
    const fringeR = 280;
    const fringeCount = 26;
    for (let i = 0; i < fringeCount; i++) {
      const a = (i / fringeCount) * Math.PI * 2;
      const rr = fringeR + (Math.random() - 0.5) * 40;
      cloudDefs.push({
        x: Math.cos(a) * rr,
        z: Math.sin(a) * rr,
        y: 10 + (Math.random() - 0.5) * 20,
        sx: 90 + Math.random() * 30,
        sy: (18 + Math.random() * 14) * yMul,
        sz: (90 + Math.random() * 30) * zMul,
        mat: cloudMat,
      });
    }

    // Upper canopy layer for more volume
    const canopyCount = 24;
    const canopyR = 240;
    for (let i = 0; i < canopyCount; i++) {
      const a = (i / canopyCount) * Math.PI * 2 + Math.random() * 0.2;
      const rr = canopyR + (Math.random() - 0.5) * 35;
      cloudDefs.push({
        x: Math.cos(a) * rr,
        z: Math.sin(a) * rr,
        y: 32 + Math.random() * 16,
        sx: 110 + Math.random() * 35,
        sy: (22 + Math.random() * 16) * yMul,
        sz: (120 + Math.random() * 45) * zMul,
        mat: cloudMat,
      });
    }

    // Bottom hanging wisps to connect funnel
    const wispCount = 14;
    for (let i = 0; i < wispCount; i++) {
      const a = (i / wispCount) * Math.PI * 2 + Math.random() * 0.4;
      const rr = 45 + Math.random() * 25;
      cloudDefs.push({
        x: Math.cos(a) * rr,
        z: Math.sin(a) * rr,
        y: -28 + Math.random() * 10,
        sx: 55 + Math.random() * 20,
        sy: (35 + Math.random() * 20) * yMul,
        sz: (55 + Math.random() * 20) * zMul,
        mat: innerMat,
      });
    }

    // Far outer crown for extra coverage
    const crownCount = 18;
    const crownR = 340;
    for (let i = 0; i < crownCount; i++) {
      const a = (i / crownCount) * Math.PI * 2 + Math.random() * 0.2;
      const rr = crownR + (Math.random() - 0.5) * 50;
      cloudDefs.push({
        x: Math.cos(a) * rr,
        z: Math.sin(a) * rr,
        y: 18 + Math.random() * 20,
        sx: 95 + Math.random() * 35,
        sy: (18 + Math.random() * 14) * yMul,
        sz: (120 + Math.random() * 50) * zMul,
        mat: cloudMat,
      });
    }

    for (const c of cloudDefs) {
      const mesh = new THREE.Mesh(cloudGeo, c.mat);
      mesh.position.set(c.x, FUNNEL_HEIGHT + c.y, c.z);
      mesh.scale.set(c.sx * initialScale, c.sy * initialScale, c.sz * initialScale);
      mesh.userData.baseScaleX = c.sx;
      mesh.userData.baseScaleY = c.sy;
      mesh.userData.baseScaleZ = c.sz;
      group.add(mesh);
    }

    return group;
  }

  private applyCloudScaleNow() {
    if (!this.cloudGroup) return;
    for (const c of this.cloudGroup.children) {
      c.scale.x = c.userData.baseScaleX * this.cloudScale;
      c.scale.y = c.userData.baseScaleY * this.cloudScale;
      c.scale.z = c.userData.baseScaleZ * this.cloudScale;
    }
  }

  private initFunnel() {
    this.funnelData = [];
    const sArr = (this.funnelPoints.geometry.attributes.pSize  as THREE.InstancedBufferAttribute).array as Float32Array;
    const aArr = (this.funnelPoints.geometry.attributes.pAlpha as THREE.InstancedBufferAttribute).array as Float32Array;
    const cArr = (this.funnelPoints.geometry.attributes.pColor as THREE.InstancedBufferAttribute).array as Float32Array;
    const sizeScale = THREE.MathUtils.clamp(this.coreRadius / 50, 0.35, 2.4);

    for (let i = 0; i < FUNNEL_PARTICLES; i++) {
      // Particle distribution:
      //   18% — ground-level dust/debris cloud (wide, very dark)
      //   40% — tight funnel wall (defines the visible dark cone)
      //   42% — inner body / fill
      const roll = Math.random();
      const isGroundDust = roll < 0.18;
      const isFunnelWall = roll >= 0.18 && roll < 0.58;

      let height: number, baseRadius: number, angularSpeed: number;

      if (isGroundDust) {
        height = Math.random() * 15;
        baseRadius = this.coreRadius * (0.5 + Math.random() * 3.0);
        angularSpeed = (this.maxWindSpeed / Math.max(baseRadius, 1)) * (0.4 + Math.random() * 0.5);
      } else if (isFunnelWall) {
        // Tightly concentrated along the funnel edge — makes the dark cone shape
        const t = Math.random();
        height = Math.pow(t, 0.35) * FUNNEL_HEIGHT;
        const funnelR = this.coreRadius * (0.12 + 0.88 * Math.pow(height / FUNNEL_HEIGHT, 0.45));
        // Very tight spread around the wall (0.90–1.10 of funnel radius)
        baseRadius = funnelR * (0.90 + Math.random() * 0.20);
        angularSpeed = this.maxWindSpeed / this.coreRadius * (0.9 + Math.random() * 0.2);
      } else {
        const t = Math.random();
        height = Math.pow(t, 0.4) * FUNNEL_HEIGHT;
        const funnelR = this.coreRadius * (0.12 + 0.88 * Math.pow(height / FUNNEL_HEIGHT, 0.45));
        baseRadius = funnelR * (0.15 + Math.random() * 0.80);
        if (baseRadius <= this.coreRadius) {
          angularSpeed = this.maxWindSpeed / this.coreRadius;
        } else {
          angularSpeed = (this.maxWindSpeed * this.coreRadius) / (baseRadius * baseRadius);
        }
        angularSpeed *= 0.8 + Math.random() * 0.4;
      }

      this.funnelData.push({
        baseRadius, height,
        angle: Math.random() * Math.PI * 2,
        angularSpeed,
        radOscAmp:   baseRadius * (0.03 + Math.random() * 0.12),
        radOscFreq:  1 + Math.random() * 3,
        radOscPhase: Math.random() * Math.PI * 2,
        vertOscAmp:  1.0 + Math.random() * 5,
        vertOscFreq: 0.5 + Math.random() * 2.5,
        vertOscPhase: Math.random() * Math.PI * 2,
      });

      const hNorm = height / FUNNEL_HEIGHT;

      // EF-dependent colour darkness & opacity boost
      const ef = this.efRating;
      const darkMul = 1.0 - ef * 0.11;          // colour multiplier: EF0 1.0 → EF5 0.45
      const alphaMul = 1.0 + ef * 0.10;          // opacity boost:     EF0 1.0 → EF5 1.50

      if (isGroundDust) {
        sArr[i] = (30 + Math.random() * 22) * sizeScale;
        aArr[i] = (0.50 + Math.random() * 0.35) * alphaMul;
        cArr[i * 3]     = (0.10 + Math.random() * 0.08) * darkMul;
        cArr[i * 3 + 1] = (0.08 + Math.random() * 0.06) * darkMul;
        cArr[i * 3 + 2] = (0.06 + Math.random() * 0.04) * darkMul;
      } else if (isFunnelWall) {
        sArr[i] = (10 + (1 - hNorm) * 16 + Math.random() * 6) * sizeScale;
        aArr[i] = (0.45 + (1 - hNorm) * 0.40) * alphaMul;
        const b = (0.12 + hNorm * 0.14 + (Math.random() - 0.5) * 0.04) * darkMul;
        cArr[i * 3]     = b;
        cArr[i * 3 + 1] = b;
        cArr[i * 3 + 2] = b + 0.04 * darkMul;
      } else {
        sArr[i] = (6 + (1 - hNorm) * 12 + Math.random() * 4) * sizeScale;
        aArr[i] = (0.25 + (1 - hNorm) * 0.50) * alphaMul;
        const b = (0.10 + hNorm * 0.16 + (Math.random() - 0.5) * 0.05) * darkMul;
        cArr[i * 3]     = b;
        cArr[i * 3 + 1] = b;
        cArr[i * 3 + 2] = b + 0.03 * darkMul;
      }
    }

    (this.funnelPoints.geometry.attributes.pSize  as THREE.InstancedBufferAttribute).needsUpdate = true;
    (this.funnelPoints.geometry.attributes.pAlpha as THREE.InstancedBufferAttribute).needsUpdate = true;
    (this.funnelPoints.geometry.attributes.pColor as THREE.InstancedBufferAttribute).needsUpdate = true;
  }

  private updateFunnel(dt: number) {
    this.particleTimeUniform.value = this.time;
    this.updateBend(dt);

    const posArr = (this.funnelPoints.geometry.attributes.instancePosition as THREE.InstancedBufferAttribute).array as Float32Array;
    for (let i = 0; i < FUNNEL_PARTICLES; i++) {
      const p = this.funnelData[i]!;
      p.angle += p.angularSpeed * dt;
      const h = p.height     + p.vertOscAmp * Math.sin(this.time * p.vertOscFreq + p.vertOscPhase);
      const rope = this.getRopeOutFactor();
      const hNorm = THREE.MathUtils.clamp(h / FUNNEL_HEIGHT, 0, 1);
      const ropeTaper = 1.0 - rope * Math.pow(hNorm, 1.1) * 0.75;
      const r = (p.baseRadius + p.radOscAmp * Math.sin(this.time * p.radOscFreq + p.radOscPhase)) * ropeTaper;
      const bend = this.getBendOffset(h);
      posArr[i * 3]     = r * Math.cos(p.angle) + bend.x;
      posArr[i * 3 + 1] = Math.max(0, h);
      posArr[i * 3 + 2] = r * Math.sin(p.angle) + bend.y;
    }
    (this.funnelPoints.geometry.attributes.instancePosition as THREE.InstancedBufferAttribute).needsUpdate = true;

    // Tick funnel shader time uniforms
    this.coneTimeUniform.value = this.time;
    this.innerConeTimeUniform.value = this.time;
    (this.coneBendDirUniform.value as THREE.Vector2).copy(this.bendDir);
    (this.innerConeBendDirUniform.value as THREE.Vector2).copy(this.bendDir);
    this.coneBendStrengthUniform.value = this.bendStrength;
    this.innerConeBendStrengthUniform.value = this.bendStrength * 0.9;

    // Animate cone meshes
    this.coneMesh.rotation.y      += 0.5 * dt;
    this.innerConeMesh.rotation.y -= 0.7 * dt;
    this.innerConeMesh.position.y = FUNNEL_HEIGHT / 2 + Math.sin(this.time * 1.2) * 2;
    const rope = this.getRopeOutFactor();
    // Outer cone rope-out only; inner cone stays stable
    const ropeX = 1.0 - rope * 0.28;
    const ropeY = 1.0 - rope * 0.12;
    this.innerConeMesh.scale.y = 1.0 * (1.0 + 0.03 * Math.sin(this.time * 2.6 + 1.0));
    this.innerConeMesh.scale.x = 1.0;
    this.innerConeMesh.scale.z = 1.0;

    this.coneMesh.scale.y = ropeY * (1.0 + 0.04 * Math.sin(this.time * 2.2));
    this.coneMesh.scale.x = ropeX;
    this.coneMesh.scale.z = ropeX;
    // Clouds should not rope-out — keep their base scale independent
    this.cloudGroup.scale.set(1, 1, 1);

    // Animate cloud base — slow menacing rotation + subtle billowing
    this.cloudGroup.rotation.y += 0.04 * dt;
    // Keep clouds upright (no lean/tilt from the funnel)
    this.cloudGroup.rotation.x = -this.tornadoGroup.rotation.x;
    this.cloudGroup.rotation.z = -this.tornadoGroup.rotation.z;
    const children = this.cloudGroup.children;
    for (let i = 0; i < children.length; i++) {
      const c = children[i]!;
      const phase = i * 1.7;
      c.position.y += Math.sin(this.time * 0.35 + phase) * 0.02;
      const breathe = 1.0 + 0.02 * Math.sin(this.time * 0.6 + phase);
      c.scale.x = c.userData.baseScaleX * this.cloudScale * breathe;
      c.scale.y = c.userData.baseScaleY * this.cloudScale * breathe;
      c.scale.z = c.userData.baseScaleZ * this.cloudScale * breathe;
    }
  }

  private getDebrisScale(): number {
    return 0.35 + this.efRating * 0.13;
  }

  private applyEfRadius() {
    this.pathWidthMeters = EF_PATH_WIDTH_YARDS[this.efRating]! * YARDS_TO_METERS;
    // Model uses outerRadius = coreRadius * 4, so damage-path diameter ≈ outerRadius * 2.
    const core = this.pathWidthMeters / 8;
    this.setCoreRadius(core, false);
  }

  private getCloudScale(): number {
    return THREE.MathUtils.clamp(this.coreRadius / 50, 0.6, 2.2);
  }

  private updateBend(dt: number) {
    const t = this.time;
    const wobbleX = Math.sin(t * 0.55 + this.bendSeedA) * 0.7 + Math.sin(t * 1.1 + this.bendSeedB) * 0.3;
    const wobbleZ = Math.cos(t * 0.48 + this.bendSeedB) * 0.7 + Math.cos(t * 1.0 + this.bendSeedA) * 0.3;
    this.bendTarget.set(wobbleX, wobbleZ);
    if (this.bendTarget.lengthSq() < 1e-4) this.bendTarget.set(1, 0);
    this.bendTarget.normalize();
    this.bendDir.lerp(this.bendTarget, 0.4 * dt);
    const base = this.coreRadius * (0.65 + this.efRating * 0.15);
    const rope = this.getRopeOutFactor();
    const whip = (0.7 + 0.5 * Math.sin(t * 1.1 + this.bendSeedA)) * (1.0 + rope * 1.6);

    // Random visible lean impulses
    this.leanTimer -= dt;
    if (this.leanTimer <= 0) {
      const ang = Math.random() * Math.PI * 2;
      this.leanDir.set(Math.cos(ang), Math.sin(ang));
      this.leanStrength = base * (0.35 + Math.random() * 0.45);
      this.leanTimer = 2.0 + Math.random() * 4.0;
    }
    const lean = this.leanStrength * (0.6 + 0.4 * Math.sin(t * 1.6 + this.ropeSeed));

    this.bendStrength = base * whip + lean;
  }

  private getBendOffset(height: number): THREE.Vector2 {
    const hNorm = THREE.MathUtils.clamp(height / FUNNEL_HEIGHT, 0, 1);
    const rope = this.getRopeOutFactor();
    const meander = Math.sin(this.time * 1.8 + this.ropeSeed + hNorm * 6.0) * rope * this.coreRadius * 0.55;
    const bend = Math.pow(hNorm, 1.35) * this.bendStrength * (1.0 + rope * 0.6);
    return new THREE.Vector2(
      this.bendDir.x * bend + this.bendDir.y * meander + this.leanDir.x * (this.leanStrength * Math.pow(hNorm, 1.1)),
      this.bendDir.y * bend - this.bendDir.x * meander + this.leanDir.y * (this.leanStrength * Math.pow(hNorm, 1.1)),
    );
  }

  private getRopeOutFactor(): number {
    return 1.0;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Movement
  // ─────────────────────────────────────────────────────────────────────────

  private updateMovement(dt: number) {
    // Erratic heading drift — real tornadoes wander unpredictably
    this.heading += (Math.random() - 0.5) * 1.2 * dt;
    // Occasional sharp direction change (≈ every 3–6 seconds on average)
    if (Math.random() < 0.004) {
      this.heading += (Math.random() - 0.5) * Math.PI * 0.6;
    }

    this.position.x += Math.cos(this.heading) * this.translationSpeed * dt;
    this.position.z += Math.sin(this.heading) * this.translationSpeed * dt;
    this.position.y = getTerrainHeight(this.position.x, this.position.z);
    this.tornadoGroup.position.copy(this.position);
    this.tornadoGroup.rotation.z = Math.sin(this.heading) * 0.06;
    this.tornadoGroup.rotation.x = -Math.cos(this.heading) * 0.06;

    // Self-terminate if the tornado leaves the loaded terrain area
    if (terrainBoundsRef) {
      const margin = this.coreRadius;
      const b = terrainBoundsRef;
      if (
        this.position.x < b.xMin - margin || this.position.x > b.xMax + margin ||
        this.position.z < b.zMin - margin || this.position.z > b.zMax + margin
      ) {
        this.despawn();
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Tree uprooting
  // ─────────────────────────────────────────────────────────────────────────

  private updateTrees() {
    const TREE_BREAK_SPEED = 20; // m/s — snap branches before full uproot
    for (const tree of treeRegistry) {
      if (tree.uprooted) continue;

      const dx = tree.x - this.position.x;
      const dz = tree.z - this.position.z;
      if (dx * dx + dz * dz > this.outerRadius * this.outerRadius) continue;

      const windSpeed = this.getWindSpeedAtGround(tree.x, tree.z);
      const effective = windSpeed / tree.strength;
      if (effective < TREE_BREAK_SPEED) continue;

      if (!tree.broken && effective < TREE_UPROOT_SPEED) {
        tree.broken = true;
        // Snap: lower canopy, tilt trunk
        const groundY = getTerrainHeight(tree.x, tree.z);
        tree.trunkMesh.scale.y = 0.45;
        tree.trunkMesh.position.y = groundY + 1.0;
        tree.trunkMesh.rotation.z = (Math.random() - 0.5) * 0.6;
        tree.trunkMesh.rotation.x = (Math.random() - 0.5) * 0.4;
        tree.canopyMesh.position.y = groundY + 0.6;
        tree.canopyMesh.rotation.set(
          (Math.random() - 0.5) * 0.8,
          Math.random() * Math.PI * 2,
          (Math.random() - 0.5) * 0.8,
        );
        continue;
      }

      // Uproot! Move trunk + canopy into the debris system as captured pieces
      tree.uprooted = true;

      // Leave a stump / root crater at the original site
      this.spawnGroundRubble(tree.x, tree.z, 3, this.stumpMat, 4, [0.2, 0.5]);

      for (const mesh of [tree.trunkMesh, tree.canopyMesh]) {
        const wp = new THREE.Vector3();
        mesh.getWorldPosition(wp);
        mesh.parent?.remove(mesh);
        mesh.position.copy(wp);
        this.debrisGroup.add(mesh);

        const wind = this.getWindVector(wp.x, wp.y, wp.z);
      this.debris.push({
        mesh,
        velocity: new THREE.Vector3(
          wind.x * 0.2 + (Math.random() - 0.5) * 10,
          8 + Math.random() * 15,
          wind.z * 0.2 + (Math.random() - 0.5) * 10,
        ),
        angularVel: new THREE.Vector3(
          (Math.random() - 0.5) * 4,
          (Math.random() - 0.5) * 4,
          (Math.random() - 0.5) * 4,
        ),
        life: 0,
        grounded: false,
        captured: true,
        allowSpinOut: true,
        mass: mesh === tree.trunkMesh ? 0.7 : 0.25,
      });
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Car uprooting (treated like trees)
  // ─────────────────────────────────────────────────────────────────────────

  private updateCars() {
    for (const car of carRegistry) {
      if (car.uprooted) continue;

      const dx = car.x - this.position.x;
      const dz = car.z - this.position.z;
      if (dx * dx + dz * dz > this.outerRadius * this.outerRadius) continue;

      const windSpeed = this.getWindSpeedAtGround(car.x, car.z);
      if (windSpeed / car.strength < TREE_UPROOT_SPEED) continue;

      car.uprooted = true;

      const mesh = car.mesh;
      const wp = new THREE.Vector3();
      mesh.getWorldPosition(wp);
      mesh.parent?.remove(mesh);
      mesh.position.copy(wp);
      this.debrisGroup.add(mesh);

      const wind = this.getWindVector(wp.x, wp.y + 1.5, wp.z);
      this.debris.push({
        mesh,
        velocity: new THREE.Vector3(
          wind.x * 0.25 + (Math.random() - 0.5) * 6,
          12 + Math.random() * 18,
          wind.z * 0.25 + (Math.random() - 0.5) * 6,
        ),
        angularVel: new THREE.Vector3(
          (Math.random() - 0.5) * 2.0,
          (Math.random() - 0.5) * 2.0,
          (Math.random() - 0.5) * 2.0,
        ),
        life: 0,
        grounded: false,
        captured: true,
        lockCaptured: true,
        allowSpinOut: true,
        ttl: 120,
        mass: 0.8,
      });
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Building damage
  // ─────────────────────────────────────────────────────────────────────────

  private updateBuildings(dt: number, buildings: BuildingRecord[]) {
    let damaged = 0;
    let destroyed = 0;

    for (const b of buildings) {
      if (b.damageLevel > 0) damaged++;
      if (b.destroyed) { destroyed++; continue; }

      const dx = b.centerX - this.position.x;
      const dz = b.centerZ - this.position.z;
      if (dx * dx + dz * dz > this.outerRadius * this.outerRadius) continue;

      const windSpeed = this.getWindSpeedAtGround(b.centerX, b.centerZ);
      const effectiveSpeed = windSpeed / b.structuralStrength;
      if (effectiveSpeed < DMG.roofCovering * 0.8) continue;

      // Slower, EF-scaled damage progression (EF scale is wind-based damage proxy)
      const intensity = THREE.MathUtils.clamp(
        (effectiveSpeed - DMG.roofCovering) / (DMG.totalCollapse - DMG.roofCovering),
        0,
        1,
      );
      const efRatio = this.maxWindSpeed / EF_SCALE[5]!.speedMs;
      const efScale = 0.05 + Math.pow(efRatio, 1.3) * 0.9; // EF0–EF5 wind-based scaling
      const damageRate = Math.pow(intensity, 2.6) * efScale * 0.35;

      const prev = b.damageLevel;
      b.damageLevel = Math.min(1, b.damageLevel + damageRate * dt);

      // Extremely rare: only very small, low buildings can be lofted in EF5
      const floors = Math.max(1, Math.round(b.height / 3));
      const isNarrow = b.width <= 14;
      if (
        this.efRating >= 5 &&
        isNarrow &&
        floors <= 1 &&
        effectiveSpeed >= DMG.totalCollapse &&
        prev < 0.60 &&
        b.damageLevel >= 0.60 &&
        Math.random() < 0.08
      ) {
        this.uprootBuilding(b);
        destroyed++;
        continue;
      }

      this.applyDamage(b);
      this.maybeTiltBuilding(b, effectiveSpeed);
      this.maybeSpawnBuildingChunk(b, effectiveSpeed);
      this.maybeSpawnDebris(b, prev);
      // Enforce base anchored to ground
      const bboxNow = new THREE.Box3().setFromObject(b.mesh);
      if (bboxNow.min.y > b.baseY) {
        b.mesh.position.y -= (bboxNow.min.y - b.baseY);
      }

      if (b.damageLevel >= 0.98 && !b.destroyed) {
        // Rare collapse for tall, heavily damaged buildings
        const tiltMag = Math.abs(b.mesh.rotation.x) + Math.abs(b.mesh.rotation.z);
        const tiltBoost = 1 + Math.min(2.0, tiltMag * 3.0);
        if (b.height >= 35 && Math.random() < 0.015 * tiltBoost) {
          b.destroyed = true;
          // Leave a rubble pile at the collapsed building site
          this.spawnGroundRubble(b.centerX, b.centerZ, 5, this.rubbleMat, 10, [0.3, 0.8]);
        }
      }
    }

    this.buildingsDamaged = damaged;
    this.buildingsDestroyed = destroyed;
  }

  private applyDamage(b: BuildingRecord) {
    const d = b.damageLevel;
    const mat = b.mesh.material as THREE.MeshPhongMaterial;

    const dark = b.originalColor.clone().multiplyScalar(0.8);
    mat.color.copy(b.originalColor).lerp(dark, Math.min(d * 0.6, 0.6));

    // No vertical sinking; damage is expressed via fragments/tilt.
  }

  private maybeTiltBuilding(b: BuildingRecord, effectiveSpeed: number) {
    if (b.tiltTargetX !== undefined || b.tiltTargetZ !== undefined) {
      const targetX = b.tiltTargetX ?? 0;
      const targetZ = b.tiltTargetZ ?? 0;
      b.mesh.rotation.x = THREE.MathUtils.lerp(b.mesh.rotation.x, targetX, 0.05);
      b.mesh.rotation.z = THREE.MathUtils.lerp(b.mesh.rotation.z, targetZ, 0.05);
      const bboxLive = new THREE.Box3().setFromObject(b.mesh);
      const sizeLive = bboxLive.getSize(new THREE.Vector3());
      const xHalf = sizeLive.x * 0.5;
      const zHalf = sizeLive.z * 0.5;
      const sink = Math.min(0.9,
        Math.abs(Math.sin(b.mesh.rotation.x)) * zHalf +
        Math.abs(Math.sin(b.mesh.rotation.z)) * xHalf
      );
      b.mesh.position.y = b.baseY - sink - b.height * 0.05;
      return;
    }

    // Tornado base failure tilt when damaged
    const tiltChance = 0.01 + b.damageLevel * 0.04;
    if (b.damageLevel >= 0.35 && effectiveSpeed >= DMG.wallPanels && Math.random() < tiltChance) {
      const tilt = (Math.random() - 0.5) * (0.12 + b.damageLevel * 0.25);
      if (Math.random() < 0.5) {
        b.tiltTargetX = tilt;
        b.tiltTargetZ = 0;
      } else {
        b.tiltTargetX = 0;
        b.tiltTargetZ = tilt;
      }
    }
  }

  private maybeSpawnBuildingChunk(b: BuildingRecord, effectiveSpeed: number) {
    if (b.damageLevel < 0.6 || effectiveSpeed < DMG.partialCollapse) return;
    const chunkChance = (0.004 + b.damageLevel * 0.02) * (0.6 + this.efRating * 0.15);
    if (this.efRating < 2 || Math.random() > chunkChance) return;

    const bboxLive = new THREE.Box3().setFromObject(b.mesh);
    const centerLive = bboxLive.getCenter(new THREE.Vector3());
    const sizeLive = bboxLive.getSize(new THREE.Vector3());
    const side = Math.random() < 0.5 ? "x" : "z";
    const sign = Math.random() < 0.5 ? -1 : 1;
    const edgeOffset = (side === "x" ? sizeLive.x : sizeLive.z) * 0.6 * sign;
    const dx = side === "x" ? edgeOffset : (Math.random() - 0.5) * sizeLive.x * 0.5;
    const dz = side === "z" ? edgeOffset : (Math.random() - 0.5) * sizeLive.z * 0.5;
    const sideY = bboxLive.min.y + (bboxLive.max.y - bboxLive.min.y) * (0.5 + Math.random() * 0.3);

    const sizeScale = 0.8 + b.damageLevel * 1.2;
    const chunkGeo = Math.random() < 0.5
      ? new THREE.BoxGeometry(1.6 * sizeScale, 1.2 * sizeScale, 1.4 * sizeScale)
      : new THREE.ConeGeometry(0.9 * sizeScale, 1.6 * sizeScale, 4);
    const chunkMat = new THREE.MeshPhongMaterial({
      color: b.originalColor.clone().lerp(new THREE.Color(0x666666), 0.4),
      emissive: b.originalColor.clone().lerp(new THREE.Color(0x222222), 0.7),
      emissiveIntensity: 0.25,
    });
    (chunkMat as any).userData = { isFragment: true };
    const mesh = new THREE.Mesh(chunkGeo, chunkMat);
    mesh.position.set(centerLive.x + dx, sideY, centerLive.z + dz);
    mesh.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);
    mesh.scale.setScalar(0.9 + Math.random() * 0.8);
    mesh.castShadow = true;
    this.debrisGroup.add(mesh);

    const wind = this.getWindVector(mesh.position.x, mesh.position.y, mesh.position.z);
    this.debris.push({
      mesh,
      velocity: new THREE.Vector3(
        wind.x * 0.3 + (Math.random() - 0.5) * 6,
        8 + Math.random() * 10,
        wind.z * 0.3 + (Math.random() - 0.5) * 6,
      ),
      angularVel: new THREE.Vector3(
        (Math.random() - 0.5) * 2,
        (Math.random() - 0.5) * 2,
        (Math.random() - 0.5) * 2,
      ),
      life: 0,
      grounded: false,
      captured: true,
      allowSpinOut: true,
      mass: 0.9,
    });
  }

  /** Rip a small building whole from its foundation and fling it into the vortex. */
  private uprootBuilding(b: BuildingRecord) {
    b.destroyed = true;
    b.damageLevel = 1;

    // Leave a rubble foundation at the original site
    this.spawnGroundRubble(b.centerX, b.centerZ, 6, this.rubbleMat, 8, [0.3, 0.7]);

    const mesh = b.mesh;
    const wp = new THREE.Vector3();
    mesh.getWorldPosition(wp);
    mesh.parent?.remove(mesh);
    mesh.position.copy(wp);
    // Restore full height so the whole building is visible flying
    mesh.scale.y = 1;
    this.debrisGroup.add(mesh);

    const wind = this.getWindVector(wp.x, wp.y + b.height * 0.5, wp.z);
    this.debris.push({
      mesh,
      velocity: new THREE.Vector3(
        wind.x * 0.3 + (Math.random() - 0.5) * 8,
        20 + Math.random() * 25,
        wind.z * 0.3 + (Math.random() - 0.5) * 8,
      ),
      angularVel: new THREE.Vector3(
        (Math.random() - 0.5) * 2.5,
        (Math.random() - 0.5) * 2.5,
        (Math.random() - 0.5) * 2.5,
      ),
      life: 0,
      grounded: false,
      captured: true,
      lockCaptured: true,
      ttl: 120,
      mass: 0.35,   // lighter so vortex grabs it quickly
    });
  }

  /**
   * More granular fragment spawning at every 8-10 % damage increment.
   * Fragments use the building's original colour so you can see pieces
   * breaking off and getting sucked into the vortex.
   */
  private maybeSpawnDebris(b: BuildingRecord, prevDmg: number) {
    const thresholds = [0.06, 0.14, 0.22, 0.32, 0.42, 0.52, 0.62, 0.72, 0.82, 0.92];
    const debrisScale = this.getDebrisScale();

    for (const t of thresholds) {
      if (prevDmg < t && b.damageLevel >= t) {
        this.chipBuilding(b, 0.8);
        const count = Math.max(1, Math.floor((2 + Math.random() * 4) * debrisScale));
        for (let i = 0; i < count; i++) {
          const geoIdx = Math.floor(Math.random() * this.debrisGeos.length);
          const fragY = b.baseY + b.height * Math.max(0.1, 1 - b.damageLevel) * (0.3 + Math.random() * 0.7);
          this.spawnBuildingFragment(
            b.centerX + (Math.random() - 0.5) * 10,
            fragY,
            b.centerZ + (Math.random() - 0.5) * 10,
            geoIdx,
            b.originalColor,
          );
        }
      }
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

  // ─────────────────────────────────────────────────────────────────────────
  // Debris system
  // ─────────────────────────────────────────────────────────────────────────

  /** Remove a debris entry — only disposes fragment-spawned materials (not shared tree/building ones). */
  private removeDebris(idx: number) {
    const d = this.debris[idx]!;
    this.debrisGroup.remove(d.mesh);
    const matLike = (d.mesh as any).material as THREE.Material | THREE.Material[] | undefined;
    if (matLike && !Array.isArray(matLike)) {
      const mat = matLike as THREE.Material;
      if ((mat as any).userData?.isFragment) mat.dispose();
    }
    this.debris.splice(idx, 1);
  }

  /** Spawn a building-coloured fragment — starts captured so it flies into the vortex. */
  private spawnBuildingFragment(
    x: number, y: number, z: number,
    geoIdx: number,
    buildingColor: THREE.Color,
  ) {
    // Evict oldest debris if at capacity
    if (this.debris.length >= MAX_DEBRIS) {
      this.removeDebris(0);
    }

    const geo = this.debrisGeos[geoIdx % this.debrisGeos.length]!;
    // Bright, saturated color so fragments pop against the dark storm sky
    const fragColor = buildingColor.clone().lerp(new THREE.Color(0x666666), Math.random() * 0.15);
    const mat = new THREE.MeshPhongMaterial({ color: fragColor, emissive: fragColor, emissiveIntensity: 0.3 });
    (mat as any).userData = { isFragment: true };
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, y, z);
    mesh.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);
    mesh.scale.setScalar(1.5 + Math.random() * 2.5);
    mesh.castShadow = true;
    this.debrisGroup.add(mesh);

    const wind = this.getWindVector(x, y, z);
    const mass = geoIdx <= 1 ? 0.2 : geoIdx <= 2 ? 0.35 : 0.5;

    this.debris.push({
      mesh,
      velocity: new THREE.Vector3(
        wind.x * 0.4 + (Math.random() - 0.5) * 10,
        wind.y * 0.3 + 15 + Math.random() * 25,
        wind.z * 0.4 + (Math.random() - 0.5) * 10,
      ),
      angularVel: new THREE.Vector3(
        (Math.random() - 0.5) * 6,
        (Math.random() - 0.5) * 6,
        (Math.random() - 0.5) * 6,
      ),
      life: 0,
      grounded: false,
      captured: true,
      allowSpinOut: true,
      mass,
    });
  }

  private updateDebris(dt: number, buildings: BuildingRecord[]) {
    const captureR = this.coreRadius * 3;
    const AIRBORNE_TTL = 20;   // seconds before airborne debris is removed (unless overridden)
    const GROUNDED_TTL = 8;    // seconds a grounded piece stays before cleanup

    for (let i = this.debris.length - 1; i >= 0; i--) {
      const d = this.debris[i]!;
      d.life += dt;
      if (d.radius === undefined) {
        const box = new THREE.Box3().setFromObject(d.mesh);
        const size = box.getSize(new THREE.Vector3());
        d.radius = Math.max(size.x, size.z, size.y) * 0.45;
      }

      // ── TTL cleanup ──
      if (d.grounded && d.life > GROUNDED_TTL) {
        this.removeDebris(i);
        continue;
      }
      const ttl = d.ttl ?? AIRBORNE_TTL;
      if (!d.grounded && d.life > ttl) {
        this.removeDebris(i);
        continue;
      }

      // Grounded debris doesn't need physics
      if (d.grounded) continue;

      const pos = d.mesh.position;
      const dx = pos.x - this.position.x;
      const dz = pos.z - this.position.z;
      const distToVortex = Math.sqrt(dx * dx + dz * dz);

      // ── Capture logic ──
      if (!d.captured && this.active && distToVortex < captureR) {
        const ws = this.getWindSpeedAtGround(pos.x, pos.z);
        if (ws > 20 / d.mass) {
          d.captured = true;
          if (d.orbitRadius === undefined) {
            d.orbitRadius = this.coreRadius * (0.7 + Math.random() * 0.7);
            d.orbitHeight = this.position.y + FUNNEL_HEIGHT * (0.25 + Math.random() * 0.35);
            d.orbitDrift = (Math.random() - 0.5) * 0.25;
          }
        }
      }
      if (!d.lockCaptured && d.captured && (distToVortex > captureR * 1.5 || !this.active)) {
        d.captured = false;
      }

      // ── Physics: captured vs free ──
      let dragC: number;
      let gravScale: number;

      if (d.captured) {
        const proximity = 1 - Math.min(distToVortex / captureR, 1);
        // Very high drag so debris velocity closely tracks the circular wind
        dragC = 2.5 + proximity * 2.5;           // 2.5 – 5.0
        gravScale = 0.05;                         // almost weightless inside vortex
      } else {
        dragC = 0.35;
        gravScale = 1.0;
      }

      // ── Forces ──
      const wind = this.getWindVector(pos.x, pos.y, pos.z);
      const relVel = wind.clone().sub(d.velocity);
      const dragForce = relVel.multiplyScalar(dragC);

      d.velocity.y += -9.81 * gravScale * dt;
      d.velocity.add(dragForce.clone().multiplyScalar(dt));

      // ── Orbit targeting for captured debris ──
      // Spring force holds debris at mid-funnel height & near core radius
      if (d.captured) {
        // Target height: 30–50 % of funnel, varies per piece for visual spread
        const drift = (d.orbitDrift ?? 0) * Math.sin(d.life * 0.4);
        const targetY = (d.orbitHeight ?? (this.position.y + FUNNEL_HEIGHT * 0.35)) + drift * FUNNEL_HEIGHT * 0.05;
        d.velocity.y += (targetY - pos.y) * 2.0 * dt;

        // Gentle radial spring keeps debris near the core wall (visible orbit ring)
        const targetR = d.lockCaptured
          ? this.coreRadius * 1.05
          : (d.orbitRadius ?? this.coreRadius * 0.9);
        if (distToVortex > 0.1) {
          const radialErr = targetR - distToVortex;
          const pushX = (dx / distToVortex) * radialErr * 1.2 * dt;
          const pushZ = (dz / distToVortex) * radialErr * 1.2 * dt;
          d.velocity.x += pushX;
          d.velocity.z += pushZ;
        }

        // Low chance spin-out: lose capture and fling outward
        if (!d.lockCaptured && d.allowSpinOut !== false && this.efRating >= 3 && Math.random() < 0.0006) {
          const out = Math.max(distToVortex, 1);
          const nx = dx / out;
          const nz = dz / out;
          d.velocity.x += nx * (12 + Math.random() * 10);
          d.velocity.y += 6 + Math.random() * 6;
          d.velocity.z += nz * (12 + Math.random() * 10);
          d.captured = false;
        }
      }

      pos.x += d.velocity.x * dt;
      pos.y += d.velocity.y * dt;
      pos.z += d.velocity.z * dt;

      // ── Building collision ──
      for (const b of buildings) {
        if (b.destroyed) continue;
        const dxB = pos.x - b.centerX;
        const dzB = pos.z - b.centerZ;
        const distB = Math.hypot(dxB, dzB);
        const bRadius = b.width * 0.6;
        const r = d.radius ?? 1.5;
        if (distB < bRadius + r && pos.y < b.baseY + b.height + r) {
          const nx = dxB / Math.max(distB, 0.001);
          const nz = dzB / Math.max(distB, 0.001);
          const push = (bRadius + r - distB) + 0.2;
          pos.x += nx * push;
          pos.z += nz * push;
          const vn = d.velocity.x * nx + d.velocity.z * nz;
          if (vn < 0) {
            d.velocity.x -= 1.6 * vn * nx;
            d.velocity.z -= 1.6 * vn * nz;
          }
          d.velocity.y *= 0.6;
          d.angularVel.x += (Math.random() - 0.5) * 0.6;
          d.angularVel.y += (Math.random() - 0.5) * 0.6;
          d.angularVel.z += (Math.random() - 0.5) * 0.6;
          if (Math.abs(vn) > 10) {
            b.damageLevel = Math.min(1, b.damageLevel + 0.02);
          }
        }
      }

      d.mesh.rotation.x += d.angularVel.x * dt;
      d.mesh.rotation.y += d.angularVel.y * dt;
      d.mesh.rotation.z += d.angularVel.z * dt;

      // ── Ground collision ──
      const groundY = getTerrainHeight(pos.x, pos.z);
      if (pos.y <= groundY + 0.3) {
        if (d.captured && distToVortex < captureR) {
          d.velocity.y = Math.abs(d.velocity.y) * 0.4 + 4;
          pos.y = groundY + 0.5;
        } else {
          pos.y = groundY + 0.3;
          if (Math.abs(d.velocity.y) < 3) {
            d.grounded = true;
            d.life = 0; // reset timer for grounded TTL
            d.velocity.set(0, 0, 0);
            d.angularVel.set(0, 0, 0);
          } else {
            d.velocity.y *= -0.25;
            d.velocity.x *= 0.6;
            d.velocity.z *= 0.6;
            d.angularVel.multiplyScalar(0.4);
          }
        }
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Earth rip-up debris (brown dirt flying into the vortex)
  // ─────────────────────────────────────────────────────────────────────────

  private spawnDirtDebris() {
    const scale = this.getDebrisScale();
    const count = Math.max(1, Math.floor((1 + Math.random() * 3) * scale));
    for (let i = 0; i < count; i++) {
      if (this.debris.length >= MAX_DEBRIS) this.removeDebris(0);

      // Spawn near the tornado base, scattered within core radius
      const angle = Math.random() * Math.PI * 2;
      const dist  = Math.random() * this.coreRadius * 1.5;
      const x = this.position.x + Math.cos(angle) * dist;
      const z = this.position.z + Math.sin(angle) * dist;
      const y = getTerrainHeight(x, z);

      const mesh = new THREE.Mesh(this.dirtGeo, this.dirtMat);
      mesh.position.set(x, y, z);
      mesh.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);
      mesh.scale.setScalar(0.8 + Math.random() * 1.8);
      mesh.castShadow = true;
      this.debrisGroup.add(mesh);

      const wind = this.getWindVector(x, y + 2, z);
      this.debris.push({
        mesh,
        velocity: new THREE.Vector3(
          wind.x * 0.2 + (Math.random() - 0.5) * 6,
          12 + Math.random() * 20,
          wind.z * 0.2 + (Math.random() - 0.5) * 6,
        ),
        angularVel: new THREE.Vector3(
          (Math.random() - 0.5) * 5,
          (Math.random() - 0.5) * 5,
          (Math.random() - 0.5) * 5,
        ),
        life: 0,
        grounded: false,
        captured: true,
        mass: 0.3,
      });
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Ground rubble (persistent aftermath at destruction sites)
  // ─────────────────────────────────────────────────────────────────────────

  /** Scatter rubble meshes on the ground at a destruction site. */
  private spawnGroundRubble(
    x: number, z: number, count: number,
    mat: THREE.Material, spread: number, scaleRange: [number, number],
  ) {
    for (let i = 0; i < count; i++) {
      if (this.debris.length >= MAX_DEBRIS) this.removeDebris(0);

      const geoIdx = Math.floor(Math.random() * this.debrisGeos.length);
      const geo = this.debrisGeos[geoIdx]!;
      const rx = x + (Math.random() - 0.5) * spread;
      const rz = z + (Math.random() - 0.5) * spread;
      const gy = getTerrainHeight(rx, rz);

      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(rx, gy + 0.15 + Math.random() * 0.4, rz);
      mesh.rotation.set(Math.random() * 0.4, Math.random() * Math.PI * 2, Math.random() * 0.4);
      mesh.scale.setScalar(scaleRange[0] + Math.random() * (scaleRange[1] - scaleRange[0]));
      this.debrisGroup.add(mesh);

      this.debris.push({
        mesh,
        velocity: new THREE.Vector3(),
        angularVel: new THREE.Vector3(),
        life: -50,       // stays ~58 seconds before cleanup (GROUNDED_TTL = 8)
        grounded: true,
        captured: false,
        mass: 1,
      });
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Ground damage trail (crater painting)
  // ─────────────────────────────────────────────────────────────────────────

  private paintGround() {
    if (!terrainCanvasRef || !terrainTextureRef || !terrainBoundsRef) return;
    const b = terrainBoundsRef;
    const TEX = terrainCanvasRef.width;
    const u = (this.position.x - b.xMin) / b.width;
    const v = (this.position.z - b.zMin) / b.depth;
    if (u < 0 || u > 1 || v < 0 || v > 1) return;

    const ctx = terrainCanvasRef.getContext("2d")!;
    const cx = u * TEX;
    const cy = v * TEX;
    const r  = (this.coreRadius / b.width) * TEX * 1.2;

    ctx.save();
    // Wide brown swath — overturned dirt/concrete
    ctx.globalAlpha = 0.22;
    ctx.fillStyle = "#4a2f1a";
    ctx.beginPath();
    ctx.arc(cx, cy, r * 1.35, 0, Math.PI * 2);
    ctx.fill();
    // Darker core
    ctx.globalAlpha = 0.20;
    ctx.fillStyle = "#2f1c10";
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.7, 0, Math.PI * 2);
    ctx.fill();
    // Scattered gouge marks around the path
    for (let i = 0; i < 5; i++) {
      const ox = (Math.random() - 0.5) * r * 2;
      const oz = (Math.random() - 0.5) * r * 2;
      ctx.globalAlpha = 0.10 + Math.random() * 0.06;
      ctx.fillStyle = "#3a2415";
      ctx.beginPath();
      ctx.arc(cx + ox, cy + oz, r * (0.22 + Math.random() * 0.35), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    terrainTextureRef.needsUpdate = true;
  }
}
