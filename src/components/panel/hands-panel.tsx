'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { createHandController, type HandMode } from '@/hands/controller';
import { startHandTracker, type HandFrame, type HandTracker } from '@/hands/tracker';
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

const MODE_LABEL: Record<HandMode, string> = {
  idle: 'ready - pinch to grab',
  move: 'moving the car',
  explode: 'exploding',
};

/** Collapsed by default on a phone, where the rail is a stack of sheets. */
function useStartsOpen() {
  const [open, setOpen] = useState(true);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (window.matchMedia('(max-width: 767px)').matches) setOpen(false);
  }, []);
  return [open, setOpen] as const;
}

export function HandsPanel() {
  const [open, setOpen] = useStartsOpen();
  const [on, setOn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('camera off');
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<HandMode>('idle');
  const [pinches, setPinches] = useState<number[]>([]);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const trackerRef = useRef<HandTracker | null>(null);
  const controllerRef = useRef<ReturnType<typeof createHandController> | null>(null);

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
    controllerRef.current?.release();
    controllerRef.current = null;
    const ctx = canvasRef.current?.getContext('2d');
    if (ctx && canvasRef.current) {
      ctx.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height);
    }
    setOn(false);
    setMode('idle');
    setPinches([]);
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

    const controller = createHandController();
    controllerRef.current = controller;

    try {
      const tracker = await startHandTracker({
        video,
        onStatus: setStatus,
        onError: (m) => setError(m),
        onFrame: (frame) => {
          const next = controller.onFrame(frame);
          setMode(next.mode);
          setPinches(next.pinches);
          draw(frame);
        },
      });
      trackerRef.current = tracker;
      useWired
        .getState()
        .log('hand', 'camera on - pinch to move, two hands to explode');
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      const denied = /denied|not allowed|dismissed/i.test(detail);
      setError(
        denied
          ? 'camera permission was refused - allow it in the address bar to use gestures'
          : detail,
      );
      stop('camera off');
    } finally {
      setBusy(false);
    }
  }, [busy, draw, stop]);

  // Release the camera on unmount. Leaving it running keeps the recording
  // light on after the panel is gone.
  useEffect(() => () => {
    trackerRef.current?.stop();
    controllerRef.current?.release();
  }, []);

  const strongest = pinches.length ? Math.max(...pinches) : 0;

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
            Move the car with your hands. Tracking runs in this browser tab —
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
            <span className="wf-label">
              {on ? MODE_LABEL[mode] : status}
            </span>
            <span className="wf-readout">
              {on ? pinches.length + ' HAND' + (pinches.length === 1 ? '' : 'S') : ''}
            </span>
          </div>

          {on ? (
            <div className="wf-meter" aria-hidden="true">
              <span
                className={'wf-meter__fill' + (strongest > 0.7 ? ' is-hot' : '')}
                style={{ width: Math.round(strongest * 100) + '%' }}
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
              <strong>pinch one hand</strong> — grab the car and drag it with
              your hand.
            </li>
            <li>
              <strong>pinch both hands</strong> — pull them apart to explode the
              car, bring them together to reassemble it.
            </li>
            <li>
              <strong>open your hand</strong> — let go. The trace logs the
              result as <strong>[HAND]</strong>.
            </li>
          </ul>
        </div>
      </div>
    </section>
  );
}

export default HandsPanel;
