Read @OVERVIEW.md for full project context.

## Vision

open_disaster is a platform where users type a natural language prompt like "Simulate an avalanche hitting Silverton, Colorado" and an AI agent swarm researches the location, fetches real terrain data, determines disaster physics, and populates a 3D simulation that runs in the browser. The full system will have multiple agents running in parallel (geocoding, terrain building, physics research, visual scouting), orchestrated via the Dedalus Labs Python SDK, feeding data into a structured SimulationWorld that handles Three.js rendering and Rapier.js physics. Agents never generate raw Three.js code — they populate the world through a standardized API.

**Don't build all of this. Build the backbone that everything plugs into.**

## Build Now

**Backend** (Python + FastAPI):
- `POST /api/simulate` takes `{ "prompt": "Avalanche at Silverton, Colorado" }`, extracts the location, geocodes it (Mapbox Geocoding API), and returns `{ location: { name, lat, lng }, disaster_type }`.
- Structure this as one "agent" inside an `agents/` folder, called by an `orchestrator.py`. Later, a prompt will fan out to many parallel agents via the Dedalus Labs Python SDK (`DedalusRunner`). Don't integrate Dedalus yet — just make the pattern clean enough that swapping it in is easy.

**Frontend** (Bun + TypeScript + Vite):
- Dark, minimal UI: text input + "Simulate" button at top, full-width Three.js canvas below.
- On submit: hit the backend, get coordinates back, use `three-geo` (npm) with a Mapbox token to fetch terrain + satellite imagery. `three-geo`'s `getTerrainRgb()` returns a `THREE.Group` of satellite-textured meshes — add to scene. Orbit camera.

**SimulationWorld stub** (frontend, `engine/` folder):
- A `SimulationWorld` class wrapping Three.js scene management. For now it only needs: `setTerrain(threeGeoGroup)`, `getScene()`, `render()`. But design it knowing it will later also manage Rapier.js physics, entity spawning (`addBuilding()`, `addEntity()`), and disaster triggers (`triggerDisaster()`). Agents will populate the world through this API via structured JSON from the backend — never touching Three.js directly.

**Test location:** Silverton, CO (37.8120, -107.6645), 5km radius, zoom 12-13.