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

let landmarker: HandLandmarker | null = null;
let delegate: 'GPU' | 'CPU' = 'GPU';

const post = (message: unknown) => (self as unknown as Worker).postMessage(message);

async function init(wasmRoot: string, modelUrl: string): Promise<void> {
  const vision = await FilesetResolver.forVisionTasks(wasmRoot);
  const options = (use: 'GPU' | 'CPU') => ({
    baseOptions: { modelAssetPath: modelUrl, delegate: use },
    runningMode: 'VIDEO' as const,
    numHands: 2,
  });
  try {
    landmarker = await HandLandmarker.createFromOptions(vision, options('GPU'));
  } catch {
    // No WebGL in workers on this browser: the CPU path is slower, but it is
    // still off the page's thread.
    landmarker = await HandLandmarker.createFromOptions(vision, options('CPU'));
    delegate = 'CPU';
  }
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
    if (!landmarker) {
      post({ type: 'frame-error', message: 'not ready' });
      return;
    }
    const result = landmarker.detectForVideo(bitmap, ts);
    post({
      type: 'result',
      ts,
      width: bitmap.width,
      height: bitmap.height,
      landmarks: result.landmarks ?? [],
      worldLandmarks: result.worldLandmarks ?? [],
    });
  } catch (err) {
    post({ type: 'frame-error', message: err instanceof Error ? err.message : String(err) });
  } finally {
    bitmap.close();
  }
};
