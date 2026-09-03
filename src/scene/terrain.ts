/**
 * Wired Future — the ground plane.
 *
 * A single wireframe PlaneGeometry that is mutated IN PLACE every frame.
 * The geometry is never rebuilt: we cache each vertex's original (x, y) and
 * radius at construction time and rewrite only the height component of the
 * position buffer, then flip `needsUpdate`.
 *
 * The mesh (not the geometry) is rotated -PI/2 on X, so in buffer-local space
 * the plane still lies on X/Y and the HEIGHT axis is the local Z component —
 * byte offset i * 3 + 2.
 *
 * No React, no store imports. Pure three.js.
 */

import * as THREE from 'three';

const PLANE_SIZE = 120;
const PLANE_SEGMENTS = 110;
const PLANE_Y = -4;

/** Overall vertical gain applied on top of state.waveAmplitude. */
const AMPLITUDE_GAIN = 0.75;

export class Terrain {
  readonly mesh: THREE.Mesh;

  private readonly geometry: THREE.PlaneGeometry;
  private readonly material: THREE.MeshBasicMaterial;
  private readonly position: THREE.BufferAttribute;
  private readonly buffer: Float32Array;

  /** Immutable per-vertex source values, cached once. */
  private readonly baseX: Float32Array;
  private readonly baseY: Float32Array;
  private readonly baseR: Float32Array;

  private amplitude = 1;
  private amplitudeDirty = true;
  /** Wave phase accumulated from (dt * velocity) so velocity changes never jump. */
  private waveTime = 0;
  private lastElapsed = -1;

  constructor(colorHex = '#00f0ff') {
    this.geometry = new THREE.PlaneGeometry(
      PLANE_SIZE,
      PLANE_SIZE,
      PLANE_SEGMENTS,
      PLANE_SEGMENTS,
    );

    this.material = new THREE.MeshBasicMaterial({
      color: new THREE.Color(colorHex),
      wireframe: true,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
    });

    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.rotation.x = -Math.PI / 2;
    this.mesh.position.y = PLANE_Y;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1;
    this.mesh.name = 'wired-terrain';

    this.position = this.geometry.attributes.position as THREE.BufferAttribute;
    this.buffer = this.position.array as Float32Array;

    const count = this.position.count;
    this.baseX = new Float32Array(count);
    this.baseY = new Float32Array(count);
    this.baseR = new Float32Array(count);

    for (let i = 0; i < count; i += 1) {
      const x = this.buffer[i * 3];
      const y = this.buffer[i * 3 + 1];
      this.baseX[i] = x;
      this.baseY[i] = y;
      this.baseR[i] = Math.sqrt(x * x + y * y);
    }

    // Seed the surface so the very first rendered frame is already sculpted.
    this.writeHeights();
  }

  /** The object to add to the scene. */
  get object3d(): THREE.Object3D {
    return this.mesh;
  }

  setColor(hex: string): void {
    this.material.color.set(hex);
  }

  setAmplitude(value: number): void {
    if (!Number.isFinite(value) || value === this.amplitude) return;
    this.amplitude = value;
    this.amplitudeDirty = true;
  }

  /**
   * @param elapsed  seconds since the engine clock started
   * @param velocity effective wave speed (state.waveVelocity, possibly boosted by a pulse)
   */
  update(elapsed: number, velocity: number): void {
    if (this.lastElapsed < 0) this.lastElapsed = elapsed;
    const dt = Math.max(0, Math.min(0.25, elapsed - this.lastElapsed));
    this.lastElapsed = elapsed;

    const advance = dt * (Number.isFinite(velocity) ? velocity : 0);

    // Frozen wave + unchanged amplitude means the buffer is already correct.
    if (advance === 0 && !this.amplitudeDirty) return;

    this.waveTime += advance;
    this.writeHeights();
  }

  private writeHeights(): void {
    const t = this.waveTime;
    const amp = this.amplitude * AMPLITUDE_GAIN;
    const count = this.position.count;
    const buf = this.buffer;
    const bx = this.baseX;
    const by = this.baseY;
    const br = this.baseR;

    // Four layered terms of different frequency, direction and phase so the
    // surface reads as an organic topographic landscape rather than one sheet.
    for (let i = 0; i < count; i += 1) {
      const x = bx[i];
      const y = by[i];
      const r = br[i];

      const h =
        Math.sin(x * 0.16 + t * 1.1) * 0.9 +
        Math.cos(y * 0.19 - t * 0.85) * 0.75 +
        Math.sin((x + y) * 0.085 + t * 0.55) * 1.2 +
        Math.cos(r * 0.22 - t * 1.6) * 0.55 * Math.exp(-r * 0.018);

      buf[i * 3 + 2] = h * amp;
    }

    this.position.needsUpdate = true;
    this.amplitudeDirty = false;
  }

  dispose(): void {
    if (this.mesh.parent) this.mesh.parent.remove(this.mesh);
    this.geometry.dispose();
    this.material.dispose();
  }
}

export function createTerrain(colorHex = '#00f0ff'): Terrain {
  return new Terrain(colorHex);
}
