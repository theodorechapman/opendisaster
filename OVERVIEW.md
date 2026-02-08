# CatastropheEngine — Project Brief

## What It Is

An AI-powered platform that generates **location-specific disaster simulations on demand**. A user types a natural language prompt like *"Simulate an avalanche hitting Telluride, Colorado from Bear Creek canyon after 72 hours of heavy snowfall"*, and the system:

1. Geocodes the location and defines a scene bounding box
2. Fetches real elevation data and building footprints for that area
3. Fetches visual reference imagery (street view, satellite) and produces a structured description of how the place looks
4. Researches the physics of that disaster type for that specific terrain (slope angles, velocities, flow dynamics)
5. Generates a 3D simulation (Three.js) using all of the above — real terrain mesh, real building placement, physically-informed disaster behavior, visually styled to match the actual location
6. Renders the simulation in-browser, with AI "human agents" that react to the disaster in real time
7. Produces an analysis with risk scores, impact estimates, and a voice-narrated briefing

The whole pipeline runs through a **multi-agent AI swarm** — each step above is a specialized agent.

## Why It Matters (Social Impact Angle)

Professional disaster simulation tools (HAZUS, CFD software) cost $50K+, require PhD expertise, and take weeks. CatastropheEngine democratizes this — a small-town mayor, school principal, community organizer, or volunteer fire chief can type a sentence and get a simulation in ~90 seconds. The equity angle: disaster impact is not evenly distributed. Low-income communities and communities of color are systematically placed near industrial hazards, in flood zones, with older infrastructure. This tool makes inequity visible and quantifiable *before* disaster strikes.

## Context: DevFest 2026 (Columbia University Hackathon)

This is a weekend hackathon project. Tracks: Sustainability, Healthcare, Business, Entertainment. We're targeting **Sustainability** as the primary track, with crossover into Healthcare (casualty prediction) and Entertainment (it's genuinely fun to watch).

## MVP Scope for Hackathon

- **One disaster type only**: avalanche (simplest physics — particle/fluid flowing downhill, visually spectacular)
- **Pre-cached demo location**: Telluride, Colorado (reliable demo with instant results)
- **Live generation**: works on any mountain location, but demo-ready for 2-3 pre-tested ones
- **3-5 AI human agents** in the simulation that make decisions via LLM
- **Counterfactual comparison**: "with avalanche barrier" vs "without" — side-by-side

## Technologies to Integrate

We want to integrate these specific technologies because they correspond to hackathon sponsor prizes:

### Dedalus Labs ADK (Agent Development Kit)
- **What**: SDK for building production AI agents with model routing, MCP server connections, custom tool integration, and built-in auth (Dedalus Auth)
- **Our use**: Core orchestration layer. Every agent in the swarm is a `DedalusRunner` instance. Dedalus Auth provides user login with role-based access (free vs pro tiers). Different agents route to different models (Sonnet for simple tasks, Opus for code generation, K2 Think for physics reasoning).
- **Docs**: https://docs.dedaluslabs.ai
- **Python SDK**: https://github.com/dedalus-labs/dedalus-sdk-python
- **TypeScript SDK**: https://github.com/dedalus-labs/dedalus-sdk-typescript
- **Prize criteria**: "Real user need", "correct auth integration", "high-quality platform usage", "ship quality"

### Flowglad (Payment Processing)
- **What**: Open-source payment provider (YC-backed). React hooks + backend SDK. No webhooks — real-time entitlement tracking. Runs on Stripe under the hood.
- **Our use**: Freemium billing. Free tier = 1 simulation/day, basic resolution. Pro tier = unlimited sims, counterfactual comparisons, API access. Test mode payment required to qualify for prize.
- **Repo**: https://github.com/flowglad/flowglad
- **Docs**: https://docs.flowglad.com/quickstart
- **Discord**: https://discord.com/servers/flowglad-1273695198639161364
- **Prize criteria**: Must complete a test mode payment and share org ID for verification.

### K2 Think (MBZUAI Reasoning Model)
- **What**: 70B parameter reasoning model optimized for math, science, and code. ~2,000+ tokens/sec on Cerebras. Fast scientific reasoning.
- **Our use**: Physics parameter estimation (what are realistic avalanche velocities, mass, flow width for this specific terrain?). Also powers the AI human agents' decision-making in the simulation ("I hear a rumble, should I run left or right?").
- **Prize criteria**: "Meaningful use of advanced reasoning", "core role, not peripheral API call"
- **Access**: API key allocated per team via WhatsApp group (https://chat.whatsapp.com/D0vXoctPvPq3rIMhvdn0il), contact jane.zhang@mbzuai.ac.ae

### ElevenLabs (Voice AI)
- **What**: Text-to-speech, speech-to-text, voice agents, sound effects, multilingual support (70+ languages), emotional control.
- **Our use**: Voice-narrated disaster briefing after simulation completes. The analysis ("Avalanche reaches town center in 47 seconds, buildings in direct flow path sustain catastrophic damage...") is delivered as an audio briefing. Multilingual support for community accessibility.
- **Docs**: https://elevenlabs.io/docs

### Computer Use (SafetyKit Prize)
- **What**: AI agents that interact with real software and digital environments to complete tasks.
- **Our use**: Agents navigate real websites and APIs to gather data — USGS for seismic/terrain data, OpenStreetMap for building data, Google Maps/Street View for visual references. The agents are doing real browser-based research, not just calling APIs.
- **Prize criteria**: "Computer use must be a core part of the project", "meaningfully interact with real software"

### Three.js
- **What**: JavaScript 3D library for WebGL rendering.
- **Our use**: The simulation itself. Terrain mesh generated from real elevation data, buildings placed from OSM footprints, avalanche rendered as a particle system, all running in the browser.

### Additional Sponsor Integrations (Lower Priority)
- **Figma**: Submit a Figma design link of the dashboard for that prize
- **Gemini**: Could use as secondary multimodal model for satellite image analysis
- **Snowflake**: Could use as data warehouse for historical disaster data / simulation results

## Key External APIs

- **Mapbox Terrain RGB Tiles** or **OpenTopography**: Real elevation/heightmap data
- **OpenStreetMap Overpass API**: Building footprints, roads, infrastructure
- **Google Street View Static API**: Ground-level photos of the location
- **Mapbox Static Images API**: Aerial/satellite tiles
- **Nominatim** or similar: Geocoding (location name → coordinates)

## The "World Model" Framing

We're not training a world model from scratch. The Three.js physics simulation *is* a world model — it maintains state, predicts how the environment evolves given initial conditions, and enables counterfactual "what if" reasoning (with barrier vs without). The agent swarm populates this world model with real-world data. This is philosophically aligned with the world models research direction (state → action → predicted next state, counterfactual rollouts) but practically achievable in a hackathon.

## Team

Building this over a weekend at Columbia. Need the architecture to be modular so teammates can work on different agents/components in parallel.
