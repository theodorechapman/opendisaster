import { createWorld, addEntity, removeEntity, registerComponent } from "bitecs";
import {
  Position,
  Rotation,
  Scale,
  Velocity,
  MeshRef,
  PhysicsBody,
  Health,
  Classification,
  TerrainCell,
  Agent,
  AgentState,
  AgentAction,
  AgentFacing,
} from "./Components.ts";

export type SystemFn = (world: any, dt: number) => void;

export interface SimWorldOptions {
  fixedDt?: number;
  maxTicksPerUpdate?: number;
}

const ALL_COMPONENTS = [
  Position,
  Rotation,
  Scale,
  Velocity,
  MeshRef,
  PhysicsBody,
  Health,
  Classification,
  TerrainCell,
  Agent,
  AgentState,
  AgentAction,
  AgentFacing,
];

export class SimWorld {
  readonly ecsWorld: ReturnType<typeof createWorld>;
  readonly fixedDt: number;

  private _tick = 0;
  private _accumulator = 0;
  private _alpha = 0;
  private _paused = false;
  private _timeScale = 1.0;
  private _maxTicksPerUpdate: number;

  private systems = new Map<string, SystemFn>();
  private systemOrder: string[] = [];

  constructor(options: SimWorldOptions = {}) {
    this.ecsWorld = createWorld();
    this.fixedDt = options.fixedDt ?? 1 / 60;
    this._maxTicksPerUpdate = options.maxTicksPerUpdate ?? 10;

    // Register all components
    for (const c of ALL_COMPONENTS) {
      registerComponent(this.ecsWorld, c);
    }
  }

  get tick(): number {
    return this._tick;
  }

  get alpha(): number {
    return this._alpha;
  }

  get paused(): boolean {
    return this._paused;
  }

  set paused(v: boolean) {
    if (v && !this._paused) {
      this._accumulator = 0;
    }
    this._paused = v;
  }

  get timeScale(): number {
    return this._timeScale;
  }

  set timeScale(v: number) {
    this._timeScale = Math.max(0, v);
  }

  addSystem(name: string, fn: SystemFn): void {
    if (this.systems.has(name)) {
      throw new Error(`System "${name}" already registered`);
    }
    this.systems.set(name, fn);
    this.systemOrder.push(name);
  }

  removeSystem(name: string): void {
    this.systems.delete(name);
    this.systemOrder = this.systemOrder.filter((n) => n !== name);
  }

  hasSytem(name: string): boolean {
    return this.systems.has(name);
  }

  update(dt: number): void {
    if (this._paused) return;

    this._accumulator += dt * this._timeScale;

    let ticks = 0;
    while (this._accumulator >= this.fixedDt && ticks < this._maxTicksPerUpdate) {
      for (const name of this.systemOrder) {
        const sys = this.systems.get(name);
        if (sys) sys(this.ecsWorld, this.fixedDt);
      }
      this._accumulator -= this.fixedDt;
      this._tick++;
      ticks++;
    }

    if (ticks >= this._maxTicksPerUpdate) {
      this._accumulator = 0;
    }

    this._alpha = this._accumulator / this.fixedDt;
  }

  createEntity(): number {
    return addEntity(this.ecsWorld);
  }

  removeEntity(eid: number): void {
    removeEntity(this.ecsWorld, eid);
  }
}
