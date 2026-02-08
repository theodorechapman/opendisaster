import * as THREE from "three";
import type { LayerData, FeatureCollection, BuildingFeature, ElevationData } from "./tiles.ts";
import { metersPerDegree } from "./tiles.ts";

type Proj = { lon: number; lat: number };

// ─── Building registry & terrain references (for tornado interaction) ────────

export interface BuildingRecord {
  mesh: THREE.Mesh;
  height: number;
  baseY: number;
  centerX: number;
  centerZ: number;
  width: number;
  tiltTargetX?: number;
  tiltTargetZ?: number;
  damageLevel: number;
  destroyed: boolean;
  originalColor: THREE.Color;
  /** Random multiplier (0.7–1.3) simulating construction quality variance. */
  structuralStrength: number;
}

export let buildingRegistry: BuildingRecord[] = [];

export function clearBuildingRegistry() {
  buildingRegistry = [];
}

export interface TreeRecord {
  trunkMesh: THREE.Mesh;
  canopyMesh: THREE.Mesh;
  x: number;
  z: number;
  height: number;
  uprooted: boolean;
  broken: boolean;
  /** Random 0.7–1.3 multiplier for wind resistance. */
  strength: number;
}

export let treeRegistry: TreeRecord[] = [];

export function clearTreeRegistry() {
  treeRegistry = [];
}

export interface CarRecord {
  mesh: THREE.Object3D;
  x: number;
  z: number;
  baseX: number;
  baseZ: number;
  baseY: number;
  uprooted: boolean;
  /** Random 0.7–1.3 multiplier for wind resistance. */
  strength: number;
  heading: number;
  speed: number;
  tipped: boolean;
}

export let carRegistry: CarRecord[] = [];

export function clearCarRegistry() {
  carRegistry = [];
}

// Terrain canvas / texture refs (for tornado ground-damage painting)
export let terrainCanvasRef: HTMLCanvasElement | null = null;
export let terrainTextureRef: THREE.CanvasTexture | null = null;
export let terrainBoundsRef: {
  xMin: number; xMax: number; zMin: number; zMax: number;
  width: number; depth: number;
} | null = null;
export let terrainMeshRef: THREE.Mesh | null = null;
export let roadLinesRef: RoadLine2D[] = [];
export let sceneGroupRef: THREE.Group | null = null;

// Height sampler accessor (set inside buildAllLayers)
let _heightSampler: HeightSampler | null = null;

/** Sample terrain height at local Three.js (x, z) coordinates. */
export function getTerrainHeight(x: number, z: number): number {
  return _heightSampler ? _heightSampler.sample(x, z) : 0;
}

// ─── Height sampler (bilinear interpolation over the elevation grid) ────────

class HeightSampler {
  private values: number[][];
  private gridSize: number;
  private minElev: number;
  private xMin: number; // local meters
  private zMin: number;
  private xMax: number;
  private zMax: number;

  constructor(elev: ElevationData, centerLat: number, centerLon: number, mpd: Proj) {
    this.values = elev.values;
    this.gridSize = elev.gridSize;

    // Find min elevation to use as baseline
    this.minElev = Infinity;
    for (const row of this.values) {
      for (const v of row) {
        if (v < this.minElev) this.minElev = v;
      }
    }

    // Bounding box in local meter coords
    this.xMin = (elev.west - centerLon) * mpd.lon;
    this.xMax = (elev.east - centerLon) * mpd.lon;
    // Note: south = lower lat = lower y in local, but in Three.js Z is negated
    // zMin corresponds to north (most negative Z), zMax to south
    this.zMin = -((elev.north - centerLat) * mpd.lat); // north → negative Z
    this.zMax = -((elev.south - centerLat) * mpd.lat); // south → positive Z
  }

  /** Sample terrain height at local (x, z) coords. Returns Y offset above min elevation. */
  sample(x: number, z: number): number {
    // Convert to grid fractional coordinates
    // x maps to columns, z maps to rows (inverted because zMin=north, row0=south)
    const colFrac = ((x - this.xMin) / (this.xMax - this.xMin)) * (this.gridSize - 1);
    // z is negated: zMin is north (row = gridSize-1), zMax is south (row = 0)
    const rowFrac = ((this.zMax - z) / (this.zMax - this.zMin)) * (this.gridSize - 1);

    const col0 = Math.max(0, Math.min(this.gridSize - 2, Math.floor(colFrac)));
    const row0 = Math.max(0, Math.min(this.gridSize - 2, Math.floor(rowFrac)));
    const col1 = col0 + 1;
    const row1 = row0 + 1;

    const ct = colFrac - col0;
    const rt = rowFrac - row0;

    const v00 = this.values[row0]![col0]! - this.minElev;
    const v10 = this.values[row1]![col0]! - this.minElev;
    const v01 = this.values[row0]![col1]! - this.minElev;
    const v11 = this.values[row1]![col1]! - this.minElev;

    // Bilinear interpolation
    const top = v00 * (1 - ct) + v01 * ct;
    const bottom = v10 * (1 - ct) + v11 * ct;
    return top * (1 - rt) + bottom * rt;
  }

  get baseElevation() {
    return this.minElev;
  }
}

// ─── Main entry point ───────────────────────────────────────────────────────

export function buildAllLayers(
  data: LayerData,
  centerLat: number,
  centerLon: number,
  carTemplate?: THREE.Object3D | null,
): THREE.Group {
  const root = new THREE.Group();
  sceneGroupRef = root;
  const mpd = metersPerDegree(centerLat);

  // Reset registries for tornado interaction
  clearBuildingRegistry();
  clearTreeRegistry();
  clearCarRegistry();

  const sampler = new HeightSampler(data.elevation, centerLat, centerLon, mpd);
  _heightSampler = sampler;

  // Extract geometry for canvas painting
  const parkPolys = extractPolygonsXZ(data.parks, centerLat, centerLon, mpd);
  const waterPolys = extractPolygonsXZ(data.water, centerLat, centerLon, mpd);
  const roadLines = extractRoadLinesXZ(data.roads, centerLat, centerLon, mpd);
  const railLines = extractRoadLinesXZ(data.railways, centerLat, centerLon, mpd);
  roadLinesRef = roadLines;

  // All ground features painted directly onto the terrain texture
  root.add(buildTerrain(data.elevation, centerLat, centerLon, mpd, sampler, parkPolys, waterPolys, roadLines, railLines));

  root.add(buildBuildings(data.buildings, centerLat, centerLon, mpd, sampler));
  root.add(buildWater(data.water, centerLat, centerLon, mpd, sampler));
  root.add(buildTrees(data.trees, centerLat, centerLon, mpd, sampler));
  root.add(buildBarriers(data.barriers, centerLat, centerLon, mpd, sampler));
  if (carTemplate && roadLines.length > 0) {
    root.add(buildCars(roadLines, sampler, carTemplate));
  }

  return root;
}

// ─── Projection helpers ─────────────────────────────────────────────────────

function toLocal(coord: number[], centerLat: number, centerLon: number, mpd: Proj): [number, number] {
  return [
    (coord[0]! - centerLon) * mpd.lon,
    (coord[1]! - centerLat) * mpd.lat,
  ];
}

/** Convert local [x, latY] to Three.js [x, z] (negate the lat axis). */
function toXZ(coord: number[], cLat: number, cLon: number, mpd: Proj): [number, number] {
  const [x, y] = toLocal(coord, cLat, cLon, mpd);
  return [x, -y];
}

function getPolygonRings(geom: BuildingFeature["geometry"]): number[][][][] {
  if (geom.type === "Polygon") return [geom.coordinates as number[][][]];
  if (geom.type === "MultiPolygon") return geom.coordinates as number[][][][];
  return [];
}

function getLineCoords(geom: BuildingFeature["geometry"]): number[][] | null {
  if (geom.type === "LineString") return geom.coordinates as number[][];
  return null;
}

function getPointCoord(geom: BuildingFeature["geometry"]): number[] | null {
  if (geom.type === "Point") return geom.coordinates as number[];
  return null;
}

// ─── Polygon extraction & point-in-polygon ──────────────────────────────────

type Poly2D = [number, number][]; // array of [x, z] in Three.js coords

/** Extract all polygon outlines from a FeatureCollection as Three.js XZ coords. */
function extractPolygonsXZ(fc: FeatureCollection, cLat: number, cLon: number, mpd: Proj): Poly2D[] {
  const result: Poly2D[] = [];
  for (const feature of fc.features) {
    const polygons = getPolygonRings(feature.geometry);
    for (const rings of polygons) {
      const outerRing = rings[0];
      if (!outerRing || outerRing.length < 4) continue;
      const poly: Poly2D = outerRing.map((c) => {
        const [x, z] = toXZ(c, cLat, cLon, mpd);
        return [x, z];
      });
      result.push(poly);
    }
  }
  return result;
}

export type RoadLine2D = { points: [number, number][]; width: number; isFootpath: boolean };

const ROAD_WIDTHS: Record<string, number> = {
  motorway: 14, trunk: 12, primary: 10, secondary: 8, tertiary: 7,
  residential: 6, service: 4, unclassified: 6, living_street: 5,
  pedestrian: 4, footway: 2, cycleway: 2, path: 1.5,
};

/** Extract road/rail linestrings with widths as Three.js XZ coords. */
function extractRoadLinesXZ(fc: FeatureCollection, cLat: number, cLon: number, mpd: Proj): RoadLine2D[] {
  const result: RoadLine2D[] = [];
  for (const feature of fc.features) {
    const coords = getLineCoords(feature.geometry);
    if (!coords || coords.length < 2) continue;
    const props = feature.properties;
    const highway = strProp(props.highway) ?? strProp(props.railway) ?? "residential";
    const lanesWidth = (numProp(props._lanes) ?? 0) * 3.5;
    const width = numProp(props._width) ?? (lanesWidth > 0 ? lanesWidth : null) ?? ROAD_WIDTHS[highway] ?? 6;
    const isFootpath = highway === "footway" || highway === "cycleway" || highway === "path";
    const points: [number, number][] = coords.map((c) => toXZ(c, cLat, cLon, mpd));
    result.push({ points, width, isFootpath });
  }
  return result;
}

/** Ray-casting point-in-polygon test in 2D (x, z). */
function pointInPolygon(x: number, z: number, poly: Poly2D): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i]![0], zi = poly[i]![1];
    const xj = poly[j]![0], zj = poly[j]![1];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function pointInAnyPolygon(x: number, z: number, polys: Poly2D[]): boolean {
  for (const p of polys) {
    if (pointInPolygon(x, z, p)) return true;
  }
  return false;
}

// ─── Cars (spawned along roads) ────────────────────────────────────────────

function buildCars(roadLines: RoadLine2D[], sampler: HeightSampler, carTemplate: THREE.Object3D): THREE.Group {
  const group = new THREE.Group();
  group.name = "cars";

  const segments: { x1: number; z1: number; x2: number; z2: number; len: number }[] = [];
  let totalLen = 0;
  for (const line of roadLines) {
    if (line.isFootpath) continue;
    const pts = line.points;
    for (let i = 0; i < pts.length - 1; i++) {
      const [x1, z1] = pts[i]!;
      const [x2, z2] = pts[i + 1]!;
      const dx = x2 - x1;
      const dz = z2 - z1;
      const len = Math.hypot(dx, dz);
      if (len < 8) continue;
      segments.push({ x1, z1, x2, z2, len });
      totalLen += len;
    }
  }

  if (segments.length === 0) return group;

  const density = THREE.MathUtils.clamp(totalLen / 2500, 0.4, 1.4);
  const areaKm2 = terrainBoundsRef ? (terrainBoundsRef.width * terrainBoundsRef.depth) / 1_000_000 : 1;
  const areaFactor = THREE.MathUtils.clamp(areaKm2 / 0.9, 0.35, 1.2);
  const maxByLen = Math.floor(totalLen / 90);
  const target = Math.min(30, Math.max(1, Math.floor(maxByLen * density * areaFactor)));

  const cumulative: number[] = [];
  let acc = 0;
  for (const s of segments) {
    acc += s.len;
    cumulative.push(acc);
  }

  for (let i = 0; i < target; i++) {
    const r = Math.random() * acc;
    let idx = cumulative.findIndex((v) => v >= r);
    if (idx < 0) idx = segments.length - 1;
    const s = segments[idx]!;
    const t = Math.random();
    const x = s.x1 + (s.x2 - s.x1) * t;
    const z = s.z1 + (s.z2 - s.z1) * t;
    const y = sampler.sample(x, z) + 0.25;

    const car = carTemplate.clone(true);
    const nx = x + (Math.random() - 0.5) * 2;
    const nz = z + (Math.random() - 0.5) * 2;
    if (terrainBoundsRef) {
      if (nx < terrainBoundsRef.xMin || nx > terrainBoundsRef.xMax) continue;
      if (nz < terrainBoundsRef.zMin || nz > terrainBoundsRef.zMax) continue;
    }
    car.position.set(nx, y, nz);

    const dirX = s.x2 - s.x1;
    const dirZ = s.z2 - s.z1;
    car.rotation.y = Math.atan2(dirX, dirZ) + (Math.random() - 0.5) * 0.15;

    car.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry = obj.geometry.clone();
        if (Array.isArray(obj.material)) {
          obj.material = obj.material.map((m) => m.clone());
        } else {
          obj.material = (obj.material as THREE.Material).clone();
        }
        obj.castShadow = true;
        obj.receiveShadow = true;
      }
    });

    group.add(car);
    carRegistry.push({
      mesh: car,
      x: nx,
      z: nz,
      baseX: nx,
      baseZ: nz,
      baseY: y,
      uprooted: false,
      strength: 0.7 + Math.random() * 0.6,
      heading: car.rotation.y,
      speed: 0,
      tipped: false,
    });
  }

  return group;
}

export function updateCarsMovement(dt: number) {
  if (!terrainBoundsRef) return;
  const b = terrainBoundsRef;
  for (const car of carRegistry) {
    if (car.uprooted || car.tipped) continue;
    const turn = (Math.random() - 0.5) * 0.6 * dt;
    car.heading += turn;
    const vx = Math.sin(car.heading) * car.speed;
    const vz = Math.cos(car.heading) * car.speed;
    car.x += vx * dt;
    car.z += vz * dt;

    // Keep within bounds by gently steering inward
    const margin = 6;
    if (car.x < b.xMin + margin) car.heading = 0.2;
    if (car.x > b.xMax - margin) car.heading = -0.2 + Math.PI;
    if (car.z < b.zMin + margin) car.heading = Math.PI;
    if (car.z > b.zMax - margin) car.heading = 0;

    const y = getTerrainHeight(car.x, car.z);
    car.mesh.position.set(car.x, y, car.z);
    car.mesh.rotation.y = car.heading;

    // Building collision: turn away and slow down
    for (const bld of buildingRegistry) {
      if (bld.destroyed) continue;
      const dx = car.x - bld.centerX;
      const dz = car.z - bld.centerZ;
      const dist = Math.hypot(dx, dz);
      const bRadius = bld.width * 0.6;
      const carRadius = 1.8;
      if (dist < bRadius + carRadius) {
        const ang = Math.atan2(dx, dz);
        car.heading = ang + Math.PI * 0.8;
        car.speed = Math.max(1.2, car.speed * 0.6);
        car.x = bld.centerX + Math.sin(car.heading) * (bRadius + carRadius + 1.0);
        car.z = bld.centerZ + Math.cos(car.heading) * (bRadius + carRadius + 1.0);
        break;
      }
    }
  }
}

export function resetCarsToBase() {
  for (const car of carRegistry) {
    car.x = car.baseX;
    car.z = car.baseZ;
    car.mesh.position.set(car.baseX, car.baseY, car.baseZ);
    car.mesh.rotation.y = car.heading;
    car.speed = 0;
    car.tipped = false;
  }
}

// ─── Terrain mesh (with canvas-textured parks & water) ──────────────────────

const TEX_SIZE = 1024; // canvas texture resolution

function buildTerrain(
  elev: ElevationData,
  cLat: number,
  cLon: number,
  mpd: Proj,
  sampler: HeightSampler,
  parkPolys: Poly2D[],
  waterPolys: Poly2D[],
  roadLines: RoadLine2D[],
  railLines: RoadLine2D[],
): THREE.Mesh {
  const gs = elev.gridSize;
  const xMin = (elev.west - cLon) * mpd.lon;
  const xMax = (elev.east - cLon) * mpd.lon;
  const zMin = -((elev.north - cLat) * mpd.lat);
  const zMax = -((elev.south - cLat) * mpd.lat);
  const width = xMax - xMin;
  const depth = zMax - zMin;

  // Pixels per meter for converting world widths to canvas stroke widths
  const pxPerMeterX = TEX_SIZE / width;
  const pxPerMeterZ = TEX_SIZE / depth;
  const pxPerMeter = (pxPerMeterX + pxPerMeterZ) / 2;

  // --- Paint all ground features onto a canvas texture ---
  const canvas = document.createElement("canvas");
  canvas.width = TEX_SIZE;
  canvas.height = TEX_SIZE;
  const ctx = canvas.getContext("2d")!;

  // Fill with terrain base color (dark grass green)
  ctx.fillStyle = "#2d5a1e";
  ctx.fillRect(0, 0, TEX_SIZE, TEX_SIZE);

  // Map world XZ → canvas pixels
  function worldToCanvas(worldX: number, worldZ: number): [number, number] {
    const u = (worldX - xMin) / width;
    const v = (worldZ - zMin) / depth;
    return [u * TEX_SIZE, v * TEX_SIZE];
  }

  function drawPolys(polys: Poly2D[], color: string) {
    ctx.fillStyle = color;
    for (const poly of polys) {
      if (poly.length < 3) continue;
      ctx.beginPath();
      const [sx, sy] = worldToCanvas(poly[0]![0], poly[0]![1]);
      ctx.moveTo(sx, sy);
      for (let i = 1; i < poly.length; i++) {
        const [px, py] = worldToCanvas(poly[i]![0], poly[i]![1]);
        ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fill();
    }
  }

  // Paint all ground features: parks, water, roads, railways
  drawPolys(parkPolys, "#3d8b37");
  drawPolys(waterPolys, "#3388cc");

  // Draw road/rail lines as thick stroked paths
  function drawLines(lines: RoadLine2D[], color: string, fallbackColor?: string) {
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (const line of lines) {
      if (line.points.length < 2) continue;
      ctx.strokeStyle = (fallbackColor && line.isFootpath) ? fallbackColor : color;
      ctx.lineWidth = line.width * pxPerMeter;
      ctx.beginPath();
      const [sx, sy] = worldToCanvas(line.points[0]![0], line.points[0]![1]);
      ctx.moveTo(sx, sy);
      for (let i = 1; i < line.points.length; i++) {
        const [px, py] = worldToCanvas(line.points[i]![0], line.points[i]![1]);
        ctx.lineTo(px, py);
      }
      ctx.stroke();
    }
  }

  drawLines(railLines, "#666666");
  drawLines(roadLines, "#444444", "#999988");

  const texture = new THREE.CanvasTexture(canvas);
  texture.flipY = false; // canvas y=0 is top, UV v=0 maps to zMin — keep them aligned
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;

  // Expose canvas/texture/bounds for tornado ground-damage painting
  terrainCanvasRef = canvas;
  terrainTextureRef = texture;
  terrainBoundsRef = { xMin, xMax, zMin, zMax, width, depth };

  // --- Build terrain geometry (indexed, much faster) ---
  const subdivs = Math.max(gs - 1, 64);
  const geo = new THREE.PlaneGeometry(width, depth, subdivs, subdivs);
  geo.rotateX(-Math.PI / 2);

  // Displace vertices & manually assign UVs matching world position
  const pos = geo.attributes.position!;
  const uv = geo.attributes.uv!;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i) + (xMin + xMax) / 2;
    const z = pos.getZ(i) + (zMin + zMax) / 2;
    pos.setX(i, x);
    pos.setY(i, sampler.sample(x, z));
    pos.setZ(i, z);

    // UV: 0→1 across the terrain extent
    uv.setXY(i, (x - xMin) / width, (z - zMin) / depth);
  }

  geo.computeVertexNormals();

  const mat = new THREE.MeshPhongMaterial({
    map: texture,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.name = "terrain";
  terrainMeshRef = mesh;
  return mesh;
}

// ─── Buildings (extruded polygons on terrain) ───────────────────────────────

function buildBuildings(fc: FeatureCollection, cLat: number, cLon: number, mpd: Proj, sampler: HeightSampler): THREE.Group {
  const group = new THREE.Group();
  group.name = "buildings";

  for (const feature of fc.features) {
    const props = feature.properties;
    const height = numProp(props._height) ?? numProp(props.height) ?? 10;
    const minHeight = numProp(props._minHeight) ?? numProp(props.min_height) ?? 0;
    const color = strProp(props["building:colour"]) ?? strProp(props.color) ?? "#8899aa";

    const polygons = getPolygonRings(feature.geometry);
    for (const rings of polygons) {
      const outerRing = rings[0];
      if (!outerRing || outerRing.length < 4) continue;

      // Shape uses toLocal (x, latY) — rotateX(-PI/2) maps latY → -Z correctly
      // Sample terrain at every vertex, use the MINIMUM so no corner floats
      const pts2d: THREE.Vector2[] = [];
      let minTerrainY = Infinity;
      for (const c of outerRing) {
        const [x, y] = toLocal(c, cLat, cLon, mpd);
        pts2d.push(new THREE.Vector2(x, y));
        const terrainAtVertex = sampler.sample(x, -y); // negate for Three.js Z
        if (terrainAtVertex < minTerrainY) minTerrainY = terrainAtVertex;
      }

      const terrainY = minTerrainY;

      const shape = new THREE.Shape(pts2d);
      const extH = height - minHeight;
      if (extH <= 0) continue;

      const geo = new THREE.ExtrudeGeometry(shape, {
        depth: extH,
        bevelEnabled: true,
        bevelThickness: 0.2,
        bevelSize: 0.15,
        bevelSegments: 2,
      });
      // ExtrudeGeometry extrudes along Z in shape space. We created shape in XZ plane,
      // so extrusion goes along "local Z". We need to rotate so extrusion goes up (Y).
      // Shape is in (x, z) coords → extrude goes along shape's Z axis.
      // We want the extrusion along Y, so rotate -90deg around X.
      geo.rotateX(-Math.PI / 2);
      geo.translate(0, terrainY + minHeight, 0);

      const mat = new THREE.MeshPhongMaterial({ color, shininess: 15 });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);

      // Register for tornado interaction
      const bbox = new THREE.Box3().setFromObject(mesh);
      const size = bbox.getSize(new THREE.Vector3());
      const center = bbox.getCenter(new THREE.Vector3());
      buildingRegistry.push({
        mesh,
        height: extH,
        baseY: terrainY + minHeight,
        centerX: center.x,
        centerZ: center.z,
        width: Math.max(size.x, size.z),
        damageLevel: 0,
        destroyed: false,
        originalColor: new THREE.Color(color),
        structuralStrength: 0.7 + Math.random() * 0.6,
      });
    }
  }
  return group;
}

// ─── Water (linestring waterways only — polygon water is painted on terrain) ─

function buildWater(fc: FeatureCollection, cLat: number, cLon: number, mpd: Proj, sampler: HeightSampler): THREE.Group {
  const group = new THREE.Group();
  group.name = "water";

  const waterMat = new THREE.MeshPhongMaterial({
    color: 0x3388cc,
    shininess: 80,
    specular: 0x88bbee,
  });

  for (const feature of fc.features) {
    // Skip polygon water bodies — they're painted on the terrain mesh
    const polygons = getPolygonRings(feature.geometry);
    if (polygons.length > 0) continue;

    // Linestring waterways (rivers, streams, canals)
    const coords = getLineCoords(feature.geometry);
    if (!coords || coords.length < 2) continue;

    const props = feature.properties;
    const waterway = strProp(props.waterway) ?? "stream";
    const width = numProp(props._width) ?? (waterway === "river" ? 15 : waterway === "canal" ? 8 : 3);

    const points = coords.map((c) => {
      const [x, z] = toXZ(c, cLat, cLon, mpd);
      const y = sampler.sample(x, z) + 0.1;
      return new THREE.Vector3(x, y, z);
    });

    const ribbonGeo = buildRibbon(points, width);
    if (!ribbonGeo) continue;

    const mesh = new THREE.Mesh(ribbonGeo, waterMat);
    group.add(mesh);
  }
  return group;
}

// ─── Trees (placed on terrain) ──────────────────────────────────────────────

const treeTrunkGeo = new THREE.CylinderGeometry(0.25, 0.45, 4, 12);
const treeCanopyGeo = new THREE.IcosahedronGeometry(3, 1);
const trunkMat = new THREE.MeshPhongMaterial({ color: 0x5c3a1e, shininess: 5 });
const canopyMat = new THREE.MeshPhongMaterial({ color: 0x2d7a2d, shininess: 8 });

function buildTrees(fc: FeatureCollection, cLat: number, cLon: number, mpd: Proj, sampler: HeightSampler): THREE.Group {
  const group = new THREE.Group();
  group.name = "trees";

  for (const feature of fc.features) {
    const coord = getPointCoord(feature.geometry);
    if (!coord) {
      // Tree row
      const lineCoords = getLineCoords(feature.geometry);
      if (!lineCoords || lineCoords.length < 2) continue;
      const points = lineCoords.map((c) => toXZ(c, cLat, cLon, mpd));
      const spacing = 8;
      let accumulated = 0;
      for (let i = 1; i < points.length; i++) {
        const dx = points[i]![0] - points[i - 1]![0];
        const dz = points[i]![1] - points[i - 1]![1];
        const segLen = Math.sqrt(dx * dx + dz * dz);
        accumulated += segLen;
        while (accumulated >= spacing) {
          accumulated -= spacing;
          const t = 1 - accumulated / segLen;
          const x = points[i - 1]![0] + dx * t;
          const z = points[i - 1]![1] + dz * t;
          addTree(group, x, z, 10, sampler);
        }
      }
      continue;
    }

    const [x, z] = toXZ(coord, cLat, cLon, mpd);
    const height = numProp(feature.properties._height) ?? 10;
    addTree(group, x, z, height, sampler);
  }

  return group;
}

function addTree(group: THREE.Group, x: number, z: number, height: number, sampler: HeightSampler) {
  const scale = height / 10;
  const terrainY = sampler.sample(x, z);

  const trunk = new THREE.Mesh(treeTrunkGeo, trunkMat);
  trunk.position.set(x, terrainY + 2 * scale, z);
  trunk.scale.setScalar(scale);
  trunk.castShadow = true;
  group.add(trunk);

  const canopy = new THREE.Mesh(treeCanopyGeo, canopyMat);
  canopy.position.set(x, terrainY + 7 * scale, z);
  canopy.scale.setScalar(scale);
  canopy.castShadow = true;
  group.add(canopy);

  // Register for tornado interaction
  treeRegistry.push({
    trunkMesh: trunk,
    canopyMesh: canopy,
    x, z, height,
    uprooted: false,
    broken: false,
    strength: 0.7 + Math.random() * 0.6,
  });
}

// ─── Barriers (walls on terrain) ────────────────────────────────────────────

function buildBarriers(fc: FeatureCollection, cLat: number, cLon: number, mpd: Proj, sampler: HeightSampler): THREE.Group {
  const group = new THREE.Group();
  group.name = "barriers";

  const wallMat = new THREE.MeshPhongMaterial({ color: 0x998877 });
  const hedgeMat = new THREE.MeshPhongMaterial({ color: 0x3a6b2a });

  for (const feature of fc.features) {
    const coords = getLineCoords(feature.geometry);
    if (!coords || coords.length < 2) continue;

    const props = feature.properties;
    const barrier = strProp(props.barrier) ?? "wall";
    const height = numProp(props._height) ?? (barrier === "hedge" ? 1.5 : barrier === "wall" ? 2 : 1);

    const points = coords.map((c) => {
      const [x, z] = toXZ(c, cLat, cLon, mpd);
      return new THREE.Vector3(x, sampler.sample(x, z), z);
    });

    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i]!;
      const b = points[i + 1]!;
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const len = Math.sqrt(dx * dx + dz * dz);
      if (len < 0.1) continue;

      const midY = (a.y + b.y) / 2;
      const geo = new THREE.BoxGeometry(len, height, 0.3);
      const mesh = new THREE.Mesh(geo, barrier === "hedge" ? hedgeMat : wallMat);
      mesh.position.set((a.x + b.x) / 2, midY + height / 2, (a.z + b.z) / 2);
      mesh.rotation.y = -Math.atan2(dz, dx);
      mesh.castShadow = true;
      group.add(mesh);
    }
  }
  return group;
}

// ─── Ribbon helper (polyline + width → terrain-draped mesh) ─────────────────

function buildRibbon(points: THREE.Vector3[], width: number): THREE.BufferGeometry | null {
  if (points.length < 2) return null;

  const hw = width / 2;
  const positions: number[] = [];
  const indices: number[] = [];

  for (let i = 0; i < points.length; i++) {
    let dir: THREE.Vector3;
    if (i === 0) {
      dir = new THREE.Vector3().subVectors(points[1]!, points[0]!).normalize();
    } else if (i === points.length - 1) {
      dir = new THREE.Vector3().subVectors(points[i]!, points[i - 1]!).normalize();
    } else {
      dir = new THREE.Vector3().subVectors(points[i + 1]!, points[i - 1]!).normalize();
    }

    // Perpendicular in XZ plane
    const perp = new THREE.Vector3(-dir.z, 0, dir.x);
    const p = points[i]!;
    positions.push(p.x - perp.x * hw, p.y, p.z - perp.z * hw);
    positions.push(p.x + perp.x * hw, p.y, p.z + perp.z * hw);
  }

  for (let i = 0; i < points.length - 1; i++) {
    const li = i * 2;
    const ri = li + 1;
    const nli = li + 2;
    const nri = li + 3;
    indices.push(li, nli, ri);
    indices.push(ri, nli, nri);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

// ─── Property helpers ───────────────────────────────────────────────────────

function numProp(val: unknown): number | null {
  if (val == null) return null;
  const n = typeof val === "number" ? val : parseFloat(String(val));
  return isNaN(n) ? null : n;
}

function strProp(val: unknown): string | null {
  return typeof val === "string" && val.length > 0 ? val : null;
}
