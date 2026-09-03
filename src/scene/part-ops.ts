/**
 * Wired Future — measuring and reshaping car parts.
 *
 * Everything here is real geometry, computed from the actual triangles of the
 * loaded glTF:
 *
 *   surface area   sum of |(b-a) x (c-a)| / 2 over every triangle
 *   volume         signed tetrahedron sum, a . (b x c) / 6, about the origin
 *   centroid       area-weighted mean of triangle centroids
 *   mass           volume x material density
 *
 * The volume figure is exact for a closed mesh and approximate for an open one.
 * Car panels are shells, not solids, so `watertight` is reported alongside the
 * number and callers are expected to say so rather than quoting it as fact.
 *
 * Deformations rewrite vertex positions from a cached copy of the ORIGINAL
 * geometry, so edits are absolute rather than cumulative: applying scale 1.2
 * twice leaves the part at 1.2, not 1.44.
 *
 * No React, no store imports. Pure three.js.
 */

import * as THREE from 'three';

// Type-only import: erased at compile time, so this does NOT pull zustand or
// React into the three.js side of the app.
import type { PartEdit, PartMaterialId } from '@/store/use-wired';

/* ------------------------------------------------------------------ */
/* Materials — real densities in kg/m3                                 */
/* ------------------------------------------------------------------ */

// Single source of truth lives in config/part-materials.ts, which imports
// nothing — see the note there about keeping three.js out of the first bundle.
export {
  PART_MATERIALS,
  MODEL_UNITS_TO_METRES,
  type PartMaterialSpec,
} from '@/config/part-materials';

import { PART_MATERIALS as MATERIALS } from '@/config/part-materials';

/* ------------------------------------------------------------------ */
/* Edits                                                               */
/* ------------------------------------------------------------------ */

export function isIdentityEdit(edit: PartEdit): boolean {
  return (
    edit.scaleX === 1 &&
    edit.scaleY === 1 &&
    edit.scaleZ === 1 &&
    edit.inflate === 0 &&
    edit.twistDeg === 0 &&
    edit.material === null
  );
}

/* ------------------------------------------------------------------ */
/* Measurement                                                         */
/* ------------------------------------------------------------------ */

export interface PartMeasurement {
  triangles: number;
  vertices: number;
  /** Model units squared. */
  surfaceArea: number;
  /** Model units cubed. Signed-tetrahedron sum; see `watertight`. */
  volume: number;
  /** True when every edge is shared by exactly two triangles. */
  watertight: boolean;
  size: { x: number; y: number; z: number };
  centre: { x: number; y: number; z: number };
  centroid: { x: number; y: number; z: number };
}

/**
 * Transform every vertex of a mesh into world space, ONCE.
 *
 * The obvious loop transforms each vertex again for every triangle that uses
 * it, which on a welded mesh is roughly six times the necessary work. Doing it
 * per-vertex up front turned a 42k-triangle measurement from seconds into
 * milliseconds. The matrix is applied inline rather than through Vector3 so the
 * inner loop stays free of method dispatch and allocation.
 */
function worldVertices(mesh: THREE.Mesh): Float64Array | null {
  const position = mesh.geometry.getAttribute('position');
  if (!position) return null;

  mesh.updateWorldMatrix(true, false);
  const e = mesh.matrixWorld.elements;
  const count = position.count;
  const out = new Float64Array(count * 3);

  // getX/getY/getZ, NOT position.array: glTF attributes can be interleaved into
  // a shared buffer, where the raw array is not tightly packed xyz and direct
  // indexing silently reads a neighbouring attribute's bytes.
  for (let i = 0; i < count; i += 1) {
    const j = i * 3;
    const x = position.getX(i);
    const y = position.getY(i);
    const z = position.getZ(i);
    // Affine only: the scene never puts a projective transform on a mesh.
    out[j] = e[0] * x + e[4] * y + e[8] * z + e[12];
    out[j + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
    out[j + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
  }
  return out;
}

/** Triangles whose edges are counted for the watertight test. */
const WATERTIGHT_TRIANGLE_BUDGET = 40000;

export function measureMeshes(meshes: THREE.Mesh[]): PartMeasurement {
  let triangles = 0;
  let vertices = 0;
  let surfaceArea = 0;
  let volumeSum = 0;

  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;

  let centroidX = 0;
  let centroidY = 0;
  let centroidZ = 0;

  // Watertight means every edge is shared by exactly two triangles. Edges are
  // keyed by INDEX PAIR packed into one number, not by a stringified position:
  // the string version allocated three strings per triangle and dominated the
  // whole measurement. A mesh with no index buffer cannot be tested this way,
  // and a part built from several meshes is never watertight as a unit.
  let watertight = meshes.length > 0;
  let edgeBudget = WATERTIGHT_TRIANGLE_BUDGET;

  for (const mesh of meshes) {
    const geometry = mesh.geometry;
    const position = geometry.getAttribute('position');
    if (!position) continue;

    const world = worldVertices(mesh);
    if (!world) continue;

    vertices += position.count;

    for (let i = 0; i < world.length; i += 3) {
      const x = world[i];
      const y = world[i + 1];
      const z = world[i + 2];
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (z < minZ) minZ = z;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (z > maxZ) maxZ = z;
    }

    const index = geometry.getIndex();
    const triCount = index ? index.count / 3 : position.count / 3;

    const edges =
      index && watertight && edgeBudget > triCount
        ? new Map<number, number>()
        : null;
    if (!edges) watertight = false;

    const stride = position.count;

    for (let t = 0; t < triCount; t += 1) {
      const i0 = index ? index.getX(t * 3) : t * 3;
      const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1;
      const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;

      const a = i0 * 3;
      const b = i1 * 3;
      const c = i2 * 3;

      const ax = world[a];
      const ay = world[a + 1];
      const az = world[a + 2];
      const bx = world[b];
      const by = world[b + 1];
      const bz = world[b + 2];
      const cx = world[c];
      const cy = world[c + 1];
      const cz = world[c + 2];

      // Area = |(b-a) x (c-a)| / 2
      const abx = bx - ax;
      const aby = by - ay;
      const abz = bz - az;
      const acx = cx - ax;
      const acy = cy - ay;
      const acz = cz - az;

      const nx = aby * acz - abz * acy;
      const ny = abz * acx - abx * acz;
      const nz = abx * acy - aby * acx;

      const area = Math.sqrt(nx * nx + ny * ny + nz * nz) * 0.5;
      surfaceArea += area;

      // Signed volume of the tetrahedron (origin, a, b, c) = a . (b x c) / 6
      const bcx = by * cz - bz * cy;
      const bcy = bz * cx - bx * cz;
      const bcz = bx * cy - by * cx;
      volumeSum += (ax * bcx + ay * bcy + az * bcz) / 6;

      centroidX += ((ax + bx + cx) / 3) * area;
      centroidY += ((ay + by + cy) / 3) * area;
      centroidZ += ((az + bz + cz) / 3) * area;

      if (edges) {
        // Pack an unordered index pair into a single number. stride <= vertex
        // count per mesh, so lo * stride + hi stays well inside 2^53.
        const e0 = i0 < i1 ? i0 * stride + i1 : i1 * stride + i0;
        const e1 = i1 < i2 ? i1 * stride + i2 : i2 * stride + i1;
        const e2 = i2 < i0 ? i2 * stride + i0 : i0 * stride + i2;
        edges.set(e0, (edges.get(e0) ?? 0) + 1);
        edges.set(e1, (edges.get(e1) ?? 0) + 1);
        edges.set(e2, (edges.get(e2) ?? 0) + 1);
      }
    }

    triangles += triCount;
    edgeBudget -= triCount;

    if (edges && watertight) {
      for (const count of edges.values()) {
        if (count !== 2) {
          watertight = false;
          break;
        }
      }
    }
  }

  // Several meshes cannot form one watertight solid.
  if (meshes.length > 1) watertight = false;

  if (surfaceArea > 0) {
    centroidX /= surfaceArea;
    centroidY /= surfaceArea;
    centroidZ /= surfaceArea;
  }

  const empty = minX === Infinity;

  return {
    triangles,
    vertices,
    surfaceArea,
    volume: Math.abs(volumeSum),
    watertight,
    size: empty
      ? { x: 0, y: 0, z: 0 }
      : { x: maxX - minX, y: maxY - minY, z: maxZ - minZ },
    centre: empty
      ? { x: 0, y: 0, z: 0 }
      : { x: (minX + maxX) / 2, y: (minY + maxY) / 2, z: (minZ + maxZ) / 2 },
    centroid: { x: centroidX, y: centroidY, z: centroidZ },
  };
}

/* ------------------------------------------------------------------ */
/* Deformation                                                         */
/* ------------------------------------------------------------------ */

/** Cached pristine vertex data, captured the first time a part is edited. */
interface OriginalGeometry {
  positions: Float32Array;
  normals: Float32Array | null;
}

const originals = new WeakMap<THREE.BufferGeometry, OriginalGeometry>();

function rememberOriginal(geometry: THREE.BufferGeometry): OriginalGeometry | null {
  const cached = originals.get(geometry);
  if (cached) return cached;

  const position = geometry.getAttribute('position');
  if (!position) return null;

  const normal = geometry.getAttribute('normal');

  // Copy through the accessor so an interleaved attribute is de-interleaved
  // into the tight xyz layout the deformation loop expects.
  const positions = new Float32Array(position.count * 3);
  for (let i = 0; i < position.count; i += 1) {
    positions[i * 3] = position.getX(i);
    positions[i * 3 + 1] = position.getY(i);
    positions[i * 3 + 2] = position.getZ(i);
  }

  let normals: Float32Array | null = null;
  if (normal) {
    normals = new Float32Array(normal.count * 3);
    for (let i = 0; i < normal.count; i += 1) {
      normals[i * 3] = normal.getX(i);
      normals[i * 3 + 1] = normal.getY(i);
      normals[i * 3 + 2] = normal.getZ(i);
    }
  }

  const snapshot: OriginalGeometry = { positions, normals };
  originals.set(geometry, snapshot);
  return snapshot;
}

/**
 * Rewrite a part's vertices from its original geometry.
 *
 * `pivot` is the point the deformation is centred on, in the same local space
 * as the vertices, so scaling a door does not fling it away from its hinge.
 */
export function applyEditToMeshes(
  meshes: THREE.Mesh[],
  edit: PartEdit,
  pivotWorld: THREE.Vector3,
): void {
  const localPivot = new THREE.Vector3();

  const twistRad = THREE.MathUtils.degToRad(edit.twistDeg);
  const twisting = twistRad !== 0;
  const inflating = edit.inflate !== 0;
  // A uniform scale leaves surface normals unchanged, so the (expensive)
  // recompute can be skipped for the most common edit of all.
  const uniformScale =
    edit.scaleX === edit.scaleY && edit.scaleY === edit.scaleZ;
  const normalsStillValid = uniformScale && !twisting && !inflating;

  for (const mesh of meshes) {
    const geometry = mesh.geometry;
    const snapshot = rememberOriginal(geometry);
    const position = geometry.getAttribute('position');
    if (!snapshot || !position) continue;

    const source = snapshot.positions;
    const normals = snapshot.normals;

    // Work in the mesh's own local space.
    mesh.updateWorldMatrix(true, false);
    localPivot.copy(pivotWorld);
    mesh.worldToLocal(localPivot);

    // Only needed to distribute the twist, and scanning every vertex for it
    // when there is no twist is pure waste.
    let span = 1;
    let minY = 0;
    if (twisting) {
      let lo = Infinity;
      let hi = -Infinity;
      for (let i = 1; i < source.length; i += 3) {
        const y = source[i];
        if (y < lo) lo = y;
        if (y > hi) hi = y;
      }
      minY = lo;
      span = hi - lo || 1;
    }

    const px = localPivot.x;
    const py = localPivot.y;
    const pz = localPivot.z;
    const sx = edit.scaleX;
    const sy = edit.scaleY;
    const sz = edit.scaleZ;

    for (let i = 0; i < source.length; i += 3) {
      let x = source[i];
      let y = source[i + 1];
      let z = source[i + 2];

      // 1. inflate along the original normal
      if (inflating && normals) {
        const nx = normals[i];
        const ny = normals[i + 1];
        const nz = normals[i + 2];
        const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
        if (len > 0) {
          const k = edit.inflate / len;
          x += nx * k;
          y += ny * k;
          z += nz * k;
        }
      }

      // 2. scale about the pivot
      x = (x - px) * sx;
      y = (y - py) * sy;
      z = (z - pz) * sz;

      // 3. twist about the vertical axis, proportional to height
      if (twisting) {
        const angle = twistRad * ((source[i + 1] - minY) / span);
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        const rx = x * cos - z * sin;
        z = x * sin + z * cos;
        x = rx;
      }

      // setXYZ rather than a raw array write: the attribute may be interleaved.
      position.setXYZ(i / 3, x + px, y + py, z + pz);
    }

    position.needsUpdate = true;
    // Deformation invalidates the shipped normals — unless it was a uniform
    // scale, which moves every vertex along the same ray and leaves the surface
    // orientation untouched.
    if (!normalsStillValid) geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
  }
}

/** Build the display material for a chosen engineering material. */
export function buildPartMaterial(id: PartMaterialId): THREE.MeshStandardMaterial {
  const spec = MATERIALS[id];
  return new THREE.MeshStandardMaterial({
    color: spec.color,
    roughness: spec.roughness,
    metalness: spec.metalness,
    transparent: id === 'glass',
    opacity: id === 'glass' ? 0.42 : 1,
  });
}
