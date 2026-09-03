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

  /** Replace the photo-relief mesh. Switching modelType to 'photo' reveals it. */
  setPhotoRelief: (input: PhotoReliefInput) => void;
  /** Drop the relief mesh and free its geometry/texture. */
  clearPhotoRelief: () => void;
  /** True once a relief has been built this session. */
  hasPhotoRelief: () => boolean;

  /** Stop the loop, drop listeners, dispose geometries/materials/renderer. */
  dispose: () => void;
}
