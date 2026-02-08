import { useEffect, useRef } from "react";

// ── Perlin noise (port of the reactbits GLSL cnoise + fbm) ──

// Permutation table
const PERM = new Uint8Array(512);
const GRAD = [[1,1],[1,-1],[-1,1],[-1,-1],[1,0],[-1,0],[0,1],[0,-1]] as const;
{
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  // Fisher-Yates with fixed seed
  let s = 12345;
  for (let i = 255; i > 0; i--) {
    s = (s * 16807) % 2147483647;
    const j = s % (i + 1);
    [p[i], p[j]] = [p[j]!, p[i]!];
  }
  for (let i = 0; i < 512; i++) PERM[i] = p[i & 255]!;
}

function fade(t: number) { return t * t * t * (t * (t * 6 - 15) + 10); }
function lerp(a: number, b: number, t: number) { return a + t * (b - a); }

function perlin2d(x: number, y: number): number {
  const xi = Math.floor(x) & 255, yi = Math.floor(y) & 255;
  const xf = x - Math.floor(x), yf = y - Math.floor(y);
  const u = fade(xf), v = fade(yf);

  const g = (ix: number, iy: number) => {
    const h = PERM[PERM[ix]! + iy]! & 7;
    const gr = GRAD[h]!;
    return gr[0]! * (xf - (ix - xi)) + gr[1]! * (yf - (iy - yi));
  };

  const n00 = g(xi, yi);
  const n10 = g(xi + 1, yi);
  const n01 = g(xi, yi + 1);
  const n11 = g(xi + 1, yi + 1);

  return lerp(lerp(n00, n10, u), lerp(n01, n11, u), v);
}

function fbm(x: number, y: number, time: number, freq: number, amp: number): number {
  let value = 0;
  let a = 1;
  let f = freq;
  // Offset by time for animation
  let px = x + time * 0.05;
  let py = y + time * 0.03;
  for (let i = 0; i < 4; i++) {
    value += a * Math.abs(perlin2d(px * f, py * f));
    f *= freq;
    a *= amp;
    // Domain warping: feed fbm back into itself
    px += value * 0.5;
    py += value * 0.3;
  }
  return value;
}

// 8x8 Bayer matrix for ordered dithering
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

// Seeded RNG for deterministic city
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
  // Rotate around Y
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

export function DitherCityBackground() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // Use a lower resolution for the retro dithered look
    const SCALE = 2;
    let cw = Math.floor(window.innerWidth / SCALE);
    let ch = Math.floor(window.innerHeight / SCALE);
    canvas.width = cw;
    canvas.height = ch;

    const ctx = canvas.getContext("2d")!;
    const buildings = generateMidtownBuildings();
    let raf: number;

    function resize() {
      cw = Math.floor(window.innerWidth / SCALE);
      ch = Math.floor(window.innerHeight / SCALE);
      canvas!.width = cw;
      canvas!.height = ch;
    }
    window.addEventListener("resize", resize);

    function draw(time: number) {
      const t = time * 0.001;
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, cw, ch);

      // Camera orbits the city
      const angle = t * 0.08;
      const camDist = 14;
      const camX = Math.sin(angle) * camDist;
      const camZ = Math.cos(angle) * camDist;
      const camY = 5 + Math.sin(t * 0.15) * 1.5;
      const cosA = Math.cos(angle + Math.PI);
      const sinA = Math.sin(angle + Math.PI);
      const fov = cw * 0.7;

      // Sort buildings by depth for painter's algorithm
      type DrawCmd = { depth: number; draw: () => void };
      const drawCmds: DrawCmd[] = [];

      for (const b of buildings) {
        // 8 corners of building box
        const x0 = b.x - b.w / 2, x1 = b.x + b.w / 2;
        const z0 = b.z - b.d / 2, z1 = b.z + b.d / 2;
        const y0 = 0, y1 = b.h;

        // Project all 8 corners
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

        // Skip if any corner is behind camera
        if (corners.some(c => c === null)) continue;
        const c = corners as { sx: number; sy: number; depth: number }[];

        const avgDepth = c.reduce((s, p) => s + p.depth, 0) / 8;

        // Define faces: [indices, brightness]
        const faces: [number[], number][] = [
          [[0, 1, 5, 4], 0.35], // front
          [[1, 2, 6, 5], 0.25], // right
          [[2, 3, 7, 6], 0.15], // back
          [[3, 0, 4, 7], 0.30], // left
          [[4, 5, 6, 7], 0.45], // top
        ];

        drawCmds.push({
          depth: avgDepth,
          draw: () => {
            for (const [indices, brightness] of faces) {
              // Backface culling (simple cross product)
              const p0 = c[indices[0]!]!;
              const p1 = c[indices[1]!]!;
              const p2 = c[indices[2]!]!;
              const cross = (p1.sx - p0.sx) * (p2.sy - p0.sy) - (p1.sy - p0.sy) * (p2.sx - p0.sx);
              if (cross > 0) continue;

              const v = Math.floor(brightness * 255);
              ctx.fillStyle = `rgb(${v},${v},${v})`;
              ctx.beginPath();
              ctx.moveTo(c[indices[0]!]!.sx, c[indices[0]!]!.sy);
              for (let k = 1; k < indices.length; k++) {
                ctx.lineTo(c[indices[k]!]!.sx, c[indices[k]!]!.sy);
              }
              ctx.closePath();
              ctx.fill();
            }
          },
        });
      }

      // Draw ground plane
      const gCorners = [
        project(-15, 0, -10, camX, camY, camZ, cosA, sinA, cw, ch, fov),
        project(15, 0, -10, camX, camY, camZ, cosA, sinA, cw, ch, fov),
        project(15, 0, 10, camX, camY, camZ, cosA, sinA, cw, ch, fov),
        project(-15, 0, 10, camX, camY, camZ, cosA, sinA, cw, ch, fov),
      ];
      if (gCorners.every(c => c !== null)) {
        const gc = gCorners as { sx: number; sy: number; depth: number }[];
        ctx.fillStyle = "rgb(25,25,25)";
        ctx.beginPath();
        ctx.moveTo(gc[0]!.sx, gc[0]!.sy);
        for (let i = 1; i < 4; i++) ctx.lineTo(gc[i]!.sx, gc[i]!.sy);
        ctx.closePath();
        ctx.fill();
      }

      // Sort back-to-front and draw
      drawCmds.sort((a, b) => b.depth - a.depth);
      for (const cmd of drawCmds) cmd.draw();

      // Apply Perlin noise fog overlay + Bayer dithering
      const imgData = ctx.getImageData(0, 0, cw, ch);
      const pixels = imgData.data;
      const colorNum = 4;
      const ditherStep = 1 / (colorNum - 1);
      const noiseScale = 3.0;
      const noiseAmp = 0.3;
      const aspect = cw / ch;

      for (let i = 0; i < pixels.length; i += 4) {
        const px = (i / 4) % cw;
        const py = Math.floor(i / 4 / cw);

        // Perlin noise fog: screen-space UV mapped through fbm
        const uvx = (px / cw - 0.5) * aspect;
        const uvy = (py / ch - 0.5);
        const noise = fbm(uvx, uvy, t, noiseScale, noiseAmp);

        // Bayer threshold
        const bx = px & 7;
        const by = py & 7;
        const threshold = (BAYER_8x8[by * 8 + bx]! / 64) - 0.25;

        // Only apply noise where city geometry is present (non-black pixels)
        const brightness = (pixels[i]! + pixels[i + 1]! + pixels[i + 2]!) / 3;
        const cityMask = Math.min(1, brightness / 20); // 0 on black bg, 1 on geometry

        for (let c = 0; c < 3; c++) {
          let v = pixels[i + c]! / 255;
          v = v + noise * 0.35 * cityMask;
          v += threshold * ditherStep;
          v = Math.max(0, v - 0.35);
          v = Math.floor(v * (colorNum - 1) + 0.5) / (colorNum - 1);
          pixels[i + c] = Math.round(v * 255);
        }
      }
      ctx.putImageData(imgData, 0, 0);

      raf = requestAnimationFrame(draw);
    }

    raf = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
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
