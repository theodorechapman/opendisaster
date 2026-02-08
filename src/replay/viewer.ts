import { listSessions, getSession, getFramesForAgent, deleteSession, saveSession } from "./storage.ts";
import type { ReplaySession, ReplayVideoFrame, ReplayVLMEntry, ReplayAudioClip } from "./types.ts";

class ReplayViewer {
  private session: ReplaySession | null = null;
  private frames: ReplayVideoFrame[] = []; // frames for current agent
  private currentAgent = 0;
  private playbackTime = 0; // seconds
  private playing = false;
  private speed = 1;
  private rafId: number | null = null;
  private lastRafTime = 0;

  // DOM elements
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private vlmLog: HTMLElement;
  private agentSelect: HTMLSelectElement;
  private sessionSelect: HTMLSelectElement;
  private playBtn: HTMLButtonElement;
  private speedBtn: HTMLButtonElement;
  private timeLabel: HTMLElement;
  private timeline: HTMLInputElement;
  private statePanel: HTMLElement;
  private deleteBtn: HTMLButtonElement;
  private audioBtn: HTMLButtonElement;

  // Preloaded images for smooth playback
  private preloadedImages = new Map<number, HTMLImageElement>();
  private loadingFrames = false;

  // Audio narration state
  private audioGenerationId = 0; // to discard stale results
  private audioCtx: AudioContext | null = null;
  private decodedClips: { simTime: number; dialogue: string; buffer: AudioBuffer }[] = [];
  private scheduledTimeouts: number[] = [];
  private activeSource: AudioBufferSourceNode | null = null;

  constructor() {
    this.canvas = document.getElementById("pov-canvas") as HTMLCanvasElement;
    this.ctx = this.canvas.getContext("2d")!;
    this.vlmLog = document.getElementById("vlm-log")!;
    this.agentSelect = document.getElementById("agent-select") as HTMLSelectElement;
    this.sessionSelect = document.getElementById("session-select") as HTMLSelectElement;
    this.playBtn = document.getElementById("play-btn") as HTMLButtonElement;
    this.speedBtn = document.getElementById("speed-btn") as HTMLButtonElement;
    this.timeLabel = document.getElementById("step-label")!;
    this.timeline = document.getElementById("timeline") as HTMLInputElement;
    this.statePanel = document.getElementById("state-panel")!;
    this.deleteBtn = document.getElementById("delete-btn") as HTMLButtonElement;
    this.audioBtn = document.getElementById("audio-btn") as HTMLButtonElement;

    this.bindEvents();
    this.loadSessionList();
  }

  private bindEvents(): void {
    this.sessionSelect.addEventListener("change", () => this.onSessionChange());
    this.agentSelect.addEventListener("change", () => {
      this.currentAgent = parseInt(this.agentSelect.value);
      this.clearAudio();
      this.loadAgentFrames();
    });
    this.playBtn.addEventListener("click", () => this.togglePlay());
    this.speedBtn.addEventListener("click", () => this.cycleSpeed());
    this.audioBtn.addEventListener("click", () => this.generateAudio());
    this.timeline.addEventListener("input", () => {
      this.playbackTime = parseFloat(this.timeline.value);
      if (this.playing) this.scheduleAudio();
      else this.cancelScheduledAudio();
      this.renderFrame();
    });
    this.deleteBtn.addEventListener("click", () => this.onDelete());

    document.addEventListener("keydown", (e) => {
      if (e.target instanceof HTMLSelectElement || e.target instanceof HTMLInputElement) return;
      switch (e.code) {
        case "Space":
          e.preventDefault();
          this.togglePlay();
          break;
        case "ArrowLeft":
          e.preventDefault();
          this.seekRelative(-0.5);
          break;
        case "ArrowRight":
          e.preventDefault();
          this.seekRelative(0.5);
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
    const sessions = await listSessions();
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
      const dur = s.durationSec.toFixed(0);
      opt.textContent = `${s.location} - ${timeStr} (${dur}s)`;
      this.sessionSelect.appendChild(opt);
    }

    await this.onSessionChange();
  }

  private async onSessionChange(): Promise<void> {
    this.stopPlay();
    this.clearAudio();
    const id = this.sessionSelect.value;
    if (!id) return;

    const session = await getSession(id);
    if (!session) return;

    this.session = session;
    this.playbackTime = 0;
    this.currentAgent = 0;

    // Populate agent selector
    this.agentSelect.innerHTML = "";
    for (let i = 0; i < session.agents.length; i++) {
      const agent = session.agents[i]!;
      const opt = document.createElement("option");
      opt.value = String(i);
      const color = `#${agent.color.toString(16).padStart(6, "0")}`;
      opt.textContent = agent.name;
      opt.style.color = color;
      this.agentSelect.appendChild(opt);
    }

    // Set timeline range (in seconds, step 0.1)
    this.timeline.min = "0";
    this.timeline.max = String(session.durationSec);
    this.timeline.step = "0.1";
    this.timeline.value = "0";

    await this.loadAgentFrames();
    this.renderVLMHistory();
    this.loadCachedAudio();
  }

  private async loadAgentFrames(): Promise<void> {
    if (!this.session) return;
    this.loadingFrames = true;
    this.preloadedImages.clear();

    this.frames = await getFramesForAgent(this.session.sessionId, this.currentAgent);
    this.frames.sort((a, b) => a.time - b.time);

    // Preload first ~60 images for instant playback
    const preloadCount = Math.min(this.frames.length, 60);
    for (let i = 0; i < preloadCount; i++) {
      this.preloadImage(i);
    }

    this.loadingFrames = false;
    this.renderFrame();
    this.renderVLMHistory();
  }

  private preloadImage(frameIdx: number): void {
    if (this.preloadedImages.has(frameIdx)) return;
    const frame = this.frames[frameIdx];
    if (!frame) return;
    const img = new Image();
    img.src = `data:image/jpeg;base64,${frame.frameBase64}`;
    this.preloadedImages.set(frameIdx, img);
  }

  private async onDelete(): Promise<void> {
    if (!this.session) return;
    if (!confirm(`Delete session "${this.session.location}"?`)) return;
    await deleteSession(this.session.sessionId);
    this.session = null;
    this.frames = [];
    this.preloadedImages.clear();
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.vlmLog.innerHTML = "";
    this.statePanel.innerHTML = "";
    this.timeLabel.textContent = "No session";
    await this.loadSessionList();
  }

  /** Find frame closest to (at or before) the given time. */
  private getFrameAtTime(time: number): { frame: ReplayVideoFrame; index: number } | undefined {
    if (this.frames.length === 0) return undefined;

    // Binary search for the last frame at or before `time`
    let lo = 0;
    let hi = this.frames.length - 1;
    let best = -1;

    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.frames[mid]!.time <= time) {
        best = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }

    if (best < 0) return undefined;
    return { frame: this.frames[best]!, index: best };
  }

  private renderFrame(): void {
    if (!this.session) return;

    const dur = this.session.durationSec;
    const t = this.playbackTime;
    this.timeLabel.textContent = `${t.toFixed(1)}s / ${dur.toFixed(1)}s`;
    this.timeline.value = String(t);

    const result = this.getFrameAtTime(t);

    if (!result) {
      this.ctx.fillStyle = "#1a1a2e";
      this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
      this.ctx.fillStyle = "#666";
      this.ctx.font = "16px monospace";
      this.ctx.textAlign = "center";
      this.ctx.fillText("No frame at this time", this.canvas.width / 2, this.canvas.height / 2);
      this.statePanel.innerHTML = "";
      return;
    }

    const { frame, index } = result;

    // Draw from preloaded image or create new
    let img = this.preloadedImages.get(index);
    if (!img) {
      img = new Image();
      img.src = `data:image/jpeg;base64,${frame.frameBase64}`;
      this.preloadedImages.set(index, img);
    }

    if (img.complete) {
      this.ctx.drawImage(img, 0, 0, this.canvas.width, this.canvas.height);
    } else {
      img.onload = () => {
        // Only draw if we're still at the same time
        if (Math.abs(this.playbackTime - t) < 0.05) {
          this.ctx.drawImage(img, 0, 0, this.canvas.width, this.canvas.height);
        }
      };
    }

    // Preload ahead
    for (let i = index + 1; i < Math.min(index + 30, this.frames.length); i++) {
      this.preloadImage(i);
    }

    // Evict far-behind images to save memory
    if (index > 60) {
      for (let i = index - 60; i >= 0; i--) {
        if (this.preloadedImages.has(i)) {
          this.preloadedImages.delete(i);
        } else {
          break;
        }
      }
    }

    // Update state panel
    const s = frame.state;
    this.statePanel.innerHTML = [
      `<div class="state-row"><span class="state-key">Health</span><span class="state-val">${s.health.toFixed(0)}</span></div>`,
      `<div class="state-row"><span class="state-key">Stamina</span><span class="state-val">${s.stamina.toFixed(0)}</span></div>`,
      `<div class="state-row"><span class="state-key">Panic</span><span class="state-val">${(s.panicLevel * 100).toFixed(0)}%</span></div>`,
      `<div class="state-row"><span class="state-key">Status</span><span class="state-val ${s.alive ? "" : "dead"}">${s.alive ? "Alive" : "Dead"}</span></div>`,
      `<div class="state-row"><span class="state-key">Position</span><span class="state-val">(${s.positionX.toFixed(1)}, ${s.positionZ.toFixed(1)})</span></div>`,
    ].join("");

    // Scroll VLM log to current time
    this.scrollVLMToTime(t);
  }

  private renderVLMHistory(): void {
    if (!this.session) return;

    const entries = this.session.vlmEntries
      .filter((e) => e.agentIndex === this.currentAgent)
      .sort((a, b) => a.simTime - b.simTime);

    const html = entries.map((e) =>
      `<div class="vlm-entry" data-time="${e.simTime.toFixed(1)}">` +
      `<div class="vlm-header">${e.simTime.toFixed(1)}s (step ${e.step})</div>` +
      `<div class="vlm-obs">${e.observation}</div>` +
      `<div class="vlm-action">Action: ${e.action}</div>` +
      `</div>`
    );

    this.vlmLog.innerHTML = html.length > 0
      ? html.join("")
      : '<div class="vlm-empty">No VLM data for this agent</div>';
  }

  private scrollVLMToTime(time: number): void {
    // Find the most recent VLM entry at or before current time
    const entries = this.vlmLog.querySelectorAll(".vlm-entry");
    let bestEntry: HTMLElement | null = null;

    entries.forEach((el) => {
      el.classList.remove("active");
      const entryTime = parseFloat((el as HTMLElement).dataset.time ?? "0");
      if (entryTime <= time) {
        bestEntry = el as HTMLElement;
      }
    });

    if (bestEntry) {
      (bestEntry as HTMLElement).classList.add("active");
      (bestEntry as HTMLElement).scrollIntoView({ behavior: "smooth", block: "nearest" });
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
    this.lastRafTime = performance.now();
    this.scheduleAudio();

    const loop = (now: number) => {
      if (!this.playing || !this.session) return;

      const dt = (now - this.lastRafTime) / 1000;
      this.lastRafTime = now;

      this.playbackTime += dt * this.speed;

      if (this.playbackTime >= this.session.durationSec) {
        this.playbackTime = this.session.durationSec;
        this.renderFrame();
        this.stopPlay();
        return;
      }

      this.renderFrame();
      this.rafId = requestAnimationFrame(loop);
    };

    this.rafId = requestAnimationFrame(loop);
  }

  private stopPlay(): void {
    this.playing = false;
    this.playBtn.textContent = "Play";
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.cancelScheduledAudio();
  }

  private cycleSpeed(): void {
    const speeds = [1, 2, 4];
    const idx = speeds.indexOf(this.speed);
    this.speed = speeds[(idx + 1) % speeds.length]!;
    this.speedBtn.textContent = `${this.speed}x`;
    if (this.playing) this.scheduleAudio();
  }

  private setSpeed(s: number): void {
    this.speed = s;
    this.speedBtn.textContent = `${s}x`;
    if (this.playing) this.scheduleAudio();
  }

  private seekRelative(deltaSec: number): void {
    if (!this.session) return;
    this.playbackTime = Math.max(0, Math.min(this.session.durationSec, this.playbackTime + deltaSec));
    if (this.playing) this.scheduleAudio();
    else this.cancelScheduledAudio();
    this.renderFrame();
  }

  /** Decode base64 mp3 clips into AudioBuffers for reliable playback. */
  private async decodeAudioClips(clips: ReplayAudioClip[]): Promise<void> {
    if (!this.audioCtx) {
      this.audioCtx = new AudioContext();
    }
    this.decodedClips = [];
    for (const clip of clips) {
      const binary = atob(clip.audioBase64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      try {
        const buffer = await this.audioCtx.decodeAudioData(bytes.buffer.slice(0) as ArrayBuffer);
        this.decodedClips.push({ simTime: clip.simTime, dialogue: clip.dialogue, buffer });
      } catch (e) {
        console.error(`[Audio] Failed to decode clip at t=${clip.simTime}`, e);
      }
    }
    this.decodedClips.sort((a, b) => a.simTime - b.simTime);
    console.log(`[Audio] Decoded ${this.decodedClips.length} clips`);
  }

  /** Schedule all future clips as setTimeout calls relative to current playback position. */
  private scheduleAudio(): void {
    this.cancelScheduledAudio();
    if (!this.audioCtx || this.decodedClips.length === 0 || !this.playing) return;

    // Resume AudioContext if suspended (browser autoplay policy)
    if (this.audioCtx.state === "suspended") {
      this.audioCtx.resume();
    }

    for (const clip of this.decodedClips) {
      const delaySec = (clip.simTime - this.playbackTime) / this.speed;
      if (delaySec < -0.5) continue; // already past

      const delayMs = Math.max(0, delaySec * 1000);
      const tid = window.setTimeout(() => {
        if (!this.playing) return;
        this.playClipBuffer(clip);
      }, delayMs);
      this.scheduledTimeouts.push(tid);
    }
    console.log(`[Audio] Scheduled ${this.scheduledTimeouts.length} clips from t=${this.playbackTime.toFixed(1)}s at ${this.speed}x`);
  }

  private playClipBuffer(clip: { buffer: AudioBuffer; dialogue: string; simTime: number }): void {
    if (!this.audioCtx) return;
    // Stop previous clip
    if (this.activeSource) {
      try { this.activeSource.stop(); } catch {}
    }
    const source = this.audioCtx.createBufferSource();
    source.buffer = clip.buffer;
    source.connect(this.audioCtx.destination);
    source.start();
    this.activeSource = source;
    console.log(`[Audio] Playing clip at t=${clip.simTime.toFixed(1)}s: "${clip.dialogue}"`);
  }

  private cancelScheduledAudio(): void {
    for (const tid of this.scheduledTimeouts) {
      window.clearTimeout(tid);
    }
    this.scheduledTimeouts = [];
    if (this.activeSource) {
      try { this.activeSource.stop(); } catch {}
      this.activeSource = null;
    }
  }

  private clearAudio(): void {
    this.cancelScheduledAudio();
    this.decodedClips = [];
    this.audioGenerationId++;
    this.audioBtn.textContent = "Generate Audio";
    this.audioBtn.classList.remove("generating", "ready");
    this.loadCachedAudio();
  }

  /** Load previously cached audio clips from IndexedDB for the current agent. */
  private async loadCachedAudio(): Promise<void> {
    if (!this.session) return;
    const cached = this.session.audioClips?.[this.currentAgent];
    if (!cached || cached.length === 0) return;

    const genId = this.audioGenerationId;
    console.log(`[Audio] Loading ${cached.length} cached clips for agent ${this.currentAgent}`);

    await this.decodeAudioClips(cached);

    if (genId !== this.audioGenerationId) return;

    this.audioBtn.textContent = `Audio Ready (${this.decodedClips.length})`;
    this.audioBtn.classList.add("ready");
    if (this.playing) this.scheduleAudio();
  }

  private async generateAudio(): Promise<void> {
    if (!this.session) return;
    if (this.audioBtn.classList.contains("generating")) return;

    // Select VLM entries for current agent
    const entries = this.session.vlmEntries
      .filter((e) => e.agentIndex === this.currentAgent && e.observation && e.observation !== "No VLM configured.")
      .sort((a, b) => a.simTime - b.simTime);

    if (entries.length === 0) {
      this.audioBtn.textContent = "No VLM Data";
      setTimeout(() => { this.audioBtn.textContent = "Generate Audio"; }, 2000);
      return;
    }

    // Send ALL valid VLM entries — they're already ~5s apart
    const agentName = this.session.agents[this.currentAgent]?.name ?? "Agent";
    const genId = ++this.audioGenerationId;

    console.log(`[Audio] Generating for "${agentName}" — sending ${entries.length} VLM entries`);

    this.audioBtn.textContent = "Generating...";
    this.audioBtn.classList.add("generating");

    try {
      const res = await fetch("/api/generate-audio", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentName,
          vlmEntries: entries.map((e) => ({
            simTime: e.simTime,
            observation: e.observation,
            action: e.action,
          })),
        }),
      });

      // Discard if agent/session changed while generating
      if (genId !== this.audioGenerationId) return;

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Unknown error" })) as { error?: string };
        console.error("[Audio] Generation failed:", err.error);
        this.audioBtn.textContent = "Error";
        this.audioBtn.classList.remove("generating");
        setTimeout(() => { this.audioBtn.textContent = "Generate Audio"; }, 3000);
        return;
      }

      const data = await res.json() as { clips: ReplayAudioClip[] };

      // Discard if stale
      if (genId !== this.audioGenerationId) return;

      console.log(`[Audio] Received ${data.clips.length} clips, decoding...`);
      for (const c of data.clips) {
        console.log(`[Audio]   t=${c.simTime.toFixed(1)}s dialogue="${c.dialogue}" audio=${c.audioBase64.length} b64 chars`);
      }

      await this.decodeAudioClips(data.clips);

      // Discard if stale after async decode
      if (genId !== this.audioGenerationId) return;

      this.audioBtn.textContent = `Audio Ready (${this.decodedClips.length})`;
      this.audioBtn.classList.remove("generating");
      this.audioBtn.classList.add("ready");

      // Cache clips to IndexedDB so we don't need to regenerate
      if (this.session && data.clips.length > 0) {
        if (!this.session.audioClips) this.session.audioClips = {};
        this.session.audioClips[this.currentAgent] = data.clips;
        saveSession(this.session).catch((e) => console.error("[Audio] Failed to cache clips:", e));
      }

      // If already playing, schedule immediately
      if (this.playing) this.scheduleAudio();
    } catch (err) {
      if (genId !== this.audioGenerationId) return;
      console.error("[Audio] Fetch error:", err);
      this.audioBtn.textContent = "Error";
      this.audioBtn.classList.remove("generating");
      setTimeout(() => { this.audioBtn.textContent = "Generate Audio"; }, 3000);
    }
  }
}

new ReplayViewer();
