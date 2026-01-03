/**
 * MCP Client Manager for groq-code-cli
 * Manages connections to MCP servers and provides access to their tools
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { MCPServerConfig, MCPTool, MCPToolResult, MCPConfig } from './types.js';
import { ToolSchema } from '../tools/tool-schemas.js';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

// Default timeouts (in milliseconds)
const CONNECTION_TIMEOUT = 30000; // 30 seconds for connection
const TOOL_EXECUTION_TIMEOUT = 120000; // 2 minutes for tool execution

/**
 * Execute a promise with a timeout, cleaning up the timer on completion
 */
async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timeoutId: NodeJS.Timeout;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), ms);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(timeoutId!);
  }
}

interface ConnectedServer {
  config: MCPServerConfig;
  client: Client;
  transport: StdioClientTransport | SSEClientTransport;
  tools: MCPTool[];
}

class MCPClientManager {
  private servers: Map<string, ConnectedServer> = new Map();
  private configPath: string;

  constructor() {
    // Store MCP config in .groq directory
    this.configPath = path.join(process.cwd(), '.groq', 'mcp.json');
  }

  /**
   * Load MCP configuration from disk
   */
  loadConfig(): MCPConfig {
    try {
      if (fs.existsSync(this.configPath)) {
        const content = fs.readFileSync(this.configPath, 'utf-8');
        return JSON.parse(content);
      }
    } catch (error) {
      // Silently fail - config might not exist yet
    }
    return { servers: [] };
  }

  /**
   * Save MCP configuration to disk
   */
  saveConfig(config: MCPConfig): void {
    try {
      const dir = path.dirname(this.configPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.configPath, JSON.stringify(config, null, 2));
    } catch (error) {
      // Log but don't throw - config saving is not critical
      console.error('Failed to save MCP config:', error);
    }
  }

  /**
   * Add a new MCP server configuration
   */
  addServerConfig(serverConfig: MCPServerConfig): void {
    const config = this.loadConfig();
    
    // Remove existing server with same name
    config.servers = config.servers.filter(s => s.name !== serverConfig.name);
    
    // Add new server
    config.servers.push(serverConfig);
    
    this.saveConfig(config);
  }

  /**
   * Remove an MCP server configuration
   */
  removeServerConfig(serverName: string): boolean {
    const config = this.loadConfig();
    const originalLength = config.servers.length;
    config.servers = config.servers.filter(s => s.name !== serverName);
    
    if (config.servers.length < originalLength) {
      this.saveConfig(config);
      return true;
    }
    return false;
  }

  /**
   * Validate that a command exists in PATH
   */
  private validateCommand(command: string): { valid: boolean; error?: string; resolvedPath?: string } {
    try {
      // Handle common commands
      if (command === 'npx' || command === 'node' || command === 'npm') {
        // Try to find the command
        const whichCmd = process.platform === 'win32' ? 'where' : 'which';
        try {
          const result = execSync(`${whichCmd} ${command}`, { encoding: 'utf-8', timeout: 5000 });
          const resolvedPath = result.trim().split('\n')[0];
          return { valid: true, resolvedPath };
        } catch {
          // Command not found in PATH
          return { 
            valid: false, 
            error: `Command '${command}' not found. Make sure Node.js is installed and in your PATH. ` +
                   `If using nvm/fnm, ensure your shell is properly configured.`
          };
        }
      }
      
      // For other commands, check if it's an absolute path that exists
      if (path.isAbsolute(command)) {
        if (fs.existsSync(command)) {
          return { valid: true, resolvedPath: command };
        }
        return { valid: false, error: `Command not found: ${command}` };
      }
      
      // Assume it exists - let spawn handle the error
      return { valid: true };
    } catch (error) {
      return { valid: true }; // Don't block on validation errors
    }
  }

  /**
   * Connect to an MCP server with timeout
   */
  async connect(serverConfig: MCPServerConfig): Promise<{ success: boolean; error?: string; toolCount?: number }> {
    try {
      // Disconnect if already connected
      if (this.servers.has(serverConfig.name)) {
        await this.disconnect(serverConfig.name);
      }

      // Validate stdio command before attempting connection
      if (serverConfig.type === 'stdio') {
        if (!serverConfig.command) {
          return { success: false, error: 'No command specified for stdio server' };
        }

        const validation = this.validateCommand(serverConfig.command);
        if (!validation.valid) {
          return { success: false, error: validation.error };
        }
      }

      const client = new Client({
        name: 'groq-code-cli',
        version: '1.0.0',
      }, {
        capabilities: {}
      });

      let transport: StdioClientTransport | SSEClientTransport;

      if (serverConfig.type === 'stdio') {
        // Merge environment variables, ensuring PATH is always included
        const env: Record<string, string> = {
          ...process.env as Record<string, string>,
          ...serverConfig.env,
        };

        // Ensure PATH is set (critical for finding node, npx, etc.)
        if (!env.PATH && process.env.PATH) {
          env.PATH = process.env.PATH;
        }

        transport = new StdioClientTransport({
          command: serverConfig.command!,
          args: serverConfig.args || [],
          env,
        });
      } else if (serverConfig.type === 'sse') {
        if (!serverConfig.url) {
          return { success: false, error: 'No URL specified for SSE server' };
        }

        try {
          new URL(serverConfig.url); // Validate URL format
        } catch {
          return { success: false, error: `Invalid URL: ${serverConfig.url}` };
        }

        transport = new SSEClientTransport(new URL(serverConfig.url));
      } else {
        return { success: false, error: `Unknown server type: ${serverConfig.type}` };
      }

      // Connect with timeout
      try {
        await withTimeout(
          client.connect(transport),
          CONNECTION_TIMEOUT,
          `Connection timeout after ${CONNECTION_TIMEOUT / 1000}s`
        );
      } catch (error) {
        // Clean up on connection failure
        try {
          await client.close();
        } catch {
          // Ignore cleanup errors
        }
        throw error;
      }

      // List available tools with timeout
      let toolsResult;
      try {
        toolsResult = await withTimeout(
          client.listTools(),
          CONNECTION_TIMEOUT,
          'Timeout listing tools'
        );
      } catch (error) {
        await this.safeClose(client);
        throw error;
      }

      const tools: MCPTool[] = (toolsResult.tools || []).map(tool => ({
        name: `mcp_${serverConfig.name}_${tool.name}`,
        originalName: tool.name,
        serverName: serverConfig.name,
        description: tool.description || `Tool from ${serverConfig.name}`,
        inputSchema: tool.inputSchema as MCPTool['inputSchema'],
      }));

      // Store the connected server
      this.servers.set(serverConfig.name, {
        config: { ...serverConfig, connected: true },
        client,
        transport,
        tools,
      });

      return { success: true, toolCount: tools.length };

    } catch (error) {
      const errorMessage = this.formatError(error);
      return { success: false, error: errorMessage };
    }
  }

  /**
   * Format error messages for user-friendly display
   */
  private formatError(error: unknown): string {
    if (error instanceof Error) {
      const msg = error.message;
      
      // Handle common spawn errors
      if (msg.includes('ENOENT') || msg.includes('spawn')) {
        if (msg.includes('npx')) {
          return 'Failed to spawn npx. Ensure Node.js is installed and npx is in your PATH. ' +
                 'If using nvm/fnm, run this command in the same shell where node is available.';
        }
        if (msg.includes('node')) {
          return 'Failed to spawn node. Ensure Node.js is installed and in your PATH.';
        }
        return `Failed to spawn command: ${msg}. Check that the command exists and is executable.`;
      }
      
      // Handle connection errors
      if (msg.includes('ECONNREFUSED')) {
        return `Connection refused. Is the MCP server running at the specified address?`;
      }
      
      if (msg.includes('timeout') || msg.includes('Timeout')) {
        return msg;
      }
      
      return msg;
    }
    
    return String(error);
  }

  /**
   * Safely close a client, ignoring errors
   */
  private async safeClose(client: Client): Promise<void> {
    try {
      await client.close();
    } catch {
      // Ignore close errors
    }
  }

  /**
   * Disconnect from an MCP server
   */
  async disconnect(serverName: string): Promise<boolean> {
    const server = this.servers.get(serverName);
    if (!server) {
      return false;
    }

    await this.safeClose(server.client);
    this.servers.delete(serverName);
    return true;
  }

  /**
   * Disconnect from all MCP servers
   */
  async disconnectAll(): Promise<void> {
    const serverNames = Array.from(this.servers.keys());
    for (const serverName of serverNames) {
      await this.disconnect(serverName);
    }
  }

  /**
   * Get all tools from all connected servers
   */
  getAllTools(): MCPTool[] {
    const allTools: MCPTool[] = [];
    for (const server of this.servers.values()) {
      allTools.push(...server.tools);
    }
    return allTools;
  }

  /**
   * Convert MCP tools to Groq tool schemas
   */
  getToolSchemas(): ToolSchema[] {
    return this.getAllTools().map(tool => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: `[MCP:${tool.serverName}] ${tool.description}`,
        parameters: {
          type: 'object' as const,
          properties: tool.inputSchema.properties || {},
          required: tool.inputSchema.required || [],
        },
      },
    }));
  }

  /**
   * Check if a tool name belongs to an MCP server
   */
  isMCPTool(toolName: string): boolean {
    return toolName.startsWith('mcp_');
  }

  /**
   * Execute an MCP tool with timeout
   */
  async executeTool(toolName: string, args: Record<string, any>): Promise<MCPToolResult> {
    // Find the tool
    for (const server of this.servers.values()) {
      const tool = server.tools.find(t => t.name === toolName);
      if (tool) {
        try {
          // Execute with timeout
          const result = await withTimeout(
            server.client.callTool({
              name: tool.originalName,
              arguments: args,
            }),
            TOOL_EXECUTION_TIMEOUT,
            `Tool execution timeout after ${TOOL_EXECUTION_TIMEOUT / 1000}s`
          );

          // Parse the result
          if (result.isError) {
            return {
              success: false,
              error: this.extractContent(result.content),
              isError: true,
            };
          }

          return {
            success: true,
            content: this.extractContent(result.content),
            message: `Tool ${tool.originalName} executed successfully`,
          };

        } catch (error) {
          const errorMessage = this.formatError(error);
          
          // Check if server connection is dead and clean up
          if (errorMessage.includes('closed') || errorMessage.includes('disconnected')) {
            this.servers.delete(server.config.name);
          }
          
          return {
            success: false,
            error: `Failed to execute tool: ${errorMessage}`,
          };
        }
      }
    }

    return {
      success: false,
      error: `Unknown MCP tool: ${toolName}`,
    };
  }

  /**
   * Extract content from MCP tool result
   */
  private extractContent(content: any): any {
    if (!content) return null;
    
    if (Array.isArray(content)) {
      // MCP returns content as array of content blocks
      const textParts = content
        .filter((c: any) => c.type === 'text')
        .map((c: any) => c.text);
      
      if (textParts.length === 1) {
        return textParts[0];
      } else if (textParts.length > 1) {
        return textParts.join('\n');
      }
      
      // Return the whole content if no text parts
      return content;
    }
    
    return content;
  }

  /**
   * Get list of connected servers
   */
  getConnectedServers(): Array<{ name: string; toolCount: number; description?: string }> {
    return Array.from(this.servers.values()).map(server => ({
      name: server.config.name,
      toolCount: server.tools.length,
      description: server.config.description,
    }));
  }

  /**
   * Get configured servers (connected or not)
   */
  getConfiguredServers(): MCPServerConfig[] {
    const config = this.loadConfig();
    return config.servers.map(s => ({
      ...s,
      connected: this.servers.has(s.name),
    }));
  }

  /**
   * Check if any servers are connected
   */
  hasConnectedServers(): boolean {
    return this.servers.size > 0;
  }

  /**
   * Check if a specific server is still responsive
   */
  async isServerHealthy(serverName: string): Promise<boolean> {
    const server = this.servers.get(serverName);
    if (!server) {
      return false;
    }

    try {
      // Try to list tools as a health check
      await withTimeout(
        server.client.listTools(),
        5000,
        'Health check timeout'
      );
      return true;
    } catch {
      // Server is not healthy, remove it from connected servers
      this.servers.delete(serverName);
      return false;
    }
  }

  /**
   * Reconnect to a server if it's configured but not connected
   */
  async reconnect(serverName: string): Promise<{ success: boolean; error?: string; toolCount?: number }> {
    const config = this.loadConfig();
    const serverConfig = config.servers.find(s => s.name === serverName);
    
    if (!serverConfig) {
      return { success: false, error: `Server '${serverName}' not found in configuration` };
    }

    return this.connect(serverConfig);
  }
}

// Export singleton instance
export const mcpManager = new MCPClientManager();

// Re-export types
export type { MCPServerConfig, MCPTool, MCPToolResult, MCPConfig };
