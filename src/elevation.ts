/** Server-side: query OpenTopoData for a grid of elevation points, return as GeoJSON. */

import type { FeatureCollection } from "./tiles.ts";

const OPENTOPODATA_URL = "https://api.opentopodata.org/v1/ned10m";
const GRID_SIZE = 10; // 10x10 grid (~50m resolution over 500m)
const MAX_PER_REQUEST = 100; // OpenTopoData limit

export interface ElevationGrid {
  geojson: FeatureCollection;
  gridSize: number;
  south: number;
  north: number;
  west: number;
  east: number;
  /** Row-major [row][col] elevation values in meters. */
  values: number[][];
}

interface OpenTopoResult {
  elevation: number | null;
  location: { lat: number; lng: number };
}

interface OpenTopoResponse {
  status: string;
  results: OpenTopoResult[];
}

/**
 * Fetch a 10x10 elevation grid covering the bounding box.
 * Uses OpenTopoData batch API — entire grid in 1 request.
 */
export async function fetchElevationGrid(
  south: number,
  west: number,
  north: number,
  east: number,
): Promise<ElevationGrid> {
  const latStep = (north - south) / (GRID_SIZE - 1);
  const lonStep = (east - west) / (GRID_SIZE - 1);

  // Build all query points
  const queries: { row: number; col: number; lat: number; lon: number }[] = [];
  for (let row = 0; row < GRID_SIZE; row++) {
    for (let col = 0; col < GRID_SIZE; col++) {
      queries.push({
        row,
        col,
        lat: south + row * latStep,
        lon: west + col * lonStep,
      });
    }
  }

  // Build pipe-separated locations string and fetch in batches of 100
  const values: number[][] = Array.from({ length: GRID_SIZE }, () =>
    new Array(GRID_SIZE).fill(0),
  );
  const features: FeatureCollection["features"] = [];

  for (let i = 0; i < queries.length; i += MAX_PER_REQUEST) {
    const batch = queries.slice(i, i + MAX_PER_REQUEST);
    const locations = batch.map((q) => `${q.lat},${q.lon}`).join("|");
    const url = `${OPENTOPODATA_URL}?locations=${locations}`;

    const res = await fetch(url);
    if (!res.ok) {
      console.error(`OpenTopoData error: ${res.status} ${await res.text()}`);
      continue;
    }

    const data = (await res.json()) as OpenTopoResponse;
    if (data.status !== "OK") {
      console.error(`OpenTopoData status: ${data.status}`);
      continue;
    }

    for (let j = 0; j < data.results.length; j++) {
      const q = batch[j]!;
      const r = data.results[j]!;
      const elev = r.elevation ?? 0;

      values[q.row]![q.col] = elev;

      features.push({
        type: "Feature",
        properties: {
          elevation: elev,
          row: q.row,
          col: q.col,
        },
        geometry: {
          type: "Point",
          coordinates: [q.lon, q.lat],
        },
      } as unknown as FeatureCollection["features"][number]);
    }
  }

  return {
    geojson: { type: "FeatureCollection", features },
    gridSize: GRID_SIZE,
    south,
    north,
    west,
    east,
    values,
  };
}
