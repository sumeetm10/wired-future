'use client';

/**
 * Registers the Wired Future tool set on navigator.modelContext.
 *
 * Spec notes (W3C WebMCP CG draft, April 2026 revision):
 *   - provideContext() / clearContext() were removed. registerTool() and
 *     unregisterTool() are the only surface.
 *   - Feature detection is `'modelContext' in navigator`.
 *   - A secure context (https or localhost) is required for the API to be
 *     exposed at all, so if the property is missing we simply fall back.
 *
 * React 19 StrictMode mounts, unmounts and remounts effects in development, so
 * registration is guarded by a module-level Set and cleanup is exact: we only
 * ever unregister the names this particular mount actually claimed.
 */

import { useEffect, useRef } from 'react';

import type { ModelContext } from '@/types/webmcp';
import type { WiredEngine } from '@/scene/contract';
import { useWired } from '@/store/use-wired';
import { buildTools } from './tools';

/** Names currently believed to be live on navigator.modelContext. */
const registeredNames = new Set<string>();

const UNAVAILABLE_MESSAGE =
  'navigator.modelContext not found - running in LOCAL SIMULATION MODE. ' +
  'Everything on this page still works: the console below runs the real tool code, ' +
  'not a mock. For a live agent bridge, open this page in the ChatGPT in-app browser. ' +
  "(Chrome's #enable-webmcp-testing flag is listed in 152 stable but exposes nothing, " +
  'so the flag is not a working alternative today.)';

/** Whichever surface this runtime exposes, or null when there is none. */
function resolveModelContext(): ModelContext | null {
  if (typeof document !== 'undefined') {
    const fromDocument = document.modelContext;
    if (typeof fromDocument?.registerTool === 'function') return fromDocument;
  }
  if (typeof navigator !== 'undefined') {
    const fromNavigator = navigator.modelContext;
    if (typeof fromNavigator?.registerTool === 'function') return fromNavigator;
  }
  return null;
}

export function useWebMcp(getEngine: () => WiredEngine | null): void {
  // Keep the latest getter in a ref so an inline arrow from the caller does not
  // re-register the whole tool set on every render.
  const getEngineRef = useRef(getEngine);

  useEffect(() => {
    getEngineRef.current = getEngine;
  }, [getEngine]);

  useEffect(() => {
    const store = useWired.getState();

    // The API is mid-migration: it moved from navigator.modelContext to
    // document.modelContext in the 21 July 2026 revision, so a runtime may
    // expose either. Probe document first (the newer home), then navigator,
    // and use whichever actually carries registerTool.
    const context = resolveModelContext();

    if (!context) {
      store.setMcpStatus('unavailable');
      store.log('system', UNAVAILABLE_MESSAGE);
      return;
    }

    const tools = buildTools(() => getEngineRef.current());
    const claimed: string[] = [];

    try {
      for (const tool of tools) {
        if (registeredNames.has(tool.name)) continue;
        context.registerTool(tool);
        registeredNames.add(tool.name);
        claimed.push(tool.name);
      }

      store.setMcpStatus('connected');
      store.log(
        'system',
        'WebMCP bridge live - ' +
          tools.length +
          ' tools exposed to the agent: ' +
          tools.map((tool) => tool.name).join(', '),
      );
    } catch (err) {
      // Spec drift must not white-screen the page. Roll back what we claimed
      // and drop to simulation mode.
      for (const name of claimed) {
        try {
          context.unregisterTool?.(name);
        } catch {
          /* nothing useful to do */
        }
        registeredNames.delete(name);
      }
      claimed.length = 0;

      const detail = err instanceof Error ? err.message : String(err);
      store.setMcpStatus('unavailable');
      store.log(
        'system',
        'WebMCP tool registration failed (' + detail + ') - falling back to local simulation mode.',
      );
      return;
    }

    return () => {
      for (const name of claimed) {
        try {
          context.unregisterTool?.(name);
        } catch {
          /* the page is going away; swallow */
        }
        registeredNames.delete(name);
      }
    };
    // Intentionally mount-only: the engine getter is read through a ref.
  }, []);
}
