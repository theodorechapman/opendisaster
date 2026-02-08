/**
 * TestFire scenario — spawns a growing fire at scene center after 10 seconds.
 *
 * Self-contained and easily removable:
 *   1. Delete this file
 *   2. Remove the import + `startTestFire(...)` call in main.ts
 */

import * as THREE from "three";
import type { EventBus } from "../core/EventBus.ts";
import type { HeightSampler } from "../layers.ts";

const DELAY_SEC = 10;

// Fire grows over ~30 seconds then holds steady
const GROW_DURATION = 30;
const MAX_INTENSITY = 0.8;
const MAX_RADIUS = 35;
const EMIT_INTERVAL = 1.5; // seconds between FIRE_SPREAD events

export function startTestFire(scene: THREE.Scene, eventBus: EventBus, sampler?: HeightSampler): void {
  const fireY = sampler ? sampler.sample(0, 0) : 0;
  const FIRE_CENTER: [number, number, number] = [0, fireY, 0];

  let started = false;
  let elapsed = 0;
  let emitTimer = 0;

  // --- visuals ---
  const fireGroup = new THREE.Group();
  fireGroup.position.set(FIRE_CENTER[0], fireY, FIRE_CENTER[2]);
  fireGroup.visible = false;

  // Glowing core sphere
  const coreMat = new THREE.MeshBasicMaterial({ color: 0xff4400, transparent: true, opacity: 0.7 });
  const core = new THREE.Mesh(new THREE.SphereGeometry(2, 16, 12), coreMat);
  core.position.y = 3;
  fireGroup.add(core);

  // Outer glow sphere
  const glowMat = new THREE.MeshBasicMaterial({ color: 0xff8800, transparent: true, opacity: 0.25, side: THREE.BackSide });
  const glow = new THREE.Mesh(new THREE.SphereGeometry(5, 16, 12), glowMat);
  glow.position.y = 3;
  fireGroup.add(glow);

  // Point light
  const light = new THREE.PointLight(0xff6600, 0, 50);
  light.position.y = 5;
  fireGroup.add(light);

  // Simple flame particles (small billboarded planes)
  const particleCount = 24;
  const particles: THREE.Mesh[] = [];
  const particleMat = new THREE.MeshBasicMaterial({ color: 0xffaa00, transparent: true, opacity: 0.6, side: THREE.DoubleSide });
  for (let i = 0; i < particleCount; i++) {
    const p = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 2.5), particleMat.clone());
    // Random XZ spread, stagger Y
    p.position.set((Math.random() - 0.5) * 6, 1 + Math.random() * 6, (Math.random() - 0.5) * 6);
    p.userData.seed = Math.random() * Math.PI * 2;
    p.userData.speed = 0.8 + Math.random() * 1.2;
    p.userData.baseY = p.position.y;
    particles.push(p);
    fireGroup.add(p);
  }

  scene.add(fireGroup);

  // --- update (called from engine render loop via returned function) ---
  return void registerUpdate();

  function registerUpdate() {
    // Piggyback on requestAnimationFrame since we don't want to touch the ECS loop
    let prev = performance.now();

    function tick() {
      const now = performance.now();
      const dt = (now - prev) / 1000;
      prev = now;

      if (!started) {
        elapsed += dt;
        if (elapsed >= DELAY_SEC) {
          started = true;
          elapsed = 0;
          fireGroup.visible = true;
          console.log("[TestFire] Fire started at scene center!");
        }
        requestAnimationFrame(tick);
        return;
      }

      elapsed += dt;
      const t = Math.min(elapsed / GROW_DURATION, 1); // 0→1 growth factor

      const intensity = t * MAX_INTENSITY;
      const radius = 5 + t * (MAX_RADIUS - 5);

      // Animate visuals
      const flicker = 0.85 + 0.15 * Math.sin(elapsed * 12);
      const scale = 1 + t * 2;
      core.scale.setScalar(scale * flicker);
      coreMat.opacity = 0.5 + 0.3 * flicker;
      glow.scale.setScalar(scale * 1.8);
      glowMat.opacity = 0.15 + 0.1 * t;
      light.intensity = intensity * 80 * flicker;
      light.distance = radius * 1.5;

      // Animate particles — rise, flicker, loop
      for (const p of particles) {
        const seed = p.userData.seed as number;
        const speed = p.userData.speed as number;
        const baseY = p.userData.baseY as number;
        const life = ((elapsed * speed + seed) % 3) / 3; // 0→1 repeating
        p.position.y = baseY + life * 8 * scale;
        (p.material as THREE.MeshBasicMaterial).opacity = (1 - life) * 0.6 * t;
        p.scale.setScalar((1 - life * 0.5) * scale * 0.5);
        // Face camera (billboard approximation)
        p.rotation.y = elapsed * 0.5 + seed;
      }

      // Emit FIRE_SPREAD events periodically so AgentDamageSystem applies damage
      emitTimer += dt;
      if (emitTimer >= EMIT_INTERVAL) {
        emitTimer -= EMIT_INTERVAL;
        eventBus.emit({
          type: "FIRE_SPREAD",
          position: FIRE_CENTER,
          intensity,
          radius,
        });
      }

      requestAnimationFrame(tick);
    }

    requestAnimationFrame(tick);
  }
}
