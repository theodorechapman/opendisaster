import type { ReplayFrame, ReplaySession } from "./types.ts";
import { saveSession } from "./storage.ts";
import type { AgentManager } from "../agents/AgentManager.ts";
import type { PerceptionPayload } from "../agents/types.ts";
import { AgentState } from "../core/Components.ts";

const BATCH_INTERVAL = 30; // flush partial data every N steps as crash safety

export class ReplayRecorder {
  private frames: ReplayFrame[] = [];
  private sessionId: string;
  private startTime: number;
  private location: string;
  private manager: AgentManager;
  private stepsSinceFlush = 0;

  constructor(manager: AgentManager, location: string) {
    this.manager = manager;
    this.location = location;
    this.sessionId = `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.startTime = Date.now();
    console.log(`[ReplayRecorder] Created: ${this.sessionId}, location: "${location}"`);
  }

  /** Record a POV frame + ECS state for one agent at the current step. */
  recordFrame(payload: PerceptionPayload, step: number, simTime: number): void {
    const eid = this.manager.agents[payload.agentIndex]?.eid;
    const frame: ReplayFrame = {
      agentIndex: payload.agentIndex,
      agentName: payload.name,
      step,
      simTime,
      frameBase64: payload.frameBase64,
      state: {
        health: payload.state.health,
        stamina: payload.state.stamina,
        panicLevel: payload.state.panicLevel,
        alive: eid !== undefined ? AgentState.alive[eid]! === 1 : true,
        positionX: payload.state.positionX,
        positionZ: payload.state.positionZ,
      },
    };
    this.frames.push(frame);
    if (this.frames.length % 16 === 1) {
      console.log(`[ReplayRecorder] ${this.frames.length} frames recorded (step ${step})`);
    }

    this.stepsSinceFlush++;
    if (this.stepsSinceFlush >= BATCH_INTERVAL) {
      this.stepsSinceFlush = 0;
      this.flushPartial();
    }
  }

  /** Pair VLM output with an existing frame. */
  attachVLM(
    agentIndex: number,
    step: number,
    vlmOutput: { observation: string; reasoning: string; action: string },
  ): void {
    // Search backwards — most recent match is likely near the end
    for (let i = this.frames.length - 1; i >= 0; i--) {
      const f = this.frames[i]!;
      if (f.agentIndex === agentIndex && f.step === step) {
        f.vlmOutput = vlmOutput;
        return;
      }
    }
  }

  /** Write the complete session to IndexedDB. */
  async finalize(): Promise<void> {
    const agents = this.manager.agents.map((a) => ({
      name: a.config.name,
      color: a.config.color,
    }));

    const maxStep = this.frames.reduce((max, f) => Math.max(max, f.step), 0);

    const session: ReplaySession = {
      sessionId: this.sessionId,
      location: this.location,
      startTime: this.startTime,
      endTime: Date.now(),
      totalSteps: maxStep,
      agents,
      frames: this.frames,
    };

    try {
      await saveSession(session);
      console.log(`[Replay] Session saved: ${this.sessionId} (${this.frames.length} frames, ${maxStep} steps)`);
    } catch (err) {
      console.error("[Replay] Failed to save session:", err);
    }
  }

  /** Crash-safety: save partial session to IndexedDB periodically. */
  private async flushPartial(): Promise<void> {
    try {
      const agents = this.manager.agents.map((a) => ({
        name: a.config.name,
        color: a.config.color,
      }));
      const maxStep = this.frames.reduce((max, f) => Math.max(max, f.step), 0);
      const session: ReplaySession = {
        sessionId: this.sessionId,
        location: this.location,
        startTime: this.startTime,
        endTime: Date.now(),
        totalSteps: maxStep,
        agents,
        frames: [...this.frames],
      };
      await saveSession(session);
    } catch {
      // Silent — this is just a safety net
    }
  }
}
