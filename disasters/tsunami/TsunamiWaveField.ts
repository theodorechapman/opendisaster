import * as THREE from "three";
import {
  createHydroState,
  type TsunamiBounds,
  type TsunamiHydroState,
  type TsunamiParams,
} from "./TsunamiTypes.ts";

type MomentumPulse = {
  x: number;
  z: number;
  vx: number;
  vz: number;
  radiusMeters: number;
  strength: number;
  ttlSec: number;
};

export class TsunamiWaveField {
  readonly direction = new THREE.Vector2(0, -1);

  private readonly bounds: TsunamiBounds;
  private readonly lateralDirection = new THREE.Vector2(1, 0);
  private readonly gravity = 9.81;
  private readonly scratchHydro = createHydroState();
  private readonly momentumPulses: MomentumPulse[] = [];
  private params: TsunamiParams;
  private startProjection = 0;
  private minProjection = 0;
  private maxProjection = 0;
  private frontProjection = 0;
  private elapsed = 0;

  constructor(bounds: TsunamiBounds, initialParams: TsunamiParams) {
    this.bounds = bounds;
    this.params = { ...initialParams };
    this.lateralDirection.set(-this.direction.y, this.direction.x).normalize();
    this.computeProjectionRange();
    this.reset();
  }

  update(dt: number): void {
    this.elapsed += dt;
    this.frontProjection += this.params.waveSpeed * dt;

    const pulseDamping = Math.exp(-Math.max(0, dt) * (1.2 + 1.15 * this.params.solverQuality));
    for (let i = this.momentumPulses.length - 1; i >= 0; i--) {
      const pulse = this.momentumPulses[i]!;
      pulse.ttlSec -= dt;
      pulse.strength *= pulseDamping;
      if (pulse.ttlSec <= 0 || pulse.strength < 0.01) {
        this.momentumPulses.splice(i, 1);
      }
    }
  }

  reset(): void {
    const startOffset = this.params.waveWidth * 2.0;
    this.startProjection = this.minProjection - startOffset;
    this.frontProjection = this.startProjection;
    this.elapsed = 0;
    this.momentumPulses.length = 0;
  }

  setParams(partial: Partial<TsunamiParams>): void {
    const progress = this.getProgress();
    this.params = { ...this.params, ...partial };
    this.computeProjectionRange();
    const travel = this.maxProjection - this.startProjection;
    this.frontProjection = this.startProjection + travel * progress;
  }

  injectMomentumImpulse(
    x: number,
    z: number,
    vx: number,
    vz: number,
    radiusMeters: number,
    strength = 1,
    ttlSec = 0.65
  ): void {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return;
    if (!Number.isFinite(vx) || !Number.isFinite(vz)) return;
    if (!Number.isFinite(radiusMeters) || !Number.isFinite(strength)) return;

    const pulse: MomentumPulse = {
      x,
      z,
      vx,
      vz,
      radiusMeters: Math.max(0.8, radiusMeters),
      strength: Math.max(0, strength),
      ttlSec: Math.max(0.05, ttlSec),
    };
    if (pulse.strength <= 0.001) return;

    this.momentumPulses.push(pulse);
    if (this.momentumPulses.length > 160) {
      this.momentumPulses.splice(0, this.momentumPulses.length - 160);
    }
  }

  getWaveHeightAt(x: number, z: number): number {
    return this.getHydroStateAt(x, z, 0, this.scratchHydro).depth;
  }

  getFlowVelocityAt(x: number, z: number): { vx: number; vz: number } {
    const hydro = this.getHydroStateAt(x, z, 0, this.scratchHydro);
    return { vx: hydro.vx, vz: hydro.vz };
  }

  getHydroStateAt(
    x: number,
    z: number,
    terrainY: number,
    out?: TsunamiHydroState
  ): TsunamiHydroState {
    const state = out ?? createHydroState();
    const delta = this.frontProjection - this.project(x, z);
    const width = Math.max(6, this.params.waveWidth);
    const periodDistance = Math.max(width * 1.5, this.params.wavePeriodSec * this.params.waveSpeed);

    let rawDepth = 0;
    let boreSignal = 0;
    let backwashSignal = 0;

    for (let waveIndex = 0; waveIndex < Math.max(1, Math.round(this.params.numWaves)); waveIndex++) {
      const local = delta - waveIndex * periodDistance;
      if (local < -width * 1.0) {
        continue;
      }

      const amp = this.waveAmplitudeAt(waveIndex);
      const crestPos = width * (0.2 + 0.06 * waveIndex);
      const sigma = width * (0.18 + 0.02 * waveIndex);
      const crest = Math.exp(-((local - crestPos) * (local - crestPos)) / (2 * sigma * sigma));
      const lead = smoothstep(-width * 0.7, width * 0.35, local);
      const tail = 1 - smoothstep(width * 3.2, width * 6.3, local);
      const runupBody = Math.max(0, lead * tail);
      rawDepth += this.params.waveHeight * amp * (0.55 * runupBody + 1.05 * crest);

      boreSignal += amp * crest;

      const retreatStart = width * (1.3 + 0.25 * waveIndex);
      const retreatRise = smoothstep(retreatStart, retreatStart + width * 1.45, local);
      const retreatFall = 1 - smoothstep(retreatStart + width * 2.6, retreatStart + width * 5.8, local);
      backwashSignal += amp * retreatRise * retreatFall;
    }

    // Real runup depth attenuates uphill; use terrain elevation as a simple proxy.
    const terrainAttenuation = 1 / (1 + Math.max(0, terrainY) * 0.0025);
    let depth = Math.max(0, rawDepth * terrainAttenuation);
    const pulse = this.computePulseInfluence(x, z);
    const pulseImpulseBoost = pulse.speed * 0.12;

    if (depth <= 0.004 && pulse.speed <= 0.01) {
      state.depth = 0;
      state.surfaceY = terrainY;
      state.vx = 0;
      state.vz = 0;
      state.speed = 0;
      state.froude = 0;
      state.dynamicPressure = 0;
      state.impulseFactor = 1;
      state.phase = "dry";
      return state;
    }

    const quality = clamp(this.params.solverQuality, 0.4, 2.5);
    const depthNorm = Math.min(1.5, depth / Math.max(1, this.params.waveHeight));
    const forward = this.params.waveSpeed * (0.26 + 0.74 * Math.min(1, depthNorm));
    let impulseFactor = 1 + this.params.impulseGain * clamp01(boreSignal * 1.8);
    impulseFactor += pulseImpulseBoost * quality;
    const impulse =
      this.params.waveSpeed *
      this.params.impulseGain *
      clamp01(boreSignal) *
      (0.34 + 0.08 * this.params.impulseCoeffBore);
    const backwash =
      this.params.waveSpeed *
      this.params.backwashStrength *
      clamp01(backwashSignal) *
      (0.35 + 0.65 * Math.min(1, depthNorm));

    const along = forward + impulse - backwash;
    const lateralOscillation =
      Math.sin(x * 0.032 + this.elapsed * 1.9) +
      Math.cos(z * 0.041 - this.elapsed * 1.6);
    const lateral =
      0.5 * lateralOscillation * this.params.turbulence * (0.18 + 0.32 * Math.min(1, depthNorm));

    let vx = this.direction.x * along + this.lateralDirection.x * lateral;
    let vz = this.direction.y * along + this.lateralDirection.y * lateral;

    vx += pulse.vx;
    vz += pulse.vz;
    depth += pulse.depthBoost;

    if (this.params.accuracyMode === "enhanced") {
      const steepness = clamp01(boreSignal * 1.25 + Math.abs(backwashSignal - boreSignal) * 0.35);
      const verticalInertia = this.params.nonHydrostaticBoost * quality * steepness;
      const oscillatory =
        0.5 + 0.5 * Math.sin((x * 0.021 - z * 0.018) + this.elapsed * (0.68 + 0.08 * quality));
      const depthBoost = depth * (0.04 + 0.10 * verticalInertia) * oscillatory;
      depth += depthBoost;
      const nonHydroVelScale = 1 + verticalInertia * 0.06;
      vx *= nonHydroVelScale;
      vz *= nonHydroVelScale;
    }

    depth = Math.max(0, depth);
    const speed = Math.hypot(vx, vz);
    const froude = speed / Math.sqrt(this.gravity * Math.max(depth, 0.02));
    const dynamicPressure = 0.5 * this.params.rhoWater * speed * speed * impulseFactor;

    state.depth = depth;
    state.surfaceY = terrainY + depth;
    state.vx = vx;
    state.vz = vz;
    state.speed = speed;
    state.froude = froude;
    state.dynamicPressure = dynamicPressure;
    state.impulseFactor = Math.max(1, impulseFactor);
    state.phase = determinePhase(along, boreSignal, backwashSignal);

    return state;
  }

  getProgress(): number {
    const denom = Math.max(1e-6, this.maxProjection - this.startProjection);
    return THREE.MathUtils.clamp((this.frontProjection - this.startProjection) / denom, 0, 1.5);
  }

  getFrontMeters(): number {
    return this.frontProjection - this.startProjection;
  }

  getCurrentWaveIndex(): number {
    const wave = Math.floor(this.elapsed / Math.max(1, this.params.wavePeriodSec)) + 1;
    return clampInt(wave, 1, Math.max(1, Math.round(this.params.numWaves)));
  }

  private computeProjectionRange(): void {
    const corners: Array<[number, number]> = [
      [this.bounds.xMin, this.bounds.zMin],
      [this.bounds.xMin, this.bounds.zMax],
      [this.bounds.xMax, this.bounds.zMin],
      [this.bounds.xMax, this.bounds.zMax],
    ];

    let minProjection = Number.POSITIVE_INFINITY;
    let maxProjection = Number.NEGATIVE_INFINITY;

    for (const [x, z] of corners) {
      const projection = this.project(x, z);
      minProjection = Math.min(minProjection, projection);
      maxProjection = Math.max(maxProjection, projection);
    }

    this.minProjection = minProjection;
    this.maxProjection = maxProjection + this.params.waveWidth * 2.8;
  }

  private waveAmplitudeAt(index: number): number {
    const base = Math.exp(-index * 0.42);
    const variation = 1 + 0.08 * Math.sin(index * 1.7 + 0.6);
    return Math.max(0.15, base * variation);
  }

  private computePulseInfluence(
    x: number,
    z: number
  ): { vx: number; vz: number; depthBoost: number; speed: number } {
    if (this.momentumPulses.length === 0) {
      return { vx: 0, vz: 0, depthBoost: 0, speed: 0 };
    }

    let vx = 0;
    let vz = 0;
    let depthBoost = 0;
    let speed = 0;

    for (const pulse of this.momentumPulses) {
      const dx = x - pulse.x;
      const dz = z - pulse.z;
      const radius2 = pulse.radiusMeters * pulse.radiusMeters;
      const dist2 = dx * dx + dz * dz;
      if (dist2 > radius2 * 6.5) continue;

      const falloff = Math.exp(-dist2 / Math.max(1e-6, radius2 * 0.7));
      const weight = pulse.strength * falloff;
      const pvx = pulse.vx * weight;
      const pvz = pulse.vz * weight;
      vx += pvx;
      vz += pvz;
      speed += Math.hypot(pvx, pvz);
      depthBoost += Math.hypot(pulse.vx, pulse.vz) * 0.03 * falloff * pulse.strength;
    }

    return { vx, vz, depthBoost, speed };
  }

  private project(x: number, z: number): number {
    return x * this.direction.x + z * this.direction.y;
  }
}

function determinePhase(along: number, boreSignal: number, backwashSignal: number) {
  if (along <= 0 || backwashSignal > boreSignal * 1.08) {
    return "backwash" as const;
  }
  if (boreSignal > 0.28) {
    return "crest" as const;
  }
  return "runup" as const;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / Math.max(1e-6, edge1 - edge0));
  return t * t * (3 - 2 * t);
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
