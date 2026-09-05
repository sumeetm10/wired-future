## Inspiration

Most "AI-powered" websites bolt a chat box onto the corner and let a model guess which
button to click. The model reads pixels or scrapes the DOM, and breaks the moment you
move a div.

WebMCP flips that. A page can hand an agent a typed contract instead: here are my tools,
here is what each argument means, call them. I wanted to find out what a site looks like
when you design for that from the first line, rather than retrofitting it.

So Wired Future has one rule: there is exactly one place scene state can change, and
both the human and the agent go through it.

## What it does

Wired Future is a 3D design canvas where you and an AI agent work the same screen at the
same time. Twenty tools are registered on `document.modelContext`.

**One reducer, two interfaces**

The human controls and the agent's `execute()` handlers call the same zustand reducer.
Three things fall out of that for free:

- Recolour the grid from ChatGPT and the human's colour picker moves to match. Nobody
  wrote that sync. The picker is a pure function of the store.
- Every change is attributed. The trace prints `[HUMAN]` or `[AGENT]` on each line, so
  you watch the collaboration happen.
- The fallback console runs the shipped handlers, not a mock.

**A real car, taken apart**

The stage holds the Khronos CarConcept glTF. It ships as 97 named mesh nodes, which
split into 109 addressable meshes: door handles, wing mirrors, wipers, brake discs,
steering wheel spokes, pedals. Each sits on its own pivot inside its assembly's pivot.

Hold Ctrl over any part and:

- **Click** runs what that part does. Doors swing on hinges derived from their own
  bounding boxes, the hood lifts from its rear edge, and anything without a hinge pops
  off and back on.
- **Drag** pulls the part out along its own outward axis, following your mouse.
- **Scroll** resizes it.

A "3D print" finish strips the paint and glass to matte resin so you can read the
geometry. An explode slider fans all thirteen assemblies into a parts diagram and back.

**Parts measured with real geometry**

`inspect_car_part` walks the actual triangles. Surface area from the cross products,
volume from the signed tetrahedron sum, an area-weighted centroid, and a watertight
check that every edge is shared by exactly two triangles.

Mass is a shell model: surface area times wall thickness times density. That detail cost
me an hour and I am glad it did. My first version treated the volume a wheel's surface
encloses as solid steel and reported 771 kg. Car parts are pressings and castings, not
billets. As a 5 mm aluminium shell the same wheel comes out at 34.9 kg, which is roughly
what an alloy wheel and tyre weigh. The tool now reports the method, the wall thickness
and the 4.6 m length assumption alongside the number instead of hiding them.

`modify_car_part` then rewrites vertices: per-axis scale about the part's own centre,
offset along vertex normals to thicken a shell, progressive twist, and re-specification
in steel, aluminium, titanium, carbon fibre, ABS, glass or rubber at real densities.
Edits rebuild from the pristine buffers, so sending `scaleX: 1.2` twice leaves the part
at 1.2 rather than 1.44.

An agent can measure the hood, tell you it is 18 kg in 1 mm aluminium, and re-spec it in
carbon fibre at 11 kg, with the geometry on screen changing to match.

**Hands on the glass**

Turn the camera on and the car answers to your hands. MediaPipe's hand
landmarker runs in the tab, and two gestures survive a noisy webcam: pinch one
hand and the car follows it across the stage, pinch both and pull them apart to
explode it into its assemblies.

Pinch is measured as a ratio of hand size rather than a raw distance, so it
reads the same at arm's length as up close, and the engage and release
thresholds differ so a hand hovering at the boundary does not chatter. Gestures
land in the same reducer as everything else, tagged [HAND] in the trace, so the
sliders move as you pinch. The video is never uploaded, and stopping the camera
releases the device.

**Photo to 3D, with no server**

Drop a photo of an object and it becomes a closed 3D shape on the stage: the depth
map is cut from its background, domed to the height its silhouette implies, and
mirrored for a back face, so a ball comes out a ball. Depth Anything V2
Small runs in the browser tab through transformers.js, on WebGPU where available. A CLIP
zero-shot pass declines people and animals before any geometry is built.

No upload, no API key, no backend. The weights stream once from the HuggingFace CDN and
the browser caches them.

## How I built it

Next.js 15 static export, three.js, zustand, TypeScript. It deploys to GitHub Pages as
flat files.

The architecture is one diagram:

```
human UI event ──┐
                 ├──> useWired.getState().apply(patch, origin)
agent execute() ─┘              │
                                ├──> React re-renders the panel
                                ├──> engine.apply(state)   (three.js mutates)
                                └──> log({ origin, message })
```

React never imports three. The engine never imports React. The store is the only bridge,
and because it lives outside React, an `execute()` callback reaches it with no context
plumbing.

## Challenges

**The API had moved and I had not noticed.** I coded against `navigator.modelContext`
from the spec draft. On 21 July 2026 it moved to `document.modelContext`. My detection
would have missed a conforming runtime entirely. It now probes both and uses whichever
carries `registerTool`, and `document` is the one Chrome actually exposes, so without
that fix none of this would work.

**The origin trial token shipped in a form Chrome ignores.** WebMCP runs as an origin
trial through Chrome 156, so production traffic needs a token. Next's `metadata.other`
API emits `<meta name="origin-trial">`. Chrome only reads `http-equiv`. The token was
live, looked correct in view-source, and did nothing. I render the tag directly now.

**The flag route is a dead end, and I measured it.** On Chrome 152.0.7977.75 and Edge
152.0.4191.53, with `WebMCP` and `DevToolsWebMCPSupport` both confirmed in the launch
command line, neither surface was exposed. The README records that so nobody repeats the
investigation.

**A bug in three.js r0.169.** `TransformControls.dispose()` calls `this.traverse(...)`,
but in r169 the class extends `Controls`, not `Object3D`. It always throws. Under React
StrictMode that killed my teardown mid-way, so the renderer was never released and the
next mount came up with a dead canvas. I call `detach()` and `disconnect()` and free the
gizmo geometry myself.

**Parts walked off screen when you dragged a slider.** Deformations rebuild from the
pristine geometry, so they must be centred on the pristine centre. I was re-measuring the
live bounding box, which is the centre of the already-deformed part, so every slider tick
translated it a little further. Each assembly now caches its rest centre in its pivot's
local space, which stays correct while the part is exploded or the door is open.

**The page froze mid-drag.** Every pointermove wrote to the store, re-rendering a 109-row
list and re-running the rig sync each frame. Gestures now mutate the scene directly and
commit once, on release. A twelve-move drag went from locking up to 57 ms.

## Accomplishments

**The bridge is verified, not assumed.** Chrome accepts the registration, `getTools()`
returns all twenty, and `executeTool` runs them:

```js
executeTool(tool, JSON.stringify({ doorLeft: 1, doorRight: 1, finish: 'print' }))
→ "rig 3D-print finish / left door 100% / right door 100%"
```

Register, enumerate, invoke, scene changes, UI mirrors, trace attributes it to the agent.
The whole loop, through a real browser implementation.

**The terrain runs 8.5× faster.** Every wave term has the form sin(kx + ωt), which expands
to sin(kx)cos(ωt) + cos(kx)sin(ωt). The spatial halves are constant per vertex. That took
the loop from 61,605 transcendental calls per frame to 8, and 2.48 ms to 0.29 ms. I checked
the algebra against the direct form over 200,000 random samples before trusting it:
maximum difference 1e-13.

## What I learned

Tool descriptions are the interface. An agent picks a tool from its name, description and
schema alone, so "scale, 0.2 to 3" is a worse contract than "scale across the car, 0.2 to 3,
where 1 is untouched." I spent longer writing those strings than writing some of the tools.

Read-only tools matter more than they look. An agent that can only write is guessing.
`get_wired_future_state`, `inspect_car_part` and `list_car_parts` let it look before it
leaps, and the difference in behaviour is obvious.

And the honest one: I claimed several things worked before I had watched them work. The
mass model, the bounding boxes, the origin trial. Each time, checking found something
wrong. The 771 kg wheel would have shipped.

## What's next

Multiplayer, so two people and an agent share a canvas. Persisting a design as a shareable
URL. And `capture_scene_snapshot` already returns the canvas as an MCP image block, which
means an agent can see what it built. The obvious next step is letting it critique its own
work and iterate.

## Credits

CarConcept from [KhronosGroup/glTF-Sample-Assets](https://github.com/KhronosGroup/glTF-Sample-Assets),
by Eric Chadwick from a public-domain model, licensed CC BY 4.0, attribution to Darmstadt
Graphics Group GmbH.

Fonts: Chakra Petch and JetBrains Mono, SIL Open Font License, self-hosted at build time.
