/**
 * MCP (Model Context Protocol) type definitions for groq-code-cli
 */

export interface MCPServerConfig {
  /** Unique identifier for this server */
  name: string;
  /** Server type: stdio (local command) or sse (HTTP server) */
  type: 'stdio' | 'sse';
  /** For stdio: command to run (e.g., 'npx', 'node') */
  command?: string;
  /** For stdio: arguments to pass to the command */
  args?: string[];
  /** For sse: URL of the SSE endpoint */
  url?: string;
  /** Environment variables to set when running the server */
  env?: Record<string, string>;
  /** Whether the server is currently connected */
  connected?: boolean;
  /** Human-readable description */
  description?: string;
}

export interface MCPTool {
  /** Tool name (prefixed with server name for uniqueness) */
  name: string;
  /** Original tool name from the MCP server */
  originalName: string;
  /** Which MCP server provides this tool */
  serverName: string;
  /** Tool description */
  description: string;
  /** JSON Schema for the tool's input parameters */
  inputSchema: {
    type: 'object';
    properties: Record<string, any>;
    required?: string[];
  };
}

export interface MCPToolResult {
  success: boolean;
  content?: any;
  message?: string;
  error?: string;
  isError?: boolean;
}

export interface MCPConfig {
  /** List of configured MCP servers */
  servers: MCPServerConfig[];
}
