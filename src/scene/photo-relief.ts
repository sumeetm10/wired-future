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

/**
 * Otsu's threshold over a 256-bin histogram of `depth` between lo and hi:
 * the split that best separates two populations. A subject in front of a
 * background is exactly two populations in depth.
 */
function otsuThreshold(depth: Float32Array, lo: number, hi: number): number {
  const BINS = 256;
  const hist = new Uint32Array(BINS);
  const scale = (BINS - 1) / Math.max(1e-6, hi - lo);
  for (let i = 0; i < depth.length; i += 1) {
    const b = Math.round((depth[i] - lo) * scale);
    hist[b < 0 ? 0 : b > BINS - 1 ? BINS - 1 : b] += 1;
  }

  const total = depth.length;
  let sum = 0;
  for (let b = 0; b < BINS; b += 1) sum += b * hist[b];

  let sumB = 0;
  let wB = 0;
  let best = 0;
  let bestVar = -1;
  for (let b = 0; b < BINS; b += 1) {
    wB += hist[b];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += b * hist[b];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const v = wB * wF * (mB - mF) * (mB - mF);
    if (v > bestVar) {
      bestVar = v;
      best = b;
    }
  }
  return lo + best / scale;
}

/**
 * Estimate which depth counts as "background" and cut it away.
 *
 * Alpha only helps for a cut-out PNG. A photo, or a screenshot of a cut-out
 * with the checkerboard baked in, is fully opaque, so the empty surround gets
 * reconstructed as surface and the subject ends up embedded in a slab.
 *
 * Depth knows better. The split is Otsu's threshold over the depth histogram,
 * bounded to a band above the median depth of the frame's border ring: the
 * border is almost always background and the model puts it far away, so the
 * band stops Otsu from slicing through the subject on an image with a strong
 * depth gradient across it, while still letting it find the true edge.
 *
 * Writes alpha 0 into `colors` for background pixels; the material alpha-tests
 * them out. Returns the threshold used, or null when nothing was cut.
 */
function cutBackgroundByDepth(
  depth: Float32Array,
  colors: Uint8ClampedArray,
  width: number,
  height: number,
): number | null {
  const ring: number[] = [];
  const band = Math.max(1, Math.round(Math.min(width, height) * 0.04));

  for (let y = 0; y < height; y += 1) {
    const edgeRow = y < band || y >= height - band;
    for (let x = 0; x < width; x += 1) {
      if (edgeRow || x < band || x >= width - band) {
        ring.push(depth[y * width + x]);
      }
    }
  }
  if (ring.length < 16) return null;

  ring.sort((a, b) => a - b);
  const median = ring[ring.length >> 1];

  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < depth.length; i += 1) {
    const d = depth[i];
    if (d < lo) lo = d;
    if (d > hi) hi = d;
  }
  const spread = hi - lo;
  // A flat image has no foreground to find; leave it alone.
  if (spread < 0.15) return null;

  const floor = median + spread * 0.05;
  const ceil = median + spread * 0.4;
  const threshold = Math.min(ceil, Math.max(floor, otsuThreshold(depth, lo, hi)));

  let cut = 0;
  for (let i = 0; i < depth.length; i += 1) {
    if (depth[i] <= threshold) {
      colors[i * 4 + 3] = 0;
      cut += 1;
    }
  }

  // If nearly everything would go, the subject fills the frame and the border
  // was not background after all. Undo rather than delete the whole image.
  if (cut > depth.length * 0.9) {
    for (let i = 0; i < depth.length; i += 1) colors[i * 4 + 3] = 255;
    return null;
  }
  return cut > 0 ? threshold : null;
}

/**
 * Once the background is gone the surviving depths only span part of 0..1.
 * Stretch them so the subject's own edge sits at zero and its nearest point
 * uses the full relief height: a ball becomes a dome, not a bump on a sheet.
 * Cut pixels clamp to zero, so the skirt around the silhouette lies flat.
 */
function remapAboveThreshold(depth: Float32Array, threshold: number): Float32Array {
  let hi = -Infinity;
  for (let i = 0; i < depth.length; i += 1) if (depth[i] > hi) hi = depth[i];
  const range = Math.max(1e-6, hi - threshold);
  const out = new Float32Array(depth.length);
  for (let i = 0; i < depth.length; i += 1) {
    const d = (depth[i] - threshold) / range;
    out[i] = d > 0 ? d : 0;
  }
  return out;
}

export function buildPhotoRelief(
  input: PhotoReliefInput,
  gridHex: string,
): ModelHandle {
  const { width, height, depth } = input;
  // Copy first: the cut writes alpha, and the caller's buffer is not ours.
  const colors = new Uint8ClampedArray(input.colors);
  const threshold = cutBackgroundByDepth(depth, colors, width, height);
  const relief = threshold === null ? depth : remapAboveThreshold(depth, threshold);

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
      const d = sampleDepth(relief, width, height, u, v);
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
