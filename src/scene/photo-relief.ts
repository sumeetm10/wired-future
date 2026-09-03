/**
 * Wired Future — photo reconstruction mesh.
 *
 * Turns a depth grid (produced in the browser by Depth Anything V2) plus the
 * source pixels into a standing bas-relief: a plane whose vertices are pushed
 * along its normal by the estimated depth, textured with the original photo.
 *
 * This is a 2.5D reconstruction, not a watertight model — the front surface is
 * real geometry, there is no back face. That is an honest limit of monocular
 * depth, and the mesh is built to read as a relief sculpture rather than to
 * pretend otherwise.
 *
 * Pure and synchronous. All async work (decode, inference) happens upstream.
 */

import * as THREE from 'three';

import type { PhotoReliefInput } from './contract';
import { disposeObject3D, type ModelHandle } from './models';

/** Longest edge of the finished relief, in world units. */
const TARGET_SIZE = 6;

/** How far the nearest pixel stands proud of the furthest. */
const RELIEF_DEPTH = 1.4;

/** Vertex grid ceiling. A 768px depth map would otherwise be ~590k vertices. */
const MAX_SEGMENTS = 220;

/** Nearest-neighbour sample from the depth grid. */
function sampleDepth(
  depth: Float32Array,
  srcW: number,
  srcH: number,
  u: number,
  v: number,
): number {
  const x = Math.min(srcW - 1, Math.max(0, Math.round(u * (srcW - 1))));
  const y = Math.min(srcH - 1, Math.max(0, Math.round(v * (srcH - 1))));
  const value = depth[y * srcW + x];
  return Number.isFinite(value) ? value : 0;
}

export function buildPhotoRelief(
  input: PhotoReliefInput,
  gridHex: string,
): ModelHandle {
  const { width, height, depth, colors } = input;

  const group = new THREE.Group();
  group.name = 'wired-photo-relief';

  /* --- plane sized to the photo's aspect ratio -------------------------- */

  const aspect = width / Math.max(1, height);
  const planeW = aspect >= 1 ? TARGET_SIZE : TARGET_SIZE * aspect;
  const planeH = aspect >= 1 ? TARGET_SIZE / aspect : TARGET_SIZE;

  const segX = Math.max(2, Math.min(MAX_SEGMENTS, width - 1));
  const segY = Math.max(2, Math.min(MAX_SEGMENTS, height - 1));

  const geometry = new THREE.PlaneGeometry(planeW, planeH, segX, segY);
  const position = geometry.attributes.position;

  /* --- displace along the plane's local Z ------------------------------- */

  const cols = segX + 1;
  const rows = segY + 1;

  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const index = row * cols + col;
      const u = cols > 1 ? col / (cols - 1) : 0;
      const v = rows > 1 ? row / (rows - 1) : 0;
      const d = sampleDepth(depth, width, height, u, v);
      position.setZ(index, d * RELIEF_DEPTH);
    }
  }

  position.needsUpdate = true;
  // Displacement invalidates the plane's flat normals; without this the relief
  // lights as if it were still a flat sheet.
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();

  /* --- texture from the source pixels ----------------------------------- */

  // Copy by value, not by buffer: colors may be backed by a SharedArrayBuffer
  // (which DataTexture will not accept) and we must not alias the caller's data.
  const texture = new THREE.DataTexture(
    new Uint8Array(colors),
    width,
    height,
    THREE.RGBAFormat,
  );
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.flipY = true;
  texture.needsUpdate = true;

  const material = new THREE.MeshStandardMaterial({
    map: texture,
    // The photo is also its own emissive map. The stage is lit by two strongly
    // coloured point lights, and a purely lit material would render a white
    // football in red and green. Emissive carries the true colours through
    // while the map still takes some shading, so the relief keeps its depth.
    emissiveMap: texture,
    emissive: new THREE.Color(0xffffff),
    emissiveIntensity: 0.85,
    roughness: 0.9,
    metalness: 0.0,
    side: THREE.DoubleSide,
    // Cut-out PNGs carry the subject silhouette in alpha. alphaTest discards
    // the transparent pixels, leaving the object instead of a rectangular slab.
    // Deliberately NOT transparent:true - a displaced surface rendered in the
    // transparent pass sorts per-object, not per-fragment, so folds in the
    // relief draw over each other. Alpha-test keeps it in the opaque pass.
    transparent: false,
    alphaTest: 0.35,
  });

  const mesh = new THREE.Mesh(geometry, material);
  group.add(mesh);


  // Stand it upright on the stage, facing the default camera.
  group.position.y = planeH / 2;

  // The relief wears the photo's own colours; the palette does not apply.
  const setColors = (): void => {};

  const update = (elapsed: number): void => {
    group.position.y = planeH / 2 + Math.sin(elapsed * 0.7) * 0.08;
  };

  const dispose = (): void => {
    texture.dispose();
    material.dispose();
    geometry.dispose();
    disposeObject3D(group);
  };

  return { group, setColors, update, dispose };
}
