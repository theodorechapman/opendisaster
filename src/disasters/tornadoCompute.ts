/**
 * Tornado GPU Compute Pipeline — All heavy simulation logic runs on WebGPU
 * compute shaders via Three.js TSL. The CPU side (tornado.ts) handles mesh
 * management, spawning, and reading back results.
 */

import * as THREE from "three";
import {
  Fn, instanceIndex, uniform, float, int, vec2, vec3,
  sin, cos, sqrt, abs, clamp, max, min, pow, select,
  If, Loop, Continue, Return,
  instancedArray,
} from "three/tsl";

// ─── Constants ──────────────────────────────────────────────────────────────

export const FUNNEL_PARTICLES = 12000;
export const MAX_DEBRIS = 350;
export const FUNNEL_HEIGHT = 280;
const MAX_BUILDINGS = 512;

// Wind speed thresholds for building damage (m/s)
const DMG_ROOF_COVERING = 30;
const DMG_TOTAL_COLLAPSE = 90;

// EF5 max speed for scaling
const EF5_SPEED = 135;

// ─── Uniforms ───────────────────────────────────────────────────────────────

export const uVortexPosX = uniform(0.0);
export const uVortexPosY = uniform(0.0);
export const uVortexPosZ = uniform(0.0);
export const uMaxWind = uniform(74.0);
export const uCoreRadius = uniform(50.0);
export const uOuterRadius = uniform(200.0);
export const uHeading = uniform(0.0);
export const uTransSpeed = uniform(15.0);
export const uTime = uniform(0.0);
export const uDt = uniform(0.016);
export const uBendDirX = uniform(1.0);
export const uBendDirY = uniform(0.0);
export const uBendStrength = uniform(0.0);
export const uEfRating = uniform(3.0);
export const uActive = uniform(0.0); // 1.0 = active
export const uBuildingCount = uniform(0);
export const uDebrisCount = uniform(0);
export const uLeanDirX = uniform(0.0);
export const uLeanDirY = uniform(0.0);
export const uLeanStrength = uniform(0.0);

// ─── Storage Buffers ────────────────────────────────────────────────────────

// Funnel particles: params (baseRadius, height, angle, angularSpeed)
export const particleParams = instancedArray(FUNNEL_PARTICLES, "vec4");
// Funnel particles: oscillation (radOscAmp, radOscFreq, radOscPhase, vertOscAmp)
export const particleOsc = instancedArray(FUNNEL_PARTICLES, "vec4");
// Funnel particles: oscillation2 (vertOscFreq, vertOscPhase, 0, 0)
export const particleOsc2 = instancedArray(FUNNEL_PARTICLES, "vec4");
// Funnel particles: output positions (x, y, z) — used as InstancedMesh attribute
export const particlePositions = instancedArray(FUNNEL_PARTICLES, "vec3");

// Debris state: 3 vec4 per piece = 12 floats
// slot0: (posX, posY, posZ, velX)
// slot1: (velY, velZ, angVelX, angVelY)
// slot2: (angVelZ, life, mass, flags)
// flags: bit0=captured, bit1=grounded, bit2=lockCaptured, bit3=allowSpinOut
export const debrisSlot0 = instancedArray(MAX_DEBRIS, "vec4");
export const debrisSlot1 = instancedArray(MAX_DEBRIS, "vec4");
export const debrisSlot2 = instancedArray(MAX_DEBRIS, "vec4");
// Debris extra: (orbitRadius, orbitHeight, orbitDrift, radius)
export const debrisExtra = instancedArray(MAX_DEBRIS, "vec4");

// Buildings: 3 vec4 per building
// slot0: (centerX, centerZ, baseY, height)
// slot1: (halfX, halfZ, width, structuralStrength)
// slot2: (damageLevel, destroyed, 0, 0)
export const buildingSlot0 = instancedArray(MAX_BUILDINGS, "vec4");
export const buildingSlot1 = instancedArray(MAX_BUILDINGS, "vec4");
export const buildingSlot2 = instancedArray(MAX_BUILDINGS, "vec4");

// ─── TSL Helper: Rankine vortex wind field ──────────────────────────────────

/** Reusable TSL function: wind speed at ground level (scalar). */
const windSpeedAtGround = Fn(([px, pz]: [any, any]) => {
  const dx = float(px).sub(uVortexPosX);
  const dz = float(pz).sub(uVortexPosZ);
  const r = sqrt(dx.mul(dx).add(dz.mul(dz)));
  const rSafe = max(r, 0.1);

  const vTanCore = uMaxWind.mul(rSafe.div(uCoreRadius));
  const vTanOuter = uMaxWind.mul(uCoreRadius.div(rSafe));
  const vTan = select(r.lessThanEqual(uCoreRadius), vTanCore, vTanOuter);

  const inflowCore = float(0.2);
  const inflowOuter = float(0.4).mul(uCoreRadius.div(rSafe));
  const inflowFactor = select(r.lessThanEqual(uCoreRadius), inflowCore, inflowOuter);
  const vRad = vTan.mul(inflowFactor);

  return sqrt(vTan.mul(vTan).add(vRad.mul(vRad)));
});

/** Reusable TSL function: full 3D wind vector. */
const windVector = Fn(([px, py, pz]: [any, any, any]) => {
  const dx = float(px).sub(uVortexPosX);
  const dz = float(pz).sub(uVortexPosZ);
  const r = sqrt(dx.mul(dx).add(dz.mul(dz)));

  // At center: pure updraft
  const rSafe = max(r, 0.1);

  const vTanCore = uMaxWind.mul(rSafe.div(uCoreRadius));
  const vTanOuter = uMaxWind.mul(uCoreRadius.div(rSafe));
  const vTan = select(r.lessThanEqual(uCoreRadius), vTanCore, vTanOuter);

  const nx = dx.div(rSafe);
  const nz = dz.div(rSafe);
  const tx = nz.negate();
  const tz = nx;

  const inflowFactor = select(r.lessThanEqual(uCoreRadius), float(0.15), float(0.35));
  const vRad = vTan.negate().mul(inflowFactor);

  const vUpCore = uMaxWind.mul(0.6).mul(float(1.0).sub(r.mul(0.5).div(uCoreRadius)));
  const vUpOuter = uMaxWind.mul(0.15).mul(uCoreRadius.div(rSafe));
  const vUp = select(r.lessThanEqual(uCoreRadius), vUpCore, vUpOuter);

  const hFactor = max(float(0.0), float(1.0).sub(float(py).div(float(FUNNEL_HEIGHT).mul(1.5))));

  const windX = tx.mul(vTan).add(nx.mul(vRad)).mul(hFactor).add(uTransSpeed.mul(cos(uHeading)));
  const windY = vUp.mul(hFactor);
  const windZ = tz.mul(vTan).add(nz.mul(vRad)).mul(hFactor).add(uTransSpeed.mul(sin(uHeading)));

  return vec3(windX, windY, windZ);
});

/** TSL bend offset calculation (mirrors CPU getBendOffset). */
const bendOffset = Fn(([h]: [any]) => {
  const hNorm = clamp(float(h).div(float(FUNNEL_HEIGHT)), 0.0, 1.0);
  const bend = pow(hNorm, 1.35).mul(uBendStrength);
  const leanAmount = uLeanStrength.mul(pow(hNorm, 1.1));
  const offX = uBendDirX.mul(bend).add(uLeanDirX.mul(leanAmount));
  const offY = uBendDirY.mul(bend).add(uLeanDirY.mul(leanAmount));
  return vec2(offX, offY);
});

// ─── Compute Shader 1: Funnel Particles ─────────────────────────────────────

export const computeFunnelParticles = Fn(() => {
  const idx = instanceIndex;
  const params = particleParams.element(idx);
  const osc = particleOsc.element(idx);
  const osc2 = particleOsc2.element(idx);

  // Read params
  const baseRadius = params.x;
  const height = params.y;
  const angle = params.z;
  const angularSpeed = params.w;

  // Read oscillation
  const radOscAmp = osc.x;
  const radOscFreq = osc.y;
  const radOscPhase = osc.z;
  const vertOscAmp = osc.w;
  const vertOscFreq = osc2.x;
  const vertOscPhase = osc2.y;

  // Update angle
  const newAngle = angle.add(angularSpeed.mul(uDt));
  params.z.assign(newAngle);

  // Compute height with vertical oscillation
  const h = height.add(vertOscAmp.mul(sin(uTime.mul(vertOscFreq).add(vertOscPhase))));

  // Rope taper (always 1.0 currently since getRopeOutFactor returns 1.0)
  const hNorm = clamp(h.div(float(FUNNEL_HEIGHT)), 0.0, 1.0);

  // Compute radius with radial oscillation
  const r = baseRadius.add(radOscAmp.mul(sin(uTime.mul(radOscFreq).add(radOscPhase))));

  // Bend offset
  const bend = bendOffset(h);

  // Write position
  const pos = particlePositions.element(idx);
  pos.x.assign(r.mul(cos(newAngle)).add(bend.x));
  pos.y.assign(max(float(0.0), h));
  pos.z.assign(r.mul(sin(newAngle)).add(bend.y));
})().compute(FUNNEL_PARTICLES);

// ─── Compute Shader 2: Building Damage ──────────────────────────────────────

export const computeBuildingDamage = Fn(() => {
  const idx = instanceIndex;

  // Early out if beyond building count
  const s0 = buildingSlot0.element(idx);
  const s1 = buildingSlot1.element(idx);
  const s2 = buildingSlot2.element(idx);

  const centerX = s0.x;
  const centerZ = s0.y;
  const height = s0.w;
  const structuralStrength = s1.w;
  const damageLevel = s2.x;
  const destroyed = s2.y;

  // Skip destroyed buildings
  If(destroyed.greaterThan(0.5), () => {
    Return();
  });

  // Distance check
  const dx = centerX.sub(uVortexPosX);
  const dz = centerZ.sub(uVortexPosZ);
  const distSq = dx.mul(dx).add(dz.mul(dz));
  const outerSq = uOuterRadius.mul(uOuterRadius);

  If(distSq.greaterThan(outerSq), () => {
    Return();
  });

  // Wind speed at building
  const ws = windSpeedAtGround(centerX, centerZ);
  const effectiveSpeed = ws.div(structuralStrength);

  If(effectiveSpeed.lessThan(float(DMG_ROOF_COVERING).mul(0.8)), () => {
    Return();
  });

  // Damage progression
  const intensity = clamp(
    effectiveSpeed.sub(float(DMG_ROOF_COVERING)).div(float(DMG_TOTAL_COLLAPSE - DMG_ROOF_COVERING)),
    0.0, 1.0,
  );
  const efRatio = uMaxWind.div(float(EF5_SPEED));
  const efScale = float(0.05).add(pow(efRatio, 1.3).mul(0.9));
  const damageRate = pow(intensity, 2.6).mul(efScale).mul(0.35);

  const newDamage = min(float(1.0), damageLevel.add(damageRate.mul(uDt)));
  s2.x.assign(newDamage);
})().compute(MAX_BUILDINGS);

// ─── Compute Shader 3: Debris Physics ───────────────────────────────────────

export const computeDebrisPhysics = Fn(() => {
  const idx = instanceIndex;

  const s0 = debrisSlot0.element(idx);
  const s1 = debrisSlot1.element(idx);
  const s2 = debrisSlot2.element(idx);
  const extra = debrisExtra.element(idx);

  // Read state
  const posX = s0.x;
  const posY = s0.y;
  const posZ = s0.z;
  const velX = s0.w;
  const velY = s1.x;
  const velZ = s1.y;
  const life = s2.y;
  const mass = s2.z;
  const flags = s2.w;

  // Decode flags (stored as float, use floor to extract bits)
  // bit0=captured(1), bit1=grounded(2), bit2=lockCaptured(4), bit3=allowSpinOut(8)
  const flagsInt = int(flags);
  const captured = flagsInt.bitAnd(int(1));
  const grounded = flagsInt.bitAnd(int(2));
  const lockCaptured = flagsInt.bitAnd(int(4));

  // Update life
  const newLife = life.add(uDt);
  s2.y.assign(newLife);

  // Skip grounded debris (no physics needed)
  If(grounded.greaterThan(int(0)), () => {
    Return();
  });

  // Vortex distance
  const dx = posX.sub(uVortexPosX);
  const dz = posZ.sub(uVortexPosZ);
  const distToVortex = sqrt(dx.mul(dx).add(dz.mul(dz)));
  const captureR = uCoreRadius.mul(3.0);

  // Capture logic
  const isCaptured = int(captured);
  If(isCaptured.equal(int(0)).and(uActive.greaterThan(0.5)).and(distToVortex.lessThan(captureR)), () => {
    const ws = windSpeedAtGround(posX, posZ);
    If(ws.greaterThan(float(20.0).div(mass)), () => {
      // Set captured flag
      const newFlags = flagsInt.bitOr(int(1));
      s2.w.assign(float(newFlags));
    });
  });

  // Lose capture if too far
  If(lockCaptured.equal(int(0)).and(captured.greaterThan(int(0))), () => {
    If(distToVortex.greaterThan(captureR.mul(1.5)).or(uActive.lessThan(0.5)), () => {
      const newFlags = flagsInt.bitAnd(int(~1));
      s2.w.assign(float(newFlags));
    });
  });

  // Re-read captured state after possible modification
  const capturedNow = int(s2.w).bitAnd(int(1));

  // Drag and gravity
  const dragC = select(capturedNow.greaterThan(int(0)),
    float(2.5).add(float(2.5).mul(float(1.0).sub(min(distToVortex.div(captureR), 1.0)))),
    float(0.35),
  );
  const gravScale = select(capturedNow.greaterThan(int(0)), float(0.05), float(1.0));

  // Wind force
  const wind = windVector(posX, posY, posZ);
  const relX = wind.x.sub(velX);
  const relY = wind.y.sub(velY);
  const relZ = wind.z.sub(velZ);

  // Apply forces
  const newVelY = velY.add(float(-9.81).mul(gravScale).mul(uDt)).add(relY.mul(dragC).mul(uDt));
  const newVelX = velX.add(relX.mul(dragC).mul(uDt));
  const newVelZ = velZ.add(relZ.mul(dragC).mul(uDt));

  // Orbit targeting for captured debris
  const orbitRadius = extra.x;
  const orbitHeight = extra.y;
  const orbitDrift = extra.z;

  const finalVelX = newVelX.toVar();
  const finalVelY = newVelY.toVar();
  const finalVelZ = newVelZ.toVar();

  If(capturedNow.greaterThan(int(0)), () => {
    // Height targeting
    const drift = orbitDrift.mul(sin(newLife.mul(0.4)));
    const targetY = orbitHeight.add(drift.mul(float(FUNNEL_HEIGHT)).mul(0.05));
    finalVelY.addAssign(targetY.sub(posY).mul(2.0).mul(uDt));

    // Radial spring
    const targetR = select(lockCaptured.greaterThan(int(0)),
      uCoreRadius.mul(1.05),
      orbitRadius,
    );
    If(distToVortex.greaterThan(0.1), () => {
      const radialErr = targetR.sub(distToVortex);
      finalVelX.addAssign(dx.div(distToVortex).mul(radialErr).mul(1.2).mul(uDt));
      finalVelZ.addAssign(dz.div(distToVortex).mul(radialErr).mul(1.2).mul(uDt));
    });
  });

  // Write velocities
  s0.w.assign(finalVelX);
  s1.x.assign(finalVelY);
  s1.y.assign(finalVelZ);

  // Integrate position
  const newPosX = posX.add(finalVelX.mul(uDt));
  const newPosY = posY.add(finalVelY.mul(uDt));
  const newPosZ = posZ.add(finalVelZ.mul(uDt));

  s0.x.assign(newPosX);
  s0.y.assign(newPosY);
  s0.z.assign(newPosZ);

  // Ground collision (simplified — uses vortex Y as ground approximation)
  // Actual terrain height sampling stays on CPU for read-back sync
  If(newPosY.lessThan(uVortexPosY.add(0.3)), () => {
    If(abs(finalVelY).lessThan(3.0), () => {
      // Ground it
      s0.y.assign(uVortexPosY.add(0.3));
      s0.w.assign(0.0); // velX = 0
      s1.x.assign(0.0); // velY = 0
      s1.y.assign(0.0); // velZ = 0
      s1.z.assign(0.0); // angVelX = 0
      s1.w.assign(0.0); // angVelY = 0
      s2.x.assign(0.0); // angVelZ = 0
      s2.y.assign(0.0); // life = 0 (reset for grounded TTL)
      // Set grounded flag
      const f = int(s2.w);
      s2.w.assign(float(f.bitOr(int(2))));
    }).Else(() => {
      s0.y.assign(uVortexPosY.add(0.3));
      s1.x.assign(finalVelY.mul(-0.25)); // bounce
      s0.w.assign(finalVelX.mul(0.6));
      s1.y.assign(finalVelZ.mul(0.6));
      // Dampen angular velocity
      s1.z.assign(s1.z.mul(0.4));
      s1.w.assign(s1.w.mul(0.4));
      s2.x.assign(s2.x.mul(0.4));
    });
  });
})().compute(MAX_DEBRIS);

// ─── Compute Shader 4: Debris-Building Collisions ───────────────────────────

export const computeDebrisCollisions = Fn(() => {
  const idx = instanceIndex;

  const s0 = debrisSlot0.element(idx);
  const s1 = debrisSlot1.element(idx);
  const s2 = debrisSlot2.element(idx);
  const extra = debrisExtra.element(idx);

  // Skip grounded
  const flagsInt = int(s2.w);
  const grounded = flagsInt.bitAnd(int(2));
  If(grounded.greaterThan(int(0)), () => { Return(); });

  const posX = s0.x;
  const posY = s0.y;
  const posZ = s0.z;
  const debrisRadius = max(extra.w, 1.5);

  // Loop over buildings
  Loop(uBuildingCount, ({ i }) => {
    const bs0 = buildingSlot0.element(i);
    const bs1 = buildingSlot1.element(i);
    const bs2 = buildingSlot2.element(i);

    // Skip destroyed
    If(bs2.y.greaterThan(0.5), () => { Continue(); });

    const bCenterX = bs0.x;
    const bCenterZ = bs0.y;
    const bBaseY = bs0.z;
    const bHeight = bs0.w;
    const bWidth = bs1.z;
    const bRadius = bWidth.mul(0.6);

    const dxB = posX.sub(bCenterX);
    const dzB = posZ.sub(bCenterZ);
    const distB = sqrt(dxB.mul(dxB).add(dzB.mul(dzB)));

    const collisionDist = bRadius.add(debrisRadius);

    If(distB.lessThan(collisionDist).and(posY.lessThan(bBaseY.add(bHeight).add(debrisRadius))), () => {
      const distSafe = max(distB, 0.001);
      const bnx = dxB.div(distSafe);
      const bnz = dzB.div(distSafe);
      const push = collisionDist.sub(distB).add(0.2);

      // Push out
      s0.x.addAssign(bnx.mul(push));
      s0.z.addAssign(bnz.mul(push));

      // Reflect velocity
      const vn = s0.w.mul(bnx).add(s1.y.mul(bnz));
      If(vn.lessThan(0.0), () => {
        s0.w.addAssign(float(-1.6).mul(vn).mul(bnx));
        s1.y.addAssign(float(-1.6).mul(vn).mul(bnz));
      });
      s1.x.mulAssign(0.6); // dampen velY

      // Apply damage to building from impact
      If(abs(vn).greaterThan(10.0), () => {
        bs2.x.assign(min(float(1.0), bs2.x.add(0.02)));
      });
    });
  });
})().compute(MAX_DEBRIS);

// ─── CPU-side helpers ───────────────────────────────────────────────────────

/** Update all vortex uniforms from CPU state before compute dispatch. */
export function syncUniforms(state: {
  position: THREE.Vector3;
  maxWindSpeed: number;
  coreRadius: number;
  outerRadius: number;
  heading: number;
  translationSpeed: number;
  time: number;
  dt: number;
  bendDir: THREE.Vector2;
  bendStrength: number;
  efRating: number;
  active: boolean;
  buildingCount: number;
  debrisCount: number;
  leanDir: THREE.Vector2;
  leanStrength: number;
}) {
  uVortexPosX.value = state.position.x;
  uVortexPosY.value = state.position.y;
  uVortexPosZ.value = state.position.z;
  uMaxWind.value = state.maxWindSpeed;
  uCoreRadius.value = state.coreRadius;
  uOuterRadius.value = state.outerRadius;
  uHeading.value = state.heading;
  uTransSpeed.value = state.translationSpeed;
  uTime.value = state.time;
  uDt.value = state.dt;
  uBendDirX.value = state.bendDir.x;
  uBendDirY.value = state.bendDir.y;
  uBendStrength.value = state.bendStrength;
  uEfRating.value = state.efRating;
  uActive.value = state.active ? 1.0 : 0.0;
  uBuildingCount.value = state.buildingCount;
  uDebrisCount.value = state.debrisCount;
  uLeanDirX.value = state.leanDir.x;
  uLeanDirY.value = state.leanDir.y;
  uLeanStrength.value = state.leanStrength;
}
