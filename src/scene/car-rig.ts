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
 * Motion is animated rather than applied: setExplode / setDoor / setHood set a
 * TARGET, and update(dt) springs the car towards it, so a door an agent opens
 * swings open instead of teleporting. Hiding a part pops it off and showing it
 * pops it back. settle() jumps everything to its target, for snapshots and for
 * visitors who ask for reduced motion.
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
import { createHologram } from './hologram';
import { carFrame, classifyMeshes } from './classify-generic';

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

export type CarFinish = 'hologram' | 'paint' | 'print';

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
  /**
   * Unit direction this part slides along when dragged out, in the assembly's
   * local space: away from the car's centre, biased upward so parts lift clear
   * rather than sinking into the ground.
   */
  outward: THREE.Vector3;
  /** Rest position of the node pivot, before any user transform. */
  basePosition: THREE.Vector3;
  triangles: number;
  /**
   * Sits between the pivot and the mesh and exists only for the pop animation.
   * Scaling the pivot would fight the user's own scale; this group is at the
   * pivot origin (the part's centre), so it shrinks the part about its centre.
   */
  pop: THREE.Group;
  /** 1 fully shown, 0 fully hidden. Only differs from the target mid-pop. */
  popValue: number;
  popFrom: number;
  popTo: number;
  /** Seconds into the current pop; -1 when at rest. */
  popClock: number;
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
  /** Gizmo placement, layered on top of explode (position) and hinge (rotation). */
  userOffset: THREE.Vector3;
  userQuat: THREE.Quaternion;
  userScale: number;
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
  /** Direction this part slides when dragged out, in world space. */
  nodeOutwardWorld: (id: string) => THREE.Vector3 | null;
  /**
   * The same direction in the frame node offsets live in (the assembly's).
   * A drag must write THIS into the offset: the world vector is only right
   * while nothing above the part is rotated.
   */
  nodeOutwardLocal: (id: string) => THREE.Vector3 | null;
  /** Whether this assembly has a hinge, i.e. whether a click can open it. */
  hasHinge: (assembly: CarPartId) => boolean;
  /** Where the hinge is right now, mid-swing included: 0 shut, 1 open. */
  hingeValue: (assembly: CarPartId) => number;
  /**
   * World position `local` (a point in the assembly pivot's frame) WOULD have
   * if the hinge stood at `t`, everything else as it is now. The caller must
   * have updated the pivot's parent world matrix. False without a hinge.
   */
  hingeWorldPoint: (
    assembly: CarPartId,
    t: number,
    local: THREE.Vector3,
    out: THREE.Vector3,
  ) => boolean;
  /** Real geometry measurements for one assembly, or null if absent. */
  measurePart: (id: CarPartId) => PartMeasurement | null;
  /** Reshape and re-material one assembly. Absolute, not cumulative. */
  setPartEdit: (id: CarPartId, edit: PartEdit) => void;
  setFinish: (finish: CarFinish) => void;
  /** Colour of the hologram finish: the palette's primary. */
  setHologramColor: (hex: string) => void;
  setExplode: (t: number) => void;
  setDoor: (side: 'left' | 'right', t: number) => void;
  setHood: (t: number) => void;
  setHidden: (ids: CarPartId[]) => void;
  /** Place a whole assembly, on top of explode and the hinge. */
  setAssemblyTransform: (id: CarPartId, next: NodeTransform) => void;
  /** The user's part of an assembly's live placement, for gizmo -> store. */
  readAssemblyTransform: (id: CarPartId) => NodeTransform | null;
  /** Meshes to highlight for a selection or hover. */
  meshesFor: (level: 'assembly' | 'node', id: string) => THREE.Mesh[];
  /** Every mesh in the car, e.g. to build picking acceleration structures. */
  allMeshes: () => THREE.Mesh[];
  /** World-space bounds of an assembly or node, written into `target`. */
  boundsFor: (level: 'assembly' | 'node', id: string, target: THREE.Box3) => boolean;
  /** Advance the springs and pops. `instant` jumps straight to the targets. */
  update: (dt: number, instant: boolean) => void;
  /** Jump every animation to its target now. */
  settle: () => void;
  /** Which assemblies actually exist in the loaded asset. */
  presentParts: () => CarPartId[];
  dispose: () => void;
}

/* ------------------------------------------------------------------ */
/* Motion                                                              */
/* ------------------------------------------------------------------ */

/**
 * One animated scalar, driven by a critically damped spring. Critical damping
 * starts from rest with zero velocity (no lurch) and never overshoots, which
 * is what a door on a hinge should do.
 */
interface Channel {
  value: number;
  target: number;
  velocity: number;
  omega: number;
}

/**
 * Stiffness is chosen per change. A big jump (an agent opening a door, a
 * click on the slider track) gets a soft spring and glides; a stream of small
 * steps (dragging the slider, a hand pulling the car apart) gets a stiff one,
 * so the part tracks the input instead of trailing a rubber band behind it.
 */
const JUMP_THRESHOLD = 0.12;
const OMEGA_STIFF = 18;

const makeChannel = (soft: number): Channel & { soft: number } => ({
  value: 0,
  target: 0,
  velocity: 0,
  omega: soft,
  soft,
});

function aimChannel(c: Channel & { soft: number }, target: number): void {
  const next = Math.max(0, Math.min(1, target));
  if (next === c.target) return;
  c.omega = Math.abs(next - c.value) > JUMP_THRESHOLD ? c.soft : OMEGA_STIFF;
  c.target = next;
}

/** Closed-form critically damped step. Returns true while still moving. */
function stepChannel(c: Channel, dt: number): boolean {
  if (c.value === c.target && c.velocity === 0) return false;
  const x = c.value - c.target;
  const w = c.omega;
  const decay = Math.exp(-w * dt);
  const drive = (c.velocity + w * x) * dt;
  const nx = (x + drive) * decay;
  const nv = (c.velocity - w * drive) * decay;
  if (Math.abs(nx) < 1e-4 && Math.abs(nv) < 1e-3) {
    c.value = c.target;
    c.velocity = 0;
  } else {
    c.value = c.target + nx;
    c.velocity = nv;
  }
  return true;
}

function settleChannel(c: Channel): boolean {
  if (c.value === c.target && c.velocity === 0) return false;
  c.value = c.target;
  c.velocity = 0;
  return true;
}

/** Seconds a part takes to pop off, and to pop back on. */
const POP_OUT = 0.22;
const POP_IN = 0.42;
/** How far a part lifts away as it pops off, in car units. */
const POP_TRAVEL = 0.35;

const easeInCubic = (t: number): number => t * t * t;
/** Overshoots slightly and settles: the part lands rather than appears. */
const easeOutBack = (t: number): number => {
  const c1 = 1.4;
  const c3 = c1 + 1;
  const u = t - 1;
  return 1 + c3 * u * u * u + c1 * u * u;
};

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

  // The concept car's own naming first; anything it calls plain bodywork is
  // sorted by the generic rules, which is all a downloaded model gets.
  const frame = carFrame(meshes, model);
  const sorted = classifyMeshes(meshes, frame, (mesh) => {
    const id = classify(mesh);
    return id === 'body' ? null : id;
  });
  const fwd = frame.forward;

  const buckets = new Map<CarPartId, THREE.Mesh[]>();
  for (const mesh of meshes) {
    const id = sorted.get(mesh) ?? 'body';
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

    // Which end is the nose comes from the frame, not from an assumption:
    // a downloaded model can face any way along its length.
    const noseAtMax = (forwardIsZ ? fwd.z : fwd.x) >= 0;

    if (id === 'doorLeft' || id === 'doorRight') {
      // Hinge on the FRONT vertical edge of the door.
      if (forwardIsZ) anchor.z = noseAtMax ? box.max.z : box.min.z;
      else anchor.x = noseAtMax ? box.max.x : box.min.x;
      // Swing the rear of the door OUT, away from the car. Turning about Y by
      // a small angle moves a point p by (p.z, 0, -p.x); the rear edge sits at
      // p = -forward, so the sign that pushes it along `out` is the sign of
      // -forward.z * out.x + forward.x * out.z.
      const out = forwardIsZ
        ? new THREE.Vector3(Math.sign(centre.x - fullCentre.x) || 1, 0, 0)
        : new THREE.Vector3(0, 0, Math.sign(centre.z - fullCentre.z) || 1);
      const sign = Math.sign(-fwd.z * out.x + fwd.x * out.z) || 1;
      hinge = { axis: 'y', maxAngle: THREE.MathUtils.degToRad(62) * sign };
    } else if (id === 'hood') {
      // Hinge on the REAR edge, so it lifts at the front like a real bonnet.
      if (forwardIsZ) anchor.z = noseAtMax ? box.min.z : box.max.z;
      else anchor.x = noseAtMax ? box.min.x : box.max.x;
      // Pivot about the lateral axis, in the direction that RAISES the nose:
      // about X a front point rises with -forward.z, about Z with +forward.x.
      const sign = forwardIsZ ? Math.sign(-fwd.z) || -1 : Math.sign(fwd.x) || 1;
      hinge = { axis: forwardIsZ ? 'x' : 'z', maxAngle: THREE.MathUtils.degToRad(52) * sign };
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

      const pop = new THREE.Group();
      pop.name = 'pop:' + nodeId;
      nodePivot.add(pop);
      pop.attach(mesh);

      assemblySeq.set(id, (assemblySeq.get(id) ?? 0) + 1);

      const geometry = mesh.geometry;
      const indexed = geometry.getIndex();
      const triangles = Math.round(
        (indexed ? indexed.count : geometry.getAttribute('position')?.count ?? 0) / 3,
      );

      // Outward is computed from the car's centre, then expressed in the
      // assembly's local frame so it stays correct once the door swings.
      const worldOut = meshCentre.clone().sub(fullCentre);
      if (worldOut.lengthSq() < 1e-6) worldOut.set(0, 1, 0);
      worldOut.normalize();
      worldOut.y += 0.3;
      worldOut.normalize();
      const localOut = worldOut
        .clone()
        .applyQuaternion(pivot.getWorldQuaternion(new THREE.Quaternion()).invert())
        .normalize();

      const node: CarNode = {
        id: nodeId,
        outward: localOut,
        label: humanise(
          mesh.name,
          CAR_PART_LABELS[id] + ' part ' + (assemblySeq.get(id) ?? 1),
        ),
        assembly: id,
        pivot: nodePivot,
        mesh,
        basePosition: localCentre.clone(),
        triangles,
        pop,
        popValue: 1,
        popFrom: 1,
        popTo: 1,
        popClock: -1,
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
      userOffset: new THREE.Vector3(),
      userQuat: new THREE.Quaternion(),
      userScale: 1,
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

  /* --- hologram ------------------------------------------------------- */

  const holo = createHologram();
  let holoClock = 0;
  /** Meshes still waiting for their edge lines, built a few per frame. */
  const edgeQueue: THREE.Mesh[] = [];
  /** Per-frame budget for building edge lines, in ms. */
  const EDGE_BUDGET_MS = 4;

  const showEdges = (visible: boolean): void => {
    for (const mesh of meshes) {
      for (const child of mesh.children) {
        if (child.name === 'wf-holo-edges') child.visible = visible;
      }
    }
  };

  const queueEdges = (list: THREE.Mesh[]): void => {
    for (const mesh of list) if (!edgeQueue.includes(mesh)) edgeQueue.push(mesh);
  };

  const buildSomeEdges = (): void => {
    if (!edgeQueue.length || finish !== 'hologram') return;
    const start = performance.now();
    // Always at least one, or a permanently busy frame would never finish.
    do {
      const mesh = edgeQueue.shift()!;
      const lines = holo.edgesFor(mesh);
      if (lines && lines.parent !== mesh) mesh.add(lines);
      if (lines) lines.visible = true;
    } while (edgeQueue.length && performance.now() - start < EDGE_BUDGET_MS);
  };

  const setFinish = (next: CarFinish): void => {
    if (next === finish) return;
    finish = next;

    if (next === 'hologram') {
      for (const mesh of meshes) mesh.material = holo.surface;
      showEdges(true);
      queueEdges(meshes);
      return;
    }
    showEdges(false);

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

  // Soft stiffness per channel: exploding moves the most, so it glides longest.
  const explode = makeChannel(6.5);
  const hingeChannels = new Map<CarPartId, Channel & { soft: number }>([
    ['doorLeft', makeChannel(7.5)],
    ['doorRight', makeChannel(7.5)],
    ['hood', makeChannel(7.5)],
  ]);

  const AXES = {
    x: new THREE.Vector3(1, 0, 0),
    y: new THREE.Vector3(0, 1, 0),
    z: new THREE.Vector3(0, 0, 1),
  } as const;
  const scratchHinge = new THREE.Quaternion();
  const scratchUser = new THREE.Quaternion();
  const scratchEuler = new THREE.Euler();
  const scratchOffset = new THREE.Vector3();

  const hingeQuatAt = (
    assembly: Assembly,
    t: number,
    out: THREE.Quaternion,
  ): THREE.Quaternion => {
    if (!assembly.hinge) return out.identity();
    const angle = assembly.hinge.maxAngle * Math.max(0, Math.min(1, t));
    return out.setFromAxisAngle(AXES[assembly.hinge.axis], angle);
  };

  const hingeQuat = (assembly: Assembly, out: THREE.Quaternion): THREE.Quaternion =>
    hingeQuatAt(assembly, hingeChannels.get(assembly.id)?.value ?? 0, out);

  const scratchSolveQuat = new THREE.Quaternion();
  const scratchSolveMat = new THREE.Matrix4();
  const scratchSolveScale = new THREE.Vector3();

  const hingeValue = (id: CarPartId): number => hingeChannels.get(id)?.value ?? 0;

  const hingeWorldPoint = (
    id: CarPartId,
    t: number,
    local: THREE.Vector3,
    out: THREE.Vector3,
  ): boolean => {
    const assembly = assemblies.get(id);
    const parent = assembly?.pivot.parent;
    if (!assembly || !assembly.hinge || !parent) return false;
    // Exactly compose()'s pose, with the hinge at t instead of where it is.
    scratchSolveQuat.copy(assembly.userQuat).multiply(hingeQuatAt(assembly, t, scratchHinge));
    scratchSolveScale.setScalar(assembly.userScale);
    scratchSolveMat.compose(assembly.pivot.position, scratchSolveQuat, scratchSolveScale);
    out.copy(local).applyMatrix4(scratchSolveMat).applyMatrix4(parent.matrixWorld);
    return true;
  };

  /**
   * The ONE place an assembly pivot is written: rest pose, plus explode, plus
   * the user's placement, with the hinge swing applied inside the user's
   * rotation so a door dragged somewhere still opens about its own hinge.
   */
  const compose = (assembly: Assembly): void => {
    const p = assembly.pivot;
    p.position
      .copy(assembly.basePosition)
      .addScaledVector(assembly.explodeDir, explodeSpan * explode.value)
      .add(assembly.userOffset);
    p.quaternion.copy(assembly.userQuat).multiply(hingeQuat(assembly, scratchHinge));
    p.scale.setScalar(assembly.userScale);
  };

  const composeAll = (): void => {
    for (const assembly of assemblies.values()) compose(assembly);
  };

  const setExplode = (t: number): void => {
    aimChannel(explode, t);
  };

  const setDoor = (side: 'left' | 'right', t: number): void => {
    const channel = hingeChannels.get(side === 'left' ? 'doorLeft' : 'doorRight');
    if (channel) aimChannel(channel, t);
  };

  const setHood = (t: number): void => {
    const channel = hingeChannels.get('hood');
    if (channel) aimChannel(channel, t);
  };

  /* --- pops ------------------------------------------------------------ */

  const hiddenAssemblies = new Set<CarPartId>();
  const hiddenNodeIds = new Set<string>();
  const popping = new Set<CarNode>();
  const scratchPopQuat = new THREE.Quaternion();

  const applyPop = (node: CarNode): void => {
    const v = node.popValue;
    node.pop.scale.setScalar(Math.max(0.0001, v));
    // Lift along the part's outward axis as it shrinks, expressed in the
    // pivot's frame so a part the user has rotated still lifts AWAY from the
    // car rather than along its own spun axis.
    scratchPopQuat.copy(node.pivot.quaternion).invert();
    node.pop.position
      .copy(node.outward)
      .applyQuaternion(scratchPopQuat)
      .multiplyScalar((POP_TRAVEL * (1 - Math.min(1, v))) / (node.pivot.scale.x || 1));
  };

  /** Rest state: full size, no offset, and simply invisible when hidden. */
  const restPop = (node: CarNode): void => {
    node.popClock = -1;
    node.popValue = node.popTo;
    node.pop.scale.setScalar(1);
    node.pop.position.set(0, 0, 0);
    // At rest a hidden part keeps its true size, so measuring it (an agent
    // asking what the wheel it just removed weighs) is unaffected.
    node.pivot.visible = node.popTo > 0;
    popping.delete(node);
  };

  const aimPop = (node: CarNode, show: boolean): void => {
    const to = show ? 1 : 0;
    if (node.popTo === to) return;
    node.popFrom = node.popClock >= 0 ? node.popValue : show ? 0 : 1;
    node.popTo = to;
    node.popClock = 0;
    node.pivot.visible = true;
    popping.add(node);
    applyPop(node);
  };

  const refreshPops = (): void => {
    for (const node of nodes.values()) {
      aimPop(node, !hiddenNodeIds.has(node.id) && !hiddenAssemblies.has(node.assembly));
    }
  };

  const stepPops = (dt: number): void => {
    for (const node of popping) {
      const duration = node.popTo > node.popFrom ? POP_IN : POP_OUT;
      node.popClock += dt;
      const t = Math.min(1, node.popClock / duration);
      const eased = node.popTo > node.popFrom ? easeOutBack(t) : easeInCubic(t);
      node.popValue = node.popFrom + (node.popTo - node.popFrom) * eased;
      if (t >= 1) restPop(node);
      else applyPop(node);
    }
  };

  const setHidden = (ids: CarPartId[]): void => {
    hiddenAssemblies.clear();
    for (const id of ids) hiddenAssemblies.add(id);
    refreshPops();
  };

  /* --- user placement of whole assemblies ------------------------------- */

  const setAssemblyTransform = (id: CarPartId, next: NodeTransform): void => {
    const assembly = assemblies.get(id);
    if (!assembly) return;
    assembly.userOffset.set(next.x, next.y, next.z);
    scratchEuler.set(
      THREE.MathUtils.degToRad(next.rotX),
      THREE.MathUtils.degToRad(next.rotY),
      THREE.MathUtils.degToRad(next.rotZ),
      'XYZ',
    );
    assembly.userQuat.setFromEuler(scratchEuler);
    if (assembly.userScale !== next.scale) assembly.measurement = null;
    assembly.userScale = next.scale;
    compose(assembly);
  };

  const readAssemblyTransform = (id: CarPartId): NodeTransform | null => {
    const assembly = assemblies.get(id);
    if (!assembly) return null;
    const p = assembly.pivot;
    // Undo the layers the rig owns, leaving only what the user put there.
    scratchOffset
      .copy(p.position)
      .sub(assembly.basePosition)
      .addScaledVector(assembly.explodeDir, -explodeSpan * explode.value);
    hingeQuat(assembly, scratchHinge).invert();
    scratchUser.copy(p.quaternion).multiply(scratchHinge);
    scratchEuler.setFromQuaternion(scratchUser, 'XYZ');
    return {
      x: scratchOffset.x,
      y: scratchOffset.y,
      z: scratchOffset.z,
      rotX: THREE.MathUtils.radToDeg(scratchEuler.x),
      rotY: THREE.MathUtils.radToDeg(scratchEuler.y),
      rotZ: THREE.MathUtils.radToDeg(scratchEuler.z),
      scale: p.scale.x,
    };
  };

  /* --- frame ----------------------------------------------------------- */

  const moved = new Set<Assembly>();

  const update = (dt: number, instant: boolean): void => {
    const step = Math.min(0.05, Math.max(0, dt));
    // The hologram's shimmer and its edge lines are not part of the motion
    // that reduced-motion turns off: edges must still be built.
    if (finish === 'hologram') {
      holoClock += instant ? 0 : step;
      holo.update(holoClock);
      buildSomeEdges();
    }
    if (instant) {
      settle();
      return;
    }
    const explodeMoving = stepChannel(explode, step);
    moved.clear();
    for (const [id, channel] of hingeChannels) {
      if (stepChannel(channel, step)) {
        const assembly = assemblies.get(id);
        if (assembly) moved.add(assembly);
      }
    }
    if (explodeMoving) composeAll();
    else for (const assembly of moved) compose(assembly);
    if (popping.size) stepPops(step);
  };

  const settle = (): void => {
    let dirty = settleChannel(explode);
    for (const channel of hingeChannels.values()) {
      if (settleChannel(channel)) dirty = true;
    }
    if (dirty) composeAll();
    for (const node of Array.from(popping)) restPop(node);
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
    if (node.pivot.scale.x !== next.scale) {
      const owner = assemblies.get(node.assembly);
      if (owner) owner.measurement = null;
    }
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

  // Scratch objects: this runs on every pointermove of a part drag, and two
  // fresh allocations per frame is churn the GC does not need.
  const scratchOutward = new THREE.Vector3();
  const scratchQuat = new THREE.Quaternion();

  const nodeOutwardWorld = (id: string): THREE.Vector3 | null => {
    const node = nodes.get(id);
    if (!node || !node.pivot.parent) return null;
    node.pivot.parent.updateMatrixWorld(true);
    node.pivot.parent.getWorldQuaternion(scratchQuat);
    return scratchOutward
      .copy(node.outward)
      .applyQuaternion(scratchQuat)
      .normalize();
  };

  const nodeOutwardLocal = (id: string): THREE.Vector3 | null => {
    const node = nodes.get(id);
    return node ? node.outward.clone() : null;
  };

  const hasHinge = (assembly: CarPartId): boolean =>
    Boolean(assemblies.get(assembly)?.hinge);

  const setNodeHidden = (ids: string[]): void => {
    hiddenNodeIds.clear();
    for (const id of ids) hiddenNodeIds.add(id);
    refreshPops();
  };

  const meshesFor = (level: 'assembly' | 'node', id: string): THREE.Mesh[] => {
    if (level === 'assembly') return assemblies.get(id as CarPartId)?.meshes ?? [];
    const node = nodes.get(id);
    return node ? [node.mesh] : [];
  };

  const allMeshes = (): THREE.Mesh[] => meshes.slice();

  const boundsFor = (
    level: 'assembly' | 'node',
    id: string,
    target: THREE.Box3,
  ): boolean => {
    const pivot = pivotFor(level, id);
    if (!pivot) return false;
    pivot.updateMatrixWorld(true);
    target.setFromObject(pivot);
    return !target.isEmpty();
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
    // The edge lines were traced from the old shape.
    for (const mesh of assembly.meshes) holo.dropEdges(mesh);
    if (finish === 'hologram') queueEdges(assembly.meshes);
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
      if (finish === 'paint') {
        for (const mesh of assembly.meshes) mesh.material = material;
      }
    } else if (finish === 'paint') {
      for (const mesh of assembly.meshes) {
        const original = originalMaterials.get(mesh);
        if (original) mesh.material = original;
      }
    }
  };

  const dispose = (): void => {
    popping.clear();
    nodes.clear();
    meshToNode.clear();
    for (const assembly of assemblies.values()) {
      assembly.editMaterial?.dispose();
      assembly.meshes.length = 0;
    }
    printMaterial.dispose();
    holo.dispose();
    edgeQueue.length = 0;
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
    nodeOutwardWorld,
    nodeOutwardLocal,
    hasHinge,
    hingeValue,
    hingeWorldPoint,
    measurePart,
    setPartEdit,
    setFinish,
    setHologramColor: (hex: string) => holo.setColor(hex),
    setExplode,
    setDoor,
    setHood,
    setHidden,
    setAssemblyTransform,
    readAssemblyTransform,
    meshesFor,
    allMeshes,
    boundsFor,
    update,
    settle,
    presentParts,
    dispose,
  };
}
