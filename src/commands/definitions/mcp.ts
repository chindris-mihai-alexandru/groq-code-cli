/**
 * MCP command implementation
 * Manages MCP (Model Context Protocol) server connections
 * 
 * Usage:
 *   /mcp                     - Show status of all MCP servers
 *   /mcp list                - List all configured and connected servers
 *   /mcp add <name> <type> <command/url> [args...]
 *                            - Add a new MCP server configuration
 *   /mcp remove <name>       - Remove an MCP server configuration
 *   /mcp connect <name>      - Connect to a configured MCP server
 *   /mcp disconnect <name>   - Disconnect from an MCP server
 *   /mcp tools [name]        - List tools from connected servers
 */

import { CommandDefinition, CommandContext } from '../base.js';
import { mcpManager, MCPServerConfig } from '../../mcp/client.js';

async function handleMCPCommand(args: string[], context: CommandContext): Promise<void> {
  const { addMessage } = context;
  const subcommand = args[0]?.toLowerCase() || 'list';

  switch (subcommand) {
    case 'list':
    case 'status': {
      await handleList(addMessage);
      break;
    }

    case 'add': {
      await handleAdd(args.slice(1), addMessage);
      break;
    }

    case 'remove':
    case 'rm': {
      await handleRemove(args.slice(1), addMessage);
      break;
    }

    case 'connect': {
      await handleConnect(args.slice(1), addMessage);
      break;
    }

    case 'disconnect': {
      await handleDisconnect(args.slice(1), addMessage);
      break;
    }

    case 'tools': {
      await handleTools(args.slice(1), addMessage);
      break;
    }

    case 'help':
    default: {
      handleHelp(addMessage);
      break;
    }
  }
}

async function handleList(addMessage: (msg: any) => void): Promise<void> {
  const configured = mcpManager.getConfiguredServers();
  const connected = mcpManager.getConnectedServers();

  let response = `MCP Server Status\n\n`;

  if (configured.length === 0) {
    response += `No MCP servers configured.\n\n`;
    response += `Add a server with:\n`;
    response += `  /mcp add <name> stdio <command> [args...]\n`;
    response += `  /mcp add <name> sse <url>\n\n`;
    response += `Example:\n`;
    response += `  /mcp add filesystem stdio npx -y @modelcontextprotocol/server-filesystem /path/to/dir\n`;
    response += `  /mcp add code-review stdio npx -y @vibesnipe/code-review-mcp\n`;
  } else {
    response += `Configured Servers:\n`;
    for (const server of configured) {
      const status = server.connected ? '(connected)' : '(disconnected)';
      const type = server.type === 'stdio' 
        ? `${server.command} ${(server.args || []).join(' ')}`
        : server.url;
      response += `  ${server.name} ${status}\n`;
      response += `    Type: ${server.type}\n`;
      response += `    ${server.type === 'stdio' ? 'Command' : 'URL'}: ${type}\n`;
      if (server.description) {
        response += `    Description: ${server.description}\n`;
      }
      
      // Show tool count if connected
      const connectedInfo = connected.find(c => c.name === server.name);
      if (connectedInfo) {
        response += `    Tools: ${connectedInfo.toolCount}\n`;
      }
      response += `\n`;
    }

    if (connected.length > 0) {
      response += `\nConnected: ${connected.length} server(s), ${connected.reduce((sum, s) => sum + s.toolCount, 0)} total tools available\n`;
    }
  }

  addMessage({ role: 'system', content: response });
}

async function handleAdd(args: string[], addMessage: (msg: any) => void): Promise<void> {
  if (args.length < 3) {
    addMessage({
      role: 'system',
      content: `Usage: /mcp add <name> <type> <command/url> [args...]\n\n` +
        `Examples:\n` +
        `  /mcp add filesystem stdio npx -y @modelcontextprotocol/server-filesystem /home/user/project\n` +
        `  /mcp add code-review stdio npx -y @vibesnipe/code-review-mcp\n` +
        `  /mcp add remote-server sse https://example.com/mcp`
    });
    return;
  }

  const [name, type, ...rest] = args;

  if (type !== 'stdio' && type !== 'sse') {
    addMessage({
      role: 'system',
      content: `Invalid type: ${type}. Must be 'stdio' or 'sse'.`
    });
    return;
  }

  const serverConfig: MCPServerConfig = {
    name,
    type: type as 'stdio' | 'sse',
  };

  if (type === 'stdio') {
    serverConfig.command = rest[0];
    serverConfig.args = rest.slice(1);
  } else {
    serverConfig.url = rest[0];
  }

  mcpManager.addServerConfig(serverConfig);

  addMessage({
    role: 'system',
    content: `Added MCP server '${name}'.\n\nUse /mcp connect ${name} to connect.`
  });
}

async function handleRemove(args: string[], addMessage: (msg: any) => void): Promise<void> {
  if (args.length < 1) {
    addMessage({
      role: 'system',
      content: `Usage: /mcp remove <name>`
    });
    return;
  }

  const name = args[0];

  // Disconnect first if connected
  await mcpManager.disconnect(name);

  const removed = mcpManager.removeServerConfig(name);

  if (removed) {
    addMessage({
      role: 'system',
      content: `Removed MCP server '${name}'.`
    });
  } else {
    addMessage({
      role: 'system',
      content: `MCP server '${name}' not found.`
    });
  }
}

async function handleConnect(args: string[], addMessage: (msg: any) => void): Promise<void> {
  if (args.length < 1) {
    // Connect to all configured servers
    const configured = mcpManager.getConfiguredServers();
    if (configured.length === 0) {
      addMessage({
        role: 'system',
        content: `No MCP servers configured. Use /mcp add to add a server.`
      });
      return;
    }

    addMessage({
      role: 'system',
      content: `Connecting to all configured servers...`
    });

    for (const server of configured) {
      if (!server.connected) {
        const result = await mcpManager.connect(server);
        if (result.success) {
          addMessage({
            role: 'system',
            content: `Connected to '${server.name}' (${result.toolCount} tools)`
          });
        } else {
          addMessage({
            role: 'system',
            content: `Failed to connect to '${server.name}': ${result.error}`
          });
        }
      }
    }
    return;
  }

  const name = args[0];
  const configured = mcpManager.getConfiguredServers();
  const server = configured.find(s => s.name === name);

  if (!server) {
    addMessage({
      role: 'system',
      content: `MCP server '${name}' not found. Use /mcp list to see configured servers.`
    });
    return;
  }

  addMessage({
    role: 'system',
    content: `Connecting to '${name}'...`
  });

  const result = await mcpManager.connect(server);

  if (result.success) {
    addMessage({
      role: 'system',
      content: `Connected to '${name}' successfully!\n${result.toolCount} tools now available.`
    });
  } else {
    addMessage({
      role: 'system',
      content: `Failed to connect to '${name}': ${result.error}`
    });
  }
}

async function handleDisconnect(args: string[], addMessage: (msg: any) => void): Promise<void> {
  if (args.length < 1) {
    // Disconnect from all servers
    const connected = mcpManager.getConnectedServers();
    if (connected.length === 0) {
      addMessage({
        role: 'system',
        content: `No MCP servers connected.`
      });
      return;
    }

    await mcpManager.disconnectAll();
    addMessage({
      role: 'system',
      content: `Disconnected from all MCP servers.`
    });
    return;
  }

  const name = args[0];
  const disconnected = await mcpManager.disconnect(name);

  if (disconnected) {
    addMessage({
      role: 'system',
      content: `Disconnected from '${name}'.`
    });
  } else {
    addMessage({
      role: 'system',
      content: `MCP server '${name}' not connected.`
    });
  }
}

async function handleTools(args: string[], addMessage: (msg: any) => void): Promise<void> {
  const tools = mcpManager.getAllTools();

  if (tools.length === 0) {
    addMessage({
      role: 'system',
      content: `No MCP tools available. Connect to an MCP server first with /mcp connect.`
    });
    return;
  }

  // Filter by server name if provided
  const serverFilter = args[0];
  const filteredTools = serverFilter 
    ? tools.filter(t => t.serverName === serverFilter)
    : tools;

  if (filteredTools.length === 0) {
    addMessage({
      role: 'system',
      content: `No tools found for server '${serverFilter}'.`
    });
    return;
  }

  let response = `MCP Tools Available:\n\n`;

  // Group by server
  const byServer = new Map<string, typeof tools>();
  for (const tool of filteredTools) {
    const existing = byServer.get(tool.serverName) || [];
    existing.push(tool);
    byServer.set(tool.serverName, existing);
  }

  for (const [serverName, serverTools] of byServer) {
    response += `${serverName}:\n`;
    for (const tool of serverTools) {
      response += `  ${tool.originalName}\n`;
      response += `    ${tool.description}\n`;
    }
    response += `\n`;
  }

  response += `\nTotal: ${filteredTools.length} tools from ${byServer.size} server(s)`;

  addMessage({ role: 'system', content: response });
}

function handleHelp(addMessage: (msg: any) => void): void {
  const help = `MCP (Model Context Protocol) Commands

Usage: /mcp <subcommand> [args...]

Subcommands:
  list, status       Show all configured and connected MCP servers
  add <name> <type> <cmd/url> [args...]
                     Add a new MCP server configuration
  remove <name>      Remove an MCP server configuration
  connect [name]     Connect to MCP server(s)
  disconnect [name]  Disconnect from MCP server(s)
  tools [server]     List available tools from connected servers
  help               Show this help message

Types:
  stdio              Local command (e.g., npx, node)
  sse                HTTP Server-Sent Events endpoint

Examples:
  /mcp add fs stdio npx -y @modelcontextprotocol/server-filesystem .
  /mcp add review stdio npx -y @vibesnipe/code-review-mcp
  /mcp connect fs
  /mcp tools

Environment Variables:
  You can set GOOGLE_API_KEY or other env vars in the server config
  by editing .groq/mcp.json directly.`;

  addMessage({ role: 'system', content: help });
}

export const mcpCommand: CommandDefinition = {
  command: 'mcp',
  description: 'Manage MCP (Model Context Protocol) server connections',
  handler: async (context: CommandContext) => {
    // Get the command string from context
    const commandString = context.commandString || '';
    
    let args: string[] = [];
    const match = commandString.match(/^\/mcp\s*(.*)/i);
    if (match && match[1]) {
      // Parse arguments, respecting quotes
      args = parseArgs(match[1]);
    }

    await handleMCPCommand(args, context);
  }
};

/**
 * Parse command arguments, respecting quoted strings
 */
function parseArgs(input: string): string[] {
  const args: string[] = [];
  let current = '';
  let inQuote = false;
  let quoteChar = '';

  for (const char of input) {
    if ((char === '"' || char === "'") && !inQuote) {
      inQuote = true;
      quoteChar = char;
    } else if (char === quoteChar && inQuote) {
      inQuote = false;
      quoteChar = '';
    } else if (char === ' ' && !inQuote) {
      if (current) {
        args.push(current);
        current = '';
      }
    } else {
      current += char;
    }
  }

  if (current) {
    args.push(current);
  }

  return args;
}
