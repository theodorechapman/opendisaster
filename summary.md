# OpenDisaster: Real‑Time Disaster Simulation With AI Agents
  ## A WebGPU‑powered, city‑scale disaster simulator that turns real locations into interactive crisis scenarios with autonomous agents, analytics, and replays.
  ———
  ## The Problem
  Emergency training tools are either too abstract to feel real or too complex to use in fast‑moving scenarios. Most systems:
  - don’t model real neighborhoods,
  - lack believable human behavior and feedback loops.

  As a result, planners and responders have to guess how people behave, how damage compounds, and how to evaluate outcomes under pressure.
  ———
  ## The Solution

  OpenDisaster turns any real location into a live, controllable disaster simulation with AI‑driven agents, realistic physics, and actionable analytics.


  - USGS elevation for terrain height and slope
  - Satellite imagery stitched and projected onto ground + rooftops

  ### 2. Multi‑Disaster Engine
  - Tornado (EF‑scale wind field, debris physics, building damage/collapse)
  - Flood (shallow‑water sim, currents, debris + tree uprooting)
  - Fire (stochastic spread, smoke/embers, building ignition)

  ### 3. AI‑Driven Agents

  - VLM perception → decision pipeline via WebSocket
  - Agents flee dangers using road graph navigation
  ### 4. Analytics + Replay
  - Damage events recorded over time
  - Replay viewer with VLM logs + POV streams
  - Snapshot gallery + downloadable evidence

  - Scenario selection UI (tornado / earthquake / flood / fire)
  - On‑screen spawn/stop controls


  - WebGPU rendering
  - Shared textures/material reuse
  - Progressive collapse + batched debris updates
  - Cachable data pipeline



  ### Backend

  - Bun server for fast local runtime
  - Overpass API pipeline → categorized OSM layers
  - Satellite imagery proxy (/api/satellite)
  - Audio dialogue via ElevenLabs TTS

  ### Frontend

  - Three.js + WebGPU rendering
  - React UI overlays for scenario control
  - Terrain + building mesh generation
  - Dynamic materials for roof satellite projection
  - Physics‑like debris + collapse logic

  2. Run disaster physics per frame
  3. Capture agent POVs
  4. Send frames to VLM for perception
  5. Apply decisions and update agent motion
  6. Log outcomes for replay + stats




  1. Keeping WebGPU stable while rendering large city meshes
  2. Avoiding per‑mesh material recompiles in WebGPU
  3. Balancing tornado debris scale vs. frame time
  4. Preventing agents from flickering in GPU capture pipelines
  5. Mapping satellite imagery cleanly onto rooftops + ground
  6. Making floods visually rich but still fast


  - Satellite imagery projected onto rooftops
  - Agents with autonomous perception + motion
  - Replay system with POV video + VLM logs
  - Real‑time survival analytics and heatmap overlays



  Realism is less about raw physics and more about signal: the right visual cues at the right time. We learned how to:
  - map external geospatial data into a 3D simulation,
  - keep large simulations responsive without sacrificing detail.
  ———
  ## The Impact
  - Enables faster scenario planning for responders and researchers
  - Generates consistent, replayable outcomes for analysis
  ———

  ## Image: Team Picture

  (Placeholder)


  - Bun
  - React
  - OpenStreetMap
  - Google Maps Satellite Imagery

  http://localhost:3000

  ## Submitted to

  - Internal Demo / Local Build

  #### Created by

  - Chris Chang
  - Theo Chapman
  - Alex Jerpelea
  - Anirudh Sridharan