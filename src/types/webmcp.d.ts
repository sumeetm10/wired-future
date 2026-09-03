// WebMCP (navigator.modelContext) is a W3C Community Group draft, not yet in lib.dom.
// Shapes follow the March/April 2026 spec revision: provideContext()/clearContext()
// were removed; registerTool()/unregisterTool() are the only ways to declare tools.

export interface McpToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
  title?: string;
}

export interface McpTextContent {
  type: 'text';
  text: string;
}

export interface McpImageContent {
  type: 'image';
  /** Base64 payload WITHOUT the data: URL prefix. */
  data: string;
  mimeType: string;
}

export type McpContent = McpTextContent | McpImageContent;

export interface McpToolResult {
  content: McpContent[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export interface McpToolDescriptor<TInput = Record<string, unknown>> {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: McpToolAnnotations;
  execute: (input: TInput) => Promise<McpToolResult> | McpToolResult;
}

export interface ModelContext {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerTool: (tool: McpToolDescriptor<any>) => void;
  unregisterTool?: (name: string) => void;
}

declare global {
  interface Navigator {
    modelContext?: ModelContext;
  }
}

export {};
