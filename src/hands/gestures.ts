/**
 * Wired Future — hand landmarks to gestures.
 *
 * Pure geometry, no MediaPipe types and no DOM: the tracker hands over 21
 * points per hand and this file decides what the hand is doing. Keeping it
 * pure means the thresholds below can be reasoned about (and changed) without
 * a camera attached.
 */

/** One of the 21 points MediaPipe returns, normalised to the frame. */
export interface Landmark {
  x: number;
  y: number;
  z: number;
}

/** Landmark indices used here, from the MediaPipe hand model. */
const THUMB_TIP = 4;
const INDEX_TIP = 8;
const WRIST = 0;
const MIDDLE_MCP = 9;

/**
 * Pinch is measured as a RATIO of hand size, never in raw frame units.
 * A hand near the camera is twice the size of one at arm's length, so a fixed
 * distance would read as permanently pinched up close and never pinched far
 * away.
 */
const PINCH_CLOSED = 0.25;
const PINCH_OPEN = 0.55;

export interface HandReading {
  /**
   * Pinch point, normalised 0..1 and MIRRORED, so moving your hand to your
   * right moves the value up — matching the flipped video preview. Without the
   * flip the control is a mirror image of the preview and reads as broken.
   */
  x: number;
  y: number;
  /** 0 open, 1 closed. Continuous, so the caller can apply its own hysteresis. */
  pinch: number;
  /** Every landmark, mirrored, for the preview overlay. */
  points: Landmark[];
}

function distance(a: Landmark, b: Landmark): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Reduce one hand's landmarks to a pinch point and a pinch strength. */
export function readHand(landmarks: Landmark[]): HandReading | null {
  if (!landmarks || landmarks.length <= MIDDLE_MCP) return null;

  const thumb = landmarks[THUMB_TIP];
  const index = landmarks[INDEX_TIP];
  const wrist = landmarks[WRIST];
  const middle = landmarks[MIDDLE_MCP];

  const scale = distance(wrist, middle);
  // A degenerate hand (edge of frame, occluded) reports a near-zero span and
  // would divide out to an infinite pinch.
  if (scale < 1e-3) return null;

  const ratio = distance(thumb, index) / scale;
  const pinch = clamp01((PINCH_OPEN - ratio) / (PINCH_OPEN - PINCH_CLOSED));

  return {
    x: 1 - (thumb.x + index.x) / 2,
    y: (thumb.y + index.y) / 2,
    pinch,
    points: landmarks.map((p) => ({ x: 1 - p.x, y: p.y, z: p.z })),
  };
}

/** Straight-line gap between two pinch points, in normalised frame units. */
export function spanBetween(a: HandReading, b: HandReading): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}
