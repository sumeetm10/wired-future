/**
 * Engineering material data — plain numbers, zero imports.
 *
 * This file exists specifically so the WebMCP tool layer can quote densities
 * and unit conversions WITHOUT importing scene/part-ops.ts, which imports
 * three.js. tools.ts is reachable from the first render, so an import chain
 * from it into three drags the whole 3D engine into the initial bundle instead
 * of the lazy chunk it belongs in.
 */

import type { PartMaterialId } from '@/store/use-wired';

export interface PartMaterialSpec {
  label: string;
  /** kg per cubic metre. */
  density: number;
  color: number;
  roughness: number;
  metalness: number;
}

export const PART_MATERIALS: Record<PartMaterialId, PartMaterialSpec> = {
  steel: { label: 'Mild steel', density: 7850, color: 0x8f9299, roughness: 0.42, metalness: 0.95 },
  aluminium: { label: 'Aluminium 6061', density: 2700, color: 0xc6ccd4, roughness: 0.34, metalness: 0.92 },
  titanium: { label: 'Titanium Ti-6Al-4V', density: 4430, color: 0x9aa3ad, roughness: 0.38, metalness: 0.9 },
  carbon: { label: 'Carbon fibre', density: 1600, color: 0x1b1e25, roughness: 0.32, metalness: 0.15 },
  abs: { label: 'ABS plastic', density: 1040, color: 0xd9dde4, roughness: 0.78, metalness: 0.02 },
  glass: { label: 'Soda-lime glass', density: 2500, color: 0x9fd8e8, roughness: 0.06, metalness: 0.0 },
  rubber: { label: 'Tyre rubber', density: 1100, color: 0x15171c, roughness: 0.95, metalness: 0.0 },
};

/**
 * The car is normalised to 5.2 model units long. A concept car of this class is
 * about 4.6 m, so this is the factor that turns model units into metres. Every
 * mass figure downstream rests on that assumption and says so.
 */
export const MODEL_UNITS_TO_METRES = 4.6 / 5.2;
