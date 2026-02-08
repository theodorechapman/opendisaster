import * as THREE from "three";
import type { WebGPURenderer } from "three/webgpu";
import type { AgentManager } from "../agents/AgentManager.ts";
import { AgentState, Position, AgentFacing } from "../core/Components.ts";
import type { ReplayRecorder } from "./ReplayRecorder.ts";

const CAPTURE_SIZE = 512;
const JPEG_QUALITY = 0.5;
const TARGET_FPS = 20;
const MAIN_LOOP_FPS = 60;

/**
 * Round-robin POV capture system for replay video.
 * Captures multiple agents per animation frame to achieve ~20fps per agent.
 * With 8 agents at 60fps main loop: ceil(8 * 20 / 60) = 3 renders per frame.
 */
export class ReplayCaptureSystem {
  private renderer: WebGPURenderer;
  private scene: THREE.Scene;
  private manager: AgentManager;
  private recorder: ReplayRecorder;
  private renderTarget: THREE.RenderTarget;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private nextAgentIdx = 0;
  private startTime: number;

  constructor(
    renderer: WebGPURenderer,
    scene: THREE.Scene,
    manager: AgentManager,
    recorder: ReplayRecorder,
  ) {
    this.renderer = renderer;
    this.scene = scene;
    this.manager = manager;
    this.recorder = recorder;
    this.startTime = performance.now();

    this.renderTarget = new THREE.RenderTarget(CAPTURE_SIZE, CAPTURE_SIZE, {
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
    });

    this.canvas = document.createElement("canvas");
    this.canvas.width = CAPTURE_SIZE;
    this.canvas.height = CAPTURE_SIZE;
    this.ctx = this.canvas.getContext("2d")!;
  }

  /** Capture multiple agents in round-robin to hit ~20fps per agent. Call once per animation frame. */
  async captureNext(): Promise<void> {
    const living = this.manager.getLiving();
    if (living.length === 0) return;

    // How many captures this frame to achieve TARGET_FPS per agent
    const capturesPerFrame = Math.ceil(living.length * TARGET_FPS / MAIN_LOOP_FPS);

    for (let c = 0; c < capturesPerFrame; c++) {
      if (this.nextAgentIdx >= living.length) this.nextAgentIdx = 0;
      const agent = living[this.nextAgentIdx]!;
      this.nextAgentIdx = (this.nextAgentIdx + 1) % living.length;

      await this.captureAgent(agent);
    }
  }

  private async captureAgent(agent: { index: number; eid: number }): Promise<void> {
    const visual = this.manager.visuals.getVisual(agent.index);
    if (!visual) return;

    const eid = agent.eid;

    // Sync position/facing
    visual.mesh.position.set(Position.x[eid]!, Position.y[eid]!, Position.z[eid]!);
    visual.mesh.rotation.y = AgentFacing.yaw[eid]!;

    // Render to offscreen target
    this.renderer.setRenderTarget(this.renderTarget);
    this.renderer.render(this.scene, visual.camera);
    this.renderer.setRenderTarget(null);

    // Read pixels (async in WebGPU)
    const pixelBuffer = await this.renderer.readRenderTargetPixelsAsync(
      this.renderTarget, 0, 0,
      CAPTURE_SIZE, CAPTURE_SIZE,
    );

    // Flip Y and encode to JPEG
    const imageData = this.ctx.createImageData(CAPTURE_SIZE, CAPTURE_SIZE);
    for (let y = 0; y < CAPTURE_SIZE; y++) {
      const srcRow = (CAPTURE_SIZE - 1 - y) * CAPTURE_SIZE * 4;
      const dstRow = y * CAPTURE_SIZE * 4;
      for (let x = 0; x < CAPTURE_SIZE * 4; x++) {
        imageData.data[dstRow + x] = pixelBuffer[srcRow + x]!;
      }
    }
    this.ctx.putImageData(imageData, 0, 0);

    const dataUrl = this.canvas.toDataURL("image/jpeg", JPEG_QUALITY);
    const base64 = dataUrl.split(",")[1]!;

    const simTime = (performance.now() - this.startTime) / 1000;

    this.recorder.recordVideoFrame(agent.index, base64, simTime, {
      health: AgentState.health[eid]!,
      stamina: AgentState.stamina[eid]!,
      panicLevel: AgentState.panicLevel[eid]!,
      alive: AgentState.alive[eid]! === 1,
      positionX: Position.x[eid]!,
      positionZ: Position.z[eid]!,
    });
  }

  dispose(): void {
    this.renderTarget.dispose();
  }
}
