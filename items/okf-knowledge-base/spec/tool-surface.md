# OKF Knowledge Base — Tool Surface (spec 040, consolidated)

Technical reference for the `okf_*` tools declared natively via bos-spec 039 (Service Tool Exposure), plus the non-OKF assistant tools the ingestion pipeline depends on. This replaces the prior `040-okf-knowledge-base/tool-surface.md` and folds in the tool this spec's former companion, `041-okf-delete-capability`, added.

## 1. Tool exposure model (039) — unchanged

`deploymentMode: "tools"` on `service.json` opts the service into runtime tool declaration over worker IPC (one `tool_declare` per tool at startup); `ServiceManager` registers each into the `AssistantTool` registry. See the original 039 spec for the full contract (discovery, validation, gating, lifecycle, loopback auth) — none of it changes here.

## 2. Current baseline: 30 `okf_*` tools (verified against the installed `services/lib/tools.js`)

This is the actual declared count today, not the original 040 spec's "29" — it already includes `okf_delete_bundle`, added by the former 041 feature. Confirmed by direct inspection of the installed item, not assumed from prior docs.

### Bundle & namespace (6)
| Tool | Signature | Purpose |
|---|---|---|
| `okf_list_bundles` | `{}` | List bundles under `/KnowledgeBase/`. |
| `okf_init_bundle` | `{bundle}` | Create a bundle (`index.md`, `log.md`, `concepts/`, `raw/`, schema). |
| `okf_bundle_status` | `{bundle}` | Concept count, stale/deprecated, per-concept trust. |
| `okf_import_bundle` | `{bundle?, source, type}` | Import from dir/git/tarball. |
| `okf_export_bundle` | `{bundle, format}` | Export as dir or tarball. |
| `okf_delete_bundle` | `{bundle}` | Delete the entire bundle directory. |

### Concept CRUD (6)
| Tool | Signature | Purpose |
|---|---|---|
| `okf_upsert_concept` | `{bundle, id, frontmatter, body?, preserveUnknownKeys?}` | Create/update; merge-on-fields; preserve unknown keys. |
| `okf_read_concept` | `{bundle, id}` | Frontmatter + body + resolved links. |
| `okf_delete_concept` | `{bundle, id, rewrite_backlinks?}` | Delete; rewrite backlinks only if `true`. |
| `okf_list_concepts` | `{bundle, type?, status?}` | List with filters. |
| `okf_find_concepts` | `{bundle, query?, type?, status?, source?}` | Full-text + frontmatter search. |

### Graph / relationships (7) — unchanged
`okf_add_link`, `okf_remove_link`, `okf_list_links`, `okf_backlinks`, `okf_neighbors`, `okf_shortest_path`, `okf_export_graph`.

### Ingest / query / lint (5 — **changed**, see §3)
`okf_add_raw_source` (renamed from the old flat `okf_ingest`), `okf_ingest` (now dispatcher-shaped), `okf_lint`, `okf_read_index`, `okf_read_bundle_schema`, `okf_append_log`. *(Note: this brings the group to 6, since the rename adds a distinct tool rather than replacing one — see §3 for why.)*

### Temporal & lifecycle (3) — unchanged
`okf_set_status`, `okf_get_as_of`, `okf_stale_report`.

### Provenance, trust & attestation (4) — unchanged
`okf_set_trust`, `okf_add_source`, `okf_attest`, `okf_provenance`.

**New total: 31** (30 baseline + `okf_add_raw_source` as a genuinely new tool alongside the redesigned `okf_ingest`, rather than a like-for-like rename — the two now have different jobs: one mechanical, one a dispatcher).

## 3. What changes in this spec — the ingest tool split

### `okf_add_raw_source` (new name for the old `ingestRaw` behavior)

```jsonc
{
  "bundle": "string, required",
  "filename": "string, required",
  "content": "string, optional — inline text",
  "sourcePath": "string, optional — a path already staged (web_fetch/file_to_markdown output); avoids requiring the caller to pass large content inline",
  "conceptId": "string, optional",
  "title": "string, optional"
}
```

Mechanical only — versions into `raw/` (append-only, never overwrites), optionally stubs a concept. No LLM involvement, no delegation.

**`sourcePath` is the whole point, and it only works because acquisition tools can stage to a path.** `web_fetch` and `file_to_markdown` each take an optional `output_path`: with it set they write the content to the VFS and return only a receipt (`wrote N characters to <path>`), so the document never enters the model's context. Without that, the only way to persist fetched content would be to pass it back as `content:` — i.e. the model re-emitting the entire document as output tokens, which is exactly the cost this design exists to remove.

Canonical URL ingest — one entry point, every subsequent call dictated by the previous result:

```
okf_ingest({bundle, source: "https://…/harness/"})                → acquisition_required, steps: [...]
  web_fetch({url, output_path: "/workspace/okf-staged-harness.md"}) → "wrote 48213 characters to …"  (a receipt)
  okf_add_raw_source({bundle, sourcePath: "/workspace/okf-staged-harness.md"}) → { rawFile: "raw/okf-staged-harness.md" }
okf_ingest({bundle, source: "raw/okf-staged-harness.md"})         → delegation_required, delegate: {...}
agent_delegate({agent: "okf-ingest", task: <verbatim from the dispatcher>})
```

At no point does the article's text appear as model output. Documents (PDF/DOCX/…) take the identical route with `file_to_markdown` as step 1.

### `okf_ingest` (redesigned — dispatcher, not a flat writer)

```jsonc
{
  "bundle": "string, required",
  "source": "string, required — an http(s) URL, an absolute VFS path, or a raw/ path already in the bundle",
  "maxDepth": "number, optional — overrides the bundle's configured default",
  "maxWorkers": "number, optional — overrides the bundle's configured default"
}
```

**`okf_ingest` is the single entry point, and it accepts a URL — but it never fetches one.** The handler runs in a worker thread outside the Next.js process, with no `web_fetch` and no `file_to_markdown`; making it fetch would mean reimplementing acquisition inside the service, losing the provider-native routing and re-introducing local HTML scraping. So it *plans* instead of acting, returning one of two shapes:

| `source` | Returns | Meaning |
|---|---|---|
| URL | `acquisition_required` + `steps` | `web_fetch(url, output_path)` → `okf_add_raw_source(sourcePath)` → `okf_ingest(raw/…)` |
| `/path/to/x.pdf` (convertible) | `acquisition_required` + `steps` | `file_to_markdown(path, output_path)` → same tail |
| `/path/to/x.md` (already text) | `acquisition_required` + `steps` | `okf_add_raw_source(sourcePath)` → same tail (no conversion needed) |
| `raw/x.md` | `delegation_required` + `delegate` | proceed straight to `agent_delegate({agent: "okf-ingest", …})` |

**Why plan rather than document the recipe:** every returned step pins `output_path`. That one parameter is the difference between the document streaming to disk (tool returns a receipt) and the model having to regenerate the entire document as output tokens to store it. Leaving it to the caller's discretion means one lapse silently reintroduces the exact cost this design removes — so the dispatcher supplies it rather than trusting the recipe to be remembered.

Behavior: ensures the source is registered in `raw/` (calling the same mechanical path as `okf_add_raw_source` if not already done), then the semantic decomposition happens via `agent_delegate` targeting the bundled `okf-ingest` agent — see `design.md`'s Container diagram and ADR-002 for exactly how the dispatch is wired (resolved at implementation time whether the worker-side tool itself triggers this or whether it instructs the calling assistant to issue the `agent_delegate` call as a second step).

### `okf_read_bundle_schema`

Unchanged signature (`{bundle}`), but now reads through to the `okf-bundle-schema` BOS skill content (see design.md ADR-005) rather than a bespoke per-bundle `schema.md` file.

## 4. Non-OKF assistant tools the pipeline depends on (not 039-declared, not owned by this item)

| Tool | Lives in | Purpose |
|---|---|---|
| `web_fetch` / `web_search` (fixed) | `src/lib/assistant/tools/server/web-search.ts` + `src/lib/net.ts` | Clean markdown, links preserved, no silent truncation. |
| `file_to_markdown` (new) | `src/lib/assistant/tools/server/file-to-markdown.ts` | PDF/DOCX/PPTX/XLSX → markdown via the sandbox's `markitdown`. |
| `video_keyframes` (new) | `src/lib/assistant/tools/server/video-tools.ts` | ffmpeg-based frame sampling for video ingestion. |
| `agent_delegate` (existing) | `src/lib/assistant/tools/server/delegate-local.ts` | Dispatches the `okf-ingest` bundled sub-agent. |

These are core BOS assistant tools, available to any agent (not gated behind the OKF item), but the `okf-ingest` bundled agent's own allowlist restricts it to using them plus the OKF read/write tools it needs — see design.md's least-privilege tool list (NFR-011).

## 5. Storage layout — unchanged

```
/KnowledgeBase/<bundle>/
├── index.md
├── log.md
├── schema.md            # legacy — superseded by the okf-bundle-schema skill; may be kept
│                         #   for backward compatibility or removed, decided during implementation
├── raw/                 # immutable; text, converted-document markdown, or binary (image/video)
└── concepts/
```

## 6. Bundled agent/skill (new — installed via copy, not symlink)

```
data/user-apps/items/okf-knowledge-base/
├── agents/
│   └── okf-ingest/AGENT.md          # copy-installed to data/agents/okf-ingest/
└── skills/
    └── okf-bundle-schema/SKILL.md   # copy-installed to data/skills/okf-bundle-schema/
```

See design.md §"Marketplace item agent/skill bundling" for the install mechanism (`seedItemAgentsAndSkills`) and provenance/update-conflict model.

## 7. Hard invariants — unchanged

1. Schema-less — only `type` required.
2. Unknown keys preserved verbatim (merge-on-fields).
3. Human-readable plain Markdown.
4. No required tooling — git/grep/editor usable.
5. Forward-compatible round-trips.
6. Raw sources immutable (append-only).

## 8. New invariants (this spec)

7. **Least-privilege sub-agent** — the `okf-ingest` agent's tool allowlist never includes unrestricted `run_command`, delete tools, or the full top-level assistant tool surface.
8. **No sandbox path widening for mechanical conversion** — `file_to_markdown`/`video_keyframes` never require `KnowledgeBase/` in the `run_command` sandbox's visible paths; they stage through `workspace/` and the OKF service's own (non-sandboxed) write path moves results into `raw/`.
9. **Bounded reference crawl** — `maxDepth`/`maxWorkers` are always enforced, with dedup against a bundle's existing provenance before any reference is re-ingested.
