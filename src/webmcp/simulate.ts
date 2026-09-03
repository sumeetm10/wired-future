'use client';

/**
 * Local fallback for browsers with no WebMCP runtime.
 *
 * This is deliberately NOT a mock. It looks the tool up in the exact same
 * buildTools() list that useWebMcp registers on navigator.modelContext and
 * calls its real execute(). Everything downstream - validation, the store
 * reducer, the [AGENT] status line, the three.js reconcile - is the identical
 * code path a live agent hits. The only thing being simulated is the transport.
 */

import type { McpToolResult } from '@/types/webmcp';
import type { WiredEngine } from '@/scene/contract';
import { TOOL_NAMES, buildTools } from './tools';

export interface SimulationResult {
  ok: boolean;
  toolName: string;
  text: string;
  imageDataUrl?: string;
}

const USAGE =
  'Expected either a tool name followed by JSON arguments, for example:\n' +
  '  modify_wired_future_environment {"gridColorHex":"#ff2bd6"}\n' +
  'or the raw MCP wire shape:\n' +
  '  {"tool":"modify_wired_future_environment","input":{"gridColorHex":"#ff2bd6"}}';

const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]*$/;

function fail(toolName: string, text: string): SimulationResult {
  return { ok: false, toolName, text };
}

function availableToolsLine(): string {
  return 'Available tools: ' + TOOL_NAMES.join(', ') + '.';
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

interface ParsedCall {
  name: string;
  args: Record<string, unknown>;
}

/** Accepts the MCP wire shape, a `{tool,input}` envelope, or `name {json}`. */
function parseCall(raw: string): ParsedCall | { error: string } {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { error: 'Nothing to run.\n\n' + USAGE + '\n\n' + availableToolsLine() };
  }

  // Form (a): a JSON envelope.
  if (trimmed.startsWith('{')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return { error: 'That is not valid JSON (' + detail + ').\n\n' + USAGE };
    }

    const envelope = asRecord(parsed);
    if (!envelope) {
      return { error: 'Expected a JSON object.\n\n' + USAGE };
    }

    const nameValue = envelope.tool ?? envelope.name ?? envelope.toolName ?? envelope.method;
    if (typeof nameValue !== 'string' || !nameValue.trim()) {
      return {
        error:
          'The JSON object needs a "tool" (or "name") property holding the tool name.\n\n' +
          USAGE +
          '\n\n' +
          availableToolsLine(),
      };
    }

    const argsValue =
      envelope.input ?? envelope.arguments ?? envelope.args ?? envelope.params ?? {};
    const args = asRecord(argsValue);
    if (!args) {
      return {
        error:
          'The arguments must be a JSON object. Received ' +
          JSON.stringify(argsValue) +
          '.\n\n' +
          USAGE,
      };
    }

    return { name: nameValue.trim(), args };
  }

  // Form (b): bare tool name, optionally followed by JSON arguments.
  const match = /^([^\s({\[]+)([\s\S]*)$/.exec(trimmed);
  if (!match) {
    return { error: 'Could not read a tool name.\n\n' + USAGE + '\n\n' + availableToolsLine() };
  }

  const name = match[1].trim();
  if (!NAME_PATTERN.test(name)) {
    return {
      error:
        quoteish(name) +
        ' is not a valid tool name.\n\n' +
        USAGE +
        '\n\n' +
        availableToolsLine(),
    };
  }

  let rest = match[2].trim();
  if (!rest) return { name, args: {} };

  // Tolerate the call-expression style an agent might echo: name({...}).
  if (rest.startsWith('(') && rest.endsWith(')')) {
    rest = rest.slice(1, -1).trim();
    if (!rest) return { name, args: {} };
  }

  let parsedArgs: unknown;
  try {
    parsedArgs = JSON.parse(rest);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      error:
        'The arguments after "' + name + '" are not valid JSON (' + detail + ').\n\n' + USAGE,
    };
  }

  const args = asRecord(parsedArgs);
  if (!args) {
    return { error: 'The arguments must be a JSON object, for example {"waveVelocity":3}.\n\n' + USAGE };
  }

  return { name, args };
}

function quoteish(value: string): string {
  return '"' + value + '"';
}

function flatten(toolName: string, result: McpToolResult): SimulationResult {
  const texts: string[] = [];
  let imageDataUrl: string | undefined;

  for (const block of result.content ?? []) {
    if (block.type === 'text') {
      texts.push(block.text);
    } else if (block.type === 'image' && !imageDataUrl) {
      imageDataUrl = 'data:' + block.mimeType + ';base64,' + block.data;
    }
  }

  let text = texts.join('\n\n').trim();
  if (!text) {
    text = imageDataUrl
      ? 'Returned an image with no accompanying text.'
      : result.structuredContent
        ? JSON.stringify(result.structuredContent, null, 2)
        : 'Tool returned no content.';
  }

  return { ok: result.isError !== true, toolName, text, imageDataUrl };
}

/**
 * Run one hand-typed tool call against the real tool implementations.
 * Never throws; every failure comes back as ok:false with a readable message.
 */
export async function runSimulatedToolCall(
  raw: string,
  getEngine: () => WiredEngine | null,
): Promise<SimulationResult> {
  let parsed: ParsedCall | { error: string };
  try {
    parsed = parseCall(raw);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return fail('', 'Could not read that call: ' + detail + '\n\n' + USAGE);
  }

  if ('error' in parsed) return fail('', parsed.error);

  const tools = buildTools(getEngine);
  const exact = tools.find((tool) => tool.name === parsed.name);
  const needle = parsed.name.toLowerCase();
  const tool = exact ?? tools.find((candidate) => candidate.name.toLowerCase() === needle);

  if (!tool) {
    return fail(
      parsed.name,
      'Unknown tool ' + quoteish(parsed.name) + '.\n\n' + availableToolsLine(),
    );
  }

  try {
    const result = await tool.execute(parsed.args);
    return flatten(tool.name, result);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return fail(tool.name, tool.name + ' threw: ' + detail);
  }
}

/** One-click demos for the console. Short enough to sit on a button. */
export const SIMULATOR_EXAMPLES: { label: string; input: string }[] = [
  {
    label: 'Recolour the grid magenta',
    input: 'modify_wired_future_environment {"gridColorHex":"#ff2bd6"}',
  },
  {
    label: 'Swap in the engine block',
    input: 'modify_wired_future_environment {"modelType":"engine"}',
  },
  {
    label: 'Go solar flare',
    input: 'apply_scene_preset {"preset":"solar-flare"}',
  },
  {
    label: 'Pulse the reality wave',
    input: 'pulse_reality_wave {"intensity":3.5,"durationMs":2200}',
  },
  {
    label: 'Read the scene state',
    input: 'get_wired_future_state',
  },
  {
    label: 'Snapshot the canvas',
    input: 'capture_scene_snapshot {"maxWidth":640}',
  },
  {
    label: 'Load the real car',
    input: 'set_car_body {"variant":"real"}',
  },
  {
    label: 'Push the car back',
    input: 'place_object {"position":{"x":-3,"z":-4},"rotationDeg":{"y":35}}',
  },
  {
    label: 'Hand me the move gizmo',
    input: 'set_edit_mode {"mode":"translate"}',
  },
  {
    label: 'Check the photo status',
    input: 'reconstruct_photo_object {"action":"status"}',
  },
];
