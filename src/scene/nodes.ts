/**
 * Wired Future — the floating node cluster.
 *
 * A pool of small spheres sharing ONE SphereGeometry and ONE material.
 * Placement is deterministic: a seeded mulberry32 PRNG generates the full
 * maxNodes layout once, so growing the count only reveals nodes that were
 * always going to be there — existing nodes never move.
 *
 * The ceiling is injected rather than hardcoded: engine.ts passes
 * LIMITS.nodeCount.max, so the store stays the single source of truth for the
 * bound the slider and the agent tool are both validated against.
 *
 * No React, no store imports. Pure three.js.
 */

import * as THREE from 'three';

const SEED = 0x5eed1337;

interface NodeSeed {
  /** Normalised placement in [-1, 1]; multiplied by the live spread. */
  nx: number;
  ny: number;
  nz: number;
  phase: number;
  /** Per-node speed jitter so the cluster never pulses in lockstep. */
  speed: number;
  bob: number;
  scale: number;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildSeeds(maxNodes: number): NodeSeed[] {
  const rand = mulberry32(SEED);
  const seeds: NodeSeed[] = [];
  for (let i = 0; i < maxNodes; i += 1) {
    const angle = rand() * Math.PI * 2;
    // sqrt keeps the disc uniform; the 0.45 floor keeps the stage centre clear
    // AND keeps nodes from landing between the orbiting camera and the model.
    const radius = 0.45 + 0.55 * Math.sqrt(rand());
    seeds.push({
      nx: Math.cos(angle) * radius,
      nz: Math.sin(angle) * radius,
      ny: rand() * 2 - 1,
      phase: rand() * Math.PI * 2,
      speed: 0.55 + rand() * 0.9,
      bob: 0.3 + rand() * 0.75,
      scale: 0.5 + rand() * 0.7,
    });
  }
  return seeds;
}

export class NodeCluster {
  readonly group: THREE.Group;

  private readonly seeds: NodeSeed[];
  private readonly geometry: THREE.SphereGeometry;
  private readonly material: THREE.MeshBasicMaterial;
  private readonly meshes: THREE.Mesh[] = [];
  private readonly baseY: number[] = [];

  private count = 0;
  private spread = 26;
  private floatSpeed = 1;

  /** Accumulated float phase so speed changes never snap the animation. */
  private floatTime = 0;
  private lastElapsed = -1;

  private readonly maxNodes: number;

  constructor(colorHex: string, maxNodes: number) {
    this.maxNodes = Math.max(0, Math.floor(maxNodes));
    this.group = new THREE.Group();
    this.group.name = 'wired-nodes';

    this.seeds = buildSeeds(this.maxNodes);
    // Small on purpose: the orbit brings the camera within a few units of the
    // outer ring, and anything larger reads as a foreground blob rather than
    // a distant node.
    this.geometry = new THREE.SphereGeometry(0.115, 8, 6);
    this.material = new THREE.MeshBasicMaterial({
      color: new THREE.Color(colorHex),
      transparent: true,
      opacity: 0.92,
    });
  }

  setCount(next: number): void {
    const target = Math.max(0, Math.min(this.maxNodes, Math.round(next)));
    if (target === this.count) return;

    if (target > this.count) {
      for (let i = this.count; i < target; i += 1) {
        this.group.add(this.ensureMesh(i));
      }
    } else {
      for (let i = this.count - 1; i >= target; i -= 1) {
        const mesh = this.meshes[i];
        if (mesh) this.group.remove(mesh);
      }
    }

    this.count = target;
  }

  setSpread(next: number): void {
    if (!Number.isFinite(next) || next === this.spread) return;
    this.spread = next;
    this.layout();
  }

  setColor(hex: string): void {
    this.material.color.set(hex);
  }

  setFloatSpeed(next: number): void {
    if (!Number.isFinite(next)) return;
    this.floatSpeed = next;
  }

  update(elapsed: number): void {
    if (this.lastElapsed < 0) this.lastElapsed = elapsed;
    const dt = Math.max(0, Math.min(0.25, elapsed - this.lastElapsed));
    this.lastElapsed = elapsed;
    this.floatTime += dt * this.floatSpeed;

    const t = this.floatTime;
    for (let i = 0; i < this.count; i += 1) {
      const mesh = this.meshes[i];
      const seed = this.seeds[i];
      if (!mesh || !seed) continue;
      const wave = t * seed.speed + seed.phase;
      mesh.position.y = this.baseY[i] + Math.sin(wave) * seed.bob;
      // Barely-there lateral sway so the cluster feels alive, not rigid.
      mesh.position.x = seed.nx * this.spread * 0.5 + Math.cos(wave * 0.6) * 0.16;
      mesh.position.z = seed.nz * this.spread * 0.5 + Math.sin(wave * 0.45) * 0.16;
    }
  }

  dispose(): void {
    if (this.group.parent) this.group.parent.remove(this.group);
    this.group.clear();
    this.meshes.length = 0;
    this.baseY.length = 0;
    this.count = 0;
    this.geometry.dispose();
    this.material.dispose();
  }

  private ensureMesh(index: number): THREE.Mesh {
    const existing = this.meshes[index];
    if (existing) return existing;

    const seed = this.seeds[index];
    const mesh = new THREE.Mesh(this.geometry, this.material);
    mesh.scale.setScalar(seed.scale);
    this.meshes[index] = mesh;
    this.placeMesh(index);
    return mesh;
  }

  private placeMesh(index: number): void {
    const mesh = this.meshes[index];
    const seed = this.seeds[index];
    if (!mesh || !seed) return;
    // Band lifted clear of the terrain (y = -4) and the model, so the cluster
    // reads as a canopy overhead instead of debris around the stage.
    const base = 3.2 + seed.ny * (this.spread * 0.12);
    this.baseY[index] = base;
    mesh.position.set(seed.nx * this.spread * 0.5, base, seed.nz * this.spread * 0.5);
  }

  private layout(): void {
    for (let i = 0; i < this.meshes.length; i += 1) this.placeMesh(i);
  }
}

export function createNodeCluster(colorHex: string, maxNodes: number): NodeCluster {
  return new NodeCluster(colorHex, maxNodes);
}
