/** Server-side: SQLite cache for all GeoJSON layer data. */

import { Database } from "bun:sqlite";
import type { LayerData } from "./tiles.ts";

const db = new Database("buildings.db", { create: true });

db.run(`
  CREATE TABLE IF NOT EXISTS cache (
    key TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    fetched_at INTEGER NOT NULL
  )
`);

// Migrate: drop old schema if it has `geojson` column instead of `data`
try {
  const info = db.query<{ name: string }, []>("PRAGMA table_info(cache)").all();
  if (info.some((col) => col.name === "geojson")) {
    db.run("DROP TABLE cache");
    db.run(`
      CREATE TABLE cache (
        key TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        fetched_at INTEGER NOT NULL
      )
    `);
  }
} catch {
  // ignore
}

const TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/** Round to 4 decimal places (~11m precision) to improve cache hit rate. */
function cacheKey(lat: number, lon: number, size = 500): string {
  return `${lat.toFixed(4)},${lon.toFixed(4)},${size}`;
}

export function getCached(lat: number, lon: number, size = 500): LayerData | null {
  const key = cacheKey(lat, lon, size);
  const row = db
    .query<{ data: string; fetched_at: number }, [string]>(
      "SELECT data, fetched_at FROM cache WHERE key = ?",
    )
    .get(key);

  if (!row) return null;
  if (Date.now() - row.fetched_at > TTL_MS) {
    db.run("DELETE FROM cache WHERE key = ?", [key]);
    return null;
  }
  return JSON.parse(row.data) as LayerData;
}

export function setCache(lat: number, lon: number, layers: LayerData, size = 500): void {
  const key = cacheKey(lat, lon, size);
  db.run("INSERT OR REPLACE INTO cache (key, data, fetched_at) VALUES (?, ?, ?)", [
    key,
    JSON.stringify(layers),
    Date.now(),
  ]);
}
