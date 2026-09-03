/**
 * Wired Future — the three.js engine.
 *
 * Implements the frozen WiredEngine contract. It knows nothing about React,
 * zustand or WebMCP: it is handed a full WiredState and reconciles the live
 * scene against it. Every expensive operation (model rebuild, node placement)
 * is guarded behind a "did this field actually change" check, so apply() is
 * safe to call on every single store emission.
 *
 * Scene graph:
 *   scene
 *     +- terrain.mesh          wireframe ground, mutated in place
 *     +- modelPivot            yaw-spun by the engine
 *     |    +- model.group      car or engine node
 *     +- nodes.group           floating cluster
 *     +- ambient / gridLight / accentLight
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';

import { CAR_PART_LABELS, LIMITS } from '@/store/use-wired';
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
import type { PhotoReliefInput, SceneSnapshot, WiredEngine } from './contract';
import { loadRealCar, type RealCarHandle } from './car-real';
import { buildPhotoRelief } from './photo-relief';
import {
  buildCarModule,
  buildEngineNode,
  disposeObject3D,
  type ModelHandle,
} from './models';

/**
 * Which centrepiece is mounted. Combines modelType and carVariant into one
 * comparable key so the swap logic stays a single equality check.
 */
type ModelKey = 'car:real' | 'car:parametric' | 'engine' | 'photo';
import { createNodeCluster, type NodeCluster } from './nodes';
import { createTerrain, type Terrain } from './terrain';

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
   * Inner pivot carrying the idle spin. The OUTER modelPivot carries the user's
   * placement and is what the gizmo attaches to - if the spin were written to
   * the same object it would overwrite a rotate drag on the very next frame.
   */
  private readonly spinPivot: THREE.Group;
  private spinAngle = 0;
  private modelKey: ModelKey = 'car:parametric';
  /** False when `model` is the shared photo relief, which the engine owns. */
  private ownsModel = true;
  private carLoadToken = 0;
  /** Set only while the loaded glTF car is the mounted model. */
  private realCar: RealCarHandle | null = null;
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
  private actuateHandler:
    | ((target: { node: string; assembly: CarPartId; hinged: boolean }) => void)
    | null = null;

  /**
   * Live ctrl-drag on a single part. Held here rather than in the store so the
   * per-frame maths never round-trips through React.
   */
  private partDrag: {
    node: string;
    assembly: CarPartId;
    hinged: boolean;
    startX: number;
    startY: number;
    /** Outward direction projected into screen space, normalised. */
    screenDirX: number;
    screenDirY: number;
    /** Node offset along `outward` when the drag began. */
    startOffset: number;
    moved: boolean;
  } | null = null;
  private nodeTransformHandler:
    | ((id: string, next: NodeTransform, settled: boolean) => void)
    | null = null;

  /** What the gizmo is bound to. null means the whole model pivot. */
  private selection: Selection | null = null;
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  /** Where the pointer went down, so a camera drag is not read as a click. */
  private pointerDownAt: { x: number; y: number } | null = null;
  /** Set while apply() writes the pivot, so our own write cannot echo back. */
  private suppressTransformEvents = false;
  private editMode: EditMode = 'orbit';
  /** False until the camera has been handed over to OrbitControls. */
  private manualCameraReady = false;
  private disposed = false;

  private renderer: THREE.WebGLRenderer | null = null;
  private container: HTMLElement | null = null;
  private observer: ResizeObserver | null = null;
  private canvasWithListeners: HTMLCanvasElement | null = null;

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
      canvas.addEventListener('pointerdown', this.onPointerDown);
      canvas.addEventListener('pointermove', this.onPointerMove);
      canvas.addEventListener('pointerup', this.onPointerUpCapture);
      canvas.addEventListener('pointerup', this.onPointerUp);
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
    this.resize();

    if (typeof ResizeObserver !== 'undefined' && !this.observer) {
      this.observer = new ResizeObserver(() => this.resize());
      this.observer.observe(container);
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('resize', this.resize);
    }

    this.setupControls();

    if (!this.clock.running) this.clock.start();
    this.cameraSnapped = false;
    this.renderer.setAnimationLoop(this.frame);
  };

  /* ---------------------------------------------------------------- */
  /* Controls                                                          */
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

  /** Raycast the pointer against the car and report what it hit. */
  private pickAt(
    clientX: number,
    clientY: number,
  ): { node: string; assembly: CarPartId } | null {
    if (!this.renderer) return null;
    const car = this.realCar;
    if (!car) return null;

    const rect = this.renderer.domElement.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    this.pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);

    const hits = this.raycaster.intersectObject(car.rig.root, true);
    if (!hits.length) return null;
    return car.rig.identify(hits[0].object);
  }

  private onPointerDown = (event: PointerEvent): void => {
    this.pointerDownAt = { x: event.clientX, y: event.clientY };
    this.partDrag = null;

    // Ctrl (or Cmd) arms direct part manipulation. Without it the pointer
    // belongs to the camera.
    if (!(event.ctrlKey || event.metaKey)) return;

    const car = this.realCar;
    const found = this.pickAt(event.clientX, event.clientY);
    if (!car || !found) return;

    const outward = car.rig.nodeOutwardWorld(found.node);
    const current = car.rig.readNodeTransform(found.node);
    if (!outward || !current) return;

    // Project the part's outward axis into screen space so dragging "away
    // from the car" always pushes the part out, whatever the camera angle.
    const pivot = car.rig.pivotFor('node', found.node);
    const origin = pivot
      ? pivot.getWorldPosition(new THREE.Vector3())
      : new THREE.Vector3();
    const a = this.projectToScreen(origin);
    const b = this.projectToScreen(origin.clone().add(outward));
    let dx = 0;
    let dy = -1;
    if (a && b) {
      const vx = b.x - a.x;
      const vy = b.y - a.y;
      const len = Math.hypot(vx, vy);
      if (len > 0.001) {
        dx = vx / len;
        dy = vy / len;
      }
    }

    const startOffset =
      current.x * outward.x + current.y * outward.y + current.z * outward.z;

    this.partDrag = {
      node: found.node,
      assembly: found.assembly,
      hinged: car.rig.hasHinge(found.assembly),
      startX: event.clientX,
      startY: event.clientY,
      screenDirX: dx,
      screenDirY: dy,
      startOffset,
      moved: false,
    };

    // The camera must not orbit while a part is being pulled out.
    if (this.orbitControls) this.orbitControls.enabled = false;
    this.renderer?.domElement.setPointerCapture?.(event.pointerId);
  };

  /** Pixels of drag per world unit of travel. Tuned by feel. */
  private static readonly DRAG_PIXELS_PER_UNIT = 90;

  private onPointerMove = (event: PointerEvent): void => {
    const drag = this.partDrag;
    const car = this.realCar;
    if (!drag || !car) return;

    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    drag.moved = true;

    // Component of the drag along the part's outward axis on screen.
    const along =
      (dx * drag.screenDirX + dy * drag.screenDirY) /
      Engine.DRAG_PIXELS_PER_UNIT;

    const outward = car.rig.nodeOutwardWorld(drag.node);
    if (!outward) return;

    const offset = Math.max(-4, Math.min(12, drag.startOffset + along));
    const live = car.rig.readNodeTransform(drag.node);
    if (!live) return;

    // Apply straight to the scene. Routing every pointermove through the store
    // re-renders the 109-row part list and re-runs the whole rig sync, which
    // locks the page up mid-drag. The store is written once, on release.
    car.rig.setNodeTransform(drag.node, {
      ...live,
      x: outward.x * offset,
      y: outward.y * offset,
      z: outward.z * offset,
    });
  };

  private onPointerUpCapture = (event: PointerEvent): void => {
    const drag = this.partDrag;
    this.partDrag = null;
    this.renderer?.domElement.releasePointerCapture?.(event.pointerId);

    if (this.orbitControls) {
      this.orbitControls.enabled = !this.cameraState.autoOrbit;
    }

    if (!drag) return;

    if (drag.moved) {
      // Settle: one trace line for the whole drag.
      const live = this.realCar?.rig.readNodeTransform(drag.node);
      if (live) this.nodeTransformHandler?.(drag.node, live, true);
      return;
    }

    // No travel: this was a ctrl-CLICK, so actuate the part instead.
    this.actuateHandler?.({
      node: drag.node,
      assembly: drag.assembly,
      hinged: drag.hinged,
    });
  };

  /**
   * Ctrl-wheel over a part scales it. preventDefault is essential: without it
   * Chrome zooms the whole page instead, which is jarring and undoes the layout.
   */
  private onWheel = (event: WheelEvent): void => {
    if (!(event.ctrlKey || event.metaKey)) return;
    const car = this.realCar;
    if (!car) return;

    // One scroll gesture fires a burst of events, and each raycast walks every
    // triangle of the car. Reuse the pick for the length of the gesture unless
    // the pointer has actually moved somewhere else.
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
      : this.pickAt(event.clientX, event.clientY);
    if (!found) return;

    this.lastWheelPick = {
      hit: found,
      x: event.clientX,
      y: event.clientY,
      at: now,
    };

    event.preventDefault();

    const live = car.rig.readNodeTransform(found.node);
    if (!live) return;

    const factor = event.deltaY < 0 ? 1.08 : 1 / 1.08;
    const scale = Math.max(0.1, Math.min(6, live.scale * factor));

    // Direct again: a wheel gesture is a burst of events, and one store write
    // each would stutter. Commit once the wheel goes quiet.
    car.rig.setNodeTransform(found.node, { ...live, scale });

    window.clearTimeout(this.wheelSettleTimer);
    this.wheelSettleTimer = window.setTimeout(() => {
      const settled = this.realCar?.rig.readNodeTransform(found.node);
      if (settled) this.nodeTransformHandler?.(found.node, settled, true);
    }, 350);
  };

  private wheelSettleTimer = 0;
  private lastWheelPick: {
    hit: { node: string; assembly: CarPartId };
    x: number;
    y: number;
    at: number;
  } | null = null;

  onActuate = (
    handler: (target: { node: string; assembly: CarPartId; hinged: boolean }) => void,
  ): void => {
    this.actuateHandler = handler;
  };

  /**
   * Treat this as a click only if the pointer barely moved. Orbiting the camera
   * is also a pointerup on the canvas, and selecting a part every time someone
   * spins the view would be maddening.
   */
  private onPointerUp = (event: PointerEvent): void => {
    const down = this.pointerDownAt;
    this.pointerDownAt = null;
    // A ctrl gesture is handled by onPointerUpCapture, not here.
    if (event.ctrlKey || event.metaKey) return;
    if (!down || !this.renderer || !this.container) return;
    if (Math.hypot(event.clientX - down.x, event.clientY - down.y) > 4) return;

    const rect = this.renderer.domElement.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

    this.raycaster.setFromCamera(this.pointer, this.camera);

    const car = this.realCar;
    const target = car ? car.rig.root : this.spinPivot;
    const hits = this.raycaster.intersectObject(target, true);

    if (!hits.length) {
      this.applySelection(null);
      this.selectHandler?.(null);
      return;
    }

    // Ctrl/Cmd drills into the individual mesh; a plain click takes the
    // assembly it belongs to.
    const fine = event.ctrlKey || event.metaKey;
    const found = car ? car.rig.identify(hits[0].object) : null;

    if (!found) {
      this.applySelection(null);
      this.selectHandler?.(null);
      return;
    }

    const next: Selection = fine
      ? {
          level: 'node',
          id: found.node,
          label:
            car?.rig.listNodes().find((n) => n.id === found.node)?.label ??
            found.node,
        }
      : {
          level: 'assembly',
          id: found.assembly,
          label: CAR_PART_LABELS[found.assembly],
        };

    this.applySelection(next);
    this.selectHandler?.(next);
  };

  onSelect = (handler: (next: Selection | null) => void): void => {
    this.selectHandler = handler;
  };

  onNodeTransformChange = (
    handler: (id: string, next: NodeTransform, settled: boolean) => void,
  ): void => {
    this.nodeTransformHandler = handler;
  };

  listCarNodes = () => (this.realCar ? this.realCar.rig.listNodes() : []);

  /** Point the gizmo at whatever is selected, or back at the whole model. */
  private applySelection(next: Selection | null): void {
    this.selection = next;
    this.applyEditMode(this.editMode);
  }

  private setupControls(): void {
    if (!this.renderer || this.orbitControls) return;
    const canvas = this.renderer.domElement;

    const orbit = new OrbitControls(this.camera, canvas);
    orbit.enableDamping = true;
    orbit.dampingFactor = 0.08;
    orbit.target.set(0, 0.8, 0);
    orbit.minDistance = LIMITS.cameraDistance.min;
    orbit.maxDistance = LIMITS.cameraDistance.max;
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
      // A drag must not also orbit the camera.
      if (this.orbitControls) {
        this.orbitControls.enabled = dragging
          ? false
          : !this.cameraState.autoOrbit;
      }
      if (!dragging) this.emitTransform(true);
    });

    transform.addEventListener('objectChange', () => {
      this.emitTransform(false);
    });

    this.transformControls = transform;
    this.applyEditMode(this.editMode);
  }

  /** Read the pivot back out and hand it to the store. */
  private emitTransform(settled: boolean): void {
    if (this.suppressTransformEvents) return;

    // A node selection routes to the node handler instead of the whole-object
    // one, so dragging a wing mirror does not rewrite the car's placement.
    const sel = this.selection;
    if (sel && sel.level === 'node' && this.realCar) {
      const next = this.realCar.rig.readNodeTransform(sel.id);
      if (next) this.nodeTransformHandler?.(sel.id, next, settled);
      return;
    }
    if (sel && sel.level === 'assembly') return;

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
        scale: this.modelPivot.scale.x,
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

  /** Mount a handle as the centrepiece. `owns` is false for the photo relief. */
  private mountModel(handle: ModelHandle, owns: boolean): void {
    if (this.model) {
      if (this.ownsModel) this.model.dispose();
      else this.model.group.removeFromParent();
    }
    // Anything mounted that is not the glTF car has no rig to drive.
    this.realCar = null;
    this.appliedRig = null;
    this.appliedRigSource = null;
    this.model = handle;
    this.ownsModel = owns;
    handle.setColors(this.gridHex, this.accentHex);
    this.spinPivot.add(handle.group);
  }

  private swapModel(key: ModelKey): void {
    this.modelKey = key;

    if (key === 'photo') {
      if (!this.photoRelief) return;
      this.mountModel(this.photoRelief, false);
      return;
    }

    if (key === 'engine') {
      this.mountModel(buildEngineNode(this.gridHex, this.accentHex), true);
      return;
    }

    // Both car variants show the parametric car immediately, so the stage is
    // never empty while the 11 MB glTF streams in.
    this.mountModel(buildCarModule(this.gridHex, this.accentHex), true);

    if (key !== 'car:real') return;

    const token = ++this.carLoadToken;
    void loadRealCar(this.gridHex, this.accentHex)
      .then((handle) => {
        // The load is slow enough that the user or an agent can have moved on.
        if (this.disposed || token !== this.carLoadToken || this.modelKey !== 'car:real') {
          handle.dispose();
          return;
        }
        this.mountModel(handle, true);
        this.realCar = handle;
        // The rig arrives long after the state that configured it, so replay
        // whatever the store currently says instead of waiting for a change.
        this.appliedRig = null;
        this.appliedRigSource = null;
        if (this.prev) this.syncRig(this.prev.carRig);
      })
      .catch(() => {
        // Stay on the parametric car. A missing asset must not empty the scene.
      });
  }

  /**
   * Push finish / explode / door / hood / hidden-part state into the loaded
   * car. Cheap no-op when nothing changed, so it is safe on every apply().
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

    // Individually hidden meshes.
    const prevNodesHidden = prev ? prev.hiddenNodes : [];
    const nodesHiddenChanged =
      !prev ||
      prevNodesHidden.length !== next.hiddenNodes.length ||
      next.hiddenNodes.some((id, i) => prevNodesHidden[i] !== id);
    if (nodesHiddenChanged) car.rig.setNodeHidden(next.hiddenNodes);

    // Per-node free transforms. Compared by reference: the store replaces the
    // map on any change, so an untouched node keeps its object identity.
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
      car.rig.setNodeTransform(
        id,
        after ?? { x: 0, y: 0, z: 0, rotX: 0, rotY: 0, rotZ: 0, scale: 1 },
      );
    }

    // Selection drives what the gizmo is attached to.
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
      selection: next.selection ? { ...next.selection } : null,
      edits: { ...next.edits },
    };
  }

  /* ---------------------------------------------------------------- */
  /* Photo relief                                                      */
  /* ---------------------------------------------------------------- */

  measureCarPart = (id: CarPartId) => {
    if (!this.realCar) return null;
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

    const gridChanged = !prev || prev.gridColorHex !== state.gridColorHex;
    const accentChanged = !prev || prev.accentColorHex !== state.accentColorHex;

    if (gridChanged) {
      this.gridHex = state.gridColorHex;
      this.terrain.setColor(state.gridColorHex);
      this.gridLight.color.set(state.gridColorHex);
    }
    if (accentChanged) {
      this.accentHex = state.accentColorHex;
      this.accentLight.color.set(state.accentColorHex);
    }
    if (gridChanged || accentChanged) {
      this.model.setColors(this.gridHex, this.accentHex);
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

    /* --- placement -------------------------------------------------- */

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
      // Guard in a try/finally: an exception here that left the flag set would
      // silently deafen the gizmo for the rest of the session.
      this.suppressTransformEvents = true;
      try {
        this.modelPivot.position.set(t.position.x, t.position.y, t.position.z);
        this.modelPivot.rotation.set(
          THREE.MathUtils.degToRad(t.rotationDeg.x),
          THREE.MathUtils.degToRad(t.rotationDeg.y),
          THREE.MathUtils.degToRad(t.rotationDeg.z),
        );
        this.modelPivot.scale.setScalar(t.scale);
        this.modelPivot.updateMatrixWorld(true);
      } finally {
        this.suppressTransformEvents = false;
      }
    }

    if (!prev || prev.editMode !== state.editMode) {
      this.applyEditMode(state.editMode);
    }

    if (!prev || prev.waveAmplitude !== state.waveAmplitude) {
      this.terrain.setAmplitude(state.waveAmplitude);
    }
    this.waveVelocity = state.waveVelocity;

    if (!prev || prev.fogDensity !== state.fogDensity) {
      this.fog.density = state.fogDensity;
    }

    if (!prev || prev.nodes.count !== state.nodes.count) {
      this.nodes.setCount(state.nodes.count);
    }
    if (!prev || prev.nodes.spread !== state.nodes.spread) {
      this.nodes.setSpread(state.nodes.spread);
    }
    if (!prev || prev.nodes.colorHex !== state.nodes.colorHex) {
      this.nodes.setColor(state.nodes.colorHex);
    }
    if (!prev || prev.nodes.floatSpeed !== state.nodes.floatSpeed) {
      this.nodes.setFloatSpeed(state.nodes.floatSpeed);
    }

    // Any change to the framing means the manual camera must be re-seated
    // before OrbitControls takes over again.
    if (
      !prev ||
      prev.camera.autoOrbit !== state.camera.autoOrbit ||
      prev.camera.preset !== state.camera.preset ||
      prev.camera.distance !== state.camera.distance ||
      prev.camera.height !== state.camera.height
    ) {
      this.manualCameraReady = false;
    }

    this.cameraState = {
      preset: state.camera.preset,
      distance: state.camera.distance,
      height: state.camera.height,
      autoOrbit: state.camera.autoOrbit,
    };

    if (this.orbitControls && this.editMode !== 'orbit') {
      // While the gizmo is armed the camera stays put unless the user grabs it.
      this.orbitControls.enabled = !state.camera.autoOrbit;
    }

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
  /* Frame                                                             */
  /* ---------------------------------------------------------------- */

  private frame = (): void => {
    if (!this.renderer) return;

    const dt = Math.min(0.1, this.clock.getDelta());
    this.elapsed += dt;
    const elapsed = this.elapsed;
    const boost = this.pulseFactor();

    // Partly additive on purpose: a purely multiplicative boost makes
    // pulse_reality_wave a silent no-op at waveVelocity 0, which is both a
    // legal value and one the tool description advertises. At rest boost is
    // exactly 1, so the added term is 0 and the baseline is untouched.
    this.terrain.update(elapsed, this.waveVelocity * boost + (boost - 1) * 0.8);
    this.nodes.update(elapsed);
    this.model.update(elapsed);

    // No idle spin. The object holds the placement it was given, by hand or by
    // tool call, until something explicitly changes it. The spin pivot stays in
    // the graph so a future "spin it" control has somewhere to write.
    this.spinPivot.rotation.y = this.spinAngle;

    this.gridLight.intensity = GRID_LIGHT_BASE * boost;
    this.accentLight.intensity = ACCENT_LIGHT_BASE * boost;

    this.updateCamera(dt);

    this.renderer.render(this.scene, this.camera);
  };

  private updateCamera(dt: number): void {
    const cam = this.cameraState;
    const framing = PRESET_FRAMING[cam.preset] ?? PRESET_FRAMING.orbit;

    const radius = Math.max(1.5, cam.distance * framing.radiusScale);
    const height = cam.height + framing.heightBias;

    /* --- manual: OrbitControls owns the camera ------------------------ */

    if (!cam.autoOrbit) {
      // Exactly one of the two may write the camera on any given frame.
      // Running both is the classic "camera jitters and fights you" bug.
      if (this.orbitControls) this.orbitControls.enabled = true;

      if (!this.manualCameraReady) {
        // Seat the camera at the preset's resting spot ONCE, then hand over.
        this.azimuth = framing.azimuth;
        this.camera.position.set(
          Math.sin(this.azimuth) * radius,
          height,
          Math.cos(this.azimuth) * radius,
        );
        if (this.orbitControls) {
          this.orbitControls.target.set(0, framing.lookAtY, 0);
          this.orbitControls.update();
        } else {
          this.camera.lookAt(0, framing.lookAtY, 0);
        }
        this.cameraSnapped = true;
        this.manualCameraReady = true;
        return;
      }

      this.orbitControls?.update();
      return;
    }

    /* --- scripted orbit ----------------------------------------------- */

    if (this.orbitControls) this.orbitControls.enabled = false;
    this.manualCameraReady = false;

    this.azimuth += dt * framing.orbitSpeed;

    const targetX = Math.sin(this.azimuth) * radius;
    const targetZ = Math.cos(this.azimuth) * radius;

    if (!this.cameraSnapped) {
      this.camera.position.set(targetX, height, targetZ);
      this.cameraSnapped = true;
    } else {
      const k = 1 - Math.exp(-dt * 4);
      this.camera.position.x += (targetX - this.camera.position.x) * k;
      this.camera.position.y += (height - this.camera.position.y) * k;
      this.camera.position.z += (targetZ - this.camera.position.z) * k;
    }

    this.camera.lookAt(0, framing.lookAtY, 0);
  }

  /* ---------------------------------------------------------------- */
  /* Capture                                                           */
  /* ---------------------------------------------------------------- */

  capture = (maxWidth = 640): SceneSnapshot | null => {
    if (!this.renderer) return null;
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
      // promises the agent. Bounding width alone would return a 640x1385 image
      // on a portrait phone and blow the payload budget the agent reasoned about.
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
    if (typeof window !== 'undefined') {
      window.removeEventListener('resize', this.resize);
    }
    if (this.canvasWithListeners) {
      this.canvasWithListeners.removeEventListener('pointerdown', this.onPointerDown);
      this.canvasWithListeners.removeEventListener('pointermove', this.onPointerMove);
      this.canvasWithListeners.removeEventListener('pointerup', this.onPointerUpCapture);
      this.canvasWithListeners.removeEventListener('pointerup', this.onPointerUp);
      this.canvasWithListeners.removeEventListener('wheel', this.onWheel);
      window.clearTimeout(this.wheelSettleTimer);
      this.canvasWithListeners.removeEventListener('webglcontextlost', this.onContextLost);
      this.canvasWithListeners.removeEventListener(
        'webglcontextrestored',
        this.onContextRestored,
      );
      this.canvasWithListeners = null;
    }

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
