/**
 * Wired Future — sorting ANY car model into assemblies.
 *
 * The concept car's parts follow one artist's naming. A model downloaded from
 * elsewhere uses its own: "Door_FL_Handle", "tyre.003", "Engine/Piston_2",
 * "Object_57". This sorts meshes by the words in their name AND their
 * ancestors' names (exporters often put the meaning on a parent group), and
 * falls back to position where names are silent: which wheel a tyre is comes
 * from where it sits, and a bolt belongs to whatever part it sits inside.
 *
 * Pure apart from reading world matrices; no store, no React.
 */

import * as THREE from 'three';

import type { CarPartId } from '@/store/use-wired';

/** Words that place a part. Checked in this order: earlier wins. */
const RULES: Array<{ id: CarPartId | 'wheel' | 'door' | 'fastener'; words: RegExp }> = [
  { id: 'fastener', words: /\b(bolt|nut|screw|washer|rivet|lug|stud|fastener)s?\b/ },
  { id: 'wheel', words: /\b(wheel|tire|tyre|rim|hub|brake|caliper|rotor|disc|disk)s?\b/ },
  { id: 'door', words: /\b(door|handle|mirror)s?\b/ },
  { id: 'hood', words: /\b(hood|bonnet)\b/ },
  { id: 'roof', words: /\b(roof|sunroof)\b/ },
  { id: 'interior', words: /\b(interior|seat|steering|dash\w*|pedal|console|gear ?(stick|lever|shift)|belt ?buckle|carpet|mat)s?\b/ },
  {
    id: 'engine',
    words:
      /\b(engine|motor|piston|crank\w*|cylinder|valve|camshaft|cam|belt|pulley|radiator|battery|alternator|intake|exhaust|manifold|turbo\w*|filter|gearbox|transmission|axle|block|head ?cover|spark|injector|fan|coolant|reservoir|muffler|driveshaft)s?\b/,
  },
  { id: 'lights', words: /\b(light|lamp|headlight|taillight|tail ?light|indicator|blinker|signal|led|fog ?lamp)s?\b/ },
  { id: 'glass', words: /\b(glass|window|windshield|windscreen|rear ?window)s?\b/ },
];


const LEFT = /\b(left|lhs|l|fl|rl|lf|lr)\b/;
const RIGHT = /\b(right|rhs|r|fr|rr|rf)\b/;

/** Every name from the mesh up to the root, lower-cased, words split out. */
function namePath(mesh: THREE.Object3D): string {
  const parts: string[] = [];
  let cursor: THREE.Object3D | null = mesh;
  while (cursor) {
    if (cursor.name) parts.push(cursor.name);
    const material = (cursor as THREE.Mesh).material;
    if (cursor === mesh && material && !Array.isArray(material) && material.name) {
      parts.push(material.name);
    }
    cursor = cursor.parent;
  }
  return parts
    .join(' / ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_.\-]+/g, ' ')
    .toLowerCase();
}

export interface CarFrame {
  /** Box and centre of the whole car, in world space. */
  box: THREE.Box3;
  centre: THREE.Vector3;
  /** Unit vector pointing out of the car's nose. */
  forward: THREE.Vector3;
  /** Unit vector pointing to the driver's left. */
  left: THREE.Vector3;
}

/**
 * Work out which way the car faces. The longer horizontal axis is the length;
 * the nose is whichever end the hood, headlights or grille are nearer to. If
 * the names say nothing, +Z.
 */
export function carFrame(meshes: THREE.Mesh[], root: THREE.Object3D): CarFrame {
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root);
  const centre = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const alongZ = size.z >= size.x;
  const axis = alongZ ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);

  let frontScore = 0;
  const tmp = new THREE.Box3();
  const c = new THREE.Vector3();
  for (const mesh of meshes) {
    const path = namePath(mesh);
    const front = /\b(hood|bonnet|headlight|head ?lamp|grille|grill|front ?bumper)\b/.test(path);
    const back = /\b(trunk|boot|tailgate|taillight|tail ?lamp|rear ?bumper|exhaust)\b/.test(path);
    if (!front && !back) continue;
    tmp.setFromObject(mesh).getCenter(c);
    const along = c.sub(centre).dot(axis);
    frontScore += front ? along : -along;
  }
  const forward = frontScore < 0 ? axis.clone().negate() : axis.clone();
  // Right-handed, Y up: left = up x forward.
  const left = new THREE.Vector3(0, 1, 0).cross(forward).normalize();
  return { box, centre, forward, left };
}

/**
 * Sort meshes into assemblies. `known` gives the concept car's own answer
 * when there is one; anything it leaves as plain bodywork is sorted here.
 */
export function classifyMeshes(
  meshes: THREE.Mesh[],
  frame: CarFrame,
  known: (mesh: THREE.Mesh) => CarPartId | null,
): Map<THREE.Mesh, CarPartId> {
  const out = new Map<THREE.Mesh, CarPartId>();
  const fasteners: THREE.Mesh[] = [];
  const box = new THREE.Box3();
  const centre = new THREE.Vector3();

  const sideOf = (path: string, at: THREE.Vector3): 'left' | 'right' => {
    const l = LEFT.test(path);
    const r = RIGHT.test(path);
    if (l !== r) return l ? 'left' : 'right';
    return at.clone().sub(frame.centre).dot(frame.left) >= 0 ? 'left' : 'right';
  };

  for (const mesh of meshes) {
    const fromConcept = known(mesh);
    if (fromConcept) {
      out.set(mesh, fromConcept);
      continue;
    }
    const path = namePath(mesh);
    box.setFromObject(mesh).getCenter(centre);
    const rule = RULES.find((r) => r.words.test(path));
    if (!rule) {
      out.set(mesh, 'body');
      continue;
    }
    if (rule.id === 'fastener') {
      fasteners.push(mesh);
      continue;
    }
    if (rule.id === 'wheel') {
      const front = centre.clone().sub(frame.centre).dot(frame.forward) >= 0;
      const left = sideOf(path, centre) === 'left';
      out.set(mesh, front ? (left ? 'wheelFL' : 'wheelFR') : left ? 'wheelRL' : 'wheelRR');
      continue;
    }
    if (rule.id === 'door') {
      out.set(mesh, sideOf(path, centre) === 'left' ? 'doorLeft' : 'doorRight');
      continue;
    }
    out.set(mesh, rule.id);
  }

  // A bolt belongs to the smallest assembly it sits inside: a lug nut to its
  // wheel, a head bolt to the engine. Bolts in open bodywork stay bodywork.
  if (fasteners.length) {
    const boxes = new Map<CarPartId, THREE.Box3>();
    for (const [mesh, id] of out) {
      if (id === 'body') continue;
      const b = boxes.get(id) ?? new THREE.Box3();
      b.expandByObject(mesh);
      boxes.set(id, b);
    }
    for (const mesh of fasteners) {
      box.setFromObject(mesh).getCenter(centre);
      let best: CarPartId = 'body';
      let bestVolume = Infinity;
      for (const [id, b] of boxes) {
        const grown = b.clone().expandByScalar(b.getSize(new THREE.Vector3()).length() * 0.05);
        if (!grown.containsPoint(centre)) continue;
        const s = b.getSize(new THREE.Vector3());
        const volume = s.x * s.y * s.z;
        if (volume < bestVolume) {
          bestVolume = volume;
          best = id;
        }
      }
      out.set(mesh, best);
    }
  }
  return out;
}
