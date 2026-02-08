import * as THREE from "three";
import type { FloodRaster } from "./FloodTypes.ts";
import type { ShallowWaterSolver } from "./ShallowWaterSolver.ts";

type ImpactPulse = {
  x: number;
  z: number;
  strength: number;
  radiusMeters: number;
};

export class FloodWaterSurface {
  readonly mesh: THREE.Mesh;

  private readonly raster: FloodRaster;
  private readonly positionAttr: THREE.BufferAttribute;
  private readonly depthAttr: THREE.BufferAttribute;
  private readonly velocityAttr: THREE.BufferAttribute;
  private readonly rippleAttr: THREE.BufferAttribute;
  private readonly vertexToCell: Uint32Array;
  private readonly material: THREE.ShaderMaterial;
  private depthScale = 1;
  private readonly baseYOffset = 0.12;
  private rippleHeight: Float32Array;
  private rippleVelocity: Float32Array;
  private rippleNextHeight: Float32Array;
  private rippleNextVelocity: Float32Array;
  private readonly pendingImpacts: ImpactPulse[] = [];

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
    const uv = geo.getAttribute("uv") as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const u = (x - raster.xMin) / widthMeters;
      const v = (z - raster.zMin) / depthMeters;
      uv.setXY(i, u, v);
    }
    uv.needsUpdate = true;

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
      const u = uv.getX(i);
      const v = uv.getY(i);
      const ci = clampInt(Math.round(u * (raster.width - 1)), 0, raster.width - 1);
      const cj = clampInt(Math.round(v * (raster.height - 1)), 0, raster.height - 1);
      this.vertexToCell[i] = cj * raster.width + ci;
    }

    const cellCount = raster.width * raster.height;
    this.rippleHeight = new Float32Array(cellCount);
    this.rippleVelocity = new Float32Array(cellCount);
    this.rippleNextHeight = new Float32Array(cellCount);
    this.rippleNextVelocity = new Float32Array(cellCount);

    this.material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: true,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
      uniforms: {
        uDepthScale: { value: this.depthScale },
        uLightDir: {
          value: sunLight
            ? sunLight.position.clone().normalize()
            : new THREE.Vector3(0.35, 0.86, 0.36).normalize(),
        },
        uSunColor: { value: new THREE.Color(1.0, 0.95, 0.82) },
        uSourceXZ: { value: new THREE.Vector2(0, 0) },
        uTime: { value: 0 },
      },
      vertexShader: `
        attribute float aDepth;
        attribute vec2 aVelocity;
        attribute float aRipple;
        uniform float uDepthScale;
        varying float vDepth;
        varying vec2 vVelocity;
        varying float vRipple;
        varying vec2 vUv;
        varying vec3 vWorldPos;

        void main() {
          // Keep visibility controlled by physical water depth only.
          vDepth = max(0.0, aDepth * uDepthScale);
          vVelocity = aVelocity;
          vRipple = aRipple;
          vUv = uv;
          vec4 world = modelMatrix * vec4(position, 1.0);
          vWorldPos = world.xyz;
          gl_Position = projectionMatrix * viewMatrix * world;
        }
      `,
      fragmentShader: `
        precision highp float;
        varying float vDepth;
        varying vec2 vVelocity;
        varying float vRipple;
        varying vec2 vUv;
        varying vec3 vWorldPos;
        uniform vec3 uLightDir;
        uniform vec3 uSunColor;
        uniform vec2 uSourceXZ;
        uniform float uTime;

        float hash21(vec2 p) {
          p = fract(p * vec2(123.34, 456.21));
          p += dot(p, p + 45.32);
          return fract(p.x * p.y);
        }

        float noise2(vec2 p) {
          vec2 i = floor(p);
          vec2 f = fract(p);
          float a = hash21(i);
          float b = hash21(i + vec2(1.0, 0.0));
          float c = hash21(i + vec2(0.0, 1.0));
          float d = hash21(i + vec2(1.0, 1.0));
          vec2 u = f * f * (3.0 - 2.0 * f);
          return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
        }

        float fbm(vec2 p) {
          float v = 0.0;
          float a = 0.5;
          for (int i = 0; i < 4; i++) {
            v += a * noise2(p);
            p = p * 2.03 + vec2(19.37, -7.11);
            a *= 0.5;
          }
          return v;
        }

        vec3 skyColor(vec3 dir) {
          float t = clamp(dir.y * 0.5 + 0.5, 0.0, 1.0);
          vec3 skyTop = vec3(0.42, 0.63, 0.90);
          vec3 skyHorizon = vec3(0.88, 0.93, 0.99);
          vec3 groundTint = vec3(0.20, 0.24, 0.30);
          return mix(mix(skyHorizon, skyTop, pow(t, 0.7)), groundTint, pow(1.0 - t, 5.0));
        }

        void main() {
          if (vDepth < 0.01) discard;

          vec2 toPoint = vWorldPos.xz - uSourceXZ;
          float radialDist = length(toPoint);
          vec2 radialDir = normalize(toPoint + vec2(1e-6));
          float sourceInfluence = smoothstep(140.0, 0.0, radialDist);

          vec2 physicalFlow = vVelocity;
          vec2 advectFlow = physicalFlow + radialDir * (0.25 * sourceInfluence);
          vec2 flowDir = normalize(advectFlow + vec2(1e-6));
          float flowSpeed = length(physicalFlow);
          vec2 flow = flowDir * (0.06 + 0.14 * min(5.0, flowSpeed));

          vec2 uvA = vUv * 10.0 + flow * (uTime * 0.8);
          vec2 uvB = vUv * 22.0 + vec2(flowDir.y, -flowDir.x) * (uTime * 0.9);
          float e = 0.0015;
          float hL = fbm(uvA - vec2(e, 0.0)) * 0.7 + fbm(uvB - vec2(e, 0.0)) * 0.3;
          float hR = fbm(uvA + vec2(e, 0.0)) * 0.7 + fbm(uvB + vec2(e, 0.0)) * 0.3;
          float hD = fbm(uvA - vec2(0.0, e)) * 0.7 + fbm(uvB - vec2(0.0, e)) * 0.3;
          float hU = fbm(uvA + vec2(0.0, e)) * 0.7 + fbm(uvB + vec2(0.0, e)) * 0.3;
          float dHx = (hR - hL) / (2.0 * e);
          float dHz = (hU - hD) / (2.0 * e);

          vec3 baseNormal = normalize(cross(dFdx(vWorldPos), dFdy(vWorldPos)));
          vec3 flowNormal = normalize(vec3(-vVelocity.x * 0.02, 1.0, -vVelocity.y * 0.02));
          vec3 microNormal = normalize(vec3(-dHx * 0.50, 1.0, -dHz * 0.50));
          vec3 normal = normalize(baseNormal * 0.58 + flowNormal * 0.18 + microNormal * 0.62);

          vec3 viewDir = normalize(cameraPosition - vWorldPos);
          vec3 lightDir = normalize(uLightDir);
          vec3 reflDir = reflect(-viewDir, normal);
          vec3 halfDir = normalize(lightDir + viewDir);

          float ndotV = max(dot(normal, viewDir), 0.0);
          float ndotL = max(dot(normal, lightDir), 0.0);
          float fresnel = 0.02 + 0.98 * pow(1.0 - ndotV, 5.0);

          float depthMix = clamp(vDepth / 6.0, 0.0, 1.0);
          float absorb = exp(-vDepth * 0.55);
          vec3 shallowCol = vec3(0.07, 0.25, 0.44);
          vec3 deepCol = vec3(0.00, 0.03, 0.12);
          vec3 subsurface = mix(deepCol, shallowCol, absorb);
          vec3 refracted = subsurface * (0.25 + 0.75 * ndotL) * mix(1.0, 0.82, depthMix);

          vec3 envRefl = skyColor(reflDir);
          float sunRefl = pow(max(dot(reflDir, lightDir), 0.0), 1300.0);
          envRefl += uSunColor * sunRefl * 6.0;

          vec3 color = mix(refracted, envRefl, fresnel);

          float spec = pow(max(dot(normal, halfDir), 0.0), 190.0) * (0.2 + 0.8 * ndotL);
          float glitter = pow(max(dot(normalize(reflDir + lightDir), viewDir), 0.0), 300.0);
          color += uSunColor * (spec * 0.85 + glitter * 0.32);

          float speed = length(vVelocity);
          float vort = abs(dFdx(vVelocity.y) - dFdy(vVelocity.x));
          float rippleEnergy = abs(vRipple);
          float shorelineFoam = 1.0 - smoothstep(0.03, 0.30, vDepth);
          float turbulenceFoam = smoothstep(0.9, 2.7, speed + vort * 1.8 + rippleEnergy * 6.5);
          float foamNoise = fbm(vUv * 36.0 + flow * uTime * 1.5);
          float streak = 0.5 + 0.5 * sin(dot(vUv * 200.0 + flow * uTime * 8.0, vec2(-flowDir.y, flowDir.x)));
          float foam = clamp(shorelineFoam * 0.8 + turbulenceFoam * 0.65, 0.0, 1.0) *
                       foamNoise * (0.62 + 0.38 * streak);
          color = mix(color, vec3(0.94, 0.97, 1.0), foam * 0.5);

          color = clamp(color, vec3(0.0), vec3(1.0));
          float alpha = clamp(0.82 + vDepth * 0.05 + fresnel * 0.02, 0.84, 0.93);
          gl_FragColor = vec4(color, alpha);
        }
      `,
    });

    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 20;
    this.mesh.name = "flood-water-surface";
  }

  updateFromSolver(solver: ShallowWaterSolver, dt: number): void {
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
    this.material.uniforms.uTime.value += dt;
    this.mesh.visible = wetCount > 0;
  }

  setDepthScale(scale: number): void {
    this.depthScale = Math.max(0.1, Math.min(4, scale));
    this.material.uniforms.uDepthScale.value = this.depthScale;
  }

  setLightDirection(dir: THREE.Vector3): void {
    this.material.uniforms.uLightDir.value.copy(dir).normalize();
    const nY = Math.max(0, Math.min(1, dir.clone().normalize().y));
    const warm = new THREE.Color(1.0, 0.95, 0.82);
    const cool = new THREE.Color(0.82, 0.90, 1.0);
    this.material.uniforms.uSunColor.value.copy(cool).lerp(warm, Math.sqrt(nY));
  }

  setSourcePosition(x: number, z: number): void {
    this.material.uniforms.uSourceXZ.value.set(x, z);
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
  private updateRippleField(solver: ShallowWaterSolver, dt: number): void {
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

  private applyPendingImpactsToRipple(solver: ShallowWaterSolver): void {
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
