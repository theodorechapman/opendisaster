import {
  Position,
  AgentState,
} from "../core/Components.ts";
import type { EventBus, DisasterEvent } from "../core/EventBus.ts";
import type { AgentManager } from "./AgentManager.ts";

/** Global damage multiplier — increase to make sims deadlier for testing. */
const DMG_SCALE = 3.0;

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
              const damage = 80 * (1 - dist / radius) * DMG_SCALE;
              AgentState.health[eid] = AgentState.health[eid]! - damage;
              AgentState.panicLevel[eid] = Math.min(1, AgentState.panicLevel[eid]! + 0.4);
              eventBus.emit({ type: "AGENT_DAMAGED", agentIndex: agent.index, position: [ax, Position.y[eid]!, az], damage, source: event.type });
              manager.addEvent(agent.index, `Building collapsed ${dist.toFixed(0)}m away! Took ${damage.toFixed(0)} damage.`);
            }
            break;
          }

          case "FLOOD_LEVEL": {
            // NOTE: FLOOD_LEVEL emits every 0.5s, so multiply by 0.5 for per-event damage.
            const FLOOD_DT = 0.5;
            const [fx, _fy, fz] = event.position;
            const dist = Math.sqrt((ax - fx) ** 2 + (az - fz) ** 2);
            if (dist < 20) {
              const wh = event.waterHeight;
              const vx = event.velocity[0];
              const vz = event.velocity[2];
              const velocity = Math.sqrt(vx * vx + vz * vz);

              if (wh > 1.5) {
                // Chest+ deep: dangerous
                const damage = (4 * wh + 1.5 * velocity) * FLOOD_DT * DMG_SCALE;
                AgentState.health[eid] = AgentState.health[eid]! - damage;
                AgentState.panicLevel[eid] = Math.min(1, AgentState.panicLevel[eid]! + 0.2);
                eventBus.emit({ type: "AGENT_DAMAGED", agentIndex: agent.index, position: [ax, Position.y[eid]!, az], damage, source: event.type });
                manager.addEvent(agent.index, `Deep flooding! Water height ${wh.toFixed(1)}m.`);
              } else if (wh > 0.8) {
                // Waist-deep: slow damage
                const damage = (1.5 * wh + 0.8 * velocity) * FLOOD_DT * DMG_SCALE;
                AgentState.health[eid] = AgentState.health[eid]! - damage;
                AgentState.panicLevel[eid] = Math.min(1, AgentState.panicLevel[eid]! + 0.1);
                eventBus.emit({ type: "AGENT_DAMAGED", agentIndex: agent.index, position: [ax, Position.y[eid]!, az], damage, source: event.type });
                manager.addEvent(agent.index, `Waist-deep flooding! Water height ${wh.toFixed(1)}m.`);
              } else if (wh > 0.3) {
                // Ankle-deep: light damage + panic
                const damage = (0.4 * wh + 0.3 * velocity) * FLOOD_DT * DMG_SCALE;
                AgentState.health[eid] = AgentState.health[eid]! - damage;
                AgentState.panicLevel[eid] = Math.min(1, AgentState.panicLevel[eid]! + 0.05);
              }

              // Velocity-based knockdown: swept away by current
              if (velocity > 1.5 && wh > 0.5) {
                const damage = 2.5 * velocity * FLOOD_DT * DMG_SCALE;
                AgentState.health[eid] = AgentState.health[eid]! - damage;
                eventBus.emit({ type: "AGENT_DAMAGED", agentIndex: agent.index, position: [ax, Position.y[eid]!, az], damage, source: event.type });
                manager.addEvent(agent.index, `Swept by flood current! Velocity ${velocity.toFixed(1)} m/s.`);
              }
            }
            break;
          }

          case "FIRE_SPREAD": {
            // NOTE: FIRE_SPREAD events emit once per second (EMIT_INTERVAL=1.0s),
            // so damage is per-event, NOT multiplied by dt.
            const [fx, _fy, fz] = event.position;
            const dist = Math.sqrt((ax - fx) ** 2 + (az - fz) ** 2);
            const r = event.radius;
            const intensity = event.intensity;

            if (dist < r) {
              // Core fire zone: ~4 HP/event at center with intensity 0.8 → ~25s to kill
              const normDist = dist / r;
              const falloff = 1.0 - 0.7 * normDist * normDist;
              const damage = 5 * intensity * falloff * DMG_SCALE;
              AgentState.health[eid] = AgentState.health[eid]! - damage;
              AgentState.panicLevel[eid] = Math.min(1, AgentState.panicLevel[eid]! + 0.3);
              eventBus.emit({ type: "AGENT_DAMAGED", agentIndex: agent.index, position: [ax, Position.y[eid]!, az], damage, source: event.type });
              manager.addEvent(agent.index, `In fire! Intensity ${intensity.toFixed(1)}, distance ${dist.toFixed(0)}m.`);
            } else if (dist < r * 1.5) {
              // Heat radiation zone: ~1.2 HP/event max
              const normDist = (dist - r) / (r * 0.5);
              const falloff = 1.0 - normDist;
              const damage = 1.5 * intensity * falloff * DMG_SCALE;
              AgentState.health[eid] = AgentState.health[eid]! - damage;
              AgentState.panicLevel[eid] = Math.min(1, AgentState.panicLevel[eid]! + 0.15);
              eventBus.emit({ type: "AGENT_DAMAGED", agentIndex: agent.index, position: [ax, Position.y[eid]!, az], damage, source: event.type });
              manager.addEvent(agent.index, `Heat radiation! Intensity ${intensity.toFixed(1)}, distance ${dist.toFixed(0)}m.`);
            } else if (dist < r * 2.5) {
              // Smoke zone: ~0.4 HP/event max
              const normDist = (dist - r * 1.5) / (r * 1.0);
              const falloff = 1.0 - normDist;
              const damage = 0.5 * intensity * falloff * DMG_SCALE;
              AgentState.health[eid] = AgentState.health[eid]! - damage;
              eventBus.emit({ type: "AGENT_DAMAGED", agentIndex: agent.index, position: [ax, Position.y[eid]!, az], damage, source: event.type });
              if (Math.random() < 0.05) {
                AgentState.panicLevel[eid] = Math.min(1, AgentState.panicLevel[eid]! + 0.1);
                manager.addEvent(agent.index, `Smoke inhalation! Distance ${dist.toFixed(0)}m from fire.`);
              }
            }
            break;
          }

          case "WIND_FIELD_UPDATE": {
            // NOTE: WIND_FIELD_UPDATE emits every 0.5s, so multiply by 0.5 for per-event damage.
            const WIND_DT = 0.5;
            const [cx, _cy, cz] = event.center;
            const dist = Math.sqrt((ax - cx) ** 2 + (az - cz) ** 2);
            const { coreRadius, outerRadius, maxWindSpeed } = event;

            // Rankine vortex wind speed at agent position
            let windSpeed: number;
            if (dist < 0.1) {
              windSpeed = maxWindSpeed * 0.7;
            } else if (dist <= coreRadius) {
              windSpeed = maxWindSpeed * (dist / coreRadius);
            } else {
              windSpeed = maxWindSpeed * (coreRadius / dist);
            }

            if (dist < coreRadius) {
              // Core vortex: quadratic + quartic severity
              const speedRatio = windSpeed / maxWindSpeed;
              const damage = (10 * speedRatio * speedRatio + 12 * Math.pow(speedRatio, 4)) * WIND_DT * DMG_SCALE;
              AgentState.health[eid] = AgentState.health[eid]! - damage;
              AgentState.panicLevel[eid] = Math.min(1, AgentState.panicLevel[eid]! + 0.3);
              eventBus.emit({ type: "AGENT_DAMAGED", agentIndex: agent.index, position: [ax, Position.y[eid]!, az], damage, source: event.type });

              // Debris hit chance scales with wind intensity
              const debrisChance = 0.06 + 0.12 * speedRatio;
              if (Math.random() < debrisChance) {
                const debrisDmg = (18 + 24 * speedRatio) * DMG_SCALE;
                AgentState.health[eid] = AgentState.health[eid]! - debrisDmg;
                AgentState.injured[eid] = AgentState.injured[eid]! | 1;
                eventBus.emit({ type: "AGENT_DAMAGED", agentIndex: agent.index, position: [ax, Position.y[eid]!, az], damage: debrisDmg, source: "WIND_DEBRIS" });
                manager.addEvent(agent.index, `Hit by flying debris in tornado core! Wind ${windSpeed.toFixed(0)} m/s.`);
              } else {
                manager.addEvent(agent.index, `In tornado core! Wind ${windSpeed.toFixed(0)} m/s, distance ${dist.toFixed(0)}m.`);
              }
            } else if (dist < outerRadius) {
              // Outer vortex: lighter but still hazardous
              const speedRatio = windSpeed / maxWindSpeed;
              const damage = (4 * speedRatio * speedRatio) * WIND_DT * DMG_SCALE;
              AgentState.health[eid] = AgentState.health[eid]! - damage;
              AgentState.panicLevel[eid] = Math.min(1, AgentState.panicLevel[eid]! + 0.15);
              eventBus.emit({ type: "AGENT_DAMAGED", agentIndex: agent.index, position: [ax, Position.y[eid]!, az], damage, source: event.type });
              if (Math.random() < 0.03) {
                manager.addEvent(agent.index, `Strong winds! Wind ${windSpeed.toFixed(0)} m/s, distance ${dist.toFixed(0)}m from tornado.`);
              }
            }
            break;
          }

          case "GROUND_SHAKE": {
            // NOTE: GROUND_SHAKE emits every 0.5s, so multiply by 0.5 for per-event damage.
            const QUAKE_DT = 0.5;
            const [ex, _ey, ez] = event.epicenter;
            const dist = Math.sqrt((ax - ex) ** 2 + (az - ez) ** 2);
            const pga = event.pga;
            const magnitude = event.magnitude;

            if (dist < 50) {
              // Close range: ground shaking + falling objects
              const magBoost = 0.8 + (magnitude - 5) * 0.25;
              const damage = (4 * pga * magBoost) * QUAKE_DT * DMG_SCALE;
              AgentState.health[eid] = AgentState.health[eid]! - damage;
              AgentState.panicLevel[eid] = Math.min(1, AgentState.panicLevel[eid]! + 0.3 * (1 - dist / 50));
              eventBus.emit({ type: "AGENT_DAMAGED", agentIndex: agent.index, position: [ax, Position.y[eid]!, az], damage, source: event.type });

              // Debris hit chance scales with magnitude and proximity
              const debrisChance = 0.08 + 0.05 * Math.max(0, magnitude - 6);
              if (Math.random() < debrisChance) {
                const debrisDamage = (18 + 10 * (magnitude - 6)) * DMG_SCALE;
                AgentState.health[eid] = AgentState.health[eid]! - debrisDamage;
                AgentState.injured[eid] = AgentState.injured[eid]! | 1;
                eventBus.emit({ type: "AGENT_DAMAGED", agentIndex: agent.index, position: [ax, Position.y[eid]!, az], damage: debrisDamage, source: "QUAKE_DEBRIS" });
                manager.addEvent(agent.index, `Hit by debris during earthquake! Magnitude ${magnitude.toFixed(1)}, ${dist.toFixed(0)}m from epicenter.`);
              } else {
                manager.addEvent(agent.index, `Earthquake! Magnitude ${magnitude.toFixed(1)}, ${dist.toFixed(0)}m from epicenter.`);
              }
            } else if (dist < 200) {
              // Medium range: lighter shaking damage
              const magBoost = 0.7 + (magnitude - 5) * 0.18;
              const damage = (1.2 * pga * magBoost) * QUAKE_DT * DMG_SCALE;
              AgentState.health[eid] = AgentState.health[eid]! - damage;
              AgentState.panicLevel[eid] = Math.min(1, AgentState.panicLevel[eid]! + 0.15 * (1 - dist / 200));
              eventBus.emit({ type: "AGENT_DAMAGED", agentIndex: agent.index, position: [ax, Position.y[eid]!, az], damage, source: event.type });

              if (Math.random() < 0.03) {
                manager.addEvent(agent.index, `Earthquake felt! Magnitude ${magnitude.toFixed(1)}.`);
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
