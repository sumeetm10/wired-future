import type {
  CarPartId,
  NodeTransform,
  Selection,
  TransformState,
  WiredState,
} from '@/store/use-wired';
import type { PartMeasurement } from './part-ops';

export interface SceneSnapshot {
  /** Full data: URL, e.g. "data:image/jpeg;base64,...". */
  dataUrl: string;
  /** Bare base64 payload with the data: prefix stripped — what MCP image blocks want. */
  base64: string;
  mimeType: string;
  width: number;
  height: number;
}

/**
 * A depth reconstruction handed to the engine by the photo pipeline.
 * `depth` and `colors` are row-major, `width * height` and `width * height * 4`
 * long respectively, both sampled on the same grid.
 */
export interface PhotoReliefInput {
  width: number;
  height: number;
  /** Normalised 0..1, where 1 is nearest the camera. */
  depth: Float32Array;
  /** RGBA of the source image, used to texture the relief. */
  colors: Uint8ClampedArray;
  /** Original file name, for labelling. */
  name: string;
}

/**
 * What a hand cursor is pointing at. Hands aim like a held Ctrl: they reach
 * single parts and removed parts, not just whole assemblies.
 */
export interface HandTarget {
  node: string;
  assembly: CarPartId;
  /** A removed part in front of anything visible: a pinch-tap puts it back. */
  hidden: boolean;
  /** Belongs to a door or the hood: holding it swings it on its hinge. */
  hinged: boolean;
  /** What to call it on the cursor: the assembly when hinged, else the part. */
  label: string;
}

/** Where a held thing is now, in the terms the store commits. */
export type HandGripState =
  | { kind: 'hinge'; assembly: CarPartId; value: number }
  | { kind: 'node'; node: string; transform: NodeTransform }
  | { kind: 'model'; position: { x: number; y: number; z: number } };

/**
 * One hand holding one thing.
 *
 *  - hinge: a door or the hood. move() solves the hinge value that puts the
 *           grabbed point under the hand and RETURNS it; the caller writes it
 *           through the store, so the sliders swing with the hand.
 *  - node:  any other part, carried in a plane facing the camera. move()
 *           writes the scene directly, like a Ctrl-drag, and the caller
 *           commits once on release: per-frame store writes re-render the
 *           109-row part list.
 *  - model: the whole car, carried the same way; returned, not written.
 */
export interface HandGrip {
  readonly kind: HandGripState['kind'];
  /** Follow the hand to these viewport coordinates. Null when it cannot. */
  move: (clientX: number, clientY: number) => HandGripState | null;
  /** Put a node grip back where it started (a tap, not a drag). */
  cancel: () => void;
  /** Where it is now, for the commit on release. */
  state: () => HandGripState;
}

/** What a Ctrl-click landed on, and what the click should do about it. */
export interface ActuateTarget {
  node: string;
  assembly: CarPartId;
  hinged: boolean;
  /**
   * The click landed where a HIDDEN part sits, in front of anything visible:
   * put that part back rather than acting on whatever is behind it.
   */
  restore: boolean;
}

/**
 * The only surface React is allowed to touch on the Three.js side.
 * React never imports `three`; the engine never imports React.
 */
export interface WiredEngine {
  /** Attach renderer + start the RAF loop. Safe to call once per mount. */
  mount: (container: HTMLElement) => void;
  /** Reconcile the live scene against a full state object. Idempotent. */
  apply: (state: WiredState) => void;
  /** Transient shockwave: spikes wave speed and light intensity, then eases back. */
  pulse: (intensity: number, durationMs: number) => void;
  /** Render one frame to an offscreen canvas and read it back. Null before mount. */
  capture: (maxWidth?: number) => SceneSnapshot | null;

  /**
   * Called by the engine whenever the human drags the transform gizmo, so the
   * store stays the single source of truth. `settled` is false during the drag
   * and true on pointer-up.
   */
  onTransformChange: (
    handler: (next: TransformState, settled: boolean) => void,
  ) => void;

  /**
   * Real measured geometry for one car assembly: triangle count, surface area,
   * signed volume, bounding box and centroid. Null when the glTF car is not
   * the mounted model, or the part is absent from the asset.
   */
  measureCarPart: (id: CarPartId) => PartMeasurement | null;

  /**
   * Called when the human clicks a part in the viewport. A plain click selects
   * the whole assembly; Ctrl (or Cmd) drills down to the individual mesh, so a
   * door handle can be grabbed without first hunting through a list of 97.
   * Passing null means they clicked empty space and cleared the selection.
   */
  onSelect: (handler: (next: Selection | null) => void) => void;

  /**
   * Ctrl-click on a part: run whatever that part DOES. A door swings, the hood
   * lifts, anything without a hinge pops off and back on. The engine reports
   * the target and lets the store decide, because "what a door does" is state,
   * not geometry.
   */
  onActuate: (handler: (target: ActuateTarget) => void) => void;

  /**
   * Fires while the gizmo drags a whole assembly (a door, the hood). Layered on
   * top of explode and the hinge, so the part keeps swinging on its own hinge.
   */
  onAssemblyTransformChange: (
    handler: (id: CarPartId, next: NodeTransform, settled: boolean) => void,
  ) => void;

  /**
   * The user grabbed the canvas while the scripted orbit was running. The
   * store owns autoOrbit, so the engine asks for it to be switched off rather
   * than silently ignoring the drag.
   */
  onCameraTakeover: (handler: () => void) => void;

  /**
   * Fires while the gizmo drags an individual mesh rather than the whole
   * object. Separate from onTransformChange so moving a wing mirror never
   * rewrites the car's own placement.
   */
  onNodeTransformChange: (
    handler: (id: string, next: NodeTransform, settled: boolean) => void,
  ) => void;

  /** Every individually addressable mesh, for the part tree. */
  listCarNodes: () => Array<{
    id: string;
    label: string;
    assembly: CarPartId;
    triangles: number;
  }>;

  /**
   * What part is under a hand cursor at these viewport coordinates. With
   * `forgiving`, a near miss within a few pixels still counts, because a
   * webcam hand cannot aim like a mouse; it costs eight more rays, so the
   * caller asks for it only while aiming or already on a part.
   */
  pickForHand: (clientX: number, clientY: number, forgiving?: boolean) => HandTarget | null;
  /**
   * Show what hand `slot` (0 or 1) is pointing at or holding. `strength` 0..1
   * brightens the glow as the fingers close, so a pinch is previewed before
   * it lands. Null clears that hand's glow.
   */
  setHandHover: (
    slot: number,
    target: HandTarget | null,
    strength: number,
    holding: boolean,
  ) => void;
  /** Start holding `target` (null = the whole car) from these coordinates. */
  grabForHand: (
    target: HandTarget | null,
    clientX: number,
    clientY: number,
  ) => HandGrip | null;
  /** Drop every hand glow, e.g. when the camera stops. */
  clearHandFeedback: () => void;
  /**
   * Turn the view around the car by a hand's travel in viewport pixels:
   * across turns it, up and down tilts it. Takes the camera over from the
   * scripted orbit if that is running.
   */
  orbitByHand: (dxPx: number, dyPx: number) => void;

  /**
   * Load a different car into the stage, e.g. a .glb the user picked; null
   * goes back to the concept car. Resolves with how many parts it split into.
   */
  setCarModel: (url: string | null) => Promise<{ parts: number }>;

  /** Replace the photo-relief mesh. Switching modelType to 'photo' reveals it. */
  setPhotoRelief: (input: PhotoReliefInput) => void;
  /** Drop the relief mesh and free its geometry/texture. */
  clearPhotoRelief: () => void;
  /** True once a relief has been built this session. */
  hasPhotoRelief: () => boolean;

  /** Stop the loop, drop listeners, dispose geometries/materials/renderer. */
  dispose: () => void;
}
