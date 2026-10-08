/**
 * Wired Future — the hologram finish.
 *
 * A projected-light look: every part is a faint translucent shell that glows
 * at its silhouette, crossed by drifting scan lines, with its hard edges
 * traced in bright lines. One shared shader material for every surface and one
 * shared line material for every edge, so the whole car costs two programs.
 *
 * Edge lines are computed per mesh with EdgesGeometry (only creases sharper
 * than EDGE_ANGLE, so a smooth door panel is not hatched with every triangle)
 * and built in idle slices after the car loads: the body shell alone is
 * tens of thousands of triangles and doing every mesh at once froze the page.
 */

import * as THREE from 'three';

/** Crease angle, in degrees, above which an edge is drawn. */
const EDGE_ANGLE = 28;

const VERTEX = /* glsl */ `
varying vec3 vNormalView;
varying vec3 vViewDir;
varying float vWorldY;
void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vec4 mv = viewMatrix * world;
  vec3 n = normalMatrix * normal;
  vNormalView = length(n) > 0.0001 ? normalize(n) : vec3(0.0, 0.0, 1.0);
  vViewDir = normalize(-mv.xyz);
  vWorldY = world.y;
  gl_Position = projectionMatrix * mv;
}
`;

const FRAGMENT = /* glsl */ `
uniform vec3 uColor;
uniform float uTime;
uniform float uOpacity;
varying vec3 vNormalView;
varying vec3 vViewDir;
varying float vWorldY;
void main() {
  float facing = abs(dot(normalize(vNormalView), normalize(vViewDir)));
  float rim = pow(1.0 - facing, 2.2);
  float scan = 0.5 + 0.5 * sin(vWorldY * 38.0 - uTime * 4.0);
  float band = smoothstep(0.92, 1.0, fract(vWorldY * 0.35 - uTime * 0.18));
  float a = (0.018 + rim * 0.42 + scan * 0.025 + band * 0.18) * uOpacity;
  gl_FragColor = vec4(uColor * (0.6 + rim * 0.9), a);
}
`;

export interface Hologram {
  surface: THREE.ShaderMaterial;
  lines: THREE.LineBasicMaterial;
  setColor: (hex: string) => void;
  update: (elapsed: number) => void;
  /** Edge lines for one mesh, built once and cached; null for degenerate meshes. */
  edgesFor: (mesh: THREE.Mesh) => THREE.LineSegments | null;
  /** Forget a mesh's edges, e.g. after its geometry was reshaped. */
  dropEdges: (mesh: THREE.Mesh) => void;
  dispose: () => void;
}

export function createHologram(colorHex = '#00f0ff'): Hologram {
  const color = new THREE.Color(colorHex);

  const surface = new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: color.clone() },
      uTime: { value: 0 },
      uOpacity: { value: 1 },
    },
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.FrontSide,
  });

  const lines = new THREE.LineBasicMaterial({
    color: color.clone(),
    transparent: true,
    opacity: 0.75,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  const edges = new Map<THREE.Mesh, THREE.LineSegments>();

  const edgesFor = (mesh: THREE.Mesh): THREE.LineSegments | null => {
    const cached = edges.get(mesh);
    if (cached) return cached;
    const geometry = mesh.geometry as THREE.BufferGeometry | undefined;
    if (!geometry || !geometry.getAttribute('position')) return null;
    let edgeGeometry: THREE.EdgesGeometry;
    try {
      edgeGeometry = new THREE.EdgesGeometry(geometry, EDGE_ANGLE);
    } catch {
      return null;
    }
    const segments = new THREE.LineSegments(edgeGeometry, lines);
    segments.name = 'wf-holo-edges';
    // Lines never take the pointer: picking stays on the part's surface.
    segments.raycast = () => {};
    segments.renderOrder = 2;
    edges.set(mesh, segments);
    return segments;
  };

  const dropEdges = (mesh: THREE.Mesh): void => {
    const segments = edges.get(mesh);
    if (!segments) return;
    segments.removeFromParent();
    segments.geometry.dispose();
    edges.delete(mesh);
  };

  return {
    surface,
    lines,
    setColor: (hex) => {
      color.set(hex);
      (surface.uniforms.uColor.value as THREE.Color).copy(color);
      lines.color.copy(color);
    },
    update: (elapsed) => {
      surface.uniforms.uTime.value = elapsed;
    },
    edgesFor,
    dropEdges,
    dispose: () => {
      for (const mesh of Array.from(edges.keys())) dropEdges(mesh);
      surface.dispose();
      lines.dispose();
    },
  };
}
