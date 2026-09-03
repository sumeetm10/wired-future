/**
 * Wired Future — the real car.
 *
 * Loads the Khronos "CarConcept" glTF asset and normalises it onto our stage.
 * Unlike the parametric car in models.ts this keeps the asset's own PBR
 * materials — that is the entire reason for using it — and expresses the live
 * palette through a tint, an underglow and a wireframe overlay instead of
 * flattening the paint to a solid colour.
 *
 * Asset: CarConcept, Darmstadt Graphics Group GmbH, CC BY 4.0.
 * Source: KhronosGroup/glTF-Sample-Assets.
 *
 * No React, no store imports. Pure three.js.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

import { buildCarRig, type CarRig } from './car-rig';
import { disposeObject3D, type ModelHandle } from './models';

/** Longest horizontal dimension the car should occupy, in world units. */
const TARGET_LENGTH = 5.2;

/** Material names that read as bodywork and should take the accent tint. */
const BODY_HINTS = ['paint', 'body', 'car', 'chassis', 'shell', 'hood', 'door'];

function assetUrl(): string {
  const base = process.env.NEXT_PUBLIC_BASE_PATH || '';
  return base + '/models/CarConcept.glb';
}

function looksLikeBodywork(material: THREE.Material): boolean {
  const name = (material.name || '').toLowerCase();
  return BODY_HINTS.some((hint) => name.includes(hint));
}

/**
 * Fit the loaded scene onto our stage: centred on X/Z, resting on y = 0, and
 * scaled so its longest horizontal dimension is TARGET_LENGTH.
 *
 * The asset ships in metres and is not centred, so without this it is either a
 * speck or fills the whole frame.
 */
function normalise(root: THREE.Object3D): void {
  root.updateMatrixWorld(true);

  const box = new THREE.Box3().setFromObject(root);
  if (box.isEmpty()) return;

  const size = box.getSize(new THREE.Vector3());
  const longest = Math.max(size.x, size.z) || Math.max(size.y, 1);
  const scale = TARGET_LENGTH / longest;
  root.scale.setScalar(scale);

  // Re-measure after scaling; the offset has to be in the scaled frame.
  root.updateMatrixWorld(true);
  const scaled = new THREE.Box3().setFromObject(root);
  const centre = scaled.getCenter(new THREE.Vector3());

  root.position.x -= centre.x;
  root.position.z -= centre.z;
  root.position.y -= scaled.min.y;
}

export interface RealCarHandle extends ModelHandle {
  /** Per-assembly control: doors, hood, wheels, explode, print finish. */
  rig: CarRig;
}

/**
 * Load and prepare the concept car. Rejects if the asset cannot be fetched or
 * parsed — the engine decides the fallback, this function does not guess.
 */
export async function loadRealCar(
  gridHex: string,
  accentHex: string,
): Promise<RealCarHandle> {
  const loader = new GLTFLoader();
  const url = assetUrl();

  const gltf = await loader.loadAsync(url);
  const model = gltf.scene;
  normalise(model);

  const group = new THREE.Group();
  group.name = 'wired-real-car';

  // Take the car apart into addressable assemblies. buildCarRig re-parents the
  // 97 mesh nodes onto pivots, so from here on `model` is an empty shell and
  // the rig root is what actually carries geometry.
  const rig = buildCarRig(model);
  group.add(rig.root);

  /* --- palette plumbing ------------------------------------------------ */

  // Cache the shipped colours once so repeated setColors() calls tint from the
  // original rather than compounding on the previous tint.
  const originalColors = new Map<THREE.Material, THREE.Color>();
  const bodyMaterials: THREE.MeshStandardMaterial[] = [];

  group.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of materials) {
      if (!material) continue;
      const standard = material as THREE.MeshStandardMaterial;
      if (standard.color && !originalColors.has(standard)) {
        originalColors.set(standard, standard.color.clone());
        if (looksLikeBodywork(standard)) bodyMaterials.push(standard);
      }
    }
  });

  // If no material announced itself as bodywork, tint the largest few instead
  // of tinting nothing — asset naming conventions are not guaranteed.
  if (bodyMaterials.length === 0) {
    for (const material of originalColors.keys()) {
      bodyMaterials.push(material as THREE.MeshStandardMaterial);
      if (bodyMaterials.length >= 3) break;
    }
  }

  /* --- underglow ------------------------------------------------------- */

  const underglow = new THREE.PointLight(new THREE.Color(gridHex), 24, 14, 2);
  underglow.position.set(0, 0.35, 0);
  group.add(underglow);

  const glowGeometry = new THREE.CircleGeometry(3.4, 40);
  const glowMaterial = new THREE.MeshBasicMaterial({
    color: new THREE.Color(gridHex),
    transparent: true,
    opacity: 0.14,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const glowDisc = new THREE.Mesh(glowGeometry, glowMaterial);
  glowDisc.rotation.x = -Math.PI / 2;
  glowDisc.position.y = 0.02;
  group.add(glowDisc);

  // No wireframe overlay: the point of loading a real asset is the real
  // surface, and a mesh-lines pass on top of it both hides the paint and
  // competes with the transform gizmo for attention.

  /* --- wheels ---------------------------------------------------------- */

  const wheels: THREE.Object3D[] = [];
  group.traverse((child) => {
    const name = (child.name || '').toLowerCase();
    if (name.includes('wheel') || name.includes('tire') || name.includes('tyre')) {
      wheels.push(child);
    }
  });

  /* --- handle ---------------------------------------------------------- */

  const tint = new THREE.Color();

  const setColors = (nextGrid: string, nextAccent: string): void => {
    const accent = new THREE.Color(nextAccent);
    for (const material of bodyMaterials) {
      const base = originalColors.get(material);
      if (!base) continue;
      // Blend from the ORIGINAL, never from the current value.
      tint.copy(base).lerp(accent, 0.35);
      material.color.copy(tint);
    }
    underglow.color.set(nextGrid);
    glowMaterial.color.set(nextGrid);
  };

  setColors(gridHex, accentHex);

  // Wheels no longer spin: the car is a subject being taken apart, not a car
  // being driven, and a spinning wheel fights the explode/detach view.
  const update = (): void => {};

  const dispose = (): void => {
    rig.dispose();
    glowGeometry.dispose();
    glowMaterial.dispose();
    originalColors.clear();
    bodyMaterials.length = 0;
    wheels.length = 0;
    disposeObject3D(group);
  };

  return { group, rig, setColors, update, dispose };
}
