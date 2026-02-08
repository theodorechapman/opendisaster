import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { clone as skeletonClone } from "three/examples/jsm/utils/SkeletonUtils.js";
import type { AgentConfig } from "./types.ts";

const EYE_HEIGHT = 8;
const TARGET_HEIGHT = 10; // desired agent height in world units

/** Animation clip names embedded in Man.glb */
const CLIP_NAMES: Record<string, string> = {
  idle: "HumanArmature|Man_Idle",
  walk: "HumanArmature|Man_Walk",
  run: "HumanArmature|Man_Run",
  death: "HumanArmature|Man_Death",
};

export interface AgentVisual {
  mesh: THREE.Object3D; // Group containing the cloned human model
  camera: THREE.PerspectiveCamera;
  mixer: THREE.AnimationMixer;
  actions: Map<string, THREE.AnimationAction>;
  currentAnim: string;
}

export class AgentVisuals {
  private visuals: AgentVisual[] = [];
  private scene: THREE.Scene;
  private template: THREE.Group | null = null;
  private animations: THREE.AnimationClip[] = [];
  private modelScale = 1;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
  }

  /** Load the human GLB model once. Must be called before createAgent(). */
  async loadModel(): Promise<void> {
    const loader = new GLTFLoader();
    const modelUrl = encodeURI("/models/Animated Men Pack-glb (1)/Man.glb");
    const gltf = await loader.loadAsync(modelUrl);
    this.template = gltf.scene as THREE.Group;
    this.animations = gltf.animations;

    // Compute scale so the model is TARGET_HEIGHT tall
    const box = new THREE.Box3().setFromObject(this.template);
    const height = box.max.y - box.min.y;
    this.modelScale = height > 0 ? TARGET_HEIGHT / height : 1;
    console.log(
      `[AgentVisuals] Model loaded, native height=${height.toFixed(2)}, scale=${this.modelScale.toFixed(3)}. Animations: ${this.animations.length} clips`,
    );
  }

  /** Create a cloned human mesh and first-person camera for an agent. */
  createAgent(config: AgentConfig): AgentVisual {
    if (!this.template) {
      throw new Error("AgentVisuals.loadModel() must be called before createAgent()");
    }

    // Clone the skinned mesh properly
    const model = skeletonClone(this.template);
    model.scale.setScalar(this.modelScale);

    // Clone materials so per-agent tint doesn't affect others.
    // We tint by lerping toward the agent color instead of replacing,
    // so the model's original textures and detail remain visible.
    const tintColor = new THREE.Color(config.color);
    model.traverse((child) => {
      if (child instanceof THREE.Mesh && child.material) {
        const mat = (child.material as THREE.Material).clone() as THREE.MeshStandardMaterial;
        if (mat.color) {
          mat.color.lerp(tintColor, 0.4);
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

    // Set up AnimationMixer on the cloned model
    const mixer = new THREE.AnimationMixer(model);
    const actions = new Map<string, THREE.AnimationAction>();

    for (const [key, clipName] of Object.entries(CLIP_NAMES)) {
      const clip = this.animations.find((c) => c.name === clipName);
      if (clip) {
        const action = mixer.clipAction(clip);
        if (key === "death") {
          action.setLoop(THREE.LoopOnce, 1);
          action.clampWhenFinished = true;
        }
        actions.set(key, action);
      }
    }

    // Play idle by default
    const idleAction = actions.get("idle");
    if (idleAction) {
      idleAction.play();
    }

    const visual: AgentVisual = { mesh: group, camera, mixer, actions, currentAnim: "idle" };
    this.visuals.push(visual);
    return visual;
  }

  /** Crossfade to a target animation. Skips if already playing. */
  setAnimation(index: number, name: string): void {
    const visual = this.visuals[index];
    if (!visual || visual.currentAnim === name) return;

    const nextAction = visual.actions.get(name);
    if (!nextAction) return;

    const prevAction = visual.actions.get(visual.currentAnim);
    if (prevAction) {
      prevAction.fadeOut(0.3);
    }

    nextAction.reset().fadeIn(0.3).play();
    visual.currentAnim = name;
  }

  /** Tick all animation mixers. Call once per frame. */
  updateAnimations(dt: number): void {
    for (const visual of this.visuals) {
      visual.mixer.update(dt);
    }
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

  /** Turn mesh gray when agent dies and play death animation. */
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
    this.setAnimation(index, "death");
  }

  getVisual(index: number): AgentVisual | undefined {
    return this.visuals[index];
  }

  get count(): number {
    return this.visuals.length;
  }
}
