/**
 * Wired Future — the One Euro filter (Casiez, Roussel and Vogel, CHI 2012).
 *
 * A hand cursor has two jobs that a plain moving average cannot do at once:
 * hold still when the hand holds still (webcam landmarks jitter by a few
 * pixels every frame), and keep up when the hand moves fast. This filter
 * adapts its cutoff to the measured speed - heavy smoothing at rest, almost
 * none in a fast sweep - so aiming at a door handle is steady and swinging
 * the door open does not trail behind the hand.
 */

const TWO_PI = Math.PI * 2;

function alpha(dtSeconds: number, cutoffHz: number): number {
  const tau = 1 / (TWO_PI * cutoffHz);
  return 1 / (1 + tau / dtSeconds);
}

export interface OneEuroOptions {
  /** Cutoff at rest, in Hz. Lower = steadier when still, but laggier. */
  minCutoff: number;
  /** How fast the cutoff rises with speed. Higher = less lag in fast moves. */
  beta: number;
  /** Cutoff for the speed estimate itself, in Hz. */
  dCutoff: number;
}

export class OneEuroFilter {
  private value: number | null = null;
  private speed = 0;
  private lastMs: number | null = null;

  constructor(private readonly options: OneEuroOptions) {}

  /** Filter one sample taken at `nowMs`. The first sample passes through. */
  filter(sample: number, nowMs: number): number {
    if (this.value === null || this.lastMs === null) {
      this.value = sample;
      this.speed = 0;
      this.lastMs = nowMs;
      return sample;
    }
    // Two samples with the same timestamp would divide by zero; a camera can
    // hand over the same frame twice when the page stalls.
    const dt = Math.max(1e-3, (nowMs - this.lastMs) / 1000);
    this.lastMs = nowMs;

    const rawSpeed = (sample - this.value) / dt;
    this.speed += alpha(dt, this.options.dCutoff) * (rawSpeed - this.speed);

    const cutoff = this.options.minCutoff + this.options.beta * Math.abs(this.speed);
    this.value += alpha(dt, cutoff) * (sample - this.value);
    return this.value;
  }

  reset(): void {
    this.value = null;
    this.speed = 0;
    this.lastMs = null;
  }
}
