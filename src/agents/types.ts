import type { ActionType } from "../core/Components.ts";

/** Per-agent configuration set at spawn time. */
export interface AgentConfig {
  name: string;
  color: number; // hex color
  personality: {
    bravery: number;   // 0-1
    altruism: number;  // 0-1
    awareness: number; // 0-1
    description: string;
  };
  spawnPosition: { x: number; y: number; z: number };
}

/** Runtime memory accumulated during the simulation. */
export interface AgentMemory {
  observations: string[];  // rolling window of last 10
  decisions: string[];     // rolling window of last 10
  recentEvents: string[];  // disaster events witnessed
}

/** Sent from client to server per agent per step. */
export interface PerceptionPayload {
  agentIndex: number;
  frameBase64: string; // base64 JPEG
  state: {
    health: number;
    stamina: number;
    panicLevel: number;
    injured: number;
    positionX: number;
    positionZ: number;
    facingYaw: number;
  };
  memory: AgentMemory;
  personality: AgentConfig["personality"];
  name: string;
}

/** Server returns one of these per agent per step. */
export interface DecisionResponse {
  agentIndex: number;
  observation: string; // VLM output
  reasoning: string;   // K2 Think reasoning
  action: string;      // action name
  targetX: number;
  targetZ: number;
  targetEntity: number;
}

/** Parsed action ready to write into ECS. */
export interface ParsedAction {
  actionType: ActionType;
  targetX: number;
  targetZ: number;
  targetEid: number;
}

/** One agent's data for a single step. */
export interface AgentStepData {
  name: string;
  agentIndex: number;
  positionX: number;
  positionY: number;
  positionZ: number;
  health: number;
  stamina: number;
  panicLevel: number;
  alive: boolean;
  observation: string;
  reasoning: string;
  action: string;
}

/** Full record for one simulation step. */
export interface StepRecord {
  step: number;
  simTime: number;
  agents: AgentStepData[];
  events: string[];
}

/** WebSocket messages client -> server */
export interface PerceiveMessage {
  type: "perceive";
  step: number;
  payloads: PerceptionPayload[];
}

/** WebSocket messages server -> client */
export interface DecisionsMessage {
  type: "decisions";
  step: number;
  decisions: DecisionResponse[];
}
