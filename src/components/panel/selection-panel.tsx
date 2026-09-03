'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

import type { WiredEngine } from '@/scene/contract';
import {
  CAR_PART_IDS,
  CAR_PART_LABELS,
  IDENTITY_NODE_TRANSFORM,
  NODE_LIMITS,
  useWired,
} from '@/store/use-wired';
import type { CarPartId } from '@/store/use-wired';

export interface SelectionPanelProps {
  getEngine: () => WiredEngine | null;
}

interface NodeRow {
  id: string;
  label: string;
  assembly: CarPartId;
  triangles: number;
}

function useStartsOpen() {
  const [open, setOpen] = useState(true);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (window.matchMedia('(max-width: 767px)').matches) setOpen(false);
  }, []);
  return [open, setOpen] as const;
}

/**
 * The part inspector.
 *
 * Click a part in the canvas to select its assembly; Ctrl-click to drill into
 * the individual mesh. Everything here writes through the same store actions an
 * agent calls, so a hand-dragged wing mirror and a tool-placed one are the same
 * event to the rest of the app.
 */
export function SelectionPanel({ getEngine }: SelectionPanelProps) {
  const selection = useWired((s) => s.carRig.selection);
  const hiddenNodes = useWired((s) => s.carRig.hiddenNodes);
  const nodeTransforms = useWired((s) => s.carRig.nodeTransforms);
  const carVariant = useWired((s) => s.carVariant);
  const modelType = useWired((s) => s.modelType);

  const [open, setOpen] = useStartsOpen();
  const [nodes, setNodes] = useState<NodeRow[]>([]);
  const [filter, setFilter] = useState('');

  // The node list only exists once the glTF has loaded, so poll briefly rather
  // than guess when that happened.
  useEffect(() => {
    let cancelled = false;
    let tries = 0;
    const tick = () => {
      if (cancelled) return;
      const list = getEngine()?.listCarNodes() ?? [];
      if (list.length) {
        setNodes(list as NodeRow[]);
        return;
      }
      if (tries++ < 40) window.setTimeout(tick, 500);
    };
    tick();
    return () => {
      cancelled = true;
    };
  }, [getEngine, carVariant, modelType]);

  const visible = modelType === 'car' && carVariant === 'real';

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return nodes;
    return nodes.filter(
      (n) =>
        n.label.toLowerCase().includes(q) ||
        CAR_PART_LABELS[n.assembly].toLowerCase().includes(q),
    );
  }, [nodes, filter]);

  const selectedNodeTransform =
    selection && selection.level === 'node'
      ? (nodeTransforms[selection.id] ?? IDENTITY_NODE_TRANSFORM)
      : null;

  const isHidden =
    selection && selection.level === 'node'
      ? hiddenNodes.includes(selection.id)
      : false;

  const toggleHidden = useCallback(() => {
    if (!selection || selection.level !== 'node') return;
    const live = useWired.getState().carRig.hiddenNodes;
    const next = live.includes(selection.id)
      ? live.filter((x) => x !== selection.id)
      : [...live, selection.id];
    useWired.getState().setNodeHidden(next, 'human');
  }, [selection]);

  const resetNode = useCallback(() => {
    if (!selection || selection.level !== 'node') return;
    useWired
      .getState()
      .setNodeTransform(selection.id, { ...IDENTITY_NODE_TRANSFORM }, 'human');
  }, [selection]);

  const nudge = useCallback(
    (part: Partial<typeof IDENTITY_NODE_TRANSFORM>) => {
      if (!selection || selection.level !== 'node') return;
      const live =
        useWired.getState().carRig.nodeTransforms[selection.id] ??
        IDENTITY_NODE_TRANSFORM;
      useWired
        .getState()
        .setNodeTransform(selection.id, { ...live, ...part }, 'human');
    },
    [selection],
  );

  if (!visible) return null;

  const bodyId = 'wf-selection-body';

  return (
    <section className="wf-dock wf-dock--parts" aria-label="Part inspector">
      <div className="wf-panel">
        <header className="wf-panel__head">
          <h2 className="wf-panel__title">Parts</h2>
          <button
            type="button"
            className="wf-button wf-button--chip wf-chip-toggle"
            aria-expanded={open}
            aria-controls={bodyId}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? 'Minimise' : 'Parts'}
          </button>
        </header>

        <div
          id={bodyId}
          className={
            'wf-panel__body wf-scroll wf-collapsible' + (open ? ' is-open' : '')
          }
        >
          <p className="wf-note">
            Click a part to select its assembly. Then, holding{' '}
            <strong>Ctrl</strong> (or Cmd) over any part:
          </p>
          <ul className="wf-gestures">
            <li>
              <strong>click</strong> — run what it does. Doors swing, the hood
              lifts, anything else pops off and back on.
            </li>
            <li>
              <strong>drag</strong> — pull that part out along its own axis,
              away from the car.
            </li>
            <li>
              <strong>scroll</strong> — resize it.
            </li>
          </ul>
          <p className="wf-note">
            {nodes.length || 109} parts, down to individual handles, wipers and
            brake discs.
          </p>

          <div className="wf-selected">
            <span className="wf-label">Selected</span>
            <span className="wf-selected__name">
              {selection ? selection.label : 'nothing'}
            </span>
            {selection ? (
              <span className="wf-selected__level">
                {selection.level === 'node' ? 'single part' : 'assembly'}
              </span>
            ) : null}
          </div>

          {selection && selection.level === 'node' && selectedNodeTransform ? (
            <>
              <div className="wf-row">
                <button
                  type="button"
                  className={'wf-button wf-button--chip' + (isHidden ? '' : ' is-active')}
                  onClick={toggleHidden}
                >
                  {isHidden ? 'Refit' : 'Detach'}
                </button>
                <button
                  type="button"
                  className="wf-button wf-button--chip wf-button--ghost"
                  onClick={resetNode}
                >
                  Reset Part
                </button>
              </div>

              <RangeRow
                label="Offset X"
                value={selectedNodeTransform.x}
                min={NODE_LIMITS.offset.min}
                max={NODE_LIMITS.offset.max}
                step={0.01}
                onChange={(v) => nudge({ x: v })}
              />
              <RangeRow
                label="Offset Y"
                value={selectedNodeTransform.y}
                min={NODE_LIMITS.offset.min}
                max={NODE_LIMITS.offset.max}
                step={0.01}
                onChange={(v) => nudge({ y: v })}
              />
              <RangeRow
                label="Offset Z"
                value={selectedNodeTransform.z}
                min={NODE_LIMITS.offset.min}
                max={NODE_LIMITS.offset.max}
                step={0.01}
                onChange={(v) => nudge({ z: v })}
              />
              <RangeRow
                label="Yaw"
                value={selectedNodeTransform.rotY}
                min={-180}
                max={180}
                step={1}
                suffix=" deg"
                onChange={(v) => nudge({ rotY: v })}
              />
              <RangeRow
                label="Scale"
                value={selectedNodeTransform.scale}
                min={NODE_LIMITS.scale.min}
                max={NODE_LIMITS.scale.max}
                step={0.01}
                suffix=" x"
                onChange={(v) => nudge({ scale: v })}
              />
            </>
          ) : null}

          <hr className="wf-divider" />

          <div className="wf-field">
            <label className="wf-label" htmlFor="wf-part-filter">
              Find a part
            </label>
            <input
              id="wf-part-filter"
              type="text"
              className="wf-input"
              placeholder="handle, wiper, disc..."
              value={filter}
              autoComplete="off"
              onChange={(e) => setFilter(e.target.value)}
            />
          </div>

          <div className="wf-partlist wf-scroll">
            {filtered.length === 0 ? (
              <span className="wf-note">
                {nodes.length
                  ? 'No part matches that.'
                  : 'Loading the part list...'}
              </span>
            ) : (
              filtered.map((n) => {
                const active = selection?.level === 'node' && selection.id === n.id;
                const off = hiddenNodes.includes(n.id);
                return (
                  <button
                    key={n.id}
                    type="button"
                    className={
                      'wf-partrow' +
                      (active ? ' is-active' : '') +
                      (off ? ' is-off' : '')
                    }
                    onClick={() =>
                      useWired
                        .getState()
                        .select(
                          { level: 'node', id: n.id, label: n.label },
                          'human',
                        )
                    }
                  >
                    <span className="wf-partrow__name">{n.label}</span>
                    <span className="wf-partrow__meta">
                      {CAR_PART_LABELS[n.assembly]}
                    </span>
                  </button>
                );
              })
            )}
          </div>

          {hiddenNodes.length ? (
            <button
              type="button"
              className="wf-button wf-button--ghost wf-button--chip"
              onClick={() => useWired.getState().setNodeHidden([], 'human')}
            >
              Refit all {hiddenNodes.length} detached
            </button>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function RangeRow(props: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  suffix?: string;
  onChange: (value: number) => void;
}) {
  const id = 'wf-node-' + props.label.replace(/\s+/g, '-').toLowerCase();
  return (
    <div className="wf-field">
      <div className="wf-row">
        <label className="wf-label" htmlFor={id}>
          {props.label}
        </label>
        <span className="wf-readout">
          {props.value.toFixed(2)}
          {props.suffix ?? ''}
        </span>
      </div>
      <input
        id={id}
        type="range"
        className="wf-range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        onChange={(e) => props.onChange(Number(e.target.value))}
      />
    </div>
  );
}

export default SelectionPanel;
