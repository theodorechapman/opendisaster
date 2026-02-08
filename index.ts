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

/** Convert lat/lon + half-size offset to a bounding box. */
function bbox(lat: number, lon: number, halfSize: number) {
  const latRad = (lat * Math.PI) / 180;
  const mPerDegLon = (Math.PI / 180) * 6378137 * Math.cos(latRad);
  const mPerDegLat = (Math.PI / 180) * 6378137;
  const dLon = halfSize / mPerDegLon;
  const dLat = halfSize / mPerDegLat;
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
      const size = Math.max(100, Math.min(2000, parseInt(url.searchParams.get("size") ?? "500") || 500));
      if (isNaN(lat) || isNaN(lon)) {
        return new Response("Missing or invalid lat/lon", { status: 400 });
      }

      // Check cache (include size in key)
      const cached = getCached(lat, lon, size);
      if (cached) {
        console.log(`Cache hit for (${lat.toFixed(4)}, ${lon.toFixed(4)})`);
        return Response.json(cached);
      }

      // Fetch Overpass + Elevation in parallel
      console.log(`Cache miss — fetching Overpass + USGS elevation for (${lat.toFixed(4)}, ${lon.toFixed(4)})`);
      try {
        const { south, west, north, east } = bbox(lat, lon, size / 2);

        const [overpassLayers, elevation] = await Promise.all([
          fetchFromOverpass(south, west, north, east),
          fetchElevationGrid(south, west, north, east),
        ]);

        const layers: LayerData = {
          ...overpassLayers,
          elevation,
        };

        setCache(lat, lon, layers, size);

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

    // --- API: geocode address or Google Maps URL ---
    if (url.pathname === "/api/geocode") {
      const q = url.searchParams.get("q")?.trim();
      if (!q) return new Response("Missing ?q=", { status: 400 });

      // If it looks like a URL, try to extract coords from it
      let resolvedQ = q;
      if (/^https?:\/\//i.test(q)) {
        // Follow redirects for short URLs (maps.app.goo.gl, goo.gl/maps, etc.)
        if (/goo\.gl/i.test(q)) {
          try {
            const res = await fetch(q, { redirect: "follow" });
            resolvedQ = res.url;
          } catch {
            // fall through to Nominatim
          }
        }

        const mapsCoords =
          resolvedQ.match(/@(-?\d+\.?\d*),(-?\d+\.?\d*)/) ??
          resolvedQ.match(/[?&]q=(-?\d+\.?\d*),(-?\d+\.?\d*)/) ??
          resolvedQ.match(/[?&]ll=(-?\d+\.?\d*),(-?\d+\.?\d*)/);

        if (mapsCoords) {
          const lat = parseFloat(mapsCoords[1]);
          const lon = parseFloat(mapsCoords[2]);
          if (!isNaN(lat) && !isNaN(lon)) {
            return Response.json({ lat, lon });
          }
        }
      }

      // Fall back to Nominatim geocoding
      try {
        const nominatimUrl = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`;
        const res = await fetch(nominatimUrl, {
          headers: { "User-Agent": "OpenDisaster/1.0" },
        });
        const results = (await res.json()) as Array<{ lat: string; lon: string; display_name: string }>;
        if (!results.length) {
          return Response.json({ error: "Address not found" }, { status: 404 });
        }
        return Response.json({
          lat: parseFloat(results[0].lat),
          lon: parseFloat(results[0].lon),
          name: results[0].display_name,
        });
      } catch (err) {
        console.error("Geocode failed:", err);
        return new Response("Geocode error", { status: 502 });
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
