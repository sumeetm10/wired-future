'use client';

import { useEffect, useRef } from 'react';
import type { WiredEngine } from '@/scene/contract';
import { useWired } from '@/store/use-wired';

interface SceneCanvasProps {
  /** Called with the live engine once mounted, and with null on teardown. */
  onReady: (engine: WiredEngine | null) => void;
}

/**
 * The only component that talks to Three.js, and it does so through a dynamic
 * import inside an effect. That import is what keeps `three` out of the server
 * bundle entirely during `output: 'export'` prerendering — no next/dynamic
 * wrapper needed, and no chance of a window reference at module scope firing
 * during the build.
 */
export default function SceneCanvas({ onReady }: SceneCanvasProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let disposed = false;
    let engine: WiredEngine | null = null;
    let unsubscribe: (() => void) | undefined;

    void (async () => {
      try {
        const { createWiredEngine } = await import('@/scene/engine');
        if (disposed || !hostRef.current) return;

        engine = createWiredEngine();
        engine.mount(hostRef.current);

        const store = useWired.getState();
        engine.apply(store.snapshot());
        store.log('system', 'render surface online');

        // The drag gizmo writes through the same reducer as everything else,
        // so a human dragging the car is indistinguishable — to the rest of the
        // app and to the agent — from a tool call that placed it. `settled` is
        // false for every pointer-move, which keeps the trace to one line per
        // drag instead of one per frame.
        engine.onTransformChange((next, settled) => {
          if (disposed) return;
          useWired.getState().setTransform(next, 'human', !settled);
        });

        onReady(engine);

        let lastPulseToken = store.pulseToken;

        // One subscription drives everything. Whether the patch came from a
        // human click or an agent tool call is irrelevant here by design.
        unsubscribe = useWired.subscribe((next) => {
          if (disposed || !engine) return;
          engine.apply(next);
          if (next.pulseToken !== lastPulseToken) {
            lastPulseToken = next.pulseToken;
            engine.pulse(next.pulseIntensity, next.pulseDurationMs);
          }
        });
      } catch (err) {
        // WebGL can be unavailable (blocklisted GPU, hardware acceleration off,
        // some in-app browsers) and the chunk import can fail on a flaky link.
        // Without this the rejection is swallowed by `void` and the page looks
        // healthy while every control is a silent no-op.
        const detail = err instanceof Error ? err.message : String(err);
        useWired
          .getState()
          .log(
            'system',
            'render surface failed to start (' +
              detail +
              ') - the 3D canvas is unavailable, but the controls and tool calls still run.',
          );
        onReady(null);
      }
    })();

    return () => {
      disposed = true;
      unsubscribe?.();
      onReady(null);
      engine?.dispose();
      engine = null;
    };
  }, [onReady]);

  return (
    <div
      ref={hostRef}
      aria-hidden="true"
      style={{ position: 'fixed', inset: 0, zIndex: 0 }}
    />
  );
}
