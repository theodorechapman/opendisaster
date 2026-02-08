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
import { createAgentActionSystem, type Obstacle } from "./agents/AgentActionSystem.ts";
import { createAgentDamageSystem } from "./agents/AgentDamageSystem.ts";
import { startTestFire } from "./scenarios/TestFire.ts";
import type { AgentConfig } from "./agents/types.ts";
import { Position } from "./core/Components.ts";

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

// --- Agent system state ---
let world: SimWorld | null = null;
let agentManager: AgentManager | null = null;
let steppedSim: SteppedSimulation | null = null;
let heightSampler: HeightSampler | null = null;

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
    // Trees have CylinderGeometry (trunks) with small radius
    const isExtrude = geom.type === "ExtrudeGeometry";
    const isCylinder = geom.type === "CylinderGeometry";

    if (!isExtrude && !isCylinder) return;

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
    } else if (isCylinder && height > 1 && height < 15) {
      // Tree trunk — smaller padding
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

// Agent configs — 4 unique personalities with distinct colors
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
];

async function initAgentSystem(sceneGroup: THREE.Group, sceneSize: number, sampler: HeightSampler) {
  const sceneHalfSize = sceneSize / 2;

  // 1. Create ECS world and event bus
  world = new SimWorld();
  const eventBus = new EventBus();

  // 2. Collect obstacles from the generated scene
  const obstacles = collectObstacles(sceneGroup, sceneHalfSize);

  // 3. Create agent manager and load model
  agentManager = new AgentManager(world, scene);
  info.textContent = "Loading agent model...";

  try {
    await agentManager.visuals.loadModel();
  } catch (err) {
    console.error("[Agents] Failed to load human.glb:", err);
    info.textContent = "Agent model failed to load — agents disabled";
    return;
  }

  // 4. Spawn 4 agents near the fire (center) but not too close
  // Place them ~25-35m from origin in 4 quadrants
  const spawnDist = 30;
  const offsets = [
    { x: -spawnDist, z: -spawnDist },
    { x:  spawnDist, z: -spawnDist },
    { x: -spawnDist, z:  spawnDist },
    { x:  spawnDist, z:  spawnDist },
  ];

  for (let i = 0; i < AGENT_CONFIGS.length; i++) {
    const cfg = AGENT_CONFIGS[i]!;
    const offset = offsets[i]!;
    const pos = findOpenPosition(offset.x, offset.z, obstacles, 3);
    const y = sampler.sample(pos.x, pos.z);
    agentManager.spawn({
      ...cfg,
      spawnPosition: { x: pos.x, y, z: pos.z },
    });
  }

  // 5. Register ECS systems
  const agentActionSystem = createAgentActionSystem(agentManager, obstacles, sceneHalfSize);
  const agentDamageSystem = createAgentDamageSystem(agentManager, eventBus);
  world.addSystem("agentAction", agentActionSystem);
  world.addSystem("agentDamage", agentDamageSystem);

  // 6. Create perception, recorder, stepped simulation
  const perception = new AgentPerceptionSystem(renderer, scene, agentManager);
  const recorder = new AgentRecorder(agentManager);
  steppedSim = new SteppedSimulation(world, agentManager, perception, recorder, {
    stepDurationSec: 1,
    enabled: true,
  });

  // 7. Start stepped simulation (connects WebSocket)
  steppedSim.start();

  // 8. Start test fire at scene center after 10s
  startTestFire(scene, eventBus, sampler);

  info.textContent = `4 agents spawned | Fire in 10s | Ctrl+P snapshots | Ctrl+R recording`;
  console.log("[Agents] Agent system initialized");
}

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
  if (steppedSim) {
    steppedSim.stop();
    steppedSim = null;
  }
  world = null;
  agentManager = null;
  heightSampler = null;

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

    // Initialize agent system after scene is built
    await initAgentSystem(sceneGroup, size, heightSampler);
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
  } else if (agentManager) {
    agentManager.syncVisuals();
  }

  const pos = camera.position;
  hud.textContent = `pos: (${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)})  |  WASD move · Mouse look · Space ↑ · Shift ↓  |  Click to capture mouse`;

  renderer.render(scene, camera);
}

animate();
