// bitECS v0.4: components are plain objects with TypedArray properties.
// Max entities defaults to 100,000.
const MAX_ENTITIES = 100_000;

export const Position = {
  x: new Float64Array(MAX_ENTITIES),
  y: new Float64Array(MAX_ENTITIES),
  z: new Float64Array(MAX_ENTITIES),
};

export const Rotation = {
  x: new Float32Array(MAX_ENTITIES),
  y: new Float32Array(MAX_ENTITIES),
  z: new Float32Array(MAX_ENTITIES),
  w: new Float32Array(MAX_ENTITIES),
};

export const Scale = {
  x: new Float32Array(MAX_ENTITIES),
  y: new Float32Array(MAX_ENTITIES),
  z: new Float32Array(MAX_ENTITIES),
};

export const Velocity = {
  x: new Float32Array(MAX_ENTITIES),
  y: new Float32Array(MAX_ENTITIES),
  z: new Float32Array(MAX_ENTITIES),
};

export const MeshRef = {
  objectId: new Uint32Array(MAX_ENTITIES),
};

export const PhysicsBody = {
  bodyId: new Uint32Array(MAX_ENTITIES),
  mass: new Float32Array(MAX_ENTITIES),
  materialId: new Uint8Array(MAX_ENTITIES),
};

export const Health = {
  current: new Float32Array(MAX_ENTITIES),
  max: new Float32Array(MAX_ENTITIES),
  damageThreshold: new Float32Array(MAX_ENTITIES),
};

export enum ClassificationType {
  GROUND = 0,
  BUILDING = 1,
  VEGETATION = 2,
  WATER = 3,
  DEBRIS = 4,
  AGENT = 5,
}

export enum ActionType {
  IDLE = 0,
  MOVE_TO = 1,
  RUN_TO = 2,
  HELP_PERSON = 4,
  EVACUATE = 5,
  WAIT = 6,
  ENTER_BUILDING = 7,
  EXIT_BUILDING = 8,
}

export const Agent = {
  agentIndex: new Uint8Array(MAX_ENTITIES),
};

export const AgentState = {
  health:     new Float32Array(MAX_ENTITIES),
  stamina:    new Float32Array(MAX_ENTITIES),
  panicLevel: new Float32Array(MAX_ENTITIES),
  injured:    new Uint8Array(MAX_ENTITIES),   // bitmask: 1=minor, 2=major, 4=critical
  alive:      new Uint8Array(MAX_ENTITIES),   // 1=alive, 0=dead
};

export const AgentAction = {
  actionType: new Uint8Array(MAX_ENTITIES),
  targetX:    new Float64Array(MAX_ENTITIES),
  targetZ:    new Float64Array(MAX_ENTITIES),
  targetEid:  new Uint32Array(MAX_ENTITIES),
  progress:   new Float32Array(MAX_ENTITIES),
};

export const AgentFacing = {
  yaw: new Float32Array(MAX_ENTITIES),
};

export const Classification = {
  type: new Uint8Array(MAX_ENTITIES),
};

export const TerrainCell = {
  height: new Float32Array(MAX_ENTITIES),
  moisture: new Float32Array(MAX_ENTITIES),
  fuelLoad: new Float32Array(MAX_ENTITIES),
  temperature: new Float32Array(MAX_ENTITIES),
};

// Register all components with a world
export function registerAllComponents(world: any): void {
  const { registerComponent } = require("bitecs");
  const components = [
    Position,
    Rotation,
    Scale,
    Velocity,
    MeshRef,
    PhysicsBody,
    Health,
    Classification,
    TerrainCell,
    Agent,
    AgentState,
    AgentAction,
    AgentFacing,
  ];
  for (const c of components) {
    registerComponent(world, c);
  }
}
