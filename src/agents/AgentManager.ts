import { addEntity } from "bitecs";
import {
  Position,
  Agent,
  AgentState,
  AgentAction,
  AgentFacing,
  Classification,
  ClassificationType,
  ActionType,
} from "../core/Components.ts";
import type { SimWorld } from "../core/World.ts";
import type { AgentConfig, AgentMemory, ParsedAction } from "./types.ts";
import type { DangerZone } from "./AgentActionSystem.ts";
import { AgentVisuals } from "./AgentVisuals.ts";
import { agentLog } from "./AgentLogger.ts";
import type * as THREE from "three";

const ACTION_NAMES = ["IDLE","MOVE_TO","RUN_TO","HELP_PERSON","EVACUATE","WAIT","ENTER_BUILDING","EXIT_BUILDING"];

/** Map ActionType → animation name for AgentVisuals */
function actionToAnim(actionType: number): string {
  switch (actionType) {
    case ActionType.MOVE_TO:
    case ActionType.HELP_PERSON:
    case ActionType.ENTER_BUILDING:
    case ActionType.EXIT_BUILDING:
      return "walk";
    case ActionType.RUN_TO:
    case ActionType.EVACUATE:
      return "run";
    case ActionType.IDLE:
    case ActionType.WAIT:
    default:
      return "idle";
  }
}

export interface AgentRuntime {
  config: AgentConfig;
  eid: number;        // bitecs entity id
  index: number;      // dense index
  memory: AgentMemory;
  dangerZones: DangerZone[];
}

export class AgentManager {
  readonly agents: AgentRuntime[] = [];
  readonly visuals: AgentVisuals;
  private world: SimWorld;

  constructor(world: SimWorld, scene: THREE.Scene) {
    this.world = world;
    this.visuals = new AgentVisuals(scene);
  }

  /** Spawn a new agent entity with all components initialized. */
  spawn(config: AgentConfig): AgentRuntime {
    const eid = this.world.createEntity();
    const index = this.agents.length;

    // Position
    Position.x[eid] = config.spawnPosition.x;
    Position.y[eid] = config.spawnPosition.y;
    Position.z[eid] = config.spawnPosition.z;

    // Agent component
    Agent.agentIndex[eid] = index;

    // AgentState
    AgentState.health[eid] = 100;
    AgentState.stamina[eid] = 100;
    AgentState.panicLevel[eid] = 0;
    AgentState.injured[eid] = 0;
    AgentState.alive[eid] = 1;

    // AgentAction
    AgentAction.actionType[eid] = ActionType.IDLE;
    AgentAction.targetX[eid] = 0;
    AgentAction.targetZ[eid] = 0;
    AgentAction.targetEid[eid] = 0;
    AgentAction.progress[eid] = 0;

    // AgentFacing
    AgentFacing.yaw[eid] = 0;

    // Classification
    Classification.type[eid] = ClassificationType.AGENT;

    // Create visual
    this.visuals.createAgent(config);

    const runtime: AgentRuntime = {
      config,
      eid,
      index,
      memory: {
        observations: [],
        decisions: [],
        recentEvents: [],
      },
      dangerZones: [],
    };

    this.agents.push(runtime);
    console.log(`[Agents] Spawned ${config.name} (eid=${eid}) at (${config.spawnPosition.x}, ${config.spawnPosition.z})`);
    return runtime;
  }

  /** Apply a parsed action decision to an agent's ECS components. */
  applyAction(agentIndex: number, action: ParsedAction): void {
    const agent = this.agents[agentIndex];
    if (!agent) return;
    const eid = agent.eid;

    const prevAction = AgentAction.actionType[eid]!;
    agentLog.log("apply_action", agent.config.name, {
      from: ACTION_NAMES[prevAction] ?? prevAction,
      to: ACTION_NAMES[action.actionType] ?? action.actionType,
      positionX: Position.x[eid]!,
      positionZ: Position.z[eid]!,
      facingYaw: AgentFacing.yaw[eid]!,
      targetX: action.targetX,
      targetZ: action.targetZ,
      targetEid: action.targetEid,
    });

    AgentAction.actionType[eid] = action.actionType;
    AgentAction.targetX[eid] = action.targetX;
    AgentAction.targetZ[eid] = action.targetZ;
    AgentAction.targetEid[eid] = action.targetEid;
    AgentAction.progress[eid] = 0;
  }

  /** Store an observation in agent memory (rolling window of 10). */
  addObservation(agentIndex: number, observation: string): void {
    const agent = this.agents[agentIndex];
    if (!agent) return;
    agent.memory.observations.push(observation);
    if (agent.memory.observations.length > 10) {
      agent.memory.observations.shift();
    }
  }

  /** Store a decision in agent memory (rolling window of 10). */
  addDecision(agentIndex: number, decision: string): void {
    const agent = this.agents[agentIndex];
    if (!agent) return;
    agent.memory.decisions.push(decision);
    if (agent.memory.decisions.length > 10) {
      agent.memory.decisions.shift();
    }
  }

  /** Record a disaster event witnessed by an agent. */
  addEvent(agentIndex: number, event: string): void {
    const agent = this.agents[agentIndex];
    if (!agent) return;
    agent.memory.recentEvents.push(event);
    if (agent.memory.recentEvents.length > 20) {
      agent.memory.recentEvents.shift();
    }
  }

  /** Get all living agents. */
  getLiving(): AgentRuntime[] {
    return this.agents.filter(a => AgentState.alive[a.eid] === 1);
  }

  /** Sync ECS positions to Three.js meshes for all agents. */
  syncVisuals(): void {
    for (const agent of this.agents) {
      const eid = agent.eid;
      this.visuals.updatePosition(
        agent.index,
        Position.x[eid]!,
        Position.y[eid]!,
        Position.z[eid]!,
      );
      this.visuals.updateCamera(agent.index, AgentFacing.yaw[eid]!);

      // Drive animation from ECS action state
      if (AgentState.alive[eid] === 0) {
        this.visuals.setAnimation(agent.index, "death");
      } else {
        const animName = actionToAnim(AgentAction.actionType[eid]!);
        this.visuals.setAnimation(agent.index, animName);
      }
    }
  }
}
