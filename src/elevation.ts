/** Server-side: query OpenTopoData for a grid of elevation points, return as GeoJSON. */

import type { FeatureCollection } from "./tiles.ts";

const OPENTOPODATA_URL = "https://api.opentopodata.org/v1/ned10m";
const MAX_PER_REQUEST = 100; // OpenTopoData limit
const REQUEST_INTERVAL_MS = 1100; // Public API limit is 1 request/second

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
  const gridSize = chooseGridSize(south, west, north, east);
  const latStep = (north - south) / (gridSize - 1);
  const lonStep = (east - west) / (gridSize - 1);

  // Build all query points
  const queries: { row: number; col: number; lat: number; lon: number }[] = [];
  for (let row = 0; row < gridSize; row++) {
    for (let col = 0; col < gridSize; col++) {
      queries.push({
        row,
        col,
        lat: south + row * latStep,
        lon: west + col * lonStep,
      });
    }
  }

  // Build pipe-separated locations string and fetch in batches of 100
  const values: number[][] = Array.from({ length: gridSize }, () =>
    new Array(gridSize).fill(0),
  );
  const features: FeatureCollection["features"] = [];
  let lastRequestAt = 0;

  for (let i = 0; i < queries.length; i += MAX_PER_REQUEST) {
    const now = Date.now();
    const waitMs = lastRequestAt + REQUEST_INTERVAL_MS - now;
    if (waitMs > 0) {
      await Bun.sleep(waitMs);
    }

    const batch = queries.slice(i, i + MAX_PER_REQUEST);
    const locations = batch.map((q) => `${q.lat},${q.lon}`).join("|");
    const url = `${OPENTOPODATA_URL}?locations=${locations}`;

    const res = await fetch(url);
    lastRequestAt = Date.now();
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
    gridSize,
    south,
    north,
    west,
    east,
    values,
  };
}

function chooseGridSize(south: number, west: number, north: number, east: number): number {
  const latMid = (south + north) * 0.5;
  const latRad = (latMid * Math.PI) / 180;
  const mPerDegLon = (Math.PI / 180) * 6378137 * Math.cos(latRad);
  const mPerDegLat = (Math.PI / 180) * 6378137;
  const widthMeters = Math.abs(east - west) * mPerDegLon;
  const heightMeters = Math.abs(north - south) * mPerDegLat;
  const longestSide = Math.max(widthMeters, heightMeters);

  // Aim for ~25m sampling while keeping OpenTopoData request volume reasonable.
  const targetSpacingMeters = 25;
  const gridSize = Math.round(longestSide / targetSpacingMeters) + 1;
  return Math.max(12, Math.min(24, gridSize));
}
