'use client';

import { create } from 'zustand';

/* ------------------------------------------------------------------ */
/* Vocabulary                                                          */
/* ------------------------------------------------------------------ */

export type ModelType = 'car' | 'engine' | 'photo';
/** 'real' is the loaded glTF concept car; 'parametric' is the built-in mesh. */
export type CarVariant = 'real' | 'parametric';
/** 'orbit' flies the camera; the rest arm the transform gizmo on the model. */
export type EditMode = 'orbit' | 'translate' | 'rotate' | 'scale';
/** 'paint' is the asset's own PBR finish; 'print' is matte resin grey. */
export type CarFinish = 'paint' | 'print';

/**
 * Assemblies the concept car can be taken apart into. These ids are the API
 * the UI and the agent tools both address parts by, so they are duplicated
 * (deliberately, as plain data) from scene/car-rig.ts, which must not be
 * imported here - the store has to stay free of three.js.
 */
/** Which granularity a click selects: the whole door, or just its handle. */
export type SelectionLevel = 'assembly' | 'node';

export interface Selection {
  level: SelectionLevel;
  /** A CarPartId for 'assembly', or a node id like "doorLeft:BodyDoorLHandle01". */
  id: string;
  /** Human label, cached so the UI does not need the rig to render it. */
  label: string;
}

/**
 * A free transform on one of the 97 individual meshes, relative to its rest
 * pose. Position is an offset, not an absolute, so a node keeps riding its
 * assembly when the door swings or the car explodes.
 */
export interface NodeTransform {
  x: number;
  y: number;
  z: number;
  rotX: number;
  rotY: number;
  rotZ: number;
  scale: number;
}

export const IDENTITY_NODE_TRANSFORM: NodeTransform = {
  x: 0,
  y: 0,
  z: 0,
  rotX: 0,
  rotY: 0,
  rotZ: 0,
  scale: 1,
};

export const NODE_LIMITS = {
  offset: { min: -12, max: 12 },
  scale: { min: 0.1, max: 6 },
} as const;

/** Engineering materials a part can be re-specified in. */
export type PartMaterialId =
  | 'steel'
  | 'aluminium'
  | 'titanium'
  | 'carbon'
  | 'abs'
  | 'glass'
  | 'rubber';

/**
 * An absolute description of how one part has been reshaped. Absolute, not
 * cumulative: the engine always rebuilds from the pristine glTF geometry, so
 * applying the same edit twice is a no-op rather than a compounding change.
 */
export interface PartEdit {
  scaleX: number;
  scaleY: number;
  scaleZ: number;
  /** Offset along vertex normals, model units. Positive thickens the shell. */
  inflate: number;
  twistDeg: number;
  material: PartMaterialId | null;
}

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
export type CameraPreset = 'orbit' | 'top' | 'close' | 'wide';
export type ScenePresetName = 'neon-noir' | 'solar-flare' | 'deep-void' | 'hologram';
/**
 * Who caused a change. 'hand' is still the human, but webcam gestures are
 * worth separating in the trace: without it a hand drag is indistinguishable
 * from a mouse drag, which is exactly the thing worth seeing.
 */
export type ActionOrigin = 'human' | 'agent' | 'system' | 'hand';

export const MODEL_TYPES: ModelType[] = ['car', 'engine', 'photo'];
export const CAR_VARIANTS: CarVariant[] = ['real', 'parametric'];
export const EDIT_MODES: EditMode[] = ['orbit', 'translate', 'rotate', 'scale'];
export const CAR_FINISHES: CarFinish[] = ['paint', 'print'];
export const PART_MATERIAL_IDS: PartMaterialId[] = [
  'steel',
  'aluminium',
  'titanium',
  'carbon',
  'abs',
  'glass',
  'rubber',
];
export const IDENTITY_EDIT: PartEdit = {
  scaleX: 1,
  scaleY: 1,
  scaleZ: 1,
  inflate: 0,
  twistDeg: 0,
  material: null,
};
export const PART_EDIT_LIMITS = {
  scale: { min: 0.2, max: 3 },
  inflate: { min: -0.12, max: 0.12 },
  twistDeg: { min: -180, max: 180 },
} as const;
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
export const CAMERA_PRESETS: CameraPreset[] = ['orbit', 'top', 'close', 'wide'];
export const SCENE_PRESET_NAMES: ScenePresetName[] = [
  'neon-noir',
  'solar-flare',
  'deep-void',
  'hologram',
];

/* ------------------------------------------------------------------ */
/* The single source of truth                                          */
/* ------------------------------------------------------------------ */

export interface NodeClusterState {
  count: number;
  spread: number;
  floatSpeed: number;
  colorHex: string;
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** Placement of the centre-stage object. Driven by the gizmo AND by tools. */
export interface TransformState {
  position: Vec3;
  /** Euler angles in DEGREES - agents reason about degrees, not radians. */
  rotationDeg: Vec3;
  scale: number;
}

export interface CameraState {
  preset: CameraPreset;
  distance: number;
  height: number;
  autoOrbit: boolean;
}

/** How the concept car is finished, opened and taken apart. */
export interface CarRigState {
  finish: CarFinish;
  /** 0 assembled, 1 fully exploded into a parts diagram. */
  explode: number;
  /** 0 shut, 1 fully open. */
  doorLeft: number;
  doorRight: number;
  hood: number;
  /** Assemblies currently detached from view. */
  hidden: CarPartId[];
  /** Individual meshes detached from view, by node id. */
  hiddenNodes: string[];
  /** Free transforms on individual meshes, by node id. */
  nodeTransforms: Record<string, NodeTransform>;
  /** What the gizmo is currently attached to. */
  selection: Selection | null;
  /** Per-part reshaping. Absent means the part is untouched. */
  edits: Partial<Record<CarPartId, PartEdit>>;
}

export interface WiredState {
  /** Terrain wireframe, point light and model accents. */
  gridColorHex: string;
  /** Secondary highlight used on model trim and the horizon glow. */
  accentColorHex: string;
  modelType: ModelType;
  carVariant: CarVariant;
  carRig: CarRigState;
  editMode: EditMode;
  transform: TransformState;
  /** Speed multiplier for the terrain wave math. */
  waveVelocity: number;
  waveAmplitude: number;
  fogDensity: number;
  camera: CameraState;
  nodes: NodeClusterState;
}

export const DEFAULT_STATE: WiredState = {
  gridColorHex: '#00f0ff',
  accentColorHex: '#ff2bd6',
  modelType: 'car',
  carVariant: 'real',
  carRig: {
    finish: 'paint',
    explode: 0,
    doorLeft: 0,
    doorRight: 0,
    hood: 0,
    hidden: [],
    hiddenNodes: [],
    nodeTransforms: {},
    selection: null,
    edits: {},
  },
  editMode: 'orbit',
  transform: {
    position: { x: 0, y: 0, z: 0 },
    rotationDeg: { x: 0, y: 0, z: 0 },
    scale: 1,
  },
  waveVelocity: 1,
  waveAmplitude: 1,
  fogDensity: 0.035,
  // Auto-orbit off and no floating nodes: the stage should hold still and
  // stay clear so the object being edited is the only thing moving.
  camera: { preset: 'orbit', distance: 16, height: 6, autoOrbit: false },
  nodes: { count: 0, spread: 26, floatSpeed: 1, colorHex: '#8b5cff' },
};

/* ------------------------------------------------------------------ */
/* Bounds — one place, shared by the UI and every agent tool           */
/* ------------------------------------------------------------------ */

export const LIMITS = {
  waveVelocity: { min: 0, max: 5 },
  waveAmplitude: { min: 0, max: 4 },
  fogDensity: { min: 0, max: 0.12 },
  cameraDistance: { min: 6, max: 48 },
  cameraHeight: { min: -6, max: 30 },
  nodeCount: { min: 0, max: 160 },
  nodeSpread: { min: 6, max: 60 },
  nodeFloatSpeed: { min: 0, max: 5 },
  positionX: { min: -24, max: 24 },
  positionY: { min: -3, max: 18 },
  positionZ: { min: -24, max: 24 },
  scale: { min: 0.15, max: 5 },
  pulseIntensity: { min: 0.2, max: 5 },
  pulseDuration: { min: 200, max: 8000 },
} as const;

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

/** Clamp a possibly-missing number, falling back to a default. */
function clampOr(
  value: number | undefined,
  range: { min: number; max: number },
  fallback: number,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return clamp(value, range.min, range.max);
}

/** Clamp one axis, leaving it untouched when the caller omitted it. */
function clampAxis(
  value: number | undefined,
  range: { min: number; max: number },
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return clamp(value, range.min, range.max);
}

/** Normalise any angle into (-180, 180]. */
function wrapDegrees(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  const wrapped = ((((value + 180) % 360) + 360) % 360) - 180;
  return Math.round(wrapped * 100) / 100;
}

/** Accepts "0ff", "#0ff", "00ffcc", "#00ffcc". Returns null when unparseable. */
export function normalizeHex(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const raw = input.trim().replace(/^#/, '');
  if (/^[0-9a-fA-F]{3}$/.test(raw)) {
    const r = raw[0];
    const g = raw[1];
    const b = raw[2];
    return ('#' + r + r + g + g + b + b).toLowerCase();
  }
  if (/^[0-9a-fA-F]{6}$/.test(raw)) return ('#' + raw).toLowerCase();
  return null;
}

/** Coerce an arbitrary patch into a legal, clamped partial state. */
export function sanitizePatch(patch: Partial<WiredState>): Partial<WiredState> {
  const out: Partial<WiredState> = {};

  const grid = normalizeHex(patch.gridColorHex);
  if (grid) out.gridColorHex = grid;

  const accent = normalizeHex(patch.accentColorHex);
  if (accent) out.accentColorHex = accent;

  if (patch.modelType && MODEL_TYPES.includes(patch.modelType)) {
    out.modelType = patch.modelType;
  }

  if (patch.carVariant && CAR_VARIANTS.includes(patch.carVariant)) {
    out.carVariant = patch.carVariant;
  }

  if (patch.editMode && EDIT_MODES.includes(patch.editMode)) {
    out.editMode = patch.editMode;
  }

  if (patch.carRig) {
    const rig: Partial<CarRigState> = {};
    const src = patch.carRig;

    if (src.finish && CAR_FINISHES.includes(src.finish)) rig.finish = src.finish;

    for (const key of ['explode', 'doorLeft', 'doorRight', 'hood'] as const) {
      const value = src[key];
      if (typeof value === 'number' && Number.isFinite(value)) {
        rig[key] = clamp(value, 0, 1);
      }
    }

    if (Array.isArray(src.hidden)) {
      // De-duplicate and drop anything that is not a real assembly id, so a
      // typo from an agent cannot wedge a part into permanent invisibility.
      const seen = new Set<CarPartId>();
      for (const id of src.hidden) {
        if (CAR_PART_IDS.includes(id as CarPartId)) seen.add(id as CarPartId);
      }
      rig.hidden = Array.from(seen);
    }

    if (Array.isArray(src.hiddenNodes)) {
      rig.hiddenNodes = Array.from(
        new Set(src.hiddenNodes.filter((id): id is string => typeof id === 'string')),
      );
    }

    if (src.selection !== undefined) {
      const sel = src.selection;
      rig.selection =
        sel &&
        typeof sel.id === 'string' &&
        (sel.level === 'assembly' || sel.level === 'node')
          ? { level: sel.level, id: sel.id, label: String(sel.label ?? sel.id) }
          : null;
    }

    if (src.nodeTransforms && typeof src.nodeTransforms === 'object') {
      const out: Record<string, NodeTransform> = {};
      for (const [key, value] of Object.entries(src.nodeTransforms)) {
        if (!value) continue;
        const t = value as Partial<NodeTransform>;
        out[key] = {
          x: clampOr(t.x, NODE_LIMITS.offset, 0),
          y: clampOr(t.y, NODE_LIMITS.offset, 0),
          z: clampOr(t.z, NODE_LIMITS.offset, 0),
          rotX: wrapDegrees(t.rotX),
          rotY: wrapDegrees(t.rotY),
          rotZ: wrapDegrees(t.rotZ),
          scale: clampOr(t.scale, NODE_LIMITS.scale, 1),
        };
      }
      rig.nodeTransforms = out;
    }

    if (src.edits && typeof src.edits === 'object') {
      const edits: Partial<Record<CarPartId, PartEdit>> = {};
      for (const [key, value] of Object.entries(src.edits)) {
        if (!CAR_PART_IDS.includes(key as CarPartId) || !value) continue;
        const e = value as Partial<PartEdit>;
        const material =
          e.material && PART_MATERIAL_IDS.includes(e.material)
            ? e.material
            : null;
        edits[key as CarPartId] = {
          scaleX: clampOr(e.scaleX, PART_EDIT_LIMITS.scale, 1),
          scaleY: clampOr(e.scaleY, PART_EDIT_LIMITS.scale, 1),
          scaleZ: clampOr(e.scaleZ, PART_EDIT_LIMITS.scale, 1),
          inflate: clampOr(e.inflate, PART_EDIT_LIMITS.inflate, 0),
          twistDeg: clampOr(e.twistDeg, PART_EDIT_LIMITS.twistDeg, 0),
          material,
        };
      }
      rig.edits = edits;
    }

    if (Object.keys(rig).length) out.carRig = rig as CarRigState;
  }

  if (patch.transform) {
    const t: Partial<TransformState> = {};
    const src = patch.transform;

    if (src.position) {
      t.position = {
        x: clampAxis(src.position.x, LIMITS.positionX),
        y: clampAxis(src.position.y, LIMITS.positionY),
        z: clampAxis(src.position.z, LIMITS.positionZ),
      };
    }
    if (src.rotationDeg) {
      // Rotation wraps rather than clamps - 370 degrees is a legal request.
      t.rotationDeg = {
        x: wrapDegrees(src.rotationDeg.x),
        y: wrapDegrees(src.rotationDeg.y),
        z: wrapDegrees(src.rotationDeg.z),
      };
    }
    if (typeof src.scale === 'number' && Number.isFinite(src.scale)) {
      t.scale = clamp(src.scale, LIMITS.scale.min, LIMITS.scale.max);
    }
    if (Object.keys(t).length) out.transform = t as TransformState;
  }

  if (typeof patch.waveVelocity === 'number' && Number.isFinite(patch.waveVelocity)) {
    out.waveVelocity = clamp(
      patch.waveVelocity,
      LIMITS.waveVelocity.min,
      LIMITS.waveVelocity.max,
    );
  }

  if (typeof patch.waveAmplitude === 'number' && Number.isFinite(patch.waveAmplitude)) {
    out.waveAmplitude = clamp(
      patch.waveAmplitude,
      LIMITS.waveAmplitude.min,
      LIMITS.waveAmplitude.max,
    );
  }

  if (typeof patch.fogDensity === 'number' && Number.isFinite(patch.fogDensity)) {
    out.fogDensity = clamp(patch.fogDensity, LIMITS.fogDensity.min, LIMITS.fogDensity.max);
  }

  if (patch.camera) {
    const camera: Partial<CameraState> = {};
    if (patch.camera.preset && CAMERA_PRESETS.includes(patch.camera.preset)) {
      camera.preset = patch.camera.preset;
    }
    if (typeof patch.camera.distance === 'number' && Number.isFinite(patch.camera.distance)) {
      camera.distance = clamp(
        patch.camera.distance,
        LIMITS.cameraDistance.min,
        LIMITS.cameraDistance.max,
      );
    }
    if (typeof patch.camera.height === 'number' && Number.isFinite(patch.camera.height)) {
      camera.height = clamp(
        patch.camera.height,
        LIMITS.cameraHeight.min,
        LIMITS.cameraHeight.max,
      );
    }
    if (typeof patch.camera.autoOrbit === 'boolean') camera.autoOrbit = patch.camera.autoOrbit;
    if (Object.keys(camera).length) out.camera = camera as CameraState;
  }

  if (patch.nodes) {
    const nodes: Partial<NodeClusterState> = {};
    if (typeof patch.nodes.count === 'number' && Number.isFinite(patch.nodes.count)) {
      nodes.count = Math.round(
        clamp(patch.nodes.count, LIMITS.nodeCount.min, LIMITS.nodeCount.max),
      );
    }
    if (typeof patch.nodes.spread === 'number' && Number.isFinite(patch.nodes.spread)) {
      nodes.spread = clamp(patch.nodes.spread, LIMITS.nodeSpread.min, LIMITS.nodeSpread.max);
    }
    if (typeof patch.nodes.floatSpeed === 'number' && Number.isFinite(patch.nodes.floatSpeed)) {
      nodes.floatSpeed = clamp(
        patch.nodes.floatSpeed,
        LIMITS.nodeFloatSpeed.min,
        LIMITS.nodeFloatSpeed.max,
      );
    }
    const nodeColor = normalizeHex(patch.nodes.colorHex);
    if (nodeColor) nodes.colorHex = nodeColor;
    if (Object.keys(nodes).length) out.nodes = nodes as NodeClusterState;
  }

  return out;
}

/* ------------------------------------------------------------------ */
/* Scene presets — one agent call flips the whole world                */
/* ------------------------------------------------------------------ */

export const SCENE_PRESETS: Record<ScenePresetName, Partial<WiredState>> = {
  'neon-noir': {
    gridColorHex: '#00f0ff',
    accentColorHex: '#ff2bd6',
    fogDensity: 0.035,
    waveVelocity: 1,
    waveAmplitude: 1,
    nodes: { count: 0, spread: 26, floatSpeed: 1, colorHex: '#8b5cff' },
    camera: { preset: 'orbit', distance: 16, height: 6, autoOrbit: false },
  },
  'solar-flare': {
    gridColorHex: '#ff8a1f',
    accentColorHex: '#ffe14d',
    fogDensity: 0.028,
    waveVelocity: 2.2,
    waveAmplitude: 1.8,
    nodes: { count: 0, spread: 34, floatSpeed: 2, colorHex: '#ff4d2b' },
    camera: { preset: 'wide', distance: 26, height: 9, autoOrbit: false },
  },
  'deep-void': {
    gridColorHex: '#2b4bff',
    accentColorHex: '#00ffa3',
    fogDensity: 0.07,
    waveVelocity: 0.35,
    waveAmplitude: 0.5,
    nodes: { count: 0, spread: 44, floatSpeed: 0.35, colorHex: '#1effc8' },
    camera: { preset: 'close', distance: 10, height: 2.5, autoOrbit: false },
  },
  hologram: {
    gridColorHex: '#9dfcff',
    accentColorHex: '#ffffff',
    fogDensity: 0.015,
    waveVelocity: 1.4,
    waveAmplitude: 0.9,
    nodes: { count: 0, spread: 30, floatSpeed: 1.6, colorHex: '#a6f0ff' },
    camera: { preset: 'top', distance: 20, height: 18, autoOrbit: false },
  },
};

/* ------------------------------------------------------------------ */
/* Logging                                                             */
/* ------------------------------------------------------------------ */

export interface LogEntry {
  id: number;
  ts: number;
  origin: ActionOrigin;
  message: string;
}

const MAX_LOGS = 60;

/* ------------------------------------------------------------------ */
/* Store                                                               */
/* ------------------------------------------------------------------ */

export type McpStatus = 'checking' | 'connected' | 'unavailable';

export type PhotoStatus =
  | 'idle'
  | 'reading'
  | 'screening'
  | 'downloading'
  | 'analyzing'
  | 'building'
  | 'ready'
  | 'rejected'
  | 'error';

export interface PhotoState {
  status: PhotoStatus;
  /** Human-readable line shown under the drop zone and in the trace. */
  message: string;
  /** 0..1 for a known-length step, or -1 for indeterminate. */
  progress: number;
  sourceName: string | null;
  /** What the subject screen decided the image contains. */
  subject: string | null;
  width: number;
  height: number;
}

export const IDLE_PHOTO: PhotoState = {
  status: 'idle',
  message: 'Drop a photo of an object to rebuild it in 3D.',
  progress: 0,
  sourceName: null,
  subject: null,
  width: 0,
  height: 0,
};

export interface WiredStore extends WiredState {
  logs: LogEntry[];
  mcpStatus: McpStatus;
  /** Count of tool invocations that came from a real agent. */
  agentActionCount: number;

  /** Bumped to fire a transient shockwave; the engine watches the token. */
  pulseToken: number;
  pulseIntensity: number;
  pulseDurationMs: number;

  /**
   * THE reducer. Human UI handlers and WebMCP execute() callbacks both call
   * this and nothing else. Returns a human-readable summary of what changed,
   * reused verbatim as the tool's text content block.
   */
  photo: PhotoState;

  apply: (
    patch: Partial<WiredState>,
    origin: ActionOrigin,
    /**
     * Skip the trace line. Continuous input — a webcam gesture, like the
     * drag gizmo before it — would otherwise write one entry per frame and
     * flush the whole ring buffer in two seconds. Call once more without it
     * when the gesture ends.
     */
    silent?: boolean,
  ) => string;

  /**
   * Transform writer for the drag gizmo. The gizmo fires on every pointer
   * move, so `silent` skips the trace line; call once more with silent=false
   * on pointer-up to log the final placement. Still routes through the same
   * sanitiser and the same state, so an agent reading the scene sees the
   * human-dragged position immediately.
   */
  setTransform: (
    next: Partial<TransformState>,
    origin: ActionOrigin,
    silent?: boolean,
  ) => string;

  /** Point the gizmo at a part, or clear the selection. */
  select: (next: Selection | null, origin: ActionOrigin) => string;
  /**
   * Move one of the 97 individual meshes. Like setTransform, `silent` skips the
   * trace line so a drag does not write one entry per pointer move.
   */
  setNodeTransform: (
    id: string,
    next: NodeTransform,
    origin: ActionOrigin,
    silent?: boolean,
  ) => string;
  /** Detach or refit individual meshes by node id. */
  setNodeHidden: (ids: string[], origin: ActionOrigin) => string;

  setPhoto: (patch: Partial<PhotoState>, origin?: ActionOrigin) => void;
  resetPhoto: (origin?: ActionOrigin) => void;
  firePulse: (intensity: number, durationMs: number, origin: ActionOrigin) => string;
  applyPreset: (name: ScenePresetName, origin: ActionOrigin) => string;
  log: (origin: ActionOrigin, message: string) => void;
  /**
   * Count a read-only agent tool call. The mutating actions bump the counter
   * themselves; without this a `get_wired_future_state` or
   * `capture_scene_snapshot` would print an [AGENT] trace line while the badge
   * still claimed zero agent activity.
   */
  noteAgentCall: () => void;
  setMcpStatus: (status: McpStatus) => void;
  reset: (origin: ActionOrigin) => string;
  /** Plain snapshot of just the scene state, no actions or logs. */
  snapshot: () => WiredState;
}

let logSeq = 0;

function describe(patch: Partial<WiredState>): string[] {
  const parts: string[] = [];
  if (patch.gridColorHex) parts.push('grid ' + patch.gridColorHex);
  if (patch.accentColorHex) parts.push('accent ' + patch.accentColorHex);
  if (patch.modelType) parts.push('model ' + patch.modelType);
  if (patch.carVariant) parts.push('car ' + patch.carVariant);
  if (patch.carRig) {
    const r = patch.carRig;
    const bits: string[] = [];
    if (r.finish) bits.push(r.finish === 'print' ? '3D-print finish' : 'painted finish');
    if (r.explode !== undefined) bits.push('explode ' + Math.round(r.explode * 100) + '%');
    if (r.doorLeft !== undefined) bits.push('left door ' + Math.round(r.doorLeft * 100) + '%');
    if (r.doorRight !== undefined) bits.push('right door ' + Math.round(r.doorRight * 100) + '%');
    if (r.hood !== undefined) bits.push('hood ' + Math.round(r.hood * 100) + '%');
    if (r.hidden) {
      bits.push(r.hidden.length ? 'removed: ' + r.hidden.join(', ') : 'all parts fitted');
    }
    if (r.selection !== undefined) {
      parts.push(r.selection ? 'selected ' + r.selection.label : 'selection cleared');
    }
    if (r.hiddenNodes) {
      bits.push(
        r.hiddenNodes.length
          ? r.hiddenNodes.length + ' individual parts removed'
          : 'no individual parts removed',
      );
    }
    if (r.nodeTransforms) {
      const moved = Object.keys(r.nodeTransforms).length;
      bits.push(moved ? moved + ' parts moved by hand' : 'no parts moved');
    }
    if (r.edits) {
      const touched = Object.keys(r.edits);
      bits.push(touched.length ? 'reshaped: ' + touched.join(', ') : 'no part edits');
    }
    if (bits.length) parts.push('rig ' + bits.join(' / '));
  }
  if (patch.editMode) parts.push('edit mode ' + patch.editMode);
  if (patch.transform) {
    const t = patch.transform;
    const bits: string[] = [];
    if (t.position) {
      bits.push(
        'pos ' + t.position.x + '/' + t.position.y + '/' + t.position.z,
      );
    }
    if (t.rotationDeg) {
      bits.push(
        'rot ' +
          t.rotationDeg.x +
          '/' +
          t.rotationDeg.y +
          '/' +
          t.rotationDeg.z +
          ' deg',
      );
    }
    if (t.scale !== undefined) bits.push('scale ' + t.scale);
    if (bits.length) parts.push('transform ' + bits.join(' / '));
  }
  if (patch.waveVelocity !== undefined) parts.push('wave velocity ' + patch.waveVelocity);
  if (patch.waveAmplitude !== undefined) parts.push('wave amplitude ' + patch.waveAmplitude);
  if (patch.fogDensity !== undefined) parts.push('fog ' + patch.fogDensity);
  if (patch.camera) {
    const c = patch.camera;
    const bits: string[] = [];
    if (c.preset) bits.push(c.preset);
    if (c.distance !== undefined) bits.push('dist ' + c.distance);
    if (c.height !== undefined) bits.push('height ' + c.height);
    if (c.autoOrbit !== undefined) bits.push(c.autoOrbit ? 'orbit on' : 'orbit off');
    if (bits.length) parts.push('camera ' + bits.join(' / '));
  }
  if (patch.nodes) {
    const n = patch.nodes;
    const bits: string[] = [];
    if (n.count !== undefined) bits.push(n.count + ' nodes');
    if (n.spread !== undefined) bits.push('spread ' + n.spread);
    if (n.floatSpeed !== undefined) bits.push('float ' + n.floatSpeed);
    if (n.colorHex) bits.push(n.colorHex);
    if (bits.length) parts.push('cluster ' + bits.join(' / '));
  }
  return parts;
}

export const useWired = create<WiredStore>((set, get) => ({
  ...DEFAULT_STATE,
  logs: [],
  photo: { ...IDLE_PHOTO },
  mcpStatus: 'checking',
  agentActionCount: 0,
  pulseToken: 0,
  pulseIntensity: 2,
  pulseDurationMs: 1600,

  apply: (rawPatch, origin, silent = false) => {
    const patch = sanitizePatch(rawPatch);
    const parts = describe(patch);

    if (!parts.length) {
      const message = 'no recognisable parameters - nothing changed';
      if (!silent) get().log(origin, message);
      return message;
    }

    set((s) => ({
      ...s,
      ...patch,
      camera: patch.camera ? { ...s.camera, ...patch.camera } : s.camera,
      nodes: patch.nodes ? { ...s.nodes, ...patch.nodes } : s.nodes,
      transform: patch.transform
        ? { ...s.transform, ...patch.transform }
        : s.transform,
      carRig: patch.carRig ? { ...s.carRig, ...patch.carRig } : s.carRig,
      agentActionCount:
        origin === 'agent' && !silent
          ? s.agentActionCount + 1
          : s.agentActionCount,
    }));

    const message = parts.join(', ');
    if (!silent) get().log(origin, message);
    return message;
  },

  firePulse: (intensity, durationMs, origin) => {
    const i = clamp(intensity, LIMITS.pulseIntensity.min, LIMITS.pulseIntensity.max);
    const d = clamp(durationMs, LIMITS.pulseDuration.min, LIMITS.pulseDuration.max);
    set((s) => ({
      pulseToken: s.pulseToken + 1,
      pulseIntensity: i,
      pulseDurationMs: d,
      agentActionCount: origin === 'agent' ? s.agentActionCount + 1 : s.agentActionCount,
    }));
    const message = 'reality wave pulsed at x' + i + ' for ' + d + 'ms';
    get().log(origin, message);
    return message;
  },

  applyPreset: (name, origin) => {
    const preset = SCENE_PRESETS[name];
    if (!preset) {
      const message = 'unknown preset "' + name + '"';
      get().log(origin, message);
      return message;
    }
    get().apply(preset, origin);
    const message = 'preset "' + name + '" applied';
    get().log(origin, message);
    return message;
  },

  reset: (origin) => {
    set((s) => ({
      ...s,
      ...DEFAULT_STATE,
      agentActionCount: origin === 'agent' ? s.agentActionCount + 1 : s.agentActionCount,
    }));
    set({ photo: { ...IDLE_PHOTO } });
    const message = 'environment reset to defaults';
    get().log(origin, message);
    return message;
  },

  log: (origin, message) => {
    logSeq += 1;
    const entry: LogEntry = { id: logSeq, ts: Date.now(), origin, message };
    set((s) => ({ logs: [...s.logs, entry].slice(-MAX_LOGS) }));
  },

  setTransform: (next, origin, silent = false) => {
    const patch = sanitizePatch({ transform: next as TransformState });
    if (!patch.transform) return 'no usable transform values';

    set((s) => ({
      transform: { ...s.transform, ...patch.transform },
      agentActionCount:
        origin === 'agent' && !silent
          ? s.agentActionCount + 1
          : s.agentActionCount,
    }));

    const t = get().transform;
    const message =
      'placed at ' +
      t.position.x.toFixed(2) + '/' +
      t.position.y.toFixed(2) + '/' +
      t.position.z.toFixed(2) +
      ', yaw ' + t.rotationDeg.y.toFixed(1) + ' deg' +
      ', scale ' + t.scale.toFixed(2);

    if (!silent) get().log(origin, message);
    return message;
  },

  select: (next, origin) => {
    set((s) => ({ carRig: { ...s.carRig, selection: next } }));
    const message = next
      ? 'selected ' + next.label + (next.level === 'node' ? ' (single part)' : '')
      : 'selection cleared';
    get().log(origin, message);
    return message;
  },

  setNodeTransform: (id, next, origin, silent = false) => {
    const patch = sanitizePatch({
      carRig: {
        ...get().carRig,
        nodeTransforms: { ...get().carRig.nodeTransforms, [id]: next },
      },
    } as Partial<WiredState>);

    if (patch.carRig?.nodeTransforms) {
      const clean = patch.carRig.nodeTransforms;
      set((s) => ({
        carRig: { ...s.carRig, nodeTransforms: clean },
        agentActionCount:
          origin === 'agent' && !silent
            ? s.agentActionCount + 1
            : s.agentActionCount,
      }));
    }

    const t = get().carRig.nodeTransforms[id];
    const message = t
      ? 'moved part ' + id + ' to ' +
        t.x.toFixed(2) + '/' + t.y.toFixed(2) + '/' + t.z.toFixed(2) +
        ', scale ' + t.scale.toFixed(2)
      : 'part ' + id + ' reset';

    if (!silent) get().log(origin, message);
    return message;
  },

  setNodeHidden: (ids, origin) => {
    const unique = Array.from(new Set(ids));
    set((s) => ({
      carRig: { ...s.carRig, hiddenNodes: unique },
      agentActionCount:
        origin === 'agent' ? s.agentActionCount + 1 : s.agentActionCount,
    }));
    const message = unique.length
      ? unique.length + ' individual part(s) detached'
      : 'all individual parts refitted';
    get().log(origin, message);
    return message;
  },

  setPhoto: (patch, origin) => {
    set((s) => ({ photo: { ...s.photo, ...patch } }));
    if (origin && patch.message) get().log(origin, patch.message);
  },

  resetPhoto: (origin) => {
    set({ photo: { ...IDLE_PHOTO } });
    if (origin) get().log(origin, 'photo reconstruction cleared');
  },

  noteAgentCall: () =>
    set((s) => ({ agentActionCount: s.agentActionCount + 1 })),

  setMcpStatus: (status) => set({ mcpStatus: status }),

  snapshot: () => {
    const s = get();
    return {
      gridColorHex: s.gridColorHex,
      accentColorHex: s.accentColorHex,
      modelType: s.modelType,
      carVariant: s.carVariant,
      carRig: {
        ...s.carRig,
        hidden: [...s.carRig.hidden],
        hiddenNodes: [...s.carRig.hiddenNodes],
        nodeTransforms: { ...s.carRig.nodeTransforms },
        selection: s.carRig.selection ? { ...s.carRig.selection } : null,
        edits: { ...s.carRig.edits },
      },
      editMode: s.editMode,
      transform: {
        position: { ...s.transform.position },
        rotationDeg: { ...s.transform.rotationDeg },
        scale: s.transform.scale,
      },
      waveVelocity: s.waveVelocity,
      waveAmplitude: s.waveAmplitude,
      fogDensity: s.fogDensity,
      camera: { ...s.camera },
      nodes: { ...s.nodes },
    };
  },
}));
