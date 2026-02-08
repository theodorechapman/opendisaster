import { join } from "path";
import { appendFileSync, writeFileSync } from "fs";
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

// Bundle the replay viewer
const replayBuild = await Bun.build({
  entrypoints: ["./src/replay/viewer.ts"],
  outdir: "./dist",
  minify: false,
  sourcemap: "inline",
  target: "browser",
});

if (!replayBuild.success) {
  console.error("Replay build failed:");
  for (const log of replayBuild.logs) console.error(log);
  process.exit(1);
}

const distDir = join(import.meta.dir, "dist");
const htmlFile = Bun.file(join(import.meta.dir, "index.html"));
const assetsDir = join(import.meta.dir, "assets");

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

/* ── JSONL file logger ───────────────────────────────────────────── */
const LOG_FILE = "./agent-log.jsonl";
writeFileSync(LOG_FILE, "");

function logEntry(event: string, agent: string, data: Record<string, any>): void {
  const entry = { ts: Date.now(), src: "server", event, agent, data };
  appendFileSync(LOG_FILE, JSON.stringify(entry) + "\n");
}

function logClientEntry(entry: { ts: number; event: string; agent: string; data: Record<string, any> }): void {
  appendFileSync(LOG_FILE, JSON.stringify({ ...entry, src: "client" }) + "\n");
}

/* ── VLM API helpers ─────────────────────────────────────────────── */

const FEATHERLESS_API_KEYS = [
  process.env.FEATHERLESS_API_KEY ?? "",
  process.env.FEATHERLESS_API_KEY_2 ?? "",
  process.env.FEATHERLESS_API_KEY_3 ?? "",
  process.env.FEATHERLESS_API_KEY_4 ?? "",
].filter(Boolean);

if (FEATHERLESS_API_KEYS.length === 0) console.warn("[Server] No FEATHERLESS_API_KEY set in .env — agents will auto-wander only");

async function callVLM(frameBase64: string, apiKey: string): Promise<string> {
  const res = await fetch("https://api.featherless.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "google/gemma-3-27b-it",
      max_tokens: 120,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: { url: `data:image/jpeg;base64,${frameBase64}` },
            },
            {
              type: "text",
              text: "You are watching the world through someone's POV in a 3D simulation. It is normal for it to look simplistic and blocky, so don't be scared by that. Describe what you see in 1-2 sentences. If anything looks dangerous or out of the ordinary, add DANGER at the end of your response. Danger could be any sign of fire, smoke, flooding, earthquake, flood, etc. Err on the side of caution.",
            },
          ],
        },
      ],
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`VLM error ${res.status}: ${text}`);
  }

  const json = (await res.json()) as any;
  return json.choices?.[0]?.message?.content ?? "I cannot see clearly.";
}

function hasDanger(observation: string): boolean {
  return /\bDANGER\s*$/i.test(observation.trim());
}

async function pooled<T>(tasks: (() => Promise<T>)[], concurrency: number): Promise<T[]> {
  const results = new Array<T>(tasks.length);
  let next = 0;

  async function worker() {
    while (next < tasks.length) {
      const idx = next++;
      results[idx] = await tasks[idx]!();
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker()));
  return results;
}

async function processPayloads(payloads: any[], step: number): Promise<any[]> {
  if (FEATHERLESS_API_KEYS.length === 0) {
    // No API keys — return WANDER for all agents
    return payloads.map((payload: any) => ({
      agentIndex: payload.agentIndex,
      observation: "No VLM configured.",
      reasoning: "",
      action: "WANDER",
      targetX: 0,
      targetZ: 0,
      targetEntity: 0,
    }));
  }

  const numKeys = FEATHERLESS_API_KEYS.length;
  const perKeyTasks: (() => Promise<{ idx: number; obs: string }>)[][] = Array.from(
    { length: numKeys },
    () => [],
  );
  payloads.forEach((p: any, i: number) => {
    const keyIdx = i % numKeys;
    const apiKey = FEATHERLESS_API_KEYS[keyIdx]!;
    perKeyTasks[keyIdx]!.push(async () => {
      try {
        const obs = await callVLM(p.frameBase64, apiKey);
        logEntry("vlm_observation", p.name, {
          step,
          observation: obs,
          positionX: p.state.positionX,
          positionZ: p.state.positionZ,
          facingYaw: p.state.facingYaw,
        });
        return { idx: i, obs };
      } catch (err) {
        logEntry("vlm_error", p.name, { step, error: String(err) });
        console.error(`[VLM] ${p.name} error:`, err);
        return { idx: i, obs: "Vision system error." };
      }
    });
  });

  const allResults = await Promise.all(
    perKeyTasks.map((tasks) => pooled(tasks, 2)),
  );
  const observations = new Array<string>(payloads.length);
  for (const batch of allResults) {
    for (const r of batch) {
      observations[r.idx] = r.obs;
    }
  }

  return payloads.map((payload: any, idx: number) => {
    const observation = observations[idx]!;
    const danger = hasDanger(observation);
    const cleanObs = observation.replace(/\s*DANGER\s*$/i, "").trim();

    if (danger) {
      const s = payload.state;
      const yaw = s.facingYaw ?? 0;
      const fleeDistance = 60;
      const targetX = s.positionX + Math.sin(yaw + Math.PI) * fleeDistance;
      const targetZ = s.positionZ + Math.cos(yaw + Math.PI) * fleeDistance;

      logEntry("danger_flee", payload.name, {
        step,
        observation: cleanObs,
        positionX: s.positionX,
        positionZ: s.positionZ,
        facingYaw: yaw,
        targetX,
        targetZ,
        fleeDistance,
      });

      return {
        agentIndex: payload.agentIndex,
        observation: cleanObs,
        reasoning: "DANGER detected — turning 180° and fleeing.",
        action: "RUN_TO",
        targetX,
        targetZ,
        targetEntity: 0,
      };
    }

    return {
      agentIndex: payload.agentIndex,
      observation: cleanObs,
      reasoning: "",
      action: "WANDER",
      targetX: 0,
      targetZ: 0,
      targetEntity: 0,
    };
  });
}

/* ── Server ──────────────────────────────────────────────────────── */

Bun.serve({
  port: 3000,
  idleTimeout: 120,
  websocket: {
    async message(ws, message) {
      try {
        const msg = JSON.parse(String(message));

        if (msg.type === "perceive") {
          console.log(`[Server] Step ${msg.step} — ${msg.payloads.length} agents`);
          const decisions = await processPayloads(msg.payloads, msg.step);
          ws.send(JSON.stringify({
            type: "decisions",
            step: msg.step,
            decisions,
          }));
        } else if (msg.type === "agent_log") {
          logClientEntry(msg.entry);
        }
      } catch (err) {
        console.error("[Server] WebSocket message error:", err);
        ws.send(JSON.stringify({ type: "error", message: String(err) }));
      }
    },
    open(ws) {
      console.log("[Server] WebSocket client connected");
    },
    close(ws) {
      console.log("[Server] WebSocket client disconnected");
    },
  },
  async fetch(req, server) {
    const url = new URL(req.url);

    // --- WebSocket upgrade ---
    if (url.pathname === "/ws") {
      if (server.upgrade(req)) return;
      return new Response("WebSocket upgrade failed", { status: 500 });
    }

    // --- API: all layers endpoint ---
    if (url.pathname === "/api/data") {
      const lat = parseFloat(url.searchParams.get("lat") ?? "");
      const lon = parseFloat(url.searchParams.get("lon") ?? "");
      const size = Math.max(100, Math.min(2000, parseInt(url.searchParams.get("size") ?? "500") || 500));
      if (isNaN(lat) || isNaN(lon)) {
        return new Response("Missing or invalid lat/lon", { status: 400 });
      }

      const cached = getCached(lat, lon, size);
      if (cached) {
        console.log(`Cache hit for (${lat.toFixed(4)}, ${lon.toFixed(4)})`);
        return Response.json(cached);
      }

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

      let resolvedQ = q;
      if (/^https?:\/\//i.test(q)) {
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

    // --- Static: Replay viewer ---
    if (url.pathname === "/replay") {
      const file = Bun.file(join(import.meta.dir, "public", "replay.html"));
      if (await file.exists()) {
        return new Response(file, { headers: { "Content-Type": "text/html" } });
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

    // --- Static: models and public assets ---
    if (url.pathname.startsWith("/models/")) {
      const decoded = decodeURIComponent(url.pathname);
      const file = Bun.file(join(import.meta.dir, "public", decoded));
      if (await file.exists()) return new Response(file);
    }

    // --- Static: assets (models, textures) ---
    if (url.pathname.startsWith("/assets/")) {
      const file = Bun.file(join(assetsDir, url.pathname.slice(8)));
      if (await file.exists()) return new Response(file);
    }

    return new Response("Not found", { status: 404 });
  },
});

console.log("[OpenDisaster] Server running at http://localhost:3000");
console.log(`[OpenDisaster] Agent logs → ${LOG_FILE}`);
if (FEATHERLESS_API_KEYS.length > 0) {
  console.log(`[OpenDisaster] VLM enabled with ${FEATHERLESS_API_KEYS.length} API key(s)`);
}
