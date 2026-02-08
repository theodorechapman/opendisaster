import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { fetchLayers } from "./tiles.ts";
import { buildAllLayers, type HeightSampler, buildingRegistry, getTerrainHeight, terrainBoundsRef, resetCarsToBase, sceneGroupRef, roadLinesRef } from "./layers.ts";
import { FlyControls } from "./controls.ts";
import { TornadoSimulator, EF_SCALE } from "./disasters/tornado.ts";
import { EarthquakeSimulator } from "./disasters/earthquake.ts";
import { FloodSimulator } from "./disasters/flood.ts";

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
import { RoadGraph } from "./agents/RoadGraph.ts";
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

// --- Car asset (GLB) ---
const carLoader = new GLTFLoader();
let carTemplate: THREE.Object3D | null = null;
const carTemplatePromise = carLoader.loadAsync("/assets/classic_muscle_car.glb")
  .then((gltf) => {
    const root = gltf.scene;
    const box = new THREE.Box3().setFromObject(root);
    const size = new THREE.Vector3();
    box.getSize(size);
    const length = Math.max(size.x, size.z, 0.001);
    const targetLen = 4.2 * 1.7;
    const scale = targetLen / length;
    root.scale.setScalar(scale);
    const box2 = new THREE.Box3().setFromObject(root);
    const center2 = new THREE.Vector3();
    box2.getCenter(center2);
    root.position.sub(center2);
    root.position.y -= box2.min.y;
    carTemplate = root;
  })
  .catch((err) => {
    console.warn("Failed to load car model:", err);
    carTemplate = null;
  });

// Tornado panel elements
const tornadoPanel   = document.getElementById("tornado-panel")!;
const efSlider       = document.getElementById("ef-slider") as HTMLInputElement;
const efBadge        = document.getElementById("ef-badge")!;
const efDesc         = document.getElementById("ef-desc")!;
const radiusVal      = document.getElementById("radius-val")!;
const widthVal       = document.getElementById("width-val")!;
const spawnBtn       = document.getElementById("spawn-btn") as HTMLButtonElement;
const despawnBtn     = document.getElementById("despawn-btn") as HTMLButtonElement;
const tornadoStats   = document.getElementById("tornado-stats")!;
const tsWind         = document.getElementById("ts-wind")!;
const tsDamaged      = document.getElementById("ts-damaged")!;
const tsDestroyed    = document.getElementById("ts-destroyed")!;

// Earthquake panel elements
const quakePanel   = document.getElementById("quake-panel")!;
const magSlider    = document.getElementById("mag-slider") as HTMLInputElement;
const magVal       = document.getElementById("mag-val")!;
const radiusValEq  = document.getElementById("eq-radius-val")!;
const spawnQuakeBtn = document.getElementById("spawn-quake-btn") as HTMLButtonElement;
const stopQuakeBtn  = document.getElementById("stop-quake-btn") as HTMLButtonElement;

// Flood panel elements
const floodPanel = document.getElementById("flood-panel")!;
const floodHeightSlider = document.getElementById("flood-height") as HTMLInputElement;
const floodHeightVal = document.getElementById("flood-height-val")!;
const floodRadiusVal = document.getElementById("flood-radius-val")!;
const spawnFloodBtn = document.getElementById("spawn-flood-btn") as HTMLButtonElement;
const stopFloodBtn = document.getElementById("stop-flood-btn") as HTMLButtonElement;

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

// --- Tornado, Earthquake, Flood simulators ---
const tornado = new TornadoSimulator(scene);
const quake = new EarthquakeSimulator(scene);
const flood = new FloodSimulator(scene);
const raycaster = new THREE.Raycaster();

const EF_COLORS = ["#22cc22", "#cccc00", "#ff8800", "#ff4400", "#ff0000", "#880000"];

function updateEFDisplay() {
  const r = parseInt(efSlider.value);
  const ef = EF_SCALE[r]!;
  efBadge.textContent = ef.label;
  efBadge.style.background = EF_COLORS[r]!;
  efDesc.textContent = `${ef.desc} · ${ef.minMph}–${ef.maxMph} mph`;
  tornado.setEFRating(r);
  radiusVal.textContent = tornado.getCoreRadius().toFixed(1);
  widthVal.textContent = Math.round(tornado.getPathWidthMeters()).toString();
}
efSlider.addEventListener("input", updateEFDisplay);
updateEFDisplay();

const speedSlider = document.getElementById("speed-slider") as HTMLInputElement;
const speedVal    = document.getElementById("speed-val")!;
speedSlider.addEventListener("input", () => {
  speedVal.textContent = speedSlider.value;
  tornado.setTranslationSpeed(parseInt(speedSlider.value));
});

function updateMagnitudeDisplay() {
  const m = parseFloat(magSlider.value);
  magVal.textContent = m.toFixed(1);
  quake.setMagnitude(m);
  radiusValEq.textContent = `${Math.round(quake.affectedRadiusKm)} km`;
}
magSlider.addEventListener("input", updateMagnitudeDisplay);
updateMagnitudeDisplay();

function updateFloodDisplay() {
  const h = parseFloat(floodHeightSlider.value);
  floodHeightVal.textContent = h.toFixed(1);
  flood.setMaxHeight(h);
  floodRadiusVal.textContent = `${Math.round(flood.affectedRadiusMeters)} m`;
}
floodHeightSlider.addEventListener("input", updateFloodDisplay);
updateFloodDisplay();

// --- Gradual storm atmosphere transition ---
const clearSky = {
  bg: new THREE.Color(skyColor),
  fogNear: 300, fogFar: 800,
  sunIntensity: 1.5, sunColor: new THREE.Color(0xfff4e0),
  hemiIntensity: 0.6, hemiColor: new THREE.Color(0x88bbee),
  ambIntensity: 0.3,
  exposure: 1.0,
};
const stormSky = {
  bg: new THREE.Color(0x8a8a96),
  fogNear: 250, fogFar: 700,
  sunIntensity: 0.85, sunColor: new THREE.Color(0xdddde8),
  hemiIntensity: 0.5, hemiColor: new THREE.Color(0x778899),
  ambIntensity: 0.28,
  exposure: 0.92,
};

let stormTarget = 0;
let stormCurrent = 0;
const STORM_SPEED = 0.35;

const _lerpColor = new THREE.Color();
function updateAtmosphere(t: number) {
  _lerpColor.copy(clearSky.bg).lerp(stormSky.bg, t);
  (scene.background as THREE.Color).copy(_lerpColor);
  const fogColor = _lerpColor.clone();
  scene.fog = new THREE.Fog(fogColor,
    clearSky.fogNear + (stormSky.fogNear - clearSky.fogNear) * t,
    clearSky.fogFar  + (stormSky.fogFar  - clearSky.fogFar) * t,
  );
  sun.intensity = clearSky.sunIntensity + (stormSky.sunIntensity - clearSky.sunIntensity) * t;
  sun.color.copy(clearSky.sunColor).lerp(stormSky.sunColor, t);
  hemi.intensity = clearSky.hemiIntensity + (stormSky.hemiIntensity - clearSky.hemiIntensity) * t;
  hemi.color.copy(clearSky.hemiColor).lerp(stormSky.hemiColor, t);
  ambient.intensity = clearSky.ambIntensity + (stormSky.ambIntensity - clearSky.ambIntensity) * t;
  renderer.toneMappingExposure = clearSky.exposure + (stormSky.exposure - clearSky.exposure) * t;
}

// Track active disaster for auto-despawn detection
let activeDisasterType: "tornado" | "earthquake" | "flood" | null = null;
let wasTornadoActive = false;
let wasQuakeActive = false;

/** Raycast from camera centre to terrain, place tornado. */
function spawnTornadoAtCrosshair() {
  const terrain = sceneGroup?.getObjectByName("terrain");
  if (!terrain) return;
  raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);
  const hits = raycaster.intersectObject(terrain);
  if (hits.length > 0) {
    tornado.spawn(hits[0]!.point);
    stormTarget = 1;
    spawnBtn.style.display = "none";
    despawnBtn.style.display = "block";
    tornadoStats.style.display = "block";
  }
}

function spawnQuakeAtCrosshair() {
  const terrain = sceneGroup?.getObjectByName("terrain");
  if (!terrain) return;
  raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);
  const hits = raycaster.intersectObject(terrain);
  if (hits.length > 0) {
    quake.spawn(hits[0]!.point);
    spawnQuakeBtn.style.display = "none";
    stopQuakeBtn.style.display = "block";
  }
}

function spawnFloodAtCrosshair() {
  const terrain = sceneGroup?.getObjectByName("terrain");
  if (!terrain) return;
  raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);
  const hits = raycaster.intersectObject(terrain);
  if (hits.length > 0) {
    flood.spawn(hits[0]!.point);
    spawnFloodBtn.style.display = "none";
    stopFloodBtn.style.display = "block";
  }
}

function stopTornado() {
  tornado.despawn();
  stormTarget = 0;
  spawnBtn.style.display = "block";
  despawnBtn.style.display = "none";
  tornadoStats.style.display = "none";
}

function stopQuake() {
  quake.despawn();
  spawnQuakeBtn.style.display = "block";
  stopQuakeBtn.style.display = "none";
}

function stopFlood() {
  flood.despawn();
  spawnFloodBtn.style.display = "block";
  stopFloodBtn.style.display = "none";
}

spawnBtn.addEventListener("click", spawnTornadoAtCrosshair);
despawnBtn.addEventListener("click", stopTornado);
spawnQuakeBtn.addEventListener("click", spawnQuakeAtCrosshair);
stopQuakeBtn.addEventListener("click", stopQuake);
spawnFloodBtn.addEventListener("click", spawnFloodAtCrosshair);
stopFloodBtn.addEventListener("click", stopFlood);

window.addEventListener("keydown", (e) => {
  if (!overlay.classList.contains("hidden")) return;
  if (activeDisasterType === "tornado") {
    if (e.code === "KeyT") spawnTornadoAtCrosshair();
    if (e.code === "KeyX") stopTornado();
  } else if (activeDisasterType === "earthquake") {
    if (e.code === "KeyT") spawnQuakeAtCrosshair();
    if (e.code === "KeyX") stopQuake();
  } else if (activeDisasterType === "flood") {
    if (e.code === "KeyT") spawnFloodAtCrosshair();
    if (e.code === "KeyX") stopFlood();
  }
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
  if (e.key === "Enter") {
    e.preventDefault();
    void doLookup();
  }
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
    id: "tornado",
    name: "Tornado",
    description: "Destructive funnel with debris physics",
    icon: "\uD83C\uDF2A\uFE0F",
    available: true,
    launch: () => {
      activeDisasterType = "tornado";
      tornadoPanel.style.display = "block";
      quakePanel.style.display = "none";
      floodPanel.style.display = "none";
    },
  },
  {
    id: "earthquake",
    name: "Earthquake",
    description: "Seismic event with structural damage",
    icon: "\uD83C\uDF0B",
    available: true,
    launch: () => {
      activeDisasterType = "earthquake";
      quakePanel.style.display = "block";
      tornadoPanel.style.display = "none";
      floodPanel.style.display = "none";
    },
  },
  {
    id: "flood",
    name: "Flood",
    description: "Rising water levels and evacuation",
    icon: "\uD83C\uDF0A",
    available: true,
    launch: (_sc, eb) => {
      activeDisasterType = "flood";
      flood.setEventBus(eb);
      floodPanel.style.display = "block";
      tornadoPanel.style.display = "none";
      quakePanel.style.display = "none";
    },
  },
  {
    id: "tsunami",
    name: "Tsunami",
    description: "Offshore surge and coastal impact",
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
let sharedRoadGraph: RoadGraph | null = null;

// --- Obstacle collection from generated scene ---
const OBSTACLE_PADDING = 3; // meters padding around buildings

function collectObstacles(group: THREE.Group, sceneHalfSize: number): Obstacle[] {
  const obstacles: Obstacle[] = [];
  const box = new THREE.Box3();

  group.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    const geom = obj.geometry;
    if (!geom) return;

    const isExtrude = geom.type === "ExtrudeGeometry";
    const isTreePart = obj.parent?.name === "trees";

    if (!isExtrude && !isTreePart) return;

    box.setFromObject(obj);
    const height = box.max.y - box.min.y;

    if (isExtrude && height > 2) {
      obstacles.push({
        minX: box.min.x - OBSTACLE_PADDING,
        maxX: box.max.x + OBSTACLE_PADDING,
        minZ: box.min.z - OBSTACLE_PADDING,
        maxZ: box.max.z + OBSTACLE_PADDING,
      });
    } else if (isTreePart && geom.type === "SphereGeometry") {
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
  if (!collidesAny(preferredX, preferredZ, obstacles, agentRadius)) {
    return { x: preferredX, z: preferredZ };
  }
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
  return { x: preferredX, z: preferredZ };
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

  world = new SimWorld();
  sharedEventBus = new EventBus();

  sharedObstacles = collectObstacles(sceneGrp, sceneHalfSize);
  sharedSceneGroup = sceneGrp;
  sharedSceneSize = sceneSize;

  // Build road navigation graph from road polylines
  sharedRoadGraph = roadLinesRef.length > 0 ? new RoadGraph(roadLinesRef) : null;

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

  // 1. Spawn agents on roads near center (fallback to ring if not enough road nodes)
  let spawnPositions: { x: number; z: number }[] = [];

  if (sharedRoadGraph) {
    const nearCenter = sharedRoadGraph.nodesNearCenter(35);
    if (nearCenter.length >= AGENT_CONFIGS.length) {
      const picked = sharedRoadGraph.spreadPick(nearCenter, AGENT_CONFIGS.length);
      spawnPositions = picked.map(id => {
        const pos = sharedRoadGraph!.getNodePos(id)!;
        return findOpenPosition(pos.x, pos.z, sharedObstacles, 3);
      });
      console.log(`[Agents] Spawning on roads: ${spawnPositions.length} positions from ${nearCenter.length} candidates`);
    }
  }

  // Fallback: ring around center
  if (spawnPositions.length < AGENT_CONFIGS.length) {
    const spawnDist = 30;
    spawnPositions = AGENT_CONFIGS.map((_, i) => {
      const angle = (i / AGENT_CONFIGS.length) * Math.PI * 2;
      const ox = Math.cos(angle) * spawnDist;
      const oz = Math.sin(angle) * spawnDist;
      return findOpenPosition(ox, oz, sharedObstacles, 3);
    });
    console.log("[Agents] Fallback: spawning in ring (not enough road nodes near center)");
  }

  for (let i = 0; i < AGENT_CONFIGS.length; i++) {
    const cfg = AGENT_CONFIGS[i]!;
    const pos = spawnPositions[i]!;
    const y = sampler.sample(pos.x, pos.z);
    agentManager.spawn({
      ...cfg,
      spawnPosition: { x: pos.x, y, z: pos.z },
    });
  }

  // 2. Register ECS systems
  const agentActionSystem = createAgentActionSystem(agentManager, sharedObstacles, sceneHalfSize, sharedRoadGraph);
  const agentDamageSystem = createAgentDamageSystem(agentManager, sharedEventBus);
  world.addSystem("agentAction", agentActionSystem);
  world.addSystem("agentDamage", agentDamageSystem);

  // 3. Create perception, recorder, stepped simulation
  const perception = new AgentPerceptionSystem(renderer, scene, agentManager);
  const recorder = new AgentRecorder(agentManager);
  const locAddr = addressInput.value.trim();
  const locLat = latInput.value;
  const locLon = lonInput.value;
  const locationStr = locAddr || `${locLat}, ${locLon}`;

  const replayRecorder = new ReplayRecorder(agentManager, locationStr);

  steppedSim = new SteppedSimulation(world, agentManager, perception, recorder, sharedEventBus, replayRecorder, {
    stepDurationSec: 1,
    enabled: true,
    disasterType: activeDisasterType ?? "fire",
  });

  // 3b. Create replay capture system
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
          scenarioPanel.classList.remove("visible");
          fireConfigPanel.classList.add("visible");
        } else if (s.id === "tornado" || s.id === "earthquake") {
          // Launch scenario immediately (agents + disaster panels)
          launchScenario(s.id);
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

  // Clean up any active disaster
  if (activeDisasterType === "tornado") {
    tornado.reset();
    stopTornado();
    tornadoPanel.style.display = "none";
  } else if (activeDisasterType === "earthquake") {
    quake.despawn();
    stopQuake();
    quakePanel.style.display = "none";
  } else if (activeDisasterType === "flood") {
    flood.despawn();
    stopFlood();
    floodPanel.style.display = "none";
  }
  activeDisasterType = null;
  flood.setEventBus(null);
  stormTarget = 0;

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
  sharedRoadGraph = null;
  scenarioPanel.classList.remove("visible");
  fireConfigPanel.classList.remove("visible");
  tornadoPanel.style.display = "none";
  quakePanel.style.display = "none";
  floodPanel.style.display = "none";
  activeDisasterType = null;
  flood.setEventBus(null);

  try {
    const size = parseInt(sizeInput.value);
    const layers = await fetchLayers(lat, lon, size);
    await carTemplatePromise;

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

    // Reset tornado state from previous session
    tornado.reset();
    stopTornado();
    quake.despawn();
    stopQuake();
    flood.despawn();
    stopFlood();

  const buildResult = buildAllLayers(layers, lat, lon, carTemplate);
  sceneGroup = buildResult.group;
  heightSampler = buildResult.heightSampler;
  resetCarsToBase();
  scene.add(sceneGroup);
  flood.setTerrainContext(layers, lat, lon, sun, sceneGroup);
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

  // Tornado & earthquake simulation ticks
  tornado.update(dt, buildingRegistry);
  quake.update(dt, buildingRegistry);
  flood.update(dt);
  if (flood.active) {
    floodRadiusVal.textContent = `${Math.round(flood.affectedRadiusMeters)} m`;
  }

  // Detect auto-despawn (tornado left the terrain)
  if (wasTornadoActive && !tornado.active) {
    stopTornado();
  }
  wasTornadoActive = tornado.active;

  // Detect auto-stop (quake finished)
  if (wasQuakeActive && !quake.active) {
    stopQuake();
  }
  wasQuakeActive = quake.active;

  // Camera shake when near tornado
  if (tornado.active) {
    const shake = tornado.getCameraShake(camera.position);
    camera.position.add(shake);

    // Update HUD stats
    const windMph = Math.round(tornado.getWindSpeedAtGround(
      tornado.position.x, tornado.position.z) * 2.237);
    tsWind.textContent = String(windMph);
    tsDamaged.textContent = String(tornado.buildingsDamaged);
    tsDestroyed.textContent = String(tornado.buildingsDestroyed);
  }

  // Earthquake camera shake
  if (quake.active) {
    camera.position.y += quake.getGroundShakeY();
  }

  // Clamp camera to rendered terrain bounds
  if (terrainBoundsRef) {
    const b = terrainBoundsRef;
    const margin = 2;
    camera.position.x = Math.min(b.xMax - margin, Math.max(b.xMin + margin, camera.position.x));
    camera.position.z = Math.min(b.zMax - margin, Math.max(b.zMin + margin, camera.position.z));
  }
  const groundY = getTerrainHeight(camera.position.x, camera.position.z);
  const minY = groundY + 2;
  const maxY = tornado.getCloudCeilingY() - 6;
  camera.position.y = Math.min(maxY, Math.max(minY, camera.position.y));

  // Apply quake jitter after clamp
  if (quake.active) {
    camera.position.add(quake.getCameraJitter());
    const groundYAfter = getTerrainHeight(camera.position.x, camera.position.z);
    if (camera.position.y < groundYAfter + 2) camera.position.y = groundYAfter + 2;
  }

  // Gradual storm atmosphere transition
  if (Math.abs(stormCurrent - stormTarget) > 0.001) {
    if (stormCurrent < stormTarget) {
      stormCurrent = Math.min(stormTarget, stormCurrent + STORM_SPEED * dt);
    } else {
      stormCurrent = Math.max(stormTarget, stormCurrent - STORM_SPEED * dt);
    }
    updateAtmosphere(stormCurrent);
  }

  const pos = camera.position;
  hud.textContent = `pos: (${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)})  |  WASD move · Mouse look · Space ↑ · Shift ↓`;

  renderer.render(scene, camera);

  // Round-robin replay capture (1 agent per frame)
  if (replayCaptureSystem) {
    replayCaptureSystem.captureNext();
  }
}

animate();
