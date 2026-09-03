/**
 * Wired Future — photo to 3D, end to end.
 *
 * Decode -> screen the subject -> estimate depth -> build a relief mesh.
 * Every step reports into the same store the rest of the app reads, so the
 * status bar narrates the reconstruction the same way it narrates a tool call.
 *
 * Nothing leaves the browser at any point.
 */

import type { PhotoReliefInput, WiredEngine } from '@/scene/contract';
import { useWired } from '@/store/use-wired';
import type { PhotoStatus } from '@/store/use-wired';
import { estimateDepth, type DepthProgress } from './depth';
import { screenSubject } from './screen';

export const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;

export const ACCEPTED_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/bmp',
];

/** Longest edge we feed the models. Bigger costs time and buys nothing here. */
const WORKING_EDGE = 768;

export interface ReconstructResult {
  ok: boolean;
  message: string;
  input?: PhotoReliefInput;
}

function report(status: PhotoStatus, message: string, progress: number): void {
  useWired.getState().setPhoto({ status, message, progress }, 'system');
}

function fail(message: string): ReconstructResult {
  useWired
    .getState()
    .setPhoto({ status: 'error', message, progress: 0 }, 'system');
  return { ok: false, message };
}

/** Decode and downscale to a working-size RGBA buffer. */
async function decode(
  file: Blob,
): Promise<{ width: number; height: number; rgba: Uint8ClampedArray }> {
  const bitmap = await createImageBitmap(file);
  try {
    const longest = Math.max(bitmap.width, bitmap.height);
    const scale = longest > WORKING_EDGE ? WORKING_EDGE / longest : 1;
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('2D canvas unavailable');

    ctx.drawImage(bitmap, 0, 0, width, height);
    const image = ctx.getImageData(0, 0, width, height);
    return { width, height, rgba: image.data };
  } finally {
    bitmap.close();
  }
}

/**
 * Resample RGBA onto the depth grid.
 *
 * The model returns its own resolution, which never matches the source, and
 * photo-relief.ts requires depth and colors to be sampled on the SAME grid.
 */
function resampleColors(
  rgba: Uint8ClampedArray,
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
): Uint8ClampedArray {
  if (srcW === dstW && srcH === dstH) return rgba;

  const out = new Uint8ClampedArray(dstW * dstH * 4);
  for (let y = 0; y < dstH; y += 1) {
    const sy = Math.min(srcH - 1, Math.round((y / Math.max(1, dstH - 1)) * (srcH - 1)));
    for (let x = 0; x < dstW; x += 1) {
      const sx = Math.min(srcW - 1, Math.round((x / Math.max(1, dstW - 1)) * (srcW - 1)));
      const from = (sy * srcW + sx) * 4;
      const to = (y * dstW + x) * 4;
      out[to] = rgba[from];
      out[to + 1] = rgba[from + 1];
      out[to + 2] = rgba[from + 2];
      // Keep the source alpha. A cut-out PNG carries the subject's silhouette
      // in its alpha channel, and forcing it opaque reconstructs the empty
      // background as surface too - a ball comes out as a slab.
      out[to + 3] = rgba[from + 3];
    }
  }
  return out;
}

export async function reconstructFromImage(
  file: Blob,
  name: string,
  getEngine: () => WiredEngine | null,
): Promise<ReconstructResult> {
  const store = useWired.getState();

  try {
    /* --- 1. validate + decode --------------------------------------- */

    if (file.size > MAX_UPLOAD_BYTES) {
      const mb = (file.size / (1024 * 1024)).toFixed(1);
      return fail('that image is ' + mb + ' MB; the limit is 12 MB');
    }
    if (file.type && !ACCEPTED_TYPES.includes(file.type)) {
      return fail('unsupported file type "' + file.type + '"');
    }

    store.setPhoto({ sourceName: name, subject: null });
    report('reading', 'decoding ' + name, -1);

    const decoded = await decode(file);

    /* --- 2. screen the subject --------------------------------------- */

    report('screening', 'checking the subject is an object', -1);

    const onProgress = (p: DepthProgress) => {
      useWired.getState().setPhoto({ message: p.status, progress: p.progress });
    };

    const screen = await screenSubject(file, onProgress);

    if (!screen.allowed) {
      const message =
        'that looks like ' +
        screen.subject +
        '. Wired Future reconstructs objects only, not people or animals.';
      useWired
        .getState()
        .setPhoto(
          { status: 'rejected', message, progress: 0, subject: screen.subject },
          'system',
        );
      return { ok: false, message };
    }

    useWired.getState().setPhoto({ subject: screen.subject });

    /* --- 3. depth ----------------------------------------------------- */

    report('analyzing', 'estimating depth', -1);
    const depth = await estimateDepth(file, (p) => {
      useWired.getState().setPhoto({
        status: p.status.startsWith('downloading') ? 'downloading' : 'analyzing',
        message: p.status,
        progress: p.progress,
      });
    });

    /* --- 4. build ----------------------------------------------------- */

    report('building', 'building the relief mesh', -1);

    const colors = resampleColors(
      decoded.rgba,
      decoded.width,
      decoded.height,
      depth.width,
      depth.height,
    );

    const input: PhotoReliefInput = {
      width: depth.width,
      height: depth.height,
      depth: depth.depth,
      colors,
      name,
    };

    const engine = getEngine();
    if (!engine) {
      return fail('the render surface is not ready yet - try again in a moment');
    }

    engine.setPhotoRelief(input);
    useWired.getState().apply({ modelType: 'photo' }, 'system');

    const message =
      'reconstructed "' +
      name +
      '" as a ' +
      depth.width +
      'x' +
      depth.height +
      ' relief (' +
      screen.subject +
      ')';

    useWired.getState().setPhoto(
      {
        status: 'ready',
        message,
        progress: 1,
        width: depth.width,
        height: depth.height,
        sourceName: name,
        subject: screen.subject,
      },
      'system',
    );

    return { ok: true, message, input };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return fail('reconstruction failed: ' + detail);
  }
}
