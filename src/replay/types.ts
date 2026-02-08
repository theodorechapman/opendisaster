/** Individual video frame stored as a separate record in IndexedDB. */
export interface ReplayVideoFrame {
  sessionId: string;
  agentIndex: number;
  time: number; // float seconds since sim start
  frameBase64: string; // JPEG base64
  state: {
    health: number;
    stamina: number;
    panicLevel: number;
    alive: boolean;
    positionX: number;
    positionZ: number;
  };
}

/** A VLM decision entry, stored inside session metadata. */
export interface ReplayVLMEntry {
  agentIndex: number;
  step: number;
  simTime: number;
  observation: string;
  action: string;
}

/** An audio clip generated from a VLM entry via LLM + TTS. */
export interface ReplayAudioClip {
  simTime: number;       // when this clip should play (matches VLM entry simTime)
  dialogue: string;      // the generated spoken line
  audioBase64: string;   // mp3 audio as base64
}

/** Session metadata (small — no frame data). */
export interface ReplaySession {
  sessionId: string;
  location: string;
  startTime: number; // Date.now() at start
  endTime: number;   // Date.now() at finalize
  durationSec: number;
  agents: { name: string; color: number }[];
  vlmEntries: ReplayVLMEntry[];
  /** Cached audio clips per agent, keyed by agent index. */
  audioClips?: Record<number, ReplayAudioClip[]>;
}
