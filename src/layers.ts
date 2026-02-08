import * as THREE from "three";
import type { LayerData, FeatureCollection, BuildingFeature, ElevationData } from "./tiles.ts";
import { metersPerDegree } from "./tiles.ts";

type Proj = { lon: number; lat: number };

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
): THREE.Group {
  const root = new THREE.Group();
  const mpd = metersPerDegree(centerLat);

  const sampler = new HeightSampler(data.elevation, centerLat, centerLon, mpd);

  // Parks and water are painted onto the terrain mesh via vertex colors
  const parkPolys = extractPolygonsXZ(data.parks, centerLat, centerLon, mpd);
  const waterPolys = extractPolygonsXZ(data.water, centerLat, centerLon, mpd);
  root.add(buildTerrain(data.elevation, centerLat, centerLon, mpd, sampler, parkPolys, waterPolys));

  root.add(buildBuildings(data.buildings, centerLat, centerLon, mpd, sampler));
  root.add(buildRoads(data.roads, centerLat, centerLon, mpd, sampler));
  root.add(buildWater(data.water, centerLat, centerLon, mpd, sampler));
  root.add(buildTrees(data.trees, centerLat, centerLon, mpd, sampler));
  root.add(buildRailways(data.railways, centerLat, centerLon, mpd, sampler));
  root.add(buildBarriers(data.barriers, centerLat, centerLon, mpd, sampler));

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
): THREE.Mesh {
  const gs = elev.gridSize;
  const xMin = (elev.west - cLon) * mpd.lon;
  const xMax = (elev.east - cLon) * mpd.lon;
  const zMin = -((elev.north - cLat) * mpd.lat);
  const zMax = -((elev.south - cLat) * mpd.lat);
  const width = xMax - xMin;
  const depth = zMax - zMin;

  // --- Paint park/water polygons onto a canvas texture ---
  const canvas = document.createElement("canvas");
  canvas.width = TEX_SIZE;
  canvas.height = TEX_SIZE;
  const ctx = canvas.getContext("2d")!;

  // Fill with terrain base color
  ctx.fillStyle = "#556b2f";
  ctx.fillRect(0, 0, TEX_SIZE, TEX_SIZE);

  // Map world XZ → canvas UV: u = (x - xMin) / width, v = (z - zMin) / depth
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

  // Draw parks first, then water on top
  drawPolys(parkPolys, "#3d8b37");
  drawPolys(waterPolys, "#3388cc");

  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;

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
    flatShading: true,
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.name = "terrain";
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

      const geo = new THREE.ExtrudeGeometry(shape, { depth: extH, bevelEnabled: false });
      // ExtrudeGeometry extrudes along Z in shape space. We created shape in XZ plane,
      // so extrusion goes along "local Z". We need to rotate so extrusion goes up (Y).
      // Shape is in (x, z) coords → extrude goes along shape's Z axis.
      // We want the extrusion along Y, so rotate -90deg around X.
      geo.rotateX(-Math.PI / 2);
      geo.translate(0, terrainY + minHeight, 0);

      const mat = new THREE.MeshPhongMaterial({ color, flatShading: true });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
    }
  }
  return group;
}

// ─── Roads (flat ribbons draped on terrain) ─────────────────────────────────

const ROAD_WIDTHS: Record<string, number> = {
  motorway: 14, trunk: 12, primary: 10, secondary: 8, tertiary: 7,
  residential: 6, service: 4, unclassified: 6, living_street: 5,
  pedestrian: 4, footway: 2, cycleway: 2, path: 1.5,
};

function buildRoads(fc: FeatureCollection, cLat: number, cLon: number, mpd: Proj, sampler: HeightSampler): THREE.Group {
  const group = new THREE.Group();
  group.name = "roads";

  const roadMat = new THREE.MeshPhongMaterial({ color: 0x333333 });
  const footpathMat = new THREE.MeshPhongMaterial({ color: 0x999988 });

  for (const feature of fc.features) {
    const coords = getLineCoords(feature.geometry);
    if (!coords || coords.length < 2) continue;

    const props = feature.properties;
    const highway = strProp(props.highway) ?? "residential";
    const lanesWidth = (numProp(props._lanes) ?? 0) * 3.5;
    const width = numProp(props._width) ?? (lanesWidth > 0 ? lanesWidth : null) ?? ROAD_WIDTHS[highway] ?? 6;
    const isFootpath = highway === "footway" || highway === "cycleway" || highway === "path";

    const points = coords.map((c) => {
      const [x, z] = toXZ(c, cLat, cLon, mpd);
      const y = sampler.sample(x, z) + 0.1;
      return new THREE.Vector3(x, y, z);
    });

    const ribbonGeo = buildRibbon(points, width);
    if (!ribbonGeo) continue;

    const mesh = new THREE.Mesh(ribbonGeo, isFootpath ? footpathMat : roadMat);
    mesh.receiveShadow = true;
    group.add(mesh);
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

const treeTrunkGeo = new THREE.CylinderGeometry(0.3, 0.4, 4, 6);
const treeCanopyGeo = new THREE.SphereGeometry(3, 8, 6);
const trunkMat = new THREE.MeshPhongMaterial({ color: 0x5c3a1e });
const canopyMat = new THREE.MeshPhongMaterial({ color: 0x2d7a2d, flatShading: true });

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
}

// ─── Railways (on terrain) ──────────────────────────────────────────────────

function buildRailways(fc: FeatureCollection, cLat: number, cLon: number, mpd: Proj, sampler: HeightSampler): THREE.Group {
  const group = new THREE.Group();
  group.name = "railways";

  const railMat = new THREE.MeshPhongMaterial({ color: 0x666666 });

  for (const feature of fc.features) {
    const coords = getLineCoords(feature.geometry);
    if (!coords || coords.length < 2) continue;

    const points = coords.map((c) => {
      const [x, z] = toXZ(c, cLat, cLon, mpd);
      const y = sampler.sample(x, z) + 0.08;
      return new THREE.Vector3(x, y, z);
    });

    const ribbonGeo = buildRibbon(points, 3);
    if (!ribbonGeo) continue;

    const mesh = new THREE.Mesh(ribbonGeo, railMat);
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  return group;
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
