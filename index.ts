import { join } from "path";
import { getCached, setCache } from "./src/cache.ts";
import { fetchFromOverpass } from "./src/overpass.ts";
import { fetchElevationGrid } from "./src/elevation.ts";
import type { LayerData } from "./src/tiles.ts";

// Bundle the frontend TS for the browser
const buildResult = await Bun.build({
  entrypoints: ["./src/main.ts"],
  outdir: "./dist",
  minify: false,
  sourcemap: "inline",
  target: "browser",
});

if (!buildResult.success) {
  console.error("Build failed:");
  for (const log of buildResult.logs) console.error(log);
  process.exit(1);
}

const distDir = join(import.meta.dir, "dist");
const htmlFile = Bun.file(join(import.meta.dir, "index.html"));

/** Convert lat/lon + 250m offset to a bounding box. */
function bbox(lat: number, lon: number) {
  const latRad = (lat * Math.PI) / 180;
  const mPerDegLon = (Math.PI / 180) * 6378137 * Math.cos(latRad);
  const mPerDegLat = (Math.PI / 180) * 6378137;
  const dLon = 250 / mPerDegLon;
  const dLat = 250 / mPerDegLat;
  return {
    south: lat - dLat,
    north: lat + dLat,
    west: lon - dLon,
    east: lon + dLon,
  };
}

Bun.serve({
  port: 3000,
  idleTimeout: 120, // seconds — elevation queries can take a while
  async fetch(req) {
    const url = new URL(req.url);

    // --- API: all layers endpoint ---
    if (url.pathname === "/api/data") {
      const lat = parseFloat(url.searchParams.get("lat") ?? "");
      const lon = parseFloat(url.searchParams.get("lon") ?? "");
      if (isNaN(lat) || isNaN(lon)) {
        return new Response("Missing or invalid lat/lon", { status: 400 });
      }

      // Check cache
      const cached = getCached(lat, lon);
      if (cached) {
        console.log(`Cache hit for (${lat.toFixed(4)}, ${lon.toFixed(4)})`);
        return Response.json(cached);
      }

      // Fetch Overpass + Elevation in parallel
      console.log(`Cache miss — fetching Overpass + USGS elevation for (${lat.toFixed(4)}, ${lon.toFixed(4)})`);
      try {
        const { south, west, north, east } = bbox(lat, lon);

        const [overpassLayers, elevation] = await Promise.all([
          fetchFromOverpass(south, west, north, east),
          fetchElevationGrid(south, west, north, east),
        ]);

        const layers: LayerData = {
          ...overpassLayers,
          elevation,
        };

        setCache(lat, lon, layers);

        const counts = Object.entries(overpassLayers)
          .map(([k, v]) => `${k}: ${v.features.length}`)
          .join(", ");
        console.log(`  → ${counts}, elevation: ${elevation.gridSize}x${elevation.gridSize} grid`);
        return Response.json(layers);
      } catch (err) {
        console.error("Fetch failed:", err);
        return new Response(`Fetch error: ${err}`, { status: 502 });
      }
    }

    // --- Static: HTML ---
    if (url.pathname === "/" || url.pathname === "/index.html") {
      const html = (await htmlFile.text()).replace("./src/main.ts", "/dist/main.js");
      return new Response(html, { headers: { "Content-Type": "text/html" } });
    }

    // --- Static: bundled JS ---
    if (url.pathname.startsWith("/dist/")) {
      const file = Bun.file(join(distDir, url.pathname.slice(6)));
      if (await file.exists()) return new Response(file);
    }

    return new Response("Not found", { status: 404 });
  },
});

console.log("OpenDisaster running at http://localhost:3000");
