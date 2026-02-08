/** Frontend: fetch GeoJSON layers from our server endpoint. */

export function metersPerDegree(lat: number) {
  const latRad = (lat * Math.PI) / 180;
  return {
    lon: (Math.PI / 180) * 6378137 * Math.cos(latRad),
    lat: (Math.PI / 180) * 6378137,
  };
}

export interface BuildingFeature {
  type: "Feature";
  properties: Record<string, unknown>;
  geometry: {
    type: string;
    coordinates: unknown;
  };
}

export interface FeatureCollection {
  type: "FeatureCollection";
  features: BuildingFeature[];
}

export interface ElevationData {
  geojson: FeatureCollection;
  gridSize: number;
  south: number;
  north: number;
  west: number;
  east: number;
  values: number[][];
}

export interface LayerData {
  buildings: FeatureCollection;
  roads: FeatureCollection;
  parks: FeatureCollection;
  water: FeatureCollection;
  trees: FeatureCollection;
  railways: FeatureCollection;
  barriers: FeatureCollection;
  elevation: ElevationData;
}

/**
 * Fetch all GeoJSON layers for a box centered on (lat, lon).
 * @param size — side length in meters (default 500)
 */
export async function fetchLayers(lat: number, lon: number, size = 500): Promise<LayerData> {
  const res = await fetch(`/api/data?lat=${lat}&lon=${lon}&size=${size}`);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Server error ${res.status}: ${text}`);
  }
  return res.json() as Promise<LayerData>;
}

export interface SatelliteResult {
  blobUrl: string;
  zoom: number;
  tilesPerAxis: number;
}

/**
 * Fetch satellite imagery for the given area.
 * Computes optimal zoom, then fetches a grid of tiles to fully cover the terrain.
 * Stitches them onto a canvas and returns as a blob URL.
 */
export async function fetchSatelliteImage(lat: number, lon: number, size: number): Promise<SatelliteResult | null> {
  try {
    const latRad = lat * Math.PI / 180;
    const cosLat = Math.cos(latRad);

    // Pick zoom for best resolution match
    // scale=2 doubles pixel count but NOT geographic coverage — coverage = 640 * mpp
    const metersPerPixelNeeded = size / 640;
    const zoom = Math.min(21, Math.max(1, Math.round(
      Math.log2(156543.03392 * cosLat / metersPerPixelNeeded)
    )));

    const metersPerPixel = 156543.03392 * cosLat / Math.pow(2, zoom);
    const tileMeters = 640 * metersPerPixel;
    const tilesPerAxis = Math.max(1, Math.ceil(size / tileMeters));

    const mPerDegLat = (Math.PI / 180) * 6378137;
    const mPerDegLon = (Math.PI / 180) * 6378137 * cosLat;

    // Fetch all tiles in parallel
    const fetches: Promise<{ img: HTMLImageElement; col: number; row: number }>[] = [];
    for (let row = 0; row < tilesPerAxis; row++) {
      for (let col = 0; col < tilesPerAxis; col++) {
        const offsetX = (col - (tilesPerAxis - 1) / 2) * tileMeters;
        const offsetZ = (row - (tilesPerAxis - 1) / 2) * tileMeters;
        // offsetZ positive = row increases downward = south in geo coords
        const tileLat = lat - offsetZ / mPerDegLat;
        const tileLon = lon + offsetX / mPerDegLon;

        const p = fetch(`/api/satellite?lat=${tileLat}&lon=${tileLon}&zoom=${zoom}`)
          .then(res => {
            if (!res.ok) throw new Error(`tile fetch failed: ${res.status}`);
            return res.blob();
          })
          .then(blob => new Promise<{ img: HTMLImageElement; col: number; row: number }>((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve({ img, col, row });
            img.onerror = reject;
            img.src = URL.createObjectURL(blob);
          }));
        fetches.push(p);
      }
    }

    const tiles = await Promise.all(fetches);

    // Stitch tiles onto a single canvas
    const pxPerTile = 1280;
    const canvasSize = tilesPerAxis * pxPerTile;
    const canvas = document.createElement("canvas");
    canvas.width = canvasSize;
    canvas.height = canvasSize;
    const ctx = canvas.getContext("2d")!;

    for (const { img, col, row } of tiles) {
      ctx.drawImage(img, col * pxPerTile, row * pxPerTile, pxPerTile, pxPerTile);
      URL.revokeObjectURL(img.src);
    }

    const stitchedBlob = await new Promise<Blob>((resolve) => {
      canvas.toBlob(blob => resolve(blob!), "image/png");
    });

    return {
      blobUrl: URL.createObjectURL(stitchedBlob),
      zoom,
      tilesPerAxis,
    };
  } catch (err) {
    console.warn("[Satellite] Fetch failed:", err);
    return null;
  }
}
