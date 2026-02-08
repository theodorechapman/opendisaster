import type { RoadLine2D } from "../layers.ts";
import type { DangerZone } from "./AgentActionSystem.ts";

export interface GraphNode {
  id: number;
  x: number;
  z: number;
  isFootpath: boolean;
  edges: Set<number>;
}

const SAMPLE_SPACING = 8;   // meters between waypoints along a road
const MERGE_RADIUS = 3;     // meters — nodes within this are merged (forms intersections)

/**
 * Road navigation graph built from RoadLine2D polylines.
 * Nodes are waypoints sampled along roads; edges connect consecutive waypoints.
 */
export class RoadGraph {
  readonly nodes = new Map<number, GraphNode>();
  private nextId = 0;
  private grid = new Map<string, number[]>(); // spatial hash for nearest-node queries
  private readonly GRID_CELL = 10; // meters per grid cell

  constructor(roadLines: RoadLine2D[]) {
    this.buildFromRoads(roadLines);
  }

  private gridKey(x: number, z: number): string {
    const gx = Math.floor(x / this.GRID_CELL);
    const gz = Math.floor(z / this.GRID_CELL);
    return `${gx},${gz}`;
  }

  private addToGrid(id: number, x: number, z: number): void {
    const key = this.gridKey(x, z);
    const bucket = this.grid.get(key);
    if (bucket) bucket.push(id);
    else this.grid.set(key, [id]);
  }

  private findNearbyInGrid(x: number, z: number, radius: number): number[] {
    const results: number[] = [];
    const cells = Math.ceil(radius / this.GRID_CELL);
    const gx0 = Math.floor(x / this.GRID_CELL);
    const gz0 = Math.floor(z / this.GRID_CELL);
    for (let dx = -cells; dx <= cells; dx++) {
      for (let dz = -cells; dz <= cells; dz++) {
        const bucket = this.grid.get(`${gx0 + dx},${gz0 + dz}`);
        if (bucket) results.push(...bucket);
      }
    }
    return results;
  }

  private buildFromRoads(roadLines: RoadLine2D[]): void {
    for (const road of roadLines) {
      const { points, isFootpath } = road;
      if (points.length < 2) continue;

      let prevNodeId = -1;

      // Walk along the polyline, sampling waypoints every SAMPLE_SPACING meters
      let accumulated = 0;
      for (let i = 0; i < points.length; i++) {
        const [px, pz] = points[i]!;

        if (i === 0) {
          prevNodeId = this.getOrCreateNode(px, pz, isFootpath);
          continue;
        }

        const [prevPx, prevPz] = points[i - 1]!;
        const segDx = px - prevPx;
        const segDz = pz - prevPz;
        const segLen = Math.sqrt(segDx * segDx + segDz * segDz);
        if (segLen < 0.01) continue;

        accumulated += segLen;

        // Sample intermediate points along this segment
        if (accumulated >= SAMPLE_SPACING || i === points.length - 1) {
          const nodeId = this.getOrCreateNode(px, pz, isFootpath);
          if (prevNodeId >= 0 && prevNodeId !== nodeId) {
            this.addEdge(prevNodeId, nodeId);
          }
          prevNodeId = nodeId;
          accumulated = 0;
        }
      }
    }

    console.log(`[RoadGraph] Built graph: ${this.nodes.size} nodes, ${this.countEdges()} edges`);
  }

  private getOrCreateNode(x: number, z: number, isFootpath: boolean): number {
    // Check if a nearby node already exists (merge within MERGE_RADIUS)
    const nearby = this.findNearbyInGrid(x, z, MERGE_RADIUS);
    for (const id of nearby) {
      const node = this.nodes.get(id)!;
      const dx = node.x - x;
      const dz = node.z - z;
      if (dx * dx + dz * dz < MERGE_RADIUS * MERGE_RADIUS) {
        return id;
      }
    }

    const id = this.nextId++;
    const node: GraphNode = { id, x, z, isFootpath, edges: new Set() };
    this.nodes.set(id, node);
    this.addToGrid(id, x, z);
    return id;
  }

  private addEdge(a: number, b: number): void {
    this.nodes.get(a)!.edges.add(b);
    this.nodes.get(b)!.edges.add(a);
  }

  private countEdges(): number {
    let total = 0;
    for (const node of this.nodes.values()) total += node.edges.size;
    return total / 2;
  }

  /** Find the closest graph node to a world position. Returns -1 if no nodes. */
  nearestNode(x: number, z: number): number {
    let bestId = -1;
    let bestDist = Infinity;

    // Try spatial hash first (fast path)
    const nearby = this.findNearbyInGrid(x, z, 50);
    for (const id of nearby) {
      const node = this.nodes.get(id)!;
      const dx = node.x - x;
      const dz = node.z - z;
      const d = dx * dx + dz * dz;
      if (d < bestDist) {
        bestDist = d;
        bestId = id;
      }
    }

    // If nothing within 50m, brute-force search
    if (bestId === -1) {
      for (const node of this.nodes.values()) {
        const dx = node.x - x;
        const dz = node.z - z;
        const d = dx * dx + dz * dz;
        if (d < bestDist) {
          bestDist = d;
          bestId = node.id;
        }
      }
    }

    return bestId;
  }

  /** Random walk: pick random edges for `steps` hops. Returns list of node IDs (not including start). */
  randomWalk(fromNode: number, steps: number, avoid: number[] = []): number[] {
    const avoidSet = new Set(avoid);
    const path: number[] = [];
    let current = fromNode;

    for (let i = 0; i < steps; i++) {
      const node = this.nodes.get(current);
      if (!node || node.edges.size === 0) break;

      const edges = [...node.edges];
      // Prefer edges not recently visited
      const fresh = edges.filter(e => !avoidSet.has(e) && !path.includes(e));
      const candidates = fresh.length > 0 ? fresh : edges;
      const next = candidates[Math.floor(Math.random() * candidates.length)]!;
      path.push(next);
      current = next;
    }

    return path;
  }

  /** Flee route: greedy graph traversal maximizing distance from danger zones. */
  fleeRoute(fromNode: number, dangerZones: DangerZone[], steps: number, avoid: number[] = []): number[] {
    const avoidSet = new Set(avoid);
    const now = Date.now();
    const activeZones = dangerZones.filter(z => z.expiresAt > now);
    if (activeZones.length === 0) return this.randomWalk(fromNode, steps, avoid);

    const path: number[] = [];
    let current = fromNode;

    for (let i = 0; i < steps; i++) {
      const node = this.nodes.get(current);
      if (!node || node.edges.size === 0) break;

      const edges = [...node.edges];
      let bestEdge = -1;
      let bestScore = -Infinity;

      for (const edgeId of edges) {
        const edgeNode = this.nodes.get(edgeId)!;
        const dangerDist = this.minDangerDist(edgeNode.x, edgeNode.z, activeZones);
        // Penalize recently visited nodes to avoid loops
        const penalty = (avoidSet.has(edgeId) || path.includes(edgeId)) ? -20 : 0;
        const score = dangerDist + penalty;

        if (score > bestScore) {
          bestScore = score;
          bestEdge = edgeId;
        }
      }

      if (bestEdge === -1) break;
      path.push(bestEdge);
      current = bestEdge;
    }

    return path;
  }

  /** Get all node IDs within `radius` meters of scene center (0,0). */
  nodesNearCenter(radius: number): number[] {
    const r2 = radius * radius;
    const result: number[] = [];
    for (const node of this.nodes.values()) {
      if (node.x * node.x + node.z * node.z < r2) {
        result.push(node.id);
      }
    }
    return result;
  }

  /** Greedy pick N well-spread nodes from candidates (maximize min pairwise distance). */
  spreadPick(candidates: number[], count: number): number[] {
    if (candidates.length <= count) return [...candidates];

    const picked: number[] = [];
    // Start with a random candidate
    picked.push(candidates[Math.floor(Math.random() * candidates.length)]!);

    while (picked.length < count) {
      let bestId = -1;
      let bestMinDist = -Infinity;

      for (const cId of candidates) {
        if (picked.includes(cId)) continue;
        const cNode = this.nodes.get(cId)!;

        // Min distance to any already-picked node
        let minDist = Infinity;
        for (const pId of picked) {
          const pNode = this.nodes.get(pId)!;
          const dx = cNode.x - pNode.x;
          const dz = cNode.z - pNode.z;
          minDist = Math.min(minDist, dx * dx + dz * dz);
        }

        if (minDist > bestMinDist) {
          bestMinDist = minDist;
          bestId = cId;
        }
      }

      if (bestId === -1) break;
      picked.push(bestId);
    }

    return picked;
  }

  /** Get world position of a node. */
  getNodePos(id: number): { x: number; z: number } | null {
    const node = this.nodes.get(id);
    if (!node) return null;
    return { x: node.x, z: node.z };
  }

  /** Convert a path of node IDs to world positions with small random offsets. */
  pathToWaypoints(nodeIds: number[], jitter = 1.5): { x: number; z: number }[] {
    return nodeIds.map(id => {
      const node = this.nodes.get(id)!;
      return {
        x: node.x + (Math.random() - 0.5) * jitter * 2,
        z: node.z + (Math.random() - 0.5) * jitter * 2,
      };
    });
  }

  /** Is a node an intersection (3+ edges)? */
  isIntersection(nodeId: number): boolean {
    const node = this.nodes.get(nodeId);
    return node ? node.edges.size >= 3 : false;
  }

  private minDangerDist(x: number, z: number, zones: DangerZone[]): number {
    let minDist = Infinity;
    for (const zone of zones) {
      const dx = x - zone.x;
      const dz = z - zone.z;
      minDist = Math.min(minDist, Math.sqrt(dx * dx + dz * dz) - zone.radius);
    }
    return minDist;
  }
}
