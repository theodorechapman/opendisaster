import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { fetchLayers } from "./tiles.ts";
import { buildAllLayers, buildingRegistry, getTerrainHeight, terrainBoundsRef, resetCarsToBase, sceneGroupRef } from "./layers.ts";
import { FlyControls } from "./controls.ts";
import { TornadoSimulator, EF_SCALE } from "./disasters/tornado.ts";
import { EarthquakeSimulator } from "./disasters/earthquake.ts";

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
const simMode = document.getElementById("sim-mode") as HTMLSelectElement;

// --- Car asset (GLB) ---
const carLoader = new GLTFLoader();
let carTemplate: THREE.Object3D | null = null;
const carTemplatePromise = carLoader.loadAsync("/assets/classic_muscle_car.glb")
  .then((gltf) => {
    const root = gltf.scene;
    // Normalize size and ground the car
    const box = new THREE.Box3().setFromObject(root);
    const size = new THREE.Vector3();
    box.getSize(size);
    const length = Math.max(size.x, size.z, 0.001);
    const targetLen = 4.2 * 1.7;
    const scale = targetLen / length;
    root.scale.setScalar(scale);
    // Recompute after scale
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

// Ground plane removed (terrain mesh replaces this in the loaded area)

// Controls
const controls = new FlyControls(camera, renderer.domElement);

// Resize
window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// --- Tornado simulator ---
const tornado = new TornadoSimulator(scene);
const quake = new EarthquakeSimulator(scene);
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

let stormTarget = 0;   // 0 = clear, 1 = stormy
let stormCurrent = 0;
const STORM_SPEED = 0.35; // full transition in ~3 s

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

/** Raycast from camera centre (crosshair) to terrain, place tornado. */
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

function spawnSelectedAtCrosshair() {
  if (simMode.value === "tornado") {
    spawnTornadoAtCrosshair();
  } else {
    spawnQuakeAtCrosshair();
  }
}

let wasTornadoActive = false;
let wasQuakeActive = false;

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

function stopSelected() {
  if (simMode.value === "tornado") {
    stopTornado();
  } else {
    stopQuake();
  }
}

spawnBtn.addEventListener("click", spawnSelectedAtCrosshair);
despawnBtn.addEventListener("click", stopSelected);
spawnQuakeBtn.addEventListener("click", spawnSelectedAtCrosshair);
stopQuakeBtn.addEventListener("click", stopSelected);

window.addEventListener("keydown", (e) => {
  // Only handle tornado shortcuts when scene is loaded (overlay hidden)
  if (!overlay.classList.contains("hidden")) return;
  if (e.code === "KeyT") spawnSelectedAtCrosshair();
  if (e.code === "KeyX") stopSelected();
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

simMode.addEventListener("change", () => {
  if (overlay.classList.contains("hidden")) {
    if (simMode.value === "tornado") {
      tornadoPanel.style.display = "block";
      quakePanel.style.display = "none";
    } else {
      tornadoPanel.style.display = "none";
      quakePanel.style.display = "block";
    }
  }
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

    sceneGroup = buildAllLayers(layers, lat, lon, carTemplate);
    resetCarsToBase();
    scene.add(sceneGroup);

    // Reset camera — scale distance with area size
    const camScale = size / 500;
    camera.position.set(0, 80 * camScale, 200 * camScale);
    controls.speed = 40 * camScale;

    overlay.classList.add("hidden");
    if (simMode.value === "tornado") {
      tornadoPanel.style.display = "block";
      quakePanel.style.display = "none";
    } else {
      tornadoPanel.style.display = "none";
      quakePanel.style.display = "block";
    }
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

  // Tornado simulation tick
  tornado.update(dt, buildingRegistry);
  quake.update(dt, buildingRegistry);

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

  // Earthquake camera shake (cheap alternative)
  if (quake.active) {
    camera.position.y += quake.getGroundShakeY();
  }

  // Clamp camera to rendered terrain bounds and between ground and cloud base
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

  // Apply quake jitter after clamp so it remains visible
  if (quake.active) {
    camera.position.add(quake.getCameraJitter());
    // Keep camera above ground even with jitter
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
}

animate();
