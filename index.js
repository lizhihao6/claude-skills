#!/usr/bin/env node

/**
 * claude-skills MCP Server
 *
 * A shared skill server for Claude, providing tools for:
 * - Dida365 (滴答清单) task tracking
 * - Volcengine ML Platform (MLP) training task management
 *
 * Usage in claude_desktop_config.json or .claude/settings.json:
 * {
 *   "mcpServers": {
 *     "claude-skills": {
 *       "command": "npx",
 *       "args": ["github:lizhihao6/claude-skills"],
 *       "env": {
 *         "DIDA365_ACCESS_TOKEN": "your-token-here"
 *       }
 *     }
 *   }
 * }
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { tools as didaTools } from "./tools/dida-task.js";
import { tools as volcTools } from "./tools/volc-mlp.js";
import { tools as veCloudTools } from "./tools/ve-cloud.js";
import { tools as tcCloudTools } from "./tools/tencent-cloud.js";

const server = new Server(
  { name: "claude-skills", version: "0.3.0" },
  { capabilities: { tools: {} } }
);

// Collect all tools from all skill modules
const allTools = [...didaTools, ...volcTools, ...veCloudTools, ...tcCloudTools];
const toolMap = new Map(allTools.map((t) => [t.name, t]));

// List tools
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: allTools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  })),
}));

// Call tool
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const tool = toolMap.get(name);
  if (!tool) {
    return {
      content: [{ type: "text", text: `Unknown tool: ${name}` }],
      isError: true,
    };
  }
  try {
    const result = await tool.handler(args || {});
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  } catch (error) {
    return {
      content: [{ type: "text", text: `Error: ${error.message}` }],
      isError: true,
    };
  }
});

// Start
const transport = new StdioServerTransport();
await server.connect(transport);
