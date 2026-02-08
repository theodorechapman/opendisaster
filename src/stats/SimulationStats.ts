import type { EventBus, AgentDamagedEvent, AgentDeathEvent } from "../core/EventBus.ts";
import type { AgentManager } from "../agents/AgentManager.ts";
import { Position, AgentState } from "../core/Components.ts";

export interface AgentRecord {
  name: string;
  alive: boolean;
  timeOfDeath: number | null;
  deathPosition: [number, number, number] | null;
  cause: string | null;
  totalDamage: number;
}

export interface SimulationStatsData {
  duration: number;
  totalAgents: number;
  deaths: number;
  survivalRate: number;
  timeToFirstDeath: number | null;
  avgSurvivalTime: number;
  agentRecords: AgentRecord[];
  movementGrid: Float32Array;
  damageGrid: Float32Array;
  deathGrid: Float32Array;
  gridWidth: number;
  gridHeight: number;
}

export class SimulationStats {
  private eventBus: EventBus;
  private manager: AgentManager;

  readonly cellSize = 2;
  readonly gridWidth: number;
  readonly gridHeight: number;
  readonly xMin: number;
  readonly zMin: number;

  readonly movementGrid: Float32Array;
  readonly damageGrid: Float32Array;
  readonly deathGrid: Float32Array;

  private agentDamage: Map<number, number> = new Map();
  private agentLastSource: Map<number, string> = new Map();
  private agentDeathTime: Map<number, number> = new Map();
  private agentDeathPos: Map<number, [number, number, number]> = new Map();
  private firstDeathTime: number | null = null;

  private unsubs: (() => void)[] = [];

  constructor(
    eventBus: EventBus,
    manager: AgentManager,
    bounds: { xMin: number; xMax: number; zMin: number; zMax: number },
  ) {
    this.eventBus = eventBus;
    this.manager = manager;

    this.xMin = bounds.xMin;
    this.zMin = bounds.zMin;
    this.gridWidth = Math.ceil((bounds.xMax - bounds.xMin) / this.cellSize);
    this.gridHeight = Math.ceil((bounds.zMax - bounds.zMin) / this.cellSize);

    const cells = this.gridWidth * this.gridHeight;
    this.movementGrid = new Float32Array(cells);
    this.damageGrid = new Float32Array(cells);
    this.deathGrid = new Float32Array(cells);

    this.unsubs.push(
      eventBus.on("AGENT_DAMAGED", (e) => {
        const ev = e as AgentDamagedEvent;
        const prev = this.agentDamage.get(ev.agentIndex) ?? 0;
        this.agentDamage.set(ev.agentIndex, prev + ev.damage);
        this.agentLastSource.set(ev.agentIndex, ev.source);

        const cell = this.posToCell(ev.position[0], ev.position[2]);
        if (cell >= 0 && cell < this.damageGrid.length) {
          this.damageGrid[cell] = this.damageGrid[cell]! + ev.damage;
        }
      }),
    );

    this.unsubs.push(
      eventBus.on("AGENT_DEATH", (e) => {
        const ev = e as AgentDeathEvent;
        const cell = this.posToCell(ev.position[0], ev.position[2]);
        if (cell >= 0 && cell < this.deathGrid.length) {
          this.deathGrid[cell] = this.deathGrid[cell]! + 1;
        }
      }),
    );
  }

  private posToCell(x: number, z: number): number {
    const col = Math.floor((x - this.xMin) / this.cellSize);
    const row = Math.floor((z - this.zMin) / this.cellSize);
    if (col < 0 || col >= this.gridWidth || row < 0 || row >= this.gridHeight) return -1;
    return row * this.gridWidth + col;
  }

  sample(simTime: number): void {
    for (const agent of this.manager.agents) {
      const eid = agent.eid;
      if (AgentState.alive[eid]! === 0) {
        if (!this.agentDeathTime.has(agent.index)) {
          this.agentDeathTime.set(agent.index, simTime);
          this.agentDeathPos.set(agent.index, [
            Position.x[eid]!,
            Position.y[eid]!,
            Position.z[eid]!,
          ]);
          if (this.firstDeathTime === null) {
            this.firstDeathTime = simTime;
          }
        }
        continue;
      }

      const cell = this.posToCell(Position.x[eid]!, Position.z[eid]!);
      if (cell >= 0 && cell < this.movementGrid.length) {
        this.movementGrid[cell] = this.movementGrid[cell]! + 1;
      }
    }
  }

  finalize(simDuration: number): SimulationStatsData {
    const agentRecords: AgentRecord[] = this.manager.agents.map((agent) => {
      const eid = agent.eid;
      const alive = AgentState.alive[eid]! === 1;
      return {
        name: agent.config.name,
        alive,
        timeOfDeath: this.agentDeathTime.get(agent.index) ?? null,
        deathPosition: this.agentDeathPos.get(agent.index) ?? null,
        cause: alive ? null : (this.agentLastSource.get(agent.index) ?? "unknown"),
        totalDamage: this.agentDamage.get(agent.index) ?? 0,
      };
    });

    const deaths = agentRecords.filter((r) => !r.alive).length;
    const totalAgents = agentRecords.length;

    const survivalTimes = agentRecords.map((r) =>
      r.timeOfDeath !== null ? r.timeOfDeath : simDuration,
    );
    const avgSurvivalTime =
      survivalTimes.length > 0
        ? survivalTimes.reduce((a, b) => a + b, 0) / survivalTimes.length
        : simDuration;

    return {
      duration: simDuration,
      totalAgents,
      deaths,
      survivalRate: totalAgents > 0 ? (totalAgents - deaths) / totalAgents : 1,
      timeToFirstDeath: this.firstDeathTime,
      avgSurvivalTime,
      agentRecords,
      movementGrid: this.movementGrid,
      damageGrid: this.damageGrid,
      deathGrid: this.deathGrid,
      gridWidth: this.gridWidth,
      gridHeight: this.gridHeight,
    };
  }

  dispose(): void {
    for (const unsub of this.unsubs) unsub();
    this.unsubs.length = 0;
  }
}
