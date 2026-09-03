'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import type { WiredEngine } from '@/scene/contract';
import { useWired } from '@/store/use-wired';
import { runSimulatedToolCall, SIMULATOR_EXAMPLES } from '@/webmcp/simulate';
import type { SimulationResult } from '@/webmcp/simulate';
import { parseIntent, INTENT_EXAMPLES } from '@/webmcp/intent';

export interface AgentSimulatorProps {
  /** Live handle on the Three.js engine, needed by capture-style tools. */
  getEngine: () => WiredEngine | null;
}

const FIRST_EXAMPLE =
  SIMULATOR_EXAMPLES.length > 0 ? SIMULATOR_EXAMPLES[0].input : '';

/**
 * The fallback interface. When no WebMCP runtime is present this textarea
 * dispatches into the very same `execute()` handlers a real agent would hit —
 * no mock layer, no parallel code path. When a runtime IS present it stays
 * mounted as a manual override so the two halves can be compared side by side.
 */
function useStartsOpen() {
  const [open, setOpen] = useState(true);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (window.matchMedia('(max-width: 767px)').matches) setOpen(false);
  }, []);
  // as const, or TS widens this to (boolean | Dispatch<...>)[] and every use
  // site loses which element is which.
  return [open, setOpen] as const;
}

export function AgentSimulator({ getEngine }: AgentSimulatorProps) {
  const mcpStatus = useWired((s) => s.mcpStatus);

  const [raw, setRaw] = useState<string>(FIRST_EXAMPLE);
  const [phrase, setPhrase] = useState('');
  const [unparsed, setUnparsed] = useState<string | null>(null);
  const [showRaw, setShowRaw] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SimulationResult | null>(null);
  const [open, setOpen] = useStartsOpen();

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const connected = mcpStatus === 'connected';
  const bodyId = 'wf-agent-simulator-body';

  const submit = useCallback(async () => {
    const payload = raw.trim();
    if (!payload || busy) return;
    setBusy(true);
    try {
      const next = await runSimulatedToolCall(payload, getEngine);
      if (aliveRef.current) setResult(next);
    } catch (error) {
      if (aliveRef.current) {
        setResult({
          ok: false,
          toolName: 'unknown',
          text:
            'simulator threw: ' +
            (error instanceof Error ? error.message : String(error)),
        });
      }
    } finally {
      if (aliveRef.current) setBusy(false);
    }
  }, [busy, getEngine, raw]);

  /**
   * Translate a phrase into a tool call, then run that call through the exact
   * same path the raw box uses. The translated JSON is written into the raw box
   * so you can see what a real agent would have sent.
   */
  const submitPhrase = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || busy) return;

      const intent = parseIntent(trimmed);
      if (!intent) {
        setUnparsed(trimmed);
        setResult(null);
        return;
      }

      setUnparsed(null);
      setRaw(intent.calls.join('\n'));
      setBusy(true);
      try {
        // A phrase can name several assemblies ("wider wheels" is four calls).
        // Run them in order and report the last result.
        let last: SimulationResult | null = null;
        for (const call of intent.calls) {
          last = await runSimulatedToolCall(call, getEngine);
          if (!aliveRef.current) return;
          if (!last.ok) break;
        }
        if (aliveRef.current && last) setResult(last);
      } catch (error) {
        if (aliveRef.current) {
          setResult({
            ok: false,
            toolName: intent.tool,
            text:
              'simulator threw: ' +
              (error instanceof Error ? error.message : String(error)),
          });
        }
      } finally {
        if (aliveRef.current) setBusy(false);
      }
    },
    [busy, getEngine],
  );

  const fillExample = useCallback((input: string) => {
    setRaw(input);
    const el = textareaRef.current;
    if (el) {
      el.focus();
      el.setSelectionRange(input.length, input.length);
    }
  }, []);

  return (
    <section
      className="wf-dock wf-dock--right"
      aria-label={connected ? 'Manual tool-call override' : 'Agent simulator'}
    >
      <div
        className={
          'wf-panel wf-panel--accent' + (connected ? ' wf-panel--muted' : '')
        }
      >
        <header className="wf-panel__head">
          <h2 className="wf-panel__title">
            {connected ? 'Manual Override' : 'Agent Simulator'}
          </h2>
          <button
            type="button"
            className="wf-button wf-button--chip wf-chip-toggle"
            aria-expanded={open}
            aria-controls={bodyId}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? 'Minimise' : 'Tool Call'}
          </button>
        </header>

        <div
          id={bodyId}
          className={
            'wf-panel__body wf-scroll wf-collapsible' + (open ? ' is-open' : '')
          }
        >
          {/* Desktop only: on a phone this paragraph fills the whole sheet and
              pushes the textarea and Run button below the fold. */}
          <p className="wf-note wf-only-wide-block">
            This box invokes the exact same execute() handlers a real WebMCP
            agent calls — same schemas, same store reducer, same scene. Nothing
            here is a mock, so what you run is the shipped code path.
          </p>

          <div className="wf-field">
            <label className="wf-label" htmlFor="wf-agent-phrase">
              Say It Plainly
            </label>
            <div className="wf-inline">
              <input
                id="wf-agent-phrase"
                type="text"
                className="wf-input"
                value={phrase}
                placeholder="open both doors"
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => {
                  setPhrase(e.target.value);
                  if (unparsed) setUnparsed(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    void submitPhrase(phrase);
                  }
                }}
              />
              <button
                type="button"
                className="wf-button wf-button--primary wf-button--chip"
                disabled={busy || phrase.trim().length === 0}
                onClick={() => void submitPhrase(phrase)}
              >
                {busy ? '...' : 'Go'}
              </button>
            </div>

            <div className="wf-chiprow">
              {INTENT_EXAMPLES.slice(0, 8).map((example) => (
                <button
                  key={example}
                  type="button"
                  className="wf-button wf-button--chip"
                  disabled={busy}
                  onClick={() => {
                    setPhrase(example);
                    void submitPhrase(example);
                  }}
                >
                  {example}
                </button>
              ))}
            </div>

            {unparsed ? (
              <p className="wf-note wf-note--refused">
                Not understood: &quot;{unparsed}&quot;. This box is a rule table,
                not a language model - real ChatGPT reads the tool descriptions
                and would handle it. Try one of the chips above, or write the
                tool call directly.
              </p>
            ) : (
              <span className="wf-note">
                Matched phrases become a real tool call, shown below. No model
                and no API key: with WebMCP the agent is ChatGPT itself.
              </span>
            )}
          </div>

          <button
            type="button"
            className="wf-button wf-button--ghost wf-button--chip"
            aria-expanded={showRaw}
            onClick={() => setShowRaw((v) => !v)}
          >
            {showRaw ? 'Hide raw tool call' : 'Show raw tool call'}
          </button>

          <div
            className={'wf-collapsible' + (showRaw ? ' is-open' : '')}
            style={{ flexDirection: 'column', gap: '10px' }}
          >
          <div className="wf-field">
            <label className="wf-label" htmlFor="wf-agent-simulator-input">
              Raw Tool Call
            </label>
            <textarea
              id="wf-agent-simulator-input"
              ref={textareaRef}
              className="wf-input"
              spellCheck={false}
              value={raw}
              placeholder={
                'modify_wired_future_environment {"gridColorHex":"#ff2bd6"}\n' +
                'or {"tool":"apply_scene_preset","input":{"preset":"hologram"}}'
              }
              onChange={(e) => setRaw(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                  e.preventDefault();
                  void submit();
                }
              }}
            />
            <span className="wf-note">Ctrl+Enter / Cmd+Enter to dispatch.</span>
          </div>

          <button
            type="button"
            className="wf-button wf-button--primary"
            disabled={busy || raw.trim().length === 0}
            onClick={() => void submit()}
          >
            {busy ? 'Dispatching' : 'Run as Agent'}
          </button>

          {SIMULATOR_EXAMPLES.length > 0 ? (
            <div className="wf-field">
              <span className="wf-label">Example Calls</span>
              <div className="wf-chiprow">
                {SIMULATOR_EXAMPLES.map((example) => (
                  <button
                    key={example.label}
                    type="button"
                    className="wf-button wf-button--chip"
                    onClick={() => fillExample(example.input)}
                  >
                    {example.label}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          </div>

          {result ? (
            <div
              className={'wf-result' + (result.ok ? '' : ' wf-result--error')}
              role="status"
              aria-live="polite"
            >
              <span className="wf-kicker">
                {(result.ok ? 'RESULT' : 'ERROR') + ' / ' + result.toolName}
              </span>
              <pre className="wf-result__text">{result.text}</pre>
              {result.imageDataUrl ? (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img
                  className="wf-result__img"
                  src={result.imageDataUrl}
                  alt={
                    'Frame captured from the live scene and returned by ' +
                    result.toolName
                  }
                />
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}

export default AgentSimulator;
