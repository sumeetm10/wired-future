/**
 * Wired Future — acting on one part of the car.
 *
 * A Ctrl-click and a quick pinch from a webcam hand mean the same thing: do
 * what this part does. Both land here so the two can never drift apart, and
 * only the origin differs, which is what the trace shows as [HUMAN] or [HAND].
 */

import {
  useWired,
  type ActionOrigin,
  type CarPartId,
  type CarRigState,
  type WiredState,
} from './use-wired';

export interface PartActuation {
  node: string;
  assembly: CarPartId;
  hinged: boolean;
  /** The part is removed: put it back rather than act on it. */
  restore: boolean;
}

type HingeKey = 'doorLeft' | 'doorRight' | 'hood';

const HINGE_KEY: Partial<Record<CarPartId, HingeKey>> = {
  doorLeft: 'doorLeft',
  doorRight: 'doorRight',
  hood: 'hood',
};

/** The store field a hinged assembly's opening lives in, if it has one. */
export function hingeKeyFor(assembly: CarPartId): HingeKey | null {
  return HINGE_KEY[assembly] ?? null;
}

/**
 * A carRig patch carrying ONLY these fields. apply() merges it over the live
 * rig. Spreading the whole rig in instead made the sanitiser rebuild every
 * map and every part edit, and the engine then re-applied every reshaped part
 * - once per click, or once per camera frame for a hand.
 */
export function rigPatch(fields: Partial<CarRigState>): Partial<WiredState> {
  return { carRig: fields as CarRigState };
}

/**
 * Do what a part does. A hinged part opens or shuts, anything else pops off
 * or back on, and a removed part is put back - the whole assembly if that is
 * what was taken off, the single mesh otherwise.
 */
export function actuatePart(target: PartActuation, origin: ActionOrigin): void {
  const store = useWired.getState();
  const rig = store.carRig;

  if (target.restore) {
    if (rig.hidden.includes(target.assembly)) {
      store.apply(
        rigPatch({ hidden: rig.hidden.filter((x) => x !== target.assembly) }),
        origin,
      );
    }
    const latest = useWired.getState().carRig;
    if (latest.hiddenNodes.includes(target.node)) {
      store.setNodeHidden(
        latest.hiddenNodes.filter((x) => x !== target.node),
        origin,
      );
    }
    return;
  }

  const key = target.hinged ? hingeKeyFor(target.assembly) : null;
  if (key) {
    store.apply(rigPatch({ [key]: rig[key] > 0.5 ? 0 : 1 }), origin);
    return;
  }

  const hiddenNow = rig.hiddenNodes.includes(target.node);
  store.setNodeHidden(
    hiddenNow
      ? rig.hiddenNodes.filter((x) => x !== target.node)
      : [...rig.hiddenNodes, target.node],
    origin,
  );
}
