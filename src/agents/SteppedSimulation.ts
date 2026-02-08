import type { SimWorld } from "../core/World.ts";
import type { AgentManager } from "./AgentManager.ts";
import type { AgentPerceptionSystem } from "./AgentPerceptionSystem.ts";
import type { AgentRecorder } from "./AgentRecorder.ts";
import { parseActionType } from "./PromptTemplates.ts";
import type { PerceiveMessage, DecisionResponse, PerceptionPayload } from "./types.ts";
import { AgentState, AgentAction, AgentFacing, Position, ActionType } from "../core/Components.ts";
import type { EventBus, FireSpreadEvent } from "../core/EventBus.ts";
import { agentLog } from "./AgentLogger.ts";
import type { ReplayRecorder } from "../replay/ReplayRecorder.ts";

const ACTION_NAMES = ["IDLE","MOVE_TO","RUN_TO","HELP_PERSON","EVACUATE","WAIT","ENTER_BUILDING","EXIT_BUILDING"];

export interface SteppedSimConfig {
  stepDurationSec: number;  // seconds of sim time per step
  enabled: boolean;
}

interface Snapshot {
  agentName: string;
  step: number;
  simTime: number;
  frameBase64: string;  // JPEG base64
  caption: string;      // VLM observation text
}

/**
 * Orchestrates non-blocking VLM perception.
 * Fires perception requests every stepDurationSec via setInterval.
 * Responses arrive asynchronously via WebSocket and are applied
 * if they are newer than the last applied step for that agent.
 */
export class SteppedSimulation {
  private world: SimWorld;
  private manager: AgentManager;
  private perception: AgentPerceptionSystem;
  private recorder: AgentRecorder;
  private config: SteppedSimConfig;
  private ws: WebSocket | null = null;
  private step = 0;
  private simTime = 0;
  private running = false;
  private snapshots: Snapshot[] = [];
  private static MAX_GALLERY_CARDS = 6;
  /** Periodic tick handle. */
  private tickInterval: ReturnType<typeof setInterval> | null = null;
  /** Guard against overlapping captureAll() calls. */
  private capturing = false;
  /** True while a perceive request is in-flight — prevents stacking VLM calls. */
  private inflight = false;
  /** Per-agent last processed step — used to discard stale responses. */
  private latestAppliedStep = new Map<number, number>();
  /** Frame data stored at send time for snapshot pairing. Key: "agentIndex:step". */
  private pendingPayloads = new Map<string, { payload: PerceptionPayload; simTime: number }>();
  /** Tracked fire sources from EventBus FIRE_SPREAD events. */
  private activeFireSources: { x: number; z: number; radius: number }[] = [];
  /** Replay recorder for persisting session data to IndexedDB. */
  private replayRecorder: ReplayRecorder;

  constructor(
    world: SimWorld,
    manager: AgentManager,
    perception: AgentPerceptionSystem,
    recorder: AgentRecorder,
    eventBus: EventBus,
    replayRecorder: ReplayRecorder,
    config: SteppedSimConfig = { stepDurationSec: 1, enabled: true },
  ) {
    this.world = world;
    this.manager = manager;
    this.perception = perception;
    this.recorder = recorder;
    this.config = config;
    this.replayRecorder = replayRecorder;

    // Subscribe to FIRE_SPREAD events to track fire sources
    eventBus.on("FIRE_SPREAD", (event) => {
      const fire = event as FireSpreadEvent;
      const [fx, _fy, fz] = fire.position;
      // Deduplicate: update radius if same position exists
      const existing = this.activeFireSources.find(
        (s) => Math.abs(s.x - fx) < 1 && Math.abs(s.z - fz) < 1,
      );
      if (existing) {
        existing.radius = Math.max(existing.radius, fire.radius);
      } else {
        this.activeFireSources.push({ x: fx, z: fz, radius: fire.radius });
      }

      // Update all agents' danger zones that match this fire source —
      // ensures zones grow as the fire grows, preventing agents from
      // wandering back into an area that was safe when first recorded.
      for (const agent of this.manager.agents) {
        for (const zone of agent.dangerZones) {
          if (zone.expiresAt < Date.now()) continue;
          const dx = zone.x - fx;
          const dz = zone.z - fz;
          if (dx * dx + dz * dz < 25) { // same fire source (within 5m)
            const newRadius = fire.radius + 10; // generous margin
            if (newRadius > zone.radius) {
              zone.radius = newRadius;
              // Extend expiry since fire is still active
              zone.expiresAt = Date.now() + 60_000;
            }
          }
        }
      }
    });

    // Ctrl+P to download all POV snapshots
    document.addEventListener("keydown", (e) => {
      if (e.ctrlKey && e.key === "p") {
        e.preventDefault();
        this.downloadSnapshots();
      }
    });
  }

  /** Save a POV snapshot paired with its VLM caption. Uses capture-time step/simTime. */
  private saveSnapshot(
    payload: PerceptionPayload,
    observation: string,
    step: number,
    simTime: number,
  ): void {
    this.snapshots.push({
      agentName: payload.name,
      step,
      simTime,
      frameBase64: payload.frameBase64,
      caption: observation,
    });
  }

  /** Update the bottom gallery with the most recent snapshots. */
  private updateGallery(): void {
    const gallery = document.getElementById("snapshot-gallery");
    if (!gallery) return;

    const recent = this.snapshots.slice(-SteppedSimulation.MAX_GALLERY_CARDS);
    gallery.innerHTML = recent
      .map(
        (s) =>
          `<div class="snapshot-card">` +
          `<img src="data:image/jpeg;base64,${s.frameBase64}" alt="${s.agentName} POV" />` +
          `<div class="caption">` +
          `<div class="name">${s.agentName}</div>` +
          `<div class="step-info">Step ${s.step} | ${s.simTime.toFixed(0)}s</div>` +
          `${s.caption}` +
          `</div></div>`,
      )
      .join("");

    // Auto-scroll to the right
    gallery.scrollLeft = gallery.scrollWidth;
  }

  /** Download all snapshots as individual captioned images. */
  private async downloadSnapshots(): Promise<void> {
    if (this.snapshots.length === 0) {
      console.log("[Snapshots] No snapshots to download.");
      return;
    }

    // Create a canvas for compositing image + caption
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d")!;
    const imgSize = 512;
    const captionHeight = 80;
    canvas.width = imgSize;
    canvas.height = imgSize + captionHeight;

    for (const snap of this.snapshots) {
      // Draw the POV image
      const img = new Image();
      img.src = `data:image/jpeg;base64,${snap.frameBase64}`;
      await new Promise<void>((resolve) => {
        img.onload = () => resolve();
      });

      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, imgSize, imgSize);

      // Draw caption bar
      ctx.fillStyle = "rgba(0,0,0,0.85)";
      ctx.fillRect(0, imgSize, imgSize, captionHeight);
      ctx.fillStyle = "#4fc3f7";
      ctx.font = "bold 14px monospace";
      ctx.fillText(`${snap.agentName} — Step ${snap.step} (${snap.simTime.toFixed(0)}s)`, 8, imgSize + 18);
      ctx.fillStyle = "#ccc";
      ctx.font = "12px monospace";

      // Word-wrap the caption
      const words = snap.caption.split(" ");
      let line = "";
      let y = imgSize + 36;
      for (const word of words) {
        const test = line + word + " ";
        if (ctx.measureText(test).width > imgSize - 16) {
          ctx.fillText(line, 8, y);
          line = word + " ";
          y += 15;
          if (y > imgSize + captionHeight - 4) break;
        } else {
          line = test;
        }
      }
      if (y <= imgSize + captionHeight - 4) ctx.fillText(line, 8, y);

      // Download
      const dataUrl = canvas.toDataURL("image/png");
      const a = document.createElement("a");
      a.href = dataUrl;
      a.download = `snapshot-${snap.agentName}-step${snap.step}.png`;
      a.click();
    }

    console.log(`[Snapshots] Downloaded ${this.snapshots.length} snapshots.`);
  }

  /** Connect to the WebSocket server for API proxying. */
  private connectWebSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      const protocol = location.protocol === "https:" ? "wss:" : "ws:";
      this.ws = new WebSocket(`${protocol}//${location.host}/ws`);

      this.ws.onopen = () => {
        console.log("[SteppedSim] WebSocket connected");
        agentLog.setWs(this.ws);
        resolve();
      };

      this.ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.type === "decisions") {
          this.handleDecisions(msg.step, msg.decisions);
        }
      };

      this.ws.onerror = (err) => {
        console.error("[SteppedSim] WebSocket error:", err);
        reject(err);
      };

      this.ws.onclose = () => {
        console.log("[SteppedSim] WebSocket closed");
        agentLog.setWs(null);
        this.ws = null;
      };
    });
  }

  /** Start the stepped simulation loop. */
  async start(): Promise<void> {
    if (!this.config.enabled) {
      console.log("[SteppedSim] Disabled, running free-form simulation");
      return;
    }

    try {
      await this.connectWebSocket();
    } catch {
      console.warn("[SteppedSim] Could not connect WebSocket. Running without AI decisions.");
      return;
    }

    this.running = true;
    console.log("[Agents] Stepped simulation started (non-blocking)");
    this.tickInterval = setInterval(() => this.tick(), this.config.stepDurationSec * 1000);
  }

  /** Stop the simulation loop and save replay. */
  async stop(): Promise<void> {
    this.running = false;
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }
    this.ws?.close();
    await this.replayRecorder.finalize();
  }

  /** Fires every stepDurationSec. Captures frames and sends fire-and-forget WS message. */
  private async tick(): Promise<void> {
    if (!this.running) return;

    // Guard against overlapping captures
    if (this.capturing) return;
    this.capturing = true;

    try {
      this.simTime += this.config.stepDurationSec;

      // Sync visuals before capture
      this.manager.syncVisuals();

      // Capture perception frames for all living agents
      const living = this.manager.getLiving();
      if (living.length === 0) {
        console.log("[SteppedSim] All agents dead. Stopping.");
        this.stop();
        return;
      }

      const payloads = await this.perception.captureAll();
      this.step++;
      const captureSimTime = this.simTime;

      // Store payloads for snapshot pairing when response arrives
      for (const p of payloads) {
        this.pendingPayloads.set(`${p.agentIndex}:${this.step}`, {
          payload: p,
          simTime: captureSimTime,
        });
      }

      // Log every agent's state at capture time
      for (const p of payloads) {
        const agent = this.manager.agents[p.agentIndex];
        if (!agent) continue;
        const eid = agent.eid;
        const curAction = AgentAction.actionType[eid]! as ActionType;
        agentLog.log("tick", p.name, {
          step: this.step,
          simTime: captureSimTime,
          positionX: p.state.positionX,
          positionZ: p.state.positionZ,
          facingYaw: p.state.facingYaw,
          action: ACTION_NAMES[curAction] ?? curAction,
          targetX: AgentAction.targetX[eid]!,
          targetZ: AgentAction.targetZ[eid]!,
          health: p.state.health,
          stamina: p.state.stamina,
        });
      }

      // Send to server if WS is open, we have payloads, and no request in-flight
      if (!this.inflight && payloads.length > 0 && this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.inflight = true;
        const msg: PerceiveMessage = {
          type: "perceive",
          step: this.step,
          payloads: payloads,
        };
        this.ws.send(JSON.stringify(msg));
      }

      // Update HUD every tick regardless of response
      this.updateHUD();

      // Prune old pending payloads
      this.gcPendingPayloads();
    } catch (err) {
      console.error(`[SteppedSim] Tick ${this.step} failed:`, err);
    } finally {
      this.capturing = false;
    }
  }

  /** Handle VLM decisions arriving asynchronously from the server. */
  private handleDecisions(step: number, decisions: DecisionResponse[]): void {
    this.inflight = false;

    const obsMap = new Map<number, string>();
    const decMap = new Map<number, { reasoning: string; action: string }>();

    for (const dec of decisions) {
      const lastStep = this.latestAppliedStep.get(dec.agentIndex) ?? 0;
      const agent = this.manager.agents[dec.agentIndex];
      const agentName = agent?.config.name ?? `agent#${dec.agentIndex}`;

      // Discard stale responses
      if (step <= lastStep) {
        agentLog.log("vlm_stale", agentName, { step, lastApplied: lastStep });
        continue;
      }
      this.latestAppliedStep.set(dec.agentIndex, step);

      // Log current ECS state vs what VLM decided
      if (agent) {
        const eid = agent.eid;
        agentLog.log("vlm_decision_received", agentName, {
          step,
          vlmAction: dec.action,
          observation: dec.observation,
          positionX: Position.x[eid]!,
          positionZ: Position.z[eid]!,
          facingYaw: AgentFacing.yaw[eid]!,
        });
      }

      // Always store observation in memory + record data
      this.manager.addObservation(dec.agentIndex, dec.observation);
      obsMap.set(dec.agentIndex, dec.observation);
      decMap.set(dec.agentIndex, { reasoning: dec.reasoning, action: dec.action });

      // Attach VLM output to replay session
      this.replayRecorder.attachVLM(dec.agentIndex, step, this.simTime, {
        observation: dec.observation,
        reasoning: dec.reasoning,
        action: dec.action,
      });

      // Save snapshot using the frame captured at send time
      const pendingKey = `${dec.agentIndex}:${step}`;
      const pending = this.pendingPayloads.get(pendingKey);
      if (pending) {
        this.saveSnapshot(pending.payload, dec.observation, step, pending.simTime);
      }

      // Apply action: RUN_TO for danger (180° flee), WANDER = keep auto-wandering
      if (dec.action === "RUN_TO") {
        agentLog.log("danger_flee", agentName, {
          step,
          observation: dec.observation,
          targetX: dec.targetX,
          targetZ: dec.targetZ,
        });
        this.manager.addDecision(dec.agentIndex, `FLEE: ${dec.reasoning}`);
        this.manager.applyAction(dec.agentIndex, {
          actionType: parseActionType(dec.action),
          targetX: dec.targetX,
          targetZ: dec.targetZ,
          targetEid: dec.targetEntity,
        });

        // Create per-agent danger zone based on VLM perception
        if (agent) {
          const eid = agent.eid;
          const px = Position.x[eid]!;
          const pz = Position.z[eid]!;
          const yaw = AgentFacing.yaw[eid]!;
          const facingX = Math.sin(yaw);
          const facingZ = Math.cos(yaw);

          // Find nearest fire source within ~120° forward cone
          let bestFire: { x: number; z: number; radius: number } | null = null;
          let bestDist = Infinity;
          for (const fire of this.activeFireSources) {
            const dx = fire.x - px;
            const dz = fire.z - pz;
            const dist = Math.sqrt(dx * dx + dz * dz);
            if (dist < 0.01) continue;
            // Dot product with facing direction (normalized)
            const dot = (dx / dist) * facingX + (dz / dist) * facingZ;
            if (dot > -0.1 && dist < bestDist) {
              bestDist = dist;
              bestFire = fire;
            }
          }

          if (bestFire) {
            agent.dangerZones.push({
              x: bestFire.x,
              z: bestFire.z,
              radius: bestFire.radius + 10,
              expiresAt: Date.now() + 60_000,
            });
            agentLog.log("danger_zone_added", agentName, {
              fireX: bestFire.x, fireZ: bestFire.z,
              radius: bestFire.radius + 10, source: "fire_match",
            });
          } else {
            // No tracked fire in facing direction — estimate 15m ahead
            const estX = px + facingX * 15;
            const estZ = pz + facingZ * 15;
            agent.dangerZones.push({
              x: estX,
              z: estZ,
              radius: 10,
              expiresAt: Date.now() + 60_000,
            });
            agentLog.log("danger_zone_added", agentName, {
              estX, estZ, radius: 10, source: "estimated",
            });
          }
        }
      }
      // WANDER with active danger zones → override to flee away from known threats
      if (agent && agent.dangerZones.length > 0) {
        const activeZones = agent.dangerZones.filter(z => z.expiresAt > Date.now());
        if (activeZones.length > 0) {
          const eid = agent.eid;
          const px = Position.x[eid]!;
          const pz = Position.z[eid]!;

          // Compute average flee direction (away from all danger zone centers)
          let fleeX = 0;
          let fleeZ = 0;
          for (const zone of activeZones) {
            const dx = px - zone.x;
            const dz = pz - zone.z;
            const dist = Math.sqrt(dx * dx + dz * dz) || 1;
            // Weight inversely by distance — closer danger = stronger push
            const weight = 1 / dist;
            fleeX += (dx / dist) * weight;
            fleeZ += (dz / dist) * weight;
          }
          const fleeMag = Math.sqrt(fleeX * fleeX + fleeZ * fleeZ) || 1;
          fleeX /= fleeMag;
          fleeZ /= fleeMag;

          // Target: 50m in the flee direction, clamped to scene bounds
          const fleeTargetX = px + fleeX * 50;
          const fleeTargetZ = pz + fleeZ * 50;

          agentLog.log("wander_override_flee", agentName, {
            step,
            dangerZones: activeZones.length,
            targetX: fleeTargetX,
            targetZ: fleeTargetZ,
          });
          this.manager.addDecision(dec.agentIndex, `FLEE (override): ${dec.reasoning}`);
          this.manager.applyAction(dec.agentIndex, {
            actionType: ActionType.RUN_TO,
            targetX: fleeTargetX,
            targetZ: fleeTargetZ,
            targetEid: 0,
          });
        }
      }
    }

    // Record step
    this.recorder.recordStep(step, this.simTime, obsMap, decMap);

    // Update gallery with new snapshots
    this.updateGallery();
  }

  /** Prune pendingPayloads entries older than 20 steps. */
  private gcPendingPayloads(): void {
    const cutoff = this.step - 20;
    for (const key of this.pendingPayloads.keys()) {
      const stepNum = parseInt(key.split(":")[1]!, 10);
      if (stepNum < cutoff) {
        this.pendingPayloads.delete(key);
      }
    }
  }

  /** Update the agent status HUD. */
  private updateHUD(): void {
    const hud = document.getElementById("agent-hud");
    if (!hud) return;

    const lines = this.manager.agents.map((agent) => {
      const eid = agent.eid;
      const alive = AgentState.alive[eid]! === 1;
      const hp = AgentState.health[eid]!.toFixed(0);
      const stam = AgentState.stamina[eid]!.toFixed(0);
      const panic = (AgentState.panicLevel[eid]! * 100).toFixed(0);
      const status = alive ? `HP:${hp} ST:${stam} P:${panic}%` : "DEAD";
      return `<div class="agent-row ${alive ? "" : "dead"}">${agent.config.name}: ${status}</div>`;
    });

    hud.innerHTML = `<div class="agent-header">Step ${this.step} | ${this.simTime.toFixed(0)}s</div>${lines.join("")}`;
  }
}
