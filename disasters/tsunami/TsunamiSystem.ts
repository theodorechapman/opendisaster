import * as THREE from "three";
import type { DisasterControl, DisasterController, DisasterContext } from "../types.ts";
import { cloneControls } from "../types.ts";
import { TerrainHeightSampler } from "./TerrainHeightSampler.ts";
import { TsunamiWaveField } from "./TsunamiWaveField.ts";
import { TsunamiWaterSurface } from "./TsunamiWaterSurface.ts";
import { TsunamiDestructionSystem } from "./TsunamiDestructionSystem.ts";
import { TsunamiSplashSystem } from "./TsunamiSplashSystem.ts";
import { TsunamiSedimentOverlay } from "./TsunamiSedimentOverlay.ts";
import { DEFAULT_TSUNAMI_PARAMS, type TsunamiParams } from "./TsunamiTypes.ts";

export const TSUNAMI_DEFAULT_CONTROLS: DisasterControl[] = [
  {
    id: "accuracy_enhanced",
    type: "checkbox",
    label: "Enhanced Solver",
    value: DEFAULT_TSUNAMI_PARAMS.accuracyMode === "enhanced",
  },
  {
    id: "solver_quality",
    type: "range",
    label: "Solver Quality",
    min: 0.4,
    max: 2.5,
    step: 0.05,
    value: DEFAULT_TSUNAMI_PARAMS.solverQuality,
    precision: 2,
  },
  {
    id: "wave_height",
    type: "range",
    label: "Wave Height",
    min: 2,
    max: 35,
    step: 0.5,
    value: DEFAULT_TSUNAMI_PARAMS.waveHeight,
    unit: "m",
    precision: 1,
  },
  {
    id: "wave_speed",
    type: "range",
    label: "Wave Speed",
    min: 4,
    max: 45,
    step: 0.5,
    value: DEFAULT_TSUNAMI_PARAMS.waveSpeed,
    unit: "m/s",
    precision: 1,
  },
  {
    id: "wave_width",
    type: "range",
    label: "Wave Width",
    min: 10,
    max: 120,
    step: 1,
    value: DEFAULT_TSUNAMI_PARAMS.waveWidth,
    unit: "m",
    precision: 0,
  },
  {
    id: "wave_count",
    type: "range",
    label: "Wave Count",
    min: 1,
    max: 6,
    step: 1,
    value: DEFAULT_TSUNAMI_PARAMS.numWaves,
    precision: 0,
  },
  {
    id: "wave_period",
    type: "range",
    label: "Wave Period",
    min: 30,
    max: 240,
    step: 5,
    value: DEFAULT_TSUNAMI_PARAMS.wavePeriodSec,
    unit: "s",
    precision: 0,
  },
  {
    id: "backwash_strength",
    type: "range",
    label: "Backwash Strength",
    min: 0,
    max: 1,
    step: 0.05,
    value: DEFAULT_TSUNAMI_PARAMS.backwashStrength,
    precision: 2,
  },
  {
    id: "bore_impulse",
    type: "range",
    label: "Bore Impulse",
    min: 0.5,
    max: 3,
    step: 0.05,
    value: DEFAULT_TSUNAMI_PARAMS.impulseGain,
    precision: 2,
  },
  {
    id: "bore_impulse_coeff",
    type: "range",
    label: "Bore Coefficient",
    min: 0.2,
    max: 2.5,
    step: 0.05,
    value: DEFAULT_TSUNAMI_PARAMS.impulseCoeffBore,
    precision: 2,
  },
  {
    id: "turbulence",
    type: "range",
    label: "Turbulence",
    min: 0,
    max: 4,
    step: 0.05,
    value: DEFAULT_TSUNAMI_PARAMS.turbulence,
    precision: 2,
  },
  {
    id: "impact_force",
    type: "range",
    label: "Impact Force",
    min: 0.2,
    max: 3,
    step: 0.05,
    value: DEFAULT_TSUNAMI_PARAMS.impactForce,
    precision: 2,
  },
  {
    id: "building_collision_intensity",
    type: "range",
    label: "Building Collision",
    min: 0,
    max: 3,
    step: 0.05,
    value: DEFAULT_TSUNAMI_PARAMS.buildingCollisionIntensity,
    precision: 2,
  },
  {
    id: "drag_coeff_building",
    type: "range",
    label: "Facade Drag Coeff",
    min: 0.5,
    max: 2.2,
    step: 0.05,
    value: DEFAULT_TSUNAMI_PARAMS.dragCoeffBuilding,
    precision: 2,
  },
  {
    id: "reflection_strength",
    type: "range",
    label: "Wave Reflection",
    min: 0,
    max: 1.3,
    step: 0.05,
    value: DEFAULT_TSUNAMI_PARAMS.reflectionStrength,
    precision: 2,
  },
  {
    id: "debris_entrainment",
    type: "range",
    label: "Debris Entrain",
    min: 0.3,
    max: 2.5,
    step: 0.05,
    value: DEFAULT_TSUNAMI_PARAMS.debrisEntrainment,
    precision: 2,
  },
  {
    id: "debris_drag",
    type: "range",
    label: "Debris Drag",
    min: 0.2,
    max: 4,
    step: 0.05,
    value: DEFAULT_TSUNAMI_PARAMS.debrisDrag,
    precision: 2,
  },
  {
    id: "debris_drag_coeff",
    type: "range",
    label: "Debris Drag Coeff",
    min: 0.2,
    max: 2.2,
    step: 0.05,
    value: DEFAULT_TSUNAMI_PARAMS.dragCoeffDebris,
    precision: 2,
  },
  {
    id: "debris_added_mass",
    type: "range",
    label: "Debris Added Mass",
    min: 0,
    max: 2,
    step: 0.05,
    value: DEFAULT_TSUNAMI_PARAMS.addedMassCoeffDebris,
    precision: 2,
  },
  {
    id: "debris_lift",
    type: "range",
    label: "Debris Lift Coeff",
    min: 0,
    max: 1.5,
    step: 0.05,
    value: DEFAULT_TSUNAMI_PARAMS.liftCoeffDebris,
    precision: 2,
  },
  {
    id: "restitution_debris",
    type: "range",
    label: "Debris Restitution",
    min: 0,
    max: 0.9,
    step: 0.01,
    value: DEFAULT_TSUNAMI_PARAMS.restitutionDebris,
    precision: 2,
  },
  {
    id: "restitution_building",
    type: "range",
    label: "Building Restitution",
    min: 0,
    max: 0.8,
    step: 0.01,
    value: DEFAULT_TSUNAMI_PARAMS.restitutionBuilding,
    precision: 2,
  },
  {
    id: "debris_collision_damping",
    type: "range",
    label: "Collision Damping",
    min: 0,
    max: 1,
    step: 0.01,
    value: DEFAULT_TSUNAMI_PARAMS.debrisCollisionDamping,
    precision: 2,
  },
  {
    id: "fragment_min",
    type: "range",
    label: "Fragment Min",
    min: 5,
    max: 25,
    step: 1,
    value: DEFAULT_TSUNAMI_PARAMS.fragmentMin,
    precision: 0,
  },
  {
    id: "fragment_max",
    type: "range",
    label: "Fragment Max",
    min: 10,
    max: 35,
    step: 1,
    value: DEFAULT_TSUNAMI_PARAMS.fragmentMax,
    precision: 0,
  },
  {
    id: "break_threshold_multiplier",
    type: "range",
    label: "Break Threshold",
    min: 0.6,
    max: 1.6,
    step: 0.05,
    value: DEFAULT_TSUNAMI_PARAMS.breakThresholdMultiplier,
    precision: 2,
  },
  {
    id: "building_destruction_level",
    type: "range",
    label: "Building Destruction",
    min: 0,
    max: 2,
    step: 0.05,
    value: DEFAULT_TSUNAMI_PARAMS.buildingDestructionLevel,
    precision: 2,
  },
  {
    id: "splash_intensity",
    type: "range",
    label: "Splash Intensity",
    min: 0,
    max: 3,
    step: 0.05,
    value: DEFAULT_TSUNAMI_PARAMS.splashIntensity,
    precision: 2,
  },
  {
    id: "splash_energy_scale",
    type: "range",
    label: "Splash Energy",
    min: 0.2,
    max: 2.5,
    step: 0.05,
    value: DEFAULT_TSUNAMI_PARAMS.splashEnergyScale,
    precision: 2,
  },
  {
    id: "spray_weber_threshold",
    type: "range",
    label: "Breakup Threshold",
    min: 20,
    max: 180,
    step: 1,
    value: DEFAULT_TSUNAMI_PARAMS.weberThreshold,
    precision: 0,
  },
  {
    id: "droplet_density",
    type: "range",
    label: "Droplet Density",
    min: 0,
    max: 3,
    step: 0.05,
    value: DEFAULT_TSUNAMI_PARAMS.dropletDensity,
    precision: 2,
  },
  {
    id: "max_splash_particles",
    type: "range",
    label: "Max Splash",
    min: 0,
    max: 1200,
    step: 10,
    value: DEFAULT_TSUNAMI_PARAMS.maxSplashParticles,
    precision: 0,
  },
  {
    id: "max_droplets",
    type: "range",
    label: "Max Droplets",
    min: 0,
    max: 2400,
    step: 20,
    value: DEFAULT_TSUNAMI_PARAMS.maxDroplets,
    precision: 0,
  },
  {
    id: "max_debris_substeps",
    type: "range",
    label: "Debris Substeps",
    min: 1,
    max: 8,
    step: 1,
    value: DEFAULT_TSUNAMI_PARAMS.maxDebrisSubsteps,
    precision: 0,
  },
  {
    id: "max_particle_substeps",
    type: "range",
    label: "Particle Substeps",
    min: 1,
    max: 6,
    step: 1,
    value: DEFAULT_TSUNAMI_PARAMS.maxParticleSubsteps,
    precision: 0,
  },
  {
    id: "max_collision_iterations",
    type: "range",
    label: "Collision Iters",
    min: 1,
    max: 8,
    step: 1,
    value: DEFAULT_TSUNAMI_PARAMS.maxCollisionIterations,
    precision: 0,
  },
  {
    id: "nonhydro_boost",
    type: "range",
    label: "Nonhydro Boost",
    min: 0,
    max: 1.5,
    step: 0.05,
    value: DEFAULT_TSUNAMI_PARAMS.nonHydrostaticBoost,
    precision: 2,
  },
  {
    id: "sediment_response",
    type: "range",
    label: "Sediment Resp",
    min: 0,
    max: 3,
    step: 0.05,
    value: DEFAULT_TSUNAMI_PARAMS.sedimentResponse,
    precision: 2,
  },
  {
    id: "scour_sensitivity",
    type: "range",
    label: "Scour Sensitivity",
    min: 0,
    max: 3,
    step: 0.05,
    value: DEFAULT_TSUNAMI_PARAMS.scourSensitivity,
    precision: 2,
  },
];

export class TsunamiSystem implements DisasterController {
  readonly kind = "tsunami" as const;

  private readonly controls = cloneControls(TSUNAMI_DEFAULT_CONTROLS);
  private readonly params: TsunamiParams = { ...DEFAULT_TSUNAMI_PARAMS };
  private readonly terrainSampler: TerrainHeightSampler;
  private readonly waveField: TsunamiWaveField;
  private readonly waterSurface: TsunamiWaterSurface;
  private readonly splashSystem: TsunamiSplashSystem;
  private readonly destruction: TsunamiDestructionSystem;
  private readonly sedimentOverlay: TsunamiSedimentOverlay;
  private running = false;

  constructor(private readonly context: DisasterContext) {
    const terrain = context.parent.getObjectByName("terrain");
    if (!(terrain instanceof THREE.Mesh)) {
      throw new Error("Terrain mesh not found for tsunami simulation.");
    }

    this.terrainSampler = new TerrainHeightSampler(terrain);
    this.waveField = new TsunamiWaveField(this.terrainSampler.bounds, this.params);
    this.sedimentOverlay = new TsunamiSedimentOverlay(
      this.context.parent,
      this.terrainSampler,
      this.waveField,
      this.params
    );
    this.context.parent.add(this.sedimentOverlay.mesh);

    this.waterSurface = new TsunamiWaterSurface(
      this.terrainSampler.bounds,
      this.terrainSampler,
      this.waveField
    );
    this.context.parent.add(this.waterSurface.mesh);

    this.splashSystem = new TsunamiSplashSystem(
      this.context.parent,
      this.terrainSampler,
      this.waveField,
      this.params,
      (x, z, strength, radiusMeters) => {
        const alongX = this.waveField.direction.x * (0.04 + strength * 0.02);
        const alongZ = this.waveField.direction.y * (0.04 + strength * 0.02);
        this.waveField.injectMomentumImpulse(
          x,
          z,
          alongX,
          alongZ,
          radiusMeters,
          0.14 * strength,
          0.28
        );
      }
    );

    this.destruction = new TsunamiDestructionSystem(
      this.context.parent,
      this.terrainSampler,
      this.waveField,
      this.params,
      {
        onImpact: (event) => {
          this.splashSystem.emitImpact(event);
        },
        onWaterImpulse: (x, z, vx, vz, radiusMeters, strength) => {
          this.waveField.injectMomentumImpulse(
            x,
            z,
            vx,
            vz,
            radiusMeters,
            strength * (0.48 + this.params.solverQuality * 0.22),
            0.55
          );
        },
      }
    );

    this.waterSurface.update();
  }

  start(): void {
    this.running = true;
  }

  pause(): void {
    this.running = false;
  }

  reset(): void {
    this.running = false;
    this.waveField.reset();
    this.destruction.reset();
    this.splashSystem.reset();
    this.sedimentOverlay.reset();
    this.waterSurface.update(0);
  }

  update(dt: number): void {
    if (this.context.sunLight) {
      this.waterSurface.setLightDirection(this.context.sunLight.position);
    }

    if (this.running) {
      this.waveField.update(dt);
      this.destruction.update(dt);
      this.splashSystem.update(dt);
      this.sedimentOverlay.update(dt);
    }

    this.waterSurface.update(dt);
  }

  dispose(): void {
    this.running = false;
    this.destruction.dispose();
    this.splashSystem.dispose();
    this.context.parent.remove(this.sedimentOverlay.mesh);
    this.sedimentOverlay.dispose();
    this.context.parent.remove(this.waterSurface.mesh);
    this.waterSurface.dispose();
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
    } else {
      if (typeof value !== "boolean") return;
      control.value = value;
    }

    this.params.accuracyMode = this.getToggle("accuracy_enhanced") ? "enhanced" : "realtime";
    this.params.solverQuality = this.getRange("solver_quality");
    this.params.waveHeight = this.getRange("wave_height");
    this.params.waveSpeed = this.getRange("wave_speed");
    this.params.waveWidth = this.getRange("wave_width");
    this.params.numWaves = Math.round(this.getRange("wave_count"));
    this.params.wavePeriodSec = this.getRange("wave_period");
    this.params.backwashStrength = this.getRange("backwash_strength");
    this.params.impulseGain = this.getRange("bore_impulse");
    this.params.impulseCoeffBore = this.getRange("bore_impulse_coeff");
    this.params.turbulence = this.getRange("turbulence");
    this.params.impactForce = this.getRange("impact_force");
    this.params.buildingCollisionIntensity = this.getRange("building_collision_intensity");
    this.params.dragCoeffBuilding = this.getRange("drag_coeff_building");
    this.params.reflectionStrength = this.getRange("reflection_strength");
    this.params.debrisEntrainment = this.getRange("debris_entrainment");
    this.params.debrisDrag = this.getRange("debris_drag");
    this.params.dragCoeffDebris = this.getRange("debris_drag_coeff");
    this.params.addedMassCoeffDebris = this.getRange("debris_added_mass");
    this.params.liftCoeffDebris = this.getRange("debris_lift");
    this.params.restitutionDebris = this.getRange("restitution_debris");
    this.params.restitutionBuilding = this.getRange("restitution_building");
    this.params.debrisCollisionDamping = this.getRange("debris_collision_damping");
    this.params.fragmentMin = Math.round(this.getRange("fragment_min"));
    this.params.fragmentMax = Math.round(this.getRange("fragment_max"));
    this.params.breakThresholdMultiplier = this.getRange("break_threshold_multiplier");
    this.params.buildingDestructionLevel = this.getRange("building_destruction_level");
    this.params.splashIntensity = this.getRange("splash_intensity");
    this.params.splashEnergyScale = this.getRange("splash_energy_scale");
    this.params.weberThreshold = this.getRange("spray_weber_threshold");
    this.params.dropletDensity = this.getRange("droplet_density");
    this.params.maxSplashParticles = Math.round(this.getRange("max_splash_particles"));
    this.params.maxDroplets = Math.round(this.getRange("max_droplets"));
    this.params.maxDebrisSubsteps = Math.round(this.getRange("max_debris_substeps"));
    this.params.maxParticleSubsteps = Math.round(this.getRange("max_particle_substeps"));
    this.params.maxCollisionIterations = Math.round(this.getRange("max_collision_iterations"));
    this.params.nonHydrostaticBoost = this.getRange("nonhydro_boost");
    this.params.sedimentResponse = this.getRange("sediment_response");
    this.params.scourSensitivity = this.getRange("scour_sensitivity");

    if (this.params.fragmentMax < this.params.fragmentMin) {
      this.params.fragmentMax = this.params.fragmentMin;
      const maxControl = this.controls.find((entry) => entry.id === "fragment_max");
      if (maxControl && maxControl.type === "range") {
        maxControl.value = this.params.fragmentMax;
      }
    }

    this.waveField.setParams({
      waveHeight: this.params.waveHeight,
      waveSpeed: this.params.waveSpeed,
      waveWidth: this.params.waveWidth,
      numWaves: this.params.numWaves,
      wavePeriodSec: this.params.wavePeriodSec,
      backwashStrength: this.params.backwashStrength,
      impulseGain: this.params.impulseGain,
      impulseCoeffBore: this.params.impulseCoeffBore,
      turbulence: this.params.turbulence,
      accuracyMode: this.params.accuracyMode,
      solverQuality: this.params.solverQuality,
      rhoWater: this.params.rhoWater,
      nonHydrostaticBoost: this.params.nonHydrostaticBoost,
    });
  }

  getStatsText(): string {
    const peak = this.destruction.getPeakMetrics();
    const impact = this.destruction.getImpactMetrics();
    const sediment = this.sedimentOverlay.getTotals();
    const spray = this.splashSystem.getCounts();
    return [
      `Tsunami ${this.running ? "running" : "paused"} (${this.params.accuracyMode})`,
      `Wave ${this.waveField.getCurrentWaveIndex()}/${Math.max(1, Math.round(this.params.numWaves))}`,
      `Front travel: ${this.waveField.getFrontMeters().toFixed(1)} m`,
      `Progress: ${(this.waveField.getProgress() * 100).toFixed(1)}%`,
      `Destroyed: ${this.destruction.getDestroyedCount()}`,
      `Debris: ${this.destruction.getDebrisCount()} (entrained ${this.destruction.getEntrainedCount()}, stranded ${this.destruction.getStrandedCount()})`,
      `Splash: ${spray.splash}  Droplets: ${spray.droplets}`,
      `Peak depth: ${peak.depth.toFixed(2)} m`,
      `Peak speed: ${peak.speed.toFixed(2)} m/s`,
      `Peak pressure: ${(peak.pressure / 1000).toFixed(1)} kPa`,
      `Peak facade force: ${(impact.hydroForce / 1000).toFixed(1)} kN`,
      `Peak impulse: ${impact.impulse.toFixed(1)} N·s`,
      `Erosion: ${sediment.erosion.toFixed(1)}  Deposition: ${sediment.deposition.toFixed(1)}  Scour: ${sediment.scour.toFixed(1)}`,
    ].join("\n");
  }

  private getRange(id: string): number {
    const control = this.controls.find((entry) => entry.id === id);
    if (!control || control.type !== "range") {
      return 0;
    }
    return control.value;
  }

  private getToggle(id: string): boolean {
    const control = this.controls.find((entry) => entry.id === id);
    return !!control && control.type === "checkbox" ? control.value : false;
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
