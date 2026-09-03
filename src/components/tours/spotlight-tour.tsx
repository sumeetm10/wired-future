'use client';

/**
 * Wired Future — spotlight coachmark engine.
 *
 * One box-shadow does the whole effect. The ring element is the hole; its
 * 9999px spread shadow is the dim over everything else, so animating the
 * ring's top/left/width/height glides the spotlight and the dim follows for
 * free. No SVG mask, no clip-path.
 *
 * Steps are CSS selectors, not refs: the anchors live on real controls in
 * whichever component owns them, and a string crosses every boundary. Steps
 * whose target is not in the DOM are dropped, so one steps array serves the
 * page in every state and a renamed id degrades to a shorter tour instead of
 * a dark screen pointing at nothing.
 *
 * The overlay portals to document.body. Every panel here uses
 * backdrop-filter, which makes a position:fixed descendant fix itself to the
 * panel, not the viewport; body is outside all of that.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useState,
  type MouseEvent,
} from 'react';
import { createPortal } from 'react-dom';

export type TourStep = { sel: string; title: string; body: string };

type Box = { top: number; left: number; width: number; height: number };

export interface SpotlightTourProps {
  /** localStorage key. Bump the suffix (_v1 -> _v2) to re-show a rewritten tour. */
  storageKey: string;
  /** Declare at MODULE scope. An inline array is a new identity every render and loops the presence effect. */
  steps: TourStep[];
  /** Wait before probing the DOM, for targets that arrive after mount. */
  startDelay?: number;
  /** Label on the inline replay chip. */
  replayLabel?: string;
}

/* Tooltip is positioned before it renders, so its size is a constant. Width
   is exact (CSS pins it); height is a ceiling used only for fit tests. */
const TIP_W = 300;
const TIP_H = 230;
const GAP = 12;
const PAD = 6;

export default function SpotlightTour({
  storageKey,
  steps,
  startDelay = 600,
  replayLabel = 'Tour',
}: SpotlightTourProps) {
  // Render nothing on the server and on the first client pass. The portal
  // needs a DOM, and localStorage decides visibility; both passes must agree
  // or React reports a hydration mismatch.
  const [mounted, setMounted] = useState(false);
  // Steps whose targets exist right now. Dots, "last" and next() use this.
  const [live, setLive] = useState<TourStep[]>([]);
  const [active, setActive] = useState(false);
  const [idx, setIdx] = useState(0);
  const [box, setBox] = useState<Box | null>(null);

  useEffect(() => setMounted(true), []);

  const presentSteps = useCallback(
    () => steps.filter((s) => document.querySelector(s.sel)),
    [steps],
  );

  /* --- should it auto-run? ---------------------------------------------- */

  useEffect(() => {
    let seen = false;
    try {
      seen = !!localStorage.getItem(storageKey);
    } catch {
      // Private mode can throw on read. Worst case the tour shows twice.
    }
    const t = setTimeout(() => {
      const present = presentSteps();
      // Set regardless of `seen`: the replay chip needs to know whether
      // there is anything to point at.
      setLive(present);
      if (!seen && present.length > 0) setActive(true);
    }, startDelay);
    return () => clearTimeout(t);
  }, [storageKey, presentSteps, startDelay]);

  /* --- measure the current target --------------------------------------- */

  // Layout effect, not effect: measuring after paint shows one frame of the
  // ring at the previous step's position before it jumps.
  useLayoutEffect(() => {
    if (!active || live.length === 0) return;
    const step = live[Math.min(idx, live.length - 1)];
    let raf = 0;

    const measure = () => {
      const el = document.querySelector(step.sel) as HTMLElement | null;
      if (!el) return setBox(null);
      // Viewport coordinates, which is what position:fixed wants. Scrolling
      // changes them, hence the listener below.
      const r = el.getBoundingClientRect();
      setBox({ top: r.top, left: r.left, width: r.width, height: r.height });
    };

    const el = document.querySelector(step.sel) as HTMLElement | null;
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    measure();

    // The smooth scroll moves the target for several hundred ms, and a
    // scroll cut short by the next step does not always report its final
    // frame. Measure every frame until the rect has held still, with a hard
    // stop so a target that never settles cannot pin the loop open.
    const started = performance.now();
    let lastKey = '';
    let still = 0;
    let settle = 0;
    const settleTick = () => {
      const target = document.querySelector(step.sel) as HTMLElement | null;
      const r = target?.getBoundingClientRect();
      const key = r ? r.top + ':' + r.left + ':' + r.width + ':' + r.height : '';
      if (key === lastKey) {
        still += 1;
      } else {
        still = 0;
        lastKey = key;
        measure();
      }
      const elapsed = performance.now() - started;
      if (elapsed < 1200 && (still < 12 || elapsed < 350)) {
        settle = requestAnimationFrame(settleTick);
      }
    };
    settle = requestAnimationFrame(settleTick);

    // One measurement per frame: getBoundingClientRect forces layout, and
    // scroll can fire many times a frame.
    const onMove = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(measure);
    };
    window.addEventListener('resize', onMove);
    // Capture phase, because scroll does not bubble. A target inside the
    // right-hand rail scrolls the rail, not the window, and a bubble-phase
    // listener on window never hears it.
    window.addEventListener('scroll', onMove, true);
    // Where supported, the definitive "smooth scroll has landed" signal.
    window.addEventListener('scrollend', onMove, true);

    // Belt and braces for a background tab, where rAF does not tick: one
    // plain timer past the longest smooth scroll, and a re-measure once the
    // self-hosted fonts have settled the title lockup above the panels.
    const late = setTimeout(measure, 700);
    let cancelled = false;
    document.fonts?.ready.then(() => {
      if (!cancelled) measure();
    });

    // The Parts list fills in after the rig loads, and a panel that grows
    // moves everything below it in the rail. Size changes on the target
    // itself are the cheap part to watch.
    const ro = el && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(onMove) : null;
    if (ro && el) ro.observe(el);

    return () => {
      cancelled = true;
      clearTimeout(late);
      ro?.disconnect();
      cancelAnimationFrame(settle);
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', onMove);
      window.removeEventListener('scroll', onMove, true);
      window.removeEventListener('scrollend', onMove, true);
    };
  }, [active, idx, live]);

  /* --- navigation --------------------------------------------------------- */

  const dismiss = useCallback(() => {
    setActive(false);
    try {
      localStorage.setItem(storageKey, '1');
    } catch {
      // Nothing to do; the tour simply shows again next visit.
    }
  }, [storageKey]);

  const last = idx >= live.length - 1;

  const next = useCallback(() => {
    if (last) dismiss();
    else setIdx((i) => i + 1);
  }, [last, dismiss]);

  const back = useCallback(() => {
    setIdx((i) => Math.max(0, i - 1));
  }, []);

  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        dismiss();
      } else if (e.key === 'ArrowRight' || e.key === 'Enter') {
        e.preventDefault();
        next();
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        back();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, dismiss, next, back]);

  // Re-query rather than reuse `live`: the page may have changed since mount.
  const replay = () => {
    const present = presentSteps();
    if (present.length === 0) return;
    setLive(present);
    setIdx(0);
    setBox(null);
    setActive(true);
  };

  if (!mounted) return null;

  // The chip renders inline where the component is mounted; only the overlay
  // portals out. Put <SpotlightTour> where you want the chip to sit.
  const replayChip =
    live.length > 0 && !active ? (
      <button
        type="button"
        className="wf-button wf-button--chip wf-tour-replay"
        onClick={replay}
      >
        {replayLabel}
      </button>
    ) : null;

  if (!active || live.length === 0) return replayChip;

  const step = live[Math.min(idx, live.length - 1)];

  /* --- tooltip placement: right, then below, then above ------------------ */

  let tip = { top: 80, left: 80 };
  if (box) {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const clampL = (l: number) => Math.min(Math.max(l, 8), vw - TIP_W - 8);
    const clampT = (t: number) => Math.min(Math.max(t, 8), vh - TIP_H - 8);
    if (box.left + box.width + GAP + TIP_W <= vw) {
      tip = { left: box.left + box.width + GAP, top: clampT(box.top) };
    } else if (box.top + box.height + GAP + TIP_H <= vh) {
      tip = { top: box.top + box.height + GAP, left: clampL(box.left) };
    } else if (box.top - TIP_H - GAP >= 8) {
      tip = { top: box.top - TIP_H - GAP, left: clampL(box.left) };
    } else if (box.left - TIP_W - GAP >= 8) {
      tip = { left: box.left - TIP_W - GAP, top: clampT(box.top) };
    } else {
      tip = { top: 8, left: clampL(box.left) };
    }
  }

  const stop = (e: MouseEvent) => e.stopPropagation();

  return createPortal(
    <div className="wf-tour" role="dialog" aria-modal="true" aria-label={step.title}>
      {box ? (
        <div
          className="wf-tour-ring"
          aria-hidden="true"
          style={{
            top: box.top - PAD,
            left: box.left - PAD,
            width: box.width + PAD * 2,
            height: box.height + PAD * 2,
          }}
        />
      ) : (
        <div className="wf-tour-dim" aria-hidden="true" />
      )}

      {/* Click anywhere to advance. The ring is pointer-events:none so this
          also catches clicks on the highlighted area. */}
      <div className="wf-tour-catcher" onClick={next} />

      <div className="wf-tour-tip" style={tip} onClick={stop}>
        <div className="wf-tour-tip__meta">
          <span className="wf-label">
            {idx + 1} / {live.length}
          </span>
          <span className="wf-tour-dots" aria-hidden="true">
            {live.map((s, i) => (
              <span
                key={s.sel}
                className={'wf-tour-dot' + (i === idx ? ' is-on' : '')}
              />
            ))}
          </span>
        </div>
        <h3 className="wf-tour-tip__title">{step.title}</h3>
        <p className="wf-tour-tip__body">{step.body}</p>
        <div className="wf-tour-tip__actions">
          <button
            type="button"
            className="wf-button wf-button--chip"
            onClick={dismiss}
          >
            Skip
          </button>
          <span className="wf-tour-tip__spacer" />
          {idx > 0 ? (
            <button
              type="button"
              className="wf-button wf-button--chip"
              onClick={back}
            >
              Back
            </button>
          ) : null}
          <button
            type="button"
            className="wf-button wf-button--primary wf-tour-next"
            onClick={next}
          >
            {last ? 'Done' : 'Next'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
