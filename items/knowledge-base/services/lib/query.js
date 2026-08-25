"use strict";

// Agent query tools' business logic (FR-009) — search + retrieve, no
// generative answers in v1 (spec Q=A). Shared by the MCP server (mcpServer.js,
// the real agent-facing surface) and the config UI's own "try a query" panel
// exposed over apiServer.js.

const state = require("./state");
const graphiti = require("./graphiti");
const provenance = require("./provenance");
const log = require("./log");

function requireKb(kbId) {
  const kb = state.getKb(kbId);
  if (!kb) throw new Error(`Unknown knowledge base id "${kbId}"`);
  return kb;
}

/** kb_search — entities (NodeResult) relevant to `query`, with passages. */
async function search({ kbId, query, limit }) {
  requireKb(kbId);
  log.debug(`kb_search: "${query}" in KB "${kbId}"`, { limit });
  const nodes = await graphiti.searchNodes({ kbId, query, limit });
  log.debug(`kb_search: "${query}" in KB "${kbId}" -> ${nodes.length} node(s)`);
  if (nodes.length === 0) return { results: [], note: "No content indexed yet for this knowledge base, or no matches." };
  return { results: await provenance.withNodeProvenance(kbId, nodes) };
}

/** kb_retrieve — facts (EdgeResult, source -> fact -> target) relevant to
 *  `query`, with passages. */
async function retrieve({ kbId, query, limit }) {
  requireKb(kbId);
  log.debug(`kb_retrieve: "${query}" in KB "${kbId}"`, { limit });
  const facts = await graphiti.searchMemoryFacts({ kbId, query, limit });
  log.debug(`kb_retrieve: "${query}" in KB "${kbId}" -> ${facts.length} fact(s)`);
  if (facts.length === 0) return { results: [], note: "No content indexed yet for this knowledge base, or no matches." };
  return { results: await provenance.withFactProvenance(kbId, facts) };
}

function listKbsForTools() {
  return state.listKbs().map((kb) => ({ id: kb.id, name: kb.name, description: kb.description }));
}

module.exports = { search, retrieve, listKbsForTools };
