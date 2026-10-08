/**
 * Wired Future — the three.js engine.
 *
 * Implements the frozen WiredEngine contract. It knows nothing about React,
 * zustand or WebMCP: it is handed a full WiredState and reconciles the live
 * scene against it. Every expensive operation (model rebuild, node placement)
 * is guarded behind a "did this field actually change" check, so apply() is
 * safe to call on every single store emission.
 *
 * apply() sets TARGETS and the frame loop moves towards them: a door an agent
 * opens swings, a palette preset cross-fades, a camera preset glides, a model
 * placed by a tool slides into place. Direct manipulation (the gizmo, a Ctrl
 * gesture) still lands instantly, and prefers-reduced-motion turns every glide
 * into a cut.
 *
 * Input has one rule: exactly one thing owns the pointer at a time. The gizmo,
 * a Ctrl gesture on a part and the orbit camera each claim it at pointerdown,
 * and OrbitControls.enabled is DERIVED from those claims in one place
 * (syncOrbitEnabled). It used to be written from five places, and the frame
 * loop's write won: the camera orbited while you dragged the gizmo.
 *
 * Scene graph:
 *   scene
 *     +- terrain.mesh          wireframe ground, mutated in place
 *     +- modelPivot            the user's placement (gizmo and tools)
 *     |    +- spinPivot        pop-in scale when a new centrepiece mounts
 *     |         +- model.group car, engine node or photo relief
 *     +- nodes.group           floating cluster
 *     +- ambient / gridLight / accentLight
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';

import {
  CAR_PART_LABELS,
  IDENTITY_NODE_TRANSFORM,
  LIMITS,
  NODE_LIMITS,
} from '@/store/use-wired';
import type {
  CameraPreset,
  CarPartId,
  CarRigState,
  EditMode,
  NodeTransform,
  Selection,
  TransformState,
  WiredState,
} from '@/store/use-wired';
import type {
  ActuateTarget,
  HandGrip,
  HandGripState,
  HandTarget,
  PhotoReliefInput,
  SceneSnapshot,
  WiredEngine,
} from './contract';
import { loadRealCar, type RealCarHandle } from './car-real';
import { HighlightLayer } from './highlight';
import { solveArc } from './hinge-solve';
import {
  buildCarModule,
  buildEngineNode,
  disposeObject3D,
  type ModelHandle,
} from './models';
import { createNodeCluster, type NodeCluster } from './nodes';
import { HoverTag, StatusPill } from './overlay-dom';
import { buildPhotoRelief } from './photo-relief';
import {
  buildBoundsTreesWhenIdle,
  installAcceleratedRaycast,
  isVisibleWithin,
} from './picking';
import { createTerrain, type Terrain } from './terrain';

/**
 * Which centrepiece is mounted. Combines modelType and carVariant into one
 * comparable key so the swap logic stays a single equality check.
 */
type ModelKey = 'car:real' | 'car:parametric' | 'engine' | 'photo';

const BACKGROUND = '#0b071e';

const GRID_LIGHT_BASE = 170;
const ACCENT_LIGHT_BASE = 130;

/**
 * Presets bias the FRAMING only — the angle the camera sits at, how fast it
 * sweeps and where it aims. state.camera.distance / height always win, because
 * the store already writes preset defaults into those fields at the moment a
 * preset is applied.
 */
interface PresetFraming {
  /** Multiplier on the horizontal orbit radius (distance stays the source of truth). */
  radiusScale: number;
  /** Small vertical offset layered on top of state.camera.height. */
  heightBias: number;
  /** Radians per second while autoOrbit is on. */
  orbitSpeed: number;
  /** Resting azimuth used when autoOrbit is off. */
  azimuth: number;
  /** Height of the look-at target. */
  lookAtY: number;
}

const PRESET_FRAMING: Record<CameraPreset, PresetFraming> = {
  orbit: { radiusScale: 1.0, heightBias: 0, orbitSpeed: 0.18, azimuth: 0.85, lookAtY: 0.8 },
  top: { radiusScale: 0.42, heightBias: 6, orbitSpeed: 0.12, azimuth: 0.0, lookAtY: 0.0 },
  close: { radiusScale: 0.72, heightBias: -0.8, orbitSpeed: 0.26, azimuth: 1.95, lookAtY: 1.2 },
  wide: { radiusScale: 1.3, heightBias: 1.6, orbitSpeed: 0.085, azimuth: 2.6, lookAtY: 0.5 },
};

const DEFAULT_CAMERA = {
  preset: 'orbit' as CameraPreset,
  distance: 16,
  height: 6,
  autoOrbit: true,
};

/**
 * Handles inside TransformControls that are pure visual noise here.
 *
 *  - E / XYZE  the grey free-rotate rings and the screen-space sphere, which
 *              sit on top of the three coloured axis rings you actually drag.
 *  - AXIS / START / END  the long white guide lines drawn across the whole
 *              viewport while a drag is in progress.
 *
 * They are REMOVED rather than hidden: TransformControlsGizmo rewrites
 * `visible` on every handle each frame in updateMatrixWorld, so hiding them
 * lasts exactly one frame. Detaching them from the graph is permanent, and the
 * gizmo simply iterates fewer children.
 */
const GIZMO_CLUTTER = new Set(['E', 'XYZE', 'AXIS', 'START', 'END', 'DELTA']);

function stripGizmoClutter(root: THREE.Object3D): void {
  try {
    const doomed: THREE.Object3D[] = [];
    root.traverse((child) => {
      if (GIZMO_CLUTTER.has(child.name)) doomed.push(child);
    });
    for (const child of doomed) child.removeFromParent();
  } catch {
    // A three.js version that reshapes the gizmo must not break the app; the
    // worst case is simply a busier gizmo.
  }
}

const devicePixelRatioSafe = (): number => {
  if (typeof window === 'undefined') return 1;
  return Math.min(window.devicePixelRatio || 1, 2);
};

/* ------------------------------------------------------------------ */
/* Motion + input tuning                                               */
/* ------------------------------------------------------------------ */

/** Per-second rate the model eases towards a placement a tool or hand set. */
const MODEL_FOLLOW_RATE = 11;
const COLOR_GLIDE_SECONDS = 0.55;
const PRESET_GLIDE_SECONDS = 0.95;
const FOCUS_GLIDE_SECONDS = 0.75;
const MOUNT_SECONDS = 0.6;
/** Where a freshly mounted centrepiece starts, as a fraction of full size. */
const MOUNT_FROM = 0.72;
/** Hover sheen: neutral, so it reads on any palette and any paint. */
const HOVER_GLOW = '#e6fbff';
/** Hand glow: the [HAND] tag's green, so the trace and the stage agree. */
const HAND_GLOW = '#37f5a0';
/**
 * Near misses a hand pick also tries, in viewport pixels: a webcam hand cannot
 * hold a cursor on a door handle the way a mouse can.
 */
const HAND_PICK_RING: Array<[number, number]> = Array.from({ length: 8 }, (_, i) => {
  const a = (i / 8) * Math.PI * 2;
  return [Math.cos(a) * 16, Math.sin(a) * 16];
});
/**
 * When the swing arc folds back on itself on screen, two hinge values put the
 * grabbed point equally near the hand. Each unit of hinge travel away from
 * where the door already is costs this many pixels, so it stays on the side
 * it is on instead of flipping.
 */
const HINGE_CONTINUITY_PX = 40;
/**
 * Seen nearly end-on, a door's whole swing can cover a dozen pixels on screen
 * - from the default camera the left door opens almost straight at the
 * viewer - and no hand motion could follow that. Below this much on-screen
 * travel a held hinge follows a virtual lever instead: this many pixels of
 * hand travel is the full swing.
 */
const HINGE_LEVER_PX = 180;
/** Radians of view rotation per pixel of hand travel: a screen-width sweep is about one turn. */
const HAND_ORBIT_RAD_PER_PX = 0.0042;
/** Movement allowed between press and release for it still to be a click. */
const CLICK_SLOP_PX = 4;
/** Hover this long without Ctrl before the part's name appears. */
const HOVER_REST_MS = 420;
/** How long wheel feedback stays in the pointer tag after the last notch. */
const WHEEL_TAG_MS = 900;
/**
 * Closest the orbit camera may get to what it is looking at. The store's
 * distance limit is for the scripted framings; a person inspecting a door
 * handle needs to get much nearer than that.
 */
const ORBIT_MIN_DISTANCE = 1.4;
/** Pixels of drag per world unit of travel when pulling a part out. */
const DRAG_PIXELS_PER_UNIT = 90;

const easeInOutCubic = (t: number): number =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

const easeOutBack = (t: number): number => {
  const c1 = 1.5;
  const c3 = c1 + 1;
  const u = t - 1;
  return 1 + c3 * u * u * u + c1 * u * u;
};

/**
 * The gizmo can scale one axis, but every stored scale is uniform. Take the
 * component the user actually dragged - the one furthest from where the drag
 * started - instead of blindly reading x, which made the Y and Z handles do
 * nothing once the value round-tripped through the store.
 */
function dominantScale(scale: THREE.Vector3, start: number): number {
  const ref = start > 0 ? start : 1;
  let best = scale.x;
  let bestDelta = Math.abs(Math.log(Math.max(1e-6, scale.x) / ref));
  for (const component of [scale.y, scale.z]) {
    const delta = Math.abs(Math.log(Math.max(1e-6, component) / ref));
    if (delta > bestDelta) {
      best = component;
      bestDelta = delta;
    }
  }
  return best;
}

const MOD_KEY =
  typeof navigator !== 'undefined' &&
  /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent || '')
    ? 'Cmd'
    : 'Ctrl';

/** What the pointer is over. `hidden` means a removed part, in front of anything visible. */
interface PartHit {
  node: string;
  assembly: CarPartId;
  hidden: boolean;
}

/** A Ctrl gesture on one part, held here so per-move maths never touches React. */
interface PartDrag {
  node: string;
  assembly: CarPartId;
  hinged: boolean;
  /** Pressed on a removed part: a click puts it back, a drag does nothing. */
  restore: boolean;
  startX: number;
  startY: number;
  /** Outward direction projected into screen space, normalised. */
  screenDirX: number;
  screenDirY: number;
  /** The node's transform when the press began. */
  start: NodeTransform;
  /** Outward axis in the assembly frame, where node offsets live. */
  axis: THREE.Vector3;
  /** Offset along `axis` when the press began. */
  startOffset: number;
  offset: number;
  moved: boolean;
}

/** A camera glide, interpolated on a sphere around a moving target. */
interface CameraGlide {
  t: number;
  duration: number;
  fromTarget: THREE.Vector3;
  toTarget: THREE.Vector3;
  from: THREE.Spherical;
  to: THREE.Spherical;
}

class Engine implements WiredEngine {
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly fog: THREE.FogExp2;
  private readonly clock: THREE.Clock;

  private readonly ambient: THREE.AmbientLight;
  private readonly gridLight: THREE.PointLight;
  private readonly accentLight: THREE.PointLight;

  private readonly terrain: Terrain;
  private readonly nodes: NodeCluster;
  private readonly modelPivot: THREE.Group;

  private model: ModelHandle;
  /**
   * Inner pivot. The OUTER modelPivot carries the user's placement and is what
   * the gizmo attaches to; this one only carries the mount pop-in, so neither
   * can overwrite the other.
   */
  private readonly spinPivot: THREE.Group;
  private spinAngle = 0;
  private modelKey: ModelKey = 'car:parametric';
  /** False when `model` is the shared photo relief, which the engine owns. */
  private ownsModel = true;
  private carLoadToken = 0;
  /** A car the user loaded instead of the concept car; null for the default. */
  private carModelUrl: string | null = null;
  /** Settle the promise setCarModel() handed out once the car mounts or fails. */
  private carLoadWaiter: ((parts: number) => void) | null = null;
  private carLoadFailer: ((error: Error) => void) | null = null;
  /** Set only while the loaded glTF car is the mounted model. */
  private realCar: RealCarHandle | null = null;
  /** Human-readable name of every node of the mounted car, by id. */
  private nodeLabels = new Map<string, string>();
  /** Last rig state pushed into the car. Null forces a full re-push. */
  private appliedRig: CarRigState | null = null;
  /**
   * The exact CarRigState object last synced. apply() runs on EVERY store
   * emission - including every trace line - but the store only replaces
   * carRig when something rig-related actually changed, so an identity check
   * skips the 109-node reconciliation for the vast majority of calls.
   */
  private appliedRigSource: CarRigState | null = null;
  private photoRelief: ModelHandle | null = null;

  private orbitControls: OrbitControls | null = null;
  private transformControls: TransformControls | null = null;
  private transformHelper: THREE.Object3D | null = null;
  private transformHandler:
    | ((next: TransformState, settled: boolean) => void)
    | null = null;
  private selectHandler: ((next: Selection | null) => void) | null = null;
  private actuateHandler: ((target: ActuateTarget) => void) | null = null;
  private nodeTransformHandler:
    | ((id: string, next: NodeTransform, settled: boolean) => void)
    | null = null;
  private assemblyTransformHandler:
    | ((id: CarPartId, next: NodeTransform, settled: boolean) => void)
    | null = null;
  private cameraTakeoverHandler: (() => void) | null = null;

  /** What the gizmo is bound to. null means the whole model pivot. */
  private selection: Selection | null = null;
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private readonly hits: THREE.Intersection[] = [];
  /** Set while apply() writes the pivot, so our own write cannot echo back. */
  private suppressTransformEvents = false;
  private editMode: EditMode = 'orbit';
  private disposed = false;

  /* --- pointer ownership ------------------------------------------------ */

  /** Physical Ctrl/Cmd, tracked from key and pointer events. */
  private ctrlHeld = false;
  private pointerInside = false;
  private readonly lastPointer = { x: 0, y: 0 };
  /** Where the primary button went down, so a camera drag is not read as a click. */
  private pointerDownAt: { x: number; y: number } | null = null;
  private partDrag: PartDrag | null = null;
  /** The press landed on a gizmo handle. */
  private gizmoPress = false;
  private gizmoDragging = false;
  /** Scale of the gizmo's target when its drag began, for dominantScale. */
  private gizmoStartScale = 1;
  /** Ctrl-press over empty space: must not become OrbitControls' ctrl-pan. */
  private ctrlVoidPress = false;
  /** A plain drag is orbiting (or panning) the camera. */
  private cameraGrab = false;
  private cursor = '';

  /* --- hover -------------------------------------------------------------- */

  private hover: PartHit | null = null;
  private hoverDirty = false;
  private hoverSince = 0;
  private hoverParity = false;
  private wheelTagUntil = 0;
  /** Bounds trees are built; until then a pick walks every triangle. */
  private pickReady = false;
  private cancelPickBuild: (() => void) | null = null;
  private readonly hoverHighlight: HighlightLayer;
  private readonly selectHighlight: HighlightLayer;
  /** One glow per tracked hand, so two hands can point at two parts. */
  private readonly handHighlights: HighlightLayer[];
  private hoverTag: HoverTag | null = null;
  private statusPill: StatusPill | null = null;

  /* --- motion -------------------------------------------------------------- */

  private reducedMotion = false;
  private motionQuery: MediaQueryList | null = null;
  private readonly modelTarget = {
    position: new THREE.Vector3(),
    quaternion: new THREE.Quaternion(),
    scale: 1,
  };
  private modelSettled = true;
  private readonly shownGrid = new THREE.Color('#00f0ff');
  private readonly shownAccent = new THREE.Color('#ff2bd6');
  private readonly fromGrid = new THREE.Color();
  private readonly fromAccent = new THREE.Color();
  private readonly toGrid = new THREE.Color('#00f0ff');
  private readonly toAccent = new THREE.Color('#ff2bd6');
  /** 1 when the palette has arrived. */
  private colorT = 1;
  /** 1 when the mounted centrepiece has finished popping in. */
  private mountT = 1;
  private cameraGlide: CameraGlide | null = null;
  /** Where the camera is aimed; the scripted orbit eases this too. */
  private readonly lookTarget = new THREE.Vector3(0, PRESET_FRAMING.orbit.lookAtY, 0);
  /** False until the manual camera has been seated at its resting spot. */
  private cameraInitialised = false;
  /** A preset/distance/height change arrived while manual: glide there. */
  private pendingFraming = false;

  private readonly scratchBox = new THREE.Box3();
  private readonly scratchSphere = new THREE.Sphere();
  private readonly scratchEuler = new THREE.Euler();

  private renderer: THREE.WebGLRenderer | null = null;
  private container: HTMLElement | null = null;
  private observer: ResizeObserver | null = null;
  private canvasWithListeners: HTMLCanvasElement | null = null;
  private windowListeners = false;

  /** Last state we reconciled against; null until the first apply(). */
  private prev: WiredState | null = null;

  private gridHex = '#00f0ff';
  private accentHex = '#ff2bd6';
  private waveVelocity = 1;
  private cameraState = { ...DEFAULT_CAMERA };

  private elapsed = 0;
  private azimuth = PRESET_FRAMING.orbit.azimuth;
  private cameraSnapped = false;

  private pulseActive = false;
  private pulseStart = 0;
  private pulseIntensity = 1;
  private pulseDuration = 1.6;

  constructor() {
    installAcceleratedRaycast();
    // One hit per mesh is all a pick needs, and it lets the bounds tree stop
    // at the first triangle instead of collecting every one along the ray.
    this.raycaster.firstHitOnly = true;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(BACKGROUND);
    this.fog = new THREE.FogExp2(BACKGROUND, 0.035);
    this.scene.fog = this.fog;

    this.camera = new THREE.PerspectiveCamera(52, 1, 0.1, 500);
    this.camera.position.set(12, 6, 12);
    this.camera.lookAt(0, 0.8, 0);

    this.clock = new THREE.Clock(false);

    this.ambient = new THREE.AmbientLight(new THREE.Color('#2a2350'), 0.75);
    this.scene.add(this.ambient);

    this.gridLight = new THREE.PointLight(
      new THREE.Color(this.gridHex),
      GRID_LIGHT_BASE,
      0,
      2,
    );
    this.gridLight.position.set(6.5, 8.5, 6.5);
    this.scene.add(this.gridLight);

    this.accentLight = new THREE.PointLight(
      new THREE.Color(this.accentHex),
      ACCENT_LIGHT_BASE,
      0,
      2,
    );
    this.accentLight.position.set(-7.5, 4.5, -6.5);
    this.scene.add(this.accentLight);

    this.terrain = createTerrain(this.gridHex);
    this.scene.add(this.terrain.object3d);

    // The store owns the ceiling, so the slider, the agent tool and the scene
    // can never disagree about how many nodes are renderable.
    this.nodes = createNodeCluster('#8b5cff', LIMITS.nodeCount.max);
    this.nodes.setCount(0);
    this.scene.add(this.nodes.group);

    this.modelPivot = new THREE.Group();
    this.modelPivot.name = 'wired-model-pivot';
    this.scene.add(this.modelPivot);

    this.spinPivot = new THREE.Group();
    this.spinPivot.name = 'wired-model-spin';
    this.modelPivot.add(this.spinPivot);

    this.model = buildCarModule(this.gridHex, this.accentHex);
    this.spinPivot.add(this.model.group);

    // Hover is a near-white sheen; selection wears the palette's PRIMARY and
    // breathes. Not the accent: the car's paint is tinted with the accent, so
    // an accent glow on it all but disappears.
    this.hoverHighlight = new HighlightLayer({
      color: HOVER_GLOW,
      base: 0.07,
      rim: 0.75,
      pulse: 0,
    });
    this.selectHighlight = new HighlightLayer({
      color: this.gridHex,
      base: 0.1,
      rim: 1.15,
      pulse: 0.3,
    });
    this.handHighlights = [0, 1].map(
      () => new HighlightLayer({ color: HAND_GLOW, base: 0.08, rim: 0.95, pulse: 0 }),
    );
  }

  /* ---------------------------------------------------------------- */
  /* Mount / resize                                                    */
  /* ---------------------------------------------------------------- */

  /**
   * A backgrounded tab on a phone, or a GPU reset, kills the WebGL context.
   * Without preventDefault() the browser will not attempt restoration and the
   * canvas stays black forever.
   */
  private onContextLost = (event: Event): void => {
    event.preventDefault();
    this.renderer?.setAnimationLoop(null);
  };

  private onContextRestored = (): void => {
    if (!this.renderer) return;
    // Force a full reconcile: every cached "did this change" comparison is
    // stale against a brand new context.
    this.prev = null;
    this.cameraSnapped = false;
    this.renderer.setAnimationLoop(this.frame);
  };

  private onMotionPreference = (event: MediaQueryListEvent): void => {
    this.reducedMotion = event.matches;
    if (event.matches) this.settleMotion(true);
  };

  mount = (container: HTMLElement): void => {
    if (typeof document === 'undefined') return;

    if (!this.renderer) {
      this.renderer = new THREE.WebGLRenderer({
        antialias: true,
        alpha: false,
        // REQUIRED: capture() reads the canvas back after rendering.
        preserveDrawingBuffer: true,
      });
      this.renderer.setPixelRatio(devicePixelRatioSafe());
      const canvas = this.renderer.domElement;
      canvas.style.display = 'block';
      canvas.style.width = '100%';
      canvas.style.height = '100%';
      canvas.addEventListener('webglcontextlost', this.onContextLost);
      canvas.addEventListener('webglcontextrestored', this.onContextRestored);
      // Registered BEFORE OrbitControls and TransformControls (setupControls
      // runs below), so every pointer event reaches the ownership logic first
      // and a gesture can be claimed before the camera starts moving.
      canvas.addEventListener('pointerdown', this.onPointerDown);
      canvas.addEventListener('pointermove', this.onPointerMove);
      canvas.addEventListener('pointerup', this.onPointerUp);
      canvas.addEventListener('pointercancel', this.onPointerCancel);
      canvas.addEventListener('lostpointercapture', this.onLostPointerCapture);
      canvas.addEventListener('pointerleave', this.onPointerLeave);
      canvas.addEventListener('dblclick', this.onDoubleClick);
      // Not passive: ctrl-wheel must be preventable or the page zooms.
      canvas.addEventListener('wheel', this.onWheel, { passive: false });
      this.canvasWithListeners = canvas;
    }

    const canvas = this.renderer.domElement;
    if (canvas.parentElement !== container) {
      if (canvas.parentElement) canvas.parentElement.removeChild(canvas);
      container.appendChild(canvas);
    }

    this.container = container;
    // On <body>, not in the canvas host: the host is a z-index 0 layer, so
    // anything inside it slides UNDER the panels and beneath the vignette.
    const chromeRoot = container.ownerDocument.body;
    if (!this.hoverTag) this.hoverTag = new HoverTag(chromeRoot);
    if (!this.statusPill) this.statusPill = new StatusPill(chromeRoot);
    this.resize();

    if (typeof ResizeObserver !== 'undefined' && !this.observer) {
      this.observer = new ResizeObserver(() => this.resize());
      this.observer.observe(container);
    }
    if (typeof window !== 'undefined' && !this.windowListeners) {
      this.windowListeners = true;
      window.addEventListener('resize', this.resize);
      window.addEventListener('keydown', this.onKeyDown);
      window.addEventListener('keyup', this.onKeyUp);
      window.addEventListener('blur', this.onWindowBlur);
      if (typeof window.matchMedia === 'function') {
        this.motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
        this.reducedMotion = this.motionQuery.matches;
        this.motionQuery.addEventListener('change', this.onMotionPreference);
      }
    }

    this.setupControls();

    if (!this.clock.running) this.clock.start();
    this.cameraSnapped = false;
    this.renderer.setAnimationLoop(this.frame);
  };

  /* ---------------------------------------------------------------- */
  /* Picking                                                           */
  /* ---------------------------------------------------------------- */

  /** World-space point of a part, projected to canvas pixels. */
  private projectToScreen(point: THREE.Vector3): { x: number; y: number } | null {
    if (!this.renderer) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const v = point.clone().project(this.camera);
    return {
      x: ((v.x + 1) / 2) * rect.width,
      y: ((1 - v.y) / 2) * rect.height,
    };
  }

  /**
   * What part is under this viewport point.
   *
   * three.js raycasting ignores `visible`, so a removed part used to keep
   * catching clicks: take the wheels off and clicking where a wheel had been
   * still selected the invisible wheel, and nothing behind it was reachable.
   * The first VISIBLE hit wins. With `includeHidden`, a removed part that sits
   * in front of it is returned instead, flagged, so a Ctrl-click can put it back.
   */
  private pickPart(clientX: number, clientY: number, includeHidden: boolean): PartHit | null {
    const car = this.realCar;
    if (!car || !this.aimRay(clientX, clientY)) return null;

    this.hits.length = 0;
    this.raycaster.intersectObject(car.rig.root, true, this.hits);

    let hidden: PartHit | null = null;
    for (const hit of this.hits) {
      const found = car.rig.identify(hit.object);
      if (!found) continue;
      if (isVisibleWithin(hit.object, car.rig.root)) {
        this.hits.length = 0;
        return hidden ?? { ...found, hidden: false };
      }
      if (includeHidden && !hidden) hidden = { ...found, hidden: true };
    }
    this.hits.length = 0;
    return hidden;
  }

  /** Point the shared raycaster through a viewport position. */
  private aimRay(clientX: number, clientY: number): boolean {
    if (!this.renderer) return false;
    const rect = this.renderer.domElement.getBoundingClientRect();
    if (!rect.width || !rect.height) return false;
    this.pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    return true;
  }

  /** Where the ray through a viewport point first meets these meshes. */
  private surfacePoint(
    meshes: THREE.Mesh[],
    clientX: number,
    clientY: number,
    out: THREE.Vector3,
  ): boolean {
    if (!meshes.length || !this.aimRay(clientX, clientY)) return false;
    this.hits.length = 0;
    for (const mesh of meshes) this.raycaster.intersectObject(mesh, false, this.hits);
    let nearest: THREE.Intersection | null = null;
    for (const hit of this.hits) {
      if (!nearest || hit.distance < nearest.distance) nearest = hit;
    }
    if (nearest) out.copy(nearest.point);
    this.hits.length = 0;
    return nearest !== null;
  }

  private nodeLabel(id: string): string {
    return this.nodeLabels.get(id) ?? id;
  }

  /* ---------------------------------------------------------------- */
  /* Pointer ownership                                                 */
  /* ---------------------------------------------------------------- */

  /**
   * The single writer of OrbitControls.enabled. The camera may move only when
   * nobody else owns the pointer and no scripted motion owns the camera.
   */
  private syncOrbitEnabled(): void {
    const orbit = this.orbitControls;
    if (!orbit) return;
    orbit.enabled =
      !this.cameraState.autoOrbit &&
      !this.gizmoDragging &&
      !this.gizmoPress &&
      !this.ctrlVoidPress &&
      this.partDrag === null &&
      this.cameraGlide === null;
  }

  private noteModifiers(event: MouseEvent): void {
    const held = event.ctrlKey || event.metaKey;
    if (held === this.ctrlHeld) return;
    this.ctrlHeld = held;
    this.onModifierChange();
  }

  private onKeyDown = (event: KeyboardEvent): void => {
    if ((event.key === 'Control' || event.key === 'Meta') && !this.ctrlHeld) {
      this.ctrlHeld = true;
      this.onModifierChange();
    }
  };

  private onKeyUp = (event: KeyboardEvent): void => {
    if ((event.key === 'Control' || event.key === 'Meta') && this.ctrlHeld) {
      this.ctrlHeld = false;
      this.onModifierChange();
    }
  };

  /** Alt-tab with Ctrl held never delivers the keyup; assume it was let go. */
  private onWindowBlur = (): void => {
    if (this.ctrlHeld) {
      this.ctrlHeld = false;
      this.onModifierChange();
    }
  };

  private onModifierChange(): void {
    // Ctrl changes what a hover means (assembly vs single part, and whether a
    // removed part is a target), so re-pick rather than reuse the last hit.
    this.hoverDirty = true;
    this.hoverSince = performance.now();
    this.refreshHoverVisuals();
    this.updateCursor();
  }

  private onPointerDown = (event: PointerEvent): void => {
    this.noteModifiers(event);
    this.lastPointer.x = event.clientX;
    this.lastPointer.y = event.clientY;
    this.partDrag = null;
    this.gizmoPress = false;
    this.ctrlVoidPress = false;
    this.cameraGrab = false;
    this.hoverTag?.hide();

    // Any press takes the camera back from a focus or preset glide.
    this.cameraGlide = null;

    // Right and middle buttons belong to the camera (pan, dolly).
    if (event.button !== 0) {
      this.pointerDownAt = null;
      this.cameraGrab = true;
      if (this.cameraState.autoOrbit) this.cameraTakeoverHandler?.();
      this.syncOrbitEnabled();
      this.updateCursor();
      return;
    }

    this.pointerDownAt = { x: event.clientX, y: event.clientY };

    // A press on a gizmo handle belongs to the gizmo. Decided HERE, before
    // OrbitControls' own listener sees the event, so the camera never starts
    // a rotate it then has to be talked out of.
    const transform = this.transformControls;
    if (transform && this.editMode !== 'orbit' && transform.axis) {
      this.gizmoPress = true;
      // Land any glide now: the gizmo records its start pose on this very
      // event, and a pivot still easing would snap back on the first move.
      this.settleMotion(false);
      this.syncOrbitEnabled();
      this.updateCursor();
      return;
    }

    const ctrl = event.ctrlKey || event.metaKey;
    if (!ctrl) {
      // A plain drag orbits. If the scripted orbit is running, grabbing the
      // canvas hands the camera over instead of silently doing nothing.
      if (this.cameraState.autoOrbit) this.cameraTakeoverHandler?.();
      this.cameraGrab = true;
      this.syncOrbitEnabled();
      this.updateCursor();
      return;
    }

    const car = this.realCar;
    const found = car ? this.pickPart(event.clientX, event.clientY, true) : null;
    if (!car || !found) {
      // Ctrl means "parts". Over empty space it does nothing - in particular
      // it must not fall through to OrbitControls, whose ctrl-drag is a pan.
      this.ctrlVoidPress = true;
      this.syncOrbitEnabled();
      this.updateCursor();
      return;
    }

    const start = car.rig.readNodeTransform(found.node) ?? { ...IDENTITY_NODE_TRANSFORM };
    const axis = car.rig.nodeOutwardLocal(found.node) ?? new THREE.Vector3(0, 1, 0);
    let dirX = 0;
    let dirY = -1;

    if (!found.hidden) {
      // Project the part's outward axis into screen space so dragging "away
      // from the car" always pushes the part out, whatever the camera angle.
      const outward = car.rig.nodeOutwardWorld(found.node);
      const pivot = car.rig.pivotFor('node', found.node);
      if (outward && pivot) {
        const origin = pivot.getWorldPosition(new THREE.Vector3());
        const a = this.projectToScreen(origin);
        const b = this.projectToScreen(origin.clone().add(outward));
        if (a && b) {
          const vx = b.x - a.x;
          const vy = b.y - a.y;
          const len = Math.hypot(vx, vy);
          if (len > 0.001) {
            dirX = vx / len;
            dirY = vy / len;
          }
        }
      }
    }

    const startOffset = start.x * axis.x + start.y * axis.y + start.z * axis.z;

    this.partDrag = {
      node: found.node,
      assembly: found.assembly,
      hinged: car.rig.hasHinge(found.assembly),
      restore: found.hidden,
      startX: event.clientX,
      startY: event.clientY,
      screenDirX: dirX,
      screenDirY: dirY,
      start,
      axis,
      startOffset,
      offset: startOffset,
      moved: false,
    };

    this.syncOrbitEnabled();
    try {
      this.renderer?.domElement.setPointerCapture(event.pointerId);
    } catch {
      // A pointer that is already gone cannot be captured; pointerup still ends it.
    }
    this.updateCursor();
  };

  private onPointerMove = (event: PointerEvent): void => {
    this.noteModifiers(event);
    this.lastPointer.x = event.clientX;
    this.lastPointer.y = event.clientY;
    this.pointerInside = true;

    const drag = this.partDrag;
    if (drag) {
      // No button held any more: the release happened somewhere this canvas
      // never heard about (another window, a dropped capture). End the drag
      // instead of letting the part follow a mouse nobody is pressing.
      if ((event.buttons & 1) === 0) {
        this.endPartDrag();
        return;
      }
      if (drag.restore) return;

      const car = this.realCar;
      if (!car) return;

      const dx = event.clientX - drag.startX;
      const dy = event.clientY - drag.startY;
      if (!drag.moved && Math.hypot(dx, dy) < CLICK_SLOP_PX) return;
      drag.moved = true;

      // Component of the drag along the part's outward axis on screen.
      const along = (dx * drag.screenDirX + dy * drag.screenDirY) / DRAG_PIXELS_PER_UNIT;
      const offset = Math.max(-4, Math.min(12, drag.startOffset + along));
      drag.offset = offset;
      const delta = offset - drag.startOffset;

      // Apply straight to the scene. Routing every pointermove through the
      // store re-renders the 109-row part list and re-runs the whole rig sync,
      // which locks the page up mid-drag. The store is written once, on release.
      // The offset is written along the part's axis IN ITS ASSEMBLY'S FRAME and
      // added to where it already was, so a part nudged sideways earlier keeps
      // that nudge and a rotated car still pulls parts away from itself.
      car.rig.setNodeTransform(drag.node, {
        ...drag.start,
        x: drag.start.x + drag.axis.x * delta,
        y: drag.start.y + drag.axis.y * delta,
        z: drag.start.z + drag.axis.z * delta,
      });

      const tag = this.hoverTag;
      if (tag) {
        tag.set(this.nodeLabel(drag.node), 'pulled out ' + delta.toFixed(2));
        tag.moveTo(event.clientX, event.clientY);
        tag.show();
      }
      return;
    }

    // A button is down: the camera or the gizmo owns this move.
    if (event.buttons !== 0) return;

    this.hoverDirty = true;
    this.hoverTag?.moveTo(event.clientX, event.clientY);
  };

  private onPointerUp = (event: PointerEvent): void => {
    this.noteModifiers(event);

    const drag = this.partDrag;
    if (drag) {
      this.partDrag = null;
      this.pointerDownAt = null;
      this.releaseCapture(event.pointerId);
      this.syncOrbitEnabled();
      this.hoverDirty = true;
      this.hoverTag?.hide();
      this.updateCursor();

      if (drag.moved) {
        // Settle: one trace line for the whole drag.
        const live = this.realCar?.rig.readNodeTransform(drag.node);
        if (live) this.nodeTransformHandler?.(drag.node, live, true);
        return;
      }

      // No travel: this was a ctrl-CLICK, so act on the part instead.
      this.actuateHandler?.({
        node: drag.node,
        assembly: drag.assembly,
        hinged: drag.hinged,
        restore: drag.restore,
      });
      return;
    }

    const down = this.pointerDownAt;
    const wasGizmo = this.gizmoPress;
    const wasVoid = this.ctrlVoidPress;
    this.pointerDownAt = null;
    this.gizmoPress = false;
    this.ctrlVoidPress = false;
    this.cameraGrab = false;
    this.syncOrbitEnabled();
    this.hoverDirty = true;
    this.updateCursor();

    if (!down || wasGizmo || wasVoid) return;
    if (event.ctrlKey || event.metaKey) return;
    // Orbiting the camera is also a pointerup on the canvas, and selecting a
    // part every time someone spins the view would be maddening.
    if (Math.hypot(event.clientX - down.x, event.clientY - down.y) > CLICK_SLOP_PX) return;

    this.clickSelect(event.clientX, event.clientY);
  };

  private onPointerCancel = (): void => {
    this.endPartDrag();
    this.pointerDownAt = null;
    this.gizmoPress = false;
    this.ctrlVoidPress = false;
    this.cameraGrab = false;
    this.syncOrbitEnabled();
    this.updateCursor();
  };

  /** Fires after our own release too; by then there is no drag left to end. */
  private onLostPointerCapture = (): void => {
    this.endPartDrag();
  };

  private onPointerLeave = (): void => {
    this.pointerInside = false;
    if (this.partDrag) return;
    this.setHover(null);
    this.hoverTag?.hide();
  };

  private releaseCapture(pointerId: number): void {
    try {
      this.renderer?.domElement.releasePointerCapture(pointerId);
    } catch {
      // Already released.
    }
  }

  /** End a Ctrl-drag without acting on the part; commits any travel. */
  private endPartDrag(): void {
    const drag = this.partDrag;
    if (!drag) return;
    this.partDrag = null;
    this.pointerDownAt = null;
    if (drag.moved) {
      const live = this.realCar?.rig.readNodeTransform(drag.node);
      if (live) this.nodeTransformHandler?.(drag.node, live, true);
    }
    this.syncOrbitEnabled();
    this.hoverTag?.hide();
    this.hoverDirty = true;
    this.updateCursor();
  }

  /**
   * Ctrl-wheel over a part scales it.
   *
   * A trackpad pinch ALSO arrives as a ctrl+wheel, with no Control key down.
   * Only a physical Ctrl (or Cmd) means "resize this part"; a pinch is a camera
   * zoom and is left for OrbitControls. Once the wheel is ours it must neither
   * zoom the page (preventDefault) nor dolly the camera as well - OrbitControls
   * listens on the same canvas, and stopImmediatePropagation is what keeps a
   * resize from also flying the camera in.
   */
  private onWheel = (event: WheelEvent): void => {
    const partMode = event.metaKey || (event.ctrlKey && this.ctrlHeld);
    if (!partMode) return;

    event.preventDefault();
    event.stopImmediatePropagation();

    const car = this.realCar;
    if (!car) return;

    // One scroll gesture fires a burst of events. Reuse the pick for the
    // length of the gesture unless the pointer has actually moved elsewhere,
    // so a notch that lands between two parts does not jump targets.
    const now = performance.now();
    const reusable =
      this.lastWheelPick &&
      now - this.lastWheelPick.at < 500 &&
      Math.hypot(
        event.clientX - this.lastWheelPick.x,
        event.clientY - this.lastWheelPick.y,
      ) < 12;

    const found = reusable
      ? this.lastWheelPick!.hit
      : this.pickPart(event.clientX, event.clientY, false);
    if (!found || found.hidden) return;

    this.lastWheelPick = {
      hit: found,
      x: event.clientX,
      y: event.clientY,
      at: now,
    };

    const live = car.rig.readNodeTransform(found.node);
    if (!live) return;

    const factor = event.deltaY < 0 ? 1.08 : 1 / 1.08;
    const scale = Math.max(0.1, Math.min(6, live.scale * factor));

    // Direct again: a wheel gesture is a burst of events, and one store write
    // each would stutter. Commit once the wheel goes quiet.
    car.rig.setNodeTransform(found.node, { ...live, scale });

    const tag = this.hoverTag;
    if (tag) {
      tag.set(this.nodeLabel(found.node), 'scale ' + scale.toFixed(2) + '×');
      tag.moveTo(event.clientX, event.clientY);
      tag.show();
      this.wheelTagUntil = now + WHEEL_TAG_MS;
    }

    window.clearTimeout(this.wheelSettleTimer);
    this.wheelSettleTimer = window.setTimeout(() => {
      const settled = this.realCar?.rig.readNodeTransform(found.node);
      if (settled) this.nodeTransformHandler?.(found.node, settled, true);
    }, 350);
  };

  private wheelSettleTimer = 0;
  private lastWheelPick: {
    hit: PartHit;
    x: number;
    y: number;
    at: number;
  } | null = null;

  /** Double-click a part to fly the camera to it; double-click empty space to fly back. */
  private onDoubleClick = (event: MouseEvent): void => {
    // Two quick Ctrl-clicks are two actuations, already handled.
    if (event.ctrlKey || event.metaKey || event.button !== 0) return;
    if (this.cameraState.autoOrbit) this.cameraTakeoverHandler?.();
    const hit = this.pickPart(event.clientX, event.clientY, false);
    if (hit) this.focusOn('node', hit.node);
    else this.flyHome();
  };

  /**
   * A click selects the assembly under the pointer, or clears the selection
   * on empty space.
   */
  private clickSelect(clientX: number, clientY: number): void {
    const hit = this.realCar ? this.pickPart(clientX, clientY, false) : null;
    const next: Selection | null = hit
      ? { level: 'assembly', id: hit.assembly, label: CAR_PART_LABELS[hit.assembly] }
      : null;

    // Clicking what is already selected is not news, and the trace would
    // otherwise fill with "selected Body Shell" on every double-click.
    const current = this.selection;
    const same =
      (current === null && next === null) ||
      (current !== null &&
        next !== null &&
        current.level === next.level &&
        current.id === next.id);
    if (same) return;

    this.applySelection(next);
    this.selectHandler?.(next);
  }

  onActuate = (handler: (target: ActuateTarget) => void): void => {
    this.actuateHandler = handler;
  };

  onSelect = (handler: (next: Selection | null) => void): void => {
    this.selectHandler = handler;
  };

  onNodeTransformChange = (
    handler: (id: string, next: NodeTransform, settled: boolean) => void,
  ): void => {
    this.nodeTransformHandler = handler;
  };

  onAssemblyTransformChange = (
    handler: (id: CarPartId, next: NodeTransform, settled: boolean) => void,
  ): void => {
    this.assemblyTransformHandler = handler;
  };

  onCameraTakeover = (handler: () => void): void => {
    this.cameraTakeoverHandler = handler;
  };

  listCarNodes = () => (this.realCar ? this.realCar.rig.listNodes() : []);

  /* ---------------------------------------------------------------- */
  /* Hands                                                             */
  /* ---------------------------------------------------------------- */

  pickForHand = (clientX: number, clientY: number, forgiving = true): HandTarget | null => {
    const car = this.realCar;
    if (!car) return null;
    let hit = this.pickPart(clientX, clientY, true);
    // Near misses only once the bounds trees exist: before that every extra
    // ray walks every triangle of the car.
    if (!hit && forgiving && this.pickReady) {
      for (const [dx, dy] of HAND_PICK_RING) {
        hit = this.pickPart(clientX + dx, clientY + dy, true);
        if (hit) break;
      }
    }
    if (!hit) return null;
    const hinged = car.rig.hasHinge(hit.assembly);
    return {
      node: hit.node,
      assembly: hit.assembly,
      hidden: hit.hidden,
      hinged,
      label: hinged && !hit.hidden ? CAR_PART_LABELS[hit.assembly] : this.nodeLabel(hit.node),
    };
  };

  setHandHover = (
    slot: number,
    target: HandTarget | null,
    strength: number,
    holding: boolean,
  ): void => {
    const layer = this.handHighlights[slot];
    if (!layer) return;
    const car = this.realCar;
    // A removed part has no visible surface to glow; the cursor says it.
    if (!car || !target || target.hidden) {
      layer.clear();
      return;
    }
    // A door glows whole, because holding any part of it swings all of it.
    const level: 'assembly' | 'node' = target.hinged ? 'assembly' : 'node';
    const id = target.hinged ? target.assembly : target.node;
    const s = Math.max(0, Math.min(1, strength));
    layer.setIntensity(holding ? 1.25 : 0.4 + 0.6 * s);
    layer.show(level + ':' + id, car.rig.meshesFor(level, id));
  };

  orbitByHand = (dxPx: number, dyPx: number): void => {
    if (this.cameraState.autoOrbit) this.cameraTakeoverHandler?.();
    const orbit = this.orbitControls;
    if (!orbit || this.cameraState.autoOrbit) return;
    this.cameraGlide = null;
    const offset = this.camera.position.clone().sub(orbit.target);
    const spherical = new THREE.Spherical().setFromVector3(offset);
    spherical.theta -= dxPx * HAND_ORBIT_RAD_PER_PX;
    spherical.phi = Math.max(
      0.12,
      Math.min(orbit.maxPolarAngle, spherical.phi - dyPx * HAND_ORBIT_RAD_PER_PX),
    );
    offset.setFromSpherical(spherical);
    this.camera.position.copy(orbit.target).add(offset);
    this.camera.lookAt(orbit.target);
    orbit.update();
  };

  clearHandFeedback = (): void => {
    for (const layer of this.handHighlights) layer.clear();
  };

  grabForHand = (
    target: HandTarget | null,
    clientX: number,
    clientY: number,
  ): HandGrip | null => {
    if (!target) return this.gripModel(clientX, clientY);
    const car = this.realCar;
    if (!car || target.hidden) return null;
    return target.hinged
      ? this.gripHinge(car, target.assembly, clientX, clientY)
      : this.gripNode(car, target.node, clientX, clientY);
  };

  /**
   * Hold a door or the hood. The point the hand grabbed sweeps an arc as the
   * hinge turns; every move finds the hinge value that puts that point
   * nearest the hand on screen. Perpendicular hand motion does nothing, which
   * is exactly how a real door feels.
   */
  private gripHinge(
    car: RealCarHandle,
    assembly: CarPartId,
    clientX: number,
    clientY: number,
  ): HandGrip | null {
    const pivot = car.rig.pivotFor('assembly', assembly);
    if (!pivot || !car.rig.hasHinge(assembly)) return null;

    const grabbed = new THREE.Vector3();
    if (!this.surfacePoint(car.rig.meshesFor('assembly', assembly), clientX, clientY, grabbed)) {
      // The aim locked on a near miss: hold the door by its middle instead.
      if (!car.rig.boundsFor('assembly', assembly, this.scratchBox)) return null;
      this.scratchBox.getCenter(grabbed);
    }
    pivot.updateWorldMatrix(true, false);
    const local = pivot.worldToLocal(grabbed.clone());
    const probe = new THREE.Vector3();
    let value = car.rig.hingeValue(assembly);
    const startValue = value;

    // How far the grabbed point travels on screen over the hinge's whole
    // range decides how to follow the hand (see HINGE_LEVER_PX).
    const lever = this.hingeLever(car, assembly, local, clientX, clientY);

    const state = (): HandGripState => ({ kind: 'hinge', assembly, value });

    return {
      kind: 'hinge',
      move: (x, y) => {
        if (this.realCar !== car || !this.renderer || !pivot.parent) return null;
        if (lever) {
          const along = (x - clientX) * lever.x + (y - clientY) * lever.y;
          value = Math.max(0, Math.min(1, startValue + along / HINGE_LEVER_PX));
          return state();
        }
        const rect = this.renderer.domElement.getBoundingClientRect();
        if (!rect.width || !rect.height) return null;
        pivot.parent.updateWorldMatrix(true, false);
        const from = value;
        const t = solveArc((tt) => {
          if (!car.rig.hingeWorldPoint(assembly, tt, local, probe)) return Infinity;
          probe.project(this.camera);
          if (probe.z > 1) return Infinity;
          const sx = rect.left + ((probe.x + 1) / 2) * rect.width;
          const sy = rect.top + ((1 - probe.y) / 2) * rect.height;
          return Math.hypot(sx - x, sy - y) + HINGE_CONTINUITY_PX * Math.abs(tt - from);
        });
        if (Number.isFinite(t)) value = t;
        return state();
      },
      // Hinge holds write through the store and a tap never moved one.
      cancel: () => {},
      state,
    };
  }

  /**
   * The screen direction a held hinge opens along, when its swing is too
   * foreshortened to follow exactly; null when the exact arc is usable.
   * The direction is the swing's own on-screen chord when there is enough of
   * one to trust, else straight out from the car through the grabbed point:
   * pulling a door away from the car opens it.
   */
  private hingeLever(
    car: RealCarHandle,
    assembly: CarPartId,
    local: THREE.Vector3,
    clientX: number,
    clientY: number,
  ): { x: number; y: number } | null {
    const pivot = car.rig.pivotFor('assembly', assembly);
    if (!pivot?.parent || !this.renderer) return null;
    pivot.parent.updateWorldMatrix(true, false);
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    if (!car.rig.hingeWorldPoint(assembly, 0, local, a)) return null;
    if (!car.rig.hingeWorldPoint(assembly, 1, local, b)) return null;
    const sa = this.worldToClient(a);
    const sb = this.worldToClient(b);
    if (!sa || !sb) return null;
    const cx = sb.x - sa.x;
    const cy = sb.y - sa.y;
    const chord = Math.hypot(cx, cy);
    if (chord >= HINGE_LEVER_PX) return null;
    if (chord > 12) return { x: cx / chord, y: cy / chord };

    const centre = this.worldToClient(this.modelPivot.getWorldPosition(new THREE.Vector3()));
    if (centre) {
      const ox = clientX - centre.x;
      const oy = clientY - centre.y;
      const len = Math.hypot(ox, oy);
      if (len > 1) return { x: ox / len, y: oy / len };
    }
    return { x: 1, y: 0 };
  }

  /** A world point in viewport pixels, or null behind the camera. */
  private worldToClient(point: THREE.Vector3): { x: number; y: number } | null {
    if (!this.renderer) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const p = point.clone().project(this.camera);
    if (p.z > 1) return null;
    return {
      x: rect.left + ((p.x + 1) / 2) * rect.width,
      y: rect.top + ((1 - p.y) / 2) * rect.height,
    };
  }

  /**
   * Hold any other part and carry it in the plane through the grabbed point
   * that faces the camera: up is up, left is left, and the part keeps its
   * distance. Writes the scene directly, like a Ctrl-drag.
   */
  private gripNode(
    car: RealCarHandle,
    node: string,
    clientX: number,
    clientY: number,
  ): HandGrip | null {
    const pivot = car.rig.pivotFor('node', node);
    const parent = pivot?.parent;
    if (!pivot || !parent) return null;

    const start = car.rig.readNodeTransform(node) ?? { ...IDENTITY_NODE_TRANSFORM };
    const grabbed = new THREE.Vector3();
    if (!this.surfacePoint(car.rig.meshesFor('node', node), clientX, clientY, grabbed)) {
      pivot.getWorldPosition(grabbed);
    }
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(
      this.camera.getWorldDirection(new THREE.Vector3()),
      grabbed,
    );
    const hit = new THREE.Vector3();
    const from = new THREE.Vector3();
    const to = new THREE.Vector3();
    const lim = NODE_LIMITS.offset;
    const clampOffset = (v: number) => Math.max(lim.min, Math.min(lim.max, v));
    let current: NodeTransform = { ...start };

    const state = (): HandGripState => ({ kind: 'node', node, transform: { ...current } });

    return {
      kind: 'node',
      move: (x, y) => {
        if (this.realCar !== car || !this.aimRay(x, y)) return null;
        if (!this.raycaster.ray.intersectPlane(plane, hit)) return null;
        parent.updateWorldMatrix(true, false);
        // Both ends through the parent's CURRENT frame, so an assembly still
        // easing outward from an explode does not read as hand travel.
        parent.worldToLocal(from.copy(grabbed));
        parent.worldToLocal(to.copy(hit));
        current = {
          ...start,
          x: clampOffset(start.x + to.x - from.x),
          y: clampOffset(start.y + to.y - from.y),
          z: clampOffset(start.z + to.z - from.z),
        };
        car.rig.setNodeTransform(node, current);
        return state();
      },
      cancel: () => {
        current = { ...start };
        if (this.realCar === car) car.rig.setNodeTransform(node, start);
      },
      state,
    };
  }

  /** Hold the whole car, carried the same way. Returned, never written. */
  private gripModel(clientX: number, clientY: number): HandGrip {
    const start = this.modelTarget.position.clone();
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(
      this.camera.getWorldDirection(new THREE.Vector3()),
      start,
    );
    const grabbed = new THREE.Vector3();
    if (!this.aimRay(clientX, clientY) || !this.raycaster.ray.intersectPlane(plane, grabbed)) {
      grabbed.copy(start);
    }
    const hit = new THREE.Vector3();
    const current = start.clone();
    const within = (v: number, r: { min: number; max: number }) =>
      Math.max(r.min, Math.min(r.max, v));

    const state = (): HandGripState => ({
      kind: 'model',
      position: { x: current.x, y: current.y, z: current.z },
    });

    return {
      kind: 'model',
      move: (x, y) => {
        if (!this.aimRay(x, y) || !this.raycaster.ray.intersectPlane(plane, hit)) return null;
        current.set(
          within(start.x + hit.x - grabbed.x, LIMITS.positionX),
          within(start.y + hit.y - grabbed.y, LIMITS.positionY),
          within(start.z + hit.z - grabbed.z, LIMITS.positionZ),
        );
        return state();
      },
      cancel: () => {},
      state,
    };
  }

  /* ---------------------------------------------------------------- */
  /* Hover feedback                                                    */
  /* ---------------------------------------------------------------- */

  private setHover(hit: PartHit | null): void {
    const prev = this.hover;
    const same =
      prev === hit ||
      (prev !== null &&
        hit !== null &&
        prev.node === hit.node &&
        prev.hidden === hit.hidden);
    if (same) return;
    this.hover = hit;
    this.hoverSince = performance.now();
    this.refreshHoverVisuals();
  }

  /**
   * Without Ctrl, hover shows the ASSEMBLY a click would select. With Ctrl it
   * narrows to the single part the gesture will act on, at full strength.
   */
  private refreshHoverVisuals(): void {
    const car = this.realCar;
    const hit = this.hover;
    if (!car || !hit || hit.hidden) {
      this.hoverHighlight.clear();
      return;
    }
    const ctrl = this.ctrlHeld;
    const level: 'assembly' | 'node' = ctrl ? 'node' : 'assembly';
    const id = ctrl ? hit.node : hit.assembly;

    // Hovering what is already selected: the selection glow says enough.
    const sel = this.selection;
    if (sel && sel.level === level && sel.id === id) {
      this.hoverHighlight.clear();
      return;
    }
    this.hoverHighlight.setIntensity(ctrl ? 1 : 0.55);
    this.hoverHighlight.show(level + ':' + id, car.rig.meshesFor(level, id));
  }

  private refreshSelectionHighlight(): void {
    const car = this.realCar;
    const sel = this.selection;
    if (!car || !sel) {
      this.selectHighlight.clear();
      return;
    }
    this.selectHighlight.show(sel.level + ':' + sel.id, car.rig.meshesFor(sel.level, sel.id));
    this.refreshHoverVisuals();
  }

  /** Runs once per frame: picks at the pointer and updates tag + cursor. */
  private updateHover(): void {
    const car = this.realCar;
    const busy =
      this.partDrag !== null ||
      this.pointerDownAt !== null ||
      this.gizmoDragging ||
      this.cameraGrab;

    if (!car || !this.pointerInside || busy) {
      if (!car || !this.pointerInside) this.setHover(null);
      if (!this.partDrag && performance.now() > this.wheelTagUntil) this.hoverTag?.hide();
      this.updateCursor();
      return;
    }

    // Before the bounds trees exist a pick walks every triangle of the car,
    // so hover simply waits for them rather than stalling the first seconds.
    if (this.pickReady) {
      // Re-pick every other frame even when the pointer is still: the camera
      // glides and parts swing, and what is under a resting pointer changes.
      this.hoverParity = !this.hoverParity;
      if (this.hoverDirty || this.hoverParity) {
        this.hoverDirty = false;
        this.setHover(
          this.pickPart(this.lastPointer.x, this.lastPointer.y, this.ctrlHeld),
        );
      }
    }

    this.updateTag();
    this.updateCursor();
  }

  private updateTag(): void {
    const tag = this.hoverTag;
    if (!tag) return;
    const now = performance.now();
    if (now < this.wheelTagUntil) return;

    const hit = this.hover;
    const car = this.realCar;
    if (!hit || !car) {
      tag.hide();
      return;
    }

    const ctrl = this.ctrlHeld;
    // Without Ctrl the name waits for the pointer to rest, so sweeping across
    // the car does not strobe labels.
    if (!ctrl && (hit.hidden || now - this.hoverSince < HOVER_REST_MS)) {
      tag.hide();
      return;
    }

    let name: string;
    let hint: string;
    if (!ctrl) {
      name = CAR_PART_LABELS[hit.assembly];
      hint = 'click select · hold ' + MOD_KEY + ' for part tools · double-click focus';
    } else if (hit.hidden) {
      name = this.nodeLabel(hit.node);
      hint = 'click to put it back';
    } else {
      name = this.nodeLabel(hit.node);
      hint =
        (car.rig.hasHinge(hit.assembly) ? 'click open/close' : 'click pop off') +
        ' · drag pull out · scroll resize';
    }
    tag.set(name, hint);
    tag.moveTo(this.lastPointer.x, this.lastPointer.y);
    tag.show();
  }

  private updateCursor(): void {
    const canvas = this.renderer?.domElement;
    if (!canvas) return;

    let cursor: string;
    if (this.partDrag) cursor = this.partDrag.restore ? 'copy' : 'grabbing';
    else if (this.gizmoDragging || this.cameraGrab) cursor = 'grabbing';
    else if (this.editMode !== 'orbit' && this.transformControls?.axis) cursor = 'grab';
    else if (this.hover && !(this.hover.hidden && !this.ctrlHeld)) {
      cursor = this.ctrlHeld ? (this.hover.hidden ? 'copy' : 'move') : 'pointer';
    } else if (this.ctrlHeld) cursor = 'default';
    else cursor = 'grab';

    if (cursor !== this.cursor) {
      this.cursor = cursor;
      canvas.style.cursor = cursor;
    }
  }

  /* ---------------------------------------------------------------- */
  /* Controls                                                          */
  /* ---------------------------------------------------------------- */

  /** Point the gizmo at whatever is selected, or back at the whole model. */
  private applySelection(next: Selection | null): void {
    this.selection = next;
    this.applyEditMode(this.editMode);
    this.refreshSelectionHighlight();
  }

  private setupControls(): void {
    if (!this.renderer || this.orbitControls) return;
    const canvas = this.renderer.domElement;

    const orbit = new OrbitControls(this.camera, canvas);
    orbit.enableDamping = true;
    orbit.dampingFactor = 0.08;
    orbit.target.set(0, 0.8, 0);
    orbit.minDistance = ORBIT_MIN_DISTANCE;
    orbit.maxDistance = LIMITS.cameraDistance.max;
    // Zoom towards whatever is under the pointer, which is how you get close
    // to a door handle without first panning the whole car around.
    orbit.zoomToCursor = true;
    // Stop the user flying under the terrain, which looks broken.
    orbit.maxPolarAngle = Math.PI * 0.495;
    orbit.enabled = false;
    this.orbitControls = orbit;

    const transform = new TransformControls(this.camera, canvas);
    // Smaller gizmo: at full size the axis handles swamp the object.
    transform.setSize(0.62);
    // three r169: TransformControls extends Controls, not Object3D. The thing
    // you add to the scene is its helper.
    const helper = transform.getHelper();
    helper.visible = false;
    stripGizmoClutter(helper);
    this.scene.add(helper);
    this.transformHelper = helper;

    transform.addEventListener('dragging-changed', (event) => {
      const dragging = Boolean(event.value);
      this.gizmoDragging = dragging;
      if (dragging) {
        const target = transform.object;
        this.gizmoStartScale = target ? target.scale.x : 1;
      }
      this.syncOrbitEnabled();
      this.updateCursor();
      if (!dragging) this.emitTransform(true);
    });

    transform.addEventListener('objectChange', () => {
      this.emitTransform(false);
    });

    this.transformControls = transform;
    this.applyEditMode(this.editMode);
  }

  /** Read the gizmo's target back out and hand it to the store. */
  private emitTransform(settled: boolean): void {
    if (this.suppressTransformEvents) return;

    // A part selection routes to the part's own handler, so dragging a wing
    // mirror or a door never rewrites the car's placement.
    const sel = this.selection;
    const car = this.realCar;
    if (sel && car) {
      if (sel.level === 'node') {
        const next = car.rig.readNodeTransform(sel.id);
        const pivot = car.rig.pivotFor('node', sel.id);
        if (next && pivot) {
          next.scale = dominantScale(pivot.scale, this.gizmoStartScale);
          this.nodeTransformHandler?.(sel.id, next, settled);
        }
        return;
      }
      const id = sel.id as CarPartId;
      const next = car.rig.readAssemblyTransform(id);
      const pivot = car.rig.pivotFor('assembly', id);
      if (next && pivot) {
        next.scale = dominantScale(pivot.scale, this.gizmoStartScale);
        this.assemblyTransformHandler?.(id, next, settled);
      }
      return;
    }

    if (!this.transformHandler) return;
    const p = this.modelPivot.position;
    const r = this.modelPivot.rotation;
    this.transformHandler(
      {
        position: { x: p.x, y: p.y, z: p.z },
        rotationDeg: {
          x: THREE.MathUtils.radToDeg(r.x),
          y: THREE.MathUtils.radToDeg(r.y),
          z: THREE.MathUtils.radToDeg(r.z),
        },
        scale: dominantScale(this.modelPivot.scale, this.gizmoStartScale),
      },
      settled,
    );
  }

  onTransformChange = (
    handler: (next: TransformState, settled: boolean) => void,
  ): void => {
    this.transformHandler = handler;
  };

  private applyEditMode(mode: EditMode): void {
    this.editMode = mode;
    const transform = this.transformControls;
    if (!transform) return;

    if (mode === 'orbit') {
      transform.detach();
      if (this.transformHelper) this.transformHelper.visible = false;
      this.updateCursor();
      return;
    }

    // Bind to the selected assembly or node when there is one, otherwise to
    // the whole model. Selecting a door handle and dragging moves only that.
    const target =
      this.selection && this.realCar
        ? this.realCar.rig.pivotFor(this.selection.level, this.selection.id)
        : null;

    transform.attach(target ?? this.modelPivot);
    transform.setMode(mode);
    if (this.transformHelper) this.transformHelper.visible = true;
  }

  /* ---------------------------------------------------------------- */
  /* Model swapping                                                    */
  /* ---------------------------------------------------------------- */

  /**
   * Mount a handle as the centrepiece. `owns` is false for the photo relief.
   * `animate` pops it in; the very first mount of the page does not, because
   * it replaces an identical placeholder and a bounce there reads as a glitch.
   */
  private mountModel(handle: ModelHandle, owns: boolean, animate = true): void {
    // Overlays are children of the outgoing meshes; take them off before those
    // meshes are disposed, and forget any hover that pointed into them.
    this.hoverHighlight.reset();
    this.selectHighlight.reset();
    for (const layer of this.handHighlights) layer.reset();
    this.hover = null;
    this.cancelPickBuild?.();
    this.cancelPickBuild = null;
    this.pickReady = false;
    this.lastWheelPick = null;

    if (this.model) {
      if (this.ownsModel) this.model.dispose();
      else this.model.group.removeFromParent();
    }
    // Anything mounted that is not the glTF car has no rig to drive.
    this.realCar = null;
    this.nodeLabels = new Map();
    this.appliedRig = null;
    this.appliedRigSource = null;
    this.model = handle;
    this.ownsModel = owns;
    handle.setColors('#' + this.shownGrid.getHexString(), '#' + this.shownAccent.getHexString());
    this.spinPivot.add(handle.group);

    this.mountT = animate && !this.reducedMotion ? 0 : 1;
    this.spinPivot.scale.setScalar(this.mountT < 1 ? MOUNT_FROM : 1);
  }

  private swapModel(key: ModelKey): void {
    this.modelKey = key;
    const animate = this.prev !== null;

    if (key === 'photo') {
      if (!this.photoRelief) return;
      this.statusPill?.hide();
      this.mountModel(this.photoRelief, false, animate);
      return;
    }

    if (key === 'engine') {
      this.statusPill?.hide();
      this.mountModel(buildEngineNode(this.gridHex, this.accentHex), true, animate);
      return;
    }

    // Both car variants show the parametric car immediately, so the stage is
    // never empty while the 11 MB glTF streams in.
    this.mountModel(buildCarModule(this.gridHex, this.accentHex), true, animate);

    if (key !== 'car:real') {
      this.statusPill?.hide();
      return;
    }

    const token = ++this.carLoadToken;
    this.statusPill?.show('Streaming the concept car', 0);

    void loadRealCar(
      this.gridHex,
      this.accentHex,
      (fraction) => {
        if (token === this.carLoadToken) this.statusPill?.setProgress(fraction);
      },
      this.carModelUrl,
    )
      .then((handle) => {
        // The load is slow enough that the user or an agent can have moved on.
        if (this.disposed || token !== this.carLoadToken || this.modelKey !== 'car:real') {
          handle.dispose();
          return;
        }
        this.mountModel(handle, true, true);
        this.realCar = handle;
        this.nodeLabels = new Map(handle.rig.listNodes().map((n) => [n.id, n.label]));
        // The rig arrives long after the state that configured it, so replay
        // whatever the store currently says instead of waiting for a change,
        // and land it immediately rather than animating from the rest pose.
        this.appliedRig = null;
        this.appliedRigSource = null;
        if (this.prev) this.syncRig(this.prev.carRig);
        handle.rig.settle();
        this.refreshSelectionHighlight();
        const parts = handle.rig.listNodes().length;
        this.statusPill?.done(
          (this.carModelUrl ? 'Car ready' : 'Concept car ready') + ' \u00b7 ' + parts + ' parts',
        );
        this.carLoadWaiter?.(parts);
        this.carLoadWaiter = null;
        this.carLoadFailer = null;

        this.cancelPickBuild = buildBoundsTreesWhenIdle(handle.rig.allMeshes(), () => {
          if (this.realCar !== handle) return;
          this.pickReady = true;
          this.hoverDirty = true;
        });
      })
      .catch(() => {
        // Stay on the parametric car. A missing asset must not empty the scene.
        if (token === this.carLoadToken) {
          this.statusPill?.fail(
            this.carModelUrl
              ? 'That model could not be loaded \u00b7 showing the parametric model'
              : 'Concept car unavailable \u00b7 showing the parametric model',
          );
          this.carLoadFailer?.(new Error('the model could not be loaded'));
          this.carLoadWaiter = null;
          this.carLoadFailer = null;
        }
      });
  }

  /**
   * Push finish / explode / door / hood / hidden-part state into the loaded
   * car. Cheap no-op when nothing changed, so it is safe on every apply().
   * Explode, doors and hood are TARGETS: the rig springs towards them.
   */
  private syncRig(next: CarRigState): void {
    const car = this.realCar;
    if (!car) return;

    // Same object as last time means nothing rig-related moved.
    if (next === this.appliedRigSource) return;
    this.appliedRigSource = next;

    const prev = this.appliedRig;

    if (!prev || prev.finish !== next.finish) car.rig.setFinish(next.finish);
    if (!prev || prev.explode !== next.explode) car.rig.setExplode(next.explode);
    if (!prev || prev.doorLeft !== next.doorLeft) {
      car.rig.setDoor('left', next.doorLeft);
    }
    if (!prev || prev.doorRight !== next.doorRight) {
      car.rig.setDoor('right', next.doorRight);
    }
    if (!prev || prev.hood !== next.hood) car.rig.setHood(next.hood);

    // Part reshaping. Compared by identity per part: the store replaces the
    // edits object on every change, so an unchanged part keeps the same
    // PartEdit reference and is skipped without a deep compare.
    const prevEdits = prev ? prev.edits : {};
    const nextEdits = next.edits;
    const touched = new Set<string>([
      ...Object.keys(prevEdits),
      ...Object.keys(nextEdits),
    ]);
    for (const key of touched) {
      const id = key as CarPartId;
      const before = prevEdits[id];
      const after = nextEdits[id];
      if (before === after) continue;
      car.rig.setPartEdit(
        id,
        after ?? {
          scaleX: 1,
          scaleY: 1,
          scaleZ: 1,
          inflate: 0,
          twistDeg: 0,
          material: null,
        },
      );
    }

    // Whole-assembly placement from the gizmo, by identity per assembly.
    const prevPlaced = prev ? prev.assemblyTransforms : {};
    const nextPlaced = next.assemblyTransforms ?? {};
    const placed = new Set<string>([
      ...Object.keys(prevPlaced),
      ...Object.keys(nextPlaced),
    ]);
    for (const key of placed) {
      const id = key as CarPartId;
      const before = prevPlaced[id];
      const after = nextPlaced[id];
      if (before === after) continue;
      car.rig.setAssemblyTransform(id, after ?? IDENTITY_NODE_TRANSFORM);
    }

    // Individually hidden meshes.
    const prevNodesHidden = prev ? prev.hiddenNodes : [];
    const nodesHiddenChanged =
      !prev ||
      prevNodesHidden.length !== next.hiddenNodes.length ||
      next.hiddenNodes.some((id, i) => prevNodesHidden[i] !== id);
    if (nodesHiddenChanged) car.rig.setNodeHidden(next.hiddenNodes);

    // Per-node free transforms. Compared by reference: the store replaces
    // only the entry that changed, so an untouched node keeps its identity.
    const prevNodeT = prev ? prev.nodeTransforms : {};
    const nextNodeT = next.nodeTransforms;
    const touchedNodes = new Set<string>([
      ...Object.keys(prevNodeT),
      ...Object.keys(nextNodeT),
    ]);
    for (const id of touchedNodes) {
      const before = prevNodeT[id];
      const after = nextNodeT[id];
      if (before === after) continue;
      car.rig.setNodeTransform(id, after ?? IDENTITY_NODE_TRANSFORM);
    }

    // Selection drives what the gizmo is attached to and what glows.
    const prevSel = prev ? prev.selection : undefined;
    const sameSelection =
      prevSel !== undefined &&
      ((prevSel === null && next.selection === null) ||
        (prevSel !== null &&
          next.selection !== null &&
          prevSel.level === next.selection.level &&
          prevSel.id === next.selection.id));
    if (!sameSelection) {
      this.selection = next.selection;
      this.applyEditMode(this.editMode);
      this.refreshSelectionHighlight();
    }

    const changedHidden =
      !prev ||
      prev.hidden.length !== next.hidden.length ||
      next.hidden.some((id, i) => prev.hidden[i] !== id);
    if (changedHidden) car.rig.setHidden(next.hidden as CarPartId[]);

    this.appliedRig = {
      ...next,
      hidden: [...next.hidden],
      hiddenNodes: [...next.hiddenNodes],
      nodeTransforms: { ...next.nodeTransforms },
      assemblyTransforms: { ...(next.assemblyTransforms ?? {}) },
      selection: next.selection ? { ...next.selection } : null,
      edits: { ...next.edits },
    };
  }

  /* ---------------------------------------------------------------- */
  /* Photo relief                                                      */
  /* ---------------------------------------------------------------- */

  measureCarPart = (id: CarPartId) => {
    if (!this.realCar) return null;
    // Measure the pose the store describes, not a frame of a swing in flight.
    this.realCar.rig.settle();
    return this.realCar.rig.measurePart(id);
  };

  setPhotoRelief = (input: PhotoReliefInput): void => {
    if (this.disposed) return;

    const wasActive = this.modelKey === 'photo';
    if (this.photoRelief) {
      if (wasActive) this.photoRelief.group.removeFromParent();
      this.photoRelief.dispose();
      this.photoRelief = null;
    }

    this.photoRelief = buildPhotoRelief(input, this.gridHex);
    // Mount it straight away when photo mode is already selected; otherwise it
    // waits for apply() to switch modelType.
    if (wasActive) this.mountModel(this.photoRelief, false);
  };

  clearPhotoRelief = (): void => {
    if (!this.photoRelief) return;
    if (this.modelKey === 'photo') {
      this.modelKey = 'car:parametric';
      this.mountModel(buildCarModule(this.gridHex, this.accentHex), true);
    }
    this.photoRelief.dispose();
    this.photoRelief = null;
  };

  hasPhotoRelief = (): boolean => this.photoRelief !== null;

  setCarModel = (url: string | null): Promise<{ parts: number }> => {
    this.carModelUrl = url;
    // A request still waiting is superseded, not left hanging.
    this.carLoadFailer?.(new Error('replaced by another model'));
    return new Promise((resolve, reject) => {
      this.carLoadWaiter = (parts) => resolve({ parts });
      this.carLoadFailer = reject;
      // Reload only when the glTF car is showing; otherwise the choice waits
      // for the next time the real car is selected.
      if (this.modelKey === 'car:real') this.swapModel('car:real');
      else {
        this.carLoadWaiter = null;
        this.carLoadFailer = null;
        resolve({ parts: 0 });
      }
    });
  };

  private resize = (): void => {
    if (!this.renderer || !this.container) return;
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    // updateStyle=false: the canvas is sized by CSS (100% of its layout box).
    this.renderer.setSize(width, height, false);
  };

  /* ---------------------------------------------------------------- */
  /* Reconcile                                                         */
  /* ---------------------------------------------------------------- */

  apply = (state: WiredState): void => {
    const prev = this.prev;
    const first = prev === null;

    /* --- palette: a glide, except on the very first apply ------------- */

    const gridChanged = first || prev.gridColorHex !== state.gridColorHex;
    const accentChanged = first || prev.accentColorHex !== state.accentColorHex;

    if (gridChanged || accentChanged) {
      this.gridHex = state.gridColorHex;
      this.accentHex = state.accentColorHex;
      this.toGrid.set(this.gridHex);
      this.toAccent.set(this.accentHex);
      if (first || this.reducedMotion) {
        this.shownGrid.copy(this.toGrid);
        this.shownAccent.copy(this.toAccent);
        this.colorT = 1;
        this.applyShownColors();
      } else {
        this.fromGrid.copy(this.shownGrid);
        this.fromAccent.copy(this.shownAccent);
        this.colorT = 0;
      }
    }

    // Model swap - only when the resolved key genuinely changed. 'photo' falls
    // back to the car when no reconstruction exists yet, because the store can
    // legitimately be ahead of the pipeline.
    const carKey: ModelKey =
      state.carVariant === 'real' ? 'car:real' : 'car:parametric';
    const desiredKey: ModelKey =
      state.modelType === 'engine'
        ? 'engine'
        : state.modelType === 'photo'
          ? this.photoRelief
            ? 'photo'
            : carKey
          : carKey;

    if (desiredKey !== this.modelKey) this.swapModel(desiredKey);

    // After any potential swap, so a freshly mounted car gets the live rig.
    this.syncRig(state.carRig);

    /* --- placement: a target the frame loop eases towards ------------- */

    const t = state.transform;
    const prevT = prev ? prev.transform : null;
    const transformChanged =
      !prevT ||
      prevT.position.x !== t.position.x ||
      prevT.position.y !== t.position.y ||
      prevT.position.z !== t.position.z ||
      prevT.rotationDeg.x !== t.rotationDeg.x ||
      prevT.rotationDeg.y !== t.rotationDeg.y ||
      prevT.rotationDeg.z !== t.rotationDeg.z ||
      prevT.scale !== t.scale;

    if (transformChanged) {
      this.modelTarget.position.set(t.position.x, t.position.y, t.position.z);
      this.scratchEuler.set(
        THREE.MathUtils.degToRad(t.rotationDeg.x),
        THREE.MathUtils.degToRad(t.rotationDeg.y),
        THREE.MathUtils.degToRad(t.rotationDeg.z),
      );
      this.modelTarget.quaternion.setFromEuler(this.scratchEuler);
      this.modelTarget.scale = t.scale;

      // The gizmo is dragging this very pivot: land exactly where it says, or
      // the frame loop would ease against the drag. Same for the first frame.
      if (first || this.reducedMotion || this.gizmoDragging) this.snapModel();
      else this.modelSettled = false;
    }

    if (first || prev.editMode !== state.editMode) {
      this.applyEditMode(state.editMode);
    }

    if (first || prev.waveAmplitude !== state.waveAmplitude) {
      this.terrain.setAmplitude(state.waveAmplitude);
    }
    this.waveVelocity = state.waveVelocity;

    if (first || prev.fogDensity !== state.fogDensity) {
      this.fog.density = state.fogDensity;
    }

    if (first || prev.nodes.count !== state.nodes.count) {
      this.nodes.setCount(state.nodes.count);
    }
    if (first || prev.nodes.spread !== state.nodes.spread) {
      this.nodes.setSpread(state.nodes.spread);
    }
    if (first || prev.nodes.colorHex !== state.nodes.colorHex) {
      this.nodes.setColor(state.nodes.colorHex);
    }
    if (first || prev.nodes.floatSpeed !== state.nodes.floatSpeed) {
      this.nodes.setFloatSpeed(state.nodes.floatSpeed);
    }

    /* --- camera ---------------------------------------------------------- */

    const wasAuto = prev ? prev.camera.autoOrbit : state.camera.autoOrbit;
    const framingChanged =
      !first &&
      (prev.camera.preset !== state.camera.preset ||
        prev.camera.distance !== state.camera.distance ||
        prev.camera.height !== state.camera.height);

    this.cameraState = {
      preset: state.camera.preset,
      distance: state.camera.distance,
      height: state.camera.height,
      autoOrbit: state.camera.autoOrbit,
    };

    if (first) {
      this.cameraInitialised = false;
      this.cameraSnapped = false;
    } else if (wasAuto !== state.camera.autoOrbit) {
      if (state.camera.autoOrbit) this.enterScriptedOrbit();
      else this.enterManualCamera();
    }
    if (framingChanged && !state.camera.autoOrbit) this.pendingFraming = true;

    // Synchronously, not next frame: a takeover from inside a pointerdown must
    // enable the orbit before OrbitControls' own listener sees that same event.
    this.syncOrbitEnabled();
    this.updateCursor();

    this.prev = {
      ...state,
      camera: { ...state.camera },
      nodes: { ...state.nodes },
      transform: {
        position: { ...state.transform.position },
        rotationDeg: { ...state.transform.rotationDeg },
        scale: state.transform.scale,
      },
      carRig: { ...state.carRig, hidden: [...state.carRig.hidden] },
    };
  };

  /* ---------------------------------------------------------------- */
  /* Pulse                                                             */
  /* ---------------------------------------------------------------- */

  pulse = (intensity: number, durationMs: number): void => {
    if (!Number.isFinite(intensity) || !Number.isFinite(durationMs)) return;
    this.pulseIntensity = Math.max(0.2, intensity);
    this.pulseDuration = Math.max(0.05, durationMs / 1000);
    this.pulseStart = this.elapsed;
    this.pulseActive = true;
  };

  /** 1 at rest; spikes to pulseIntensity and eases back with a cosine falloff. */
  private pulseFactor(): number {
    if (!this.pulseActive) return 1;
    const t = (this.elapsed - this.pulseStart) / this.pulseDuration;
    if (t >= 1 || t < 0) {
      this.pulseActive = false;
      return 1;
    }
    const ease = 0.5 * (1 + Math.cos(Math.PI * t));
    return 1 + (this.pulseIntensity - 1) * ease;
  }

  /* ---------------------------------------------------------------- */
  /* Motion                                                            */
  /* ---------------------------------------------------------------- */

  private applyShownColors(): void {
    const grid = '#' + this.shownGrid.getHexString();
    const accent = '#' + this.shownAccent.getHexString();
    this.terrain.setColor(grid);
    this.gridLight.color.copy(this.shownGrid);
    this.accentLight.color.copy(this.shownAccent);
    this.model.setColors(grid, accent);
    this.selectHighlight.setColor(this.shownGrid);
  }

  private snapModel(): void {
    this.suppressTransformEvents = true;
    try {
      this.modelPivot.position.copy(this.modelTarget.position);
      this.modelPivot.quaternion.copy(this.modelTarget.quaternion);
      this.modelPivot.scale.setScalar(this.modelTarget.scale);
      this.modelPivot.updateMatrixWorld(true);
    } finally {
      // An exception that left the flag set would deafen the gizmo for good.
      this.suppressTransformEvents = false;
    }
    this.modelSettled = true;
  }

  /** Land every glide on its target. `includeCamera` also ends a camera glide. */
  private settleMotion(includeCamera: boolean): void {
    this.realCar?.rig.settle();
    if (!this.modelSettled) this.snapModel();
    if (this.colorT < 1) {
      this.colorT = 1;
      this.shownGrid.copy(this.toGrid);
      this.shownAccent.copy(this.toAccent);
      this.applyShownColors();
    }
    if (this.mountT < 1) {
      this.mountT = 1;
      this.spinPivot.scale.setScalar(1);
    }
    if (includeCamera && this.cameraGlide) {
      this.cameraGlide.t = 1;
      this.stepCameraGlide(0);
    }
  }

  private stepMotion(dt: number): void {
    const instant = this.reducedMotion;

    this.realCar?.rig.update(dt, instant);

    if (!this.modelSettled) {
      if (instant) {
        this.snapModel();
      } else {
        const p = this.modelPivot;
        const k = 1 - Math.exp(-dt * MODEL_FOLLOW_RATE);
        p.position.lerp(this.modelTarget.position, k);
        p.quaternion.slerp(this.modelTarget.quaternion, k);
        p.scale.setScalar(p.scale.x + (this.modelTarget.scale - p.scale.x) * k);
        const close =
          p.position.distanceToSquared(this.modelTarget.position) < 1e-8 &&
          p.quaternion.angleTo(this.modelTarget.quaternion) < 1e-4 &&
          Math.abs(p.scale.x - this.modelTarget.scale) < 1e-4;
        if (close) this.snapModel();
      }
    }

    if (this.colorT < 1) {
      this.colorT = instant ? 1 : Math.min(1, this.colorT + dt / COLOR_GLIDE_SECONDS);
      const e = easeInOutCubic(this.colorT);
      this.shownGrid.lerpColors(this.fromGrid, this.toGrid, e);
      this.shownAccent.lerpColors(this.fromAccent, this.toAccent, e);
      this.applyShownColors();
    }

    if (this.mountT < 1) {
      this.mountT = instant ? 1 : Math.min(1, this.mountT + dt / MOUNT_SECONDS);
      const s = MOUNT_FROM + (1 - MOUNT_FROM) * easeOutBack(this.mountT);
      this.spinPivot.scale.setScalar(this.mountT >= 1 ? 1 : s);
    }
  }

  /* ---------------------------------------------------------------- */
  /* Camera                                                            */
  /* ---------------------------------------------------------------- */

  /** Where the manual camera rests for the current preset, distance and height. */
  private restingPose(): { position: THREE.Vector3; target: THREE.Vector3 } {
    const cam = this.cameraState;
    const framing = PRESET_FRAMING[cam.preset] ?? PRESET_FRAMING.orbit;
    const radius = Math.max(1.5, cam.distance * framing.radiusScale);
    const height = cam.height + framing.heightBias;
    return {
      position: new THREE.Vector3(
        Math.sin(framing.azimuth) * radius,
        height,
        Math.cos(framing.azimuth) * radius,
      ),
      target: new THREE.Vector3(0, framing.lookAtY, 0),
    };
  }

  /**
   * Glide the manual camera to a new pose. Interpolated on a sphere around a
   * moving target, so swinging from the front of the car to the back arcs
   * around it instead of cutting straight through the bodywork.
   */
  private startCameraGlide(position: THREE.Vector3, target: THREE.Vector3, duration: number): void {
    const orbit = this.orbitControls;
    const fromTarget = (orbit ? orbit.target : this.lookTarget).clone();

    if (this.reducedMotion || duration <= 0) {
      this.camera.position.copy(position);
      if (orbit) {
        orbit.target.copy(target);
        orbit.update();
      } else {
        this.camera.lookAt(target);
      }
      this.lookTarget.copy(target);
      this.cameraGlide = null;
      this.syncOrbitEnabled();
      return;
    }

    const from = new THREE.Spherical().setFromVector3(
      this.camera.position.clone().sub(fromTarget),
    );
    const to = new THREE.Spherical().setFromVector3(position.clone().sub(target));
    // Shortest way round.
    let dTheta = to.theta - from.theta;
    while (dTheta > Math.PI) dTheta -= Math.PI * 2;
    while (dTheta < -Math.PI) dTheta += Math.PI * 2;
    to.theta = from.theta + dTheta;

    this.cameraGlide = {
      t: 0,
      duration,
      fromTarget,
      toTarget: target.clone(),
      from,
      to,
    };
    this.syncOrbitEnabled();
  }

  private readonly glideTarget = new THREE.Vector3();
  private readonly glideSpherical = new THREE.Spherical();

  private stepCameraGlide(dt: number): void {
    const glide = this.cameraGlide;
    if (!glide) return;
    glide.t = Math.min(1, glide.t + (glide.duration > 0 ? dt / glide.duration : 1));
    const e = easeInOutCubic(glide.t);

    this.glideTarget.lerpVectors(glide.fromTarget, glide.toTarget, e);
    // Radius in log space: zooming from 20 to 2 should feel even, not rush
    // through the far half and crawl the near one.
    const r0 = Math.max(0.001, glide.from.radius);
    const r1 = Math.max(0.001, glide.to.radius);
    this.glideSpherical.set(
      Math.exp(Math.log(r0) + (Math.log(r1) - Math.log(r0)) * e),
      glide.from.phi + (glide.to.phi - glide.from.phi) * e,
      glide.from.theta + (glide.to.theta - glide.from.theta) * e,
    );
    this.camera.position.setFromSpherical(this.glideSpherical).add(this.glideTarget);
    this.camera.lookAt(this.glideTarget);
    this.lookTarget.copy(this.glideTarget);
    if (this.orbitControls) this.orbitControls.target.copy(this.glideTarget);

    if (glide.t >= 1) {
      this.cameraGlide = null;
      this.syncOrbitEnabled();
    }
  }

  /** Frame a part: close enough to read it, never inside it. */
  private focusOn(level: 'assembly' | 'node', id: string): void {
    const car = this.realCar;
    if (!car || this.cameraState.autoOrbit) return;
    if (!car.rig.boundsFor(level, id, this.scratchBox)) return;
    this.scratchBox.getBoundingSphere(this.scratchSphere);

    const radius = Math.max(0.3, this.scratchSphere.radius);
    const target = this.scratchSphere.center.clone();
    const halfFov = THREE.MathUtils.degToRad(this.camera.fov) / 2;
    const distance = THREE.MathUtils.clamp(
      (radius / Math.sin(halfFov)) * 1.25,
      ORBIT_MIN_DISTANCE + 0.2,
      LIMITS.cameraDistance.max,
    );

    // Keep the current viewing direction; only the distance and aim change.
    const from = this.orbitControls ? this.orbitControls.target : this.lookTarget;
    const dir = this.camera.position.clone().sub(from);
    if (dir.lengthSq() < 1e-6) dir.set(1, 0.6, 1);
    dir.normalize();
    const position = target.clone().addScaledVector(dir, distance);
    // Not below the ground plane: the terrain would fill the frame.
    position.y = Math.max(position.y, 0.35);

    this.startCameraGlide(position, target, FOCUS_GLIDE_SECONDS);
  }

  private flyHome(): void {
    if (this.cameraState.autoOrbit) return;
    const rest = this.restingPose();
    this.startCameraGlide(rest.position, rest.target, FOCUS_GLIDE_SECONDS);
  }

  /** Scripted orbit -> manual, keeping the exact view the user grabbed. */
  private enterManualCamera(): void {
    this.cameraGlide = null;
    const orbit = this.orbitControls;
    if (orbit) {
      orbit.target.copy(this.lookTarget);
      orbit.update();
    }
    this.cameraInitialised = true;
  }

  /** Manual -> scripted orbit, continuing from where the camera already is. */
  private enterScriptedOrbit(): void {
    this.cameraGlide = null;
    this.azimuth = Math.atan2(this.camera.position.x, this.camera.position.z);
    if (this.orbitControls) this.lookTarget.copy(this.orbitControls.target);
    this.cameraSnapped = true;
  }

  private updateCamera(dt: number): void {
    const cam = this.cameraState;
    const framing = PRESET_FRAMING[cam.preset] ?? PRESET_FRAMING.orbit;

    /* --- manual: OrbitControls owns the camera ------------------------ */

    if (!cam.autoOrbit) {
      const orbit = this.orbitControls;

      if (!this.cameraInitialised) {
        // Seat the camera at the preset's resting spot ONCE, then hand over.
        const rest = this.restingPose();
        this.azimuth = framing.azimuth;
        this.camera.position.copy(rest.position);
        this.lookTarget.copy(rest.target);
        if (orbit) {
          orbit.target.copy(rest.target);
          orbit.update();
        } else {
          this.camera.lookAt(rest.target);
        }
        this.cameraGlide = null;
        this.pendingFraming = false;
        this.cameraSnapped = true;
        this.cameraInitialised = true;
      } else if (this.pendingFraming) {
        this.pendingFraming = false;
        const rest = this.restingPose();
        this.startCameraGlide(rest.position, rest.target, PRESET_GLIDE_SECONDS);
      }

      if (this.cameraGlide) this.stepCameraGlide(dt);
      // Exactly one of the two may write the camera on any given frame.
      // Running both is the classic "camera jitters and fights you" bug.
      this.syncOrbitEnabled();
      if (!this.cameraGlide && orbit) {
        orbit.update();
        this.lookTarget.copy(orbit.target);
      }
      return;
    }

    /* --- scripted orbit ----------------------------------------------- */

    this.cameraGlide = null;
    this.syncOrbitEnabled();

    const radius = Math.max(1.5, cam.distance * framing.radiusScale);
    const height = cam.height + framing.heightBias;

    this.azimuth += dt * framing.orbitSpeed;

    const targetX = Math.sin(this.azimuth) * radius;
    const targetZ = Math.cos(this.azimuth) * radius;

    const k = 1 - Math.exp(-dt * 4);
    if (!this.cameraSnapped) {
      this.camera.position.set(targetX, height, targetZ);
      this.lookTarget.set(0, framing.lookAtY, 0);
      this.cameraSnapped = true;
    } else {
      this.camera.position.x += (targetX - this.camera.position.x) * k;
      this.camera.position.y += (height - this.camera.position.y) * k;
      this.camera.position.z += (targetZ - this.camera.position.z) * k;
      // The aim eases too, so leaving a close-up focus does not whip the view.
      this.lookTarget.x += (0 - this.lookTarget.x) * k;
      this.lookTarget.y += (framing.lookAtY - this.lookTarget.y) * k;
      this.lookTarget.z += (0 - this.lookTarget.z) * k;
    }

    this.camera.lookAt(this.lookTarget);
  }

  /* ---------------------------------------------------------------- */
  /* Frame                                                             */
  /* ---------------------------------------------------------------- */

  private frame = (): void => {
    if (!this.renderer) return;

    const dt = Math.min(0.1, this.clock.getDelta());
    this.elapsed += dt;
    const elapsed = this.elapsed;
    const boost = this.pulseFactor();

    this.stepMotion(dt);

    // Partly additive on purpose: a purely multiplicative boost makes
    // pulse_reality_wave a silent no-op at waveVelocity 0, which is both a
    // legal value and one the tool description advertises. At rest boost is
    // exactly 1, so the added term is 0 and the baseline is untouched.
    this.terrain.update(elapsed, this.waveVelocity * boost + (boost - 1) * 0.8);
    this.nodes.update(elapsed);
    this.model.update(elapsed);

    // No idle spin. The object holds the placement it was given, by hand or by
    // tool call, until something explicitly changes it.
    this.spinPivot.rotation.y = this.spinAngle;

    this.gridLight.intensity = GRID_LIGHT_BASE * boost;
    this.accentLight.intensity = ACCENT_LIGHT_BASE * boost;

    this.updateCamera(dt);
    this.updateHover();
    this.hoverHighlight.update(dt, elapsed);
    this.selectHighlight.update(dt, elapsed);
    for (const layer of this.handHighlights) layer.update(dt, elapsed);

    this.renderer.render(this.scene, this.camera);
  };

  /* ---------------------------------------------------------------- */
  /* Capture                                                           */
  /* ---------------------------------------------------------------- */

  capture = (maxWidth = 640): SceneSnapshot | null => {
    if (!this.renderer) return null;
    try {
      // The agent asked what the scene IS: land every glide first, and leave
      // hover and selection glows out of the picture - they are this viewer's
      // pointer, not part of the design.
      this.settleMotion(true);
      this.hoverHighlight.setCaptureHidden(true);
      this.selectHighlight.setCaptureHidden(true);
      for (const layer of this.handHighlights) layer.setCaptureHidden(true);

      try {
        this.renderer.render(this.scene, this.camera);
        const source = this.renderer.domElement;
        const sourceWidth = source.width;
        const sourceHeight = source.height;
        if (!sourceWidth || !sourceHeight) return null;

        let dataUrl: string;
        let width = sourceWidth;
        let height = sourceHeight;

        // maxWidth bounds the LONGEST edge, which is what the tool schema
        // promises the agent. Bounding width alone would return a 640x1385
        // image on a portrait phone and blow the payload budget the agent
        // reasoned about.
        const longest = Math.max(sourceWidth, sourceHeight);
        if (longest > maxWidth && typeof document !== 'undefined') {
          const scale = maxWidth / longest;
          width = Math.max(1, Math.round(sourceWidth * scale));
          height = Math.max(1, Math.round(sourceHeight * scale));
          const offscreen = document.createElement('canvas');
          offscreen.width = width;
          offscreen.height = height;
          const ctx = offscreen.getContext('2d');
          if (!ctx) return null;
          ctx.drawImage(source, 0, 0, width, height);
          dataUrl = offscreen.toDataURL('image/jpeg', 0.72);
        } else {
          dataUrl = source.toDataURL('image/jpeg', 0.72);
        }

        const comma = dataUrl.indexOf(',');
        const base64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;

        return { dataUrl, base64, mimeType: 'image/jpeg', width, height };
      } finally {
        this.hoverHighlight.setCaptureHidden(false);
        this.selectHighlight.setCaptureHidden(false);
        for (const layer of this.handHighlights) layer.setCaptureHidden(false);
      }
    } catch {
      return null;
    }
  };

  /* ---------------------------------------------------------------- */
  /* Teardown                                                          */
  /* ---------------------------------------------------------------- */

  dispose = (): void => {
    this.disposed = true;
    if (this.renderer) this.renderer.setAnimationLoop(null);
    this.clock.stop();

    this.cancelPickBuild?.();
    this.cancelPickBuild = null;
    window.clearTimeout(this.wheelSettleTimer);

    if (this.transformControls) {
      this.transformControls.detach();
      // NOT .dispose(): in three r0.169 TransformControls extends Controls,
      // which is not an Object3D, but its dispose() still calls this.traverse()
      // and therefore always throws. That exception used to abort the rest of
      // this teardown, so the renderer was never released and the next mount
      // came up with a dead canvas. disconnect() is the half that matters
      // (it removes the pointer listeners); the geometry is freed below.
      this.transformControls.disconnect();
      this.transformControls = null;
    }
    if (this.transformHelper) {
      disposeObject3D(this.transformHelper);
      this.transformHelper = null;
    }
    this.transformHandler = null;

    if (this.orbitControls) {
      this.orbitControls.dispose();
      this.orbitControls = null;
    }

    if (this.photoRelief) {
      this.photoRelief.dispose();
      this.photoRelief = null;
    }

    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
    if (typeof window !== 'undefined' && this.windowListeners) {
      this.windowListeners = false;
      window.removeEventListener('resize', this.resize);
      window.removeEventListener('keydown', this.onKeyDown);
      window.removeEventListener('keyup', this.onKeyUp);
      window.removeEventListener('blur', this.onWindowBlur);
    }
    this.motionQuery?.removeEventListener('change', this.onMotionPreference);
    this.motionQuery = null;

    if (this.canvasWithListeners) {
      const canvas = this.canvasWithListeners;
      canvas.removeEventListener('pointerdown', this.onPointerDown);
      canvas.removeEventListener('pointermove', this.onPointerMove);
      canvas.removeEventListener('pointerup', this.onPointerUp);
      canvas.removeEventListener('pointercancel', this.onPointerCancel);
      canvas.removeEventListener('lostpointercapture', this.onLostPointerCapture);
      canvas.removeEventListener('pointerleave', this.onPointerLeave);
      canvas.removeEventListener('dblclick', this.onDoubleClick);
      canvas.removeEventListener('wheel', this.onWheel);
      canvas.removeEventListener('webglcontextlost', this.onContextLost);
      canvas.removeEventListener('webglcontextrestored', this.onContextRestored);
      this.canvasWithListeners = null;
    }

    // Overlays hang off the car's meshes; off before those are disposed.
    this.hoverHighlight.dispose();
    this.selectHighlight.dispose();
    for (const layer of this.handHighlights) layer.dispose();
    this.hoverTag?.dispose();
    this.hoverTag = null;
    this.statusPill?.dispose();
    this.statusPill = null;

    if (this.ownsModel) this.model.dispose();
    this.terrain.dispose();
    this.nodes.dispose();

    // Sweep anything the sub-modules did not own. disposeObject3D already
    // de-duplicates shared geometries/materials and clears the root.
    disposeObject3D(this.scene);

    if (this.renderer) {
      const canvas = this.renderer.domElement;
      if (canvas.parentElement) canvas.parentElement.removeChild(canvas);
      this.renderer.dispose();
      this.renderer = null;
    }

    this.container = null;
    this.prev = null;
  };
}

export function createWiredEngine(): WiredEngine {
  return new Engine();
}
