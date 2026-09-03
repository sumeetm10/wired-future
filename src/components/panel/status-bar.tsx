'use client';

import { useEffect, useRef, useState } from 'react';

import { useWired } from '@/store/use-wired';
import type { ActionOrigin } from '@/store/use-wired';

const TAGS: Record<ActionOrigin, string> = {
  human: '[HUMAN]',
  agent: '[AGENT]',
  system: '[SYS]',
};

const TAG_CLASS: Record<ActionOrigin, string> = {
  human: 'wf-tag wf-tag--human',
  agent: 'wf-tag wf-tag--agent',
  system: 'wf-tag wf-tag--system',
};

const ROW_CLASS: Record<ActionOrigin, string> = {
  human: 'wf-log__row wf-log__row--human',
  agent: 'wf-log__row wf-log__row--agent',
  system: 'wf-log__row',
};

function pad2(n: number): string {
  return n < 10 ? '0' + n : String(n);
}

function clockOf(ts: number): string {
  const d = new Date(ts);
  return (
    pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds())
  );
}

/**
 * Terminal strip pinned to the bottom of the viewport. Every mutation of the
 * shared store lands here tagged with its origin, so a viewer can watch a
 * human and an agent take turns on the exact same world.
 */
export function StatusBar() {
  const logs = useWired((s) => s.logs);
  const agentActionCount = useWired((s) => s.agentActionCount);
  const scrollRef = useRef<HTMLOListElement | null>(null);
  const [open, setOpen] = useState(true);

  // Key on the newest entry's id, NOT on logs.length. The store caps the ring
  // buffer at 60, so once it saturates the length is pinned forever and a
  // length-keyed effect never fires again — the trace would silently stop
  // following exactly when it gets busy.
  const lastLogId = logs.length ? logs[logs.length - 1]!.id : 0;

  // Scroll the log container only — never the page.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lastLogId]);

  return (
    <section
      className={'wf-statusbar' + (open ? '' : ' is-collapsed')}
      aria-label="Action trace"
    >
      <div className="wf-statusbar__head">
        <span className="wf-label">System Trace</span>
        <span className="wf-statusbar__legend">
          <span className="wf-label wf-only-wide">
            <span className="wf-tag wf-tag--human">[HUMAN]</span> UI
          </span>
          <span className="wf-label wf-only-wide">
            <span className="wf-tag wf-tag--agent">[AGENT]</span> TOOL CALL
          </span>
          {/* The counter is the polite region, not the log itself. A live
              region on a 60-row trace turns one slider drag into a
              screen-reader torrent. */}
          <span
            className="wf-readout"
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            {logs.length} EVENTS / {agentActionCount} AGENT
          </span>
          <button
            type="button"
            className="wf-button wf-button--chip wf-chip-toggle"
            aria-expanded={open}
            aria-controls="wf-trace-log"
            onClick={() => setOpen((v) => !v)}
          >
            {open ? 'Minimise' : 'Trace'}
          </button>
        </span>
      </div>

      <ol id="wf-trace-log" className="wf-log wf-scroll" ref={scrollRef}>
        {logs.length === 0 ? (
          <li className="wf-log__empty">
            awaiting first action - move a control or run an agent tool call
          </li>
        ) : (
          logs.map((entry) => (
            <li key={entry.id} className={ROW_CLASS[entry.origin]}>
              <span className="wf-log__ts">{clockOf(entry.ts)}</span>
              <span className={TAG_CLASS[entry.origin]}>
                {TAGS[entry.origin]}
              </span>
              <span className="wf-log__msg">{entry.message}</span>
            </li>
          ))
        )}
      </ol>
    </section>
  );
}

export default StatusBar;
