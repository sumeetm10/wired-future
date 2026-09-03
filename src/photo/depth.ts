/**
 * Wired Future — monocular depth estimation, in the browser.
 *
 * Runs Depth Anything V2 Small (24.8M params) through transformers.js. Weights
 * stream from the HuggingFace CDN on first use and are cached by the browser
 * afterwards. Nothing is uploaded anywhere and no API key exists.
 *
 * transformers.js is imported lazily inside the function that needs it: a
 * top-level import would be evaluated during the static-export prerender, where
 * there is no WebGPU, no WASM host and no window.
 */

export interface DepthProgress {
  status: string;
  /** 0..1, or -1 when the step has no measurable length. */
  progress: number;
}

export interface DepthResult {
  width: number;
  height: number;
  /** Normalised 0..1, where 1 is NEAREST the camera. */
  depth: Float32Array;
}

const MODEL_ID = 'onnx-community/depth-anything-v2-small';

/* eslint-disable @typescript-eslint/no-explicit-any */
type DepthPipeline = (input: unknown) => Promise<any>;

/** Built once per page load; a second photo must not re-download the weights. */
let cached: DepthPipeline | null = null;
/** Shared so two concurrent uploads do not both start a 50 MB download. */
let inFlight: Promise<DepthPipeline> | null = null;

function hasWebGpu(): boolean {
  return typeof navigator !== 'undefined' && 'gpu' in navigator;
}

async function getPipeline(onProgress: (p: DepthProgress) => void): Promise<DepthPipeline> {
  if (cached) return cached;
  if (inFlight) return inFlight;

  inFlight = (async () => {
    const { pipeline } = await import('@huggingface/transformers');

    const progress_callback = (event: any) => {
      if (!event) return;
      if (event.status === 'progress' && typeof event.progress === 'number') {
        const pct = Math.round(event.progress);
        onProgress({
          status: 'downloading depth model ' + pct + '%',
          progress: Math.max(0, Math.min(1, event.progress / 100)),
        });
      } else if (event.status === 'ready') {
        onProgress({ status: 'depth model ready', progress: 1 });
      }
    };

    if (hasWebGpu()) {
      try {
        const gpu = (await pipeline('depth-estimation', MODEL_ID, {
          device: 'webgpu',
          progress_callback,
        })) as unknown as DepthPipeline;
        onProgress({ status: 'depth model running on WebGPU', progress: 1 });
        cached = gpu;
        return gpu;
      } catch {
        // Plenty of machines advertise navigator.gpu and still fail to build a
        // device. Fall back rather than losing the whole feature.
        onProgress({ status: 'WebGPU unavailable, falling back to WASM', progress: -1 });
      }
    }

    const wasm = (await pipeline('depth-estimation', MODEL_ID, {
      device: 'wasm',
      progress_callback,
    })) as unknown as DepthPipeline;
    onProgress({ status: 'depth model running on WASM', progress: 1 });
    cached = wasm;
    return wasm;
  })();

  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}

/**
 * Normalise raw model output to 0..1 with 1 nearest the camera.
 *
 * Depth Anything emits INVERSE depth (bigger = closer), but the absolute range
 * is not specified, so the min/max are measured rather than assumed.
 */
function normalise(raw: ArrayLike<number>, length: number): Float32Array {
  const out = new Float32Array(length);

  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < length; i += 1) {
    const v = raw[i];
    if (!Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }

  if (!Number.isFinite(min) || !Number.isFinite(max) || max === min) {
    // Flat or degenerate output: a uniform sheet is better than NaN geometry.
    out.fill(0.5);
    return out;
  }

  const span = max - min;
  for (let i = 0; i < length; i += 1) {
    const v = raw[i];
    out[i] = Number.isFinite(v) ? (v - min) / span : 0;
  }
  return out;
}

export async function estimateDepth(
  image: Blob | string,
  onProgress: (p: DepthProgress) => void,
): Promise<DepthResult> {
  const estimator = await getPipeline(onProgress);

  onProgress({ status: 'estimating depth', progress: -1 });

  // transformers.js accepts a URL or a RawImage; an object URL covers Blobs
  // without pulling RawImage into this module's type surface.
  const revoke = typeof image === 'string' ? null : URL.createObjectURL(image);
  try {
    const output = await estimator(revoke ?? image);
    const map = output?.depth ?? output?.predicted_depth ?? output;

    const width: number = map?.width;
    const height: number = map?.height;
    const data: ArrayLike<number> | undefined = map?.data;

    if (!width || !height || !data) {
      throw new Error('depth model returned no usable map');
    }

    // RawImage may carry more than one channel; depth is single-channel, so
    // stride past any padding rather than assuming length === width * height.
    const pixels = width * height;
    const channels = Math.max(1, Math.round(data.length / pixels));
    const single =
      channels === 1
        ? data
        : (() => {
            const packed = new Float32Array(pixels);
            for (let i = 0; i < pixels; i += 1) packed[i] = data[i * channels];
            return packed;
          })();

    return { width, height, depth: normalise(single, pixels) };
  } finally {
    if (revoke) URL.revokeObjectURL(revoke);
  }
}
