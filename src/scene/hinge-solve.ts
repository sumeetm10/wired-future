/**
 * Wired Future — following a hand around a hinge.
 *
 * A held door can only move one way: around its hinge. The point the hand
 * grabbed sweeps an arc as the hinge opens, and the hinge value that puts that
 * point nearest the hand on screen is the one to show. The arc's projection
 * can fold back over itself (look along the hinge and an open door and a shut
 * one land on the same pixels), so the search samples the whole range rather
 * than walking downhill from the last value, and the caller's score carries a
 * small penalty for jumping far from where the door already is.
 *
 * Pure: the caller supplies the score, so this needs no three.js.
 */

/**
 * Minimise `score` over [0, 1]: coarse samples, then a golden-section
 * refinement around the best one. Ties keep the earlier sample.
 */
export function solveArc(score: (t: number) => number, samples = 32): number {
  const n = Math.max(2, Math.floor(samples));
  let bestT = 0;
  let bestScore = Infinity;
  for (let i = 0; i <= n; i += 1) {
    const t = i / n;
    const s = score(t);
    if (s < bestScore) {
      bestScore = s;
      bestT = t;
    }
  }
  if (!Number.isFinite(bestScore)) return NaN;

  // Golden-section search within one sample either side of the winner.
  let lo = Math.max(0, bestT - 1 / n);
  let hi = Math.min(1, bestT + 1 / n);
  const g = (Math.sqrt(5) - 1) / 2;
  let a = hi - g * (hi - lo);
  let b = lo + g * (hi - lo);
  let fa = score(a);
  let fb = score(b);
  for (let k = 0; k < 14; k += 1) {
    if (fa <= fb) {
      hi = b;
      b = a;
      fb = fa;
      a = hi - g * (hi - lo);
      fa = score(a);
    } else {
      lo = a;
      a = b;
      fa = fb;
      b = lo + g * (hi - lo);
      fb = score(b);
    }
  }
  const refined = (lo + hi) / 2;
  return score(refined) <= bestScore ? refined : bestT;
}
