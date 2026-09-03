'use client';

import { useCallback, useRef } from 'react';
import type { WiredEngine } from '@/scene/contract';
import SceneCanvas from '@/components/scene-canvas';
import ControlPanel from '@/components/panel/control-panel';
import McpBadge from '@/components/panel/mcp-badge';
import AgentSimulator from '@/components/panel/agent-simulator';
import PhotoPanel from '@/components/panel/photo-panel';
import SelectionPanel from '@/components/panel/selection-panel';
import StatusBar from '@/components/panel/status-bar';
import WiredTour from '@/components/tours/wired-tour';
import { useWebMcp } from '@/webmcp/use-webmcp';

export default function WiredFutureApp() {
  const engineRef = useRef<WiredEngine | null>(null);

  // Stable identities: SceneCanvas mounts on [onReady], and useWebMcp registers
  // tools on [getEngine]. A fresh closure each render would tear down and
  // re-register the entire tool set on every state change.
  const handleReady = useCallback((engine: WiredEngine | null) => {
    engineRef.current = engine;
  }, []);

  const getEngine = useCallback(() => engineRef.current, []);

  useWebMcp(getEngine);

  return (
    <main>
      <SceneCanvas onReady={handleReady} />

      {/* Atmosphere sits above the canvas and below every panel, so the CRT
          treatment is uniform instead of screen-lightening only the glass. */}
      <div className="wf-vignette" aria-hidden="true" />
      <div className="wf-scanlines" aria-hidden="true" />

      {/* The car is WebGL, so the tour has no DOM node to point at. This
          empty box marks where it sits; nothing else uses it. */}
      <div id="tour-stage" className="wf-stage-mark" aria-hidden="true" />

      <div className="wf-topdock">
        <header className="wf-titlecard">
          <h1 className="wf-title">Wired Future</h1>
          <p className="wf-tagline wf-only-wide-block">
            One action, two interfaces. Every control here and every WebMCP tool
            call hit the same reducer — the trace tags each change [HUMAN] or
            [AGENT].
          </p>
        </header>
        <McpBadge className="wf-badge-inline" />
        {/* Mounted here so the replay chip flows under the badge; the
            overlay itself portals to body. */}
        <WiredTour />
      </div>

      <ControlPanel />
      {/* One column, not two fixed docks. The simulator grows as example
          chips are added and the photo panel grows during a reconstruction,
          so anchoring one to the top and the other to the bottom made them
          collide at exactly the moment both had content. */}
      <div className="wf-rail wf-rail--right">
        <AgentSimulator getEngine={getEngine} />
        <SelectionPanel getEngine={getEngine} />
        <PhotoPanel getEngine={getEngine} />
      </div>
      <StatusBar />
    </main>
  );
}
