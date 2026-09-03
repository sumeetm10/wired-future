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
  // The API moved from navigator.modelContext to document.modelContext in the
  // 21 July 2026 revision. Both are declared because the migration is still in
  // flight and a given runtime may expose either one.
  interface Navigator {
    modelContext?: ModelContext;
  }
  interface Document {
    modelContext?: ModelContext;
  }
}

export {};
