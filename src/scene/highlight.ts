/**
 * Wired Future — part highlighting.
 *
 * A highlight is an OVERLAY, not a material change. Every part already has a
 * material that something else owns: the asset, the 3D-print finish, an
 * agent's "make the hood carbon fibre". Tinting those would need save/restore
 * bookkeeping that three separate systems would have to agree on. Instead each
 * highlighted mesh gets a child mesh sharing its geometry, drawn additively on
 * top with a view-dependent rim, and removing the highlight removes the child.
 *
 * Sharing the geometry means the overlay follows reshaping edits for free and
 * costs no memory; it costs one extra draw call per highlighted mesh.
 */

import * as THREE from 'three';

const VERTEX = /* glsl */ `
varying vec3 vNormalView;
varying vec3 vViewDir;

void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vec3 n = normalMatrix * normal;
  // A geometry without normals reads (0,0,0); fall back to facing the viewer
  // rather than normalising a zero vector into NaN.
  vNormalView = length(n) > 0.0001 ? normalize(n) : vec3(0.0, 0.0, 1.0);
  vViewDir = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}
`;

const FRAGMENT = /* glsl */ `
uniform vec3 uColor;
uniform float uBase;
uniform float uRim;
uniform float uOpacity;

varying vec3 vNormalView;
varying vec3 vViewDir;

void main() {
  float facing = abs(dot(normalize(vNormalView), normalize(vViewDir)));
  float rim = pow(1.0 - facing, 2.4);
  float a = clamp((uBase + uRim * rim) * uOpacity, 0.0, 1.0);
  gl_FragColor = vec4(uColor, a);
}
`;

export interface HighlightStyle {
  color: string;
  /** Flat glow across the whole surface. */
  base: number;
  /** Extra glow at grazing angles, which is what outlines the silhouette. */
  rim: number;
  /** Amplitude of the slow breathing pulse; 0 for none. */
  pulse: number;
}

/** Rate the overlay fades in and out, per second. */
const FADE_RATE = 14;

export class HighlightLayer {
  private readonly material: THREE.ShaderMaterial;
  private overlays: THREE.Mesh[] = [];
  private key: string | null = null;
  private opacity = 0;
  private targetOpacity = 0;
  private intensity = 1;
  private readonly pulse: number;
  private hiddenForCapture = false;

  constructor(style: HighlightStyle) {
    this.pulse = style.pulse;
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(style.color) },
        uBase: { value: style.base },
        uRim: { value: style.rim },
        uOpacity: { value: 0 },
      },
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      // Coplanar with the part it sits on: pull it towards the camera so it
      // wins the depth test instead of flickering against the surface.
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -2,
      fog: false,
    });
  }

  /** Highlight these meshes. The same key twice is a no-op, so call freely. */
  show(key: string, meshes: THREE.Mesh[]): void {
    if (key === this.key && this.overlays.length) {
      this.targetOpacity = 1;
      return;
    }
    this.detach();
    this.key = key;
    for (const mesh of meshes) {
      if (!mesh.geometry) continue;
      const overlay = new THREE.Mesh(mesh.geometry, this.material);
      overlay.name = 'wf-highlight';
      // Never pickable: a highlight must not stand between the pointer and
      // the part it is highlighting.
      overlay.raycast = () => {};
      overlay.renderOrder = 5;
      overlay.frustumCulled = mesh.frustumCulled;
      overlay.visible = !this.hiddenForCapture;
      mesh.add(overlay);
      this.overlays.push(overlay);
    }
    // Fade in from nothing, so moving across parts shimmers rather than blinks.
    this.opacity = 0;
    this.targetOpacity = 1;
  }

  /** Fade out, then drop the overlays. */
  clear(): void {
    this.targetOpacity = 0;
    this.key = null;
  }

  /** Remove immediately, e.g. before the meshes themselves are disposed. */
  reset(): void {
    this.detach();
    this.key = null;
    this.opacity = 0;
    this.targetOpacity = 0;
  }

  get activeKey(): string | null {
    return this.key;
  }

  setColor(color: THREE.Color | string): void {
    (this.material.uniforms.uColor.value as THREE.Color).set(color);
  }

  /** 1 is full strength; lower for a quieter state of the same highlight. */
  setIntensity(value: number): void {
    this.intensity = value;
  }

  /** Snapshots are for the agent to judge the design, not the UI chrome. */
  setCaptureHidden(hidden: boolean): void {
    this.hiddenForCapture = hidden;
    for (const overlay of this.overlays) overlay.visible = !hidden;
  }

  update(dt: number, elapsed: number): void {
    if (!this.overlays.length) return;
    const k = 1 - Math.exp(-dt * FADE_RATE);
    this.opacity += (this.targetOpacity - this.opacity) * k;
    if (this.targetOpacity === 0 && this.opacity < 0.01) {
      this.detach();
      this.opacity = 0;
      return;
    }
    const breathe = this.pulse > 0 ? 1 - this.pulse * (0.5 + 0.5 * Math.sin(elapsed * 3.2)) : 1;
    this.material.uniforms.uOpacity.value = this.opacity * this.intensity * breathe;
  }

  dispose(): void {
    this.detach();
    this.material.dispose();
  }

  private detach(): void {
    for (const overlay of this.overlays) overlay.removeFromParent();
    this.overlays = [];
  }
}
