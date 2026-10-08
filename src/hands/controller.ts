/**
 * Wired Future — webcam hands as pointers.
 *
 * Each hand drives a cursor on the screen from the point between its thumb
 * and index tips, and pinching those two fingers is the click:
 *
 *   point at a part        -> it glows, and the cursor names it
 *   pinch a door or hood   -> hold it: it swings on its hinge with the hand
 *   pinch any other part   -> hold it: carry it, release to let go
 *   quick pinch on a part  -> what a Ctrl-click does: open, pop off, put back
 *   pinch empty space      -> turn the view around the car
 *   both hands, empty space-> like a touchscreen: spread to explode, move
 *                             together to carry the car, twist to turn it
 *
 * It is the third interface onto the same reducer: holds and taps end in the
 * same store calls a mouse or an agent makes, tagged [HAND] in the trace, so
 * the door slider swings while a hand swings the door.
 *
 * Webcam hands are noisy, so three things carry the feel:
 *  - a One Euro filter on each cursor: steady at rest, no lag in a sweep;
 *  - an AIM LOCK: closing fingers drag the pinch point a little, so the
 *    target is chosen as the fingers START to close, not when they meet;
 *  - a grace period: tracking drops single frames, and a door must not be
 *    let go of because the camera blinked.
 */

import type { HandGrip, HandGripState, HandTarget, WiredEngine } from '@/scene/contract';
import { actuatePart, hingeKeyFor, rigPatch } from '@/store/part-actions';
import { useWired } from '@/store/use-wired';
import type { CursorMode, HandCursorLayer } from './cursor-layer';
import { mapToViewport, matchHands, type ReachBox } from './hand-slots';
import { OneEuroFilter } from './one-euro';
import type { HandFrame } from './tracker';

/** Engage above, release below. The gap stops a pinch chattering open/shut. */
const PINCH_ON = 0.7;
const PINCH_OFF = 0.4;
/** Fingers this far closed lock the aim, before the pinch lands. */
const AIM_LOCK = 0.35;
const AIM_RELEASE = 0.22;
/** Fingers this far closed start counting near misses as hits. */
const FORGIVING_PINCH = 0.15;
/** A locked aim follows the hand again once the cursor strays this far. */
const AIM_RADIUS_PX = 40;
/** Cursor travel that turns a pinch from a tap into a hold, in px. */
const DRAG_SLOP_PX = 22;
/** A pinch released within this, without travelling, is a tap. */
const TAP_MS = 600;
/** A hand missing for less than this keeps what it holds. */
const LOST_GRACE_MS = 320;
/** Still the same hand if it moved less than this between frames (frame units). */
const MAX_JUMP = 0.3;
/** The middle of the camera frame spans the whole screen; edges are unreliable. */
const REACH: ReachBox = { left: 0.15, right: 0.85, top: 0.1, bottom: 0.8 };
/** Pulling the hands apart by this share of the screen width explodes the car fully. */
const EXPLODE_SPAN = 0.45;
const HINGE_EPSILON = 0.003;
const EXPLODE_EPSILON = 0.004;
const MOVE_EPSILON = 0.004;
/** One Euro settings, in viewport pixels at camera rate. */
const FILTER = { minCutoff: 2.0, beta: 0.02, dCutoff: 1.0 };

export type HandMode = 'idle' | 'point' | 'hold' | 'orbit' | 'two';

export interface HandStatus {
  mode: HandMode;
  hands: number;
  /** The strongest pinch, 0..1, for the meter. */
  pinch: number;
  /** What the hands are doing, in words. */
  label: string;
}

export interface HandController {
  onFrame: (frame: HandFrame, now?: number) => HandStatus;
  /** Let go of everything, committing what was held. Call when the camera stops. */
  release: () => void;
}

export interface HandControllerOptions {
  getEngine: () => WiredEngine | null;
  cursors?: HandCursorLayer | null;
}

type Role = 'none' | 'part' | 'restore' | 'space';

interface Slot {
  index: number;
  /** Has a hand, possibly one missing for a few frames. */
  live: boolean;
  /** Seen in the current frame. */
  seen: boolean;
  lastSeen: number;
  /** Raw mirrored camera position, for telling the hands apart. */
  nx: number;
  ny: number;
  fx: OneEuroFilter;
  fy: OneEuroFilter;
  /** Filtered viewport position. */
  x: number;
  y: number;
  pinch: number;
  engaged: boolean;
  hover: HandTarget | null;
  lock: { target: HandTarget | null; x: number; y: number } | null;
  role: Role;
  target: HandTarget | null;
  grip: HandGrip | null;
  startX: number;
  startY: number;
  startAt: number;
  moved: boolean;
}

type Space =
  | { kind: 'orbit'; slot: Slot; lastX: number; lastY: number; moved: boolean }
  | {
      kind: 'two';
      a: Slot;
      b: Slot;
      span0: number;
      angle0: number;
      cx0: number;
      cy0: number;
      explode0: number;
      yaw0: number;
      grip: HandGrip | null;
      /** Each part of the gesture wakes up only past its own dead zone. */
      exploding: boolean;
      carrying: boolean;
      twisting: boolean;
      explodeChanged: boolean;
      placed: boolean;
    };

/** Dead zones for the two-hand gesture, so a spread does not also nudge the car. */
const TWO_SPREAD_PX = 24;
const TWO_CARRY_PX = 28;
const TWO_TWIST_RAD = (10 * Math.PI) / 180;

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

function makeSlot(index: number): Slot {
  return {
    index,
    live: false,
    seen: false,
    lastSeen: 0,
    nx: 0,
    ny: 0,
    fx: new OneEuroFilter(FILTER),
    fy: new OneEuroFilter(FILTER),
    x: 0,
    y: 0,
    pinch: 0,
    engaged: false,
    hover: null,
    lock: null,
    role: 'none',
    target: null,
    grip: null,
    startX: 0,
    startY: 0,
    startAt: 0,
    moved: false,
  };
}

export function createHandController({
  getEngine,
  cursors = null,
}: HandControllerOptions): HandController {
  const slots: Slot[] = [makeSlot(0), makeSlot(1)];
  let space: Space | null = null;

  const store = () => useWired.getState();

  /* --- commits --------------------------------------------------------- */

  /**
   * Write where a held thing is. Silent writes run every frame while a hinge
   * or the car is carried, so the sliders follow the hand; the final write is
   * not silent and leaves one [HAND] line in the trace. Node grips move the
   * scene directly and only ever commit once.
   */
  const commit = (state: HandGripState, silent: boolean): void => {
    if (state.kind === 'hinge') {
      const key = hingeKeyFor(state.assembly);
      if (!key) return;
      if (silent && Math.abs(store().carRig[key] - state.value) < HINGE_EPSILON) return;
      store().apply(rigPatch({ [key]: state.value }), 'hand', silent);
      return;
    }
    if (state.kind === 'node') {
      if (!silent) store().setNodeTransform(state.node, state.transform, 'hand');
      return;
    }
    const p = store().transform.position;
    const q = state.position;
    if (silent && Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z) < MOVE_EPSILON) return;
    store().setTransform({ position: { ...q } }, 'hand', silent);
  };

  /* --- one hand's part gesture -------------------------------------------- */

  /** End what this hand holds. `allowTap` is false when the hand vanished. */
  const endPart = (slot: Slot, now: number, allowTap: boolean): void => {
    const { role, grip, target } = slot;
    if (role === 'part' && grip && target) {
      const tap = allowTap && !slot.moved && now - slot.startAt <= TAP_MS;
      if (tap) {
        grip.cancel();
        actuatePart(
          { node: target.node, assembly: target.assembly, hinged: target.hinged, restore: false },
          'hand',
        );
      } else if (slot.moved) {
        commit(grip.state(), false);
      }
    } else if (role === 'restore' && target && allowTap && !slot.moved) {
      actuatePart(
        { node: target.node, assembly: target.assembly, hinged: target.hinged, restore: true },
        'hand',
      );
    }
    slot.role = 'none';
    slot.grip = null;
    slot.target = null;
    slot.moved = false;
  };

  const engage = (slot: Slot, now: number, engine: WiredEngine | null): void => {
    const lock = slot.lock;
    slot.lock = null;
    const target = lock ? lock.target : slot.hover;
    // Measure from where the aim locked: the fingers closing drag the
    // cursor a little, and that must not count as a drag or move the grip.
    slot.startX = lock ? lock.x : slot.x;
    slot.startY = lock ? lock.y : slot.y;
    slot.startAt = now;
    slot.moved = false;

    if (target?.hidden) {
      slot.role = 'restore';
      slot.target = target;
      return;
    }
    if (target && engine) {
      const grip = engine.grabForHand(target, slot.startX, slot.startY);
      if (grip) {
        slot.role = 'part';
        slot.target = target;
        slot.grip = grip;
        return;
      }
    }
    slot.role = 'space';
  };

  const continuePart = (slot: Slot): void => {
    if (!slot.moved && Math.hypot(slot.x - slot.startX, slot.y - slot.startY) > DRAG_SLOP_PX) {
      slot.moved = true;
    }
    if (slot.role !== 'part' || !slot.grip || !slot.moved) return;
    const state = slot.grip.move(slot.x, slot.y);
    if (state && state.kind === 'hinge') commit(state, true);
  };

  const resetSlot = (slot: Slot): void => {
    slot.live = false;
    slot.seen = false;
    slot.fx.reset();
    slot.fy.reset();
    slot.pinch = 0;
    slot.engaged = false;
    slot.hover = null;
    slot.lock = null;
    slot.role = 'none';
    slot.grip = null;
    slot.target = null;
    slot.moved = false;
  };

  /** The hand left, or a different hand took its place. */
  const endSlot = (slot: Slot, now: number): void => {
    endPart(slot, now, false);
    resetSlot(slot);
  };

  /* --- gestures in empty space --------------------------------------------- */

  const endSpace = (): void => {
    const s = space;
    space = null;
    if (!s || s.kind === 'orbit') return;
    if (s.placed) {
      const t = store().transform;
      store().setTransform({ position: { ...t.position }, rotationDeg: { ...t.rotationDeg } }, 'hand', false);
    }
    if (s.explodeChanged) {
      store().apply(rigPatch({ explode: store().carRig.explode }), 'hand', false);
    }
  };

  const updateSpace = (engine: WiredEngine | null, width: number): void => {
    const spacers = slots.filter((s) => s.live && s.engaged && s.role === 'space');
    const holding = slots.some(
      (s) => s.live && s.engaged && (s.role === 'part' || s.role === 'restore'),
    );

    /* Two hands: a touchscreen made of air. */
    if (spacers.length >= 2) {
      const [a, b] = spacers;
      const span = Math.hypot(a.x - b.x, a.y - b.y);
      const angle = Math.atan2(b.y - a.y, b.x - a.x);
      const cx = (a.x + b.x) / 2;
      const cy = (a.y + b.y) / 2;
      if (!space || space.kind !== 'two') {
        endSpace();
        const t = store().transform;
        space = {
          kind: 'two',
          a,
          b,
          span0: span,
          angle0: angle,
          cx0: cx,
          cy0: cy,
          explode0: store().carRig.explode,
          yaw0: t.rotationDeg.y,
          grip: engine ? engine.grabForHand(null, cx, cy) : null,
          exploding: false,
          carrying: false,
          twisting: false,
          explodeChanged: false,
          placed: false,
        };
        return;
      }
      const two = space;

      // Spread: explode.
      if (!two.exploding && Math.abs(span - two.span0) > TWO_SPREAD_PX) two.exploding = true;
      if (two.exploding) {
        const next = clamp01(two.explode0 + (span - two.span0) / (EXPLODE_SPAN * width));
        if (Math.abs(next - store().carRig.explode) > EXPLODE_EPSILON) {
          two.explodeChanged = true;
          store().apply(rigPatch({ explode: next }), 'hand', true);
        }
      }

      // Move together: carry the car. Twist: turn it.
      if (!two.carrying && Math.hypot(cx - two.cx0, cy - two.cy0) > TWO_CARRY_PX) two.carrying = true;
      let dAngle = angle - two.angle0;
      while (dAngle > Math.PI) dAngle -= Math.PI * 2;
      while (dAngle < -Math.PI) dAngle += Math.PI * 2;
      if (!two.twisting && Math.abs(dAngle) > TWO_TWIST_RAD) two.twisting = true;

      if (two.carrying || two.twisting) {
        const t = store().transform;
        const moved = two.carrying && two.grip ? two.grip.move(cx, cy) : null;
        const position = moved && moved.kind === 'model' ? moved.position : t.position;
        const yaw = two.twisting ? two.yaw0 - (dAngle * 180) / Math.PI : t.rotationDeg.y;
        const changed =
          Math.hypot(position.x - t.position.x, position.y - t.position.y, position.z - t.position.z) >
            MOVE_EPSILON || Math.abs(yaw - t.rotationDeg.y) > 0.2;
        if (changed) {
          two.placed = true;
          store().setTransform(
            { position: { ...position }, rotationDeg: { ...t.rotationDeg, y: yaw } },
            'hand',
            true,
          );
        }
      }
      return;
    }

    /* One hand in empty space: turn the view. */
    if (spacers.length === 1 && !holding && engine) {
      const s = spacers[0];
      if (!space || space.kind !== 'orbit' || space.slot !== s) {
        endSpace();
        // Start from where the hand is NOW: a hand left over from a two-hand
        // gesture must not swing the view by however far it travelled.
        s.startX = s.x;
        s.startY = s.y;
        s.moved = false;
        space = { kind: 'orbit', slot: s, lastX: s.x, lastY: s.y, moved: false };
        return;
      }
      if (!s.moved && Math.hypot(s.x - s.startX, s.y - s.startY) > DRAG_SLOP_PX) {
        s.moved = true;
        space.lastX = s.x;
        space.lastY = s.y;
      }
      if (!s.moved) return;
      engine.orbitByHand(s.x - space.lastX, s.y - space.lastY);
      space.lastX = s.x;
      space.lastY = s.y;
      space.moved = true;
      return;
    }

    if (space) endSpace();
  };

  /* --- feedback ------------------------------------------------------------- */

  const render = (engine: WiredEngine | null): void => {
    for (const slot of slots) {
      if (!slot.live) {
        cursors?.set(slot.index, null);
        engine?.setHandHover(slot.index, null, 0, false);
        continue;
      }

      let target: HandTarget | null = null;
      let strength = 0;
      let mode: CursorMode;
      let name = '';
      let hint = '';

      if (slot.engaged) {
        mode = 'hold';
        if (slot.role === 'part' && slot.target) {
          target = slot.target;
          name = target.label;
          hint = slot.moved
            ? target.hinged
              ? 'swinging - open your fingers to let go'
              : 'carrying - open your fingers to let go'
            : target.hinged
              ? 'move to swing it, or let go to toggle'
              : 'move to carry it, or let go to pop it off';
        } else if (slot.role === 'restore' && slot.target) {
          name = slot.target.label;
          hint = 'let go to put it back';
        } else if (space?.kind === 'two' && space.a === slot) {
          // One label for a two-handed gesture; the other ring says enough.
          name = 'Both hands';
          hint = 'spread to explode - move to carry - twist to turn';
        } else if (space?.kind === 'orbit' && space.slot === slot) {
          name = 'View';
          hint = 'move to turn around the car';
        }
      } else {
        target = slot.lock ? slot.lock.target : slot.hover;
        strength = slot.pinch >= AIM_LOCK ? clamp01((slot.pinch - AIM_LOCK) / (PINCH_ON - AIM_LOCK)) : 0;
        mode = slot.lock ? 'aim' : 'point';
        if (target) {
          name = target.label;
          hint = target.hidden
            ? 'pinch to put it back'
            : target.hinged
              ? 'pinch and move to swing it'
              : 'pinch to hold it';
        }
      }
      if (!slot.seen) mode = 'lost';

      engine?.setHandHover(slot.index, target, strength, slot.engaged && slot.role === 'part');
      cursors?.set(slot.index, {
        x: slot.x,
        y: slot.y,
        mode,
        progress: slot.engaged ? 1 : strength,
        name,
        hint,
      });
    }
  };

  const status = (): HandStatus => {
    const live = slots.filter((s) => s.live);
    const hands = live.length;
    const pinch = live.reduce((m, s) => Math.max(m, s.pinch), 0);

    if (space?.kind === 'two') {
      return { mode: 'two', hands, pinch, label: 'both hands on the car' };
    }
    const holder = live.find((s) => s.engaged && s.role === 'part' && s.target);
    if (holder?.target) {
      return { mode: 'hold', hands, pinch, label: 'holding ' + holder.target.label };
    }
    const restorer = live.find((s) => s.engaged && s.role === 'restore' && s.target);
    if (restorer?.target) {
      return { mode: 'hold', hands, pinch, label: 'putting back ' + restorer.target.label };
    }
    if (space?.kind === 'orbit') return { mode: 'orbit', hands, pinch, label: 'turning the view' };
    for (const s of live) {
      const t = s.lock ? s.lock.target : s.hover;
      if (t) return { mode: 'point', hands, pinch, label: 'pointing at ' + t.label };
    }
    return {
      mode: 'idle',
      hands,
      pinch,
      label: hands ? 'point at a part, then pinch' : 'show a hand to the camera',
    };
  };

  /* --- per frame ---------------------------------------------------------- */

  const onFrame = (frame: HandFrame, now = performance.now()): HandStatus => {
    const engine = getEngine();
    const width = typeof window !== 'undefined' ? window.innerWidth : 1280;
    const height = typeof window !== 'undefined' ? window.innerHeight : 800;

    // 1. Which detection is which hand.
    const matches = matchHands(
      slots.map((s) => (s.live ? { x: s.nx, y: s.ny } : null)),
      frame.hands.map((h) => ({ x: h.x, y: h.y })),
      MAX_JUMP,
    );
    for (const slot of slots) slot.seen = false;
    matches.forEach((match, i) => {
      const slot = slots[match.slot];
      if (!slot) return;
      if (match.fresh && slot.live) endSlot(slot, now);
      const hand = frame.hands[i];
      slot.live = true;
      slot.seen = true;
      slot.lastSeen = now;
      slot.nx = hand.x;
      slot.ny = hand.y;
      const p = mapToViewport(hand.x, hand.y, width, height, REACH);
      slot.x = slot.fx.filter(p.x, now);
      slot.y = slot.fy.filter(p.y, now);
      slot.pinch = hand.pinch;
    });

    // 2. Hands gone for longer than a dropped frame or two let go.
    for (const slot of slots) {
      if (slot.live && !slot.seen && now - slot.lastSeen > LOST_GRACE_MS) endSlot(slot, now);
    }

    // 3. Each visible hand's pinch.
    for (const slot of slots) {
      if (!slot.seen) continue;
      const was = slot.engaged;
      slot.engaged = was ? slot.pinch > PINCH_OFF : slot.pinch > PINCH_ON;

      if (slot.engaged) {
        if (!was) engage(slot, now, engine);
        else continuePart(slot);
        continue;
      }

      if (was) endPart(slot, now, true);
      // Near misses count only while aiming or already on a part: an open
      // hand roaming empty space does not need eight extra rays a frame.
      const forgiving = slot.pinch >= FORGIVING_PINCH || slot.hover !== null;
      slot.hover = engine ? engine.pickForHand(slot.x, slot.y, forgiving) : null;
      if (slot.pinch >= AIM_LOCK) {
        const strayed =
          slot.lock !== null &&
          Math.hypot(slot.x - slot.lock.x, slot.y - slot.lock.y) > AIM_RADIUS_PX;
        if (!slot.lock || strayed) slot.lock = { target: slot.hover, x: slot.x, y: slot.y };
      } else if (slot.pinch < AIM_RELEASE) {
        slot.lock = null;
      }
    }

    // 4. Pinches in empty space: carry the car, or two hands explode it.
    updateSpace(engine, width);

    // 5. Cursors and glows.
    render(engine);
    return status();
  };

  const release = (): void => {
    const now = performance.now();
    for (const slot of slots) if (slot.live) endSlot(slot, now);
    endSpace();
    cursors?.clear();
    getEngine()?.clearHandFeedback();
  };

  return { onFrame, release };
}
