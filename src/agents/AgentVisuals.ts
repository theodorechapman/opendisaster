import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { clone as skeletonClone } from "three/examples/jsm/utils/SkeletonUtils.js";
import type { AgentConfig } from "./types.ts";

const EYE_HEIGHT = 8;
const TARGET_HEIGHT = 10; // desired agent height in world units

export interface AgentVisual {
  mesh: THREE.Object3D; // Group containing the cloned human model
  camera: THREE.PerspectiveCamera;
}

export class AgentVisuals {
  private visuals: AgentVisual[] = [];
  private scene: THREE.Scene;
  private template: THREE.Group | null = null;
  private modelScale = 1;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
  }

  /** Load the human GLB model once. Must be called before createAgent(). */
  async loadModel(): Promise<void> {
    const loader = new GLTFLoader();
    const gltf = await loader.loadAsync("/models/human.glb");
    this.template = gltf.scene as THREE.Group;

    // Compute scale so the model is TARGET_HEIGHT tall
    const box = new THREE.Box3().setFromObject(this.template);
    const height = box.max.y - box.min.y;
    this.modelScale = height > 0 ? TARGET_HEIGHT / height : 1;
    console.log(`[AgentVisuals] Model loaded, native height=${height.toFixed(2)}, scale=${this.modelScale.toFixed(3)}`);
  }

  /** Create a cloned human mesh and first-person camera for an agent. */
  createAgent(config: AgentConfig): AgentVisual {
    if (!this.template) {
      throw new Error("AgentVisuals.loadModel() must be called before createAgent()");
    }

    // Clone the skinned mesh properly
    const model = skeletonClone(this.template);
    model.scale.setScalar(this.modelScale);

    // Apply per-agent color
    model.traverse((child) => {
      if (child instanceof THREE.Mesh && child.material) {
        // Clone material so per-agent color doesn't affect others
        const mat = (child.material as THREE.Material).clone() as THREE.MeshStandardMaterial;
        if (mat.color) {
          mat.color.setHex(config.color);
        }
        child.material = mat;
        child.castShadow = true;
        child.receiveShadow = true;
      }
    });

    const group = new THREE.Group();
    group.name = `agent_${config.name}`;
    group.add(model);
    group.position.set(
      config.spawnPosition.x,
      config.spawnPosition.y,
      config.spawnPosition.z,
    );

    const camera = new THREE.PerspectiveCamera(90, 1, 0.1, 500);
    // Camera is a child of the group so it moves/rotates with it.
    // Default camera looks along local -Z, but our yaw convention (atan2(nx,nz))
    // treats yaw=0 as facing +Z, so rotate camera π to align with +Z forward.
    group.add(camera);
    camera.position.set(0, EYE_HEIGHT, 0);
    camera.rotation.set(0, Math.PI, 0);

    this.scene.add(group);

    const visual: AgentVisual = { mesh: group, camera };
    this.visuals.push(visual);
    return visual;
  }

  /** Update camera and mesh orientation from yaw (radians around Y). */
  updateCamera(index: number, yaw: number): void {
    const visual = this.visuals[index];
    if (!visual) return;
    // Rotate the entire group (mesh + camera) so the agent body faces the walk direction.
    // The camera is a child of the group, so it inherits this rotation and looks forward.
    visual.mesh.rotation.y = yaw;
  }

  /** Update mesh position from ECS data. */
  updatePosition(index: number, x: number, y: number, z: number): void {
    const visual = this.visuals[index];
    if (!visual) return;
    visual.mesh.position.set(x, y, z);
  }

  /** Turn mesh gray when agent dies. */
  markDead(index: number): void {
    const visual = this.visuals[index];
    if (!visual) return;
    visual.mesh.traverse((child) => {
      if (child instanceof THREE.Mesh && child.material) {
        const mat = child.material as THREE.MeshStandardMaterial;
        if (mat.color) {
          mat.color.setHex(0x555555);
        }
      }
    });
  }

  getVisual(index: number): AgentVisual | undefined {
    return this.visuals[index];
  }

  get count(): number {
    return this.visuals.length;
  }
}
