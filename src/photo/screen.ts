/**
 * Wired Future — subject screening.
 *
 * Wired Future reconstructs OBJECTS. Photos of people and animals are refused
 * before any geometry is built. This runs a small CLIP zero-shot classifier in
 * the browser, alongside the depth model, with no server involved.
 */

import type { DepthProgress } from './depth';

const MODEL_ID = 'Xenova/clip-vit-base-patch32';

/** Labels the classifier scores the image against. Order does not matter. */
const LIVING_LABELS = [
  'a photo of a person',
  'a photo of a human face',
  'a photo of a group of people',
  'a photo of an animal',
  'a photo of a pet dog or cat',
  'a photo of a bird',
];

const OBJECT_LABELS = [
  'a photo of a car or vehicle',
  'a photo of a machine or engine',
  'a photo of furniture',
  'a photo of a tool or device',
  'a photo of a building or architecture',
  'a photo of a product or manufactured object',
  'a photo of food or a plant',
];

const CANDIDATES = [...LIVING_LABELS, ...OBJECT_LABELS];
const LIVING = new Set(LIVING_LABELS);

export interface ScreenResult {
  allowed: boolean;
  /** The winning label with the "a photo of " prefix stripped. */
  subject: string;
  confidence: number;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type ClipPipeline = (input: unknown, labels: string[]) => Promise<any>;

let cached: ClipPipeline | null = null;
let inFlight: Promise<ClipPipeline> | null = null;

async function getPipeline(onProgress: (p: DepthProgress) => void): Promise<ClipPipeline> {
  if (cached) return cached;
  if (inFlight) return inFlight;

  inFlight = (async () => {
    const { pipeline } = await import('@huggingface/transformers');
    const built = (await pipeline('zero-shot-image-classification', MODEL_ID, {
      progress_callback: (event: any) => {
        if (event?.status === 'progress' && typeof event.progress === 'number') {
          onProgress({
            status: 'downloading subject screen ' + Math.round(event.progress) + '%',
            progress: Math.max(0, Math.min(1, event.progress / 100)),
          });
        }
      },
    })) as unknown as ClipPipeline;
    cached = built;
    return built;
  })();

  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}

function tidy(label: string): string {
  return label.replace(/^a photo of (a |an )?/i, '');
}

export async function screenSubject(
  image: Blob,
  onProgress: (p: DepthProgress) => void,
): Promise<ScreenResult> {
  const url = URL.createObjectURL(image);
  try {
    const classifier = await getPipeline(onProgress);
    onProgress({ status: 'screening subject', progress: -1 });

    const output = await classifier(url, CANDIDATES);
    const results: Array<{ label: string; score: number }> = Array.isArray(output)
      ? output
      : [];

    if (results.length === 0) {
      throw new Error('classifier returned no scores');
    }

    const top = results.reduce((best, cur) => (cur.score > best.score ? cur : best));

    return {
      allowed: !LIVING.has(top.label),
      subject: tidy(top.label),
      confidence: top.score,
    };
  } catch {
    // The screen is a filter, not a security boundary. If the classifier will
    // not load, refusing every upload would break the feature outright for a
    // failure that has nothing to do with the image. Allow it through, and
    // report 'unscreened' so the caller can say so plainly in the UI.
    return { allowed: true, subject: 'unscreened', confidence: 0 };
  } finally {
    URL.revokeObjectURL(url);
  }
}
