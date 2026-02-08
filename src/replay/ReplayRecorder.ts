import type { ReplayVideoFrame, ReplayVLMEntry, ReplaySession } from "./types.ts";
import { saveSession, saveFramesBatch } from "./storage.ts";
import type { AgentManager } from "../agents/AgentManager.ts";

const BATCH_SIZE = 30;

export class ReplayRecorder {
  private frameBuffer: ReplayVideoFrame[] = [];
  private vlmEntries: ReplayVLMEntry[] = [];
  private sessionId: string;
  private startTime: number;
  private location: string;
  private manager: AgentManager;
  private simStartPerf: number;

  constructor(manager: AgentManager, location: string) {
    this.manager = manager;
    this.location = location;
    this.sessionId = `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.startTime = Date.now();
    this.simStartPerf = performance.now();
    console.log(`[ReplayRecorder] Created: ${this.sessionId}, location: "${location}"`);
  }

  getSessionId(): string {
    return this.sessionId;
  }

  /** Record a video frame from the capture system. Batches writes to IndexedDB. */
  recordVideoFrame(
    agentIndex: number,
    frameBase64: string,
    simTime: number,
    state: ReplayVideoFrame["state"],
  ): void {
    this.frameBuffer.push({
      sessionId: this.sessionId,
      agentIndex,
      time: simTime,
      frameBase64,
      state,
    });

    if (this.frameBuffer.length >= BATCH_SIZE) {
      this.flushFrames();
    }
  }

  /** Store a VLM decision entry (separate from video frames). */
  attachVLM(
    agentIndex: number,
    step: number,
    simTime: number,
    vlmOutput: { observation: string; reasoning: string; action: string },
  ): void {
    this.vlmEntries.push({
      agentIndex,
      step,
      simTime,
      observation: vlmOutput.observation,
      reasoning: vlmOutput.reasoning,
      action: vlmOutput.action,
    });
  }

  /** Flush remaining frames and save session metadata + VLM entries. */
  async finalize(): Promise<void> {
    // Flush any remaining buffered frames
    await this.flushFrames();

    const agents = this.manager.agents.map((a) => ({
      name: a.config.name,
      color: a.config.color,
    }));

    const durationSec = (performance.now() - this.simStartPerf) / 1000;

    const session: ReplaySession = {
      sessionId: this.sessionId,
      location: this.location,
      startTime: this.startTime,
      endTime: Date.now(),
      durationSec,
      agents,
      vlmEntries: this.vlmEntries,
    };

    try {
      await saveSession(session);
      console.log(`[Replay] Session saved: ${this.sessionId} (${this.vlmEntries.length} VLM entries, ${durationSec.toFixed(1)}s)`);
    } catch (err) {
      console.error("[Replay] Failed to save session:", err);
    }
  }

  /** Flush buffered frames to IndexedDB. */
  private async flushFrames(): Promise<void> {
    if (this.frameBuffer.length === 0) return;
    const batch = this.frameBuffer.splice(0);
    try {
      await saveFramesBatch(batch);
    } catch (err) {
      console.error("[Replay] Failed to flush frame batch:", err);
    }
  }
}
