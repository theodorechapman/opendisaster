import { useEffect, useRef } from "react";

// ── Seeded RNG for deterministic city ──
function seededRng(seed: number) {
  let s = seed;
  return () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
}

interface Building {
  x: number; z: number; w: number; d: number; h: number;
}

function generateMidtownBuildings(): Building[] {
  const buildings: Building[] = [];
  const rand = seededRng(42);
  const blockW = 1.5;
  const blockD = 0.8;
  const gridX = 14;
  const gridZ = 18;

  for (let gx = 0; gx < gridX; gx++) {
    for (let gz = 0; gz < gridZ; gz++) {
      const cx = (gx - gridX / 2) * blockW + (rand() - 0.5) * 0.2;
      const cz = (gz - gridZ / 2) * blockD + (rand() - 0.5) * 0.1;
      const distFromCenter = Math.sqrt(
        ((gx - gridX / 2) / (gridX / 2)) ** 2 +
        ((gz - gridZ / 2) / (gridZ / 2)) ** 2
      );
      const heightMul = Math.max(0.3, 1.0 - distFromCenter * 0.5);
      const count = 1 + Math.floor(rand() * 2.5);
      for (let i = 0; i < count; i++) {
        const w = 0.3 + rand() * 0.7;
        const d = 0.2 + rand() * 0.5;
        const h = (0.8 + rand() * 5.0) * heightMul;
        const ox = (rand() - 0.5) * (blockW - w) * 0.5;
        const oz = (rand() - 0.5) * (blockD - d) * 0.5;
        buildings.push({ x: cx + ox, z: cz + oz, w, d, h });
      }
    }
  }
  return buildings;
}

// Simple 3D projection
function project(
  x: number, y: number, z: number,
  camX: number, camY: number, camZ: number,
  cosA: number, sinA: number,
  w: number, h: number, fov: number
): { sx: number; sy: number; depth: number } | null {
  let dx = x - camX;
  let dz = z - camZ;
  const rz = dx * sinA + dz * cosA;
  const rx = dx * cosA - dz * sinA;
  const ry = y - camY;

  if (rz < 0.1) return null;
  const scale = fov / rz;
  return {
    sx: w / 2 + rx * scale,
    sy: h / 2 - ry * scale,
    depth: rz,
  };
}

// ── WebGPU post-processing shader ──
const DITHER_SHADER = /* wgsl */`
struct Uniforms {
  time: f32,
  width: f32,
  height: f32,
  _pad: f32,
};

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var cityTex: texture_2d<f32>;
@group(0) @binding(2) var citySampler: sampler;

// Permutation table baked into shader
const PERM = array<u32, 256>(
  151,160,137,91,90,15,131,13,201,95,96,53,194,233,7,225,
  140,36,103,30,69,142,8,99,37,240,21,10,23,190,6,148,
  247,120,234,75,0,26,197,62,94,252,219,203,117,35,11,32,
  57,177,33,88,237,149,56,87,174,20,125,136,171,168,68,175,
  74,165,71,134,139,48,27,166,77,146,158,231,83,111,229,122,
  60,211,133,230,220,105,92,41,55,46,245,40,244,102,143,54,
  65,25,63,161,1,216,80,73,209,76,132,187,208,89,18,169,
  200,196,135,130,116,188,159,86,164,100,109,198,173,186,3,64,
  52,217,226,250,124,123,5,202,38,147,118,126,255,82,85,212,
  207,206,59,227,47,16,58,17,182,189,28,42,223,183,170,213,
  119,248,152,2,44,154,163,70,221,153,101,155,167,43,172,9,
  129,22,39,253,19,98,108,110,79,113,224,232,178,185,112,104,
  218,246,97,228,251,34,242,193,238,210,144,12,191,179,162,241,
  81,51,145,235,249,14,239,107,49,192,214,31,181,199,106,157,
  184,84,204,176,115,121,50,45,127,4,150,254,138,236,205,93,
  222,114,67,29,24,72,243,141,128,195,78,66,215,61,156,180
);

fn permute(x: u32) -> u32 {
  return PERM[x & 255u];
}

const GRAD_X = array<f32, 8>(1.0, 1.0, -1.0, -1.0, 1.0, -1.0, 0.0, 0.0);
const GRAD_Y = array<f32, 8>(1.0, -1.0, 1.0, -1.0, 0.0, 0.0, 1.0, -1.0);

fn fade(t: f32) -> f32 {
  return t * t * t * (t * (t * 6.0 - 15.0) + 10.0);
}

fn perlin2d(x: f32, y: f32) -> f32 {
  let xi = u32(floor(x)) & 255u;
  let yi = u32(floor(y)) & 255u;
  let xf = x - floor(x);
  let yf = y - floor(y);
  let u = fade(xf);
  let v = fade(yf);

  let aa = permute(permute(xi) + yi) & 7u;
  let ba = permute(permute(xi + 1u) + yi) & 7u;
  let ab = permute(permute(xi) + yi + 1u) & 7u;
  let bb = permute(permute(xi + 1u) + yi + 1u) & 7u;

  let n00 = GRAD_X[aa] * xf + GRAD_Y[aa] * yf;
  let n10 = GRAD_X[ba] * (xf - 1.0) + GRAD_Y[ba] * yf;
  let n01 = GRAD_X[ab] * xf + GRAD_Y[ab] * (yf - 1.0);
  let n11 = GRAD_X[bb] * (xf - 1.0) + GRAD_Y[bb] * (yf - 1.0);

  let lx0 = mix(n00, n10, u);
  let lx1 = mix(n01, n11, u);
  return mix(lx0, lx1, v);
}

fn fbm(x_in: f32, y_in: f32, time: f32, freq: f32, amp: f32) -> f32 {
  var value = 0.0;
  var a = 1.0;
  var f = freq;
  var px = x_in + time * 0.05;
  var py = y_in + time * 0.03;
  for (var i = 0u; i < 4u; i++) {
    value += a * abs(perlin2d(px * f, py * f));
    f *= freq;
    a *= amp;
    px += value * 0.5;
    py += value * 0.3;
  }
  return value;
}

const BAYER_8x8 = array<f32, 64>(
   0.0, 48.0, 12.0, 60.0,  3.0, 51.0, 15.0, 63.0,
  32.0, 16.0, 44.0, 28.0, 35.0, 19.0, 47.0, 31.0,
   8.0, 56.0,  4.0, 52.0, 11.0, 59.0,  7.0, 55.0,
  40.0, 24.0, 36.0, 20.0, 43.0, 27.0, 39.0, 23.0,
   2.0, 50.0, 14.0, 62.0,  1.0, 49.0, 13.0, 61.0,
  34.0, 18.0, 46.0, 30.0, 33.0, 17.0, 45.0, 29.0,
  10.0, 58.0,  6.0, 54.0,  9.0, 57.0,  5.0, 53.0,
  42.0, 26.0, 38.0, 22.0, 41.0, 25.0, 37.0, 21.0,
);

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  // Fullscreen triangle
  let x = f32(i32(vi) / 2) * 4.0 - 1.0;
  let y = f32(i32(vi) % 2) * 4.0 - 1.0;
  return vec4f(x, y, 0.0, 1.0);
}

@fragment
fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let px = u32(pos.x);
  let py = u32(pos.y);
  let w = u32(u.width);
  let h = u32(u.height);
  let t = u.time;

  // Sample city texture
  let uv = vec2f(pos.x / u.width, pos.y / u.height);
  let city = textureSample(cityTex, citySampler, uv);

  // Perlin noise fog
  let aspect = u.width / u.height;
  let uvx = (uv.x - 0.5) * aspect;
  let uvy = uv.y - 0.5;
  let noise = fbm(uvx, uvy, t, 3.0, 0.3);

  // Bayer threshold
  let bx = px & 7u;
  let by = py & 7u;
  let threshold = (BAYER_8x8[by * 8u + bx] / 64.0) - 0.25;

  // City mask: only apply noise on geometry (non-black pixels)
  let brightness = (city.r + city.g + city.b) / 3.0;
  let cityMask = min(1.0, brightness / (20.0 / 255.0));

  let colorNum = 4.0;
  let ditherStep = 1.0 / (colorNum - 1.0);

  var r = city.r + noise * 0.35 * cityMask + threshold * ditherStep;
  r = max(0.0, r - 0.35);
  r = floor(r * (colorNum - 1.0) + 0.5) / (colorNum - 1.0);

  var g = city.g + noise * 0.35 * cityMask + threshold * ditherStep;
  g = max(0.0, g - 0.35);
  g = floor(g * (colorNum - 1.0) + 0.5) / (colorNum - 1.0);

  var b = city.b + noise * 0.35 * cityMask + threshold * ditherStep;
  b = max(0.0, b - 0.35);
  b = floor(b * (colorNum - 1.0) + 0.5) / (colorNum - 1.0);

  return vec4f(r, g, b, 1.0);
}
`;

async function initWebGPU(canvas: HTMLCanvasElement, cw: number, ch: number) {
  const adapter = await navigator.gpu?.requestAdapter();
  if (!adapter) return null;
  const device = await adapter.requestDevice();
  const ctx = canvas.getContext("webgpu");
  if (!ctx) return null;

  const format = navigator.gpu.getPreferredCanvasFormat();
  ctx.configure({ device, format, alphaMode: "opaque" });

  const shaderModule = device.createShaderModule({ code: DITHER_SHADER });

  const uniformBuffer = device.createBuffer({
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  const sampler = device.createSampler({
    magFilter: "nearest",
    minFilter: "nearest",
  });

  let cityTexture = device.createTexture({
    size: [cw, ch],
    format: "rgba8unorm",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
  });

  const bindGroupLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
    ],
  });

  const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] });

  const pipeline = device.createRenderPipeline({
    layout: pipelineLayout,
    vertex: { module: shaderModule, entryPoint: "vs" },
    fragment: {
      module: shaderModule,
      entryPoint: "fs",
      targets: [{ format }],
    },
    primitive: { topology: "triangle-list" },
  });

  let bindGroup = device.createBindGroup({
    layout: bindGroupLayout,
    entries: [
      { binding: 0, resource: { buffer: uniformBuffer } },
      { binding: 1, resource: cityTexture.createView() },
      { binding: 2, resource: sampler },
    ],
  });

  function resize(newW: number, newH: number) {
    cw = newW;
    ch = newH;
    cityTexture.destroy();
    cityTexture = device.createTexture({
      size: [cw, ch],
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    bindGroup = device.createBindGroup({
      layout: bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: uniformBuffer } },
        { binding: 1, resource: cityTexture.createView() },
        { binding: 2, resource: sampler },
      ],
    });
  }

  function render(cityCanvas: OffscreenCanvas | HTMLCanvasElement, time: number) {
    // Upload city framebuffer to GPU texture
    const bmp = (cityCanvas as any).transferToImageBitmap
      ? (cityCanvas as OffscreenCanvas).transferToImageBitmap()
      : null;

    if (bmp) {
      device.queue.copyExternalImageToTexture(
        { source: bmp },
        { texture: cityTexture },
        [cw, ch]
      );
      bmp.close();
    } else {
      // Fallback: use canvas directly
      device.queue.copyExternalImageToTexture(
        { source: cityCanvas as HTMLCanvasElement },
        { texture: cityTexture },
        [cw, ch]
      );
    }

    // Update uniforms
    const uniformData = new Float32Array([time, cw, ch, 0]);
    device.queue.writeBuffer(uniformBuffer, 0, uniformData);

    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: ctx!.getCurrentTexture().createView(),
        loadOp: "clear",
        storeOp: "store",
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
      }],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3);
    pass.end();
    device.queue.submit([encoder.finish()]);
  }

  return { device, render, resize };
}

export function DitherCityBackground() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const SCALE = 2;
    let cw = Math.floor(window.innerWidth / SCALE);
    let ch = Math.floor(window.innerHeight / SCALE);
    canvas.width = cw;
    canvas.height = ch;

    const buildings = generateMidtownBuildings();
    let raf: number;
    let destroyed = false;

    // Offscreen canvas for CPU city rendering
    let offscreen = new OffscreenCanvas(cw, ch);
    let offCtx = offscreen.getContext("2d")!;

    function drawCity(t: number) {
      offCtx.fillStyle = "#000";
      offCtx.fillRect(0, 0, cw, ch);

      const angle = t * 0.08;
      const camDist = 14;
      const camX = Math.sin(angle) * camDist;
      const camZ = Math.cos(angle) * camDist;
      const camY = 5 + Math.sin(t * 0.15) * 1.5;
      const cosA = Math.cos(angle + Math.PI);
      const sinA = Math.sin(angle + Math.PI);
      const fov = cw * 0.7;

      type DrawCmd = { depth: number; draw: () => void };
      const drawCmds: DrawCmd[] = [];

      for (const b of buildings) {
        const x0 = b.x - b.w / 2, x1 = b.x + b.w / 2;
        const z0 = b.z - b.d / 2, z1 = b.z + b.d / 2;
        const y0 = 0, y1 = b.h;

        const corners = [
          project(x0, y0, z0, camX, camY, camZ, cosA, sinA, cw, ch, fov),
          project(x1, y0, z0, camX, camY, camZ, cosA, sinA, cw, ch, fov),
          project(x1, y0, z1, camX, camY, camZ, cosA, sinA, cw, ch, fov),
          project(x0, y0, z1, camX, camY, camZ, cosA, sinA, cw, ch, fov),
          project(x0, y1, z0, camX, camY, camZ, cosA, sinA, cw, ch, fov),
          project(x1, y1, z0, camX, camY, camZ, cosA, sinA, cw, ch, fov),
          project(x1, y1, z1, camX, camY, camZ, cosA, sinA, cw, ch, fov),
          project(x0, y1, z1, camX, camY, camZ, cosA, sinA, cw, ch, fov),
        ];

        if (corners.some(c => c === null)) continue;
        const c = corners as { sx: number; sy: number; depth: number }[];
        const avgDepth = c.reduce((s, p) => s + p.depth, 0) / 8;

        const faces: [number[], number][] = [
          [[0, 1, 5, 4], 0.35],
          [[1, 2, 6, 5], 0.25],
          [[2, 3, 7, 6], 0.15],
          [[3, 0, 4, 7], 0.30],
          [[4, 5, 6, 7], 0.45],
        ];

        drawCmds.push({
          depth: avgDepth,
          draw: () => {
            for (const [indices, brightness] of faces) {
              const p0 = c[indices[0]!]!;
              const p1 = c[indices[1]!]!;
              const p2 = c[indices[2]!]!;
              const cross = (p1.sx - p0.sx) * (p2.sy - p0.sy) - (p1.sy - p0.sy) * (p2.sx - p0.sx);
              if (cross > 0) continue;

              const v = Math.floor(brightness * 255);
              offCtx.fillStyle = `rgb(${v},${v},${v})`;
              offCtx.beginPath();
              offCtx.moveTo(c[indices[0]!]!.sx, c[indices[0]!]!.sy);
              for (let k = 1; k < indices.length; k++) {
                offCtx.lineTo(c[indices[k]!]!.sx, c[indices[k]!]!.sy);
              }
              offCtx.closePath();
              offCtx.fill();
            }
          },
        });
      }

      // Ground plane
      const gCorners = [
        project(-15, 0, -10, camX, camY, camZ, cosA, sinA, cw, ch, fov),
        project(15, 0, -10, camX, camY, camZ, cosA, sinA, cw, ch, fov),
        project(15, 0, 10, camX, camY, camZ, cosA, sinA, cw, ch, fov),
        project(-15, 0, 10, camX, camY, camZ, cosA, sinA, cw, ch, fov),
      ];
      if (gCorners.every(c => c !== null)) {
        const gc = gCorners as { sx: number; sy: number; depth: number }[];
        offCtx.fillStyle = "rgb(25,25,25)";
        offCtx.beginPath();
        offCtx.moveTo(gc[0]!.sx, gc[0]!.sy);
        for (let i = 1; i < 4; i++) offCtx.lineTo(gc[i]!.sx, gc[i]!.sy);
        offCtx.closePath();
        offCtx.fill();
      }

      drawCmds.sort((a, b) => b.depth - a.depth);
      for (const cmd of drawCmds) cmd.draw();
    }

    // ── CPU fallback (original code path) ──
    // 8x8 Bayer matrix
    const BAYER_8x8 = [
       0, 48, 12, 60,  3, 51, 15, 63,
      32, 16, 44, 28, 35, 19, 47, 31,
       8, 56,  4, 52, 11, 59,  7, 55,
      40, 24, 36, 20, 43, 27, 39, 23,
       2, 50, 14, 62,  1, 49, 13, 61,
      34, 18, 46, 30, 33, 17, 45, 29,
      10, 58,  6, 54,  9, 57,  5, 53,
      42, 26, 38, 22, 41, 25, 37, 21,
    ];

    // Perlin noise for CPU fallback
    const PERM = new Uint8Array(512);
    const GRAD = [[1,1],[1,-1],[-1,1],[-1,-1],[1,0],[-1,0],[0,1],[0,-1]] as const;
    {
      const p = new Uint8Array(256);
      for (let i = 0; i < 256; i++) p[i] = i;
      let s = 12345;
      for (let i = 255; i > 0; i--) {
        s = (s * 16807) % 2147483647;
        const j = s % (i + 1);
        [p[i], p[j]] = [p[j]!, p[i]!];
      }
      for (let i = 0; i < 512; i++) PERM[i] = p[i & 255]!;
    }

    function pfade(t: number) { return t * t * t * (t * (t * 6 - 15) + 10); }
    function plerp(a: number, b: number, t: number) { return a + t * (b - a); }

    function perlin2d(x: number, y: number): number {
      const xi = Math.floor(x) & 255, yi = Math.floor(y) & 255;
      const xf = x - Math.floor(x), yf = y - Math.floor(y);
      const u = pfade(xf), v = pfade(yf);
      const g = (ix: number, iy: number) => {
        const h = PERM[PERM[ix]! + iy]! & 7;
        const gr = GRAD[h]!;
        return gr[0]! * (xf - (ix - xi)) + gr[1]! * (yf - (iy - yi));
      };
      return plerp(plerp(g(xi, yi), g(xi + 1, yi), u), plerp(g(xi, yi + 1), g(xi + 1, yi + 1), u), v);
    }

    function fbmCpu(x: number, y: number, time: number, freq: number, amp: number): number {
      let value = 0, a = 1, f = freq;
      let px = x + time * 0.05, py = y + time * 0.03;
      for (let i = 0; i < 4; i++) {
        value += a * Math.abs(perlin2d(px * f, py * f));
        f *= freq; a *= amp;
        px += value * 0.5; py += value * 0.3;
      }
      return value;
    }

    function cpuPostProcess(ctx2d: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, t: number) {
      const imgData = ctx2d.getImageData(0, 0, cw, ch);
      const pixels = imgData.data;
      const colorNum = 4;
      const ditherStep = 1 / (colorNum - 1);
      const aspect = cw / ch;

      for (let i = 0; i < pixels.length; i += 4) {
        const px = (i / 4) % cw;
        const py = Math.floor(i / 4 / cw);
        const uvx = (px / cw - 0.5) * aspect;
        const uvy = (py / ch - 0.5);
        const noise = fbmCpu(uvx, uvy, t, 3.0, 0.3);
        const bx = px & 7;
        const by = py & 7;
        const threshold = (BAYER_8x8[by * 8 + bx]! / 64) - 0.25;
        const brightness = (pixels[i]! + pixels[i + 1]! + pixels[i + 2]!) / 3;
        const cityMask = Math.min(1, brightness / 20);

        for (let c = 0; c < 3; c++) {
          let v = pixels[i + c]! / 255;
          v = v + noise * 0.35 * cityMask;
          v += threshold * ditherStep;
          v = Math.max(0, v - 0.35);
          v = Math.floor(v * (colorNum - 1) + 0.5) / (colorNum - 1);
          pixels[i + c] = Math.round(v * 255);
        }
      }
      ctx2d.putImageData(imgData, 0, 0);
    }

    // ── Init ──
    async function start() {
      const gpu = await initWebGPU(canvas, cw, ch);

      if (gpu) {
        // WebGPU path
        function handleResize() {
          cw = Math.floor(window.innerWidth / SCALE);
          ch = Math.floor(window.innerHeight / SCALE);
          canvas!.width = cw;
          canvas!.height = ch;
          offscreen = new OffscreenCanvas(cw, ch);
          offCtx = offscreen.getContext("2d")!;
          gpu!.resize(cw, ch);
        }
        window.addEventListener("resize", handleResize);

        function draw(time: number) {
          if (destroyed) return;
          const t = time * 0.001;
          drawCity(t);
          gpu!.render(offscreen, t);
          raf = requestAnimationFrame(draw);
        }
        raf = requestAnimationFrame(draw);

        return () => {
          destroyed = true;
          cancelAnimationFrame(raf);
          window.removeEventListener("resize", handleResize);
        };
      } else {
        // CPU fallback
        const ctx2d = offscreen.getContext("2d")!;

        function handleResize() {
          cw = Math.floor(window.innerWidth / SCALE);
          ch = Math.floor(window.innerHeight / SCALE);
          canvas!.width = cw;
          canvas!.height = ch;
          offscreen = new OffscreenCanvas(cw, ch);
          offCtx = offscreen.getContext("2d")!;
        }
        window.addEventListener("resize", handleResize);

        // For CPU fallback, draw directly to the visible canvas
        const fallbackCtx = canvas.getContext("2d")!;

        function draw(time: number) {
          if (destroyed) return;
          const t = time * 0.001;
          // Draw city to offscreen
          drawCity(t);
          // Copy to visible canvas, then post-process there
          fallbackCtx.drawImage(offscreen, 0, 0);
          cpuPostProcess(fallbackCtx, t);
          raf = requestAnimationFrame(draw);
        }
        raf = requestAnimationFrame(draw);

        return () => {
          destroyed = true;
          cancelAnimationFrame(raf);
          window.removeEventListener("resize", handleResize);
        };
      }
    }

    let cleanup: (() => void) | undefined;
    start().then(c => { cleanup = c; });

    return () => {
      destroyed = true;
      cancelAnimationFrame(raf);
      cleanup?.();
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        zIndex: 0,
        pointerEvents: "none",
        imageRendering: "pixelated",
      }}
    />
  );
}
