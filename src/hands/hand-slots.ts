/**
 * Wired Future — keeping track of WHICH hand is which.
 *
 * MediaPipe returns the hands it sees in no particular order, and the order
 * can swap between two consecutive frames. A hand that is holding a door has
 * to stay the hand holding the door, so detections are matched to the two
 * slots by distance to where each slot's hand was last seen.
 *
 * Pure: no DOM, no MediaPipe, no three.js.
 */

export interface Point {
  x: number;
  y: number;
}

export interface SlotMatch {
  /** Slot index (0 or 1) this detection belongs to. */
  slot: number;
  /**
   * The slot was empty, or its last hand was too far away to be this one: a
   * hand left and a different one appeared. The caller starts the slot over.
   */
  fresh: boolean;
}

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * Assign each detection to one of `slots.length` slots (two for two hands).
 * `slots[i]` is the last position seen in slot i, or null when it is empty.
 * `maxJump` is how far, in the same units, a hand may move between frames
 * and still count as the same hand.
 */
export function matchHands(
  slots: Array<Point | null>,
  detections: Point[],
  maxJump: number,
): SlotMatch[] {
  const out: SlotMatch[] = [];
  if (!detections.length) return out;

  const taken = new Set<number>();
  const freeSlot = (): number => {
    // Prefer a slot nobody has used recently over one whose hand is merely
    // missing for a frame: that one may still come back.
    for (let i = 0; i < slots.length; i += 1) {
      if (!taken.has(i) && !slots[i]) return i;
    }
    for (let i = 0; i < slots.length; i += 1) {
      if (!taken.has(i)) return i;
    }
    return -1;
  };

  // Try every assignment of detections to live slots and keep the cheapest.
  // With at most two of each that is four candidates, so brute force is fine.
  const live = slots.map((s, i) => (s ? i : -1)).filter((i) => i >= 0);
  let best: Array<number> | null = null;
  let bestCost = Infinity;

  const consider = (assign: number[]) => {
    let cost = 0;
    for (let d = 0; d < assign.length; d += 1) {
      const s = assign[d];
      if (s < 0) continue;
      cost += dist(slots[s]!, detections[d]);
    }
    // Pairing more hands with their slots is always better than pairing
    // fewer, so every unmatched detection costs a full jump.
    cost += assign.filter((s) => s < 0).length * maxJump;
    if (cost < bestCost) {
      bestCost = cost;
      best = assign;
    }
  };

  const recurse = (d: number, assign: number[], used: Set<number>) => {
    if (d === detections.length) {
      consider(assign.slice());
      return;
    }
    // Leave this detection unmatched...
    assign.push(-1);
    recurse(d + 1, assign, used);
    assign.pop();
    // ...or give it any live slot not already used, within reach.
    for (const s of live) {
      if (used.has(s)) continue;
      if (dist(slots[s]!, detections[d]) > maxJump) continue;
      used.add(s);
      assign.push(s);
      recurse(d + 1, assign, used);
      assign.pop();
      used.delete(s);
    }
  };
  recurse(0, [], new Set());

  const chosen: number[] = best ?? detections.map(() => -1);
  for (const s of chosen) if (s >= 0) taken.add(s);

  for (let d = 0; d < detections.length; d += 1) {
    const s = chosen[d];
    if (s >= 0) {
      out.push({ slot: s, fresh: false });
    } else {
      const free = freeSlot();
      if (free >= 0) taken.add(free);
      out.push({ slot: free, fresh: true });
    }
  }
  return out;
}

/** The part of the camera frame that maps onto the whole screen. */
export interface ReachBox {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/**
 * Tracking fails at the edges of the camera frame, and reaching them is
 * tiring, so only the central part of the frame is used: it is stretched to
 * cover the whole viewport. Inputs are normalised, MIRRORED camera
 * coordinates; the result is viewport pixels, clamped to the screen.
 */
export function mapToViewport(
  nx: number,
  ny: number,
  width: number,
  height: number,
  reach: ReachBox,
): Point {
  const u = (nx - reach.left) / (reach.right - reach.left);
  const v = (ny - reach.top) / (reach.bottom - reach.top);
  return {
    x: Math.min(width - 1, Math.max(0, u * width)),
    y: Math.min(height - 1, Math.max(0, v * height)),
  };
}
