import { simulate } from "../api/client";
import { loadTerrain } from "../engine/TerrainLoader";
import { SimulationWorld } from "../engine/SimulationWorld";

export function createApp(root: HTMLElement): void {
  // DOM
  root.innerHTML = `
    <div class="toolbar">
      <input type="text" id="prompt-input" placeholder="Describe a disaster scenario..."
        value="Simulate an avalanche hitting Silverton, Colorado" />
      <button id="simulate-btn">Simulate</button>
      <span class="status" id="status"></span>
    </div>
    <div id="canvas-container"></div>
  `;

  const input = root.querySelector<HTMLInputElement>("#prompt-input")!;
  const button = root.querySelector<HTMLButtonElement>("#simulate-btn")!;
  const status = root.querySelector<HTMLSpanElement>("#status")!;
  const container = root.querySelector<HTMLDivElement>("#canvas-container")!;

  // Engine
  const world = new SimulationWorld(container);
  world.render();

  // Handler
  const handleSimulate = async () => {
    const prompt = input.value.trim();
    if (!prompt) return;

    button.disabled = true;
    status.className = "status";
    status.textContent = "Calling backend...";

    try {
      const res = await simulate(prompt);

      if (!res.location) {
        status.textContent = "Could not geocode location from prompt.";
        status.className = "status error";
        return;
      }

      status.textContent = `Loading terrain for ${res.location.name}...`;

      const terrain = await loadTerrain({
        lat: res.location.lat,
        lng: res.location.lng,
      });

      world.setTerrain(terrain);
      status.textContent = `${res.disaster_type} @ ${res.location.name} (${res.location.lat.toFixed(3)}, ${res.location.lng.toFixed(3)})`;
    } catch (err) {
      status.textContent = err instanceof Error ? err.message : "Unknown error";
      status.className = "status error";
    } finally {
      button.disabled = false;
    }
  };

  button.addEventListener("click", handleSimulate);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") handleSimulate();
  });
}
