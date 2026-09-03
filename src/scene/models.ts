/**
 * Wired Future — the two swappable centrepiece models.
 *
 * Each builder returns a handle with a stable shape so engine.ts can treat the
 * car and the engine node interchangeably:
 *
 *   { group, setColors(grid, accent), update(elapsed), dispose() }
 *
 * The handle owns its geometries and materials and disposes every one of them.
 * Solid surfaces are MeshStandardMaterial with emissive driven by the palette;
 * the neon outlines are MeshBasicMaterial in wireframe mode.
 *
 * No React, no store imports. Pure three.js.
 */

import * as THREE from 'three';

export interface ModelHandle {
  /** Add this to the scene. The engine spins its parent pivot, not this group. */
  group: THREE.Group;
  setColors: (gridHex: string, accentHex: string) => void;
  /** Per-frame animation local to the model (ring spin, hover bob). */
  update: (elapsed: number) => void;
  dispose: () => void;
}

/** Dispose every unique geometry/material below `root` and detach it. */
export function disposeObject3D(root: THREE.Object3D): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();

  root.traverse((child) => {
    const mesh = child as Partial<THREE.Mesh>;
    if (mesh.geometry) geometries.add(mesh.geometry as THREE.BufferGeometry);
    const material = mesh.material;
    if (Array.isArray(material)) {
      material.forEach((m) => materials.add(m));
    } else if (material) {
      materials.add(material as THREE.Material);
    }
  });

  geometries.forEach((g) => g.dispose());
  materials.forEach((m) => m.dispose());

  if (root.parent) root.parent.remove(root);
  root.clear();
}

/** A darkened body tone derived from the live palette colour. */
function bodyTone(hex: string, scale: number): THREE.Color {
  return new THREE.Color(hex).multiplyScalar(scale);
}

/* ------------------------------------------------------------------ */
/* Car module                                                          */
/* ------------------------------------------------------------------ */

export function buildCarModule(gridHex: string, accentHex: string): ModelHandle {
  const group = new THREE.Group();
  group.name = 'wired-car';

  const geometries: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];

  const track = <T extends THREE.BufferGeometry>(g: T): T => {
    geometries.push(g);
    return g;
  };
  const trackMat = <T extends THREE.Material>(m: T): T => {
    materials.push(m);
    return m;
  };

  const bodyMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: bodyTone(gridHex, 0.16),
      emissive: new THREE.Color(gridHex),
      emissiveIntensity: 0.35,
      metalness: 0.75,
      roughness: 0.3,
    }),
  );

  const cabinMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: bodyTone(accentHex, 0.14),
      emissive: new THREE.Color(accentHex),
      emissiveIntensity: 0.45,
      metalness: 0.6,
      roughness: 0.25,
      transparent: true,
      opacity: 0.92,
    }),
  );

  const wheelMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: new THREE.Color('#0d0a1c'),
      emissive: new THREE.Color(gridHex),
      emissiveIntensity: 0.18,
      metalness: 0.4,
      roughness: 0.65,
    }),
  );

  const accentMat = trackMat(
    new THREE.MeshBasicMaterial({ color: new THREE.Color(accentHex) }),
  );

  const wireMat = trackMat(
    new THREE.MeshBasicMaterial({
      color: new THREE.Color(gridHex),
      wireframe: true,
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
    }),
  );

  // Chassis -----------------------------------------------------------
  const chassisGeo = track(new THREE.BoxGeometry(4.8, 0.72, 2.24));
  const chassis = new THREE.Mesh(chassisGeo, bodyMat);
  chassis.position.y = 0.62;
  group.add(chassis);

  const chassisWireGeo = track(new THREE.BoxGeometry(4.88, 0.8, 2.32));
  const chassisWire = new THREE.Mesh(chassisWireGeo, wireMat);
  chassisWire.position.copy(chassis.position);
  group.add(chassisWire);

  // Cabin -------------------------------------------------------------
  const cabinGeo = track(new THREE.BoxGeometry(2.3, 0.74, 1.86));
  const cabin = new THREE.Mesh(cabinGeo, cabinMat);
  cabin.position.set(-0.28, 1.32, 0);
  group.add(cabin);

  const cabinWireGeo = track(new THREE.BoxGeometry(2.38, 0.82, 1.94));
  const cabinWire = new THREE.Mesh(cabinWireGeo, wireMat);
  cabinWire.position.copy(cabin.position);
  group.add(cabinWire);

  // Wheels ------------------------------------------------------------
  const wheelGeo = track(new THREE.CylinderGeometry(0.46, 0.46, 0.34, 16, 1));
  const wheelOffsets: Array<[number, number]> = [
    [1.55, 1.12],
    [1.55, -1.12],
    [-1.55, 1.12],
    [-1.55, -1.12],
  ];
  for (const [x, z] of wheelOffsets) {
    const wheel = new THREE.Mesh(wheelGeo, wheelMat);
    wheel.rotation.x = Math.PI / 2;
    wheel.position.set(x, 0.32, z);
    group.add(wheel);
  }

  // Glowing flank strips ----------------------------------------------
  const stripGeo = track(new THREE.BoxGeometry(4.3, 0.07, 0.07));
  for (const z of [1.16, -1.16]) {
    const strip = new THREE.Mesh(stripGeo, accentMat);
    strip.position.set(0, 0.66, z);
    group.add(strip);
  }

  // Headlight bar + tail bar ------------------------------------------
  const lampGeo = track(new THREE.BoxGeometry(0.09, 0.12, 1.5));
  const headlight = new THREE.Mesh(lampGeo, accentMat);
  headlight.position.set(2.42, 0.72, 0);
  group.add(headlight);

  const tail = new THREE.Mesh(lampGeo, accentMat);
  tail.position.set(-2.42, 0.72, 0);
  group.add(tail);

  // Under-glow blade ---------------------------------------------------
  const bladeGeo = track(new THREE.BoxGeometry(4.0, 0.05, 1.9));
  const blade = new THREE.Mesh(bladeGeo, wireMat);
  blade.position.set(0, 0.16, 0);
  group.add(blade);

  const setColors = (grid: string, accent: string): void => {
    bodyMat.color.copy(bodyTone(grid, 0.16));
    bodyMat.emissive.set(grid);
    cabinMat.color.copy(bodyTone(accent, 0.14));
    cabinMat.emissive.set(accent);
    wheelMat.emissive.set(grid);
    accentMat.color.set(accent);
    wireMat.color.set(grid);
  };

  const update = (elapsed: number): void => {
    // Subtle hover bob + a hint of roll; the engine owns the yaw spin.
    group.position.y = Math.sin(elapsed * 0.9) * 0.14;
    group.rotation.z = Math.sin(elapsed * 0.55) * 0.03;
  };

  const dispose = (): void => {
    if (group.parent) group.parent.remove(group);
    group.clear();
    geometries.forEach((g) => g.dispose());
    materials.forEach((m) => m.dispose());
    geometries.length = 0;
    materials.length = 0;
  };

  return { group, setColors, update, dispose };
}

/* ------------------------------------------------------------------ */
/* Engine node                                                         */
/* ------------------------------------------------------------------ */

export function buildEngineNode(gridHex: string, accentHex: string): ModelHandle {
  const group = new THREE.Group();
  group.name = 'wired-engine-node';

  const geometries: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];

  const track = <T extends THREE.BufferGeometry>(g: T): T => {
    geometries.push(g);
    return g;
  };
  const trackMat = <T extends THREE.Material>(m: T): T => {
    materials.push(m);
    return m;
  };

  const coreMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: bodyTone(gridHex, 0.2),
      emissive: new THREE.Color(gridHex),
      emissiveIntensity: 0.7,
      metalness: 0.55,
      roughness: 0.25,
    }),
  );

  const coreWireMat = trackMat(
    new THREE.MeshBasicMaterial({
      color: new THREE.Color(accentHex),
      wireframe: true,
      transparent: true,
      opacity: 0.7,
      depthWrite: false,
    }),
  );

  const ringPrimaryMat = trackMat(
    new THREE.MeshBasicMaterial({
      color: new THREE.Color(gridHex),
      wireframe: true,
      transparent: true,
      opacity: 0.8,
      depthWrite: false,
    }),
  );

  const ringAccentMat = trackMat(
    new THREE.MeshBasicMaterial({
      color: new THREE.Color(accentHex),
      wireframe: true,
      transparent: true,
      opacity: 0.75,
      depthWrite: false,
    }),
  );

  const satelliteMat = trackMat(
    new THREE.MeshBasicMaterial({ color: new THREE.Color(accentHex) }),
  );

  // Core --------------------------------------------------------------
  const coreGeo = track(new THREE.OctahedronGeometry(1.15, 0));
  const core = new THREE.Mesh(coreGeo, coreMat);
  core.position.y = 1.2;
  group.add(core);

  const coreWireGeo = track(new THREE.OctahedronGeometry(1.45, 1));
  const coreWire = new THREE.Mesh(coreWireGeo, coreWireMat);
  coreWire.position.copy(core.position);
  group.add(coreWire);

  // Rings -------------------------------------------------------------
  const ringMajorGeo = track(new THREE.TorusGeometry(2.35, 0.06, 6, 60));
  const ringMajor = new THREE.Mesh(ringMajorGeo, ringPrimaryMat);
  ringMajor.position.copy(core.position);
  ringMajor.rotation.x = Math.PI / 2;
  group.add(ringMajor);

  const ringMinorGeo = track(new THREE.TorusGeometry(1.72, 0.05, 6, 48));
  const ringMinor = new THREE.Mesh(ringMinorGeo, ringAccentMat);
  ringMinor.position.copy(core.position);
  ringMinor.rotation.y = Math.PI / 2;
  ringMinor.rotation.z = 0.4;
  group.add(ringMinor);

  const ringTiltGeo = track(new THREE.TorusGeometry(2.0, 0.04, 6, 48));
  const ringTilt = new THREE.Mesh(ringTiltGeo, ringPrimaryMat);
  ringTilt.position.copy(core.position);
  ringTilt.rotation.set(Math.PI / 3, 0, Math.PI / 5);
  group.add(ringTilt);

  // Orbiting satellites -----------------------------------------------
  const satelliteOrbit = new THREE.Group();
  satelliteOrbit.position.copy(core.position);
  group.add(satelliteOrbit);

  const satelliteGeo = track(new THREE.SphereGeometry(0.13, 10, 8));
  const SATELLITES = 4;
  for (let i = 0; i < SATELLITES; i += 1) {
    const angle = (i / SATELLITES) * Math.PI * 2;
    const satellite = new THREE.Mesh(satelliteGeo, satelliteMat);
    satellite.position.set(
      Math.cos(angle) * 2.35,
      Math.sin(angle * 2) * 0.35,
      Math.sin(angle) * 2.35,
    );
    satelliteOrbit.add(satellite);
  }

  // Base pylon ---------------------------------------------------------
  const pylonGeo = track(new THREE.CylinderGeometry(0.1, 0.34, 1.2, 8, 1, true));
  const pylon = new THREE.Mesh(pylonGeo, ringPrimaryMat);
  pylon.position.y = 0.1;
  group.add(pylon);

  const setColors = (grid: string, accent: string): void => {
    coreMat.color.copy(bodyTone(grid, 0.2));
    coreMat.emissive.set(grid);
    coreWireMat.color.set(accent);
    ringPrimaryMat.color.set(grid);
    ringAccentMat.color.set(accent);
    satelliteMat.color.set(accent);
  };

  const update = (elapsed: number): void => {
    ringMajor.rotation.z = elapsed * 0.65;
    ringMinor.rotation.x = -elapsed * 0.95;
    ringTilt.rotation.y = elapsed * 0.42;
    core.rotation.y = elapsed * 0.5;
    core.rotation.x = Math.sin(elapsed * 0.4) * 0.25;
    coreWire.rotation.y = -elapsed * 0.32;
    satelliteOrbit.rotation.y = elapsed * 0.8;
    group.position.y = Math.sin(elapsed * 0.75) * 0.1;
  };

  const dispose = (): void => {
    if (group.parent) group.parent.remove(group);
    satelliteOrbit.clear();
    group.clear();
    geometries.forEach((g) => g.dispose());
    materials.forEach((m) => m.dispose());
    geometries.length = 0;
    materials.length = 0;
  };

  return { group, setColors, update, dispose };
}
