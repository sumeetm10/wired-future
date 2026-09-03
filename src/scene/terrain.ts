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

  /**
   * Per-vertex sin/cos of each wave's SPATIAL argument, plus the distance
   * falloff. Every term has the form sin(kx + wt), which expands to
   * sin(kx)cos(wt) + cos(kx)sin(wt) - so the only time-dependent parts are two
   * scalars per wave, shared by every vertex.
   *
   * Evaluating it directly cost 2 sin + 2 cos + 1 exp on each of 12,321
   * vertices, about 61,600 transcendental calls per frame. Hoisting leaves 8
   * per frame in total and turns the inner loop into multiply-adds.
   */
  private readonly s1: Float32Array;
  private readonly c1: Float32Array;
  private readonly s2: Float32Array;
  private readonly c2: Float32Array;
  private readonly s3: Float32Array;
  private readonly c3: Float32Array;
  private readonly s4: Float32Array;
  private readonly c4: Float32Array;
  /** exp(-r * 0.018) * 0.55, folded together since neither depends on time. */
  private readonly decay: Float32Array;

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
    this.s1 = new Float32Array(count);
    this.c1 = new Float32Array(count);
    this.s2 = new Float32Array(count);
    this.c2 = new Float32Array(count);
    this.s3 = new Float32Array(count);
    this.c3 = new Float32Array(count);
    this.s4 = new Float32Array(count);
    this.c4 = new Float32Array(count);
    this.decay = new Float32Array(count);

    for (let i = 0; i < count; i += 1) {
      const x = this.buffer[i * 3];
      const y = this.buffer[i * 3 + 1];
      const r = Math.sqrt(x * x + y * y);
      this.baseX[i] = x;
      this.baseY[i] = y;
      this.baseR[i] = r;

      const a = x * 0.16;
      const b = y * 0.19;
      const c = (x + y) * 0.085;
      const d = r * 0.22;
      this.s1[i] = Math.sin(a);
      this.c1[i] = Math.cos(a);
      this.s2[i] = Math.sin(b);
      this.c2[i] = Math.cos(b);
      this.s3[i] = Math.sin(c);
      this.c3[i] = Math.cos(c);
      this.s4[i] = Math.sin(d);
      this.c4[i] = Math.cos(d);
      this.decay[i] = Math.exp(-r * 0.018) * 0.55;
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

    // Eight trig calls for the whole frame, not eight per vertex. Identical
    // output to the direct form: sin(kx + wt) = sin(kx)cos(wt) + cos(kx)sin(wt),
    // and cos(kx - wt) = cos(kx)cos(wt) + sin(kx)sin(wt).
    const sT1 = Math.sin(t * 1.1);
    const cT1 = Math.cos(t * 1.1);
    const sT2 = Math.sin(t * 0.85);
    const cT2 = Math.cos(t * 0.85);
    const sT3 = Math.sin(t * 0.55);
    const cT3 = Math.cos(t * 0.55);
    const sT4 = Math.sin(t * 1.6);
    const cT4 = Math.cos(t * 1.6);

    const s1 = this.s1;
    const c1 = this.c1;
    const s2 = this.s2;
    const c2 = this.c2;
    const s3 = this.s3;
    const c3 = this.c3;
    const s4 = this.s4;
    const c4 = this.c4;
    const decay = this.decay;

    // Four layered terms of different frequency, direction and phase so the
    // surface reads as an organic topographic landscape rather than one sheet.
    for (let i = 0; i < count; i += 1) {
      const h =
        0.9 * (s1[i] * cT1 + c1[i] * sT1) +
        0.75 * (c2[i] * cT2 + s2[i] * sT2) +
        1.2 * (s3[i] * cT3 + c3[i] * sT3) +
        decay[i] * (c4[i] * cT4 + s4[i] * sT4);

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
