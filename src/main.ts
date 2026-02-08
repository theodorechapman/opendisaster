import * as THREE from "three";
import { fetchLayers, type LayerData } from "./tiles.ts";
import { buildAllLayers } from "./layers.ts";
import { FlyControls } from "./controls.ts";
import { createDisaster, getDefaultDisasterControls } from "../disasters/factory.ts";
import type { DisasterControl, DisasterController, DisasterKind } from "../disasters/types.ts";

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
const disasterPanel = document.getElementById("disaster-panel") as HTMLDivElement;
const disasterType = document.getElementById("disaster-type") as HTMLSelectElement;
const disasterStartBtn = document.getElementById("disaster-start") as HTMLButtonElement;
const disasterToggleBtn = document.getElementById("disaster-toggle") as HTMLButtonElement;
const disasterResetBtn = document.getElementById("disaster-reset") as HTMLButtonElement;
const disasterControlsHost = document.getElementById("disaster-controls") as HTMLDivElement;
const disasterStats = document.getElementById("disaster-stats") as HTMLPreElement;

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
  if (e.key === "Enter") {
    e.preventDefault();
    void doLookup();
  }
});

// --- Load all layers ---
let sceneGroup: THREE.Group | null = null;
let loadedLayers: LayerData | null = null;
let loadedCenter: { lat: number; lon: number } | null = null;
let activeDisaster: DisasterController | null = null;
let selectedDisaster: DisasterKind = parseDisasterKind(disasterType.value);
let stagedControls: DisasterControl[] = getDefaultDisasterControls(selectedDisaster);

disasterPanel.style.display = "none";
renderDisasterControls();
updateDisasterButtons();
disasterStats.textContent = "Load terrain, choose a disaster, then press Start Disaster.";

disasterType.addEventListener("change", () => {
  selectedDisaster = parseDisasterKind(disasterType.value);
  stagedControls = getDefaultDisasterControls(selectedDisaster);
  if (activeDisaster) {
    activeDisaster.dispose();
    activeDisaster = null;
  }
  renderDisasterControls();
  updateDisasterButtons();
  disasterStats.textContent = `Selected ${capitalize(selectedDisaster)}. Press Start Disaster.`;
});

disasterStartBtn.addEventListener("click", () => {
  const disaster = ensureActiveDisaster();
  if (!disaster) return;
  disaster.start();
  updateDisasterButtons();
});

disasterToggleBtn.addEventListener("click", () => {
  if (!activeDisaster) return;
  if (activeDisaster.isRunning()) {
    activeDisaster.pause();
  } else {
    activeDisaster.start();
  }
  updateDisasterButtons();
});

disasterResetBtn.addEventListener("click", () => {
  if (!activeDisaster) return;
  activeDisaster.reset();
  updateDisasterButtons();
});

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

    destroyActiveDisaster();
    loadedLayers = null;
    loadedCenter = null;

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

    sceneGroup = buildAllLayers(layers, lat, lon);
    scene.add(sceneGroup);
    loadedLayers = layers;
    loadedCenter = { lat, lon };

    // Reset camera — scale distance with area size
    const camScale = size / 500;
    camera.position.set(0, 80 * camScale, 200 * camScale);
    controls.speed = 40 * camScale;

    overlay.classList.add("hidden");
    disasterPanel.style.display = "block";
    stagedControls = getDefaultDisasterControls(selectedDisaster);
    renderDisasterControls();
    updateDisasterButtons();
    disasterStats.textContent = `Loaded area. Selected ${capitalize(selectedDisaster)}. Press Start Disaster.`;
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
  activeDisaster?.update(dt);

  const pos = camera.position;
  const disasterMode = activeDisaster
    ? `${capitalize(activeDisaster.kind)} ${activeDisaster.isRunning() ? "running" : "paused"}`
    : "No active disaster";
  hud.textContent =
    `pos: (${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)})  |  ` +
    `WASD move · Mouse look · Space ↑ · Shift ↓  |  Click to capture mouse  |  ${disasterMode}`;

  if (activeDisaster) {
    disasterStats.textContent = activeDisaster.getStatsText();
  }

  renderer.render(scene, camera);
}

animate();

function ensureActiveDisaster(): DisasterController | null {
  if (!sceneGroup || !loadedLayers || !loadedCenter) {
    disasterStats.textContent = "Load an area before starting a disaster.";
    return null;
  }

  if (activeDisaster && activeDisaster.kind === selectedDisaster) {
    applyStagedControls(activeDisaster);
    return activeDisaster;
  }

  destroyActiveDisaster();

  try {
    activeDisaster = createDisaster(selectedDisaster, {
      scene,
      parent: sceneGroup,
      camera,
      layers: loadedLayers,
      centerLat: loadedCenter.lat,
      centerLon: loadedCenter.lon,
      sunLight: sun,
    });
    applyStagedControls(activeDisaster);
    stagedControls = activeDisaster.getControls();
    renderDisasterControls();
    updateDisasterButtons();
    return activeDisaster;
  } catch (error) {
    console.error(error);
    disasterStats.textContent = `Could not create ${selectedDisaster} disaster.`;
    return null;
  }
}

function destroyActiveDisaster(): void {
  if (!activeDisaster) return;
  activeDisaster.dispose();
  activeDisaster = null;
}

function applyStagedControls(disaster: DisasterController): void {
  for (const control of stagedControls) {
    disaster.setControl(control.id, control.value);
  }
}

function renderDisasterControls(): void {
  disasterControlsHost.innerHTML = "";
  const controls =
    activeDisaster && activeDisaster.kind === selectedDisaster
      ? activeDisaster.getControls()
      : stagedControls;

  for (const control of controls) {
    const row = document.createElement("div");
    row.style.marginBottom = "10px";

    if (control.type === "range") {
      const label = document.createElement("label");
      label.style.display = "flex";
      label.style.justifyContent = "space-between";
      label.style.fontSize = "12px";
      label.style.color = "#c6d7e9";
      label.style.marginBottom = "3px";

      const name = document.createElement("span");
      name.textContent = control.label;

      const value = document.createElement("span");
      value.textContent = formatRangeValue(control.value, control);

      label.append(name, value);

      const input = document.createElement("input");
      input.type = "range";
      input.min = String(control.min);
      input.max = String(control.max);
      input.step = String(control.step);
      input.value = String(control.value);
      input.style.width = "100%";

      input.addEventListener("input", () => {
        const next = input.valueAsNumber;
        setStagedControlValue(control.id, next);
        if (activeDisaster && activeDisaster.kind === selectedDisaster) {
          activeDisaster.setControl(control.id, next);
          stagedControls = activeDisaster.getControls();
          const refreshed = stagedControls.find((entry) => entry.id === control.id);
          if (refreshed && refreshed.type === "range") {
            value.textContent = formatRangeValue(refreshed.value, refreshed);
            if (Math.abs(refreshed.value - next) > 1e-6) {
              input.value = String(refreshed.value);
            }
          }
        } else {
          value.textContent = formatRangeValue(next, control);
        }
      });

      row.append(label, input);
      disasterControlsHost.appendChild(row);
      continue;
    }

    const checkLabel = document.createElement("label");
    checkLabel.style.display = "flex";
    checkLabel.style.alignItems = "center";
    checkLabel.style.gap = "8px";
    checkLabel.style.fontSize = "12px";
    checkLabel.style.color = "#c6d7e9";

    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = control.value;
    input.addEventListener("change", () => {
      setStagedControlValue(control.id, input.checked);
      if (activeDisaster && activeDisaster.kind === selectedDisaster) {
        activeDisaster.setControl(control.id, input.checked);
        stagedControls = activeDisaster.getControls();
      }
    });

    const text = document.createElement("span");
    text.textContent = control.label;
    checkLabel.append(input, text);
    row.appendChild(checkLabel);
    disasterControlsHost.appendChild(row);
  }
}

function setStagedControlValue(id: string, value: number | boolean): void {
  const control = stagedControls.find((entry) => entry.id === id);
  if (!control) return;
  if (control.type === "range" && typeof value === "number") {
    control.value = clamp(value, control.min, control.max);
  } else if (control.type === "checkbox" && typeof value === "boolean") {
    control.value = value;
  }
}

function updateDisasterButtons(): void {
  const hasTerrain = sceneGroup !== null && loadedLayers !== null;
  disasterStartBtn.disabled = !hasTerrain;
  disasterToggleBtn.disabled = !hasTerrain || activeDisaster === null;
  disasterResetBtn.disabled = !hasTerrain || activeDisaster === null;
  disasterToggleBtn.textContent =
    activeDisaster && activeDisaster.isRunning() ? "Pause" : "Resume";
}

function parseDisasterKind(value: string): DisasterKind {
  return value === "tsunami" ? "tsunami" : "flood";
}

function capitalize(value: string): string {
  return value.slice(0, 1).toUpperCase() + value.slice(1);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function formatRangeValue(
  value: number,
  control: Extract<DisasterControl, { type: "range" }>
): string {
  const precision = control.precision ?? inferPrecision(control.step);
  const suffix = control.unit ? ` ${control.unit}` : "";
  return `${value.toFixed(precision)}${suffix}`;
}

function inferPrecision(step: number): number {
  const text = step.toString();
  const dot = text.indexOf(".");
  return dot >= 0 ? text.length - dot - 1 : 0;
}
