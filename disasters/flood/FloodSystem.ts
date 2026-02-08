import * as THREE from "three";
import type { LayerData } from "../../src/tiles.ts";
import type { FloodInitContext } from "./FloodTypes.ts";
import { buildFloodRaster } from "./FloodTerrain.ts";
import { ShallowWaterSolver } from "./ShallowWaterSolver.ts";
import { FloodWaterSurface } from "./FloodWaterSurface.ts";
import { FloodEnvironmentEffectsRealistic } from "./FloodEnvironmentEffectsRealistic.ts";

interface FloodSystemOptions {
  autoStart?: boolean;
  targetCellSizeMeters?: number;
}

const DEFAULT_SOURCE_FLOW = 34;
const DEFAULT_FLOW_SPEED = 3.2;
const MIN_SOURCE_DEPTH_METERS = 10.0;
const DEFAULT_SOURCE_DEPTH_METERS = 10.0;

export class FloodSystem {
  private readonly parent: THREE.Group;
  private readonly solver: ShallowWaterSolver;
  private readonly surface: FloodWaterSurface;
  private readonly environment: FloodEnvironmentEffectsRealistic;
  private readonly panel: HTMLDivElement;
  private readonly statsEl: HTMLDivElement;
  private readonly cleanupFns: Array<() => void> = [];
  private running: boolean;
  private statsTimer = 0;
  private readonly sunLight?: THREE.DirectionalLight;
  private flowSpeed = DEFAULT_FLOW_SPEED;

  constructor(
    parent: THREE.Group,
    layers: LayerData,
    centerLat: number,
    centerLon: number,
    sunLight?: THREE.DirectionalLight,
    options: FloodSystemOptions = {}
  ) {
    this.parent = parent;
    this.sunLight = sunLight;
    this.running = options.autoStart ?? true;

    const initCtx: FloodInitContext = {
      layers,
      centerLat,
      centerLon,
    };
    const raster = buildFloodRaster(initCtx, {
      targetCellSizeMeters: options.targetCellSizeMeters ?? 2.0,
    });

    this.solver = new ShallowWaterSolver(raster, {
      sourceEnabled: true,
      sourceFlowRate: DEFAULT_SOURCE_FLOW,
      sourceRadiusCells: 2,
      cfl: 0.62,
      maxSubsteps: 28,
      manningN: 0.0008,
      infiltrationRate: 0,
      drainageRate: 0,
      rainRate: 0,
    });
    this.solver.setSourceDepthMeters(DEFAULT_SOURCE_DEPTH_METERS);

    this.surface = new FloodWaterSurface(raster, sunLight);
    this.parent.add(this.surface.mesh);
    this.environment = new FloodEnvironmentEffectsRealistic(this.parent, this.solver, this.surface);

    const sourcePos = this.solver.getSourcePosition();
    this.surface.setSourcePosition(sourcePos.x, sourcePos.z);
    const ui = this.createPanel(sourcePos);
    this.panel = ui.panel;
    this.statsEl = ui.statsEl;
    this.refreshStats();
    this.surface.updateFromSolver(this.solver, 0);
  }

  update(dt: number): void {
    if (this.sunLight) {
      this.surface.setLightDirection(this.sunLight.position);
    }
    if (this.running) {
      const simDt = dt * this.flowSpeed;
      this.solver.step(simDt);
      this.environment.update(simDt);
      this.surface.updateFromSolver(this.solver, dt);
      this.statsTimer += dt;
      if (this.statsTimer > 0.2) {
        this.statsTimer = 0;
        this.refreshStats();
      }
    }
  }

  dispose(): void {
    for (const fn of this.cleanupFns) fn();
    this.cleanupFns.length = 0;
    this.panel.remove();
    this.parent.remove(this.surface.mesh);
    this.environment.dispose();
    this.surface.dispose();
  }

  private refreshStats(): void {
    const stats = this.solver.stats;
    this.statsEl.textContent =
      `Wet cells: ${stats.wetCellCount}\n` +
      `Max depth: ${stats.maxDepth.toFixed(2)} m\n` +
      `Volume: ${stats.totalVolume.toFixed(1)} m³\n` +
      `dt: ${stats.lastDt.toFixed(3)} s`;
  }

  private createPanel(sourcePos: { x: number; y: number; z: number }): {
    panel: HTMLDivElement;
    statsEl: HTMLDivElement;
  } {
    const panel = document.createElement("div");
    panel.style.position = "fixed";
    panel.style.top = "16px";
    panel.style.right = "16px";
    panel.style.zIndex = "20";
    panel.style.width = "320px";
    panel.style.padding = "12px";
    panel.style.borderRadius = "10px";
    panel.style.border = "1px solid rgba(255,255,255,0.15)";
    panel.style.background = "rgba(10,16,28,0.82)";
    panel.style.backdropFilter = "blur(4px)";
    panel.style.color = "#d7e8ff";
    panel.style.fontFamily = "monospace";
    panel.style.fontSize = "12px";
    panel.innerHTML = `
      <div style="font-weight:700; font-size:13px; margin-bottom:8px;">Flood Simulator</div>
      <div style="margin-bottom:8px; color:#9ec3ff;">
        Source @ mid-elevation terrain (non-building)<br/>
        x=${sourcePos.x.toFixed(1)} z=${sourcePos.z.toFixed(1)} y=${sourcePos.y.toFixed(1)}
      </div>
      <div style="display:flex; gap:8px; margin-bottom:10px;">
        <button id="flood-toggle" style="flex:1;">${this.running ? "Pause" : "Start"}</button>
        <button id="flood-reset" style="flex:1;">Reset</button>
      </div>
      <div style="margin-bottom:8px;">
        <label style="display:flex;justify-content:space-between; margin-bottom:2px;">
          <span>Source Flow</span><span id="flood-source-value">${DEFAULT_SOURCE_FLOW.toFixed(1)} m³/s</span>
        </label>
        <input id="flood-source-flow" type="range" min="0" max="80" step="0.1" value="${DEFAULT_SOURCE_FLOW}" style="width:100%;" />
      </div>
      <div style="margin-bottom:8px;">
        <label style="display:flex;justify-content:space-between; margin-bottom:2px;">
          <span>Source Depth</span><span id="flood-depth-value">${DEFAULT_SOURCE_DEPTH_METERS.toFixed(1)} m</span>
        </label>
        <input id="flood-depth-scale" type="range" min="${MIN_SOURCE_DEPTH_METERS}" max="30.0" step="0.1" value="${DEFAULT_SOURCE_DEPTH_METERS}" style="width:100%;" />
      </div>
      <div style="margin-bottom:8px;">
        <label style="display:flex;justify-content:space-between; margin-bottom:2px;">
          <span>Flow Speed</span><span id="flood-speed-value">${DEFAULT_FLOW_SPEED.toFixed(2)}x</span>
        </label>
        <input id="flood-flow-speed" type="range" min="0.5" max="8" step="0.1" value="${DEFAULT_FLOW_SPEED}" style="width:100%;" />
      </div>
      <div style="margin-bottom:8px;">
        <label style="display:flex;justify-content:space-between; margin-bottom:2px;">
          <span>Rainfall</span><span id="flood-rain-value">0 mm/h</span>
        </label>
        <input id="flood-rain" type="range" min="0" max="120" step="1" value="0" style="width:100%;" />
      </div>
      <label style="display:flex; align-items:center; gap:8px; margin-bottom:10px;">
        <input id="flood-source-enabled" type="checkbox" checked />
        <span>Enable Terrain Source</span>
      </label>
      <pre id="flood-stats" style="white-space:pre-wrap; margin:0; color:#a8f0ff;"></pre>
    `;

    // Button styles
    const buttons = panel.querySelectorAll("button");
    for (const btn of buttons) {
      const b = btn as HTMLButtonElement;
      b.style.background = "#2859c5";
      b.style.border = "1px solid #3976f0";
      b.style.color = "#fff";
      b.style.padding = "6px 8px";
      b.style.borderRadius = "6px";
      b.style.cursor = "pointer";
    }

    document.body.appendChild(panel);

    const toggleBtn = panel.querySelector("#flood-toggle") as HTMLButtonElement;
    const resetBtn = panel.querySelector("#flood-reset") as HTMLButtonElement;
    const sourceRange = panel.querySelector("#flood-source-flow") as HTMLInputElement;
    const sourceValue = panel.querySelector("#flood-source-value") as HTMLSpanElement;
    const depthRange = panel.querySelector("#flood-depth-scale") as HTMLInputElement;
    const depthValue = panel.querySelector("#flood-depth-value") as HTMLSpanElement;
    const speedRange = panel.querySelector("#flood-flow-speed") as HTMLInputElement;
    const speedValue = panel.querySelector("#flood-speed-value") as HTMLSpanElement;
    const rainRange = panel.querySelector("#flood-rain") as HTMLInputElement;
    const rainValue = panel.querySelector("#flood-rain-value") as HTMLSpanElement;
    const sourceEnabled = panel.querySelector("#flood-source-enabled") as HTMLInputElement;
    const statsEl = panel.querySelector("#flood-stats") as HTMLDivElement;

    const onToggle = () => {
      this.running = !this.running;
      toggleBtn.textContent = this.running ? "Pause" : "Start";
    };
    toggleBtn.addEventListener("click", onToggle);
    this.cleanupFns.push(() => toggleBtn.removeEventListener("click", onToggle));

    const onReset = () => {
      this.solver.reset();
      this.environment.reset();
      this.surface.updateFromSolver(this.solver, 0);
      this.refreshStats();
    };
    resetBtn.addEventListener("click", onReset);
    this.cleanupFns.push(() => resetBtn.removeEventListener("click", onReset));

    const onSourceFlow = () => {
      const flow = sourceRange.valueAsNumber;
      sourceValue.textContent = `${flow.toFixed(1)} m³/s`;
      this.solver.setSourceFlowRate(flow);
    };
    sourceRange.addEventListener("input", onSourceFlow);
    this.cleanupFns.push(() => sourceRange.removeEventListener("input", onSourceFlow));
    onSourceFlow();

    const onDepthScale = () => {
      const depthMeters = depthRange.valueAsNumber;
      depthValue.textContent = `${depthMeters.toFixed(1)} m`;
      this.solver.setSourceDepthMeters(depthMeters);
      this.surface.updateFromSolver(this.solver, 0);
    };
    depthRange.addEventListener("input", onDepthScale);
    this.cleanupFns.push(() => depthRange.removeEventListener("input", onDepthScale));
    onDepthScale();

    const onSpeed = () => {
      const scale = speedRange.valueAsNumber;
      speedValue.textContent = `${scale.toFixed(2)}x`;
      this.flowSpeed = scale;
    };
    speedRange.addEventListener("input", onSpeed);
    this.cleanupFns.push(() => speedRange.removeEventListener("input", onSpeed));
    onSpeed();

    const onRain = () => {
      const rain = rainRange.valueAsNumber;
      rainValue.textContent = `${rain.toFixed(0)} mm/h`;
      this.solver.setRainRateMmPerHour(rain);
    };
    rainRange.addEventListener("input", onRain);
    this.cleanupFns.push(() => rainRange.removeEventListener("input", onRain));
    onRain();

    const onSourceEnabled = () => {
      this.solver.setSourceEnabled(sourceEnabled.checked);
    };
    sourceEnabled.addEventListener("change", onSourceEnabled);
    this.cleanupFns.push(() => sourceEnabled.removeEventListener("change", onSourceEnabled));
    onSourceEnabled();

    return { panel, statsEl };
  }
}
