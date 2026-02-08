import * as THREE from "three";

export interface TerrainParams {
  lat: number;
  lng: number;
  radius?: number;
  zoom?: number;
}

/** Convert lat/lng + zoom to tile coordinates */
function lngLatToTile(lng: number, lat: number, zoom: number) {
  const n = Math.pow(2, zoom);
  const x = Math.floor(((lng + 180) / 360) * n);
  const latRad = (lat * Math.PI) / 180;
  const y = Math.floor(
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) *
      n,
  );
  return { x, y, z: zoom };
}

/** Decode Mapbox Terrain-RGB: elevation = -10000 + (R*256*256 + G*256 + B) * 0.1 */
function decodeElevation(r: number, g: number, b: number): number {
  return -10000 + (r * 256 * 256 + g * 256 + b) * 0.1;
}

/** Load an image as ImageData via offscreen canvas */
async function fetchImageData(
  url: string,
  size: number,
): Promise<ImageData> {
  const img = new Image();
  img.crossOrigin = "anonymous";
  await new Promise<void>((res, rej) => {
    img.onload = () => res();
    img.onerror = () => rej(new Error(`Failed to load: ${url}`));
    img.src = url;
  });

  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(img, 0, 0, size, size);
  return ctx.getImageData(0, 0, size, size);
}

/** Load a texture from a URL */
function loadTexture(url: string): Promise<THREE.Texture> {
  return new Promise((res, rej) => {
    new THREE.TextureLoader().load(url, res, undefined, rej);
  });
}

/**
 * Fetch Mapbox Terrain-RGB + satellite tile, build a displaced PlaneGeometry.
 * No dependency on three-geo — just Three.js + Mapbox tile APIs.
 */
export async function loadTerrain(params: TerrainParams): Promise<THREE.Group> {
  const { lat, lng, radius = 5, zoom = 13 } = params;
  const token = import.meta.env.VITE_MAPBOX_TOKEN;

  if (!token) {
    throw new Error("VITE_MAPBOX_TOKEN is not set in frontend/.env");
  }

  const center = lngLatToTile(lng, lat, zoom);
  const tileRange = Math.ceil(radius / 5); // ~1 tile per 5km at zoom 13
  const group = new THREE.Group();
  group.name = "terrain";

  const segments = 64; // vertex resolution per tile

  for (let dx = -tileRange; dx <= tileRange; dx++) {
    for (let dy = -tileRange; dy <= tileRange; dy++) {
      const tx = center.x + dx;
      const ty = center.y + dy;

      const demUrl = `https://api.mapbox.com/v4/mapbox.terrain-rgb/${zoom}/${tx}/${ty}@2x.pngraw?access_token=${token}`;
      const satUrl = `https://api.mapbox.com/v4/mapbox.satellite/${zoom}/${tx}/${ty}@2x.png?access_token=${token}`;

      const [demData, satTexture] = await Promise.all([
        fetchImageData(demUrl, segments),
        loadTexture(satUrl),
      ]);

      // Build displaced plane
      const geo = new THREE.PlaneGeometry(100, 100, segments - 1, segments - 1);
      const positions = geo.attributes.position;

      // Find elevation range for this tile to scale nicely
      let minElev = Infinity;
      let maxElev = -Infinity;
      const elevations: number[] = [];

      for (let i = 0; i < segments * segments; i++) {
        const px = i * 4;
        const elev = decodeElevation(
          demData.data[px],
          demData.data[px + 1],
          demData.data[px + 2],
        );
        elevations.push(elev);
        minElev = Math.min(minElev, elev);
        maxElev = Math.max(maxElev, elev);
      }

      // Exaggeration factor so terrain is visible
      const elevRange = maxElev - minElev;
      const scale = elevRange > 0 ? 30 / elevRange : 1;

      for (let i = 0; i < positions.count; i++) {
        // PlaneGeometry vertices are in row-major order
        const row = Math.floor(i / segments);
        const col = i % segments;
        const elevIdx = row * segments + col;
        positions.setZ(i, (elevations[elevIdx] - minElev) * scale);
      }

      geo.computeVertexNormals();

      const mat = new THREE.MeshLambertMaterial({ map: satTexture });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.rotation.x = -Math.PI / 2; // PlaneGeometry is XY, we want XZ
      mesh.position.set(dx * 100, 0, dy * 100);
      group.add(mesh);
    }
  }

  return group;
}
