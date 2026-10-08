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

/**
 * Distance in a frame where all three axes share one unit. Image landmarks
 * are normalised per axis - x by the frame's width, y by its height - so on a
 * 4:3 camera a raw 2D distance stretches anything horizontal by a third.
 * MediaPipe gives z on the same scale as x.
 */
function distance3(a: Landmark, b: Landmark, aspect: number): number {
  const dx = (a.x - b.x) * aspect;
  const dy = a.y - b.y;
  const dz = (a.z - b.z) * aspect;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Reduce one hand's landmarks to a pinch point and a pinch strength.
 *
 * `world` are MediaPipe's world landmarks: the same 21 points in metres,
 * centred on the hand. When present they decide the pinch, because a 3D
 * distance does not collapse when the hand turns edge-on to the camera - seen
 * from the side, an open thumb and index overlap on screen and a 2D measure
 * reads them as pinched. Image landmarks still give the POSITION.
 */
export function readHand(
  landmarks: Landmark[],
  world?: Landmark[] | null,
  /** Frame width over height, for the image-landmark fallback. */
  aspect = 1,
): HandReading | null {
  if (!landmarks || landmarks.length <= MIDDLE_MCP) return null;

  const thumb = landmarks[THUMB_TIP];
  const index = landmarks[INDEX_TIP];

  const useWorld = !!world && world.length > MIDDLE_MCP;
  const src = useWorld ? world! : landmarks;
  const a = useWorld ? 1 : aspect;
  const span = (p: Landmark, q: Landmark) =>
    useWorld || aspect !== 1 ? distance3(p, q, a) : distance(p, q);

  const scale = span(src[WRIST], src[MIDDLE_MCP]);
  // A degenerate hand (edge of frame, occluded) reports a near-zero span and
  // would divide out to an infinite pinch. World landmarks are in metres, so
  // their floor is a millimetre rather than a thousandth of the frame.
  if (scale < 1e-3) return null;

  const ratio = span(src[THUMB_TIP], src[INDEX_TIP]) / scale;
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
