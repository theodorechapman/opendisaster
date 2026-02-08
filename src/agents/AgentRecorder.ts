import { Position, AgentState } from "../core/Components.ts";
import type { AgentManager } from "./AgentManager.ts";
import type { StepRecord, AgentStepData } from "./types.ts";

/**
 * Records per-step simulation data for replay and analysis.
 * Press Ctrl+R to download the recording as JSON.
 */
export class AgentRecorder {
  private records: StepRecord[] = [];
  private manager: AgentManager;
  private pendingEvents: string[] = [];

  constructor(manager: AgentManager) {
    this.manager = manager;

    // Listen for Ctrl+R to download
    document.addEventListener("keydown", (e) => {
      if (e.ctrlKey && e.key === "r") {
        e.preventDefault();
        this.download();
      }
    });
  }

  /** Add an event string to be included in the next step record. */
  addEvent(event: string): void {
    this.pendingEvents.push(event);
  }

  /** Record a full simulation step. */
  recordStep(
    step: number,
    simTime: number,
    observations: Map<number, string>,
    decisions: Map<number, { reasoning: string; action: string }>,
  ): void {
    const agents: AgentStepData[] = this.manager.agents.map((agent) => {
      const eid = agent.eid;
      const obs = observations.get(agent.index) ?? "";
      const dec = decisions.get(agent.index);
      return {
        name: agent.config.name,
        agentIndex: agent.index,
        positionX: Position.x[eid]!,
        positionY: Position.y[eid]!,
        positionZ: Position.z[eid]!,
        health: AgentState.health[eid]!,
        stamina: AgentState.stamina[eid]!,
        panicLevel: AgentState.panicLevel[eid]!,
        alive: AgentState.alive[eid]! === 1,
        observation: obs,
        reasoning: dec?.reasoning ?? "",
        action: dec?.action ?? "",
      };
    });

    this.records.push({
      step,
      simTime,
      agents,
      events: [...this.pendingEvents],
    });

    this.pendingEvents = [];
  }

  /** Download recorded data as JSON file. */
  download(): void {
    if (this.records.length === 0) {
      console.log("[Recorder] No data to download.");
      return;
    }

    const json = JSON.stringify(this.records, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `opendisaster-recording-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    console.log(`[Recorder] Downloaded ${this.records.length} steps.`);
  }

  get stepCount(): number {
    return this.records.length;
  }
}
