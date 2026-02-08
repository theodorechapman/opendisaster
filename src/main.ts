import * as THREE from "three";
import { fetchLayers } from "./tiles.ts";
import { buildAllLayers, type HeightSampler } from "./layers.ts";
import { FlyControls } from "./controls.ts";

// Agent system imports
import { SimWorld } from "./core/World.ts";
import { EventBus } from "./core/EventBus.ts";
import { AgentManager } from "./agents/AgentManager.ts";
import { AgentPerceptionSystem } from "./agents/AgentPerceptionSystem.ts";
import { AgentRecorder } from "./agents/AgentRecorder.ts";
import { SteppedSimulation } from "./agents/SteppedSimulation.ts";
import { ReplayRecorder } from "./replay/ReplayRecorder.ts";
import { createAgentActionSystem, type Obstacle } from "./agents/AgentActionSystem.ts";
import { createAgentDamageSystem } from "./agents/AgentDamageSystem.ts";
import { startTestFire, type FireConfig } from "./scenarios/TestFire.ts";
import type { AgentConfig } from "./agents/types.ts";
import { Position } from "./core/Components.ts";
import { ReplayCaptureSystem } from "./replay/ReplayCaptureSystem.ts";

const overlay = document.getElementById("overlay")!;
const goBtn = document.getElementById("go") as HTMLButtonElement;
const latInput = document.getElementById("lat") as HTMLInputElement;
const lonInput = document.getElementById("lon") as HTMLInputElement;
const sizeInput = document.getElementById("size") as HTMLInputElement;
const sizeVal = document.getElementById("size-val")!;
const sizeLabel = document.getElementById("size-label")!;
const sizeLabel2 = document.getElementById("size-label2")!;
const addressInput = document.getElementById("address") as HTMLInputElement;
const lookupBtn = document.getElementById("lookup") as HTMLButtonElement;
const geocodeError = document.getElementById("geocode-error")!;
const loading = document.getElementById("loading")!;
const hud = document.getElementById("hud")!;
const info = document.getElementById("info")!;
const stopSimBtn = document.getElementById("stop-sim-btn") as HTMLButtonElement;

// Fire config panel elements
const fireConfigPanel = document.getElementById("fire-config-panel")!;
const fireXInput = document.getElementById("fire-x") as HTMLInputElement;
const fireZInput = document.getElementById("fire-z") as HTMLInputElement;
const fireSizeInput = document.getElementById("fire-size") as HTMLInputElement;
const fireSpreadInput = document.getElementById("fire-spread") as HTMLInputElement;
const fireXVal = document.getElementById("fire-x-val")!;
const fireZVal = document.getElementById("fire-z-val")!;
const fireSizeVal = document.getElementById("fire-size-val")!;
const fireSpreadVal = document.getElementById("fire-spread-val")!;
const fireStartBtn = document.getElementById("fire-start-btn") as HTMLButtonElement;
const fireBackBtn = document.getElementById("fire-back-btn") as HTMLButtonElement;

// Live value updates for fire sliders
fireXInput.addEventListener("input", () => { fireXVal.textContent = fireXInput.value; });
fireZInput.addEventListener("input", () => { fireZVal.textContent = fireZInput.value; });
fireSizeInput.addEventListener("input", () => { fireSizeVal.textContent = fireSizeInput.value; });
fireSpreadInput.addEventListener("input", () => { fireSpreadVal.textContent = fireSpreadInput.value; });

sizeInput.addEventListener("input", () => {
  sizeVal.textContent = sizeInput.value;
  sizeLabel.textContent = sizeInput.value;
  sizeLabel2.textContent = sizeInput.value;
});

// --- Three.js setup ---
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const skyColor = 0x87ceeb;
scene.background = new THREE.Color(skyColor);
scene.fog = new THREE.Fog(skyColor, 300, 800);

const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.5, 1000);
camera.position.set(0, 80, 200);

// Lighting — sun directional light with shadows
const sun = new THREE.DirectionalLight(0xfff4e0, 1.5);
sun.position.set(200, 400, 300);
sun.castShadow = true;
sun.shadow.mapSize.width = 2048;
sun.shadow.mapSize.height = 2048;
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 1000;
sun.shadow.camera.left = -300;
sun.shadow.camera.right = 300;
sun.shadow.camera.top = 300;
sun.shadow.camera.bottom = -300;
scene.add(sun);

// Hemisphere light: sky blue from above, warm ground bounce from below
const hemi = new THREE.HemisphereLight(0x88bbee, 0x886644, 0.6);
scene.add(hemi);

// Soft ambient fill
const ambient = new THREE.AmbientLight(0xffffff, 0.3);
scene.add(ambient);



// Controls
const controls = new FlyControls(camera, renderer.domElement);

// Resize
window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// --- Geocode lookup ---
async function doLookup() {
  const q = addressInput.value.trim();
  if (!q) return;
  geocodeError.style.display = "none";
  lookupBtn.disabled = true;
  lookupBtn.textContent = "…";
  try {
    const res = await fetch(`/api/geocode?q=${encodeURIComponent(q)}`);
    const data = await res.json();
    if (!res.ok || data.error) {
      geocodeError.textContent = data.error ?? "Lookup failed";
      geocodeError.style.display = "block";
      return;
    }
    latInput.value = data.lat.toString();
    lonInput.value = data.lon.toString();
  } catch {
    geocodeError.textContent = "Network error";
    geocodeError.style.display = "block";
  } finally {
    lookupBtn.disabled = false;
    lookupBtn.textContent = "Lookup";
  }
}

lookupBtn.addEventListener("click", doLookup);
addressInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); doLookup(); }
});

// --- Scenario registry ---
interface ScenarioDefinition {
  id: string;
  name: string;
  description: string;
  icon: string;
  available: boolean;
  launch: (scene: THREE.Scene, eventBus: EventBus, sampler: HeightSampler, fireConfig?: FireConfig) => void;
}

const scenarios: ScenarioDefinition[] = [
  {
    id: "fire",
    name: "Fire",
    description: "Building fire with smoke and flames",
    icon: "\uD83D\uDD25",
    available: true,
    launch: (sc, eb, s, fireConfig?: FireConfig) => startTestFire(sc, eb, s, fireConfig),
  },
  {
    id: "earthquake",
    name: "Earthquake",
    description: "Seismic event with structural damage",
    icon: "\uD83C\uDF0B",
    available: false,
    launch: () => {},
  },
  {
    id: "flood",
    name: "Flood",
    description: "Rising water levels and evacuation",
    icon: "\uD83C\uDF0A",
    available: false,
    launch: () => {},
  },
];

const scenarioPanel = document.getElementById("scenario-panel")!;

// --- Agent system state ---
let world: SimWorld | null = null;
let agentManager: AgentManager | null = null;
let steppedSim: SteppedSimulation | null = null;
let heightSampler: HeightSampler | null = null;
let replayCaptureSystem: ReplayCaptureSystem | null = null;

// Exploration phase shared state
let explorationReady = false;
let sharedEventBus: EventBus | null = null;
let sharedObstacles: Obstacle[] = [];
let sharedSceneGroup: THREE.Group | null = null;
let sharedSceneSize = 0;

// --- Obstacle collection from generated scene ---
const OBSTACLE_PADDING = 3; // meters padding around buildings

function collectObstacles(group: THREE.Group, sceneHalfSize: number): Obstacle[] {
  const obstacles: Obstacle[] = [];
  const box = new THREE.Box3();

  group.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    const geom = obj.geometry;
    if (!geom) return;

    // Heuristic: buildings are ExtrudeGeometry with height > 2m
    // Trees: any mesh under the "trees" group (trunks and canopies)
    const isExtrude = geom.type === "ExtrudeGeometry";
    const isTreePart = obj.parent?.name === "trees";

    if (!isExtrude && !isTreePart) return;

    // Compute world bounding box
    box.setFromObject(obj);
    const height = box.max.y - box.min.y;

    if (isExtrude && height > 2) {
      // Building — add with padding
      obstacles.push({
        minX: box.min.x - OBSTACLE_PADDING,
        maxX: box.max.x + OBSTACLE_PADDING,
        minZ: box.min.z - OBSTACLE_PADDING,
        maxZ: box.max.z + OBSTACLE_PADDING,
      });
    } else if (isTreePart && geom.type === "SphereGeometry") {
      // Tree canopy — use its full XZ footprint as the collision area
      const pad = 1.5;
      obstacles.push({
        minX: box.min.x - pad,
        maxX: box.max.x + pad,
        minZ: box.min.z - pad,
        maxZ: box.max.z + pad,
      });
    }
  });

  console.log(`[Agents] Collected ${obstacles.length} obstacles from scene`);
  return obstacles;
}

/** Find an open position that doesn't collide with any obstacle. */
function findOpenPosition(
  preferredX: number,
  preferredZ: number,
  obstacles: Obstacle[],
  agentRadius: number,
): { x: number; z: number } {
  // Try the preferred position first
  if (!collidesAny(preferredX, preferredZ, obstacles, agentRadius)) {
    return { x: preferredX, z: preferredZ };
  }
  // Spiral outward
  for (let r = 5; r < 100; r += 5) {
    for (let a = 0; a < 8; a++) {
      const angle = (a / 8) * Math.PI * 2;
      const x = preferredX + Math.cos(angle) * r;
      const z = preferredZ + Math.sin(angle) * r;
      if (!collidesAny(x, z, obstacles, agentRadius)) {
        return { x, z };
      }
    }
  }
  return { x: preferredX, z: preferredZ }; // fallback
}

function collidesAny(x: number, z: number, obstacles: Obstacle[], radius: number): boolean {
  for (const o of obstacles) {
    const cx = Math.max(o.minX, Math.min(x, o.maxX));
    const cz = Math.max(o.minZ, Math.min(z, o.maxZ));
    const dx = x - cx;
    const dz = z - cz;
    if (dx * dx + dz * dz < radius * radius) return true;
  }
  return false;
}

// Agent configs — 8 unique personalities with distinct colors
const AGENT_CONFIGS: Omit<AgentConfig, "spawnPosition">[] = [
  {
    name: "Alice",
    color: 0xff4444,
    personality: { bravery: 0.8, altruism: 0.6, awareness: 0.7, description: "a brave security guard" },
  },
  {
    name: "Bob",
    color: 0x4444ff,
    personality: { bravery: 0.3, altruism: 0.5, awareness: 0.8, description: "a nervous bystander" },
  },
  {
    name: "Carol",
    color: 0x44ff44,
    personality: { bravery: 0.5, altruism: 0.9, awareness: 0.6, description: "an analytical professor" },
  },
  {
    name: "Dave",
    color: 0xffaa00,
    personality: { bravery: 0.6, altruism: 0.4, awareness: 0.5, description: "a practical delivery worker" },
  },
  {
    name: "Eve",
    color: 0xff44ff,
    personality: { bravery: 0.9, altruism: 0.8, awareness: 0.9, description: "an experienced firefighter" },
  },
  {
    name: "Frank",
    color: 0x44ffff,
    personality: { bravery: 0.2, altruism: 0.3, awareness: 0.6, description: "a panicky tourist" },
  },
  {
    name: "Grace",
    color: 0xffff44,
    personality: { bravery: 0.7, altruism: 0.7, awareness: 0.5, description: "a resourceful paramedic" },
  },
  {
    name: "Hank",
    color: 0x88ff88,
    personality: { bravery: 0.4, altruism: 0.6, awareness: 0.4, description: "a distracted jogger" },
  },
];

/**
 * Phase A: Set up ECS world, event bus, obstacles, load agent model.
 * Does NOT spawn agents or start simulation.
 */
async function initExploration(sceneGrp: THREE.Group, sceneSize: number, sampler: HeightSampler) {
  const sceneHalfSize = sceneSize / 2;

  // 1. Create ECS world and event bus
  world = new SimWorld();
  sharedEventBus = new EventBus();

  // 2. Collect obstacles from the generated scene
  sharedObstacles = collectObstacles(sceneGrp, sceneHalfSize);
  sharedSceneGroup = sceneGrp;
  sharedSceneSize = sceneSize;

  // 3. Create agent manager and load model
  agentManager = new AgentManager(world, scene);
  info.textContent = "Loading agent model...";

  try {
    await agentManager.visuals.loadModel();
  } catch (err) {
    console.error("[Agents] Failed to load Man.glb:", err);
    info.textContent = "Agent model failed to load — agents disabled";
    return;
  }

  explorationReady = true;
  info.textContent = "Explore the area. Select a scenario to begin simulation.";
  console.log("[Agents] Exploration phase ready — awaiting scenario selection");
}

/**
 * Phase B: Spawn agents, register systems, start simulation,
 * then trigger the chosen scenario.
 */
function launchScenario(scenarioId: string, fireConfig?: FireConfig) {
  if (!explorationReady || !world || !agentManager || !heightSampler || !sharedEventBus) {
    console.error("[Agents] Cannot launch scenario — exploration not ready");
    return;
  }

  const scenario = scenarios.find((s) => s.id === scenarioId);
  if (!scenario || !scenario.available) return;

  const sampler = heightSampler;
  const sceneHalfSize = sharedSceneSize / 2;

  // 1. Spawn 8 agents in a ring around the center
  const spawnDist = 30;
  const offsets = AGENT_CONFIGS.map((_, i) => {
    const angle = (i / AGENT_CONFIGS.length) * Math.PI * 2;
    return {
      x: Math.cos(angle) * spawnDist,
      z: Math.sin(angle) * spawnDist,
    };
  });

  for (let i = 0; i < AGENT_CONFIGS.length; i++) {
    const cfg = AGENT_CONFIGS[i]!;
    const offset = offsets[i]!;
    const pos = findOpenPosition(offset.x, offset.z, sharedObstacles, 3);
    const y = sampler.sample(pos.x, pos.z);
    agentManager.spawn({
      ...cfg,
      spawnPosition: { x: pos.x, y, z: pos.z },
    });
  }

  // 2. Register ECS systems
  const agentActionSystem = createAgentActionSystem(agentManager, sharedObstacles, sceneHalfSize);
  const agentDamageSystem = createAgentDamageSystem(agentManager, sharedEventBus);
  world.addSystem("agentAction", agentActionSystem);
  world.addSystem("agentDamage", agentDamageSystem);

  // 3. Create perception, recorder, stepped simulation
  const perception = new AgentPerceptionSystem(renderer, scene, agentManager);
  const recorder = new AgentRecorder(agentManager);
  // Build location string for replay recording
  const locAddr = addressInput.value.trim();
  const locLat = latInput.value;
  const locLon = lonInput.value;
  const locationStr = locAddr || `${locLat}, ${locLon}`;

  const replayRecorder = new ReplayRecorder(agentManager, locationStr);

  steppedSim = new SteppedSimulation(world, agentManager, perception, recorder, sharedEventBus, replayRecorder, {
    stepDurationSec: 1,
    enabled: true,
  });

  // 3b. Create replay capture system (round-robin 512x512 captures in animate loop)
  replayCaptureSystem = new ReplayCaptureSystem(renderer, scene, agentManager, replayRecorder);

  // 4. Start stepped simulation (connects WebSocket)
  steppedSim.start();

  // 5. Launch the chosen scenario
  scenario.launch(scene, sharedEventBus, sampler, fireConfig);

  // 6. Hide scenario panel, show stop button
  scenarioPanel.classList.remove("visible");
  explorationReady = false;
  stopSimBtn.style.display = "block";

  info.textContent = `${AGENT_CONFIGS.length} agents spawned | ${scenario.name} scenario active | Ctrl+P snapshots | Ctrl+R recording`;
  console.log(`[Agents] Scenario "${scenario.name}" launched`);
}

/** Build scenario panel UI from the registry */
function buildScenarioPanel() {
  // Clear existing cards
  scenarioPanel.querySelectorAll(".scenario-card").forEach((el) => el.remove());

  for (const s of scenarios) {
    const card = document.createElement("div");
    card.className = "scenario-card" + (s.available ? "" : " disabled");
    card.innerHTML = `
      <div class="sc-icon">${s.icon}</div>
      <div class="sc-text">
        <div class="sc-name">${s.name}</div>
        <div class="sc-desc">${s.description}${s.available ? "" : " (coming soon)"}</div>
      </div>
    `;
    if (s.available) {
      card.addEventListener("click", () => {
        if (s.id === "fire") {
          // Show fire config panel instead of launching directly
          scenarioPanel.classList.remove("visible");
          fireConfigPanel.classList.add("visible");
        } else {
          launchScenario(s.id);
        }
      });
    }
    scenarioPanel.appendChild(card);
  }
}

// --- Fire config panel buttons ---
fireStartBtn.addEventListener("click", () => {
  const config: FireConfig = {
    offsetX: parseInt(fireXInput.value),
    offsetZ: parseInt(fireZInput.value),
    maxRadius: parseInt(fireSizeInput.value),
    maxFires: parseInt(fireSpreadInput.value),
  };
  fireConfigPanel.classList.remove("visible");
  launchScenario("fire", config);
});

fireBackBtn.addEventListener("click", () => {
  fireConfigPanel.classList.remove("visible");
  scenarioPanel.classList.add("visible");
});

// --- Stop simulation button ---
stopSimBtn.addEventListener("click", async () => {
  if (!steppedSim) return;
  stopSimBtn.disabled = true;
  stopSimBtn.textContent = "Saving...";
  if (replayCaptureSystem) {
    replayCaptureSystem.dispose();
    replayCaptureSystem = null;
  }
  await steppedSim.stop();
  steppedSim = null;
  stopSimBtn.style.display = "none";
  stopSimBtn.disabled = false;
  stopSimBtn.textContent = "Stop Simulation";
  info.textContent = "Simulation stopped. Replay saved.";
});

// --- Load all layers ---
let sceneGroup: THREE.Group | null = null;

goBtn.addEventListener("click", async () => {
  const lat = parseFloat(latInput.value);
  const lon = parseFloat(lonInput.value);
  if (isNaN(lat) || isNaN(lon)) return;

  goBtn.disabled = true;
  goBtn.textContent = "Loading…";
  loading.style.display = "block";

  // Clean up previous agent system
  if (replayCaptureSystem) {
    replayCaptureSystem.dispose();
    replayCaptureSystem = null;
  }
  if (steppedSim) {
    await steppedSim.stop();
    steppedSim = null;
  }
  stopSimBtn.style.display = "none";
  world = null;
  agentManager = null;
  heightSampler = null;
  explorationReady = false;
  sharedEventBus = null;
  sharedObstacles = [];
  sharedSceneGroup = null;
  sharedSceneSize = 0;
  scenarioPanel.classList.remove("visible");
  fireConfigPanel.classList.remove("visible");

  try {
    const size = parseInt(sizeInput.value);
    const layers = await fetchLayers(lat, lon, size);

    if (sceneGroup) {
      scene.remove(sceneGroup);
      sceneGroup.traverse((obj) => {
        if (obj instanceof THREE.Mesh) {
          obj.geometry.dispose();
          if (Array.isArray(obj.material)) {
            obj.material.forEach((m) => m.dispose());
          } else {
            (obj.material as THREE.Material).dispose();
          }
        }
      });
    }

    const buildResult = buildAllLayers(layers, lat, lon);
    sceneGroup = buildResult.group;
    heightSampler = buildResult.heightSampler;
    scene.add(sceneGroup);

    // Reset camera — scale distance with area size
    const camScale = size / 500;
    camera.position.set(0, 80 * camScale, 200 * camScale);
    controls.speed = 40 * camScale;

    overlay.classList.add("hidden");

    // Initialize exploration phase (no agents yet)
    await initExploration(sceneGroup, size, heightSampler);

    // Show scenario selection panel
    buildScenarioPanel();
    scenarioPanel.classList.add("visible");
  } catch (err) {
    console.error("Failed to load:", err);
    alert("Failed to load data. Check console for details.");
  } finally {
    goBtn.disabled = false;
    goBtn.textContent = "Load Buildings";
    loading.style.display = "none";
  }
});

// --- Render loop ---
let lastTime = performance.now();

function animate() {
  requestAnimationFrame(animate);
  const now = performance.now();
  const dt = Math.min((now - lastTime) / 1000, 0.1);
  lastTime = now;

  controls.update(dt);

  // Update ECS world and sync agent visuals
  if (world) {
    world.update(dt);
  }
  if (agentManager && heightSampler) {
    // Update agent Y positions to follow terrain before syncing visuals
    for (const agent of agentManager.agents) {
      const eid = agent.eid;
      Position.y[eid] = heightSampler.sample(Position.x[eid]!, Position.z[eid]!);
    }
    agentManager.syncVisuals();
    agentManager.visuals.updateAnimations(dt);
  } else if (agentManager) {
    agentManager.syncVisuals();
    agentManager.visuals.updateAnimations(dt);
  }

  const pos = camera.position;
  hud.textContent = `pos: (${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)})  |  WASD move · Mouse look · Space ↑ · Shift ↓  |  Click to capture mouse`;

  renderer.render(scene, camera);

  // Round-robin replay capture (1 agent per frame)
  if (replayCaptureSystem) {
    replayCaptureSystem.captureNext();
  }
}

animate();
