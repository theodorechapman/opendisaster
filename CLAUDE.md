# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `bun run dev` — Start dev server with hot reload (http://localhost:3000)
- `bun run start` — Start production server
- `bun install` — Install dependencies
- `bun test` — Run tests (bun:test)

## Project Overview

OpenDisaster is a 3D disaster simulation platform. Users enter a real-world location, the app fetches OpenStreetMap + USGS elevation data, builds a 3D scene with Three.js, then runs AI-driven agent simulations through disaster scenarios (currently fire).

## Architecture

**Server (`index.ts`):** Bun.serve with HTTP routes + WebSocket. Pre-bundles `src/main.ts` → `dist/main.js` on startup via `Bun.build()`. Proxies VLM API calls (Featherless AI, gemma-3-27b-it model) for agent perception. WebSocket receives agent POV screenshots, returns VLM decisions.

**Frontend (`src/main.ts`):** Three.js renderer with FlyControls. Builds scene from GeoJSON layers (terrain with elevation displacement, extruded buildings, trees, water, barriers). Manages scenario selection UI and simulation lifecycle.

**ECS (`src/core/`):** bitecs v0.4 with SoA TypedArrays. `Components.ts` defines schemas (Position, AgentState, AgentAction, AgentFacing, Classification). `World.ts` wraps bitecs with fixed-timestep update (1/60s, max 10 ticks). `EventBus.ts` provides pub/sub for disaster events (FIRE_SPREAD, AGENT_DEATH).

**Agent System (`src/agents/`):**
1. `AgentManager` — Spawns 8 named agents with personalities, manages per-agent memory
2. `AgentVisuals` — Loads GLB humanoid model, clones with SkeletonUtils, drives idle/walk/run/death animations
3. `AgentPerceptionSystem` — Renders 512x512 POV from each agent's first-person camera → JPEG base64
4. `SteppedSimulation` — Orchestrates 1-sec perception loop, sends frames over WebSocket, applies returned decisions
5. `AgentActionSystem` — ECS system executing movement (walk 1.68 m/s, run 4.8 m/s), AABB collision with obstacles, wall-sliding, agent separation, danger zone avoidance
6. `AgentDamageSystem` — Listens for FIRE_SPREAD events, applies distance-based heat damage, emits AGENT_DEATH

**Scene Building (`src/layers.ts`):** Converts GeoJSON to Three.js geometry. Terrain is a displaced PlaneGeometry with painted canvas texture (parks, water, roads). Buildings are extruded polygons from OSM. Trees are cylinder+sphere with 8m spacing along linestrings.

**Scenarios (`src/scenarios/`):** `TestFire.ts` implements multi-source stochastic fire spread with wind gusts, particle effects (three.quarks), and dynamic point lights.

**Data Pipeline:**
- `src/overpass.ts` — Fetches OSM data (buildings, roads, parks, water, trees, barriers)
- `src/elevation.ts` — Fetches USGS elevation grid
- `src/cache.ts` — In-memory LRU cache (5 entries, 60 min TTL) for API responses

## Key Constraints

- **TypedArray indexing:** `noUncheckedIndexedAccess: true` in tsconfig — all TypedArray access needs `!` assertion (e.g., `Position.x[eid]!`)
- **MAX_ENTITIES:** 100,000 (bitecs default)
- **tsconfig lib:** `["ESNext", "DOM"]`, module: `"Preserve"`, moduleResolution: `"bundler"`
- **VLM graceful degradation:** No `FEATHERLESS_API_KEY` in `.env` = agents auto-wander only (no perception)
- **Obstacle collection:** `collectObstacles()` in main.ts traverses the scene after `buildAllLayers()` to find buildings (ExtrudeGeometry, height > 2m) and trees (SphereGeometry) as AABB collision boxes

## Environment Variables (.env)

- `FEATHERLESS_API_KEY` — Required for VLM-powered agent perception (optional: `_2`, `_3`, `_4` for parallel requests)

## Runtime

Default to Bun for everything. Don't use Node.js, npm, vite, express, or dotenv. Bun auto-loads `.env`.
