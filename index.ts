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

const DANGER_PROMPTS: Record<string, string> = {
  fire: "Look out for fire related danger. If you see any signs of fire, smoke, etc. add DANGER at the very end of your response.",
  tornado: "Look out for tornado related danger. If you see any signs of a funnel cloud, flying debris, strong winds, or structural damage add DANGER at the very end of your response.",
  earthquake: "Look out for earthquake related danger. If you see any signs of shaking, cracking ground, collapsing structures, or falling debris add DANGER at the very end of your response.",
  flood: "Look out for flood related danger. If you see any signs of rising water, submerged roads, or fast-moving currents add DANGER at the very end of your response.",
};

async function callVLM(frameBase64: string, apiKey: string, disasterType: string = "fire"): Promise<string> {
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
              text: `You are watching the world through someone's POV in a 3D low-polygon simulation. It is normal for it to look simplistic and blocky, so don't comment on that that. Humans are also rendered in a low-polygon, colorful style, so don't comment on that either. Describe what you see in 1-2 sentences. ${DANGER_PROMPTS[disasterType] ?? DANGER_PROMPTS["fire"]} Err on the side of caution.`,
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
  return /\bDANGER[\s*_\]\)!."]*$/i.test(observation.trim());
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

async function processPayloads(payloads: any[], step: number, disasterType: string = "fire"): Promise<any[]> {
  if (FEATHERLESS_API_KEYS.length === 0) {
    // No API keys — return WANDER for all agents
    return payloads.map((payload: any) => ({
      agentIndex: payload.agentIndex,
      observation: "No VLM configured.",
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
        const obs = await callVLM(p.frameBase64, apiKey, disasterType);
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
    const cleanObs = observation.replace(/[\s*_\]\)!."]*\bDANGER[\s*_\]\)!."]*$/i, "").trim();

    if (danger) {
      logEntry("danger_detected", payload.name, {
        step,
        observation: cleanObs,
        positionX: payload.state.positionX,
        positionZ: payload.state.positionZ,
      });

      return {
        agentIndex: payload.agentIndex,
        observation: cleanObs + " [DANGER]",
        action: "RUN_TO",
        targetX: 0,
        targetZ: 0,
        targetEntity: 0,
      };
    }

    return {
      agentIndex: payload.agentIndex,
      observation: cleanObs,
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
          const decisions = await processPayloads(msg.payloads, msg.step, msg.disasterType ?? "fire");
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

    // --- API: generate audio narration for replay ---
    if (url.pathname === "/api/generate-audio" && req.method === "POST") {
      const elevenlabsKey = process.env.ELEVENLABS_API_KEY ?? "";
      if (!elevenlabsKey) {
        return Response.json({ error: "ELEVENLABS_API_KEY not set" }, { status: 500 });
      }
      if (FEATHERLESS_API_KEYS.length === 0) {
        return Response.json({ error: "FEATHERLESS_API_KEY not set" }, { status: 500 });
      }

      try {
        const body = await req.json() as {
          agentName: string;
          vlmEntries: { simTime: number; observation: string; action: string }[];
        };

        const { agentName, vlmEntries } = body;
        if (!agentName || !vlmEntries?.length) {
          return Response.json({ error: "Missing agentName or vlmEntries" }, { status: 400 });
        }

        const clips: { simTime: number; dialogue: string; audioBase64: string }[] = [];
        const apiKey = FEATHERLESS_API_KEYS[0]!;

        // Pick voice based on agent name gender
        const femaleNames = new Set(["alice", "carol", "eve", "grace", "dorothy", "emily", "lily", "sarah"]);
        // Animated/energetic voices — respond better to emotional audio tags
        const femaleVoices = [
          "FGY2WhTYpPnrIDTdsKH5", // Laura - Quirky, Sassy
          "cgSgspJ2msm6clMCkdW9", // Jessica - Playful, Bright
          "pFZP5JQG7iQjIQuC4Bku", // Lily - Velvety Actress
          "Xb7hH8MSUJpSbSDYk0k2", // Alice - Clear, Engaging
        ];
        const maleVoices = [
          "SOYHLrjzK2X1ezoPC6cr", // Harry - Fierce Warrior, Rough
          "IKne3meq5aSn9XLyUdCD", // Charlie - Energetic, Hyped
          "N2lVS1w4EtoT3dr4eOWO", // Callum - Husky Trickster
          "TX3LPaxmHKxFdv7VOQHJ", // Liam - Energetic
        ];
        const isFemale = femaleNames.has(agentName.toLowerCase());
        const voicePool = isFemale ? femaleVoices : maleVoices;
        // Simple hash of agent name to pick a consistent voice
        const nameHash = agentName.split("").reduce((acc, c) => acc + c.charCodeAt(0), 0);
        const voiceId = voicePool[nameHash % voicePool.length]!;

        console.log(`[Audio] Starting generation for "${agentName}" (${isFemale ? "female" : "male"}, voice: ${voiceId}) with ${vlmEntries.length} entries`);

        const dialogueHistory: string[] = []; // track previous lines for context

        for (const entry of vlmEntries) {
          console.log(`[Audio] Processing entry at ${entry.simTime.toFixed(1)}s — obs: "${entry.observation.slice(0, 60)}..." action: ${entry.action}`);

          // Build conversation history (last 3 lines for context)
          const recentHistory = dialogueHistory.slice(-3);
          const historyBlock = recentHistory.length > 0
            ? `\n\nYour last ${recentHistory.length} spoken line(s):\n${recentHistory.map((d, i) => `${i + 1}. ${d}`).join("\n")}\n\nDon't repeat yourself. React to what's NEW.`
            : "";

          // 1. Generate dialogue via Featherless AI (text-only)
          // Check if this observation was flagged as DANGER by the VLM
          const entryIsDanger = /\[DANGER\]\s*$/.test(entry.observation);
          const systemPrompt = entryIsDanger
            ? `You are ${agentName}, a real person in a life-threatening disaster. You are terrified. Your voice shakes. You stutter, gasp, and yell. Write ONLY the raw dialogue — one short sentence. No quotes, no actions, no narration. Use filler words, stuttering, exclamation marks, and ALL CAPS for shouted words. Examples of good output:\n- Oh god oh god THE FIRE is right there!\n- I c-can't breathe, the smoke is everywhere!\n- RUN! Everyone get OUT!\n- W-what is happening, is that... is that fire?!`
            : `You are ${agentName}, a person going about their day. Write ONLY the raw dialogue — one short sentence. No quotes, no actions, no narration. Be calm and natural. Examples of good output:\n- Huh, what's going on over there?\n- Looks like a nice day, I should keep walking.\n- I wonder what that crowd is about.\n- Everything seems fine so far.`;
          const userPrompt = entryIsDanger
            ? `You just saw: "${entry.observation}"\nYou decided to: ${entry.action}${historyBlock}\n\nWhat do you scream or say? (One raw sentence, terrified)`
            : `You just saw: "${entry.observation}"\nYou decided to: ${entry.action}${historyBlock}\n\nWhat do you say? (One short casual sentence)`;

          console.log(`[Audio] → Calling Featherless LLM (danger=${entryIsDanger}, history: ${recentHistory.length} lines)...`);
          const llmRes = await fetch("https://api.featherless.ai/v1/chat/completions", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
              model: "google/gemma-3-27b-it",
              max_tokens: 256,
              messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: userPrompt },
              ],
            }),
          });

          if (!llmRes.ok) {
            const errText = await llmRes.text();
            console.error(`[Audio] ✗ LLM error ${llmRes.status} for ${agentName}:`, errText);
            continue;
          }

          const llmJson = (await llmRes.json()) as any;
          console.log(`[Audio] Raw LLM response:`, JSON.stringify(llmJson, null, 2));
          const dialogue: string = llmJson.choices?.[0]?.message?.content?.trim() ?? "";
          if (!dialogue) {
            console.warn(`[Audio] ✗ LLM returned empty dialogue for ${agentName} at ${entry.simTime.toFixed(1)}s`);
            continue;
          }
          console.log(`[Audio] ✓ LLM dialogue: "${dialogue}"`);
          dialogueHistory.push(dialogue);

          // 2. Convert to speech via ElevenLabs TTS
          // Use scared voice only when VLM flagged DANGER (stored as " [DANGER]" at end of observation)
          const isDanger = /\[DANGER\]\s*$/.test(entry.observation);
          const ttsText = isDanger
            ? `[SCARED] [breathing heavily] ${dialogue} [exhales]`
            : dialogue;
          const voiceSettings = isDanger
            ? { stability: 0.0, similarity_boost: 0.8, style: 0.7, use_speaker_boost: true }
            : { stability: 0.5, similarity_boost: 0.8, style: 0.3, use_speaker_boost: true };
          console.log(`[Audio] → Calling ElevenLabs TTS (voice ${voiceId}, danger=${isDanger}), text: "${ttsText}"`);
          const ttsRes = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "xi-api-key": elevenlabsKey,
            },
            body: JSON.stringify({
              text: ttsText,
              model_id: "eleven_v3",
              voice_settings: voiceSettings,
            }),
          });

          if (!ttsRes.ok) {
            const errText = await ttsRes.text();
            console.error(`[Audio] ✗ TTS error ${ttsRes.status} for ${agentName}:`, errText);
            continue;
          }

          const audioBuffer = await ttsRes.arrayBuffer();
          const audioBase64 = Buffer.from(audioBuffer).toString("base64");
          console.log(`[Audio] ✓ TTS returned ${audioBuffer.byteLength} bytes (base64: ${audioBase64.length} chars)`);

          clips.push({ simTime: entry.simTime, dialogue, audioBase64 });
        }

        console.log(`[Audio] Done — returning ${clips.length} clips for "${agentName}"`);
        for (const c of clips) {
          console.log(`[Audio]   clip @ ${c.simTime.toFixed(1)}s: "${c.dialogue.slice(0, 50)}..." (${c.audioBase64.length} b64 chars)`);
        }

        return Response.json({ clips });
      } catch (err) {
        console.error("[Audio] Error:", err);
        return Response.json({ error: String(err) }, { status: 500 });
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
