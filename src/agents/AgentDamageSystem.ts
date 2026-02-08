import {
  Position,
  AgentState,
} from "../core/Components.ts";
import type { EventBus, DisasterEvent } from "../core/EventBus.ts";
import type { AgentManager } from "./AgentManager.ts";

/**
 * Creates the agent damage ECS system.
 * Subscribes to EventBus hazards and applies damage/panic to agents.
 */
export function createAgentDamageSystem(
  manager: AgentManager,
  eventBus: EventBus,
) {
  const pendingEvents: DisasterEvent[] = [];

  eventBus.on("*", (event) => {
    pendingEvents.push(event);
  });

  return (_world: any, dt: number) => {
    while (pendingEvents.length > 0) {
      const event = pendingEvents.shift()!;

      for (const agent of manager.agents) {
        const eid = agent.eid;
        if (AgentState.alive[eid]! === 0) continue;

        const ax = Position.x[eid]!;
        const az = Position.z[eid]!;

        switch (event.type) {
          case "STRUCTURE_COLLAPSE": {
            const [ex, _ey, ez] = event.position;
            const dist = Math.sqrt((ax - ex) ** 2 + (az - ez) ** 2);
            const radius = 10;
            if (dist < radius) {
              const damage = 80 * (1 - dist / radius);
              AgentState.health[eid] = AgentState.health[eid]! - damage;
              AgentState.panicLevel[eid] = Math.min(1, AgentState.panicLevel[eid]! + 0.4);
              manager.addEvent(agent.index, `Building collapsed ${dist.toFixed(0)}m away! Took ${damage.toFixed(0)} damage.`);
            }
            break;
          }

          case "FLOOD_LEVEL": {
            const [fx, _fy, fz] = event.position;
            const dist = Math.sqrt((ax - fx) ** 2 + (az - fz) ** 2);
            if (dist < 20 && event.waterHeight > 1.5) {
              const damage = 5 * event.waterHeight * dt;
              AgentState.health[eid] = AgentState.health[eid]! - damage;
              AgentState.panicLevel[eid] = Math.min(1, AgentState.panicLevel[eid]! + 0.2);
              manager.addEvent(agent.index, `Flooding! Water height ${event.waterHeight.toFixed(1)}m.`);
            }
            break;
          }

          case "FIRE_SPREAD": {
            const [fx, _fy, fz] = event.position;
            const dist = Math.sqrt((ax - fx) ** 2 + (az - fz) ** 2);
            const r = event.radius;
            const intensity = event.intensity;

            if (dist < r) {
              // Core fire zone: quadratic falloff (center=full, edge=30%)
              const normDist = dist / r;
              const falloff = 1.0 - 0.7 * normDist * normDist;
              const damage = 35 * intensity * falloff * dt;
              AgentState.health[eid] = AgentState.health[eid]! - damage;
              AgentState.panicLevel[eid] = Math.min(1, AgentState.panicLevel[eid]! + 0.3);
              manager.addEvent(agent.index, `In fire! Intensity ${intensity.toFixed(1)}, distance ${dist.toFixed(0)}m.`);
            } else if (dist < r * 1.5) {
              // Heat radiation zone: linear falloff
              const normDist = (dist - r) / (r * 0.5);
              const falloff = 1.0 - normDist;
              const damage = 8 * intensity * falloff * dt;
              AgentState.health[eid] = AgentState.health[eid]! - damage;
              AgentState.panicLevel[eid] = Math.min(1, AgentState.panicLevel[eid]! + 0.15);
              manager.addEvent(agent.index, `Heat radiation! Intensity ${intensity.toFixed(1)}, distance ${dist.toFixed(0)}m.`);
            } else if (dist < r * 2.5) {
              // Smoke zone: linear falloff
              const normDist = (dist - r * 1.5) / (r * 1.0);
              const falloff = 1.0 - normDist;
              const damage = 2 * intensity * falloff * dt;
              AgentState.health[eid] = AgentState.health[eid]! - damage;
              if (Math.random() < 0.05) {
                AgentState.panicLevel[eid] = Math.min(1, AgentState.panicLevel[eid]! + 0.1);
                manager.addEvent(agent.index, `Smoke inhalation! Distance ${dist.toFixed(0)}m from fire.`);
              }
            }
            break;
          }

          case "GROUND_SHAKE": {
            const [ex, _ey, ez] = event.epicenter;
            const dist = Math.sqrt((ax - ex) ** 2 + (az - ez) ** 2);
            if (dist < 200) {
              const panicIncrease = 0.3 * (1 - dist / 200);
              AgentState.panicLevel[eid] = Math.min(1, AgentState.panicLevel[eid]! + panicIncrease);

              if (Math.random() < 0.1) {
                AgentState.health[eid] = AgentState.health[eid]! - 10;
                AgentState.injured[eid] = AgentState.injured[eid]! | 1;
                manager.addEvent(agent.index, `Hit by debris during earthquake! Magnitude ${event.magnitude.toFixed(1)}.`);
              } else {
                manager.addEvent(agent.index, `Earthquake felt! Magnitude ${event.magnitude.toFixed(1)}.`);
              }
            }
            break;
          }
        }

        // Check for death
        if (AgentState.health[eid]! <= 0 && AgentState.alive[eid]! === 1) {
          AgentState.alive[eid] = 0;
          AgentState.health[eid] = 0;
          manager.visuals.markDead(agent.index);

          eventBus.emit({
            type: "AGENT_DEATH",
            agentIndex: agent.index,
            name: agent.config.name,
            position: [Position.x[eid]!, Position.y[eid]!, Position.z[eid]!],
          });

          console.log(`[Agents] ${agent.config.name} has died!`);
          manager.addEvent(agent.index, "I have died.");
        }
      }
    }

    // Natural panic decay
    for (const agent of manager.agents) {
      const eid = agent.eid;
      if (AgentState.alive[eid]! === 0) continue;
      AgentState.panicLevel[eid] = Math.max(0, AgentState.panicLevel[eid]! - 0.02 * dt);
    }
  };
}
