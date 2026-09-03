/**
 * Wired Future — the car rig.
 *
 * The CarConcept glTF ships as 97 separately named mesh nodes, so the car can
 * be taken apart rather than admired whole. This module re-parents those nodes
 * into a dozen logical assemblies and gives each one a pivot, so doors swing on
 * a real hinge, the hood lifts from its rear edge, wheels come off, and the
 * whole thing can be exploded into a parts diagram and reassembled.
 *
 * It also carries the "3D print" finish: every material swapped for one matte
 * resin-grey, which is how you actually read the geometry of a model whose
 * paint is doing most of the visual work.
 *
 * No React, no store imports. Pure three.js.
 */

import * as THREE from 'three';

import type {
  NodeTransform,
  PartEdit,
  PartMaterialId,
} from '@/store/use-wired';
import {
  applyEditToMeshes,
  buildPartMaterial,
  measureMeshes,
  type PartMeasurement,
} from './part-ops';

export type CarPartId =
  | 'body'
  | 'doorLeft'
  | 'doorRight'
  | 'hood'
  | 'roof'
  | 'glass'
  | 'interior'
  | 'engine'
  | 'lights'
  | 'wheelFL'
  | 'wheelFR'
  | 'wheelRL'
  | 'wheelRR';

export const CAR_PART_IDS: CarPartId[] = [
  'body',
  'doorLeft',
  'doorRight',
  'hood',
  'roof',
  'glass',
  'interior',
  'engine',
  'lights',
  'wheelFL',
  'wheelFR',
  'wheelRL',
  'wheelRR',
];

export const CAR_PART_LABELS: Record<CarPartId, string> = {
  body: 'Body Shell',
  doorLeft: 'Left Door',
  doorRight: 'Right Door',
  hood: 'Hood',
  roof: 'Roof Panel',
  glass: 'Glass',
  interior: 'Interior',
  engine: 'Engine + Axles',
  lights: 'Lights',
  wheelFL: 'Wheel Front L',
  wheelFR: 'Wheel Front R',
  wheelRL: 'Wheel Rear L',
  wheelRR: 'Wheel Rear R',
};

export type CarFinish = 'paint' | 'print';

/**
 * One individually addressable mesh from the glTF - a door handle, a wiper, a
 * brake disc. There are 97 of them. Each sits on its own pivot nested inside
 * its assembly's pivot, so a node can be moved, hidden or reshaped without
 * disturbing the assembly, and the assembly can still swing on its hinge with
 * the node riding along.
 */
export interface CarNodeInfo {
  id: string;
  label: string;
  assembly: CarPartId;
  triangles: number;
}

/**
 * Names three.js invents for meshes the asset left unnamed - the tyres, and
 * the extra primitives a multi-material mesh is split into. They carry no
 * meaning, so they are replaced with a numbered label from the assembly.
 */
const AUTO_NAME = /^(mesh|object|node|primitive)[_\d]*$/i;

/** Turn a glTF node name into something a person can read in a list. */
function humanise(name: string, fallback: string): string {
  const raw = (name || '').trim();
  if (!raw || AUTO_NAME.test(raw)) return fallback;
  return (
    raw
      .replace(/^Body|^Interior/, '')
      .replace(/[_-]+/g, ' ')
      // lower->Upper: "DoorHandle" -> "Door Handle"
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      // Upper->Upper+lower: "LColor" -> "L Color", so "BodyDoorLColor2"
      // reads "Door L Color 2" instead of "Door LColor 2".
      .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
      .replace(/([A-Za-z])(\d)/g, '$1 $2')
      .replace(/\s+/g, ' ')
      .trim() || fallback
  );
}

/* ------------------------------------------------------------------ */
/* Classification                                                      */
/* ------------------------------------------------------------------ */

const WHEEL_ANCESTORS: Record<string, CarPartId> = {
  WheelFrontL: 'wheelFL',
  WheelFrontR: 'wheelFR',
  WheelRearL: 'wheelRL',
  WheelRearR: 'wheelRR',
};

/**
 * Which assembly a mesh belongs to.
 *
 * Wheels are resolved by walking UP the graph: each wheel's tyre mesh is an
 * unnamed child of its wheel group, so its own name says nothing.
 */
function classify(node: THREE.Object3D): CarPartId {
  let cursor: THREE.Object3D | null = node;
  while (cursor) {
    const wheel = WHEEL_ANCESTORS[cursor.name];
    if (wheel) return wheel;
    cursor = cursor.parent;
  }

  const name = node.name;

  if (name.startsWith('BodyDoorL') || name.startsWith('InteriorDoorL')) return 'doorLeft';
  if (name.startsWith('BodyDoorR') || name.startsWith('InteriorDoorR')) return 'doorRight';
  if (name.startsWith('BodyHood')) return 'hood';
  if (name.startsWith('BodyRoofPanel')) return 'roof';
  if (name === 'Engine' || name === 'Axles') return 'engine';

  if (
    name.startsWith('BodyHeadlights') ||
    name.startsWith('BodyTaillights') ||
    name.startsWith('BodyTurnsignals')
  ) {
    return 'lights';
  }

  if (
    name.startsWith('BodyWindshield') ||
    name.startsWith('BodyRearwindow') ||
    name.startsWith('BodyWindows')
  ) {
    return 'glass';
  }

  if (name.startsWith('Interior')) return 'interior';

  return 'body';
}

/* ------------------------------------------------------------------ */
/* Rig                                                                 */
/* ------------------------------------------------------------------ */

interface Hinge {
  /** Local axis the assembly swings about. */
  axis: 'x' | 'y' | 'z';
  /** Radians at fully open. Sign encodes the direction. */
  maxAngle: number;
}

interface CarNode {
  id: string;
  label: string;
  assembly: CarPartId;
  pivot: THREE.Group;
  mesh: THREE.Mesh;
  /** Rest position of the node pivot, before any user transform. */
  basePosition: THREE.Vector3;
  triangles: number;
}

interface Assembly {
  id: CarPartId;
  meshes: THREE.Mesh[];
  /**
   * Centre of the part AS SHIPPED, in the pivot's local space.
   *
   * Deformations always rebuild from the pristine geometry, so they must always
   * be centred on the pristine centre. Re-measuring the live bounding box gives
   * the centre of the ALREADY-DEFORMED part, and rebuilding the original about
   * that point translates the part a little further every time a slider ticks —
   * which walks it off the screen. Local space, not world, so the value stays
   * correct while the part is exploded out or swung open on its hinge.
   */
  restCentreLocal: THREE.Vector3;
  /** Material built for the current PartEdit, disposed when it is replaced. */
  editMaterial: THREE.MeshStandardMaterial | null;
  /**
   * Last measurement, kept until this part's geometry changes. Measuring the
   * body shell walks 42k triangles, and inspect_car_part is the tool an agent
   * calls most, usually twice in a row while it reasons.
   */
  measurement: PartMeasurement | null;
  /** Sits at the hinge point (or the assembly centre when there is none). */
  pivot: THREE.Group;
  /** Rest position of the pivot; explode offsets are added to this. */
  basePosition: THREE.Vector3;
  /** Unit direction this assembly flies out along when exploded. */
  explodeDir: THREE.Vector3;
  hinge: Hinge | null;
}

export interface CarRig {
  root: THREE.Group;
  /** Every individually addressable mesh, for the part tree and the agent. */
  listNodes: () => CarNodeInfo[];
  /** Which node a raycast hit belongs to, and its assembly. */
  identify: (object: THREE.Object3D) => { node: string; assembly: CarPartId } | null;
  /** The Object3D a transform gizmo should attach to for this selection. */
  pivotFor: (level: 'assembly' | 'node', id: string) => THREE.Object3D | null;
  /** Free transform on one node, relative to its rest pose. */
  setNodeTransform: (id: string, next: NodeTransform) => void;
  setNodeHidden: (ids: string[]) => void;
  /** Read a node's live transform back, for the gizmo -> store direction. */
  readNodeTransform: (id: string) => NodeTransform | null;
  /** Real geometry measurements for one assembly, or null if absent. */
  measurePart: (id: CarPartId) => PartMeasurement | null;
  /** Reshape and re-material one assembly. Absolute, not cumulative. */
  setPartEdit: (id: CarPartId, edit: PartEdit) => void;
  setFinish: (finish: CarFinish) => void;
  setExplode: (t: number) => void;
  setDoor: (side: 'left' | 'right', t: number) => void;
  setHood: (t: number) => void;
  setHidden: (ids: CarPartId[]) => void;
  /** Which assemblies actually exist in the loaded asset. */
  presentParts: () => CarPartId[];
  dispose: () => void;
}

const PRINT_COLOR = 0xd8dae2;

export function buildCarRig(model: THREE.Object3D): CarRig {
  const root = new THREE.Group();
  root.name = 'wired-car-rig';

  model.updateMatrixWorld(true);

  /* --- measure the whole car before touching the graph --------------- */

  const fullBox = new THREE.Box3().setFromObject(model);
  const fullSize = fullBox.getSize(new THREE.Vector3());
  const fullCentre = fullBox.getCenter(new THREE.Vector3());
  const maxDim = Math.max(fullSize.x, fullSize.y, fullSize.z) || 1;

  // The car is longer than it is wide, so the longer horizontal axis is
  // forward. Everything hinge-related depends on getting this right.
  const forwardIsZ = fullSize.z >= fullSize.x;

  /* --- collect meshes BEFORE re-parenting ---------------------------- */

  const meshes: THREE.Mesh[] = [];
  model.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (mesh.isMesh) meshes.push(mesh);
  });

  const originalMaterials = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>();
  for (const mesh of meshes) originalMaterials.set(mesh, mesh.material);

  const buckets = new Map<CarPartId, THREE.Mesh[]>();
  for (const mesh of meshes) {
    const id = classify(mesh);
    const list = buckets.get(id);
    if (list) list.push(mesh);
    else buckets.set(id, [mesh]);
  }

  /* --- build one pivot per assembly ---------------------------------- */

  const assemblies = new Map<CarPartId, Assembly>();
  const nodes = new Map<string, CarNode>();
  const meshToNode = new Map<THREE.Mesh, string>();
  /** Per-assembly counter, so unnamed meshes get "Body Shell part 3". */
  const assemblySeq = new Map<CarPartId, number>();
  let nodeSeq = 0;

  for (const [id, group] of buckets) {
    // Measure in world space while the meshes are still where they started.
    const box = new THREE.Box3();
    for (const mesh of group) box.expandByObject(mesh);
    if (box.isEmpty()) continue;

    const centre = box.getCenter(new THREE.Vector3());

    const pivot = new THREE.Group();
    pivot.name = 'assembly:' + id;

    // Hinge location, or the assembly centre when it does not swing.
    const anchor = centre.clone();
    let hinge: Hinge | null = null;

    if (id === 'doorLeft' || id === 'doorRight') {
      // Hinge on the FRONT vertical edge of the door.
      if (forwardIsZ) anchor.z = box.max.z;
      else anchor.x = box.max.x;
      // Which side of the car this door is on, measured on the LATERAL axis —
      // which is X only when the car runs along Z.
      const outward = forwardIsZ
        ? centre.x - fullCentre.x
        : centre.z - fullCentre.z;
      hinge = {
        axis: 'y',
        maxAngle: THREE.MathUtils.degToRad(62) * (outward >= 0 ? -1 : 1),
      };
    } else if (id === 'hood') {
      // Hinge on the REAR edge, so it lifts at the front like a real bonnet.
      if (forwardIsZ) anchor.z = box.min.z;
      else anchor.x = box.min.x;
      // A bonnet pivots about the LATERAL axis, which is whichever horizontal
      // axis is not the forward one.
      hinge = {
        axis: forwardIsZ ? 'x' : 'z',
        maxAngle: THREE.MathUtils.degToRad(-52),
      };
    }

    pivot.position.copy(anchor);
    root.add(pivot);

    // attach() preserves each mesh's world transform while re-parenting it,
    // which is the whole reason this can be done after the fact.
    for (const mesh of group) pivot.attach(mesh);

    // Then give every mesh its OWN pivot inside the assembly, so a single
    // handle or wiper can be grabbed without moving the door it belongs to.
    for (const mesh of group) {
      const meshBox = new THREE.Box3().setFromObject(mesh);
      if (meshBox.isEmpty()) continue;

      const meshCentre = meshBox.getCenter(new THREE.Vector3());
      pivot.updateMatrixWorld(true);
      const localCentre = pivot.worldToLocal(meshCentre.clone());

      const nodePivot = new THREE.Group();
      const nodeId = id + ':' + (mesh.name || 'part' + nodeSeq);
      nodePivot.name = 'node:' + nodeId;
      nodePivot.position.copy(localCentre);
      pivot.add(nodePivot);
      nodePivot.attach(mesh);

      assemblySeq.set(id, (assemblySeq.get(id) ?? 0) + 1);

      const geometry = mesh.geometry;
      const indexed = geometry.getIndex();
      const triangles = Math.round(
        (indexed ? indexed.count : geometry.getAttribute('position')?.count ?? 0) / 3,
      );

      const node: CarNode = {
        id: nodeId,
        label: humanise(
          mesh.name,
          CAR_PART_LABELS[id] + ' part ' + (assemblySeq.get(id) ?? 1),
        ),
        assembly: id,
        pivot: nodePivot,
        mesh,
        basePosition: localCentre.clone(),
        triangles,
      };
      nodes.set(nodeId, node);
      meshToNode.set(mesh, nodeId);
      nodeSeq += 1;
    }

    // Explode outward from the car centre, biased upward so parts fan into a
    // readable diagram instead of collapsing into the ground plane.
    const dir = centre.clone().sub(fullCentre);
    if (dir.lengthSq() < 1e-6) dir.set(0, 1, 0);
    dir.normalize();
    dir.y += 0.35;
    dir.normalize();

    assemblies.set(id, {
      id,
      meshes: group,
      // pivot sits at `anchor` with identity rotation/scale at this moment, so
      // a world point P is simply P - anchor in its local frame.
      restCentreLocal: centre.clone().sub(anchor),
      measurement: null,
      editMaterial: null,
      pivot,
      basePosition: anchor.clone(),
      explodeDir: dir,
      hinge,
    });
  }

  /* --- finishes ------------------------------------------------------- */

  const printMaterial = new THREE.MeshStandardMaterial({
    color: PRINT_COLOR,
    roughness: 0.94,
    metalness: 0.0,
    // A resin print has no transparency, not even where the glass was.
    transparent: false,
    opacity: 1,
  });

  let finish: CarFinish = 'paint';

  const setFinish = (next: CarFinish): void => {
    if (next === finish) return;
    finish = next;

    if (next === 'print') {
      for (const mesh of meshes) mesh.material = printMaterial;
      return;
    }

    // Leaving print: a part with a material override goes back to ITS material,
    // not to the asset's, or an agent's "make the hood carbon fibre" would be
    // silently undone by toggling the finish.
    for (const assembly of assemblies.values()) {
      for (const mesh of assembly.meshes) {
        if (assembly.editMaterial) mesh.material = assembly.editMaterial;
        else {
          const original = originalMaterials.get(mesh);
          if (original) mesh.material = original;
        }
      }
    }
  };

  /* --- motion --------------------------------------------------------- */

  const explodeSpan = maxDim * 0.55;
  let explodeT = 0;

  const applyExplode = (): void => {
    for (const assembly of assemblies.values()) {
      assembly.pivot.position
        .copy(assembly.basePosition)
        .addScaledVector(assembly.explodeDir, explodeSpan * explodeT);
    }
  };

  const setExplode = (t: number): void => {
    explodeT = Math.max(0, Math.min(1, t));
    applyExplode();
  };

  const swing = (assembly: Assembly | undefined, t: number): void => {
    if (!assembly || !assembly.hinge) return;
    const clamped = Math.max(0, Math.min(1, t));
    const angle = assembly.hinge.maxAngle * clamped;
    const axis = assembly.hinge.axis;
    if (axis === 'y') assembly.pivot.rotation.y = angle;
    else if (axis === 'x') assembly.pivot.rotation.x = angle;
    else assembly.pivot.rotation.z = angle;
  };

  const setDoor = (side: 'left' | 'right', t: number): void => {
    swing(assemblies.get(side === 'left' ? 'doorLeft' : 'doorRight'), t);
  };

  const setHood = (t: number): void => {
    swing(assemblies.get('hood'), t);
  };

  const setHidden = (ids: CarPartId[]): void => {
    const hidden = new Set(ids);
    for (const assembly of assemblies.values()) {
      assembly.pivot.visible = !hidden.has(assembly.id);
    }
  };

  const presentParts = (): CarPartId[] =>
    CAR_PART_IDS.filter((id) => assemblies.has(id));

  const listNodes = (): CarNodeInfo[] =>
    Array.from(nodes.values())
      .map((n) => ({
        id: n.id,
        label: n.label,
        assembly: n.assembly,
        triangles: n.triangles,
      }))
      .sort((a, b) =>
        a.assembly === b.assembly
          ? a.label.localeCompare(b.label)
          : CAR_PART_IDS.indexOf(a.assembly) - CAR_PART_IDS.indexOf(b.assembly),
      );

  /** Walk up from a raycast hit to the mesh the rig knows about. */
  const identify = (
    object: THREE.Object3D,
  ): { node: string; assembly: CarPartId } | null => {
    let cursor: THREE.Object3D | null = object;
    while (cursor) {
      const asMesh = cursor as THREE.Mesh;
      const nodeId = meshToNode.get(asMesh);
      if (nodeId) {
        const node = nodes.get(nodeId);
        if (node) return { node: nodeId, assembly: node.assembly };
      }
      cursor = cursor.parent;
    }
    return null;
  };

  const pivotFor = (
    level: 'assembly' | 'node',
    id: string,
  ): THREE.Object3D | null => {
    if (level === 'assembly') return assemblies.get(id as CarPartId)?.pivot ?? null;
    return nodes.get(id)?.pivot ?? null;
  };

  const setNodeTransform = (id: string, next: NodeTransform): void => {
    const node = nodes.get(id);
    if (!node) return;
    node.pivot.position.set(
      node.basePosition.x + next.x,
      node.basePosition.y + next.y,
      node.basePosition.z + next.z,
    );
    node.pivot.rotation.set(
      THREE.MathUtils.degToRad(next.rotX),
      THREE.MathUtils.degToRad(next.rotY),
      THREE.MathUtils.degToRad(next.rotZ),
    );
    node.pivot.scale.setScalar(next.scale);
  };

  const readNodeTransform = (id: string): NodeTransform | null => {
    const node = nodes.get(id);
    if (!node) return null;
    const p = node.pivot.position;
    const r = node.pivot.rotation;
    return {
      x: p.x - node.basePosition.x,
      y: p.y - node.basePosition.y,
      z: p.z - node.basePosition.z,
      rotX: THREE.MathUtils.radToDeg(r.x),
      rotY: THREE.MathUtils.radToDeg(r.y),
      rotZ: THREE.MathUtils.radToDeg(r.z),
      scale: node.pivot.scale.x,
    };
  };

  const setNodeHidden = (ids: string[]): void => {
    const hidden = new Set(ids);
    for (const node of nodes.values()) {
      node.pivot.visible = !hidden.has(node.id);
    }
  };

  const measurePart = (id: CarPartId): PartMeasurement | null => {
    const assembly = assemblies.get(id);
    if (!assembly) return null;
    if (!assembly.measurement) {
      assembly.measurement = measureMeshes(assembly.meshes);
    }
    return assembly.measurement;
  };

  const setPartEdit = (id: CarPartId, edit: PartEdit): void => {
    const assembly = assemblies.get(id);
    if (!assembly) return;

    // Deform about the part's ORIGINAL centre, converted to wherever the pivot
    // currently is. Never re-measure the live box here: see restCentreLocal.
    assembly.pivot.updateMatrixWorld(true);
    const pivotPoint = assembly.pivot.localToWorld(
      assembly.restCentreLocal.clone(),
    );

    applyEditToMeshes(assembly.meshes, edit, pivotPoint);
    // The geometry just moved, so any cached measurement is stale.
    assembly.measurement = null;

    // Material: null restores whatever the asset shipped, unless the whole car
    // is currently in print finish, which overrides everything anyway.
    if (assembly.editMaterial) {
      assembly.editMaterial.dispose();
      assembly.editMaterial = null;
    }

    if (edit.material) {
      const material = buildPartMaterial(edit.material as PartMaterialId);
      assembly.editMaterial = material;
      if (finish !== 'print') {
        for (const mesh of assembly.meshes) mesh.material = material;
      }
    } else if (finish !== 'print') {
      for (const mesh of assembly.meshes) {
        const original = originalMaterials.get(mesh);
        if (original) mesh.material = original;
      }
    }
  };

  const dispose = (): void => {
    nodes.clear();
    meshToNode.clear();
    for (const assembly of assemblies.values()) {
      assembly.editMaterial?.dispose();
      assembly.meshes.length = 0;
    }
    printMaterial.dispose();
    originalMaterials.clear();
    assemblies.clear();
    buckets.clear();
    meshes.length = 0;
  };

  return {
    root,
    listNodes,
    identify,
    pivotFor,
    setNodeTransform,
    setNodeHidden,
    readNodeTransform,
    measurePart,
    setPartEdit,
    setFinish,
    setExplode,
    setDoor,
    setHood,
    setHidden,
    presentParts,
    dispose,
  };
}
