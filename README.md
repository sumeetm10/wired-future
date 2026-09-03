# Wired Future

An agent-native 3D creative canvas. A human and an AI agent drive the **same screen**, through
the **same code path**, at the same time.

Built for the [OpenAI WebMCP Challenge](https://webmcp.devpost.com/).

---

## The idea: one action, two interfaces

Most "AI-powered" apps bolt a chat box onto a UI and let the model pretend to click things.
Wired Future does the opposite. There is exactly one place where scene state can change:

```
human UI event ──┐
                 ├──> useWired.getState().apply(patch, origin)
agent execute() ─┘              │
                                ├──> React re-renders the control panel
                                ├──> engine.apply(state)   (Three.js mutates)
                                └──> log({ origin, message })  (status bar)
```

Consequences that fall out of this for free:

- When the agent recolours the grid, the human's colour picker **moves to match**. Nobody wrote
  sync code — the picker is a pure function of the store.
- Every action is attributed. The status bar prints `[HUMAN]` or `[AGENT]` on each line, so you
  can watch the collaboration happen.
- The "Agent Simulator" panel calls the **real** `execute()` handlers. It is not a mock. What you
  see without a WebMCP runtime is the same code an agent runs with one.

React never imports Three.js. The engine never imports React. The zustand store is the only bridge.

---

## Where the model lives

Nowhere in this repo, and that is the point.

WebMCP inverts the usual arrangement: the page does not call a model, the page
*exposes tools* and the user's own agent calls them. The model runs in ChatGPT, on the
user's account. This site holds no API key, makes no completion request, and could not
leak a credential if it wanted to — it is a static export.

The plain-English box in the simulator is a deterministic parser (`src/webmcp/intent.ts`),
not an LLM. It is scaffolding for browsers without a WebMCP runtime, not the product.

## Tools exposed to the agent

Registered via `navigator.modelContext.registerTool()` (W3C WebMCP draft, April 2026 revision —
`provideContext()` / `clearContext()` were removed in March 2026).

| Tool | What it does |
|---|---|
| `get_wired_future_state` | Read-only. Full scene state plus a natural-language description, so the agent can look before it leaps. |
| `modify_wired_future_environment` | The headline tool. `gridColorHex`, `modelType`, `waveVelocity`. |
| `pulse_reality_wave` | Transient shockwave — spikes terrain velocity and light intensity, then eases back. |
| `set_camera_view` | `preset` / `distance` / `height` / `autoOrbit`. |
| `configure_node_cluster` | Count, spread, float speed and colour of the floating neon nodes. |
| `apply_scene_preset` | `neon-noir`, `solar-flare`, `deep-void`, `hologram`. One call, whole world flips. |
| `capture_scene_snapshot` | Returns the live canvas as an MCP **image content block** — the agent can see what it just built. |
| `reset_wired_future` | Restore every parameter to defaults. The same Reset control the human has — no preset reproduces it. |
| `place_object` | Move / turn / resize the hero object in world units. The same placement the drag gizmo produces. |
| `set_edit_mode` | Changes what the human's mouse does: orbit the camera, or arm a move / rotate / scale gizmo. |
| `set_car_body` | Swap between the real glTF concept car and the parametric one. |
| `reconstruct_photo_object` | Inspect, show or clear the photo reconstruction. The agent cannot upload, so it asks the person to drop one. |
| `configure_car_rig` | Finish (painted / 3D-print), explode 0-1, and door + hood angles on their real hinges. |
| `set_car_parts` | Detach or refit assemblies: take the wheels off, drop the body shell to expose the interior. |
| `inspect_car_part` | Measures a part from its actual triangles: area, volume, bbox, watertightness, mass in each material. |
| `modify_car_part` | Rewrites the part's vertices: per-axis scale, normal-offset thickening, twist, and material re-spec. |

Every `execute()` returns MCP content blocks plus `structuredContent` carrying the resulting
state, so the agent stays grounded across turns.

---

## Taking the car apart

The CarConcept glTF ships as **97 separately named mesh nodes**, so this is real
articulation rather than a canned animation. On load they are re-parented into
thirteen assemblies — body, both doors, hood, roof, glass, interior, engine, lights
and four wheels — each on its own pivot.

- **3D-print finish** swaps every material for one matte resin grey, glass included.
  It is how you actually read the geometry of a model whose paint does the heavy lifting.
- **Explode** fans each assembly out along its own axis into a parts diagram, and back.
- **Doors and hood** swing on hinges derived from their own bounding boxes — the door
  pivots on its front vertical edge, the hood on its rear edge.
- **Parts detach and refit** individually.

### Editing a part with real geometry

`inspect_car_part` measures the actual triangles:

| Quantity | Method |
|---|---|
| Surface area | `Σ ‖(b−a) × (c−a)‖ / 2` over every triangle |
| Volume | signed tetrahedron sum, `a · (b × c) / 6` |
| Centroid | area-weighted mean of triangle centroids |
| Watertight | every edge shared by exactly two triangles |
| Mass | **shell model**: `surface area × wall thickness × density` |

The mass model matters. Car parts are pressings and castings, not solid billets —
treating the volume a wheel's surface encloses as solid steel gives 771 kg. As a 5 mm
aluminium shell the same wheel comes out at 35 kg, which is what an alloy wheel and
tyre actually weigh. The method, the wall thickness and the 4.6 m length assumption are
all reported alongside the number rather than hidden behind it.

`modify_car_part` then rewrites the vertices: per-axis scale about the part's own
centre, offset along vertex normals to thicken a shell, progressive twist about the
vertical axis, and re-specification in steel, aluminium, titanium, carbon fibre, ABS,
glass or rubber (real densities). Edits are **absolute and rebuilt from the pristine
geometry**, so sending `scaleX: 1.2` twice leaves the part at 1.2, not 1.44, and reset
returns it exactly to the shipped part.

So an agent can measure the hood, tell you it is 18 kg in 1 mm aluminium, and re-spec
it in carbon fibre at 11 kg — with the geometry on screen changing to match.

---

## Photo to 3D

Drop a photo of an object onto the Photo to 3D panel and it is rebuilt as relief
geometry on the stage.

This runs **entirely in the browser**. There is no server, no API key and no upload:

- **Depth** comes from [Depth Anything V2 Small](https://huggingface.co/onnx-community/depth-anything-v2-small)
  (24.8M params) via transformers.js, on WebGPU where available and WASM otherwise.
- **Subject screening** uses CLIP zero-shot classification. Wired Future reconstructs
  objects; photos of people and animals are declined before any geometry is built.
- Weights stream from the HuggingFace CDN on first use (~50 MB) and are then cached
  by the browser.

An honest limit: monocular depth gives a **2.5D relief**, not a watertight mesh. The
surface facing the camera is real geometry; there is no back face. The mesh is built
to read as a relief sculpture rather than to pretend otherwise.

---

## Editing

- **Orbit** mode flies the camera (OrbitControls).
- **Move / Rotate / Scale** arm a drag gizmo on the object (TransformControls).

The gizmo writes through `setTransform`, the same reducer `place_object` calls. So a
human dragging the car and an agent placing it are indistinguishable to everything
downstream, and the position sliders track a drag live.

---

## Credits

The concept car is **CarConcept** from
[KhronosGroup/glTF-Sample-Assets](https://github.com/KhronosGroup/glTF-Sample-Assets),
by Eric Chadwick from a public-domain model, licensed
**CC BY 4.0 — attribution to Darmstadt Graphics Group GmbH**.

Fonts: Chakra Petch and JetBrains Mono, both SIL Open Font License, self-hosted at
build time by `next/font`.

---

## Running it

```bash
npm install
npm run dev
```

Then open http://localhost:3000.

Production static export:

```bash
npm run build          # emits ./out, prefixed with the /wired-future basePath
```

To smoke-test that export locally, build it without the subpath first — otherwise
every asset 404s when served from a domain root:

```bash
npm run build:local && npm start
```

---

## Seeing the agent side

WebMCP is not on by default in most browsers yet. Three ways to drive the agent interface,
in descending order of realism:

1. **ChatGPT's in-app browser** — native WebMCP support. Open the deployed URL there and ask it
   to change the scene.
2. **Chrome with `#enable-webmcp-testing`** — in principle. Verified NOT working on
   152.0.7977.75 stable: with both `WebMCP` and `DevToolsWebMCPSupport` confirmed in the
   launch command line, `navigator` exposes nothing WebMCP-shaped. The flag is listed but
   inert in that build, so treat it as unavailable rather than as a fallback.
3. **The built-in simulator** — the "Agent Simulator" panel (top right on desktop; on a phone
   it is the sheet below the badge, collapsible with the "Tool Call" chip). Works in any
   browser. It invokes the same `execute()` handlers, so the behaviour is identical.

   Type plainly — *"open both doors"*, *"take the wheels off"*, *"make the hood carbon
   fibre"*, *"how heavy is the hood"* — and it shows you the tool call it produced before
   running it. That translation is a **rule table, not a model**: no API key, nothing
   downloaded. It exists so the page is playable without a WebMCP runtime. With one, the
   translation is ChatGPT's job and it handles phrasing this parser never will.

The badge in the corner tells you which mode you are in.

Things worth asking an agent to do:

- "Look at the canvas, then make it feel like a solar flare."
- "Switch to the quantum engine node, slow the waves right down, and pull the camera in close."
- "Take a snapshot and tell me what you see."

---

## Deploying to GitHub Pages

`.github/workflows/deploy.yml` builds and publishes on every push to `main`. Enable
**Settings → Pages → Source: GitHub Actions** once.

Two details worth knowing:

- **`basePath: '/wired-future'`** in `next.config.mjs` assumes the repo is named
  `wired-future`. If yours is not, change `NEXT_PUBLIC_BASE_PATH` in
  `.github/workflows/deploy.yml` and the production fallback in `next.config.mjs` to match,
  or the deployed page loads with no CSS and no JS. Set it to `""` to host at a domain root.
- **`public/.nojekyll`** is belt-and-braces. The Actions path here uploads `out/` as a Pages
  artifact and never runs Jekyll, so it is not strictly needed — but it matters the moment
  you switch to branch-based publishing, where Jekyll would strip the `_next/` directory.

---

## Layout

```
src/
  app/                     layout, page, globals.css
  scene/
    contract.ts            the WiredEngine interface — the only React/Three boundary
    engine.ts              renderer, camera, lights, RAF loop, pulse, capture
    terrain.ts             wireframe landscape, ripples by mutating the position buffer in place
    models.ts              parametric cyber-car and quantum engine node builders
    car-real.ts            glTF concept car: load, normalise onto the stage, tint
    car-rig.ts             97 nodes -> 13 assemblies with hinges, explode, finishes
    part-ops.ts            real geometry: area, volume, centroid, vertex deformation
    photo-relief.ts        depth grid -> displaced, photo-textured relief mesh
    nodes.ts               seeded floating neon node cluster
  store/
    use-wired.ts           THE reducer. Frozen contract everything else builds against.
  photo/
    pipeline.ts            decode -> screen -> depth -> mesh, all in-browser
    depth.ts               Depth Anything V2 Small via transformers.js
    screen.ts              CLIP zero-shot gate: objects yes, living things no
  webmcp/
    tools.ts               the sixteen tool descriptors
    use-webmcp.ts          feature detection, registration, StrictMode-safe cleanup
    simulate.ts            local agent fallback, routed through the real execute()
  components/panel/        control panel, status bar, agent simulator, runtime badge
  types/webmcp.d.ts        navigator.modelContext typings (not yet in lib.dom)
```

## Performance notes

- The terrain ripple mutates `geometry.attributes.position.array` in place and sets
  `needsUpdate = true`. It never rebuilds `PlaneGeometry`.
- The node cluster shares one `SphereGeometry` and one material across every node, and places
  them with a seeded PRNG so raising the count adds nodes without shuffling the existing ones.
- `engine.apply()` is called on every store change and diffs against a cached previous state, so
  dragging the colour picker does not rebuild the model.
