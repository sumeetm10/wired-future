'use client';

import { useWired } from '@/store/use-wired';
import { TOOL_NAMES } from '@/webmcp/tools';

/**
 * Read the real registry rather than restating a number that can drift.
 * The literal is only a floor for the impossible case of an empty registry.
 */
const DEFAULT_TOOL_COUNT = TOOL_NAMES.length || 7;

export interface McpBadgeProps {
  /** Override the count of tools handed to `navigator.modelContext`. */
  toolCount?: number;
  /** Extra class names merged onto the fixed dock wrapper. */
  className?: string;
}

/**
 * Live readout of whether a real agent runtime is driving this page.
 * Fixed to the top-left dock; the control panel rail starts below it.
 */
export function McpBadge({
  toolCount = DEFAULT_TOOL_COUNT,
  className,
}: McpBadgeProps) {
  const mcpStatus = useWired((s) => s.mcpStatus);
  const agentActionCount = useWired((s) => s.agentActionCount);

  const dotClass =
    mcpStatus === 'connected'
      ? 'wf-dot wf-dot--live'
      : mcpStatus === 'unavailable'
        ? 'wf-dot wf-dot--offline'
        : 'wf-dot wf-dot--checking';

  const lineClass =
    mcpStatus === 'connected'
      ? 'wf-badge__line wf-badge__line--live'
      : mcpStatus === 'unavailable'
        ? 'wf-badge__line wf-badge__line--offline'
        : 'wf-badge__line wf-badge__line--checking';

  const headline =
    mcpStatus === 'connected'
      ? 'WEBMCP LIVE - ' + toolCount + ' TOOLS EXPOSED'
      : mcpStatus === 'unavailable'
        ? 'NO WEBMCP RUNTIME - SIMULATION MODE'
        : 'DETECTING AGENT RUNTIME';

  // Dim only while the probe is still running. The 'unavailable' state carries
  // the line a viewer most needs to read (how to get a real runtime), so it
  // must not be the state that fades out.
  const panelClass =
    'wf-panel wf-badge' + (mcpStatus === 'checking' ? ' wf-panel--muted' : '');

  return (
    <div className={className ? 'wf-badge-dock ' + className : 'wf-badge-dock'}>
      <div
        className={panelClass}
        role="status"
        aria-live="polite"
        aria-label={'Agent runtime status: ' + headline}
      >
        <span className={dotClass + ' wf-badge__dot'} aria-hidden="true" />
        <span className="wf-badge__text">
          <span className={lineClass}>
            {headline}
            {agentActionCount > 0 ? (
              <span className="wf-badge__count">
                {' · ' + agentActionCount + ' AGENT ACTION' + (agentActionCount === 1 ? '' : 'S')}
              </span>
            ) : null}
          </span>

          {mcpStatus === 'unavailable' ? (
            <span className="wf-badge__hint">
              Open in ChatGPT&apos;s in-app browser for a live agent bridge.
            </span>
          ) : null}

          {mcpStatus === 'checking' ? (
            <span className="wf-badge__hint">
              Probing navigator.modelContext for a tool registry.
            </span>
          ) : null}
        </span>
      </div>
    </div>
  );
}

export default McpBadge;
