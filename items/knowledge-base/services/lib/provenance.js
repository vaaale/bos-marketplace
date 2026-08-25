"use strict";

// Maps Graphiti search results (entities/facts) to agent-facing passages with
// source-passage provenance (design.md §5.7/ADR-5). Graphiti's native
// retrieval returns entities (NodeResult) and facts (EdgeResult), not raw
// passage chunks — Q=A ("search + retrieve passages") is satisfied by
// reconstructing the underlying episode text via get_episodes and attaching
// it as the passage citation.

const graphiti = require("./graphiti");

/** Fetches the KB's recent episodes once and indexes them by uuid, so many
 *  nodes/facts from the same search can share one get_episodes round trip. */
async function episodeIndex(kbId, lastN) {
  const episodes = await graphiti.getEpisodes({ kbId, lastN: lastN || 200 });
  const byUuid = new Map();
  for (const ep of episodes) {
    const uuid = ep.uuid || ep.episode_uuid || ep.id;
    if (uuid) byUuid.set(uuid, ep);
  }
  return byUuid;
}

function episodeText(ep) {
  return ep && (ep.content || ep.episode_body || ep.body || ep.text || "");
}

function episodeUuidsOf(nodeOrEdge) {
  const raw = nodeOrEdge.episodes || nodeOrEdge.episode_uuids || nodeOrEdge.source_episodes || [];
  return Array.isArray(raw) ? raw : [];
}

/** A node result -> { name, summary, labels, passages: [{episodeName, text}] }. */
function passagesFor(nodeOrEdge, byUuid) {
  const uuids = episodeUuidsOf(nodeOrEdge);
  const passages = uuids
    .map((uuid) => byUuid.get(uuid))
    .filter(Boolean)
    .map((ep) => ({ episodeName: ep.name || ep.uuid, text: episodeText(ep) }))
    .filter((p) => p.text);
  return passages;
}

/** kb_search: search_nodes results -> entities with passage citations. */
async function withNodeProvenance(kbId, nodes) {
  const byUuid = await episodeIndex(kbId);
  return nodes.map((node) => ({
    uuid: node.uuid,
    name: node.name,
    labels: node.labels || [],
    summary: node.summary || "",
    attributes: node.attributes || {},
    passages: passagesFor(node, byUuid),
  }));
}

/** kb_retrieve: search_memory_facts results -> relationship triples with
 *  passage citations (design.md §5.7: "surfaced as the relationship triple
 *  (source -> fact -> target) plus the supporting episode text"). */
async function withFactProvenance(kbId, facts) {
  const byUuid = await episodeIndex(kbId);
  return facts.map((fact) => ({
    uuid: fact.uuid,
    fact: fact.fact || fact.name || "",
    sourceNode: fact.source_node_name || fact.source_node_uuid || null,
    targetNode: fact.target_node_name || fact.target_node_uuid || null,
    validAt: fact.valid_at || null,
    invalidAt: fact.invalid_at || null,
    passages: passagesFor(fact, byUuid),
  }));
}

module.exports = { withNodeProvenance, withFactProvenance };
