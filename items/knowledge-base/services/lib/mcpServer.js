"use strict";

// Exposes kb_search / kb_retrieve as a standard MCP server over Streamable
// HTTP — the sanctioned, zero-BOS-source-change way for a marketplace item
// to make a tool callable by a BOS agent (there is no dynamic tool-
// registration path into src/lib/assistant/registry.ts; MCP is the
// intentional escape hatch, mirrored by src/lib/mcp/client.ts's own use of
// this same SDK). The user adds this service's own endpoint as an MCP server
// in Settings -> MCP Servers (transport "http"); once added, kb_search/
// kb_retrieve are immediately callable by any agent through BOS's generic
// mcp_tool_search + mcp_tool_call gateway tools — see README.md for the exact
// steps.

const { randomUUID } = require("crypto");
const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { ListToolsRequestSchema, CallToolRequestSchema } = require("@modelcontextprotocol/sdk/types.js");
const query = require("./query");
const log = require("./log");

const TOOLS = [
  {
    name: "kb_search",
    description:
      "Search a Knowledge Base for relevant entities. Returns ranked entities (name, summary, attributes) each with the source passage(s) they were extracted from. Use kb_list_knowledge_bases first if you don't know the kbId.",
    inputSchema: {
      type: "object",
      properties: {
        kbId: { type: "string", description: "The knowledge base id to search." },
        query: { type: "string", description: "Natural-language search query." },
        limit: { type: "number", description: "Max results (default 10)." },
      },
      required: ["kbId", "query"],
    },
  },
  {
    name: "kb_retrieve",
    description:
      "Retrieve relevant facts (relationship triples: source -> fact -> target) from a Knowledge Base, each with the supporting source passage. Use kb_list_knowledge_bases first if you don't know the kbId.",
    inputSchema: {
      type: "object",
      properties: {
        kbId: { type: "string", description: "The knowledge base id to query." },
        query: { type: "string", description: "Natural-language query." },
        limit: { type: "number", description: "Max results (default 10)." },
      },
      required: ["kbId", "query"],
    },
  },
  {
    name: "kb_list_knowledge_bases",
    description: "List every knowledge base this service currently knows about (id, name, description).",
    inputSchema: { type: "object", properties: {} },
  },
];

function textResult(value) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function createMcpServer() {
  const server = new Server({ name: "browseros-knowledge-base", version: "1.0.0" }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    log.debug(`MCP tool call "${name}"`, args);
    try {
      if (name === "kb_search") {
        return textResult(await query.search({ kbId: args.kbId, query: args.query, limit: args.limit }));
      }
      if (name === "kb_retrieve") {
        return textResult(await query.retrieve({ kbId: args.kbId, query: args.query, limit: args.limit }));
      }
      if (name === "kb_list_knowledge_bases") {
        return textResult({ knowledgeBases: query.listKbsForTools() });
      }
      log.warn(`MCP tool call for unknown tool "${name}"`, args);
      return { content: [{ type: "text", text: `Unknown tool "${name}"` }], isError: true };
    } catch (err) {
      log.error(`MCP tool call "${name}" failed`, err);
      return { content: [{ type: "text", text: (err && err.message) || String(err) }], isError: true };
    }
  });

  return server;
}

/** One shared server + transport for the whole worker process — the
 *  Streamable HTTP transport manages its own sessions internally, so a
 *  single instance can serve every request routed to it. */
function createMcpEndpoint() {
  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
  let connected = server.connect(transport);
  return {
    async handleRequest(req, res) {
      await connected;
      await transport.handleRequest(req, res);
    },
  };
}

module.exports = { createMcpEndpoint, TOOLS };
