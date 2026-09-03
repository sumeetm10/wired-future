'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';

import {
  CAMERA_PRESETS,
  CAR_FINISHES,
  CAR_PART_IDS,
  CAR_PART_LABELS,
  CAR_VARIANTS,
  IDENTITY_EDIT,
  PART_EDIT_LIMITS,
  PART_MATERIAL_IDS,
  EDIT_MODES,
  LIMITS,
  MODEL_TYPES,
  SCENE_PRESET_NAMES,
  SCENE_PRESETS,
  useWired,
} from '@/store/use-wired';
import type {
  CameraPreset,
  CarFinish,
  CarPartId,
  CarVariant,
  PartEdit,
  PartMaterialId,
  EditMode,
  ModelType,
  ScenePresetName,
  WiredState,
} from '@/store/use-wired';

/* ------------------------------------------------------------------ */
/* Throttled writer                                                    */
/* ------------------------------------------------------------------ */

/**
 * `input[type=color]` and `input[type=range]` fire continuously while the
 * pointer is down. Every raw event would become a store write and a log line,
 * so writes are throttled: leading edge fires immediately (the scene reacts
 * instantly), the rest coalesce into one trailing write per window.
 *
 * The panel still holds ZERO local copies of scene values — this only
 * schedules calls into the same reducer the agent tools use.
 */
function useThrottledApply(delayMs = 60) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<Partial<WiredState> | null>(null);

  const flush = useCallback(() => {
    timer.current = null;
    const patch = pending.current;
    pending.current = null;
    if (patch) useWired.getState().apply(patch, 'human');
  }, []);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  return useCallback(
    (patch: Partial<WiredState>) => {
      // Every pushed patch carries complete `camera` / `nodes` objects, so a
      // shallow merge is enough to coalesce a burst.
      pending.current = pending.current ? { ...pending.current, ...patch } : patch;
      if (timer.current) return;
      flush();
      timer.current = setTimeout(flush, delayMs);
    },
    [delayMs, flush],
  );
}

/* ------------------------------------------------------------------ */
/* Small presentational helpers                                        */
/* ------------------------------------------------------------------ */

const MODEL_LABELS: Record<ModelType, string> = {
  car: 'Cyber-Car Module',
  engine: 'Quantum Engine Node',
  photo: 'Photo Reconstruction',
};

const PRESET_LABELS: Record<ScenePresetName, string> = {
  'neon-noir': 'Neon Noir',
  'solar-flare': 'Solar Flare',
  'deep-void': 'Deep Void',
  hologram: 'Hologram',
};

const VARIANT_LABELS: Record<CarVariant, string> = {
  real: 'Concept (glTF)',
  parametric: 'Parametric',
};

const FINISH_LABELS: Record<CarFinish, string> = {
  paint: 'Painted',
  print: '3D Print',
};

const MATERIAL_LABELS: Record<PartMaterialId, string> = {
  steel: 'Mild steel',
  aluminium: 'Aluminium',
  titanium: 'Titanium',
  carbon: 'Carbon fibre',
  abs: 'ABS plastic',
  glass: 'Glass',
  rubber: 'Rubber',
};

const EDIT_LABELS: Record<EditMode, string> = {
  orbit: 'Orbit',
  translate: 'Move',
  rotate: 'Rotate',
  scale: 'Scale',
};

const CAMERA_LABELS: Record<CameraPreset, string> = {
  orbit: 'Orbit',
  top: 'Top',
  close: 'Close',
  wide: 'Wide',
};

function ColorRow(props: {
  id: string;
  label: string;
  value: string;
  onChange: (hex: string) => void;
}) {
  return (
    <div className="wf-field">
      <label className="wf-label" htmlFor={props.id}>
        {props.label}
      </label>
      <div className="wf-row">
        <input
          id={props.id}
          type="color"
          className="wf-color"
          value={props.value}
          onChange={(e) => props.onChange(e.target.value)}
        />
        <span className="wf-hex">{props.value}</span>
      </div>
    </div>
  );
}

function RangeRow(props: {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  readout: string;
  onChange: (value: number) => void;
}) {
  return (
    <div className="wf-field">
      <div className="wf-row">
        <label className="wf-label" htmlFor={props.id}>
          {props.label}
        </label>
        <span className="wf-readout">{props.readout}</span>
      </div>
      <input
        id={props.id}
        type="range"
        className="wf-range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        onChange={(e) => props.onChange(Number(e.target.value))}
      />
    </div>
  );
}

function ToggleRow(props: {
  id: string;
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="wf-field">
      <div className="wf-row">
        <label className="wf-label" htmlFor={props.id}>
          {props.label}
        </label>
        <input
          id={props.id}
          type="checkbox"
          className="wf-check"
          checked={props.checked}
          onChange={(e) => props.onChange(e.target.checked)}
        />
      </div>
    </div>
  );
}

/**
 * `WiredState` carries no preset name, so the live preset is derived by
 * comparing the fields a preset owns against the current state. Without this
 * the `.wf-button.is-active` rule is dead CSS and an agent's
 * `apply_scene_preset` call leaves the preset row showing nothing.
 */
function activeScenePreset(state: {
  gridColorHex: string;
  accentColorHex: string;
  waveVelocity: number;
  fogDensity: number;
}): ScenePresetName | null {
  const match = SCENE_PRESET_NAMES.find((name) => {
    const preset = SCENE_PRESETS[name];
    return (
      preset.gridColorHex === state.gridColorHex &&
      preset.accentColorHex === state.accentColorHex &&
      preset.waveVelocity === state.waveVelocity &&
      preset.fogDensity === state.fogDensity
    );
  });
  return match ?? null;
}


/**
 * Panels start open on desktop and collapsed on a phone, where three expanded
 * sheets would bury the canvas. Resolved in an effect because the static export
 * has no viewport at render time.
 */
function useStartsOpen() {
  const [open, setOpen] = useState(true);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (window.matchMedia('(max-width: 767px)').matches) setOpen(false);
  }, []);
  // as const, or TS widens this to (boolean | Dispatch<...>)[] and every use
  // site loses which element is which.
  return [open, setOpen] as const;
}

/* ------------------------------------------------------------------ */
/* Panel                                                               */
/* ------------------------------------------------------------------ */

/**
 * The human half of "one action, two interfaces".
 *
 * Every handler below funnels into `useWired.getState().apply / firePulse /
 * applyPreset / reset` — exactly the functions the WebMCP tool `execute()`
 * callbacks call. Nothing here keeps a local copy of a scene value, which is
 * why an agent editing the world redraws these controls for free.
 */
export function ControlPanel() {
  const uid = useId();
  const push = useThrottledApply(60);

  const gridColorHex = useWired((s) => s.gridColorHex);
  const accentColorHex = useWired((s) => s.accentColorHex);
  const modelType = useWired((s) => s.modelType);
  const waveVelocity = useWired((s) => s.waveVelocity);
  const waveAmplitude = useWired((s) => s.waveAmplitude);
  const fogDensity = useWired((s) => s.fogDensity);
  const nodeCount = useWired((s) => s.nodes.count);
  const nodeSpread = useWired((s) => s.nodes.spread);
  const nodeFloatSpeed = useWired((s) => s.nodes.floatSpeed);
  const nodeColorHex = useWired((s) => s.nodes.colorHex);
  const pulseToken = useWired((s) => s.pulseToken);
  // Selected one primitive at a time on purpose. `useWired((s) => s.camera)`
  // is fine in zustand v5 (stable reference), but a derived object literal
  // would loop forever, so the rule here is: never build one in a selector.
  const cameraPreset = useWired((s) => s.camera.preset);
  const cameraDistance = useWired((s) => s.camera.distance);
  const cameraHeight = useWired((s) => s.camera.height);
  const cameraAutoOrbit = useWired((s) => s.camera.autoOrbit);
  const carVariant = useWired((s) => s.carVariant);
  const rigFinish = useWired((s) => s.carRig.finish);
  const rigExplode = useWired((s) => s.carRig.explode);
  const rigDoorLeft = useWired((s) => s.carRig.doorLeft);
  const rigDoorRight = useWired((s) => s.carRig.doorRight);
  const rigHood = useWired((s) => s.carRig.hood);
  // The array identity is stable in the store (a new one is only built on an
  // actual change), so selecting it directly is safe under zustand v5.
  const rigHidden = useWired((s) => s.carRig.hidden);
  const rigEdits = useWired((s) => s.carRig.edits);
  const editMode = useWired((s) => s.editMode);
  const photoStatus = useWired((s) => s.photo.status);
  // Primitives only. A selector returning s.transform's parts as a new object
  // would re-render forever under zustand v5.
  const posX = useWired((s) => s.transform.position.x);
  const posY = useWired((s) => s.transform.position.y);
  const posZ = useWired((s) => s.transform.position.z);
  const yawDeg = useWired((s) => s.transform.rotationDeg.y);
  const objectScale = useWired((s) => s.transform.scale);

  const livePreset = activeScenePreset({
    gridColorHex,
    accentColorHex,
    waveVelocity,
    fogDensity,
  });

  const [open, setOpen] = useStartsOpen();
  // Which part the editor is aimed at. Purely a UI concern - the scene has no
  // notion of a "selected" part, only of parts that have edits.
  const [focusPart, setFocusPart] = useState<CarPartId>('body');
  const [charging, setCharging] = useState(false);
  const bodyId = uid + '-body';

  // Light the pulse button for the duration of the shockwave — including when
  // the pulse was fired by an agent, so the button visibly reacts to the tool
  // call without the panel knowing who triggered it.
  const initialToken = useRef(pulseToken);
  useEffect(() => {
    if (pulseToken === initialToken.current) return;
    setCharging(true);
    const timeout = window.setTimeout(
      () => setCharging(false),
      useWired.getState().pulseDurationMs,
    );
    return () => window.clearTimeout(timeout);
  }, [pulseToken]);

  const setNodes = useCallback(
    (part: {
      count?: number;
      spread?: number;
      floatSpeed?: number;
      colorHex?: string;
    }) => {
      push({ nodes: { ...useWired.getState().nodes, ...part } });
    },
    [push],
  );

  const setRig = useCallback(
    (part: {
      finish?: CarFinish;
      explode?: number;
      doorLeft?: number;
      doorRight?: number;
      hood?: number;
      hidden?: CarPartId[];
    }) => {
      push({ carRig: { ...useWired.getState().carRig, ...part } });
    },
    [push],
  );

  const togglePart = useCallback(
    (id: CarPartId) => {
      const live = useWired.getState().carRig.hidden;
      const next = live.includes(id)
        ? live.filter((x) => x !== id)
        : [...live, id];
      useWired
        .getState()
        .apply(
          { carRig: { ...useWired.getState().carRig, hidden: next } },
          'human',
        );
    },
    [],
  );

  const partEdit: PartEdit = rigEdits[focusPart] ?? IDENTITY_EDIT;

  const setPartEdit = useCallback(
    (part: CarPartId, patch: Partial<PartEdit>) => {
      const live = useWired.getState().carRig;
      const current = live.edits[part] ?? IDENTITY_EDIT;
      push({
        carRig: {
          ...live,
          edits: { ...live.edits, [part]: { ...current, ...patch } },
        },
      });
    },
    [push],
  );

  const resetPartEdit = useCallback((part: CarPartId) => {
    const live = useWired.getState().carRig;
    const edits = { ...live.edits };
    delete edits[part];
    useWired.getState().apply({ carRig: { ...live, edits } }, 'human');
  }, []);

  const setCamera = useCallback(
    (part: {
      preset?: CameraPreset;
      distance?: number;
      height?: number;
      autoOrbit?: boolean;
    }) => {
      push({ camera: { ...useWired.getState().camera, ...part } });
    },
    [push],
  );

  const nudge = useCallback(
    (part: {
      position?: Partial<{ x: number; y: number; z: number }>;
      yaw?: number;
      scale?: number;
    }) => {
      const live = useWired.getState().transform;
      useWired.getState().setTransform(
        {
          position: { ...live.position, ...(part.position ?? {}) },
          rotationDeg:
            part.yaw === undefined
              ? live.rotationDeg
              : { ...live.rotationDeg, y: part.yaw },
          scale: part.scale ?? live.scale,
        },
        'human',
      );
    },
    [],
  );

  return (
    <section
      className="wf-dock wf-dock--left"
      aria-label="Scene control panel"
    >
      <div id="tour-controls" className="wf-panel">
        <header className="wf-panel__head">
          <h2 className="wf-panel__title">Control Deck</h2>
          <button
            type="button"
            className="wf-button wf-button--chip wf-chip-toggle"
            aria-expanded={open}
            aria-controls={bodyId}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? 'Minimise' : 'Controls'}
          </button>
        </header>

        <div
          id={bodyId}
          className={
            'wf-panel__body wf-scroll wf-collapsible' + (open ? ' is-open' : '')
          }
        >
          <ColorRow
            id={uid + '-grid'}
            label="Grid / Primary Neon"
            value={gridColorHex}
            onChange={(hex) => push({ gridColorHex: hex })}
          />

          <ColorRow
            id={uid + '-accent'}
            label="Accent Trim"
            value={accentColorHex}
            onChange={(hex) => push({ accentColorHex: hex })}
          />

          <hr className="wf-divider" />

          <div className="wf-field">
            <label className="wf-label" htmlFor={uid + '-model'}>
              Model Module
            </label>
            <select
              id={uid + '-model'}
              className="wf-input"
              value={modelType}
              onChange={(e) =>
                useWired
                  .getState()
                  .apply({ modelType: e.target.value as ModelType }, 'human')
              }
            >
              {MODEL_TYPES.map((type) => (
                <option
                  key={type}
                  value={type}
                  disabled={type === 'photo' && photoStatus !== 'ready'}
                >
                  {MODEL_LABELS[type]}
                  {type === 'photo' && photoStatus !== 'ready'
                    ? ' (drop a photo first)'
                    : ''}
                </option>
              ))}
            </select>
          </div>

          {modelType === 'car' ? (
            <div className="wf-field">
              <span className="wf-label">Car Body</span>
              <div className="wf-grid-2">
                {CAR_VARIANTS.map((variant) => (
                  <button
                    key={variant}
                    type="button"
                    className={
                      'wf-button' + (variant === carVariant ? ' is-active' : '')
                    }
                    aria-pressed={variant === carVariant}
                    onClick={() =>
                      useWired.getState().apply({ carVariant: variant }, 'human')
                    }
                  >
                    {VARIANT_LABELS[variant]}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {modelType === 'car' && carVariant === 'real' ? (
            <>
              <hr className="wf-divider" />

              <div className="wf-field">
                <span className="wf-label">Finish</span>
                <div className="wf-grid-2">
                  {CAR_FINISHES.map((finish) => (
                    <button
                      key={finish}
                      type="button"
                      className={
                        'wf-button' + (finish === rigFinish ? ' is-active' : '')
                      }
                      aria-pressed={finish === rigFinish}
                      onClick={() => setRig({ finish })}
                    >
                      {FINISH_LABELS[finish]}
                    </button>
                  ))}
                </div>
                <span className="wf-note">
                  3D Print strips the paint and glass to one matte resin grey,
                  so you can read the geometry.
                </span>
              </div>

              <RangeRow
                id={uid + '-explode'}
                label="Explode"
                value={rigExplode}
                min={0}
                max={1}
                step={0.01}
                readout={Math.round(rigExplode * 100) + '%'}
                onChange={(v) => setRig({ explode: v })}
              />

              <RangeRow
                id={uid + '-doorl'}
                label="Left Door"
                value={rigDoorLeft}
                min={0}
                max={1}
                step={0.01}
                readout={Math.round(rigDoorLeft * 100) + '%'}
                onChange={(v) => setRig({ doorLeft: v })}
              />

              <RangeRow
                id={uid + '-doorr'}
                label="Right Door"
                value={rigDoorRight}
                min={0}
                max={1}
                step={0.01}
                readout={Math.round(rigDoorRight * 100) + '%'}
                onChange={(v) => setRig({ doorRight: v })}
              />

              <RangeRow
                id={uid + '-hood'}
                label="Hood"
                value={rigHood}
                min={0}
                max={1}
                step={0.01}
                readout={Math.round(rigHood * 100) + '%'}
                onChange={(v) => setRig({ hood: v })}
              />

              <div className="wf-row">
                <button
                  type="button"
                  className="wf-button wf-button--chip"
                  onClick={() =>
                    setRig({ doorLeft: 1, doorRight: 1, hood: 1 })
                  }
                >
                  Open All
                </button>
                <button
                  type="button"
                  className="wf-button wf-button--chip"
                  onClick={() =>
                    setRig({ doorLeft: 0, doorRight: 0, hood: 0, explode: 0 })
                  }
                >
                  Close + Rejoin
                </button>
              </div>

              <div className="wf-field">
                <span className="wf-label">Parts</span>
                <div className="wf-partgrid">
                  {CAR_PART_IDS.map((id) => {
                    const fitted = !rigHidden.includes(id);
                    return (
                      <button
                        key={id}
                        type="button"
                        className={
                          'wf-button wf-button--chip' +
                          (fitted ? ' is-active' : '')
                        }
                        aria-pressed={fitted}
                        onClick={() => togglePart(id)}
                      >
                        {CAR_PART_LABELS[id]}
                      </button>
                    );
                  })}
                </div>
                <span className="wf-note">
                  Lit means fitted. Click to detach a part; click again to put
                  it back.
                </span>
              </div>

              <hr className="wf-divider" />

              <div className="wf-field">
                <label className="wf-label" htmlFor={uid + '-focus'}>
                  Edit Part
                </label>
                <select
                  id={uid + '-focus'}
                  className="wf-input"
                  value={focusPart}
                  onChange={(e) => setFocusPart(e.target.value as CarPartId)}
                >
                  {CAR_PART_IDS.map((id) => (
                    <option key={id} value={id}>
                      {CAR_PART_LABELS[id]}
                      {rigEdits[id] ? ' (edited)' : ''}
                    </option>
                  ))}
                </select>
              </div>

              <div className="wf-field">
                <label className="wf-label" htmlFor={uid + '-material'}>
                  Material
                </label>
                <select
                  id={uid + '-material'}
                  className="wf-input"
                  value={partEdit.material ?? ''}
                  onChange={(e) =>
                    setPartEdit(focusPart, {
                      material: e.target.value
                        ? (e.target.value as PartMaterialId)
                        : null,
                    })
                  }
                >
                  <option value="">As shipped</option>
                  {PART_MATERIAL_IDS.map((id) => (
                    <option key={id} value={id}>
                      {MATERIAL_LABELS[id]}
                    </option>
                  ))}
                </select>
              </div>

              <RangeRow
                id={uid + '-psx'}
                label="Part Width"
                value={partEdit.scaleX}
                min={PART_EDIT_LIMITS.scale.min}
                max={PART_EDIT_LIMITS.scale.max}
                step={0.01}
                readout={partEdit.scaleX.toFixed(2) + ' x'}
                onChange={(v) => setPartEdit(focusPart, { scaleX: v })}
              />

              <RangeRow
                id={uid + '-psy'}
                label="Part Height"
                value={partEdit.scaleY}
                min={PART_EDIT_LIMITS.scale.min}
                max={PART_EDIT_LIMITS.scale.max}
                step={0.01}
                readout={partEdit.scaleY.toFixed(2) + ' x'}
                onChange={(v) => setPartEdit(focusPart, { scaleY: v })}
              />

              <RangeRow
                id={uid + '-psz'}
                label="Part Length"
                value={partEdit.scaleZ}
                min={PART_EDIT_LIMITS.scale.min}
                max={PART_EDIT_LIMITS.scale.max}
                step={0.01}
                readout={partEdit.scaleZ.toFixed(2) + ' x'}
                onChange={(v) => setPartEdit(focusPart, { scaleZ: v })}
              />

              <RangeRow
                id={uid + '-pinf'}
                label="Thicken"
                value={partEdit.inflate}
                min={PART_EDIT_LIMITS.inflate.min}
                max={PART_EDIT_LIMITS.inflate.max}
                step={0.002}
                readout={Math.round(partEdit.inflate * 880) + ' mm'}
                onChange={(v) => setPartEdit(focusPart, { inflate: v })}
              />

              <RangeRow
                id={uid + '-ptw'}
                label="Twist"
                value={partEdit.twistDeg}
                min={PART_EDIT_LIMITS.twistDeg.min}
                max={PART_EDIT_LIMITS.twistDeg.max}
                step={1}
                readout={partEdit.twistDeg.toFixed(0) + ' deg'}
                onChange={(v) => setPartEdit(focusPart, { twistDeg: v })}
              />

              <div className="wf-row">
                <span className="wf-note">
                  Edits rebuild from the original geometry, so they never
                  compound.
                </span>
                <button
                  type="button"
                  className="wf-button wf-button--ghost wf-button--chip"
                  onClick={() => resetPartEdit(focusPart)}
                >
                  Reset Part
                </button>
              </div>
            </>
          ) : null}

          <hr className="wf-divider" />

          <div className="wf-field">
            <span className="wf-label">Edit Mode</span>
            <div className="wf-grid-2">
              {EDIT_MODES.map((mode) => (
                <button
                  key={mode}
                  type="button"
                  className={
                    'wf-button' + (mode === editMode ? ' is-active' : '')
                  }
                  aria-pressed={mode === editMode}
                  onClick={() =>
                    useWired.getState().apply({ editMode: mode }, 'human')
                  }
                >
                  {EDIT_LABELS[mode]}
                </button>
              ))}
            </div>
            <span className="wf-note">
              Orbit flies the camera. Move / Rotate / Scale arm a drag gizmo on
              the object itself.
            </span>
          </div>

          <RangeRow
            id={uid + '-posx'}
            label="Position X"
            value={posX}
            min={LIMITS.positionX.min}
            max={LIMITS.positionX.max}
            step={0.1}
            readout={posX.toFixed(1)}
            onChange={(v) => nudge({ position: { x: v } })}
          />

          <RangeRow
            id={uid + '-posy'}
            label="Position Y"
            value={posY}
            min={LIMITS.positionY.min}
            max={LIMITS.positionY.max}
            step={0.1}
            readout={posY.toFixed(1)}
            onChange={(v) => nudge({ position: { y: v } })}
          />

          <RangeRow
            id={uid + '-posz'}
            label="Position Z"
            value={posZ}
            min={LIMITS.positionZ.min}
            max={LIMITS.positionZ.max}
            step={0.1}
            readout={posZ.toFixed(1)}
            onChange={(v) => nudge({ position: { z: v } })}
          />

          <RangeRow
            id={uid + '-yaw'}
            label="Yaw"
            value={yawDeg}
            min={-180}
            max={180}
            step={1}
            readout={yawDeg.toFixed(0) + ' deg'}
            onChange={(v) => nudge({ yaw: v })}
          />

          <RangeRow
            id={uid + '-scale'}
            label="Object Scale"
            value={objectScale}
            min={LIMITS.scale.min}
            max={LIMITS.scale.max}
            step={0.05}
            readout={objectScale.toFixed(2) + ' x'}
            onChange={(v) => nudge({ scale: v })}
          />

          <button
            type="button"
            className="wf-button wf-button--ghost"
            onClick={() =>
              useWired.getState().setTransform(
                {
                  position: { x: 0, y: 0, z: 0 },
                  rotationDeg: { x: 0, y: 0, z: 0 },
                  scale: 1,
                },
                'human',
              )
            }
          >
            Reset Placement
          </button>

          <RangeRow
            id={uid + '-wave'}
            label="Wave Velocity"
            value={waveVelocity}
            min={LIMITS.waveVelocity.min}
            max={LIMITS.waveVelocity.max}
            step={0.05}
            readout={waveVelocity.toFixed(2) + ' x'}
            onChange={(v) => push({ waveVelocity: v })}
          />

          <RangeRow
            id={uid + '-amp'}
            label="Wave Amplitude"
            value={waveAmplitude}
            min={LIMITS.waveAmplitude.min}
            max={LIMITS.waveAmplitude.max}
            step={0.05}
            readout={waveAmplitude.toFixed(2)}
            onChange={(v) => push({ waveAmplitude: v })}
          />

          <RangeRow
            id={uid + '-fog'}
            label="Fog Density"
            value={fogDensity}
            min={LIMITS.fogDensity.min}
            max={LIMITS.fogDensity.max}
            step={0.005}
            readout={fogDensity.toFixed(3)}
            onChange={(v) => push({ fogDensity: v })}
          />

          <hr className="wf-divider" />

          <RangeRow
            id={uid + '-nodes'}
            label="Node Count"
            value={nodeCount}
            min={LIMITS.nodeCount.min}
            max={LIMITS.nodeCount.max}
            step={1}
            readout={String(Math.round(nodeCount))}
            onChange={(v) => setNodes({ count: v })}
          />

          <RangeRow
            id={uid + '-spread'}
            label="Node Spread"
            value={nodeSpread}
            min={LIMITS.nodeSpread.min}
            max={LIMITS.nodeSpread.max}
            step={0.5}
            readout={nodeSpread.toFixed(1)}
            onChange={(v) => setNodes({ spread: v })}
          />

          <RangeRow
            id={uid + '-float'}
            label="Node Float Speed"
            value={nodeFloatSpeed}
            min={LIMITS.nodeFloatSpeed.min}
            max={LIMITS.nodeFloatSpeed.max}
            step={0.05}
            readout={nodeFloatSpeed.toFixed(2) + ' x'}
            onChange={(v) => setNodes({ floatSpeed: v })}
          />

          <ColorRow
            id={uid + '-nodecolor'}
            label="Node Cluster Hue"
            value={nodeColorHex}
            onChange={(hex) => setNodes({ colorHex: hex })}
          />

          <hr className="wf-divider" />

          <div className="wf-field">
            <span className="wf-label">Camera Framing</span>
            <div className="wf-grid-2">
              {CAMERA_PRESETS.map((name) => (
                <button
                  key={name}
                  type="button"
                  className={
                    'wf-button' + (name === cameraPreset ? ' is-active' : '')
                  }
                  aria-pressed={name === cameraPreset}
                  onClick={() => setCamera({ preset: name })}
                >
                  {CAMERA_LABELS[name]}
                </button>
              ))}
            </div>
          </div>

          <RangeRow
            id={uid + '-dist'}
            label="Camera Distance"
            value={cameraDistance}
            min={LIMITS.cameraDistance.min}
            max={LIMITS.cameraDistance.max}
            step={0.5}
            readout={cameraDistance.toFixed(1)}
            onChange={(v) => setCamera({ distance: v })}
          />

          <RangeRow
            id={uid + '-height'}
            label="Camera Height"
            value={cameraHeight}
            min={LIMITS.cameraHeight.min}
            max={LIMITS.cameraHeight.max}
            step={0.5}
            readout={cameraHeight.toFixed(1)}
            onChange={(v) => setCamera({ height: v })}
          />

          <ToggleRow
            id={uid + '-orbit'}
            label="Auto Orbit"
            checked={cameraAutoOrbit}
            onChange={(checked) => setCamera({ autoOrbit: checked })}
          />

          <hr className="wf-divider" />

          <div className="wf-field">
            <span className="wf-label">Scene Presets</span>
            <div className="wf-grid-2">
              {SCENE_PRESET_NAMES.map((name) => (
                <button
                  key={name}
                  type="button"
                  className={
                    'wf-button' + (name === livePreset ? ' is-active' : '')
                  }
                  aria-pressed={name === livePreset}
                  onClick={() => useWired.getState().applyPreset(name, 'human')}
                >
                  {PRESET_LABELS[name]}
                </button>
              ))}
            </div>
          </div>

          <button
            type="button"
            className={
              'wf-button wf-button--primary' + (charging ? ' is-charging' : '')
            }
            aria-pressed={charging}
            onClick={() => useWired.getState().firePulse(2.4, 1600, 'human')}
          >
            {charging ? 'Wave Propagating' : 'Pulse Reality Wave'}
          </button>

          <div className="wf-row">
            <span className="wf-note">Same reducer the agent calls.</span>
            <button
              type="button"
              className="wf-button wf-button--ghost wf-button--chip"
              onClick={() => useWired.getState().reset('human')}
            >
              Reset
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

export default ControlPanel;
