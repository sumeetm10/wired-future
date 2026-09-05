'use client';

import SpotlightTour, { type TourStep } from './spotlight-tour';

/**
 * Steps in the visual order of the page, so the spotlight walks the screen
 * rather than jumping around it. Each `sel` is an id on the real control it
 * describes; if one is missing the engine skips it.
 *
 * MODULE SCOPE, on purpose. Inline in the component this array would be a
 * new identity every render and loop the presence effect.
 */
const STEPS: TourStep[] = [
  {
    sel: '#tour-badge',
    title: 'Agent bridge',
    body:
      'Twenty tools are registered on document.modelContext. Green means a real agent runtime is attached to this tab; otherwise the simulator on the right stands in.',
  },
  {
    sel: '#tour-stage',
    title: 'The car',
    body:
      'Drag to orbit, scroll to zoom. Hold Ctrl over any part: click to make it act (doors swing, the hood lifts), drag to pull it out, scroll to resize it.',
  },
  {
    sel: '#tour-controls',
    title: 'Control Deck',
    body:
      'Your half. Every slider calls the same reducer the agent’s tools call, so when an agent changes the scene these move on their own.',
  },
  {
    sel: '#tour-agent',
    title: 'Agent Simulator',
    body:
      'The agent’s half. Type plain English like “open both doors” or “wider wheels”, or paste a raw tool call. It runs the same execute() handlers a real agent calls.',
  },
  {
    sel: '#tour-parts',
    title: 'Parts',
    body:
      '109 parts, each addressable by name. Search, select, measure real geometry, or re-spec a hood in carbon fibre.',
  },
  {
    sel: '#tour-hands',
    title: 'Hand control',
    body:
      'Turn the camera on and pinch. One hand drags the car; pinch both hands and pull them apart to explode it. The video never leaves this tab.',
  },
  {
    sel: '#tour-photo',
    title: 'Photo to 3D',
    body:
      'Drop a photo of an object. A depth model runs in this tab, so nothing is uploaded; the front is mirrored to close the back.',
  },
  {
    sel: '#tour-trace',
    title: 'System Trace',
    body:
      'Every change lands here tagged [HUMAN] or [AGENT]. Run something from the simulator and watch the controls follow.',
  },
];

export default function WiredTour() {
  // Panels are SSR’d, but the badge settles its runtime probe and the rig
  // finishes loading in the first second. A short delay lets the first paint
  // stop moving before the ring lands.
  return <SpotlightTour storageKey="wf_tour_v2" steps={STEPS} startDelay={900} />;
}
