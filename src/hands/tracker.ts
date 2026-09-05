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

/**
 * Start the camera and the landmarker. Resolves once frames are flowing;
 * rejects if the camera is refused or the model cannot load.
 */
export async function startHandTracker(
  opts: HandTrackerOptions,
): Promise<HandTracker> {
  const { video, onFrame, onStatus, onError } = opts;

  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    throw new Error('this browser exposes no camera API');
  }

  onStatus('asking for the camera');

  // Modest resolution on purpose: the landmarker downsamples anyway, and a
  // 1080p stream costs frame time for no extra accuracy.
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
    audio: false,
  });

  let stopped = false;
  let rafHandle = 0;
  let vfcHandle = 0;
  let landmarker: { detectForVideo: (v: HTMLVideoElement, ts: number) => { landmarks?: Landmark[][] }; close: () => void } | null =
    null;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (rafHandle) cancelAnimationFrame(rafHandle);
    if (vfcHandle && typeof video.cancelVideoFrameCallback === 'function') {
      video.cancelVideoFrameCallback(vfcHandle);
    }
    for (const track of stream.getTracks()) track.stop();
    video.srcObject = null;
    // Closing frees the WASM heap; without it a second enable leaks the first
    // landmarker for the life of the tab.
    landmarker?.close();
    landmarker = null;
  };

  try {
    video.srcObject = stream;
    video.muted = true;
    video.playsInline = true;
    await video.play();

    onStatus('loading the hand model');

    const { FilesetResolver, HandLandmarker } = await import(
      '@mediapipe/tasks-vision'
    );
    if (stopped) {
      stop();
      throw new Error('cancelled');
    }

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

    onStatus('tracking');

    // detectForVideo rejects a timestamp it has already seen, and a paused or
    // still-buffering element reports zero dimensions.
    let lastTs = -1;

    const tick = () => {
      if (stopped || !landmarker) return;
      if (video.videoWidth > 0 && video.videoHeight > 0) {
        const ts = performance.now();
        if (ts > lastTs) {
          lastTs = ts;
          try {
            const result = landmarker.detectForVideo(video, ts);
            const hands: HandReading[] = [];
            for (const points of result.landmarks ?? []) {
              const reading = readHand(points);
              if (reading) hands.push(reading);
            }
            onFrame({ hands });
          } catch (err) {
            // One bad frame should not end the session; a broken landmarker
            // will simply keep throwing and the user can stop it.
            onError(err instanceof Error ? err.message : String(err));
          }
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
