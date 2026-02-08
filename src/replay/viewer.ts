import { listSessions, getSession, deleteSession } from "./storage.ts";
import type { ReplaySession, ReplayFrame } from "./types.ts";

class ReplayViewer {
  private session: ReplaySession | null = null;
  private currentAgent = 0;
  private currentStep = 0;
  private playing = false;
  private speed = 1;
  private playInterval: ReturnType<typeof setInterval> | null = null;

  // DOM elements
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private vlmLog: HTMLElement;
  private agentSelect: HTMLSelectElement;
  private sessionSelect: HTMLSelectElement;
  private playBtn: HTMLButtonElement;
  private speedBtn: HTMLButtonElement;
  private stepLabel: HTMLElement;
  private timeline: HTMLInputElement;
  private statePanel: HTMLElement;
  private deleteBtn: HTMLButtonElement;

  constructor() {
    this.canvas = document.getElementById("pov-canvas") as HTMLCanvasElement;
    this.ctx = this.canvas.getContext("2d")!;
    this.vlmLog = document.getElementById("vlm-log")!;
    this.agentSelect = document.getElementById("agent-select") as HTMLSelectElement;
    this.sessionSelect = document.getElementById("session-select") as HTMLSelectElement;
    this.playBtn = document.getElementById("play-btn") as HTMLButtonElement;
    this.speedBtn = document.getElementById("speed-btn") as HTMLButtonElement;
    this.stepLabel = document.getElementById("step-label")!;
    this.timeline = document.getElementById("timeline") as HTMLInputElement;
    this.statePanel = document.getElementById("state-panel")!;
    this.deleteBtn = document.getElementById("delete-btn") as HTMLButtonElement;

    this.bindEvents();
    this.loadSessionList();
  }

  private bindEvents(): void {
    this.sessionSelect.addEventListener("change", () => this.onSessionChange());
    this.agentSelect.addEventListener("change", () => {
      this.currentAgent = parseInt(this.agentSelect.value);
      this.renderFrame();
    });
    this.playBtn.addEventListener("click", () => this.togglePlay());
    this.speedBtn.addEventListener("click", () => this.cycleSpeed());
    this.timeline.addEventListener("input", () => {
      this.currentStep = parseInt(this.timeline.value);
      this.renderFrame();
    });
    this.deleteBtn.addEventListener("click", () => this.onDelete());

    // Keyboard shortcuts
    document.addEventListener("keydown", (e) => {
      if (e.target instanceof HTMLSelectElement || e.target instanceof HTMLInputElement) return;
      switch (e.code) {
        case "Space":
          e.preventDefault();
          this.togglePlay();
          break;
        case "ArrowLeft":
          e.preventDefault();
          this.stepBack();
          break;
        case "ArrowRight":
          e.preventDefault();
          this.stepForward();
          break;
        case "Digit1":
          this.setSpeed(1);
          break;
        case "Digit2":
          this.setSpeed(2);
          break;
        case "Digit4":
          this.setSpeed(4);
          break;
      }
    });
  }

  private async loadSessionList(): Promise<void> {
    console.log("[ReplayViewer] Loading session list...");
    const sessions = await listSessions();
    console.log("[ReplayViewer] Sessions found:", sessions.length);
    this.sessionSelect.innerHTML = "";

    if (sessions.length === 0) {
      const opt = document.createElement("option");
      opt.textContent = "No sessions recorded";
      opt.disabled = true;
      this.sessionSelect.appendChild(opt);
      return;
    }

    for (const s of sessions) {
      const opt = document.createElement("option");
      opt.value = s.sessionId;
      const date = new Date(s.startTime);
      const timeStr = date.toLocaleString();
      opt.textContent = `${s.location} - ${timeStr} (${s.totalSteps} steps)`;
      this.sessionSelect.appendChild(opt);
    }

    // Auto-load first session
    await this.onSessionChange();
  }

  private async onSessionChange(): Promise<void> {
    this.stopPlay();
    const id = this.sessionSelect.value;
    if (!id) return;

    const session = await getSession(id);
    if (!session) return;

    this.session = session;
    this.currentStep = 1;
    this.currentAgent = 0;

    // Populate agent selector
    this.agentSelect.innerHTML = "";
    for (const agent of session.agents) {
      const opt = document.createElement("option");
      opt.value = String(session.agents.indexOf(agent));
      const color = `#${agent.color.toString(16).padStart(6, "0")}`;
      opt.textContent = agent.name;
      opt.style.color = color;
      this.agentSelect.appendChild(opt);
    }

    // Set timeline range
    this.timeline.min = "1";
    this.timeline.max = String(session.totalSteps);
    this.timeline.value = "1";

    this.renderFrame();
    this.renderVLMHistory();
  }

  private async onDelete(): Promise<void> {
    if (!this.session) return;
    if (!confirm(`Delete session "${this.session.location}"?`)) return;
    await deleteSession(this.session.sessionId);
    this.session = null;
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.vlmLog.innerHTML = "";
    this.statePanel.innerHTML = "";
    this.stepLabel.textContent = "No session";
    await this.loadSessionList();
  }

  private getFramesForAgent(agentIndex: number): ReplayFrame[] {
    if (!this.session) return [];
    return this.session.frames
      .filter((f) => f.agentIndex === agentIndex)
      .sort((a, b) => a.step - b.step);
  }

  private getFrameAt(agentIndex: number, step: number): ReplayFrame | undefined {
    if (!this.session) return undefined;
    // Find closest frame at or before this step
    let best: ReplayFrame | undefined;
    for (const f of this.session.frames) {
      if (f.agentIndex === agentIndex && f.step <= step) {
        if (!best || f.step > best.step) best = f;
      }
    }
    return best;
  }

  private renderFrame(): void {
    if (!this.session) return;

    const frame = this.getFrameAt(this.currentAgent, this.currentStep);
    this.stepLabel.textContent = `Step ${this.currentStep} / ${this.session.totalSteps}`;
    this.timeline.value = String(this.currentStep);

    if (!frame) {
      this.ctx.fillStyle = "#1a1a2e";
      this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
      this.ctx.fillStyle = "#666";
      this.ctx.font = "16px monospace";
      this.ctx.textAlign = "center";
      this.ctx.fillText("No frame at this step", this.canvas.width / 2, this.canvas.height / 2);
      this.statePanel.innerHTML = "";
      return;
    }

    // Draw JPEG frame
    const img = new Image();
    img.onload = () => {
      this.ctx.drawImage(img, 0, 0, this.canvas.width, this.canvas.height);
    };
    img.src = `data:image/jpeg;base64,${frame.frameBase64}`;

    // Update state panel
    const s = frame.state;
    this.statePanel.innerHTML = [
      `<div class="state-row"><span class="state-key">Health</span><span class="state-val">${s.health.toFixed(0)}</span></div>`,
      `<div class="state-row"><span class="state-key">Stamina</span><span class="state-val">${s.stamina.toFixed(0)}</span></div>`,
      `<div class="state-row"><span class="state-key">Panic</span><span class="state-val">${(s.panicLevel * 100).toFixed(0)}%</span></div>`,
      `<div class="state-row"><span class="state-key">Status</span><span class="state-val ${s.alive ? "" : "dead"}">${s.alive ? "Alive" : "Dead"}</span></div>`,
      `<div class="state-row"><span class="state-key">Position</span><span class="state-val">(${s.positionX.toFixed(1)}, ${s.positionZ.toFixed(1)})</span></div>`,
    ].join("");

    // Scroll VLM log to current step
    this.scrollVLMTo(frame.step);
  }

  private renderVLMHistory(): void {
    if (!this.session) return;

    const frames = this.getFramesForAgent(this.currentAgent);
    const entries = frames
      .filter((f) => f.vlmOutput)
      .map((f) => {
        const v = f.vlmOutput!;
        return `<div class="vlm-entry" data-step="${f.step}">` +
          `<div class="vlm-header">Step ${f.step} (${f.simTime.toFixed(0)}s)</div>` +
          `<div class="vlm-obs">${v.observation}</div>` +
          (v.reasoning ? `<div class="vlm-reason">${v.reasoning}</div>` : "") +
          `<div class="vlm-action">Action: ${v.action}</div>` +
          `</div>`;
      });

    this.vlmLog.innerHTML = entries.length > 0
      ? entries.join("")
      : '<div class="vlm-empty">No VLM data for this agent</div>';
  }

  private scrollVLMTo(step: number): void {
    const entry = this.vlmLog.querySelector(`[data-step="${step}"]`) as HTMLElement | null;
    if (entry) {
      entry.scrollIntoView({ behavior: "smooth", block: "nearest" });
      // Highlight current
      this.vlmLog.querySelectorAll(".vlm-entry").forEach((el) => el.classList.remove("active"));
      entry.classList.add("active");
    }
  }

  private togglePlay(): void {
    if (this.playing) {
      this.stopPlay();
    } else {
      this.startPlay();
    }
  }

  private startPlay(): void {
    if (!this.session) return;
    this.playing = true;
    this.playBtn.textContent = "Pause";
    this.playInterval = setInterval(() => {
      if (!this.session) return;
      if (this.currentStep >= this.session.totalSteps) {
        this.stopPlay();
        return;
      }
      this.currentStep++;
      this.renderFrame();
    }, 1000 / this.speed);
  }

  private stopPlay(): void {
    this.playing = false;
    this.playBtn.textContent = "Play";
    if (this.playInterval) {
      clearInterval(this.playInterval);
      this.playInterval = null;
    }
  }

  private cycleSpeed(): void {
    const speeds = [1, 2, 4];
    const idx = speeds.indexOf(this.speed);
    this.speed = speeds[(idx + 1) % speeds.length]!;
    this.speedBtn.textContent = `${this.speed}x`;
    if (this.playing) {
      this.stopPlay();
      this.startPlay();
    }
  }

  private setSpeed(s: number): void {
    this.speed = s;
    this.speedBtn.textContent = `${s}x`;
    if (this.playing) {
      this.stopPlay();
      this.startPlay();
    }
  }

  private stepForward(): void {
    if (!this.session || this.currentStep >= this.session.totalSteps) return;
    this.currentStep++;
    this.renderFrame();
  }

  private stepBack(): void {
    if (!this.session || this.currentStep <= 1) return;
    this.currentStep--;
    this.renderFrame();
  }
}

// Initialize when DOM is ready
new ReplayViewer();
