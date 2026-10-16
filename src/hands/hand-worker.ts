/**
 * Wired Future — hand tracking off the main thread.
 *
 * MediaPipe's detectForVideo is synchronous: on the page's main thread it
 * blocked rendering and input for ~800 ms of every second on an Intel UHD
 * laptop, dropping the 3D scene from 18 to 8 fps. Here it runs in a worker:
 * the page posts a camera frame as an ImageBitmap, carries on drawing, and
 * gets landmarks back whenever they are ready.
 *
 * A classic worker on purpose: MediaPipe loads its WASM runtime with
 * importScripts, which module workers do not have.
 */

import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision';

type InMessage =
  | { type: 'init'; wasmRoot: string; modelUrl: string }
  | { type: 'frame'; bitmap: ImageBitmap; ts: number };

/**
 * Two landmarkers, because of how MediaPipe tracks in VIDEO mode: it runs the
 * expensive full-frame palm detector on every frame until it is tracking
 * `numHands` hands, and only the cheap landmark model after that. With
 * numHands 2 and one hand up (the usual case) that meant the slow path on
 * every single frame. So `one` (numHands 1) tracks the common case cheaply,
 * and `two` looks for a second hand every DISCOVER_MS; while it is tracking
 * two hands it takes over, and it is cheap then too.
 */
let one: HandLandmarker | null = null;
let two: HandLandmarker | null = null;
let twoActive = false;
let lastDiscoverTs = -Infinity;
let delegate: 'GPU' | 'CPU' = 'GPU';
const DISCOVER_MS = 300;

const post = (message: unknown) => (self as unknown as Worker).postMessage(message);

async function init(wasmRoot: string, modelUrl: string): Promise<void> {
  const vision = await FilesetResolver.forVisionTasks(wasmRoot);
  const create = (use: 'GPU' | 'CPU', numHands: number) =>
    HandLandmarker.createFromOptions(vision, {
      baseOptions: { modelAssetPath: modelUrl, delegate: use },
      runningMode: 'VIDEO',
      numHands,
    });
  try {
    one = await create('GPU', 1);
  } catch {
    // No WebGL in workers on this browser: the CPU path is slower, but it is
    // still off the page's thread.
    one = await create('CPU', 1);
    delegate = 'CPU';
  }
  // Built before 'ready', not after: compiling a second GPU graph stalls the
  // GPU for seconds, and doing it while the page is drawing froze the scene.
  try {
    two = await create(delegate, 2);
  } catch {
    two = null;
  }
  // The GPU shaders compile on the first detection, not on create: run one
  // on a blank frame per landmarker now, while the panel still says loading.
  const blank = new OffscreenCanvas(256, 256);
  blank.getContext('2d')?.fillRect(0, 0, 256, 256);
  one.detectForVideo(blank, 1);
  two?.detectForVideo(blank, 1);
}

function detect(bitmap: ImageBitmap, ts: number) {
  if (two && (twoActive || ts - lastDiscoverTs >= DISCOVER_MS)) {
    if (!twoActive) lastDiscoverTs = ts;
    const result = two.detectForVideo(bitmap, ts);
    // With fewer than two hands this frame still counts; `one` takes the
    // next frame and picks the hand up from there.
    twoActive = (result.landmarks?.length ?? 0) >= 2;
    return result;
  }
  return one!.detectForVideo(bitmap, ts);
}

self.onmessage = async (event: MessageEvent<InMessage>) => {
  const msg = event.data;
  if (msg.type === 'init') {
    try {
      await init(msg.wasmRoot, msg.modelUrl);
      post({ type: 'ready', delegate });
    } catch (err) {
      post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  const { bitmap, ts } = msg;
  try {
    // Always answer: the page sends the next frame only after a reply.
    if (!one) {
      post({ type: 'frame-error', message: 'not ready' });
      return;
    }
    const started = performance.now();
    const result = detect(bitmap, ts);
    post({
      type: 'result',
      ts,
      width: bitmap.width,
      height: bitmap.height,
      ms: performance.now() - started,
      landmarks: result.landmarks ?? [],
      worldLandmarks: result.worldLandmarks ?? [],
    });
  } catch (err) {
    post({ type: 'frame-error', message: err instanceof Error ? err.message : String(err) });
  } finally {
    bitmap.close();
  }
};
