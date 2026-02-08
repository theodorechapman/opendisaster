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

/** Session metadata (small — no frame data). */
export interface ReplaySession {
  sessionId: string;
  location: string;
  startTime: number; // Date.now() at start
  endTime: number;   // Date.now() at finalize
  durationSec: number;
  agents: { name: string; color: number }[];
  vlmEntries: ReplayVLMEntry[];
}
