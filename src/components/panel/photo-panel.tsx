'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import type { WiredEngine } from '@/scene/contract';
import { useWired } from '@/store/use-wired';
import {
  ACCEPTED_TYPES,
  reconstructFromImage,
} from '@/photo/pipeline';

export interface PhotoPanelProps {
  getEngine: () => WiredEngine | null;
}

const BUSY_STATES = new Set(['reading', 'screening', 'downloading', 'analyzing', 'building']);

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

/**
 * Photo to 3D, the human half.
 *
 * Everything here runs in the browser: depth estimation and the subject screen
 * are both local models. No upload, no API key, no server.
 */
export function PhotoPanel({ getEngine }: PhotoPanelProps) {
  // Primitive selectors only — a derived object would loop under zustand v5.
  const status = useWired((s) => s.photo.status);
  const message = useWired((s) => s.photo.message);
  const progress = useWired((s) => s.photo.progress);
  const sourceName = useWired((s) => s.photo.sourceName);

  const [open, setOpen] = useStartsOpen();
  const [dragging, setDragging] = useState(false);
  const [thumb, setThumb] = useState<string | null>(null);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const thumbRef = useRef<string | null>(null);

  // One object URL per upload; leaking one per drop is a real leak.
  const setThumbUrl = useCallback((next: string | null) => {
    if (thumbRef.current) URL.revokeObjectURL(thumbRef.current);
    thumbRef.current = next;
    setThumb(next);
  }, []);

  useEffect(
    () => () => {
      if (thumbRef.current) URL.revokeObjectURL(thumbRef.current);
      thumbRef.current = null;
    },
    [],
  );

  const busy = BUSY_STATES.has(status);
  const bodyId = 'wf-photo-body';

  const handleFile = useCallback(
    (file: File | undefined) => {
      if (!file || busy) return;
      setThumbUrl(URL.createObjectURL(file));
      // The pipeline owns validation; duplicating it here would let the two
      // disagree about what is acceptable.
      void reconstructFromImage(file, file.name, getEngine);
    },
    [busy, getEngine, setThumbUrl],
  );

  const clear = useCallback(() => {
    setThumbUrl(null);
    getEngine()?.clearPhotoRelief();
    useWired.getState().resetPhoto('human');
    useWired.getState().apply({ modelType: 'car' }, 'human');
    if (inputRef.current) inputRef.current.value = '';
  }, [getEngine, setThumbUrl]);

  const barClass =
    'wf-progress__fill' + (progress < 0 ? ' is-indeterminate' : '');

  return (
    <section className="wf-dock wf-dock--photo" aria-label="Photo to 3D">
      <div
        id="tour-photo"
        className={
          'wf-panel' + (status === 'rejected' ? ' wf-panel--refused' : '')
        }
      >
        <header className="wf-panel__head">
          <h2 className="wf-panel__title">Photo to 3D</h2>
          <button
            type="button"
            className="wf-button wf-button--chip wf-chip-toggle"
            aria-expanded={open}
            aria-controls={bodyId}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? 'Minimise' : 'Upload'}
          </button>
        </header>

        <div
          id={bodyId}
          className={
            'wf-panel__body wf-scroll wf-collapsible' + (open ? ' is-open' : '')
          }
        >
          <p className="wf-note">
            Depth is estimated by a model running in this browser tab. Your image
            is never uploaded anywhere. Objects only — people and animals are
            declined.
          </p>

          <button
            type="button"
            className={'wf-drop' + (dragging ? ' is-dragging' : '')}
            disabled={busy}
            onClick={() => inputRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              handleFile(e.dataTransfer.files?.[0]);
            }}
          >
            {thumb ? (
              /* eslint-disable-next-line @next/next/no-img-element */
              <img className="wf-drop__thumb" src={thumb} alt="Uploaded source" />
            ) : (
              <span className="wf-drop__hint">
                Drop an image, or click to browse
              </span>
            )}
          </button>

          <input
            ref={inputRef}
            type="file"
            className="wf-visually-hidden"
            accept={ACCEPTED_TYPES.join(',')}
            onChange={(e) => handleFile(e.target.files?.[0])}
          />

          {busy || status !== 'idle' ? (
            <div className="wf-field">
              <div className="wf-row">
                <span className="wf-label">
                  {status === 'rejected' ? 'Declined' : status}
                </span>
                {sourceName ? (
                  <span className="wf-readout">{sourceName}</span>
                ) : null}
              </div>

              {busy ? (
                <div className="wf-progress" role="progressbar">
                  <div
                    className={barClass}
                    style={
                      progress >= 0
                        ? { width: Math.round(progress * 100) + '%' }
                        : undefined
                    }
                  />
                </div>
              ) : null}

              <p
                className={
                  'wf-note' +
                  (status === 'rejected'
                    ? ' wf-note--refused'
                    : status === 'error'
                      ? ' wf-note--error'
                      : '')
                }
              >
                {message}
              </p>
            </div>
          ) : null}

          <div className="wf-row">
            <span className="wf-note">Runs entirely on-device.</span>
            <button
              type="button"
              className="wf-button wf-button--ghost wf-button--chip"
              disabled={busy}
              onClick={clear}
            >
              Clear
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

export default PhotoPanel;
