export type Vec3 = [number, number, number];

export type GroundShakeEvent = {
  type: "GROUND_SHAKE";
  epicenter: Vec3;
  magnitude: number;
  pga: number;
};

export type GroundDisplacementEvent = {
  type: "GROUND_DISPLACEMENT";
  region: [number, number, number, number]; // [x0, z0, x1, z1]
  maxDisplacement: number;
};

export type StructureCollapseEvent = {
  type: "STRUCTURE_COLLAPSE";
  entityId: number;
  position: Vec3;
  fragmentCount: number;
};

export type FloodLevelEvent = {
  type: "FLOOD_LEVEL";
  position: Vec3;
  waterHeight: number;
  velocity: Vec3;
};

export type FireSpreadEvent = {
  type: "FIRE_SPREAD";
  position: Vec3;
  intensity: number;
  radius: number;
};

export type WindFieldUpdateEvent = {
  type: "WIND_FIELD_UPDATE";
  direction: Vec3;
  speed: number;
  center: Vec3;
  coreRadius: number;
  outerRadius: number;
  maxWindSpeed: number;
};

export type AgentDamagedEvent = {
  type: "AGENT_DAMAGED";
  agentIndex: number;
  position: Vec3;
  damage: number;
  source: string;
};

export type AgentDeathEvent = {
  type: "AGENT_DEATH";
  agentIndex: number;
  name: string;
  position: Vec3;
};

export type DisasterEvent =
  | GroundShakeEvent
  | GroundDisplacementEvent
  | StructureCollapseEvent
  | FloodLevelEvent
  | FireSpreadEvent
  | WindFieldUpdateEvent
  | AgentDamagedEvent
  | AgentDeathEvent;

export type EventType = DisasterEvent["type"] | "*";
export type EventListener = (event: DisasterEvent) => void;

export class EventBus {
  private listeners = new Map<EventType, Set<EventListener>>();

  on(type: EventType, listener: EventListener): () => void {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set());
    }
    this.listeners.get(type)!.add(listener);

    return () => this.off(type, listener);
  }

  once(type: EventType, listener: EventListener): () => void {
    const wrapper: EventListener = (event) => {
      this.off(type, wrapper);
      listener(event);
    };
    return this.on(type, wrapper);
  }

  off(type: EventType, listener: EventListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  emit(event: DisasterEvent): void {
    // Notify type-specific listeners
    const typeListeners = this.listeners.get(event.type);
    if (typeListeners) {
      for (const listener of typeListeners) {
        listener(event);
      }
    }

    // Notify wildcard listeners
    const wildcardListeners = this.listeners.get("*");
    if (wildcardListeners) {
      for (const listener of wildcardListeners) {
        listener(event);
      }
    }
  }

  clear(): void {
    this.listeners.clear();
  }
}
