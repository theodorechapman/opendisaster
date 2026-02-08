import type { DisasterControl, DisasterController, DisasterContext } from "../types.ts";
import { cloneControls } from "../types.ts";
import { buildFloodRaster } from "./FloodTerrain.ts";
import { FloodWaterSurface } from "./FloodWaterSurface.ts";
import { FloodEnvironmentEffectsRealistic } from "./FloodEnvironmentEffectsRealistic.ts";
import { ShallowWaterSolver } from "./ShallowWaterSolver.ts";

const DEFAULT_SOURCE_FLOW = 34;
const DEFAULT_FLOW_SPEED = 3.2;
const DEFAULT_SOURCE_DEPTH_METERS = 10.0;

export const FLOOD_DEFAULT_CONTROLS: DisasterControl[] = [
  {
    id: "source_flow",
    type: "range",
    label: "Source Flow",
    min: 0,
    max: 80,
    step: 0.1,
    value: DEFAULT_SOURCE_FLOW,
    unit: "m^3/s",
    precision: 1,
  },
  {
    id: "source_depth",
    type: "range",
    label: "Source Depth",
    min: 10,
    max: 30,
    step: 0.1,
    value: DEFAULT_SOURCE_DEPTH_METERS,
    unit: "m",
    precision: 1,
  },
  {
    id: "flow_speed",
    type: "range",
    label: "Flow Speed",
    min: 0.5,
    max: 8,
    step: 0.1,
    value: DEFAULT_FLOW_SPEED,
    unit: "x",
    precision: 2,
  },
  {
    id: "rainfall",
    type: "range",
    label: "Rainfall",
    min: 0,
    max: 120,
    step: 1,
    value: 0,
    unit: "mm/h",
    precision: 0,
  },
  {
    id: "source_enabled",
    type: "checkbox",
    label: "Enable Terrain Source",
    value: true,
  },
];

export class FloodDisaster implements DisasterController {
  readonly kind = "flood" as const;

  private readonly solver: ShallowWaterSolver;
  private readonly surface: FloodWaterSurface;
  private readonly environment: FloodEnvironmentEffectsRealistic;
  private readonly controls = cloneControls(FLOOD_DEFAULT_CONTROLS);
  private readonly sourcePosition: { x: number; y: number; z: number };
  private running = false;
  private flowSpeed = DEFAULT_FLOW_SPEED;

  constructor(private readonly context: DisasterContext) {
    const raster = buildFloodRaster(
      {
        layers: context.layers,
        centerLat: context.centerLat,
        centerLon: context.centerLon,
      },
      {
        targetCellSizeMeters: 2.0,
      }
    );

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

    this.surface = new FloodWaterSurface(raster, context.sunLight);
    this.context.parent.add(this.surface.mesh);
    this.environment = new FloodEnvironmentEffectsRealistic(this.context.parent, this.solver, this.surface);
    this.sourcePosition = this.solver.getSourcePosition();
    this.surface.setSourcePosition(this.sourcePosition.x, this.sourcePosition.z);
    this.surface.updateFromSolver(this.solver, 0);
  }

  start(): void {
    this.running = true;
  }

  pause(): void {
    this.running = false;
  }

  reset(): void {
    this.solver.reset();
    this.environment.reset();
    this.surface.updateFromSolver(this.solver, 0);
  }

  update(dt: number): void {
    if (this.context.sunLight) {
      this.surface.setLightDirection(this.context.sunLight.position);
    }

    if (!this.running) {
      return;
    }

    const simDt = dt * this.flowSpeed;
    this.solver.step(simDt);
    this.environment.update(simDt);
    this.surface.updateFromSolver(this.solver, dt);
  }

  dispose(): void {
    this.context.parent.remove(this.surface.mesh);
    this.environment.dispose();
    this.surface.dispose();
  }

  isRunning(): boolean {
    return this.running;
  }

  getControls(): DisasterControl[] {
    return cloneControls(this.controls);
  }

  setControl(id: string, value: number | boolean): void {
    const control = this.controls.find((entry) => entry.id === id);
    if (!control) return;

    if (control.type === "range") {
      if (typeof value !== "number" || !Number.isFinite(value)) return;
      control.value = clamp(value, control.min, control.max);
    } else if (typeof value === "boolean") {
      control.value = value;
    } else {
      return;
    }

    this.applyControl(id, control.value);
  }

  getStatsText(): string {
    const stats = this.solver.stats;
    return [
      `Flood ${this.running ? "running" : "paused"}`,
      `Source @ x=${this.sourcePosition.x.toFixed(1)} z=${this.sourcePosition.z.toFixed(1)} y=${this.sourcePosition.y.toFixed(1)}`,
      `Wet cells: ${stats.wetCellCount}`,
      `Max depth: ${stats.maxDepth.toFixed(2)} m`,
      `Volume: ${stats.totalVolume.toFixed(1)} m^3`,
      `dt: ${stats.lastDt.toFixed(3)} s`,
    ].join("\n");
  }

  private applyControl(id: string, value: number | boolean): void {
    switch (id) {
      case "source_flow":
        if (typeof value === "number") {
          this.solver.setSourceFlowRate(value);
        }
        break;
      case "source_depth":
        if (typeof value === "number") {
          this.solver.setSourceDepthMeters(value);
          this.surface.updateFromSolver(this.solver, 0);
        }
        break;
      case "flow_speed":
        if (typeof value === "number") {
          this.flowSpeed = value;
        }
        break;
      case "rainfall":
        if (typeof value === "number") {
          this.solver.setRainRateMmPerHour(value);
        }
        break;
      case "source_enabled":
        if (typeof value === "boolean") {
          this.solver.setSourceEnabled(value);
        }
        break;
      default:
        break;
    }
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
