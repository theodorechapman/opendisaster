import * as THREE from "three";

/**
 * Minecraft-style fly controls:
 *   WASD  — move horizontally
 *   Space — ascend
 *   Shift — descend
 *   Mouse — look around (pointer lock)
 */
export class FlyControls {
  camera: THREE.PerspectiveCamera;
  speed = 40; // m/s
  lookSpeed = 0.002;

  private keys = new Set<string>();
  private yaw = 0;
  private pitch = 0;
  private locked = false;

  constructor(camera: THREE.PerspectiveCamera, canvas: HTMLCanvasElement) {
    this.camera = camera;
    this.yaw = 0;
    this.pitch = 0;

    canvas.addEventListener("click", () => {
      canvas.requestPointerLock();
    });

    document.addEventListener("pointerlockchange", () => {
      this.locked = document.pointerLockElement === canvas;
      document.getElementById("crosshair")!.style.display = this.locked ? "block" : "none";
    });

    document.addEventListener("mousemove", (e) => {
      if (!this.locked) return;
      this.yaw -= e.movementX * this.lookSpeed;
      this.pitch -= e.movementY * this.lookSpeed;
      this.pitch = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, this.pitch));
    });

    window.addEventListener("keydown", (e) => {
      this.keys.add(e.code);
    });
    window.addEventListener("keyup", (e) => {
      this.keys.delete(e.code);
    });
  }

  update(dt: number) {
    // Apply rotation
    const euler = new THREE.Euler(this.pitch, this.yaw, 0, "YXZ");
    this.camera.quaternion.setFromEuler(euler);

    // Movement relative to camera facing direction
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion);

    // Project forward/right onto horizontal plane for WASD
    forward.y = 0;
    forward.normalize();
    right.y = 0;
    right.normalize();

    const velocity = new THREE.Vector3();

    if (this.keys.has("KeyW")) velocity.add(forward);
    if (this.keys.has("KeyS")) velocity.sub(forward);
    if (this.keys.has("KeyD")) velocity.add(right);
    if (this.keys.has("KeyA")) velocity.sub(right);
    if (this.keys.has("Space")) velocity.y += 1;
    if (this.keys.has("ShiftLeft") || this.keys.has("ShiftRight")) velocity.y -= 1;

    if (velocity.lengthSq() > 0) {
      velocity.normalize().multiplyScalar(this.speed * dt);
      this.camera.position.add(velocity);
    }
  }
}
