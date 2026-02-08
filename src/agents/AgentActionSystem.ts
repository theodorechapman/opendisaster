import {
  Position,
  AgentState,
  AgentAction,
  AgentFacing,
  ActionType,
} from "../core/Components.ts";
import type { AgentManager } from "./AgentManager.ts";
import type { RoadGraph } from "./RoadGraph.ts";
import { agentLog } from "./AgentLogger.ts";

const WALK_SPEED = 1.68;  // m/s
const RUN_SPEED = 4.8;    // m/s
const STAMINA_DRAIN = 5;  // per second while running
const STAMINA_REGEN = 3;  // per second while walking/idle
const ARRIVAL_DIST = 1.5; // meters - close enough to target
const WANDER_IDLE_TIME = 2.0; // seconds idle before auto-wandering
const WANDER_RADIUS = 40;     // meters - fallback random wander radius
const AGENT_RADIUS = 2.5;     // collision radius per agent
const AGENT_PUSH_STRENGTH = 4.0; // separation speed m/s
const STUCK_TIME_THRESHOLD = 2.0; // seconds of wall-sliding before giving up
const STUCK_PROGRESS_RATIO = 0.3; // must close at least 30% of expected distance
const ROAD_SEARCH_RADIUS = 30;    // max distance to snap to road graph
const MIN_TARGET_DIST = 15;        // reject graph targets closer than this
const FLEE_COMMIT_TIME = 3.0;      // seconds an agent commits to a flee target before allowing change
const ACTION_NAMES: Record<number, string> = {
  [ActionType.IDLE]: "IDLE",
  [ActionType.WALK_TO]: "WALK_TO",
  [ActionType.RUN_TO]: "RUN_TO",
};

/** A circular zone agents should avoid (e.g. fire). */
export interface DangerZone {
  x: number;
  z: number;
  radius: number;
  expiresAt: number; // Date.now() timestamp
}

/** Simple XZ axis-aligned rectangle for collision. */
export interface Obstacle {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

/** Test if a point is inside any active danger zone. */
function isInDangerZone(x: number, z: number, zones: DangerZone[]): boolean {
  const now = Date.now();
  for (const zone of zones) {
    if (zone.expiresAt < now) continue;
    const dx = x - zone.x;
    const dz = z - zone.z;
    if (dx * dx + dz * dz < zone.radius * zone.radius) return true;
  }
  return false;
}

/** Minimum distance from a point to the nearest active danger zone edge. */
function minDangerDist(x: number, z: number, zones: DangerZone[]): number {
  let minDist = Infinity;
  const now = Date.now();
  for (const zone of zones) {
    if (zone.expiresAt < now) continue;
    const dx = x - zone.x;
    const dz = z - zone.z;
    minDist = Math.min(minDist, Math.sqrt(dx * dx + dz * dz) - zone.radius);
  }
  return minDist;
}

/** Test if a circle (agent) at (x,z) with AGENT_RADIUS overlaps any obstacle. */
function collidesWithObstacle(x: number, z: number, obstacles: Obstacle[]): boolean {
  for (const o of obstacles) {
    const cx = Math.max(o.minX, Math.min(x, o.maxX));
    const cz = Math.max(o.minZ, Math.min(z, o.maxZ));
    const dx = x - cx;
    const dz = z - cz;
    if (dx * dx + dz * dz < AGENT_RADIUS * AGENT_RADIUS) return true;
  }
  return false;
}

/** If agent is overlapping an obstacle, push them to the nearest edge. */
function pushOutOfObstacles(x: number, z: number, obstacles: Obstacle[]): { x: number; z: number } {
  for (const o of obstacles) {
    const cx = Math.max(o.minX, Math.min(x, o.maxX));
    const cz = Math.max(o.minZ, Math.min(z, o.maxZ));
    const dx = x - cx;
    const dz = z - cz;
    const distSq = dx * dx + dz * dz;
    if (distSq < AGENT_RADIUS * AGENT_RADIUS) {
      if (distSq > 0.0001) {
        const dist = Math.sqrt(distSq);
        const pushDist = AGENT_RADIUS - dist + 0.1;
        x += (dx / dist) * pushDist;
        z += (dz / dist) * pushDist;
      } else {
        const toMinX = x - o.minX;
        const toMaxX = o.maxX - x;
        const toMinZ = z - o.minZ;
        const toMaxZ = o.maxZ - z;
        const minPush = Math.min(toMinX, toMaxX, toMinZ, toMaxZ);
        if (minPush === toMinX) x = o.minX - AGENT_RADIUS - 0.1;
        else if (minPush === toMaxX) x = o.maxX + AGENT_RADIUS + 0.1;
        else if (minPush === toMinZ) z = o.minZ - AGENT_RADIUS - 0.1;
        else z = o.maxZ + AGENT_RADIUS + 0.1;
      }
    }
  }
  return { x, z };
}

/** Move from (px,pz) toward (nx,nz)*speed*dt, sliding along obstacles. */
function moveWithCollision(
  px: number, pz: number,
  nx: number, nz: number,
  speed: number, dt: number,
  obstacles: Obstacle[],
): { x: number; z: number; blocked: boolean } {
  const fullX = px + nx * speed * dt;
  const fullZ = pz + nz * speed * dt;
  if (!collidesWithObstacle(fullX, fullZ, obstacles)) {
    return { x: fullX, z: fullZ, blocked: false };
  }
  const slideX = px + Math.sign(nx) * speed * dt;
  if (nx !== 0 && !collidesWithObstacle(slideX, pz, obstacles)) {
    return { x: slideX, z: pz, blocked: false };
  }
  const slideZ = pz + Math.sign(nz) * speed * dt;
  if (nz !== 0 && !collidesWithObstacle(px, slideZ, obstacles)) {
    return { x: px, z: slideZ, blocked: false };
  }
  return { x: px, z: pz, blocked: true };
}

/** Fallback random wander target (used when no road graph nearby). */
function pickRandomWanderTarget(
  px: number, pz: number,
  obstacles: Obstacle[], sceneBound: number,
): { x: number; z: number } {
  for (let attempt = 0; attempt < 16; attempt++) {
    const angle = Math.random() * Math.PI * 2;
    const r = WANDER_RADIUS * (0.3 + Math.random() * 0.7);
    const tx = Math.max(-sceneBound, Math.min(sceneBound, px + Math.cos(angle) * r));
    const tz = Math.max(-sceneBound, Math.min(sceneBound, pz + Math.sin(angle) * r));
    if (!collidesWithObstacle(tx, tz, obstacles)) {
      return { x: tx, z: tz };
    }
  }
  return { x: px, z: pz };
}

/** Pick a wander destination from the road graph (endpoint of a random walk).
 *  Retries a few times to find a point at least MIN_TARGET_DIST away. */
function pickWanderTarget(
  px: number, pz: number,
  roadGraph: RoadGraph | null,
  obstacles: Obstacle[],
  sceneBound: number,
): { x: number; z: number } {
  if (!roadGraph) {
    return pickRandomWanderTarget(px, pz, obstacles, sceneBound);
  }

  const nearestId = roadGraph.nearestNode(px, pz);
  if (nearestId === -1) {
    return pickRandomWanderTarget(px, pz, obstacles, sceneBound);
  }

  const nearestPos = roadGraph.getNodePos(nearestId)!;
  const ddx = nearestPos.x - px;
  const ddz = nearestPos.z - pz;
  if (ddx * ddx + ddz * ddz > ROAD_SEARCH_RADIUS * ROAD_SEARCH_RADIUS) {
    return pickRandomWanderTarget(px, pz, obstacles, sceneBound);
  }

  // Try a few times to find an endpoint far enough away
  const minDist2 = MIN_TARGET_DIST * MIN_TARGET_DIST;
  for (let attempt = 0; attempt < 4; attempt++) {
    const steps = 5 + attempt * 3; // increase walk length on retry
    const nodeIds = roadGraph.randomWalk(nearestId, steps);
    if (nodeIds.length === 0) continue;

    const endId = nodeIds[nodeIds.length - 1]!;
    const endPos = roadGraph.getNodePos(endId)!;
    const edx = endPos.x - px;
    const edz = endPos.z - pz;
    if (edx * edx + edz * edz >= minDist2) {
      return {
        x: endPos.x + (Math.random() - 0.5) * 3,
        z: endPos.z + (Math.random() - 0.5) * 3,
      };
    }
  }

  // Graph couldn't find a distant-enough point — fall back to random
  return pickRandomWanderTarget(px, pz, obstacles, sceneBound);
}

/** Pick a flee destination from the road graph (endpoint of a flee route).
 *  Retries to find a point at least MIN_TARGET_DIST away. */
function pickFleeTarget(
  px: number, pz: number,
  roadGraph: RoadGraph | null,
  obstacles: Obstacle[],
  sceneBound: number,
  zones: DangerZone[],
): { x: number; z: number } {
  if (!roadGraph) {
    return pickFleeTargetFallback(px, pz, obstacles, sceneBound, zones);
  }

  const nearestId = roadGraph.nearestNode(px, pz);
  if (nearestId === -1 || distToNode(px, pz, roadGraph, nearestId) > ROAD_SEARCH_RADIUS) {
    return pickFleeTargetFallback(px, pz, obstacles, sceneBound, zones);
  }

  const minDist2 = MIN_TARGET_DIST * MIN_TARGET_DIST;
  for (let attempt = 0; attempt < 3; attempt++) {
    const steps = 6 + attempt * 3;
    const nodeIds = roadGraph.fleeRoute(nearestId, zones, steps);
    if (nodeIds.length === 0) continue;

    const endId = nodeIds[nodeIds.length - 1]!;
    const endPos = roadGraph.getNodePos(endId)!;
    const edx = endPos.x - px;
    const edz = endPos.z - pz;
    if (edx * edx + edz * edz >= minDist2) {
      return { x: endPos.x, z: endPos.z };
    }
  }

  // Graph is too small/loopy here — use fallback escape vector
  return pickFleeTargetFallback(px, pz, obstacles, sceneBound, zones);
}

function distToNode(px: number, pz: number, graph: RoadGraph, nodeId: number): number {
  const pos = graph.getNodePos(nodeId);
  if (!pos) return Infinity;
  const dx = pos.x - px;
  const dz = pos.z - pz;
  return Math.sqrt(dx * dx + dz * dz);
}

/** Fallback flee when no road graph is available. */
function pickFleeTargetFallback(
  px: number, pz: number,
  obstacles: Obstacle[], sceneBound: number,
  zones: DangerZone[],
): { x: number; z: number } {
  const now = Date.now();
  let escX = 0;
  let escZ = 0;
  for (const zone of zones) {
    if (zone.expiresAt < now) continue;
    const dx = px - zone.x;
    const dz = pz - zone.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    const weight = 1 / Math.max(dist, 0.1);
    escX += (dist > 0.01 ? dx / dist : Math.random() - 0.5) * weight;
    escZ += (dist > 0.01 ? dz / dist : Math.random() - 0.5) * weight;
  }
  const escLen = Math.sqrt(escX * escX + escZ * escZ);
  if (escLen > 0.01) { escX /= escLen; escZ /= escLen; }
  else { const a = Math.random() * Math.PI * 2; escX = Math.cos(a); escZ = Math.sin(a); }

  let tx = Math.max(-sceneBound, Math.min(sceneBound, px + escX * WANDER_RADIUS));
  let tz = Math.max(-sceneBound, Math.min(sceneBound, pz + escZ * WANDER_RADIUS));
  if (collidesWithObstacle(tx, tz, obstacles)) {
    for (const r of [WANDER_RADIUS * 0.5, 12, 6]) {
      const cx = Math.max(-sceneBound, Math.min(sceneBound, px + escX * r));
      const cz = Math.max(-sceneBound, Math.min(sceneBound, pz + escZ * r));
      if (!collidesWithObstacle(cx, cz, obstacles)) {
        tx = cx; tz = cz; break;
      }
    }
  }
  return { x: tx, z: tz };
}

/**
 * Creates the agent action ECS system.
 * Executes movement and actions each tick based on AgentAction components.
 */
export function createAgentActionSystem(
  manager: AgentManager,
  obstacles: Obstacle[] = [],
  sceneBound = 180,
  roadGraph: RoadGraph | null = null,
) {
  // Per-agent: time remaining before a flee target can be changed
  const fleeCommitCountdown = new Map<number, number>();

  return (_world: any, dt: number) => {
    const now = Date.now();

    // Collect all agent danger zones for separation check
    const allDangerZones: DangerZone[] = [];
    for (const agent of manager.agents) {
      for (const z of agent.dangerZones) {
        if (z.expiresAt > now) allDangerZones.push(z);
      }
    }

    for (const agent of manager.agents) {
      // Prune expired per-agent danger zones
      const zones = agent.dangerZones;
      for (let i = zones.length - 1; i >= 0; i--) {
        if (zones[i]!.expiresAt < now) zones.splice(i, 1);
      }
      const eid = agent.eid;
      if (AgentState.alive[eid]! === 0) continue;

      // Tick down flee commit countdown
      const commitLeft = fleeCommitCountdown.get(eid) ?? 0;
      if (commitLeft > 0) fleeCommitCountdown.set(eid, commitLeft - dt);

      const action = AgentAction.actionType[eid]! as ActionType;

      // Push agent out of any obstacle they're overlapping
      {
        const pushed = pushOutOfObstacles(Position.x[eid]!, Position.z[eid]!, obstacles);
        Position.x[eid] = pushed.x;
        Position.z[eid] = pushed.z;
      }

      const px = Position.x[eid]!;
      const pz = Position.z[eid]!;
      const tx = AgentAction.targetX[eid]!;
      const tz = AgentAction.targetZ[eid]!;

      const dx = tx - px;
      const dz = tz - pz;
      const dist = Math.sqrt(dx * dx + dz * dz);

      switch (action) {
        case ActionType.IDLE: {
          AgentState.stamina[eid] = Math.min(100, AgentState.stamina[eid]! + STAMINA_REGEN * dt);
          const hasActiveDanger = zones.some(z => z.expiresAt > now);
          const nearDanger = hasActiveDanger && minDangerDist(px, pz, zones) < WANDER_RADIUS;
          const idleThreshold = nearDanger ? 0.5 : WANDER_IDLE_TIME;

          AgentAction.progress[eid] = (AgentAction.progress[eid] ?? 0) + dt;
          if (AgentAction.progress[eid]! >= idleThreshold) {
            if (nearDanger) {
              const target = pickFleeTarget(px, pz, roadGraph, obstacles, sceneBound, zones);
              agentLog.log("auto_flee", agent.config.name, {
                fromX: px, fromZ: pz,
                targetX: target.x, targetZ: target.z,
              });
              AgentAction.targetX[eid] = target.x;
              AgentAction.targetZ[eid] = target.z;
              AgentAction.actionType[eid] = ActionType.RUN_TO;
              fleeCommitCountdown.set(eid, FLEE_COMMIT_TIME);
            } else {
              const target = pickWanderTarget(px, pz, roadGraph, obstacles, sceneBound);
              agentLog.log("auto_wander", agent.config.name, {
                fromX: px, fromZ: pz,
                targetX: target.x, targetZ: target.z,
              });
              AgentAction.targetX[eid] = target.x;
              AgentAction.targetZ[eid] = target.z;
              AgentAction.actionType[eid] = ActionType.WALK_TO;
            }
            AgentAction.progress[eid] = 0;
          }
          break;
        }

        case ActionType.WALK_TO: {
          // If walk target is now inside a danger zone, switch to flee
          if (isInDangerZone(tx, tz, zones) || (zones.some(z => z.expiresAt > now) && minDangerDist(px, pz, zones) < 5)) {
            const safe = pickFleeTarget(px, pz, roadGraph, obstacles, sceneBound, zones);
            agentLog.log("walk_danger_redirect", agent.config.name, {
              fromX: px, fromZ: pz,
              safeTargetX: safe.x, safeTargetZ: safe.z,
            });
            AgentAction.targetX[eid] = safe.x;
            AgentAction.targetZ[eid] = safe.z;
            AgentAction.actionType[eid] = ActionType.RUN_TO;
            AgentAction.progress[eid] = 0;
            fleeCommitCountdown.set(eid, FLEE_COMMIT_TIME);
            break;
          }

          if (dist > ARRIVAL_DIST) {
            const nx = dx / dist;
            const nz = dz / dist;
            const result = moveWithCollision(px, pz, nx, nz, WALK_SPEED, dt, obstacles);
            Position.x[eid] = result.x;
            Position.z[eid] = result.z;
            AgentFacing.yaw[eid] = Math.atan2(nx, nz);
            if (result.blocked) {
              AgentAction.actionType[eid] = ActionType.IDLE;
              AgentAction.progress[eid] = WANDER_IDLE_TIME;
            } else {
              // Stuck detection
              const newDx = tx - result.x;
              const newDz = tz - result.z;
              const newDist = Math.sqrt(newDx * newDx + newDz * newDz);
              const closed = dist - newDist;
              if (closed < WALK_SPEED * dt * STUCK_PROGRESS_RATIO) {
                AgentAction.progress[eid] = (AgentAction.progress[eid] ?? 0) + dt;
                if (AgentAction.progress[eid]! >= STUCK_TIME_THRESHOLD) {
                  AgentAction.actionType[eid] = ActionType.IDLE;
                  AgentAction.progress[eid] = WANDER_IDLE_TIME;
                }
              } else {
                AgentAction.progress[eid] = 0;
              }
            }
          } else {
            AgentAction.actionType[eid] = ActionType.IDLE;
            AgentAction.progress[eid] = 0;
          }
          AgentState.stamina[eid] = Math.min(100, AgentState.stamina[eid]! + STAMINA_REGEN * dt);
          break;
        }

        case ActionType.RUN_TO: {
          if (dist > ARRIVAL_DIST) {
            const stamina = AgentState.stamina[eid]!;
            const speed = stamina > 0 ? RUN_SPEED : WALK_SPEED;
            let nx = dx / dist;
            let nz = dz / dist;

            // Only redirect if target is inside a danger zone AND commit window expired
            const canChangeTarget = (fleeCommitCountdown.get(eid) ?? 0) <= 0;
            if (canChangeTarget && isInDangerZone(tx, tz, zones)) {
              const safe = pickFleeTarget(px, pz, roadGraph, obstacles, sceneBound, zones);
              AgentAction.targetX[eid] = safe.x;
              AgentAction.targetZ[eid] = safe.z;
              fleeCommitCountdown.set(eid, FLEE_COMMIT_TIME);
              const sdx = safe.x - px;
              const sdz = safe.z - pz;
              const sDist = Math.sqrt(sdx * sdx + sdz * sdz);
              if (sDist > 0.01) { nx = sdx / sDist; nz = sdz / sDist; }
            }

            const result = moveWithCollision(px, pz, nx, nz, speed, dt, obstacles);
            Position.x[eid] = result.x;
            Position.z[eid] = result.z;
            AgentFacing.yaw[eid] = Math.atan2(nx, nz);

            if (result.blocked) {
              AgentAction.actionType[eid] = ActionType.IDLE;
              AgentAction.progress[eid] = WANDER_IDLE_TIME;
            } else {
              // Stuck detection
              const newDx = tx - result.x;
              const newDz = tz - result.z;
              const newDist = Math.sqrt(newDx * newDx + newDz * newDz);
              const closed = dist - newDist;
              if (closed < speed * dt * STUCK_PROGRESS_RATIO) {
                AgentAction.progress[eid] = (AgentAction.progress[eid] ?? 0) + dt;
                if (AgentAction.progress[eid]! >= STUCK_TIME_THRESHOLD) {
                  AgentAction.actionType[eid] = ActionType.IDLE;
                  AgentAction.progress[eid] = WANDER_IDLE_TIME;
                }
              } else {
                AgentAction.progress[eid] = 0;
              }

              if (stamina > 0) {
                AgentState.stamina[eid] = Math.max(0, stamina - STAMINA_DRAIN * dt);
              } else {
                AgentState.stamina[eid] = Math.min(100, stamina + STAMINA_REGEN * 0.5 * dt);
              }
            }
          } else {
            // Arrived at flee destination — go idle (will re-flee if still near danger)
            AgentAction.actionType[eid] = ActionType.IDLE;
            AgentAction.progress[eid] = 0;
          }
          break;
        }
      }
    }

    // Agent-agent separation — don't push agents into danger zones
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
          const naX = ax - sx * push;
          const naZ = az - sz * push;
          if (!collidesWithObstacle(naX, naZ, obstacles) && !isInDangerZone(naX, naZ, allDangerZones)) {
            Position.x[a] = naX;
            Position.z[a] = naZ;
          }
          const nbX = bx + sx * push;
          const nbZ = bz + sz * push;
          if (!collidesWithObstacle(nbX, nbZ, obstacles) && !isInDangerZone(nbX, nbZ, allDangerZones)) {
            Position.x[b] = nbX;
            Position.z[b] = nbZ;
          }
        }
      }
    }
  };
}
