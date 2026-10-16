'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

// Types only: the hand code itself is imported when the camera starts.
import type { HandController } from '@/hands/controller';
import type { HandCursorLayer } from '@/hands/cursor-layer';
import type { HandFrame, HandTracker } from '@/hands/tracker';
import type { WiredEngine } from '@/scene/contract';
import { useWired } from '@/store/use-wired';

/**
 * Bones drawn on the preview: MediaPipe's 21 landmarks as five fingers plus
 * the palm arch. Only used for the overlay, so it lives here rather than in
 * the gesture module.
 */
const BONES: Array<[number, number]> = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
];

/** Collapsed by default on a phone, where the rail is a stack of sheets. */
function useStartsOpen() {
  const [open, setOpen] = useState(true);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (window.matchMedia('(max-width: 767px)').matches) setOpen(false);
  }, []);
  return [open, setOpen] as const;
}

export interface HandsPanelProps {
  getEngine: () => WiredEngine | null;
}

export function HandsPanel({ getEngine }: HandsPanelProps) {
  const [open, setOpen] = useStartsOpen();
  const [on, setOn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('camera off');
  const [error, setError] = useState<string | null>(null);
  // Set on every camera frame; React skips the render when the value is the
  // same, so these only cost anything when something actually changed.
  const [label, setLabel] = useState('');
  const [handCount, setHandCount] = useState(0);
  const [pinch, setPinch] = useState(0);
  // Tracker results per second: the number to quote when tracking feels slow.
  const [rate, setRate] = useState(0);
  const rateRef = useRef({ count: 0, since: 0 });

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const trackerRef = useRef<HandTracker | null>(null);
  const controllerRef = useRef<HandController | null>(null);
  const cursorsRef = useRef<HandCursorLayer | null>(null);

  const bodyId = 'wf-hands-body';

  /* --- preview overlay ---------------------------------------------------- */

  const draw = useCallback((frame: HandFrame) => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;

    // Match the backing store to the element, or the drawing is stretched.
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }

    ctx.clearRect(0, 0, w, h);
    for (const hand of frame.hands) {
      const pts = hand.points;
      const hot = hand.pinch > 0.7;
      ctx.strokeStyle = hot ? '#37f5a0' : 'rgba(0, 240, 255, 0.75)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (const [a, b] of BONES) {
        const p = pts[a];
        const q = pts[b];
        if (!p || !q) continue;
        ctx.moveTo(p.x * w, p.y * h);
        ctx.lineTo(q.x * w, q.y * h);
      }
      ctx.stroke();

      // The pinch point is what actually drives the scene, so mark it.
      ctx.fillStyle = hot ? '#37f5a0' : '#00f0ff';
      ctx.beginPath();
      ctx.arc(hand.x * w, hand.y * h, hot ? 6 : 4, 0, Math.PI * 2);
      ctx.fill();
    }
  }, []);

  /* --- lifecycle ----------------------------------------------------------- */

  const stop = useCallback((message = 'camera off') => {
    trackerRef.current?.stop();
    trackerRef.current = null;
    // Let go of whatever a hand still holds, committing it, before the
    // cursors that show it disappear.
    controllerRef.current?.release();
    controllerRef.current = null;
    cursorsRef.current?.dispose();
    cursorsRef.current = null;
    const ctx = canvasRef.current?.getContext('2d');
    if (ctx && canvasRef.current) {
      ctx.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height);
    }
    setOn(false);
    setLabel('');
    setHandCount(0);
    setPinch(0);
    setRate(0);
    setStatus(message);
  }, []);

  const start = useCallback(async () => {
    const video = videoRef.current;
    if (!video || busy) return;
    setBusy(true);
    setError(null);
    // Show the element before starting: the tracker needs a laid-out video to
    // read frames from, and a hidden one reports zero dimensions forever.
    setOn(true);

    try {
      // Loaded with the camera, not with the page: a visitor who never turns
      // it on never downloads the hand code, let alone MediaPipe.
      const [{ createHandController }, { HandCursorLayer }, { startHandTracker }] =
        await Promise.all([
          import('@/hands/controller'),
          import('@/hands/cursor-layer'),
          import('@/hands/tracker'),
        ]);

      const cursors = new HandCursorLayer(document.body);
      cursorsRef.current = cursors;
      const controller = createHandController({ getEngine, cursors });
      controllerRef.current = controller;

      const tracker = await startHandTracker({
        video,
        onStatus: setStatus,
        onError: (m) => setError(m),
        onFrame: (frame) => {
          const next = controller.onFrame(frame);
          setLabel(next.label);
          setHandCount(next.hands);
          setPinch(Math.round(next.pinch * 20) / 20);
          const r = rateRef.current;
          const t = performance.now();
          r.count += 1;
          if (t - r.since >= 1000) {
            setRate(r.since ? Math.round((r.count * 1000) / (t - r.since)) : 0);
            r.count = 0;
            r.since = t;
          }
          draw(frame);
        },
      });
      trackerRef.current = tracker;
      useWired
        .getState()
        .log('hand', 'camera on - point at a part and pinch to hold it');
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      const name = err instanceof DOMException ? err.name : '';
      const denied = name === 'NotAllowedError' || /denied|not allowed|dismissed/i.test(detail);
      setError(
        denied
          ? 'camera permission was refused - allow it in the address bar to use gestures'
          : name === 'NotFoundError'
            ? 'no camera found - check it is switched on (some laptops have a camera key or shutter) and that Windows camera access is on'
            : name === 'NotReadableError'
              ? 'the camera is busy - close any other app or tab using it (Zoom, Teams, another browser tab) and try again'
              : detail,
      );
      stop('camera off');
    } finally {
      setBusy(false);
    }
  }, [busy, draw, getEngine, stop]);

  // Release the camera on unmount. Leaving it running keeps the recording
  // light on after the panel is gone.
  useEffect(() => () => {
    trackerRef.current?.stop();
    controllerRef.current?.release();
    cursorsRef.current?.dispose();
  }, []);

  return (
    <section className="wf-dock wf-dock--hands" aria-label="Hand control">
      <div id="tour-hands" className="wf-panel">
        <header className="wf-panel__head">
          <h2 className="wf-panel__title">Hand Control</h2>
          <button
            type="button"
            className="wf-button wf-button--chip wf-chip-toggle"
            aria-expanded={open}
            aria-controls={bodyId}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? 'Minimise' : 'Hands'}
          </button>
        </header>

        <div
          id={bodyId}
          className={
            'wf-panel__body wf-scroll wf-collapsible' + (open ? ' is-open' : '')
          }
        >
          <p className="wf-note">
            Point at the car with your hand, then pinch your thumb and index
            finger together to hold a part. Tracking runs in this browser tab -
            the video is never uploaded or recorded.
          </p>

          <div className={'wf-cam' + (on ? ' is-live' : '')}>
            {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
            <video ref={videoRef} className="wf-cam__video" playsInline muted />
            <canvas ref={canvasRef} className="wf-cam__overlay" />
            {!on ? (
              <span className="wf-cam__hint">camera off</span>
            ) : null}
          </div>

          <div className="wf-row">
            <span className="wf-label" aria-live="polite">
              {on ? label || status : status}
            </span>
            <span className="wf-readout">
              {on
                ? handCount +
                  ' HAND' +
                  (handCount === 1 ? '' : 'S') +
                  (rate ? ' · ' + rate + ' FPS' : '')
                : ''}
            </span>
          </div>

          {on ? (
            <div className="wf-meter" aria-hidden="true">
              <span
                className={'wf-meter__fill' + (pinch > 0.7 ? ' is-hot' : '')}
                style={{ width: Math.round(pinch * 100) + '%' }}
              />
            </div>
          ) : null}

          <button
            type="button"
            className={
              'wf-button ' + (on ? 'wf-button--ghost' : 'wf-button--primary')
            }
            disabled={busy}
            onClick={() => (on ? stop() : void start())}
          >
            {busy ? 'Starting' : on ? 'Stop camera' : 'Enable camera'}
          </button>

          {error ? <span className="wf-note wf-note--warn">{error}</span> : null}

          <ul className="wf-gestures">
            <li>
              <strong>point</strong> - a cursor follows the gap between your
              thumb and index finger, and the part under it glows.
            </li>
            <li>
              <strong>pinch a door or the hood</strong> - hold it and move your
              hand: it swings on its hinge with you.
            </li>
            <li>
              <strong>pinch any other part</strong> - a window, a wheel, a
              mirror: carry it, then open your fingers to let go.
            </li>
            <li>
              <strong>quick pinch</strong> - opens or shuts, pops a part off, or
              puts it back, like Ctrl-click.
            </li>
            <li>
              <strong>pinch empty space</strong> - move your hand to turn the
              view around the car.
            </li>
            <li>
              <strong>both hands in empty space</strong> - spread to explode,
              move together to carry the car, twist to turn it. The trace logs
              each result as <strong>[HAND]</strong>.
            </li>
          </ul>
        </div>
      </div>
    </section>
  );
}

export default HandsPanel;
