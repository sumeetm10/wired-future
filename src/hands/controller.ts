/**
 * Wired Future — hand gestures to scene state.
 *
 * The third interface onto the same reducer. Mouse handlers, WebMCP
 * `execute()` callbacks and this file all end at
 * `useWired.getState().apply / setTransform`, so a hand drag redraws the
 * sliders and an agent reading the scene sees where the hands left it.
 *
 * Two gestures, chosen because they survive a noisy webcam:
 *
 *   pinch one hand and move   -> drag the car across the stage
 *   pinch both and pull apart -> explode the car into its assemblies
 *
 * Both are RELATIVE to where the gesture started. An absolute mapping snaps
 * the car to wherever your hand happened to be when you pinched.
 */

import { LIMITS, useWired } from '@/store/use-wired';
import type { HandFrame } from './tracker';

/** Engage above this pinch strength, release below. The gap is deliberate: a
 *  single threshold chatters open/closed on the frames either side of it. */
const PINCH_ON = 0.7;
const PINCH_OFF = 0.4;

/** Frame units to world units. A full sweep of the frame is ~16 wide. */
const MOVE_GAIN_X = 16;
const MOVE_GAIN_Y = 12;

/** Pulling hands from touching to a wide span covers the whole explode range. */
const EXPLODE_GAIN = 2.4;

/** Landmarks jitter a few percent frame to frame; this is a low-pass filter. */
const SMOOTHING = 0.45;

/** Don't write a value the scene cannot show. */
const MOVE_EPSILON = 0.01;
const EXPLODE_EPSILON = 0.004;

export type HandMode = 'idle' | 'move' | 'explode';

export interface HandStatus {
  mode: HandMode;
  hands: number;
  /** Pinch strength per detected hand, for the meter in the panel. */
  pinches: number[];
}

const clamp = (v: number, min: number, max: number) =>
  v < min ? min : v > max ? max : v;

interface MoveAnchor {
  handX: number;
  handY: number;
  carX: number;
  carY: number;
}

interface ExplodeAnchor {
  span: number;
  explode: number;
}

export interface HandController {
  onFrame: (frame: HandFrame) => HandStatus;
  /** Commit any gesture in flight. Call when the camera stops. */
  release: () => void;
}

export function createHandController(): HandController {
  let mode: HandMode = 'idle';
  let engaged = false;
  let move: MoveAnchor | null = null;
  let explode: ExplodeAnchor | null = null;

  // Smoothed gesture inputs. Null means "no history yet", so the first frame
  // of a gesture adopts the raw value instead of easing in from zero.
  let sx: number | null = null;
  let sy: number | null = null;
  let sSpan: number | null = null;

  const smooth = (prev: number | null, next: number): number =>
    prev === null ? next : prev + (next - prev) * SMOOTHING;

  const endGesture = () => {
    // Re-write the final value non-silently so the trace carries one line per
    // gesture rather than one per frame.
    if (mode === 'move' && move) {
      const t = useWired.getState().transform;
      useWired.getState().setTransform({ position: t.position }, 'hand', false);
    } else if (mode === 'explode' && explode) {
      const rig = useWired.getState().carRig;
      useWired
        .getState()
        .apply({ carRig: { ...rig, explode: rig.explode } }, 'hand', false);
    }
    mode = 'idle';
    move = null;
    explode = null;
    sx = null;
    sy = null;
    sSpan = null;
  };

  const onFrame = (frame: HandFrame): HandStatus => {
    const hands = frame.hands;
    const pinches = hands.map((h) => h.pinch);

    // Hysteresis on the strongest pinch decides whether a gesture is running
    // at all; which gesture then depends on how many hands are pinching.
    const strongest = pinches.length ? Math.max(...pinches) : 0;
    engaged = engaged ? strongest > PINCH_OFF : strongest > PINCH_ON;

    const pinching = hands.filter((h) =>
      engaged ? h.pinch > PINCH_OFF : h.pinch > PINCH_ON,
    );

    if (!engaged || pinching.length === 0) {
      if (mode !== 'idle') endGesture();
      return { mode: 'idle', hands: hands.length, pinches };
    }

    /* --- both hands: explode --------------------------------------------- */

    if (pinching.length >= 2) {
      const [a, b] = pinching;
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      const raw = Math.sqrt(dx * dx + dy * dy);
      sSpan = smooth(mode === 'explode' ? sSpan : null, raw);

      if (mode !== 'explode') {
        if (mode === 'move') endGesture();
        mode = 'explode';
        explode = { span: sSpan, explode: useWired.getState().carRig.explode };
        return { mode, hands: hands.length, pinches };
      }

      if (explode) {
        const next = clamp(
          explode.explode + (sSpan - explode.span) * EXPLODE_GAIN,
          0,
          1,
        );
        const current = useWired.getState().carRig.explode;
        if (Math.abs(next - current) > EXPLODE_EPSILON) {
          const rig = useWired.getState().carRig;
          useWired
            .getState()
            .apply({ carRig: { ...rig, explode: next } }, 'hand', true);
        }
      }
      return { mode, hands: hands.length, pinches };
    }

    /* --- one hand: move --------------------------------------------------- */

    const hand = pinching[0];
    sx = smooth(mode === 'move' ? sx : null, hand.x);
    sy = smooth(mode === 'move' ? sy : null, hand.y);

    if (mode !== 'move') {
      if (mode === 'explode') endGesture();
      mode = 'move';
      const pos = useWired.getState().transform.position;
      move = { handX: sx, handY: sy, carX: pos.x, carY: pos.y };
      return { mode, hands: hands.length, pinches };
    }

    if (move) {
      const x = clamp(
        move.carX + (sx - move.handX) * MOVE_GAIN_X,
        LIMITS.positionX.min,
        LIMITS.positionX.max,
      );
      // Screen y grows downward; the stage's does not.
      const y = clamp(
        move.carY - (sy - move.handY) * MOVE_GAIN_Y,
        LIMITS.positionY.min,
        LIMITS.positionY.max,
      );
      const pos = useWired.getState().transform.position;
      if (
        Math.abs(x - pos.x) > MOVE_EPSILON ||
        Math.abs(y - pos.y) > MOVE_EPSILON
      ) {
        useWired
          .getState()
          .setTransform({ position: { x, y, z: pos.z } }, 'hand', true);
      }
    }

    return { mode, hands: hands.length, pinches };
  };

  return {
    onFrame,
    release: () => {
      if (mode !== 'idle') endGesture();
      engaged = false;
    },
  };
}
