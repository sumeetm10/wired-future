/**
 * Wired Future — plain-English to tool call.
 *
 * This is NOT a language model. It is a deterministic rule table that maps
 * phrases onto the same tool calls a real agent would make, so the page is
 * playable in a browser with no WebMCP runtime and no API key.
 *
 * The distinction matters for the demo: with ChatGPT driving, the model reads
 * the tool descriptions and picks the call itself. Here we do that job with
 * regexes, then hand the result to the identical execute() path. The UI shows
 * the translated call so you can see exactly what a real agent would have sent.
 */

import { CAR_PART_IDS, SCENE_PRESET_NAMES } from '@/store/use-wired';
import type { CarPartId, ScenePresetName } from '@/store/use-wired';

export interface Intent {
  /**
   * One or more raw call strings, run in order. A phrase like "wider wheels"
   * names four assemblies, and modify_car_part addresses one at a time, so a
   * single phrase legitimately becomes four tool calls.
   */
  calls: string[];
  /** Tool of the first call, for labelling. */
  tool: string;
}

/* ------------------------------------------------------------------ */
/* Vocabulary                                                          */
/* ------------------------------------------------------------------ */

const COLORS: Record<string, string> = {
  red: '#ff2b2b',
  crimson: '#d81b3c',
  orange: '#ff8a1f',
  amber: '#ffb347',
  yellow: '#ffe14d',
  gold: '#ffc93c',
  green: '#37f5a0',
  lime: '#9dff4d',
  teal: '#1effc8',
  cyan: '#00f0ff',
  blue: '#2b4bff',
  navy: '#16266b',
  purple: '#8b5cff',
  violet: '#8b5cff',
  magenta: '#ff2bd6',
  pink: '#ff6ec7',
  white: '#ffffff',
  silver: '#c6ccd4',
  grey: '#8f9299',
  gray: '#8f9299',
  black: '#12131a',
};

const MATERIALS: Record<string, string> = {
  steel: 'steel',
  aluminium: 'aluminium',
  aluminum: 'aluminium',
  alloy: 'aluminium',
  titanium: 'titanium',
  carbon: 'carbon',
  'carbon fibre': 'carbon',
  'carbon fiber': 'carbon',
  plastic: 'abs',
  abs: 'abs',
  glass: 'glass',
  rubber: 'rubber',
};

/** Phrases that name an assembly. Longest match wins, so order matters. */
const PART_PHRASES: Array<[RegExp, CarPartId | 'allWheels' | 'allDoors']> = [
  [/\ball (?:four )?(?:the )?wheels?\b|\bwheels\b|\btyres?\b|\btires?\b/, 'allWheels'],
  [/\bfront left wheel\b|\bwheelfl\b/, 'wheelFL'],
  [/\bfront right wheel\b|\bwheelfr\b/, 'wheelFR'],
  [/\brear left wheel\b|\bwheelrl\b/, 'wheelRL'],
  [/\brear right wheel\b|\bwheelrr\b/, 'wheelRR'],
  [/\bleft door\b/, 'doorLeft'],
  [/\bright door\b/, 'doorRight'],
  [/\bdoors?\b/, 'allDoors'],
  [/\bhood\b|\bbonnet\b/, 'hood'],
  [/\broof\b/, 'roof'],
  [/\bglass\b|\bwindows?\b|\bwindscreen\b|\bwindshield\b/, 'glass'],
  [/\binterior\b|\bseats?\b|\bcabin\b|\bdashboard\b/, 'interior'],
  [/\bengine\b|\baxles?\b|\bmotor\b/, 'engine'],
  [/\blights?\b|\bheadlights?\b|\btaillights?\b/, 'lights'],
  [/\bbody\b|\bshell\b|\bchassis\b|\bpanels?\b/, 'body'],
];

const WHEELS: CarPartId[] = ['wheelFL', 'wheelFR', 'wheelRL', 'wheelRR'];

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function findColor(text: string): string | null {
  const hex = text.match(/#([0-9a-f]{3}|[0-9a-f]{6})\b/i);
  if (hex) return '#' + hex[1].toLowerCase();
  for (const [name, value] of Object.entries(COLORS)) {
    if (new RegExp('\\b' + name + '\\b').test(text)) return value;
  }
  return null;
}

function findMaterial(text: string): string | null {
  // Longest key first so "carbon fibre" beats "carbon".
  const keys = Object.keys(MATERIALS).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    if (new RegExp('\\b' + key + '\\b').test(text)) return MATERIALS[key];
  }
  return null;
}

function findPart(text: string): CarPartId | 'allWheels' | 'allDoors' | null {
  for (const [pattern, id] of PART_PHRASES) {
    if (pattern.test(text)) return id;
  }
  return null;
}

function findNumber(text: string): number | null {
  const match = text.match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function callString(tool: string, input: Record<string, unknown>): string {
  return Object.keys(input).length > 0
    ? tool + ' ' + JSON.stringify(input)
    : tool;
}

function build(tool: string, input: Record<string, unknown>): Intent {
  return { tool, calls: [callString(tool, input)] };
}

/** One call per input — used when a phrase names several assemblies. */
function buildMany(
  tool: string,
  inputs: Array<Record<string, unknown>>,
): Intent {
  return { tool, calls: inputs.map((input) => callString(tool, input)) };
}

/** Expand a part phrase into concrete assembly ids. */
function expandParts(part: CarPartId | 'allWheels' | 'allDoors'): CarPartId[] {
  if (part === 'allWheels') return [...WHEELS];
  if (part === 'allDoors') return ['doorLeft', 'doorRight'];
  return [part];
}

/* ------------------------------------------------------------------ */
/* The rule table                                                      */
/* ------------------------------------------------------------------ */

export function parseIntent(raw: string): Intent | null {
  const text = raw.toLowerCase().trim();
  if (!text) return null;

  const negated = /\b(close|shut|put back|refit|reattach|reassemble|rejoin|reset|undo)\b/.test(text);

  /* --- scene state ------------------------------------------------- */

  if (/\b(what|describe|tell me|read).*(scene|state|screen|look|going on)\b/.test(text)) {
    return build('get_wired_future_state', {});
  }

  if (/\b(snapshot|screenshot|photo of the|picture of the|capture|show me what)\b/.test(text)) {
    return build('capture_scene_snapshot', { maxWidth: 640 });
  }

  if (/\b(reset|start over|from scratch|default)\b/.test(text) && !/\bpart\b/.test(text)) {
    return build('reset_wired_future', {});
  }

  /* --- measurement -------------------------------------------------- */

  if (/\b(how heavy|how much does|weigh|mass|measure|inspect|how big|dimensions|how many triangles)\b/.test(text)) {
    const part = findPart(text);
    const ids = part ? expandParts(part) : ['body' as CarPartId];
    const thickness = /\bmm\b/.test(text) ? findNumber(text) : null;
    return build('inspect_car_part', {
      part: ids[0],
      ...(thickness ? { wallThicknessMm: thickness } : {}),
    });
  }

  /* --- part material / reshaping ------------------------------------ */

  const material = findMaterial(text);
  const partForEdit = findPart(text);

  if (material && partForEdit && /\b(make|turn|swap|change|upgrade|respec|re-spec|build)\b/.test(text)) {
    return buildMany(
      'modify_car_part',
      expandParts(partForEdit).map((part) => ({ part, material })),
    );
  }

  if (partForEdit && /\b(wider|fatter|thicker|bigger|larger|wide)\b/.test(text)) {
    const bulk = /\b(bigger|larger)\b/.test(text) ? 1.2 : 1;
    return buildMany(
      'modify_car_part',
      expandParts(partForEdit).map((part) => ({
        part,
        scaleX: 1.35,
        scaleY: bulk,
        scaleZ: bulk,
      })),
    );
  }

  if (partForEdit && /\b(smaller|thinner|narrower|slimmer)\b/.test(text)) {
    return buildMany(
      'modify_car_part',
      expandParts(partForEdit).map((part) => ({
        part,
        scaleX: 0.75,
        scaleY: 0.85,
        scaleZ: 0.85,
      })),
    );
  }

  if (partForEdit && /\btwist\b/.test(text)) {
    const deg = findNumber(text) ?? 35;
    return buildMany(
      'modify_car_part',
      expandParts(partForEdit).map((part) => ({ part, twistDeg: deg })),
    );
  }

  /* --- detach / refit ------------------------------------------------ */

  // "take the wheels off" and "pull the doors off" put words between the verb
  // and the particle, so a contiguous "take off" alternation never matched.
  const removes =
    /\b(remove|detach|hide|strip|unbolt|get rid of)\b/.test(text) ||
    /\b(take|pull|rip|knock|strip)\b[\s\S]*\boff\b/.test(text) ||
    /\bdrop\b[\s\S]*\b(off|out)\b/.test(text);

  if (removes && partForEdit) {
    return build('set_car_parts', { action: 'remove', parts: expandParts(partForEdit) });
  }

  const refits =
    /\b(refit|reattach|restore|bolt back)\b/.test(text) ||
    /\bput\b[\s\S]*\bback\b/.test(text) ||
    /\bbring\b[\s\S]*\bback\b/.test(text);

  if (refits && partForEdit) {
    return build('set_car_parts', { action: 'refit', parts: expandParts(partForEdit) });
  }

  if (/\b(only|just)\b/.test(text) && partForEdit) {
    return build('set_car_parts', { action: 'only', parts: expandParts(partForEdit) });
  }

  if (/\b(all parts|everything back|refit everything)\b/.test(text)) {
    return build('set_car_parts', { action: 'reset' });
  }

  /* --- rig: explode, doors, hood, finish ----------------------------- */

  if (/\b(explode|take (?:it|the car) apart|apart|teardown|parts diagram|disassemble|separate)\b/.test(text)) {
    return build('configure_car_rig', { explode: negated ? 0 : 1 });
  }

  if (/\b(put (?:it|them) back together|reassemble|rejoin|join|assemble)\b/.test(text)) {
    return build('configure_car_rig', { explode: 0, doorLeft: 0, doorRight: 0, hood: 0 });
  }

  if (/\bhood\b|\bbonnet\b/.test(text) && /\b(open|lift|raise|close|shut|down)\b/.test(text)) {
    return build('configure_car_rig', { hood: negated ? 0 : 1 });
  }

  if (/\bdoors?\b/.test(text) && /\b(open|close|shut|swing)\b/.test(text)) {
    const value = negated ? 0 : 1;
    if (/\bleft\b/.test(text)) return build('configure_car_rig', { doorLeft: value });
    if (/\bright\b/.test(text)) return build('configure_car_rig', { doorRight: value });
    return build('configure_car_rig', { doorLeft: value, doorRight: value });
  }

  if (/\b(3d print|3-d print|print view|unpainted|resin|prototype|bare|grey model|gray model)\b/.test(text)) {
    return build('configure_car_rig', { finish: 'print' });
  }

  if (/\b(paint|painted|colour it back|color it back|real finish|normal finish)\b/.test(text) && /\bcar\b|\bfinish\b|\bback\b/.test(text)) {
    return build('configure_car_rig', { finish: 'paint' });
  }

  /* --- model + car body ---------------------------------------------- */

  if (/\b(real car|concept car|gltf|proper car|actual car)\b/.test(text)) {
    return build('set_car_body', { variant: 'real' });
  }

  if (/\b(parametric|wireframe car|simple car|built-in car)\b/.test(text)) {
    return build('set_car_body', { variant: 'parametric' });
  }

  if (/\b(engine (?:block|node)|quantum engine|torus)\b/.test(text)) {
    return build('modify_wired_future_environment', { modelType: 'engine' });
  }

  if (/\bphoto\b/.test(text) && /\b(show|display|reconstruct|model)\b/.test(text)) {
    return build('reconstruct_photo_object', { action: 'show' });
  }

  if (/\bphoto\b/.test(text) && /\b(status|ready|check)\b/.test(text)) {
    return build('reconstruct_photo_object', { action: 'status' });
  }

  /* --- presets -------------------------------------------------------- */

  for (const preset of SCENE_PRESET_NAMES) {
    const words = preset.replace('-', ' ');
    if (new RegExp('\\b' + words + '\\b').test(text)) {
      return build('apply_scene_preset', { preset: preset as ScenePresetName });
    }
  }

  /* --- camera --------------------------------------------------------- */

  if (/\b(zoom in|closer|close up|move in)\b/.test(text)) {
    return build('set_camera_view', { preset: 'close', distance: 10 });
  }
  if (/\b(zoom out|pull back|further|wider shot|step back)\b/.test(text)) {
    return build('set_camera_view', { preset: 'wide', distance: 28 });
  }
  if (/\b(top view|from above|bird|overhead|top down)\b/.test(text)) {
    return build('set_camera_view', { preset: 'top' });
  }
  if (/\b(spin|orbit|rotate the camera|circle)\b/.test(text)) {
    return build('set_camera_view', { autoOrbit: !negated });
  }

  /* --- placement + edit mode ------------------------------------------ */

  if (/\b(move|drag|nudge|shift|slide)\b/.test(text) && /\b(tool|gizmo|let me|handle)\b/.test(text)) {
    return build('set_edit_mode', { mode: 'translate' });
  }
  if (/\brotate\b/.test(text) && /\b(tool|gizmo|let me|handle)\b/.test(text)) {
    return build('set_edit_mode', { mode: 'rotate' });
  }
  if (/\bscale\b/.test(text) && /\b(tool|gizmo|let me|handle)\b/.test(text)) {
    return build('set_edit_mode', { mode: 'scale' });
  }

  if (/\bturn\b|\brotate\b/.test(text) && /\bdegrees?\b/.test(text)) {
    return build('place_object', { rotationDeg: { y: findNumber(text) ?? 45 } });
  }

  if (/\b(move|push|shift)\b/.test(text) && /\b(left|right|back|forward|up|down)\b/.test(text)) {
    const amount = Math.abs(findNumber(text) ?? 3);
    if (/\bleft\b/.test(text)) return build('place_object', { position: { x: -amount } });
    if (/\bright\b/.test(text)) return build('place_object', { position: { x: amount } });
    if (/\bup\b/.test(text)) return build('place_object', { position: { y: amount } });
    if (/\bdown\b/.test(text)) return build('place_object', { position: { y: 0 } });
    if (/\bback\b/.test(text)) return build('place_object', { position: { z: -amount } });
    return build('place_object', { position: { z: amount } });
  }

  /* --- environment ----------------------------------------------------- */

  if (/\bpulse\b|\bshockwave\b|\bflash\b/.test(text)) {
    return build('pulse_reality_wave', { intensity: 3, durationMs: 1800 });
  }

  if (/\b(faster|speed up|quicker)\b/.test(text)) {
    return build('modify_wired_future_environment', { waveVelocity: 3 });
  }
  if (/\b(slower|slow down|freeze|calm)\b/.test(text)) {
    return build('modify_wired_future_environment', { waveVelocity: /\bfreeze\b/.test(text) ? 0 : 0.4 });
  }

  const color = findColor(text);
  if (color) {
    // A colour with a part named goes to that part's material; otherwise it is
    // the grid. "make the hood red" is a part edit, "make it red" is the grid.
    if (partForEdit && /\bmake|paint|colour|color\b/.test(text)) {
      return build('modify_wired_future_environment', { gridColorHex: color });
    }
    return build('modify_wired_future_environment', { gridColorHex: color });
  }

  return null;
}

/** Shown when nothing matched, so the box teaches its own vocabulary. */
export const INTENT_EXAMPLES: string[] = [
  'open both doors',
  'show me the 3D print view',
  'take it apart',
  'put it back together',
  'take the wheels off',
  'make the hood carbon fibre',
  'how heavy is the hood',
  'wider wheels',
  'lift the bonnet',
  'zoom in',
  'go solar flare',
  'make the grid magenta',
  'what is on screen',
];

/** Assemblies the parser knows how to name, for the help text. */
export const KNOWN_PARTS = CAR_PART_IDS;
