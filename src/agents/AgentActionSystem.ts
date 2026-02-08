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

/** A circular zone agents should avoid (e.g. fire). */
export interface DangerZone {
  x: number;
  z: number;
  radius: number;
  expiresAt: number; // Date.now() timestamp
}

const DANGER_ZONE_MARGIN = 5; // extra meters beyond fire radius

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
        // Push along the vector from closest point to agent center
        const dist = Math.sqrt(distSq);
        const pushDist = AGENT_RADIUS - dist + 0.1; // small extra margin
        x += (dx / dist) * pushDist;
        z += (dz / dist) * pushDist;
      } else {
        // Agent center is exactly inside the AABB — push to nearest edge
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

/** Minimum distance from a point to the nearest active danger zone edge.
 *  Returns Infinity if no active zones exist. */
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

/** Pick a wander target that isn't inside an obstacle or danger zone.
 *  When danger zones exist, all candidates are scored to maximize distance
 *  from the nearest danger — the agent always moves AWAY from known threats. */
function pickWanderTarget(
  px: number,
  pz: number,
  obstacles: Obstacle[],
  sceneBound: number,
  dangerZones: DangerZone[] = [],
): { x: number; z: number } {
  const hasActiveDanger = dangerZones.some(z => z.expiresAt > Date.now());

  if (!hasActiveDanger) {
    // No known danger — plain random wander
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

  // Danger exists — score candidates to maximize distance from all danger zones.
  // Sample 16 directions at full WANDER_RADIUS + 8 closer fallback directions.
  let bestX = px;
  let bestZ = pz;
  let bestScore = -Infinity;

  const radii = [WANDER_RADIUS, WANDER_RADIUS * 0.6, 12];
  for (const r of radii) {
    for (let i = 0; i < 16; i++) {
      const angle = (i / 16) * Math.PI * 2 + (r < WANDER_RADIUS ? Math.PI / 16 : 0);
      const tx = Math.max(-sceneBound, Math.min(sceneBound, px + Math.cos(angle) * r));
      const tz = Math.max(-sceneBound, Math.min(sceneBound, pz + Math.sin(angle) * r));
      if (collidesWithObstacle(tx, tz, obstacles)) continue;
      if (isInDangerZone(tx, tz, dangerZones)) continue;
      const score = minDangerDist(tx, tz, dangerZones);
      if (score > bestScore) {
        bestScore = score;
        bestX = tx;
        bestZ = tz;
      }
    }
  }

  // Fallback: all candidates were inside danger zones (agent is surrounded).
  // Compute a weighted escape vector away from all danger zones and flee at max
  // range, even if the target is still inside a zone — moving away is better
  // than standing still and burning.
  if (bestScore === -Infinity) {
    const now = Date.now();
    let escX = 0;
    let escZ = 0;
    for (const zone of dangerZones) {
      if (zone.expiresAt < now) continue;
      const dx = px - zone.x;
      const dz = pz - zone.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      // Weight by inverse distance — closer zones push harder
      const weight = 1 / Math.max(dist, 0.1);
      escX += (dist > 0.01 ? dx / dist : Math.random() - 0.5) * weight;
      escZ += (dist > 0.01 ? dz / dist : Math.random() - 0.5) * weight;
    }
    const escLen = Math.sqrt(escX * escX + escZ * escZ);
    if (escLen > 0.01) {
      escX /= escLen;
      escZ /= escLen;
    } else {
      // All zones perfectly centered on agent — pick random direction
      const rAngle = Math.random() * Math.PI * 2;
      escX = Math.cos(rAngle);
      escZ = Math.sin(rAngle);
    }
    bestX = Math.max(-sceneBound, Math.min(sceneBound, px + escX * WANDER_RADIUS));
    bestZ = Math.max(-sceneBound, Math.min(sceneBound, pz + escZ * WANDER_RADIUS));
    // Nudge away from obstacles if we landed in one
    if (collidesWithObstacle(bestX, bestZ, obstacles)) {
      for (const r of [WANDER_RADIUS * 0.5, 12, 6]) {
        const tx = Math.max(-sceneBound, Math.min(sceneBound, px + escX * r));
        const tz = Math.max(-sceneBound, Math.min(sceneBound, pz + escZ * r));
        if (!collidesWithObstacle(tx, tz, obstacles)) {
          bestX = tx;
          bestZ = tz;
          break;
        }
      }
    }
  }

  return { x: bestX, z: bestZ };
}

/**
 * Creates the agent action ECS system.
 * Executes movement and actions each tick based on AgentAction components.
 * sceneBound: half-size of the scene in world units (agents are clamped within).
 */
export function createAgentActionSystem(manager: AgentManager, obstacles: Obstacle[] = [], sceneBound = 180) {
  return (_world: any, dt: number) => {
    const now = Date.now();
    for (const agent of manager.agents) {
      // Prune expired per-agent danger zones inline
      const zones = agent.dangerZones;
      for (let i = zones.length - 1; i >= 0; i--) {
        if (zones[i]!.expiresAt < now) zones.splice(i, 1);
      }
      const eid = agent.eid;
      if (AgentState.alive[eid]! === 0) continue;

      const action = AgentAction.actionType[eid]! as ActionType;

      // Push agent out of any obstacle they're overlapping (from pushes, spawns, etc.)
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
        case ActionType.IDLE:
        case ActionType.WAIT: {
          AgentState.stamina[eid] = Math.min(100, AgentState.stamina[eid]! + STAMINA_REGEN * dt);
          const hasActiveDanger = zones.some(z => z.expiresAt > now);
          // If agent is near known danger, flee immediately instead of idling
          const nearDanger = hasActiveDanger && minDangerDist(px, pz, zones) < WANDER_RADIUS;
          const idleThreshold = nearDanger ? 0.3 : WANDER_IDLE_TIME;

          AgentAction.progress[eid] = (AgentAction.progress[eid] ?? 0) + dt;
          if (AgentAction.progress[eid]! >= idleThreshold) {
            const target = pickWanderTarget(px, pz, obstacles, sceneBound, zones);
            agentLog.log("auto_wander", agent.config.name, {
              fromX: px, fromZ: pz,
              targetX: target.x, targetZ: target.z,
              fleeMode: nearDanger,
            });
            AgentAction.targetX[eid] = target.x;
            AgentAction.targetZ[eid] = target.z;
            // Run away from danger, walk if safe
            AgentAction.actionType[eid] = nearDanger ? ActionType.RUN_TO : ActionType.MOVE_TO;
            AgentAction.progress[eid] = 0;
          }
          break;
        }

        case ActionType.MOVE_TO:
        case ActionType.ENTER_BUILDING:
        case ActionType.EXIT_BUILDING: {
          // If walk target is now inside a danger zone, abort and flee
          if (isInDangerZone(tx, tz, zones) || (zones.some(z => z.expiresAt > now) && minDangerDist(px, pz, zones) < 5)) {
            const safe = pickWanderTarget(px, pz, obstacles, sceneBound, zones);
            agentLog.log("walk_danger_redirect", agent.config.name, {
              fromX: px, fromZ: pz,
              oldTargetX: tx, oldTargetZ: tz,
              safeTargetX: safe.x, safeTargetZ: safe.z,
            });
            AgentAction.targetX[eid] = safe.x;
            AgentAction.targetZ[eid] = safe.z;
            AgentAction.actionType[eid] = ActionType.RUN_TO;
            AgentAction.progress[eid] = 0;
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
            let nx = dx / dist;
            let nz = dz / dist;

            // Check if the flee target is dangerous or if we'd enter a danger zone.
            // But if we're already IN a zone heading toward a safe target, let us escape.
            // Also allow moving toward a target inside a zone if it's further from
            // danger than we are (escape vector — better than standing still).
            const agentInZone = isInDangerZone(px, pz, zones);
            const targetInZone = isInDangerZone(tx, tz, zones);
            const nextX = px + nx * speed * dt;
            const nextZ = pz + nz * speed * dt;
            const targetImprovesPosition = agentInZone && targetInZone
              && minDangerDist(tx, tz, zones) > minDangerDist(px, pz, zones);
            const shouldRedirect = !targetImprovesPosition
              && (targetInZone || (!agentInZone && isInDangerZone(nextX, nextZ, zones)));
            if (shouldRedirect) {
              const safe = pickWanderTarget(px, pz, obstacles, sceneBound, zones);
              agentLog.log("flee_redirected", agent.config.name, {
                originalTargetX: tx, originalTargetZ: tz,
                safeTargetX: safe.x, safeTargetZ: safe.z,
              });
              AgentAction.targetX[eid] = safe.x;
              AgentAction.targetZ[eid] = safe.z;
              const sdx = safe.x - px;
              const sdz = safe.z - pz;
              const sDist = Math.sqrt(sdx * sdx + sdz * sdz);
              if (sDist > 0.01) {
                nx = sdx / sDist;
                nz = sdz / sDist;
              }
            }

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
