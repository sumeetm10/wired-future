/**
 * Wired Future — webcam hand tracking.
 *
 * Owns the camera stream and the MediaPipe HandLandmarker, and emits one
 * reading per hand per frame. Everything here is browser-only and lazily
 * imported: the model and its WASM runtime are several megabytes and must not
 * land in the first bundle for the visitors who never turn the camera on.
 *
 * Frames are never uploaded, recorded or drawn anywhere except the local
 * preview. The stream stops the moment stop() is called.
 */

import { readHand, type HandReading, type Landmark } from './gestures';

/**
 * Must match the @mediapipe/tasks-vision version in package.json. The npm
 * package ships the WASM next to the JS, but a static export cannot serve it
 * from node_modules, so it is fetched from the CDN at the pinned version. A
 * mismatch loads a runtime built against a different API.
 */
const MEDIAPIPE_VERSION = '1.0.1';
const WASM_ROOT =
  'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@' +
  MEDIAPIPE_VERSION +
  '/wasm';
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

export interface HandFrame {
  hands: HandReading[];
}

export interface HandTrackerOptions {
  video: HTMLVideoElement;
  onFrame: (frame: HandFrame) => void;
  onStatus: (status: string) => void;
  onError: (message: string) => void;
}

export interface HandTracker {
  stop: () => void;
}

/** With no hand in view for this long, look for one less often. */
const IDLE_AFTER_MS = 1000;
/** Gap between frames while idle: still quick to notice a raised hand. */
const IDLE_GAP_MS = 125;
/** Main-thread fallback never runs faster than this, so the page keeps breathing. */
const FALLBACK_GAP_MS = 66;

interface Detection {
  landmarks?: Landmark[][];
  worldLandmarks?: Landmark[][];
}

/**
 * Start the camera and the landmarker. Resolves once frames are flowing;
 * rejects if the camera is refused or the model cannot load.
 *
 * Detection runs in a Web Worker (hand-worker.ts). The page only grabs each
 * camera frame as an ImageBitmap and posts it; it never waits for the model.
 * One frame is in flight at a time, so a slow GPU lowers the tracking rate
 * instead of queueing frames and lagging. If a worker cannot be started, the
 * old main-thread path runs instead, throttled.
 */
export async function startHandTracker(
  opts: HandTrackerOptions,
): Promise<HandTracker> {
  const { video, onFrame, onStatus, onError } = opts;

  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    throw new Error('this browser exposes no camera API');
  }

  onStatus('asking for the camera');

  // Modest resolution and rate on purpose: the model works on a small crop
  // anyway, and a 1080p/60 stream costs decode time for nothing.
  const preferred: MediaStreamConstraints = {
    video: {
      width: { ideal: 640 },
      height: { ideal: 480 },
      frameRate: { ideal: 30 },
      facingMode: 'user',
    },
    audio: false,
  };
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia(preferred);
  } catch (err) {
    // Some drivers reject even "ideal" hints; the plainest request is the
    // last word on whether a camera is there at all.
    const name = err instanceof DOMException ? err.name : '';
    if (name !== 'NotFoundError' && name !== 'OverconstrainedError') throw err;
    stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
  }

  let stopped = false;
  let rafHandle = 0;
  let vfcHandle = 0;
  let worker: Worker | null = null;
  let landmarker: {
    detectForVideo: (v: HTMLVideoElement, ts: number) => Detection;
    close: () => void;
  } | null = null;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (rafHandle) cancelAnimationFrame(rafHandle);
    if (vfcHandle && typeof video.cancelVideoFrameCallback === 'function') {
      video.cancelVideoFrameCallback(vfcHandle);
    }
    for (const track of stream.getTracks()) track.stop();
    video.srcObject = null;
    // Terminating the worker frees its WASM heap and GPU context; closing the
    // fallback landmarker does the same on the main thread.
    worker?.terminate();
    worker = null;
    landmarker?.close();
    landmarker = null;
  };

  let lastHandAt = 0;
  let lastSentAt = 0;
  const deliver = (result: Detection, aspect: number, now: number) => {
    const hands: HandReading[] = [];
    const all = result.landmarks ?? [];
    for (let i = 0; i < all.length; i += 1) {
      // World landmarks are index-aligned with image landmarks.
      const reading = readHand(all[i], result.worldLandmarks?.[i], aspect);
      if (reading) hands.push(reading);
    }
    if (hands.length) lastHandAt = now;
    onFrame({ hands });
  };

  /** Too soon for another frame? Idle when no hand has been seen for a while. */
  const tooSoon = (now: number, minGap: number) => {
    const idle = now - lastHandAt > IDLE_AFTER_MS;
    return now - lastSentAt < Math.max(minGap, idle ? IDLE_GAP_MS : 0);
  };

  const startWorker = (): Promise<Worker> =>
    new Promise((resolve, reject) => {
      let w: Worker;
      try {
        w = new Worker(new URL('./hand-worker.ts', import.meta.url));
      } catch (err) {
        reject(err);
        return;
      }
      const onFirst = (event: MessageEvent) => {
        if (event.data?.type === 'ready') {
          w.removeEventListener('message', onFirst);
          resolve(w);
        } else if (event.data?.type === 'error') {
          w.removeEventListener('message', onFirst);
          w.terminate();
          reject(new Error(event.data.message));
        }
      };
      w.addEventListener('message', onFirst);
      w.addEventListener('error', (e) => {
        w.terminate();
        reject(new Error(e.message || 'hand worker failed to start'));
      });
      w.postMessage({ type: 'init', wasmRoot: WASM_ROOT, modelUrl: MODEL_URL });
    });

  try {
    video.srcObject = stream;
    video.muted = true;
    video.playsInline = true;
    await video.play();

    onStatus('loading the hand model');

    try {
      worker = await startWorker();
    } catch {
      worker = null;
    }
    if (stopped) {
      stop();
      throw new Error('cancelled');
    }

    if (!worker) {
      const { FilesetResolver, HandLandmarker } = await import('@mediapipe/tasks-vision');
      const vision = await FilesetResolver.forVisionTasks(WASM_ROOT);
      const created = await HandLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: MODEL_URL, delegate: 'GPU' },
        runningMode: 'VIDEO',
        numHands: 2,
      });
      if (stopped) {
        created.close();
        throw new Error('cancelled');
      }
      landmarker = created as unknown as typeof landmarker;
    }

    onStatus('tracking');

    // One frame in flight to the worker at a time.
    let busy = false;
    if (worker) {
      worker.onmessage = (event: MessageEvent) => {
        const data = event.data;
        if (data?.type === 'result') {
          busy = false;
          if (!stopped) deliver(data, data.width / data.height, performance.now());
        } else if (data?.type === 'frame-error') {
          busy = false;
          if (!stopped && data.message !== 'not ready') onError(data.message);
        }
      };
    }

    // detectForVideo rejects a timestamp it has already seen, and a paused or
    // still-buffering element reports zero dimensions.
    let lastTs = -1;

    const tick = () => {
      if (stopped) return;
      const now = performance.now();
      const ready = video.videoWidth > 0 && video.videoHeight > 0 && now > lastTs;

      if (ready && worker && !busy && !tooSoon(now, 0)) {
        lastTs = now;
        lastSentAt = now;
        busy = true;
        const w = worker;
        createImageBitmap(video)
          .then((bitmap) => {
            if (stopped || worker !== w) {
              bitmap.close();
              return;
            }
            w.postMessage({ type: 'frame', bitmap, ts: now }, [bitmap]);
          })
          .catch(() => {
            busy = false;
          });
      } else if (ready && landmarker && !tooSoon(now, FALLBACK_GAP_MS)) {
        lastTs = now;
        lastSentAt = now;
        try {
          deliver(
            landmarker.detectForVideo(video, now),
            video.videoWidth / video.videoHeight,
            now,
          );
        } catch (err) {
          // One bad frame should not end the session.
          onError(err instanceof Error ? err.message : String(err));
        }
      }
      schedule();
    };

    // requestVideoFrameCallback fires once per DECODED frame, so the tracker
    // runs at camera rate rather than display rate and never sees a frame
    // twice. Safari and older Firefox lack it, hence the rAF fallback.
    const useVfc = typeof video.requestVideoFrameCallback === 'function';
    const schedule = useVfc
      ? () => {
          vfcHandle = video.requestVideoFrameCallback(tick);
        }
      : () => {
          rafHandle = requestAnimationFrame(tick);
        };

    schedule();
    return { stop };
  } catch (err) {
    stop();
    throw err instanceof Error ? err : new Error(String(err));
  }
}
