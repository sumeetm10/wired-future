/**
 * Wired Future — the hologram stage.
 *
 * Replaces the rippling wireframe landscape. That landscape rewrote 12,321
 * vertices every frame on the CPU and re-uploaded them; this stage is one
 * flat quad whose rings, ticks and grid are drawn by a fragment shader, so a
 * frame costs two uniform writes and one draw call.
 *
 * The old wave controls keep working with new jobs, so agents and saved
 * presets still mean something:
 *   waveVelocity  -> how fast the rings turn (0 holds them still)
 *   waveAmplitude -> how brightly the stage glows (0 nearly dark)
 */

import * as THREE from 'three';

const STAGE_SIZE = 90;
const STAGE_Y = 0;

const VERTEX = /* glsl */ `
varying vec2 vPos;
void main() {
  vPos = position.xy;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FRAGMENT = /* glsl */ `
uniform vec3 uColor;
uniform float uTime;
uniform float uGlow;
varying vec2 vPos;

// Anti-aliased line of width w (in world units) at distance d.
float line(float d, float w) {
  float aa = fwidth(d) * 1.2;
  return 1.0 - smoothstep(w - aa, w + aa, abs(d));
}

void main() {
  // Ring radii below are authored for a 1.35x larger car; scale them to fit.
  float r = length(vPos) * 1.35;
  float a = atan(vPos.y, vPos.x);
  float glow = uGlow;

  // Concentric platform rings under the car.
  float rings = 0.0;
  rings += line(r - 3.6, 0.05) * 1.0;
  rings += line(r - 4.3, 0.025) * 0.7;
  rings += line(r - 5.4, 0.04) * 0.9;
  rings += line(r - 6.8, 0.02) * 0.5;

  // Dashed rings that turn in opposite directions.
  float dashA = step(0.5, fract((a + uTime * 0.35) * 24.0 / 6.2831853));
  float dashB = step(0.35, fract((a - uTime * 0.22) * 60.0 / 6.2831853));
  rings += line(r - 4.0, 0.06) * dashA * 0.8;
  rings += line(r - 6.1, 0.04) * dashB * 0.6;

  // Radial tick marks around the outer ring.
  float ticks = line(fract(a * 72.0 / 6.2831853) - 0.5, 0.06) * step(5.6, r) * step(r, 5.9);

  // A soft disc of light the car stands in.
  float disc = smoothstep(4.8, 0.0, r) * 0.18;

  // A faint floor grid that fades into the dark.
  vec2 g = abs(fract(vPos * 0.5) - 0.5);
  float grid = (1.0 - smoothstep(0.0, fwidth(vPos.x) * 1.5 + 0.01, min(g.x, g.y))) * 0.18;
  grid *= smoothstep(38.0, 8.0, r);

  // A slow pulse sweeping outward through the rings.
  float sweep = smoothstep(0.35, 0.0, abs(r - mod(uTime * 2.2, 12.0))) * 0.35 * step(r, 7.5);

  float fade = smoothstep(42.0, 6.0, r);
  float a1 = (rings + ticks) * 0.9 + disc + grid + sweep;
  gl_FragColor = vec4(uColor * a1 * glow, clamp(a1 * glow, 0.0, 1.0) * fade);
}
`;

export class Terrain {
  readonly mesh: THREE.Mesh;

  private readonly geometry: THREE.PlaneGeometry;
  private readonly material: THREE.ShaderMaterial;
  private spin = 0;
  private lastElapsed = 0;

  constructor(colorHex = '#00f0ff') {
    this.geometry = new THREE.PlaneGeometry(STAGE_SIZE, STAGE_SIZE, 1, 1);
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(colorHex) },
        uTime: { value: 0 },
        uGlow: { value: 1 },
      },
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.name = 'wired-holo-stage';
    this.mesh.rotation.x = -Math.PI / 2;
    this.mesh.position.y = STAGE_Y;
    // Never pickable: clicks pass through to the car or to empty space.
    this.mesh.raycast = () => {};
    this.mesh.renderOrder = -1;
  }

  get object3d(): THREE.Object3D {
    return this.mesh;
  }

  setColor(hex: string): void {
    (this.material.uniforms.uColor.value as THREE.Color).set(hex);
  }

  /** Was wave height; now the stage's brightness (0..4, 1 = default). */
  setAmplitude(value: number): void {
    if (!Number.isFinite(value)) return;
    this.material.uniforms.uGlow.value = 0.15 + Math.min(4, Math.max(0, value)) * 0.85;
  }

  /** Was wave speed; now how fast the rings turn. */
  update(elapsed: number, velocity: number): void {
    const dt = Math.min(0.1, Math.max(0, elapsed - this.lastElapsed));
    this.lastElapsed = elapsed;
    this.spin += dt * Math.max(0, velocity);
    this.material.uniforms.uTime.value = this.spin;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}

export function createTerrain(colorHex = '#00f0ff'): Terrain {
  return new Terrain(colorHex);
}
