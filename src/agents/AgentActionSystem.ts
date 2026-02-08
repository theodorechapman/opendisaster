import {
  Position,
  AgentState,
  AgentAction,
  AgentFacing,
  ActionType,
} from "../core/Components.ts";
import type { AgentManager } from "./AgentManager.ts";
import { agentLog } from "./AgentLogger.ts";

const WALK_SPEED = 1.68;  // m/s (1.4 * 1.2)
const RUN_SPEED = 4.8;    // m/s (4.0 * 1.2)
const STAMINA_DRAIN = 5;  // per second while running
const STAMINA_REGEN = 3;  // per second while walking/idle
const ARRIVAL_DIST = 1.0; // meters - close enough to target
const HELP_RANGE = 2.0;   // meters - range to heal another agent
const HEAL_RATE = 10;     // health/s when helping
const WANDER_IDLE_TIME = 2.0; // seconds idle before auto-wandering
const WANDER_RADIUS = 40;     // meters - how far to wander
const AGENT_RADIUS = 2.5;     // collision radius per agent
const AGENT_PUSH_STRENGTH = 4.0; // separation speed m/s
const STUCK_TIME_THRESHOLD = 2.0; // seconds of wall-sliding before giving up
const STUCK_PROGRESS_RATIO = 0.3; // must close at least 30% of expected distance

const ACTION_NAMES = ["IDLE","MOVE_TO","RUN_TO","HELP_PERSON","EVACUATE","WAIT","ENTER_BUILDING","EXIT_BUILDING"];

/** Simple XZ axis-aligned rectangle for collision. */
export interface Obstacle {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

/** Test if a circle (agent) at (x,z) with AGENT_RADIUS overlaps any obstacle. */
function collidesWithObstacle(x: number, z: number, obstacles: Obstacle[]): boolean {
  for (const o of obstacles) {
    // Closest point on the AABB to the circle center
    const cx = Math.max(o.minX, Math.min(x, o.maxX));
    const cz = Math.max(o.minZ, Math.min(z, o.maxZ));
    const dx = x - cx;
    const dz = z - cz;
    if (dx * dx + dz * dz < AGENT_RADIUS * AGENT_RADIUS) return true;
  }
  return false;
}

/** Try to move from (px,pz) toward (nx,nz)*speed*dt, sliding along obstacles.
 *  When sliding along a wall, move at full speed along the unblocked axis. */
function moveWithCollision(
  px: number,
  pz: number,
  nx: number,
  nz: number,
  speed: number,
  dt: number,
  obstacles: Obstacle[],
): { x: number; z: number; blocked: boolean } {
  const stepX = nx * speed * dt;
  const stepZ = nz * speed * dt;

  // Try full move
  const fullX = px + stepX;
  const fullZ = pz + stepZ;
  if (!collidesWithObstacle(fullX, fullZ, obstacles)) {
    return { x: fullX, z: fullZ, blocked: false };
  }
  // Try sliding along X at full speed (preserve direction sign)
  const slideX = px + Math.sign(nx) * speed * dt;
  if (nx !== 0 && !collidesWithObstacle(slideX, pz, obstacles)) {
    return { x: slideX, z: pz, blocked: false };
  }
  // Try sliding along Z at full speed (preserve direction sign)
  const slideZ = pz + Math.sign(nz) * speed * dt;
  if (nz !== 0 && !collidesWithObstacle(px, slideZ, obstacles)) {
    return { x: px, z: slideZ, blocked: false };
  }
  // Fully blocked
  return { x: px, z: pz, blocked: true };
}

/** Pick a wander target that isn't inside an obstacle. */
function pickWanderTarget(
  px: number,
  pz: number,
  obstacles: Obstacle[],
  sceneBound: number,
): { x: number; z: number } {
  for (let attempt = 0; attempt < 8; attempt++) {
    const angle = Math.random() * Math.PI * 2;
    const r = WANDER_RADIUS * (0.3 + Math.random() * 0.7);
    const tx = Math.max(-sceneBound, Math.min(sceneBound, px + Math.cos(angle) * r));
    const tz = Math.max(-sceneBound, Math.min(sceneBound, pz + Math.sin(angle) * r));
    if (!collidesWithObstacle(tx, tz, obstacles)) {
      return { x: tx, z: tz };
    }
  }
  // Fallback: small step in random direction
  const angle = Math.random() * Math.PI * 2;
  return {
    x: Math.max(-sceneBound, Math.min(sceneBound, px + Math.cos(angle) * 8)),
    z: Math.max(-sceneBound, Math.min(sceneBound, pz + Math.sin(angle) * 8)),
  };
}

/**
 * Creates the agent action ECS system.
 * Executes movement and actions each tick based on AgentAction components.
 * sceneBound: half-size of the scene in world units (agents are clamped within).
 */
export function createAgentActionSystem(manager: AgentManager, obstacles: Obstacle[] = [], sceneBound = 180) {
  return (_world: any, dt: number) => {
    for (const agent of manager.agents) {
      const eid = agent.eid;
      if (AgentState.alive[eid]! === 0) continue;

      const action = AgentAction.actionType[eid]! as ActionType;
      const px = Position.x[eid]!;
      const pz = Position.z[eid]!;
      const tx = AgentAction.targetX[eid]!;
      const tz = AgentAction.targetZ[eid]!;

      const dx = tx - px;
      const dz = tz - pz;
      const dist = Math.sqrt(dx * dx + dz * dz);

      switch (action) {
        case ActionType.IDLE:
        case ActionType.WAIT: {
          AgentState.stamina[eid] = Math.min(100, AgentState.stamina[eid]! + STAMINA_REGEN * dt);
          // Auto-wander: after being idle for a bit, pick a random nearby target
          AgentAction.progress[eid] = (AgentAction.progress[eid] ?? 0) + dt;
          if (AgentAction.progress[eid]! >= WANDER_IDLE_TIME) {
            const target = pickWanderTarget(px, pz, obstacles, sceneBound);
            agentLog.log("auto_wander", agent.config.name, {
              fromX: px, fromZ: pz,
              targetX: target.x, targetZ: target.z,
            });
            AgentAction.targetX[eid] = target.x;
            AgentAction.targetZ[eid] = target.z;
            AgentAction.actionType[eid] = ActionType.MOVE_TO;
            AgentAction.progress[eid] = 0;
          }
          break;
        }

        case ActionType.MOVE_TO:
        case ActionType.ENTER_BUILDING:
        case ActionType.EXIT_BUILDING: {
          if (dist > ARRIVAL_DIST) {
            const nx = dx / dist;
            const nz = dz / dist;
            const result = moveWithCollision(px, pz, nx, nz, WALK_SPEED, dt, obstacles);
            Position.x[eid] = result.x;
            Position.z[eid] = result.z;
            AgentFacing.yaw[eid] = Math.atan2(nx, nz);
            if (result.blocked) {
              agentLog.log("walk_blocked", agent.config.name, {
                positionX: px, positionZ: pz,
                targetX: tx, targetZ: tz,
                dist,
              });
              AgentAction.actionType[eid] = ActionType.IDLE;
              AgentAction.progress[eid] = WANDER_IDLE_TIME; // immediately re-wander
            } else {
              // Stuck detection: check if we're making real progress toward the target
              const newDx = tx - result.x;
              const newDz = tz - result.z;
              const newDist = Math.sqrt(newDx * newDx + newDz * newDz);
              const closed = dist - newDist;
              const expected = WALK_SPEED * dt;
              if (closed < expected * STUCK_PROGRESS_RATIO) {
                AgentAction.progress[eid] = (AgentAction.progress[eid] ?? 0) + dt;
                if (AgentAction.progress[eid]! >= STUCK_TIME_THRESHOLD) {
                  agentLog.log("walk_stuck", agent.config.name, {
                    positionX: result.x, positionZ: result.z,
                    targetX: tx, targetZ: tz,
                    dist: newDist,
                    stuckTime: AgentAction.progress[eid]!,
                  });
                  AgentAction.actionType[eid] = ActionType.IDLE;
                  AgentAction.progress[eid] = WANDER_IDLE_TIME; // immediately re-wander
                }
              } else {
                AgentAction.progress[eid] = 0; // making progress, reset stuck timer
              }
            }
          } else {
            agentLog.log("walk_arrived", agent.config.name, {
              positionX: px, positionZ: pz,
              targetX: tx, targetZ: tz,
            });
            AgentAction.actionType[eid] = ActionType.IDLE;
          }
          AgentState.stamina[eid] = Math.min(100, AgentState.stamina[eid]! + STAMINA_REGEN * dt);
          break;
        }

        case ActionType.RUN_TO:
        case ActionType.EVACUATE: {
          if (dist > ARRIVAL_DIST) {
            const stamina = AgentState.stamina[eid]!;
            const speed = stamina > 0 ? RUN_SPEED : WALK_SPEED;
            const nx = dx / dist;
            const nz = dz / dist;
            const result = moveWithCollision(px, pz, nx, nz, speed, dt, obstacles);
            Position.x[eid] = result.x;
            Position.z[eid] = result.z;
            AgentFacing.yaw[eid] = Math.atan2(nx, nz);

            if (result.blocked) {
              agentLog.log("run_blocked", agent.config.name, {
                action: ACTION_NAMES[action],
                positionX: px, positionZ: pz,
                targetX: tx, targetZ: tz,
                dist,
              });
              AgentAction.actionType[eid] = ActionType.IDLE;
              AgentAction.progress[eid] = WANDER_IDLE_TIME;
            } else {
              // Stuck detection: wall-sliding with negligible progress toward target
              const newDx = tx - result.x;
              const newDz = tz - result.z;
              const newDist = Math.sqrt(newDx * newDx + newDz * newDz);
              const closed = dist - newDist;
              const expected = speed * dt;
              if (closed < expected * STUCK_PROGRESS_RATIO) {
                AgentAction.progress[eid] = (AgentAction.progress[eid] ?? 0) + dt;
                if (AgentAction.progress[eid]! >= STUCK_TIME_THRESHOLD) {
                  agentLog.log("run_stuck", agent.config.name, {
                    action: ACTION_NAMES[action],
                    positionX: result.x, positionZ: result.z,
                    targetX: tx, targetZ: tz,
                    dist: newDist,
                    stuckTime: AgentAction.progress[eid]!,
                  });
                  AgentAction.actionType[eid] = ActionType.IDLE;
                  AgentAction.progress[eid] = WANDER_IDLE_TIME; // immediately re-wander
                }
              } else {
                AgentAction.progress[eid] = 0; // making progress, reset stuck timer
              }

              if (stamina > 0) {
                AgentState.stamina[eid] = Math.max(0, stamina - STAMINA_DRAIN * dt);
              } else {
                AgentState.stamina[eid] = Math.min(100, stamina + STAMINA_REGEN * 0.5 * dt);
              }
            }
          } else {
            agentLog.log("run_arrived", agent.config.name, {
              action: ACTION_NAMES[action],
              positionX: px, positionZ: pz,
              targetX: tx, targetZ: tz,
            });
            AgentAction.actionType[eid] = ActionType.IDLE;
          }
          break;
        }

        case ActionType.HELP_PERSON: {
          const targetEid = AgentAction.targetEid[eid]!;
          if (targetEid > 0 && AgentState.alive[targetEid]! === 1) {
            const hx = Position.x[targetEid]! - px;
            const hz = Position.z[targetEid]! - pz;
            const hDist = Math.sqrt(hx * hx + hz * hz);

            if (hDist > HELP_RANGE) {
              const nx = hx / hDist;
              const nz = hz / hDist;
              const result = moveWithCollision(px, pz, nx, nz, WALK_SPEED, dt, obstacles);
              Position.x[eid] = result.x;
              Position.z[eid] = result.z;
              AgentFacing.yaw[eid] = Math.atan2(nx, nz);
            } else {
              AgentState.health[targetEid] = Math.min(100, AgentState.health[targetEid]! + HEAL_RATE * dt);
            }
          } else {
            AgentAction.actionType[eid] = ActionType.IDLE;
          }
          AgentState.stamina[eid] = Math.min(100, AgentState.stamina[eid]! + STAMINA_REGEN * dt);
          break;
        }
      }
    }

    // Agent-agent separation: push overlapping agents apart
    const living = manager.getLiving();
    const sep = AGENT_RADIUS * 2;
    for (let i = 0; i < living.length; i++) {
      for (let j = i + 1; j < living.length; j++) {
        const a = living[i]!.eid;
        const b = living[j]!.eid;
        const ax = Position.x[a]!;
        const az = Position.z[a]!;
        const bx = Position.x[b]!;
        const bz = Position.z[b]!;
        let sx = bx - ax;
        let sz = bz - az;
        const d = Math.sqrt(sx * sx + sz * sz);
        if (d < sep && d > 0.01) {
          sx /= d;
          sz /= d;
          const push = (sep - d) * 0.5 * AGENT_PUSH_STRENGTH * dt;
          // Push each agent away from the other (only if not into obstacle)
          const naX = ax - sx * push;
          const naZ = az - sz * push;
          if (!collidesWithObstacle(naX, naZ, obstacles)) {
            Position.x[a] = naX;
            Position.z[a] = naZ;
          }
          const nbX = bx + sx * push;
          const nbZ = bz + sz * push;
          if (!collidesWithObstacle(nbX, nbZ, obstacles)) {
            Position.x[b] = nbX;
            Position.z[b] = nbZ;
          }
        }
      }
    }
  };
}
