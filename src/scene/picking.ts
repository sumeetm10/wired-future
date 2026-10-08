/**
 * Wired Future — fast picking.
 *
 * Stock three.js raycasting tests every triangle of every mesh whose bounding
 * sphere the ray crosses. The concept car's body shell alone is 42k triangles,
 * so one pick cost milliseconds: fine for a click, far too slow to follow the
 * pointer for hover feedback. A bounds tree per geometry makes a pick cost
 * microseconds.
 *
 * Trees are built in idle slices after the car loads, so the load itself never
 * stalls; until a mesh has its tree it simply takes the stock path.
 */

import * as THREE from 'three';
import {
  acceleratedRaycast,
  computeBoundsTree,
  disposeBoundsTree,
} from 'three-mesh-bvh';

let installed = false;

/**
 * Route Mesh.raycast through three-mesh-bvh. Safe for every mesh in the scene:
 * a geometry without a bounds tree falls back to the stock implementation.
 */
export function installAcceleratedRaycast(): void {
  if (installed) return;
  installed = true;
  THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
  THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
  THREE.Mesh.prototype.raycast = acceleratedRaycast;
}

interface IdleDeadlineLike {
  timeRemaining: () => number;
  didTimeout: boolean;
}

type IdleCallback = (deadline: IdleDeadlineLike) => void;

function scheduleIdle(callback: IdleCallback): () => void {
  if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
    const handle = window.requestIdleCallback(callback, { timeout: 300 });
    return () => window.cancelIdleCallback(handle);
  }
  // Safari has no requestIdleCallback. A short timer with a fixed budget is
  // the usual stand-in.
  const handle = setTimeout(
    () => callback({ timeRemaining: () => 8, didTimeout: false }),
    16,
  );
  return () => clearTimeout(handle);
}

/**
 * Build a bounds tree for every distinct geometry, a few per idle slice.
 * Returns a cancel function; `onDone` fires once every tree exists.
 */
export function buildBoundsTreesWhenIdle(
  meshes: THREE.Mesh[],
  onDone: () => void,
): () => void {
  const queue: THREE.BufferGeometry[] = [];
  const seen = new Set<THREE.BufferGeometry>();
  for (const mesh of meshes) {
    const geometry = mesh.geometry;
    if (!geometry || seen.has(geometry) || geometry.boundsTree) continue;
    // Morph targets and skinning move vertices on the GPU; a static tree
    // would pick where the part used to be. The car has neither.
    if (Object.keys(geometry.morphAttributes).length) continue;
    seen.add(geometry);
    queue.push(geometry);
  }

  let cancelled = false;
  let cancelPending: () => void = () => {};

  const work: IdleCallback = (deadline) => {
    if (cancelled) return;
    // Always make progress on at least one geometry per slice, or a
    // permanently busy page would never finish.
    let built = 0;
    while (queue.length && (built === 0 || deadline.timeRemaining() > 4)) {
      const geometry = queue.shift()!;
      try {
        // indirect: leave the index buffer exactly as shipped. The measuring
        // and reshaping code reads it, and a reordered index is a surprise
        // nobody needs.
        geometry.computeBoundsTree({ indirect: true });
      } catch {
        // A geometry the builder rejects keeps the stock raycast path.
      }
      built += 1;
    }
    if (queue.length) cancelPending = scheduleIdle(work);
    else onDone();
  };

  if (queue.length) cancelPending = scheduleIdle(work);
  else onDone();

  return () => {
    cancelled = true;
    cancelPending();
  };
}

/** Walk up to `root`: false if the object or any ancestor is hidden. */
export function isVisibleWithin(object: THREE.Object3D, root: THREE.Object3D): boolean {
  let cursor: THREE.Object3D | null = object;
  while (cursor) {
    if (!cursor.visible) return false;
    if (cursor === root) return true;
    cursor = cursor.parent;
  }
  return true;
}
