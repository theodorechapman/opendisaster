import * as THREE from "three";
import type { AgentManager } from "./AgentManager.ts";
import { AgentState, Position, AgentFacing } from "../core/Components.ts";
import type { PerceptionPayload } from "./types.ts";

const RENDER_SIZE = 256;

/**
 * Renders first-person views for each living agent using a shared WebGLRenderTarget.
 * Returns base64-encoded JPEG frames for VLM consumption.
 */
export class AgentPerceptionSystem {
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private manager: AgentManager;
  private renderTarget: THREE.WebGLRenderTarget;
  private pixelBuffer: Uint8Array;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;

  constructor(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    manager: AgentManager,
  ) {
    this.renderer = renderer;
    this.scene = scene;
    this.manager = manager;

    this.renderTarget = new THREE.WebGLRenderTarget(RENDER_SIZE, RENDER_SIZE, {
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
    });

    this.pixelBuffer = new Uint8Array(RENDER_SIZE * RENDER_SIZE * 4);

    // Use a hidden canvas for JPEG encoding
    this.canvas = document.createElement("canvas");
    this.canvas.width = RENDER_SIZE;
    this.canvas.height = RENDER_SIZE;
    this.ctx = this.canvas.getContext("2d")!;
  }

  /** Capture first-person frames for all living agents. */
  async captureAll(): Promise<PerceptionPayload[]> {
    const payloads: PerceptionPayload[] = [];
    const living = this.manager.getLiving();

    for (const agent of living) {
      const visual = this.manager.visuals.getVisual(agent.index);
      if (!visual) continue;

      const eid = agent.eid;

      // Sync position and facing from ECS — group rotation drives both mesh and camera
      visual.mesh.position.set(Position.x[eid]!, Position.y[eid]!, Position.z[eid]!);
      visual.mesh.rotation.y = AgentFacing.yaw[eid]!;

      // Hide agent's own mesh so it doesn't appear in its own view
      visual.mesh.visible = false;

      // Render to offscreen target
      this.renderer.setRenderTarget(this.renderTarget);
      this.renderer.render(this.scene, visual.camera);
      this.renderer.setRenderTarget(null);

      // Read pixels
      this.renderer.readRenderTargetPixels(
        this.renderTarget,
        0, 0,
        RENDER_SIZE, RENDER_SIZE,
        this.pixelBuffer,
      );

      // Restore visibility
      visual.mesh.visible = true;

      // Flip Y and put into canvas (WebGL reads bottom-to-top)
      const imageData = this.ctx.createImageData(RENDER_SIZE, RENDER_SIZE);
      for (let y = 0; y < RENDER_SIZE; y++) {
        const srcRow = (RENDER_SIZE - 1 - y) * RENDER_SIZE * 4;
        const dstRow = y * RENDER_SIZE * 4;
        for (let x = 0; x < RENDER_SIZE * 4; x++) {
          imageData.data[dstRow + x] = this.pixelBuffer[srcRow + x]!;
        }
      }
      this.ctx.putImageData(imageData, 0, 0);

      // Encode as JPEG base64 via canvas toDataURL
      const dataUrl = this.canvas.toDataURL("image/jpeg", 0.7);
      const base64 = dataUrl.split(",")[1]!;

      payloads.push({
        agentIndex: agent.index,
        frameBase64: base64,
        state: {
          health: AgentState.health[eid]!,
          stamina: AgentState.stamina[eid]!,
          panicLevel: AgentState.panicLevel[eid]!,
          injured: AgentState.injured[eid]!,
          positionX: Position.x[eid]!,
          positionZ: Position.z[eid]!,
          facingYaw: AgentFacing.yaw[eid]!,
        },
        memory: agent.memory,
        personality: agent.config.personality,
        name: agent.config.name,
      });
    }

    return payloads;
  }

  dispose(): void {
    this.renderTarget.dispose();
  }
}
