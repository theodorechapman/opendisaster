import * as THREE from "three";
import { fetchLayers } from "./tiles.ts";
import { buildAllLayers } from "./layers.ts";
import { FlyControls } from "./controls.ts";

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

    // Reset camera — scale distance with area size
    const camScale = size / 500;
    camera.position.set(0, 80 * camScale, 200 * camScale);
    controls.speed = 40 * camScale;

    overlay.classList.add("hidden");
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

  const pos = camera.position;
  hud.textContent = `pos: (${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)})  |  WASD move · Mouse look · Space ↑ · Shift ↓  |  Click to capture mouse`;

  renderer.render(scene, camera);
}

animate();
