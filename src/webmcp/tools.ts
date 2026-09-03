'use client';

/**
 * The agent half of "one action, two interfaces".
 *
 * Every execute() below is a thin, defensive shell around a single store
 * action. It never mutates state directly, never talks to three.js except
 * through the injected engine getter, and never throws — a throwing tool is a
 * dead tool, so every body is wrapped and returns an isError result instead.
 *
 * The text content block is the store's own summary string, which is the exact
 * same string the human status bar prints. structuredContent carries the full
 * resulting WiredState so the agent can ground its next call on real numbers
 * instead of re-reading its own prose.
 */

import type { McpContent, McpToolDescriptor, McpToolResult } from '@/types/webmcp';
import type { WiredEngine } from '@/scene/contract';
import { MODEL_UNITS_TO_METRES, PART_MATERIALS } from '@/config/part-materials';
import {
  CAMERA_PRESETS,
  CAR_FINISHES,
  CAR_PART_IDS,
  CAR_PART_LABELS,
  EDIT_MODES,
  IDENTITY_EDIT,
  IDENTITY_NODE_TRANSFORM,
  LIMITS,
  NODE_LIMITS,
  PART_EDIT_LIMITS,
  PART_MATERIAL_IDS,
  MODEL_TYPES,
  SCENE_PRESET_NAMES,
  normalizeHex,
  useWired,
} from '@/store/use-wired';
import type {
  CameraPreset,
  CameraState,
  CarFinish,
  CarPartId,
  EditMode,
  NodeTransform,
  PartEdit,
  PartMaterialId,
  ModelType,
  NodeClusterState,
  ScenePresetName,
  WiredState,
} from '@/store/use-wired';

/* ------------------------------------------------------------------ */
/* Small utilities                                                     */
/* ------------------------------------------------------------------ */

type ToolInput = Record<string, unknown> | undefined;

type Range = { min: number; max: number };

type Parsed<T> = { ok: true; value: T; clamped?: boolean } | { ok: false; error: string };

const quote = (value: string) => '"' + value + '"';

function describeValue(raw: unknown): string {
  if (raw === undefined) return 'nothing';
  try {
    const serialised = JSON.stringify(raw);
    return serialised === undefined ? String(raw) : serialised;
  } catch {
    return String(raw);
  }
}

/** Treat null, undefined and blank strings as "the caller did not supply this". */
function present(raw: unknown): boolean {
  if (raw === undefined || raw === null) return false;
  if (typeof raw === 'string' && raw.trim() === '') return false;
  return true;
}

function tidy(value: number): number {
  return Number(value.toFixed(3));
}

function readNumber(label: string, raw: unknown, range: Range): Parsed<number> {
  let parsed = Number.NaN;
  if (typeof raw === 'number') parsed = raw;
  else if (typeof raw === 'string' && raw.trim() !== '') parsed = Number(raw);

  if (!Number.isFinite(parsed)) {
    return {
      ok: false,
      error:
        quote(label) +
        ' must be a number between ' +
        range.min +
        ' and ' +
        range.max +
        '; received ' +
        describeValue(raw) +
        '.',
    };
  }

  const clampedValue = Math.min(range.max, Math.max(range.min, parsed));
  return { ok: true, value: clampedValue, clamped: clampedValue !== parsed };
}

function readHex(label: string, raw: unknown): Parsed<string> {
  const hex = normalizeHex(raw);
  if (!hex) {
    return {
      ok: false,
      error:
        quote(label) +
        ' must be a hex colour such as "#00f0ff" or "#0ff"; received ' +
        describeValue(raw) +
        '. CSS colour names like "cyan" are not accepted - convert to hex first.',
    };
  }
  return { ok: true, value: hex };
}

function readEnum<T extends string>(label: string, raw: unknown, allowed: readonly T[]): Parsed<T> {
  if (typeof raw === 'string') {
    const needle = raw.trim().toLowerCase();
    const hit = allowed.find((candidate) => candidate.toLowerCase() === needle);
    if (hit) return { ok: true, value: hit };
  }
  return {
    ok: false,
    error:
      quote(label) +
      ' must be one of ' +
      allowed.map(quote).join(', ') +
      '; received ' +
      describeValue(raw) +
      '.',
  };
}

function readBoolean(label: string, raw: unknown): Parsed<boolean> {
  if (typeof raw === 'boolean') return { ok: true, value: raw };
  if (typeof raw === 'string') {
    const needle = raw.trim().toLowerCase();
    if (needle === 'true' || needle === 'yes' || needle === 'on' || needle === '1') {
      return { ok: true, value: true };
    }
    if (needle === 'false' || needle === 'no' || needle === 'off' || needle === '0') {
      return { ok: true, value: false };
    }
  }
  return {
    ok: false,
    error: quote(label) + ' must be true or false; received ' + describeValue(raw) + '.',
  };
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/* ------------------------------------------------------------------ */
/* Natural-language grounding                                          */
/* ------------------------------------------------------------------ */

function hexToRgb(hex: string): [number, number, number] {
  const normalised = normalizeHex(hex) ?? '#000000';
  return [
    parseInt(normalised.slice(1, 3), 16) / 255,
    parseInt(normalised.slice(3, 5), 16) / 255,
    parseInt(normalised.slice(5, 7), 16) / 255,
  ];
}

const HUE_NAMES: { upTo: number; name: string }[] = [
  { upTo: 15, name: 'red' },
  { upTo: 40, name: 'orange' },
  { upTo: 52, name: 'amber' },
  { upTo: 66, name: 'yellow' },
  { upTo: 90, name: 'lime' },
  { upTo: 150, name: 'green' },
  { upTo: 165, name: 'mint' },
  { upTo: 180, name: 'teal' },
  { upTo: 200, name: 'cyan' },
  { upTo: 215, name: 'azure' },
  { upTo: 250, name: 'blue' },
  { upTo: 285, name: 'violet' },
  { upTo: 305, name: 'purple' },
  { upTo: 330, name: 'magenta' },
  { upTo: 345, name: 'pink' },
  { upTo: 361, name: 'red' },
];

/** Rough hue bucketing so the agent gets "cyan" rather than "#00f0ff". */
function colourName(hex: string): string {
  const [r, g, b] = hexToRgb(hex);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lightness = (max + min) / 2;
  const delta = max - min;

  if (delta < 0.06) {
    if (lightness > 0.85) return 'white';
    if (lightness > 0.5) return 'pale grey';
    if (lightness > 0.2) return 'grey';
    return 'near-black';
  }

  let hue: number;
  if (max === r) hue = ((g - b) / delta) % 6;
  else if (max === g) hue = (b - r) / delta + 2;
  else hue = (r - g) / delta + 4;
  hue = (hue * 60 + 360) % 360;

  const bucket = HUE_NAMES.find((entry) => hue < entry.upTo);
  const base = bucket ? bucket.name : 'neon';

  if (lightness > 0.84) return 'pale ' + base;
  if (lightness < 0.22) return 'deep ' + base;
  return base;
}

function capitalise(text: string): string {
  return text.length ? text[0].toUpperCase() + text.slice(1) : text;
}

/**
 * A short scene description in plain English. Agents reason far better on this
 * than on a bag of hex codes, so it rides along with every tool result.
 */
export function describeScene(state: WiredState): string {
  const grid = colourName(state.gridColorHex);
  const accent = colourName(state.accentColorHex);
  const nodeColour = colourName(state.nodes.colorHex);
  const model =
    state.modelType === 'photo'
      ? 'photo reconstruction'
      : state.modelType === 'car'
        ? state.carVariant === 'real'
          ? 'concept car (glTF)'
          : 'parametric cyber-car'
        : 'engine-block';
  const spin = state.camera.autoOrbit ? 'slowly rotating' : 'motionless';

  const nodeClause =
    state.nodes.count > 0
      ? state.nodes.count +
        ' ' +
        nodeColour +
        ' nodes drift overhead across a ' +
        tidy(state.nodes.spread) +
        '-unit spread at float speed ' +
        tidy(state.nodes.floatSpeed)
      : 'the node cluster is empty';

  const fogWord =
    state.fogDensity <= 0.02
      ? 'clear air'
      : state.fogDensity <= 0.05
        ? 'a light haze'
        : 'thick fog';

  const t = state.transform;
  const placed =
    t.position.x === 0 && t.position.y === 0 && t.position.z === 0 && t.scale === 1
      ? 'The object sits at the stage centre at default scale'
      : 'The object is placed at ' +
        tidy(t.position.x) + '/' + tidy(t.position.y) + '/' + tidy(t.position.z) +
        ', yaw ' + tidy(t.rotationDeg.y) + ' degrees, scale ' + tidy(t.scale);

  const rig = state.carRig;
  const rigBits: string[] = [];
  if (state.modelType === 'car' && state.carVariant === 'real') {
    if (rig.finish === 'print') rigBits.push('shown as an unpainted 3D print');
    if (rig.explode > 0) {
      rigBits.push('exploded ' + Math.round(rig.explode * 100) + '%');
    }
    if (rig.doorLeft > 0 || rig.doorRight > 0) rigBits.push('doors open');
    if (rig.hood > 0) rigBits.push('hood up');
    if (rig.hidden.length) {
      rigBits.push('removed: ' + rig.hidden.map((id) => CAR_PART_LABELS[id]).join(', '));
    }
  }
  const rigClause = rigBits.length ? 'The car is ' + rigBits.join(', ') + '. ' : '';

  const selectionClause = rig.selection
    ? 'The person has "' +
      rig.selection.label +
      '" selected' +
      (rig.selection.level === 'node' ? ' as a single part' : '') +
      '. '
    : '';

  const editing =
    state.editMode === 'orbit'
      ? 'The mouse orbits the camera'
      : 'A ' + state.editMode + ' gizmo is armed on the object';

  return (
    placed + '. ' + editing + '. ' + rigClause + selectionClause +
    'A ' +
    grid +
    ' wireframe landscape ripples at ' +
    tidy(state.waveVelocity) +
    'x speed and ' +
    tidy(state.waveAmplitude) +
    'x amplitude beneath a ' +
    spin +
    ' ' +
    model +
    ' module. ' +
    capitalise(nodeClause) +
    '. ' +
    capitalise(accent) +
    ' accents trace the horizon through ' +
    fogWord +
    ' (fog density ' +
    tidy(state.fogDensity) +
    '). Camera is on the "' +
    state.camera.preset +
    '" preset at distance ' +
    tidy(state.camera.distance) +
    ' and height ' +
    tidy(state.camera.height) +
    ', auto-orbit ' +
    (state.camera.autoOrbit ? 'on' : 'off') +
    '.'
  );
}

/* ------------------------------------------------------------------ */
/* Result builders                                                     */
/* ------------------------------------------------------------------ */

function failure(message: string): McpToolResult {
  return {
    content: [{ type: 'text', text: message }],
    structuredContent: { ok: false, error: message },
    isError: true,
  };
}

function success(text: string, extra?: Record<string, unknown>): McpToolResult {
  const store = useWired.getState();
  const state = store.snapshot();
  return {
    content: [{ type: 'text', text }],
    structuredContent: {
      ok: true,
      summary: text,
      ...(extra ?? {}),
      state,
      description: describeScene(state),
      mcpStatus: store.mcpStatus,
      agentActionCount: store.agentActionCount,
    },
  };
}

function withNotes(summary: string, notes: string[]): string {
  return notes.length ? summary + ' (' + notes.join('; ') + ')' : summary;
}

function clampNote(label: string, parsed: { value: number; clamped?: boolean }, range: Range): string | null {
  if (!parsed.clamped) return null;
  return label + ' clamped to ' + tidy(parsed.value) + ' - legal range is ' + range.min + '-' + range.max;
}

/* ------------------------------------------------------------------ */
/* The tool set                                                        */
/* ------------------------------------------------------------------ */

/**
 * Build the eight WebMCP tools.
 *
 * The engine arrives as a getter, not a value, because the tool list is
 * constructed before the canvas has mounted — only capture_scene_snapshot ever
 * dereferences it, and it does so lazily at call time.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function buildTools(getEngine: () => WiredEngine | null): McpToolDescriptor<any>[] {
  /* ---------------------------------------------------------------- */
  /* 1. Read                                                           */
  /* ---------------------------------------------------------------- */
  const getState: McpToolDescriptor<ToolInput> = {
    name: 'get_wired_future_state',
    description:
      'Read the complete live state of the Wired Future 3D canvas: grid and accent colours, which hero model is floating, wave velocity and amplitude, fog density, the camera rig and the drifting node cluster. Returns a short natural-language description of what is currently on screen alongside the exact numbers and the legal range for every parameter. Call this first whenever you need to make a relative change ("make it faster", "darker", "twice as many nodes") so you are adjusting from the real value instead of guessing.',
    annotations: {
      title: 'Read scene state',
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
      description: 'Takes no arguments.',
    },
    execute: () => {
      try {
        const store = useWired.getState();
        const state = store.snapshot();
        const description = describeScene(state);

        // Log the read so the human watching the status bar SEES the agent look.
        store.log('agent', 'read scene state');
        store.noteAgentCall();

        return {
          content: [
            {
              type: 'text',
              text: description + '\n\nExact values:\n' + JSON.stringify(state, null, 2),
            },
          ],
          structuredContent: {
            ok: true,
            state,
            description,
            mcpStatus: store.mcpStatus,
            agentActionCount: store.agentActionCount,
            limits: LIMITS,
            modelTypes: MODEL_TYPES,
            cameraPresets: CAMERA_PRESETS,
            scenePresets: SCENE_PRESET_NAMES,
          },
        };
      } catch (err) {
        return failure('get_wired_future_state failed: ' + errorMessage(err));
      }
    },
  };

  /* ---------------------------------------------------------------- */
  /* 2. The headline tool                                              */
  /* ---------------------------------------------------------------- */
  const modifyEnvironment: McpToolDescriptor<ToolInput> = {
    name: 'modify_wired_future_environment',
    description:
      'Restyle the Wired Future world: recolour the neon wireframe terrain, swap the hero model between the cyber-car and the engine block, and retune how violently the landscape ripples and how thick the fog sits. This is the main creative control - reach for it whenever someone asks the scene to look different. Every property is optional and you must supply at least one; anything you leave out keeps its current value. Numeric values outside their documented range are clamped rather than rejected. The same change appears instantly in the human control panel, so the person watching sees exactly what you did.',
    annotations: {
      title: 'Restyle the environment',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      description:
        'Supply at least one property. Omitted properties are left untouched, so partial updates are the normal case.',
      properties: {
        gridColorHex: {
          type: 'string',
          description:
            'Hex colour for the terrain wireframe, primary point light and model accents. Accepts #rgb or #rrggbb, for example "#00f0ff" or "#0ff". This is the dominant colour of the whole scene, so change it first when asked for a different mood. CSS colour names such as "cyan" are rejected - convert to hex yourself.',
        },
        accentColorHex: {
          type: 'string',
          description:
            'Hex colour for the secondary highlight: model trim and the horizon glow. Same #rgb / #rrggbb format. Works best as a contrasting hue to gridColorHex, for example magenta "#ff2bd6" against cyan.',
        },
        modelType: {
          type: 'string',
          enum: ['car', 'engine'],
          description:
            'Which hero model hovers above the landscape. "car" is a low-poly cyber-car silhouette; "engine" is a segmented engine-block module. Nothing else is valid.',
        },
        waveVelocity: {
          type: 'number',
          minimum: LIMITS.waveVelocity.min,
          maximum: LIMITS.waveVelocity.max,
          description:
            'Speed multiplier for the terrain wave math, 0 to 5. 0 freezes the landscape solid, 1 is the calm default, 2.5 reads as an energetic ripple, 5 is a violent churn. Out-of-range values are clamped.',
        },
        waveAmplitude: {
          type: 'number',
          minimum: LIMITS.waveAmplitude.min,
          maximum: LIMITS.waveAmplitude.max,
          description:
            'Height of the terrain waves, 0 to 4. 0 flattens the grid into a plane, 1 is the default swell, 4 is a mountainous chop that swallows the horizon. Clamped.',
        },
        fogDensity: {
          type: 'number',
          minimum: LIMITS.fogDensity.min,
          maximum: LIMITS.fogDensity.max,
          description:
            'Exponential fog density, 0 to 0.12. 0 is crystal clear to the horizon, 0.035 is the default haze, 0.12 buries everything a few units out for a claustrophobic look. Clamped.',
        },
      },
    },
    execute: (input) => {
      try {
        const args = input ?? {};
        const patch: Partial<WiredState> = {};
        const notes: string[] = [];

        if (present(args.gridColorHex)) {
          const parsed = readHex('gridColorHex', args.gridColorHex);
          if (!parsed.ok) return failure(parsed.error);
          patch.gridColorHex = parsed.value;
        }

        if (present(args.accentColorHex)) {
          const parsed = readHex('accentColorHex', args.accentColorHex);
          if (!parsed.ok) return failure(parsed.error);
          patch.accentColorHex = parsed.value;
        }

        if (present(args.modelType)) {
          const parsed = readEnum<ModelType>('modelType', args.modelType, MODEL_TYPES);
          if (!parsed.ok) return failure(parsed.error);
          patch.modelType = parsed.value;
        }

        if (present(args.waveVelocity)) {
          const parsed = readNumber('waveVelocity', args.waveVelocity, LIMITS.waveVelocity);
          if (!parsed.ok) return failure(parsed.error);
          patch.waveVelocity = parsed.value;
          const note = clampNote('waveVelocity', parsed, LIMITS.waveVelocity);
          if (note) notes.push(note);
        }

        if (present(args.waveAmplitude)) {
          const parsed = readNumber('waveAmplitude', args.waveAmplitude, LIMITS.waveAmplitude);
          if (!parsed.ok) return failure(parsed.error);
          patch.waveAmplitude = parsed.value;
          const note = clampNote('waveAmplitude', parsed, LIMITS.waveAmplitude);
          if (note) notes.push(note);
        }

        if (present(args.fogDensity)) {
          const parsed = readNumber('fogDensity', args.fogDensity, LIMITS.fogDensity);
          if (!parsed.ok) return failure(parsed.error);
          patch.fogDensity = parsed.value;
          const note = clampNote('fogDensity', parsed, LIMITS.fogDensity);
          if (note) notes.push(note);
        }

        if (!Object.keys(patch).length) {
          return failure(
            'No parameters supplied. Provide at least one of gridColorHex, accentColorHex, modelType, waveVelocity, waveAmplitude or fogDensity.',
          );
        }

        const summary = useWired.getState().apply(patch, 'agent');
        return success(withNotes(summary, notes), { applied: patch, notes });
      } catch (err) {
        return failure('modify_wired_future_environment failed: ' + errorMessage(err));
      }
    },
  };

  /* ---------------------------------------------------------------- */
  /* 3. Pulse                                                          */
  /* ---------------------------------------------------------------- */
  const pulse: McpToolDescriptor<ToolInput> = {
    name: 'pulse_reality_wave',
    description:
      'Fire a one-off shockwave through the world: the terrain waves spike, the neon light flares, and everything eases back to where it was. Nothing is permanently changed, so this is the safe way to punctuate a moment, react to something the person said, or show off that the bridge is live. Use a low intensity for a heartbeat and a high one for an explosion.',
    annotations: {
      title: 'Pulse the reality wave',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        intensity: {
          type: 'number',
          minimum: LIMITS.pulseIntensity.min,
          maximum: LIMITS.pulseIntensity.max,
          default: 2.4,
          description:
            'How hard the shockwave hits, 0.2 to 5. 0.5 is a subtle heartbeat, 2.4 is the default punch, 5 is a full detonation. Clamped.',
        },
        durationMs: {
          type: 'number',
          minimum: LIMITS.pulseDuration.min,
          maximum: LIMITS.pulseDuration.max,
          default: 1600,
          description:
            'How long the wave takes to rise and settle, in milliseconds, 200 to 8000. 400 is a snap, 1600 is the default swell, 8000 is a long slow breath. Clamped.',
        },
      },
    },
    execute: (input) => {
      try {
        const args = input ?? {};
        const notes: string[] = [];

        let intensity = 2.4;
        if (present(args.intensity)) {
          const parsed = readNumber('intensity', args.intensity, LIMITS.pulseIntensity);
          if (!parsed.ok) return failure(parsed.error);
          intensity = parsed.value;
          const note = clampNote('intensity', parsed, LIMITS.pulseIntensity);
          if (note) notes.push(note);
        }

        let durationMs = 1600;
        if (present(args.durationMs)) {
          const parsed = readNumber('durationMs', args.durationMs, LIMITS.pulseDuration);
          if (!parsed.ok) return failure(parsed.error);
          durationMs = Math.round(parsed.value);
          const note = clampNote('durationMs', parsed, LIMITS.pulseDuration);
          if (note) notes.push(note);
        }

        const summary = useWired.getState().firePulse(intensity, durationMs, 'agent');
        return success(withNotes(summary, notes), { intensity, durationMs, notes });
      } catch (err) {
        return failure('pulse_reality_wave failed: ' + errorMessage(err));
      }
    },
  };

  /* ---------------------------------------------------------------- */
  /* 4. Camera                                                         */
  /* ---------------------------------------------------------------- */
  const setCamera: McpToolDescriptor<ToolInput> = {
    name: 'set_camera_view',
    description:
      'Move the virtual camera around the Wired Future scene. Pick a framing preset, push in or pull back, raise or drop the eye line, and turn the slow automatic orbit on or off. Use this when someone wants a closer look at the model, a map-like view of the terrain, or a still frame to inspect. Every property is optional; only what you supply is changed. Pair it with capture_scene_snapshot when you want to actually see the result.',
    annotations: {
      title: 'Set the camera view',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      description: 'Supply at least one property. Omitted properties keep their current value.',
      properties: {
        preset: {
          type: 'string',
          enum: ['orbit', 'top', 'close', 'wide'],
          description:
            'Framing preset. "orbit" is the default three-quarter hero angle; "top" looks almost straight down and reads the terrain like a map; "close" sits low and tight on the hero model; "wide" pulls far back so the whole landscape and node cluster fit in frame.',
        },
        distance: {
          type: 'number',
          minimum: LIMITS.cameraDistance.min,
          maximum: LIMITS.cameraDistance.max,
          description:
            'How far the camera sits from the scene centre, 6 to 48. 6 is nose-to-the-glass, 16 is the default, 48 is a distant establishing shot. Clamped.',
        },
        height: {
          type: 'number',
          minimum: LIMITS.cameraHeight.min,
          maximum: LIMITS.cameraHeight.max,
          description:
            'Camera eye height, -6 to 30. Negative values look up at the terrain from below, 6 is the default eye line, 30 is a near top-down bird view. Clamped.',
        },
        autoOrbit: {
          type: 'boolean',
          description:
            'When true the camera drifts slowly around the scene; when false it locks in place. Turn it off before capturing a snapshot you want to compare against another one.',
        },
      },
    },
    execute: (input) => {
      try {
        const args = input ?? {};
        const camera: Partial<CameraState> = {};
        const notes: string[] = [];

        if (present(args.preset)) {
          const parsed = readEnum<CameraPreset>('preset', args.preset, CAMERA_PRESETS);
          if (!parsed.ok) return failure(parsed.error);
          camera.preset = parsed.value;
        }

        if (present(args.distance)) {
          const parsed = readNumber('distance', args.distance, LIMITS.cameraDistance);
          if (!parsed.ok) return failure(parsed.error);
          camera.distance = parsed.value;
          const note = clampNote('distance', parsed, LIMITS.cameraDistance);
          if (note) notes.push(note);
        }

        if (present(args.height)) {
          const parsed = readNumber('height', args.height, LIMITS.cameraHeight);
          if (!parsed.ok) return failure(parsed.error);
          camera.height = parsed.value;
          const note = clampNote('height', parsed, LIMITS.cameraHeight);
          if (note) notes.push(note);
        }

        if (args.autoOrbit !== undefined && args.autoOrbit !== null) {
          const parsed = readBoolean('autoOrbit', args.autoOrbit);
          if (!parsed.ok) return failure(parsed.error);
          camera.autoOrbit = parsed.value;
        }

        if (!Object.keys(camera).length) {
          return failure(
            'No camera parameters supplied. Provide at least one of preset, distance, height or autoOrbit.',
          );
        }

        // apply() merges the partial camera over the live one.
        const summary = useWired.getState().apply({ camera: camera as CameraState }, 'agent');
        return success(withNotes(summary, notes), { applied: { camera }, notes });
      } catch (err) {
        return failure('set_camera_view failed: ' + errorMessage(err));
      }
    },
  };

  /* ---------------------------------------------------------------- */
  /* 5. Node cluster                                                   */
  /* ---------------------------------------------------------------- */
  const configureNodes: McpToolDescriptor<ToolInput> = {
    name: 'configure_node_cluster',
    description:
      'Reshape the swarm of glowing nodes that drifts above the terrain. Change how many there are, how far they scatter, how fast they bob, and what colour they glow. This is the cheapest way to change the density and mood of the sky: a handful of slow far-flung nodes reads as lonely and vast, a hundred fast tight ones reads as a busy data storm. Every property is optional.',
    annotations: {
      title: 'Configure the node cluster',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      description: 'Supply at least one property. Omitted properties keep their current value.',
      properties: {
        count: {
          type: 'number',
          minimum: LIMITS.nodeCount.min,
          maximum: LIMITS.nodeCount.max,
          description:
            'How many nodes exist, 0 to 160, rounded to a whole number. 0 empties the sky entirely, 40 is the default, 160 is a dense swarm. Clamped.',
        },
        spread: {
          type: 'number',
          minimum: LIMITS.nodeSpread.min,
          maximum: LIMITS.nodeSpread.max,
          description:
            'Radius the nodes scatter across, 6 to 60. 6 packs them into a tight knot above the model, 26 is the default, 60 flings them out to the horizon. Clamped.',
        },
        floatSpeed: {
          type: 'number',
          minimum: LIMITS.nodeFloatSpeed.min,
          maximum: LIMITS.nodeFloatSpeed.max,
          description:
            'How fast the nodes bob and drift, 0 to 5. 0 freezes them mid-air, 1 is the default gentle float, 5 is agitated. Clamped.',
        },
        colorHex: {
          type: 'string',
          description:
            'Hex colour the nodes glow, #rgb or #rrggbb, for example "#8b5cff". CSS colour names are rejected - convert to hex first.',
        },
      },
    },
    execute: (input) => {
      try {
        const args = input ?? {};
        const nodes: Partial<NodeClusterState> = {};
        const notes: string[] = [];

        if (present(args.count)) {
          const parsed = readNumber('count', args.count, LIMITS.nodeCount);
          if (!parsed.ok) return failure(parsed.error);
          nodes.count = Math.round(parsed.value);
          const note = clampNote('count', parsed, LIMITS.nodeCount);
          if (note) notes.push(note);
        }

        if (present(args.spread)) {
          const parsed = readNumber('spread', args.spread, LIMITS.nodeSpread);
          if (!parsed.ok) return failure(parsed.error);
          nodes.spread = parsed.value;
          const note = clampNote('spread', parsed, LIMITS.nodeSpread);
          if (note) notes.push(note);
        }

        if (present(args.floatSpeed)) {
          const parsed = readNumber('floatSpeed', args.floatSpeed, LIMITS.nodeFloatSpeed);
          if (!parsed.ok) return failure(parsed.error);
          nodes.floatSpeed = parsed.value;
          const note = clampNote('floatSpeed', parsed, LIMITS.nodeFloatSpeed);
          if (note) notes.push(note);
        }

        if (present(args.colorHex)) {
          const parsed = readHex('colorHex', args.colorHex);
          if (!parsed.ok) return failure(parsed.error);
          nodes.colorHex = parsed.value;
        }

        if (!Object.keys(nodes).length) {
          return failure(
            'No node parameters supplied. Provide at least one of count, spread, floatSpeed or colorHex.',
          );
        }

        const summary = useWired.getState().apply({ nodes: nodes as NodeClusterState }, 'agent');
        return success(withNotes(summary, notes), { applied: { nodes }, notes });
      } catch (err) {
        return failure('configure_node_cluster failed: ' + errorMessage(err));
      }
    },
  };

  /* ---------------------------------------------------------------- */
  /* 6. Presets                                                        */
  /* ---------------------------------------------------------------- */
  const applyPreset: McpToolDescriptor<ToolInput> = {
    name: 'apply_scene_preset',
    description:
      'Flip the entire world to a hand-tuned look in one call - colours, wave motion, fog, camera rig and node cluster all at once. Prefer this over a pile of individual edits when someone describes a mood rather than a number ("make it warmer", "something cold and empty", "go full sci-fi hologram"). It overwrites every parameter the preset covers, so use modify_wired_future_environment afterwards if you want to tweak one detail.',
    annotations: {
      title: 'Apply a scene preset',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['preset'],
      properties: {
        preset: {
          type: 'string',
          enum: ['neon-noir', 'solar-flare', 'deep-void', 'hologram'],
          description:
            'Which look to apply. "neon-noir" is the signature cyan-on-black cyberpunk default with a magenta horizon and a calm orbiting camera. "solar-flare" is hot orange and yellow, fast high waves, a wide shot and a dense swarm of red nodes - loud and energetic. "deep-void" is cold deep blue with mint accents, almost still water, heavy fog, only eighteen far-flung nodes and a locked close camera - lonely and quiet. "hologram" is pale ice-white and near-transparent, almost no fog, a top-down view and ninety-six fast nodes - clinical and futuristic.',
        },
      },
    },
    execute: (input) => {
      try {
        const args = input ?? {};
        if (!present(args.preset)) {
          return failure(
            'A preset name is required. Choose one of ' +
              SCENE_PRESET_NAMES.map(quote).join(', ') +
              '.',
          );
        }

        const parsed = readEnum<ScenePresetName>('preset', args.preset, SCENE_PRESET_NAMES);
        if (!parsed.ok) return failure(parsed.error);

        const summary = useWired.getState().applyPreset(parsed.value, 'agent');
        return success(summary, { preset: parsed.value });
      } catch (err) {
        return failure('apply_scene_preset failed: ' + errorMessage(err));
      }
    },
  };

  /* ---------------------------------------------------------------- */
  /* 7. Snapshot                                                       */
  /* ---------------------------------------------------------------- */
  const captureSnapshot: McpToolDescriptor<ToolInput> = {
    name: 'capture_scene_snapshot',
    description:
      'Render the live 3D canvas to an image and return it, so you can actually look at the scene instead of inferring it from numbers. Use it to verify a change landed the way you intended, to compare a before and after, or when the person asks what the scene looks like right now. Changes nothing. If the canvas has not finished mounting yet this returns an error rather than a blank frame - wait a moment and try again.',
    annotations: {
      title: 'Capture a snapshot',
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        maxWidth: {
          type: 'number',
          minimum: 240,
          maximum: 1280,
          default: 640,
          description:
            'Longest edge of the returned image in pixels, 240 to 1280. 640 is the default and is plenty to judge colour and composition; go higher only when you need to read fine wireframe detail. Clamped.',
        },
      },
    },
    execute: (input) => {
      try {
        const args = input ?? {};

        let maxWidth = 640;
        if (present(args.maxWidth)) {
          const parsed = readNumber('maxWidth', args.maxWidth, { min: 240, max: 1280 });
          if (!parsed.ok) return failure(parsed.error);
          maxWidth = Math.round(parsed.value);
        }

        const engine = getEngine();
        if (!engine) {
          return failure(
            'The 3D canvas is not mounted yet, so there is nothing to capture. Call get_wired_future_state to read the scene instead, or retry the snapshot in a moment.',
          );
        }

        const snap = engine.capture(maxWidth);
        if (!snap) {
          return failure(
            'Snapshot failed: the renderer returned no frame. The canvas may still be initialising or the tab may be backgrounded. Retry shortly.',
          );
        }

        const store = useWired.getState();
        const state = store.snapshot();
        const description = describeScene(state);
        store.log('agent', 'captured a ' + snap.width + 'x' + snap.height + ' snapshot');
        store.noteAgentCall();

        const content: McpContent[] = [
          { type: 'image', data: snap.base64, mimeType: snap.mimeType },
          {
            type: 'text',
            text:
              'Snapshot of the Wired Future canvas, ' +
              snap.width +
              'x' +
              snap.height +
              ' ' +
              snap.mimeType +
              '. ' +
              description,
          },
        ];

        return {
          content,
          structuredContent: {
            ok: true,
            width: snap.width,
            height: snap.height,
            mimeType: snap.mimeType,
            state,
            description,
            mcpStatus: store.mcpStatus,
            agentActionCount: store.agentActionCount,
          },
        };
      } catch (err) {
        return failure('capture_scene_snapshot failed: ' + errorMessage(err));
      }
    },
  };

  /* ---------------------------------------------------------------- */
  /* 8. reset_wired_future                                             */
  /* ---------------------------------------------------------------- */

  const resetScene: McpToolDescriptor<ToolInput> = {
    name: 'reset_wired_future',
    description:
      'Restore every scene parameter - grid and accent colour, model, wave velocity and amplitude, ' +
      'fog, camera framing and the whole node cluster - to the Wired Future defaults. ' +
      'Use this when the person asks to start over, undo everything, or put it back the way it was. ' +
      'This is the exact same Reset control the human has in the Control Deck; no preset reproduces it, ' +
      'because presets do not restore the default model type.',
    annotations: {
      title: 'Reset the scene',
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
    execute: () => {
      try {
        return success(useWired.getState().reset('agent'));
      } catch (err) {
        return failure('reset_wired_future failed: ' + errorMessage(err));
      }
    },
  };

  /* ---------------------------------------------------------------- */
  /* 9. place_object                                                   */
  /* ---------------------------------------------------------------- */

  const placeObject: McpToolDescriptor<ToolInput> = {
    name: 'place_object',
    description:
      'Move, turn or resize the centre-stage object. World units: the stage is about 120 units across, the object is roughly 5 units long, and the camera orbits at 16 units. Y is up and 0 is ground level. Rotation is in DEGREES; yaw (rotationDeg.y) is the one you usually want. This is the same placement a person produces by dragging the on-screen gizmo, so call get_wired_future_state first when making a relative move like "push it back a bit".',
    annotations: {
      title: 'Place the object',
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      description: 'Supply at least one of position, rotationDeg or scale.',
      properties: {
        position: {
          type: 'object',
          additionalProperties: false,
          description:
            'Absolute world position. Omit an axis to leave it where it is.',
          properties: {
            x: {
              type: 'number',
              description:
                'Left/right, ' + LIMITS.positionX.min + ' to ' + LIMITS.positionX.max + '.',
            },
            y: {
              type: 'number',
              description:
                'Up/down, ' + LIMITS.positionY.min + ' to ' + LIMITS.positionY.max + '. 0 rests on the ground.',
            },
            z: {
              type: 'number',
              description:
                'Near/far, ' + LIMITS.positionZ.min + ' to ' + LIMITS.positionZ.max + '.',
            },
          },
        },
        rotationDeg: {
          type: 'object',
          additionalProperties: false,
          description: 'Euler angles in degrees. Values wrap, so 370 becomes 10.',
          properties: {
            x: { type: 'number', description: 'Pitch in degrees.' },
            y: { type: 'number', description: 'Yaw in degrees. The usual one.' },
            z: { type: 'number', description: 'Roll in degrees.' },
          },
        },
        scale: {
          type: 'number',
          description:
            'Uniform scale, ' + LIMITS.scale.min + ' to ' + LIMITS.scale.max + '. 1 is the natural size.',
        },
      },
    },
    execute: (input) => {
      try {
        const raw = (input ?? {}) as {
          position?: Partial<{ x: number; y: number; z: number }>;
          rotationDeg?: Partial<{ x: number; y: number; z: number }>;
          scale?: number;
        };

        if (!raw.position && !raw.rotationDeg && raw.scale === undefined) {
          return failure(
            'place_object needs at least one of position, rotationDeg or scale.',
          );
        }

        // Merge against the live values so a partial axis is a nudge, not a
        // reset of every axis the caller left out.
        const live = useWired.getState().transform;
        const summary = useWired.getState().setTransform(
          {
            position: { ...live.position, ...(raw.position ?? {}) },
            rotationDeg: { ...live.rotationDeg, ...(raw.rotationDeg ?? {}) },
            scale: raw.scale ?? live.scale,
          },
          'agent',
        );
        return success(summary);
      } catch (err) {
        return failure('place_object failed: ' + errorMessage(err));
      }
    },
  };

  /* ---------------------------------------------------------------- */
  /* 10. set_edit_mode                                                 */
  /* ---------------------------------------------------------------- */

  const setEditModeTool: McpToolDescriptor<ToolInput> = {
    name: 'set_edit_mode',
    description:
      "Change what the PERSON's mouse does on the canvas. 'orbit' lets them fly the camera around the scene; 'translate', 'rotate' and 'scale' arm a drag gizmo on the object so they can place it by hand. This changes their controls rather than the scene, so say why you switched - for example, arm 'rotate' when you have asked them to aim the car themselves.",
    annotations: {
      title: 'Set the edit mode',
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['mode'],
      properties: {
        mode: {
          type: 'string',
          enum: ['orbit', 'translate', 'rotate', 'scale'],
          description:
            'orbit = camera control. translate = move gizmo. rotate = turn gizmo. scale = resize gizmo.',
        },
      },
    },
    execute: (input) => {
      try {
        const mode = (input as { mode?: string } | undefined)?.mode;
        if (!mode || !EDIT_MODES.includes(mode as EditMode)) {
          return failure(
            'set_edit_mode needs mode to be one of: ' + EDIT_MODES.join(', '),
          );
        }
        return success(
          useWired.getState().apply({ editMode: mode as EditMode }, 'agent'),
        );
      } catch (err) {
        return failure('set_edit_mode failed: ' + errorMessage(err));
      }
    },
  };

  /* ---------------------------------------------------------------- */
  /* 11. set_car_body                                                  */
  /* ---------------------------------------------------------------- */

  const setCarBody: McpToolDescriptor<ToolInput> = {
    name: 'set_car_body',
    description:
      "Choose which car is on stage. 'real' loads a genuine glTF concept car with PBR paint, glass and rims; it streams an 11 MB asset, so the parametric car shows for a second or two first. 'parametric' is the built-in geometric car, which loads instantly and sits closer to the wireframe aesthetic. Also switches the hero model to the car.",
    annotations: {
      title: 'Set the car body',
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['variant'],
      properties: {
        variant: {
          type: 'string',
          enum: ['real', 'parametric'],
          description:
            'real = loaded glTF concept car. parametric = built-in editable mesh.',
        },
      },
    },
    execute: (input) => {
      try {
        const variant = (input as { variant?: string } | undefined)?.variant;
        if (variant !== 'real' && variant !== 'parametric') {
          return failure(
            "set_car_body needs variant to be 'real' or 'parametric'.",
          );
        }
        return success(
          useWired
            .getState()
            .apply({ carVariant: variant, modelType: 'car' }, 'agent'),
        );
      } catch (err) {
        return failure('set_car_body failed: ' + errorMessage(err));
      }
    },
  };

  /* ---------------------------------------------------------------- */
  /* 12. reconstruct_photo_object                                      */
  /* ---------------------------------------------------------------- */

  const photoObject: McpToolDescriptor<ToolInput> = {
    name: 'reconstruct_photo_object',
    description:
      "Inspect or control the photo-to-3D reconstruction. A person can drop a photo of an OBJECT onto this page and a depth model running inside their browser rebuilds it as 3D relief geometry on the stage. You cannot upload an image yourself - if none exists, ASK the person to drop one onto the Photo to 3D panel. Use action 'status' to see whether a reconstruction is ready and what it is of, 'show' to put it on stage, and 'clear' to discard it and return to the car. People and animals are declined by design; only inanimate objects are reconstructed.",
    annotations: { title: 'Photo reconstruction', openWorldHint: false },
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: {
          type: 'string',
          enum: ['status', 'show', 'clear'],
          description:
            'status = report what has been reconstructed (read-only). show = display it on stage. clear = discard it and go back to the car.',
        },
      },
    },
    execute: (input) => {
      try {
        const action = (input as { action?: string } | undefined)?.action;
        const store = useWired.getState();
        const photo = store.photo;

        if (action === 'status') {
          store.noteAgentCall();
          const line =
            photo.status === 'ready'
              ? 'A reconstruction of "' +
                (photo.sourceName ?? 'an image') +
                '" (' +
                (photo.subject ?? 'object') +
                ') is ready at ' +
                photo.width +
                'x' +
                photo.height +
                '.'
              : photo.status === 'idle'
                ? 'No photo has been dropped yet. Ask the person to drop an image of an object onto the Photo to 3D panel.'
                : 'The photo pipeline is "' + photo.status + '": ' + photo.message;
          store.log('agent', 'checked the photo reconstruction');
          return success(line, { photo: { ...photo } });
        }

        if (action === 'show') {
          if (photo.status !== 'ready' || !getEngine()?.hasPhotoRelief()) {
            return failure(
              'There is no reconstruction to show yet. Ask the person to drop a photo of an object onto the Photo to 3D panel first.',
            );
          }
          return success(store.apply({ modelType: 'photo' }, 'agent'));
        }

        if (action === 'clear') {
          getEngine()?.clearPhotoRelief();
          store.resetPhoto('agent');
          return success(store.apply({ modelType: 'car' }, 'agent'));
        }

        return failure(
          "reconstruct_photo_object needs action to be 'status', 'show' or 'clear'.",
        );
      } catch (err) {
        return failure('reconstruct_photo_object failed: ' + errorMessage(err));
      }
    },
  };

  /* ---------------------------------------------------------------- */
  /* 13. configure_car_rig                                             */
  /* ---------------------------------------------------------------- */

  const configureCarRig: McpToolDescriptor<ToolInput> = {
    name: 'configure_car_rig',
    description:
      "Open, strip and take apart the concept car. It is a real glTF asset built from 97 separate named parts, so this genuinely articulates it rather than faking an animation. finish 'print' swaps all paint, glass and trim for one matte resin grey - the 3D-print view, which is how you actually read the shape. explode fans every assembly out along its own axis into a parts diagram (0 assembled, 1 fully apart). doorLeft, doorRight and hood each swing on their real hinge from 0 shut to 1 wide open. Only affects the 'real' car body - call set_car_body with variant 'real' first if the parametric car is showing.",
    annotations: {
      title: 'Configure the car rig',
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      description: 'Supply at least one field. Omitted fields are left alone.',
      properties: {
        finish: {
          type: 'string',
          enum: ['paint', 'print'],
          description:
            "paint = the asset's own PBR bodywork. print = matte resin grey with the glass made solid, like an unpainted 3D print.",
        },
        explode: {
          type: 'number',
          description:
            'How far apart the assemblies fly, 0 (assembled) to 1 (full parts diagram). 0.35 reads as a cutaway; 1 is a full teardown.',
        },
        doorLeft: {
          type: 'number',
          description: 'Left door angle, 0 shut to 1 fully open.',
        },
        doorRight: {
          type: 'number',
          description: 'Right door angle, 0 shut to 1 fully open.',
        },
        hood: {
          type: 'number',
          description: 'Hood angle, 0 shut to 1 fully raised.',
        },
      },
    },
    execute: (input) => {
      try {
        const raw = (input ?? {}) as {
          finish?: string;
          explode?: number;
          doorLeft?: number;
          doorRight?: number;
          hood?: number;
        };

        const keys = ['finish', 'explode', 'doorLeft', 'doorRight', 'hood'] as const;
        if (!keys.some((k) => raw[k] !== undefined)) {
          return failure(
            'configure_car_rig needs at least one of: ' + keys.join(', ') + '.',
          );
        }

        if (raw.finish && !CAR_FINISHES.includes(raw.finish as CarFinish)) {
          return failure(
            "configure_car_rig finish must be 'paint' or 'print', got \"" +
              raw.finish +
              '".',
          );
        }

        const store = useWired.getState();
        const summary = store.apply(
          { carRig: { ...store.carRig, ...(raw as object) } },
          'agent',
        );

        const note =
          store.carVariant === 'real'
            ? ''
            : ' (note: the parametric car is showing, so this has no visible effect until set_car_body variant "real")';

        return success(summary + note);
      } catch (err) {
        return failure('configure_car_rig failed: ' + errorMessage(err));
      }
    },
  };

  /* ---------------------------------------------------------------- */
  /* 14. set_car_parts                                                 */
  /* ---------------------------------------------------------------- */

  const setCarParts: McpToolDescriptor<ToolInput> = {
    name: 'set_car_parts',
    description:
      "Detach or refit individual assemblies of the concept car - take the wheels off, drop the body shell to expose the interior and engine, remove the glass. Assemblies: " +
      CAR_PART_IDS.map((id) => id + ' (' + CAR_PART_LABELS[id] + ')').join(', ') +
      ". action 'remove' hides the listed parts, 'refit' puts them back, 'only' shows ONLY the listed parts, and 'reset' refits everything. Nothing is destroyed - a removed part is always one call away from returning.",
    annotations: {
      title: 'Detach or refit car parts',
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: {
          type: 'string',
          enum: ['remove', 'refit', 'only', 'reset'],
          description:
            "remove = detach the listed parts. refit = put them back. only = show just these. reset = refit everything (ignores parts).",
        },
        parts: {
          type: 'array',
          items: { type: 'string', enum: CAR_PART_IDS },
          description:
            "Assembly ids. Required for remove / refit / only; ignored for reset. Example: [\"wheelFL\",\"wheelFR\",\"wheelRL\",\"wheelRR\"] takes all four wheels off.",
        },
      },
    },
    execute: (input) => {
      try {
        const raw = (input ?? {}) as { action?: string; parts?: unknown };
        const action = raw.action;
        const store = useWired.getState();
        const current = store.carRig.hidden;

        if (action === 'reset') {
          return success(
            store.apply({ carRig: { ...store.carRig, hidden: [] } }, 'agent'),
          );
        }

        const requested = Array.isArray(raw.parts) ? raw.parts : [];
        const valid: CarPartId[] = [];
        const unknown: string[] = [];
        for (const entry of requested) {
          if (typeof entry === 'string' && CAR_PART_IDS.includes(entry as CarPartId)) {
            valid.push(entry as CarPartId);
          } else {
            unknown.push(String(entry));
          }
        }

        if (unknown.length) {
          return failure(
            'Unknown car part(s): ' +
              unknown.join(', ') +
              '. Valid ids are: ' +
              CAR_PART_IDS.join(', ') +
              '.',
          );
        }
        if (!valid.length) {
          return failure(
            "set_car_parts needs a non-empty parts array for action '" +
              String(action) +
              "'.",
          );
        }

        let hidden: CarPartId[];
        if (action === 'remove') {
          hidden = Array.from(new Set([...current, ...valid]));
        } else if (action === 'refit') {
          const drop = new Set(valid);
          hidden = current.filter((id) => !drop.has(id));
        } else if (action === 'only') {
          const keep = new Set(valid);
          hidden = CAR_PART_IDS.filter((id) => !keep.has(id));
        } else {
          return failure(
            "set_car_parts action must be 'remove', 'refit', 'only' or 'reset'.",
          );
        }

        return success(
          useWired
            .getState()
            .apply({ carRig: { ...store.carRig, hidden } }, 'agent'),
        );
      } catch (err) {
        return failure('set_car_parts failed: ' + errorMessage(err));
      }
    },
  };

  /* ---------------------------------------------------------------- */
  /* 15. inspect_car_part                                              */
  /* ---------------------------------------------------------------- */

  const inspectCarPart: McpToolDescriptor<ToolInput> = {
    name: 'inspect_car_part',
    description:
      'Measure one assembly of the concept car from its actual triangles: triangle and vertex counts, surface area, bounding-box dimensions, centroid, whether the mesh is watertight, and the estimated mass in every available engineering material. Real geometry, computed in the browser - not a lookup table. Call this before proposing an upgrade so your suggestion is grounded in the part true size and mass rather than a guess. Lengths come back in metres (the car is normalised to 5.2 model units for a real length of about 4.6 m). MASS IS A SHELL ESTIMATE: automotive parts are pressed panels and castings, not solid billets, so mass is surface area x wall thickness x density, defaulting to a 2 mm wall. Pass wallThicknessMm to model a thicker casting or a thinner skin. The enclosed volume is also returned, but for an open shell it is geometrically meaningless and is flagged as such.',
    annotations: {
      title: 'Measure a car part',
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['part'],
      properties: {
        part: {
          type: 'string',
          enum: CAR_PART_IDS,
          description: 'Which assembly to measure.',
        },
        wallThicknessMm: {
          type: 'number',
          description:
            'Wall thickness used for the mass estimate, in millimetres. Default 2. Typical: 0.8-1.2 for a steel body panel, 3-6 for a cast alloy wheel, 2-4 for a structural carbon panel.',
        },
      },
    },
    execute: (input) => {
      try {
        const part = (input as { part?: string } | undefined)?.part;
        if (!part || !CAR_PART_IDS.includes(part as CarPartId)) {
          return failure(
            'inspect_car_part needs part to be one of: ' + CAR_PART_IDS.join(', ') + '.',
          );
        }

        const store = useWired.getState();
        const engine = getEngine();
        const measured = engine ? engine.measureCarPart(part as CarPartId) : null;

        if (!measured) {
          return failure(
            'Cannot measure "' +
              part +
              '" right now. The glTF concept car must be the model on stage - call set_car_body with variant "real" first, and give the 11 MB asset a moment to load.',
          );
        }

        store.noteAgentCall();

        const m = MODEL_UNITS_TO_METRES;
        const volumeM3 = measured.volume * m * m * m;
        const areaM2 = measured.surfaceArea * m * m;

        const rawThickness = (input as { wallThicknessMm?: number } | undefined)
          ?.wallThicknessMm;
        const wallMm =
          typeof rawThickness === 'number' && Number.isFinite(rawThickness)
            ? Math.min(40, Math.max(0.2, rawThickness))
            : 2;

        // Shell mass, not solid mass. A car panel is a pressing; treating the
        // volume its surface encloses as solid metal gives figures an order of
        // magnitude too high (a 770 kg road wheel).
        const shellVolumeM3 = areaM2 * (wallMm / 1000);

        const masses: Record<string, number> = {};
        for (const id of PART_MATERIAL_IDS) {
          masses[id] =
            Math.round(shellVolumeM3 * PART_MATERIALS[id].density * 100) / 100;
        }

        const edit = store.carRig.edits[part as CarPartId] ?? IDENTITY_EDIT;

        const text =
          CAR_PART_LABELS[part as CarPartId] +
          ': ' +
          measured.triangles.toLocaleString() +
          ' triangles, ' +
          tidy(measured.size.x * m) +
          ' x ' +
          tidy(measured.size.y * m) +
          ' x ' +
          tidy(measured.size.z * m) +
          ' m, surface ' +
          tidy(areaM2) +
          ' m2. As a ' +
          wallMm +
          ' mm shell that is about ' +
          masses.carbon +
          ' kg in carbon fibre, ' +
          masses.aluminium +
          ' kg in aluminium, ' +
          masses.steel +
          ' kg in steel.' +
          (measured.watertight
            ? ' The mesh is watertight, so its enclosed volume of ' +
              tidy(volumeM3) +
              ' m3 is exact if you need a solid-billet figure.'
            : ' The mesh is an open shell, so its enclosed volume is not meaningful.');

        return success(text, {
          part,
          label: CAR_PART_LABELS[part as CarPartId],
          measured,
          metres: {
            size: {
              x: measured.size.x * m,
              y: measured.size.y * m,
              z: measured.size.z * m,
            },
            surfaceAreaM2: areaM2,
            enclosedVolumeM3: volumeM3,
            enclosedVolumeMeaningful: measured.watertight,
          },
          massModel: {
            method: 'shell: surfaceArea * wallThickness * density',
            wallThicknessMm: wallMm,
            shellVolumeM3,
          },
          estimatedMassKg: masses,
          materialDensities: Object.fromEntries(
            PART_MATERIAL_IDS.map((id) => [id, PART_MATERIALS[id].density]),
          ),
          currentEdit: edit,
          availableOperations: {
            scaleX: PART_EDIT_LIMITS.scale,
            scaleY: PART_EDIT_LIMITS.scale,
            scaleZ: PART_EDIT_LIMITS.scale,
            inflate: PART_EDIT_LIMITS.inflate,
            twistDeg: PART_EDIT_LIMITS.twistDeg,
            material: PART_MATERIAL_IDS,
          },
        });
      } catch (err) {
        return failure('inspect_car_part failed: ' + errorMessage(err));
      }
    },
  };

  /* ---------------------------------------------------------------- */
  /* 16. modify_car_part                                               */
  /* ---------------------------------------------------------------- */

  const modifyCarPart: McpToolDescriptor<ToolInput> = {
    name: 'modify_car_part',
    description:
      "Reshape one assembly of the car by rewriting its vertices. scaleX/Y/Z stretch it about its own centre, so scaling a wheel widens the tyre without moving it off the axle. inflate offsets every vertex along its surface normal, which thickens a panel or puffs a shell outward. twistDeg rotates the part progressively about the vertical axis, distributed over its height. material re-specifies it in a real engineering material, changing both its look and its calculated mass. Edits are ABSOLUTE and rebuilt from the pristine geometry each time, so sending scaleX 1.2 twice leaves it at 1.2, and reset returns it exactly to the shipped part. Measure first with inspect_car_part so you know what you are changing.",
    annotations: {
      title: 'Reshape a car part',
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['part'],
      description:
        'Supply part plus at least one change, or part plus reset:true to restore it.',
      properties: {
        part: {
          type: 'string',
          enum: CAR_PART_IDS,
          description: 'Which assembly to reshape.',
        },
        reset: {
          type: 'boolean',
          description:
            'Restore this part to the shipped geometry and material, discarding every edit.',
        },
        scaleX: {
          type: 'number',
          description:
            'Scale across the car, ' + PART_EDIT_LIMITS.scale.min + ' to ' + PART_EDIT_LIMITS.scale.max + '. 1 is untouched.',
        },
        scaleY: {
          type: 'number',
          description:
            'Vertical scale, ' + PART_EDIT_LIMITS.scale.min + ' to ' + PART_EDIT_LIMITS.scale.max + '.',
        },
        scaleZ: {
          type: 'number',
          description:
            'Scale along the car, ' + PART_EDIT_LIMITS.scale.min + ' to ' + PART_EDIT_LIMITS.scale.max + '.',
        },
        inflate: {
          type: 'number',
          description:
            'Offset along surface normals in model units, ' + PART_EDIT_LIMITS.inflate.min + ' to ' + PART_EDIT_LIMITS.inflate.max + '. One model unit is about 0.88 m, so 0.02 is roughly 18 mm of added thickness.',
        },
        twistDeg: {
          type: 'number',
          description:
            'Twist about the vertical axis over the part height, ' + PART_EDIT_LIMITS.twistDeg.min + ' to ' + PART_EDIT_LIMITS.twistDeg.max + ' degrees.',
        },
        material: {
          type: 'string',
          enum: PART_MATERIAL_IDS,
          description:
            'Re-specify the part: ' +
            PART_MATERIAL_IDS.map(
              (id) => id + ' (' + PART_MATERIALS[id].density + ' kg/m3)',
            ).join(', ') +
            '.',
        },
      },
    },
    execute: (input) => {
      try {
        const raw = (input ?? {}) as Record<string, unknown>;
        const part = raw.part as string | undefined;

        if (!part || !CAR_PART_IDS.includes(part as CarPartId)) {
          return failure(
            'modify_car_part needs part to be one of: ' + CAR_PART_IDS.join(', ') + '.',
          );
        }

        const id = part as CarPartId;
        const store = useWired.getState();

        if (raw.reset === true) {
          const nextEdits = { ...store.carRig.edits };
          delete nextEdits[id];
          const summary = useWired
            .getState()
            .apply({ carRig: { ...store.carRig, edits: nextEdits } }, 'agent');
          return success(
            CAR_PART_LABELS[id] + ' restored to the shipped part. ' + summary,
          );
        }

        const fields = ['scaleX', 'scaleY', 'scaleZ', 'inflate', 'twistDeg', 'material'] as const;
        if (!fields.some((f) => raw[f] !== undefined)) {
          return failure(
            'modify_car_part needs at least one of ' +
              fields.join(', ') +
              ', or reset:true.',
          );
        }

        if (
          raw.material !== undefined &&
          !PART_MATERIAL_IDS.includes(raw.material as PartMaterialId)
        ) {
          return failure(
            'Unknown material "' +
              String(raw.material) +
              '". Available: ' +
              PART_MATERIAL_IDS.join(', ') +
              '.',
          );
        }

        const current: PartEdit = store.carRig.edits[id] ?? IDENTITY_EDIT;
        const nextEdit: PartEdit = {
          scaleX: (raw.scaleX as number) ?? current.scaleX,
          scaleY: (raw.scaleY as number) ?? current.scaleY,
          scaleZ: (raw.scaleZ as number) ?? current.scaleZ,
          inflate: (raw.inflate as number) ?? current.inflate,
          twistDeg: (raw.twistDeg as number) ?? current.twistDeg,
          material:
            raw.material === undefined
              ? current.material
              : (raw.material as PartMaterialId),
        };

        const summary = useWired.getState().apply(
          {
            carRig: {
              ...store.carRig,
              edits: { ...store.carRig.edits, [id]: nextEdit },
            },
          },
          'agent',
        );

        // Only re-measure when the answer actually needs it. A reshape
        // invalidates the cache, so measuring here walks every triangle again
        // — worth it to quote a new mass, wasteful for a pure scale change the
        // caller can follow up with inspect_car_part if it wants numbers.
        const engine = nextEdit.material ? getEngine() : null;
        const measured = engine ? engine.measureCarPart(id) : null;
        const m = MODEL_UNITS_TO_METRES;
        // Same 2 mm shell model as inspect_car_part, so the two tools never
        // disagree about what a part weighs.
        const massNote =
          measured && nextEdit.material
            ? ' Now about ' +
              Math.round(
                measured.surfaceArea *
                  m *
                  m *
                  0.002 *
                  PART_MATERIALS[nextEdit.material].density *
                  100,
              ) /
                100 +
              ' kg as a 2 mm ' +
              PART_MATERIALS[nextEdit.material].label +
              ' shell.'
            : '';

        return success(
          CAR_PART_LABELS[id] + ' reshaped. ' + summary + massNote,
          { part: id, edit: nextEdit, measured },
        );
      } catch (err) {
        return failure('modify_car_part failed: ' + errorMessage(err));
      }
    },
  };

  /* ---------------------------------------------------------------- */
  /* 17. list_car_parts                                                */
  /* ---------------------------------------------------------------- */

  const listCarParts: McpToolDescriptor<ToolInput> = {
    name: 'list_car_parts',
    description:
      'Enumerate every individually addressable mesh of the concept car - over a hundred of them, down to individual door handles, wing mirrors, wipers, brake discs, steering wheel spokes and pedals. Returns each part id, its human label and which assembly it belongs to. Call this before place_car_part or detach_car_parts, because those address parts by id and the ids are asset-specific. Optionally filter by assembly or by a substring of the label.',
    annotations: {
      title: 'List every car part',
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        assembly: {
          type: 'string',
          enum: CAR_PART_IDS,
          description: 'Only parts belonging to this assembly.',
        },
        search: {
          type: 'string',
          description:
            'Case-insensitive substring of the label, e.g. "handle", "wiper", "disc".',
        },
      },
    },
    execute: (input) => {
      try {
        const engine = getEngine();
        const all = engine ? engine.listCarNodes() : [];
        if (!all.length) {
          return failure(
            'The part list is empty. The glTF concept car must be on stage - call set_car_body with variant "real" and allow a moment for the 11 MB asset to load.',
          );
        }

        const raw = (input ?? {}) as { assembly?: string; search?: string };
        const search = (raw.search ?? '').trim().toLowerCase();

        const matched = all.filter(
          (n) =>
            (!raw.assembly || n.assembly === raw.assembly) &&
            (!search || n.label.toLowerCase().includes(search)),
        );

        useWired.getState().noteAgentCall();
        useWired.getState().log('agent', 'listed ' + matched.length + ' car parts');

        const preview = matched
          .slice(0, 25)
          .map((n) => n.label + ' (' + n.id + ')')
          .join('; ');

        return success(
          matched.length +
            ' of ' +
            all.length +
            ' parts matched. ' +
            preview +
            (matched.length > 25 ? ' ... and more, see structuredContent.' : ''),
          { parts: matched, total: all.length },
        );
      } catch (err) {
        return failure('list_car_parts failed: ' + errorMessage(err));
      }
    },
  };

  /* ---------------------------------------------------------------- */
  /* 18. select_car_part                                               */
  /* ---------------------------------------------------------------- */

  const selectCarPart: McpToolDescriptor<ToolInput> = {
    name: 'select_car_part',
    description:
      "Point the on-screen transform gizmo at a part, so the PERSON can drag it by hand. Selecting an assembly (a whole door) or a single mesh (that door's handle) changes what their mouse grabs. This is a handoff: use it when you want them to position something themselves, and say so. Pass nothing to clear the selection.",
    annotations: { title: 'Select a part', idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        assembly: {
          type: 'string',
          enum: CAR_PART_IDS,
          description: 'Select a whole assembly. Ignored when part is given.',
        },
        part: {
          type: 'string',
          description:
            'A part id from list_car_parts, for single-mesh selection. Wins over assembly.',
        },
      },
    },
    execute: (input) => {
      try {
        const raw = (input ?? {}) as { assembly?: string; part?: string };
        const store = useWired.getState();

        if (raw.part) {
          const node = (getEngine()?.listCarNodes() ?? []).find(
            (n) => n.id === raw.part,
          );
          if (!node) {
            return failure(
              'No part with id "' + raw.part + '". Call list_car_parts for valid ids.',
            );
          }
          return success(
            store.select({ level: 'node', id: node.id, label: node.label }, 'agent'),
          );
        }

        if (raw.assembly && CAR_PART_IDS.includes(raw.assembly as CarPartId)) {
          const id = raw.assembly as CarPartId;
          return success(
            store.select(
              { level: 'assembly', id, label: CAR_PART_LABELS[id] },
              'agent',
            ),
          );
        }

        return success(store.select(null, 'agent'));
      } catch (err) {
        return failure('select_car_part failed: ' + errorMessage(err));
      }
    },
  };

  /* ---------------------------------------------------------------- */
  /* 19. place_car_part                                                */
  /* ---------------------------------------------------------------- */

  const placeCarPart: McpToolDescriptor<ToolInput> = {
    name: 'place_car_part',
    description:
      'Move, turn or resize ONE individual mesh - lift a wing mirror off, rotate a wheel rim, shrink a door handle. Offsets are relative to the part\u2019s rest position in model units (one unit is about 0.88 m), so the part keeps riding its assembly when a door swings or the car explodes. Absolute, not cumulative: sending the same offset twice leaves it in one place. Pass reset:true to put it back. Get part ids from list_car_parts.',
    annotations: { title: 'Place one car part', idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['part'],
      properties: {
        part: { type: 'string', description: 'Part id from list_car_parts.' },
        reset: {
          type: 'boolean',
          description: 'Return this part to its rest position and scale.',
        },
        x: {
          type: 'number',
          description:
            'Offset across the car, ' + NODE_LIMITS.offset.min + ' to ' + NODE_LIMITS.offset.max + '.',
        },
        y: { type: 'number', description: 'Offset up/down, same range.' },
        z: { type: 'number', description: 'Offset along the car, same range.' },
        rotY: { type: 'number', description: 'Yaw in degrees. Values wrap.' },
        scale: {
          type: 'number',
          description:
            'Scale, ' + NODE_LIMITS.scale.min + ' to ' + NODE_LIMITS.scale.max + '. 1 is untouched.',
        },
      },
    },
    execute: (input) => {
      try {
        const raw = (input ?? {}) as Record<string, unknown>;
        const part = raw.part as string | undefined;
        if (!part) return failure('place_car_part needs a part id.');

        const known = (getEngine()?.listCarNodes() ?? []).some((n) => n.id === part);
        if (!known) {
          return failure(
            'No part with id "' + part + '". Call list_car_parts for valid ids.',
          );
        }

        const store = useWired.getState();

        if (raw.reset === true) {
          return success(
            store.setNodeTransform(part, { ...IDENTITY_NODE_TRANSFORM }, 'agent'),
          );
        }

        const live = store.carRig.nodeTransforms[part] ?? IDENTITY_NODE_TRANSFORM;
        const next: NodeTransform = {
          x: (raw.x as number) ?? live.x,
          y: (raw.y as number) ?? live.y,
          z: (raw.z as number) ?? live.z,
          rotX: live.rotX,
          rotY: (raw.rotY as number) ?? live.rotY,
          rotZ: live.rotZ,
          scale: (raw.scale as number) ?? live.scale,
        };

        return success(store.setNodeTransform(part, next, 'agent'));
      } catch (err) {
        return failure('place_car_part failed: ' + errorMessage(err));
      }
    },
  };

  /* ---------------------------------------------------------------- */
  /* 20. detach_car_parts                                              */
  /* ---------------------------------------------------------------- */

  const detachCarParts: McpToolDescriptor<ToolInput> = {
    name: 'detach_car_parts',
    description:
      'Remove or refit individual meshes by id - take off just the wing mirrors, or hide every window while leaving the frames. Distinct from set_car_parts, which works on whole assemblies. Nothing is destroyed; a detached part is one call from returning.',
    annotations: { title: 'Detach individual parts', idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: {
          type: 'string',
          enum: ['remove', 'refit', 'reset'],
          description:
            'remove = hide the listed parts. refit = show them. reset = refit everything (ignores parts).',
        },
        parts: {
          type: 'array',
          items: { type: 'string' },
          description: 'Part ids from list_car_parts. Required for remove and refit.',
        },
      },
    },
    execute: (input) => {
      try {
        const raw = (input ?? {}) as { action?: string; parts?: unknown };
        const store = useWired.getState();
        const current = store.carRig.hiddenNodes;

        if (raw.action === 'reset') {
          return success(store.setNodeHidden([], 'agent'));
        }

        const requested = Array.isArray(raw.parts)
          ? raw.parts.filter((x): x is string => typeof x === 'string')
          : [];
        if (!requested.length) {
          return failure(
            "detach_car_parts needs a non-empty parts array for action '" +
              String(raw.action) +
              "'.",
          );
        }

        const known = new Set((getEngine()?.listCarNodes() ?? []).map((n) => n.id));
        const unknown = requested.filter((id) => !known.has(id));
        if (unknown.length) {
          return failure(
            'Unknown part id(s): ' +
              unknown.slice(0, 5).join(', ') +
              '. Call list_car_parts for valid ids.',
          );
        }

        if (raw.action === 'remove') {
          return success(
            store.setNodeHidden([...current, ...requested], 'agent'),
          );
        }
        if (raw.action === 'refit') {
          const drop = new Set(requested);
          return success(
            store.setNodeHidden(current.filter((id) => !drop.has(id)), 'agent'),
          );
        }

        return failure(
          "detach_car_parts action must be 'remove', 'refit' or 'reset'.",
        );
      } catch (err) {
        return failure('detach_car_parts failed: ' + errorMessage(err));
      }
    },
  };

  return [
    getState,
    modifyEnvironment,
    pulse,
    setCamera,
    configureNodes,
    applyPreset,
    captureSnapshot,
    resetScene,
    placeObject,
    setEditModeTool,
    setCarBody,
    photoObject,
    configureCarRig,
    setCarParts,
    inspectCarPart,
    modifyCarPart,
    listCarParts,
    selectCarPart,
    placeCarPart,
    detachCarParts,
  ];
}

/** Names of every tool buildTools() produces, in registration order. */
export const TOOL_NAMES: string[] = buildTools(() => null).map((tool) => tool.name);
