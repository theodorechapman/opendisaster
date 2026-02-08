/** A single frame captured during simulation for one agent. */
export interface ReplayFrame {
  agentIndex: number;
  agentName: string;
  step: number;
  simTime: number;
  frameBase64: string; // JPEG base64
  vlmOutput?: {
    observation: string;
    reasoning: string;
    action: string;
  };
  state: {
    health: number;
    stamina: number;
    panicLevel: number;
    alive: boolean;
    positionX: number;
    positionZ: number;
  };
}

/** A complete recorded simulation session. */
export interface ReplaySession {
  sessionId: string;
  location: string;
  startTime: number; // Date.now() at start
  endTime: number;   // Date.now() at finalize
  totalSteps: number;
  agents: { name: string; color: number }[];
  frames: ReplayFrame[];
}
