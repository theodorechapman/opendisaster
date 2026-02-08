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
 * Fetch all GeoJSON layers for a 500m x 500m box centered on (lat, lon).
 */
export async function fetchLayers(lat: number, lon: number): Promise<LayerData> {
  const res = await fetch(`/api/data?lat=${lat}&lon=${lon}`);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Server error ${res.status}: ${text}`);
  }
  return res.json() as Promise<LayerData>;
}
