import * as THREE from "three";
import { NodeMaterial } from "three/webgpu";
import {
  uniform, attribute, float, vec2, vec3, vec4,
  sin, cos, fract, floor, dot, mix, smoothstep, pow, abs, clamp, length, normalize, cross, reflect, exp, max, min,
  uv, positionLocal, positionWorld, cameraPosition,
  Fn, If, Discard,
  varying,
} from "three/tsl";
import type { FloodRaster } from "./FloodTypes.ts";

export interface FloodSurfaceSolverState {
  depth: Float32Array;
  mx: Float32Array;
  my: Float32Array;
  obstacle: Uint8Array;
}

type ImpactPulse = {
  x: number;
  z: number;
  strength: number;
  radiusMeters: number;
};

// --- TSL helper functions (replacing GLSL) ---

const hash21 = Fn(({ p_in }: { p_in: any }) => {
  const p = fract(p_in.mul(vec2(123.34, 456.21))).toVar();
  p.addAssign(dot(p, p.add(45.32)));
  return fract(p.x.mul(p.y));
});

const noise2 = Fn(({ p }: { p: any }) => {
  const i = floor(p);
  const f = fract(p);
  const a = hash21({ p_in: i });
  const b = hash21({ p_in: i.add(vec2(1.0, 0.0)) });
  const c = hash21({ p_in: i.add(vec2(0.0, 1.0)) });
  const d = hash21({ p_in: i.add(vec2(1.0, 1.0)) });
  const u = f.mul(f).mul(float(3.0).sub(f.mul(2.0)));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
});

const fbm = Fn(({ p_in }: { p_in: any }) => {
  const v = float(0.0).toVar();
  const a = float(0.5).toVar();
  const p = p_in.toVar();
  // Unrolled 4 iterations
  v.addAssign(a.mul(noise2({ p })));
  p.assign(p.mul(2.03).add(vec2(19.37, -7.11)));
  a.mulAssign(0.5);

  v.addAssign(a.mul(noise2({ p })));
  p.assign(p.mul(2.03).add(vec2(19.37, -7.11)));
  a.mulAssign(0.5);

  v.addAssign(a.mul(noise2({ p })));
  p.assign(p.mul(2.03).add(vec2(19.37, -7.11)));
  a.mulAssign(0.5);

  v.addAssign(a.mul(noise2({ p })));
  return v;
});

const skyColor = Fn(({ dir }: { dir: any }) => {
  const t = clamp(dir.y.mul(0.5).add(0.5), 0.0, 1.0);
  const skyTop = vec3(0.42, 0.63, 0.90);
  const skyHorizon = vec3(0.88, 0.93, 0.99);
  const groundTint = vec3(0.20, 0.24, 0.30);
  return mix(mix(skyHorizon, skyTop, pow(t, 0.7)), groundTint, pow(float(1.0).sub(t), 5.0));
});

export class FloodWaterSurface {
  readonly mesh: THREE.Mesh;

  private readonly raster: FloodRaster;
  private readonly positionAttr: THREE.BufferAttribute;
  private readonly depthAttr: THREE.BufferAttribute;
  private readonly velocityAttr: THREE.BufferAttribute;
  private readonly rippleAttr: THREE.BufferAttribute;
  private readonly vertexToCell: Uint32Array;
  private readonly material: NodeMaterial;
  private depthScale = 1;
  private readonly baseYOffset = 0.12;
  private rippleHeight: Float32Array;
  private rippleVelocity: Float32Array;
  private rippleNextHeight: Float32Array;
  private rippleNextVelocity: Float32Array;
  private readonly pendingImpacts: ImpactPulse[] = [];

  // TSL uniform nodes
  private readonly uDepthScale;
  private readonly uLightDir;
  private readonly uSunColor;
  private readonly uSourceXZ;
  private readonly uTime;

  constructor(raster: FloodRaster, sunLight?: THREE.DirectionalLight) {
    this.raster = raster;

    const widthMeters = raster.xMax - raster.xMin;
    const depthMeters = raster.zMax - raster.zMin;
    const geo = new THREE.PlaneGeometry(
      widthMeters,
      depthMeters,
      raster.width - 1,
      raster.height - 1
    );
    geo.rotateX(-Math.PI / 2);
    geo.translate((raster.xMin + raster.xMax) * 0.5, 0, (raster.zMin + raster.zMax) * 0.5);

    const pos = geo.getAttribute("position") as THREE.BufferAttribute;
    const uvAttr = geo.getAttribute("uv") as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const u = (x - raster.xMin) / widthMeters;
      const v = (z - raster.zMin) / depthMeters;
      uvAttr.setXY(i, u, v);
    }
    uvAttr.needsUpdate = true;

    this.positionAttr = geo.getAttribute("position") as THREE.BufferAttribute;
    this.depthAttr = new THREE.BufferAttribute(new Float32Array(this.positionAttr.count), 1);
    this.velocityAttr = new THREE.BufferAttribute(
      new Float32Array(this.positionAttr.count * 2),
      2
    );
    this.rippleAttr = new THREE.BufferAttribute(new Float32Array(this.positionAttr.count), 1);
    geo.setAttribute("aDepth", this.depthAttr);
    geo.setAttribute("aVelocity", this.velocityAttr);
    geo.setAttribute("aRipple", this.rippleAttr);
    this.vertexToCell = new Uint32Array(this.positionAttr.count);
    for (let i = 0; i < this.positionAttr.count; i++) {
      const u = uvAttr.getX(i);
      const v = uvAttr.getY(i);
      const ci = clampInt(Math.round(u * (raster.width - 1)), 0, raster.width - 1);
      const cj = clampInt(Math.round(v * (raster.height - 1)), 0, raster.height - 1);
      this.vertexToCell[i] = cj * raster.width + ci;
    }

    const cellCount = raster.width * raster.height;
    this.rippleHeight = new Float32Array(cellCount);
    this.rippleVelocity = new Float32Array(cellCount);
    this.rippleNextHeight = new Float32Array(cellCount);
    this.rippleNextVelocity = new Float32Array(cellCount);

    // --- TSL uniforms ---
    this.uDepthScale = uniform(this.depthScale);
    this.uLightDir = uniform(
      sunLight
        ? sunLight.position.clone().normalize()
        : new THREE.Vector3(0.35, 0.86, 0.36).normalize()
    );
    this.uSunColor = uniform(new THREE.Color(1.0, 0.95, 0.82));
    this.uSourceXZ = uniform(new THREE.Vector2(0, 0));
    this.uTime = uniform(0.0);

    // --- Build the NodeMaterial ---
    const mat = new NodeMaterial();
    mat.transparent = true;
    mat.depthWrite = false;
    mat.depthTest = true;
    mat.polygonOffset = true;
    mat.polygonOffsetFactor = -2;
    mat.polygonOffsetUnits = -2;

    // Vertex: pass varyings
    const aDepth = attribute("aDepth", "float");
    const aVelocity = attribute("aVelocity", "vec2");
    const aRipple = attribute("aRipple", "float");

    const vDepth = varying(max(float(0.0), aDepth.mul(this.uDepthScale)), "vDepth");
    const vVelocity = varying(aVelocity, "vVelocity");
    const vRipple = varying(aRipple, "vRipple");
    const vUv = varying(uv(), "vUv");
    const vWorldPos = varying(positionWorld, "vWorldPos");

    // Fragment shader as colorNode + opacityNode
    const fragmentColor = Fn(() => {
      // Discard dry pixels
      Discard(vDepth.lessThan(0.01));

      const toPoint = vWorldPos.xz.sub(this.uSourceXZ);
      const radialDist = length(toPoint);
      const radialDir = normalize(toPoint.add(vec2(1e-6, 1e-6)));
      const sourceInfluence = smoothstep(float(140.0), float(0.0), radialDist);

      const physicalFlow = vVelocity;
      const advectFlow = physicalFlow.add(radialDir.mul(float(0.25).mul(sourceInfluence)));
      const flowDir = normalize(advectFlow.add(vec2(1e-6, 1e-6)));
      const flowSpeed = length(physicalFlow);
      const flow = flowDir.mul(float(0.06).add(float(0.14).mul(min(float(5.0), flowSpeed))));

      const uvA = vUv.mul(10.0).add(flow.mul(this.uTime.mul(0.8)));
      const uvB = vUv.mul(22.0).add(vec2(flowDir.y, flowDir.x.negate()).mul(this.uTime.mul(0.9)));
      const e = float(0.0015);

      const hL = fbm({ p_in: uvA.sub(vec2(e, 0.0)) }).mul(0.7).add(fbm({ p_in: uvB.sub(vec2(e, 0.0)) }).mul(0.3));
      const hR = fbm({ p_in: uvA.add(vec2(e, 0.0)) }).mul(0.7).add(fbm({ p_in: uvB.add(vec2(e, 0.0)) }).mul(0.3));
      const hD = fbm({ p_in: uvA.sub(vec2(0.0, e)) }).mul(0.7).add(fbm({ p_in: uvB.sub(vec2(0.0, e)) }).mul(0.3));
      const hU = fbm({ p_in: uvA.add(vec2(0.0, e)) }).mul(0.7).add(fbm({ p_in: uvB.add(vec2(0.0, e)) }).mul(0.3));
      const dHx = hR.sub(hL).div(e.mul(2.0));
      const dHz = hU.sub(hD).div(e.mul(2.0));

      // Normals
      const baseNormal = normalize(cross(vWorldPos.dFdx(), vWorldPos.dFdy()));
      const flowNormal = normalize(vec3(vVelocity.x.mul(-0.02), 1.0, vVelocity.y.mul(-0.02)));
      const microNormal = normalize(vec3(dHx.mul(-0.50), 1.0, dHz.mul(-0.50)));
      const normal = normalize(baseNormal.mul(0.58).add(flowNormal.mul(0.18)).add(microNormal.mul(0.62)));

      const viewDir = normalize(cameraPosition.sub(vWorldPos));
      const lightDir = normalize(this.uLightDir);
      const reflDir = reflect(viewDir.negate(), normal);
      const halfDir = normalize(lightDir.add(viewDir));

      const ndotV = max(dot(normal, viewDir), 0.0);
      const ndotL = max(dot(normal, lightDir), 0.0);
      const fresnel = float(0.02).add(float(0.98).mul(pow(float(1.0).sub(ndotV), 5.0)));

      const depthMix = clamp(vDepth.div(6.0), 0.0, 1.0);
      const absorb = exp(vDepth.mul(-0.55));
      const shallowCol = vec3(0.07, 0.25, 0.44);
      const deepCol = vec3(0.00, 0.03, 0.12);
      const subsurface = mix(deepCol, shallowCol, absorb);
      const refracted = subsurface.mul(float(0.25).add(float(0.75).mul(ndotL))).mul(mix(float(1.0), float(0.82), depthMix));

      const envRefl = skyColor({ dir: reflDir }).toVar();
      const sunRefl = pow(max(dot(reflDir, lightDir), 0.0), 1300.0);
      envRefl.addAssign(this.uSunColor.mul(sunRefl).mul(6.0));

      const color = mix(refracted, envRefl, fresnel).toVar();

      const spec = pow(max(dot(normal, halfDir), 0.0), 190.0).mul(float(0.2).add(float(0.8).mul(ndotL)));
      const glitter = pow(max(dot(normalize(reflDir.add(lightDir)), viewDir), 0.0), 300.0);
      color.addAssign(this.uSunColor.mul(spec.mul(0.85).add(glitter.mul(0.32))));

      // Foam
      const speed = length(vVelocity);
      const vort = abs(vVelocity.y.dFdx().sub(vVelocity.x.dFdy()));
      const rippleEnergy = abs(vRipple);
      const shorelineFoam = float(1.0).sub(smoothstep(float(0.03), float(0.30), vDepth));
      const turbulenceFoam = smoothstep(float(0.9), float(2.7), speed.add(vort.mul(1.8)).add(rippleEnergy.mul(6.5)));
      const foamNoise = fbm({ p_in: vUv.mul(36.0).add(flow.mul(this.uTime).mul(1.5)) });
      const streak = float(0.5).add(float(0.5).mul(sin(dot(vUv.mul(200.0).add(flow.mul(this.uTime).mul(8.0)), vec2(flowDir.y.negate(), flowDir.x)))));
      const foam = clamp(shorelineFoam.mul(0.8).add(turbulenceFoam.mul(0.65)), 0.0, 1.0)
        .mul(foamNoise).mul(float(0.62).add(float(0.38).mul(streak)));
      color.assign(mix(color, vec3(0.94, 0.97, 1.0), foam.mul(0.5)));

      color.assign(clamp(color, vec3(0.0, 0.0, 0.0), vec3(1.0, 1.0, 1.0)));
      const alpha = clamp(float(0.82).add(vDepth.mul(0.05)).add(fresnel.mul(0.02)), 0.84, 0.93);

      return vec4(color, alpha);
    });

    mat.colorNode = fragmentColor();

    this.material = mat;

    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 20;
    this.mesh.name = "flood-water-surface";
  }

  updateFromSolver(solver: FloodSurfaceSolverState, dt: number): void {
    this.updateRippleField(solver, dt);
    const eps = 1e-5;
    let wetCount = 0;
    for (let i = 0; i < this.positionAttr.count; i++) {
      const cell = this.vertexToCell[i]!;
      const terrainY = this.raster.terrain[cell]!;
      const depth = solver.depth[cell]!;
      const ripple = this.rippleHeight[cell]!;
      let vx = 0;
      let vz = 0;
      if (depth > eps) {
        vx = solver.mx[cell]! / depth;
        vz = solver.my[cell]! / depth;
      }
      const scaledDepth = depth * this.depthScale;
      const rippleAmp = Math.min(0.20, 0.02 + scaledDepth * 0.04);
      const wet = depth > eps;
      const rippleOffset = wet ? ripple * rippleAmp : 0;
      const y = wet ? terrainY + scaledDepth + this.baseYOffset + rippleOffset : terrainY;
      if (wet) wetCount++;
      this.positionAttr.setY(i, y);
      this.depthAttr.setX(i, depth);
      this.velocityAttr.setXY(i, vx, vz);
      this.rippleAttr.setX(i, wet ? rippleOffset : 0);
    }
    this.positionAttr.needsUpdate = true;
    this.depthAttr.needsUpdate = true;
    this.velocityAttr.needsUpdate = true;
    this.rippleAttr.needsUpdate = true;
    this.uTime.value += dt;
    this.mesh.visible = wetCount > 0;
  }

  setDepthScale(scale: number): void {
    this.depthScale = Math.max(0.1, Math.min(4, scale));
    this.uDepthScale.value = this.depthScale;
  }

  setLightDirection(dir: THREE.Vector3): void {
    (this.uLightDir.value as THREE.Vector3).copy(dir).normalize();
    const nY = Math.max(0, Math.min(1, dir.clone().normalize().y));
    const warm = new THREE.Color(1.0, 0.95, 0.82);
    const cool = new THREE.Color(0.82, 0.90, 1.0);
    (this.uSunColor.value as THREE.Color).copy(cool).lerp(warm, Math.sqrt(nY));
  }

  setSourcePosition(x: number, z: number): void {
    (this.uSourceXZ.value as THREE.Vector2).set(x, z);
  }

  addImpactAtWorld(x: number, z: number, strength = 1, radiusMeters = 5): void {
    this.pendingImpacts.push({
      x,
      z,
      strength: Math.max(0, strength),
      radiusMeters: Math.max(0.5, radiusMeters),
    });
  }

  /**
   * Port of the core heightfield update from jeantimex/webgpu-water:
   * velocity += (neighborAverage - height) * 2.0
   * velocity *= damping
   * height += velocity
   */
  private updateRippleField(solver: FloodSurfaceSolverState, dt: number): void {
    const w = this.raster.width;
    const h = this.raster.height;
    const steps = Math.max(1, Math.min(4, Math.round(dt * 120)));
    const stepDt = dt / steps;
    const damping = Math.pow(0.99925, Math.max(1, dt * 60 / steps));
    this.applyPendingImpactsToRipple(solver);

    for (let s = 0; s < steps; s++) {
      for (let j = 0; j < h; j++) {
        const jUp = j > 0 ? j - 1 : j;
        const jDn = j < h - 1 ? j + 1 : j;
        for (let i = 0; i < w; i++) {
          const iLf = i > 0 ? i - 1 : i;
          const iRt = i < w - 1 ? i + 1 : i;
          const idx = j * w + i;

          if (solver.obstacle[idx] !== 0) {
            this.rippleNextHeight[idx] = 0;
            this.rippleNextVelocity[idx] = 0;
            continue;
          }

          const depth = solver.depth[idx]!;
          const dryNeighborhood =
            depth <= 0.01 &&
            solver.depth[j * w + iLf]! <= 0.01 &&
            solver.depth[j * w + iRt]! <= 0.01 &&
            solver.depth[jUp * w + i]! <= 0.01 &&
            solver.depth[jDn * w + i]! <= 0.01;
          if (dryNeighborhood) {
            this.rippleNextHeight[idx] = 0;
            this.rippleNextVelocity[idx] = 0;
            continue;
          }

          let center = this.rippleHeight[idx]!;
          const left = this.rippleHeight[j * w + iLf]!;
          const right = this.rippleHeight[j * w + iRt]!;
          const up = this.rippleHeight[jUp * w + i]!;
          const down = this.rippleHeight[jDn * w + i]!;
          const avg = 0.25 * (left + right + up + down);

          let vel = this.rippleVelocity[idx]! + (avg - center) * 2.0;
          let localDamping = damping;

          if (depth > 0.01) {
            const vx = solver.mx[idx]! / depth;
            const vz = solver.my[idx]! / depth;
            const speed = Math.min(6, Math.sqrt(vx * vx + vz * vz));
            const backI = i - (vx * stepDt) / this.raster.dx;
            const backJ = j - (vz * stepDt) / this.raster.dz;
            const advected = this.sampleBilinear(this.rippleHeight, backI, backJ, w, h);
            center = center * 0.45 + advected * 0.55;
            vel += speed * 0.0035;
            if (depth < 0.45) vel += (0.45 - depth) * 0.005;
            localDamping = Math.min(0.99995, localDamping + speed * 0.00012);
          }

          vel *= localDamping;
          const nextH = (center + vel) * 0.9996;
          this.rippleNextVelocity[idx] = vel;
          this.rippleNextHeight[idx] = Math.max(-1, Math.min(1, nextH));
        }
      }

      let tmpH = this.rippleHeight;
      this.rippleHeight = this.rippleNextHeight;
      this.rippleNextHeight = tmpH;

      let tmpV = this.rippleVelocity;
      this.rippleVelocity = this.rippleNextVelocity;
      this.rippleNextVelocity = tmpV;
    }
  }

  private applyPendingImpactsToRipple(solver: FloodSurfaceSolverState): void {
    if (this.pendingImpacts.length === 0) return;
    const w = this.raster.width;
    const h = this.raster.height;

    for (const impact of this.pendingImpacts) {
      const cx = clampInt(
        Math.round((impact.x - this.raster.xMin) / Math.max(1e-6, this.raster.dx)),
        0,
        w - 1
      );
      const cy = clampInt(
        Math.round((impact.z - this.raster.zMin) / Math.max(1e-6, this.raster.dz)),
        0,
        h - 1
      );
      const radiusCells = Math.max(
        1,
        Math.ceil(impact.radiusMeters / Math.max(1e-6, Math.min(this.raster.dx, this.raster.dz)))
      );
      const r2 = radiusCells * radiusCells;

      for (let j = Math.max(0, cy - radiusCells); j <= Math.min(h - 1, cy + radiusCells); j++) {
        for (let i = Math.max(0, cx - radiusCells); i <= Math.min(w - 1, cx + radiusCells); i++) {
          const di = i - cx;
          const dj = j - cy;
          const d2 = di * di + dj * dj;
          if (d2 > r2) continue;
          const idx = j * w + i;
          if (solver.obstacle[idx] !== 0) continue;
          const falloff = Math.exp(-d2 / Math.max(1, r2 * 0.45));
          const amp = impact.strength * falloff;
          this.rippleVelocity[idx] += amp * 0.28;
          this.rippleHeight[idx] += amp * 0.06;
        }
      }
    }

    this.pendingImpacts.length = 0;
  }

  private sampleBilinear(
    data: Float32Array,
    x: number,
    y: number,
    width: number,
    height: number
  ): number {
    const cx = Math.max(0, Math.min(width - 1, x));
    const cy = Math.max(0, Math.min(height - 1, y));
    const x0 = Math.floor(cx);
    const y0 = Math.floor(cy);
    const x1 = Math.min(width - 1, x0 + 1);
    const y1 = Math.min(height - 1, y0 + 1);
    const tx = cx - x0;
    const ty = cy - y0;

    const p00 = data[y0 * width + x0]!;
    const p10 = data[y0 * width + x1]!;
    const p01 = data[y1 * width + x0]!;
    const p11 = data[y1 * width + x1]!;
    const a = p00 + (p10 - p00) * tx;
    const b = p01 + (p11 - p01) * tx;
    return a + (b - a) * ty;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value | 0));
}
