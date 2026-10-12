# Data model

Everything is a Markdown file with YAML frontmatter in the BOS VFS. No database, no binary index, no sidecar state the content can't regenerate.

## Bundle layout

```
<bundleRoot>/                       # default /KnowledgeBase
├── .jobs/
│   └── jobs.json                   # service-level job store (NOT exported)
└── <bundle>/
    ├── index.md                    # curated entry point + derived "concepts covered"
    ├── log.md                      # append-only event log (init/ingest/lint/merge/delete)
    ├── concept-index.md            # DERIVED level 1 — the O(V) routing table
    ├── toc/
    │   └── <docId>.md              # DERIVED level 2 — one document's chapters
    ├── links.json                  # [{from, to, label?}] — okf_add_link edges
    ├── raw/                        # IMMUTABLE, append-only
    │   ├── <source>.md             # ingested text / converted-document markdown
    │   ├── <source>.v2.md          # a changed re-ingest; the old bytes stay
    │   ├── sources.json            # provenance ledger
    │   └── assets/<docId>/         # downloaded non-HTML inline assets
    │       ├── <name>.png
    │       └── <name>.mp4
    └── concepts/                   # CONTENT — the source of truth
        ├── <docId>.md              # document stub   {type: document}
        └── <docId>/<chId>.md       # chapter         {type: section}
```

**Source of truth: `concepts/**` and `raw/**`.** `concept-index.md` and `toc/*.md` are derived and regenerable. `links.json` is a derivation convenience — the markdown links in chapter bodies are the portable record, and `okf_lint` reconciles the two.

A chapter id is `<docId>/<chId>`. `validateConceptId` allows the `/`; `safeJoin` scopes it under `concepts/`. Nesting makes "which chapters belong to this document" a single directory listing, and `parent` stays in frontmatter anyway — redundant on purpose, so the file is portable and the graph derivable without a directory walk.

## Invariants

1. **Schema-less** — only `type` is required.
2. **Unknown frontmatter keys are preserved verbatim** on every write (shallow merge, `{...existing, ...patch}`). Dropping a key you don't recognise is silent data loss.
3. **Human-readable plain Markdown** — git, grep and an editor are sufficient tooling.
4. **`raw/` is append-only** — never overwritten, versioned instead.
5. **Path safety on every write** — `safeJoin` rejects anything that escapes the root; writes are atomic (temp + rename).
6. **Derived artifacts are never the sole source of truth** and are regenerated, not patched.
7. **`raw/assets/` copies are immutable**; `raw/sources.json` is the dedup ledger.

Frontmatter round-trips every *key and value*, but not byte-for-byte: there is no external YAML library here, so comments, quoting style and formatting in hand-edited frontmatter are normalized.

## Chapter frontmatter

```yaml
---
id: api-design/endpoint-naming        # == the path under concepts/
type: section                         # section | document
parent: api-design                    # the docId this chapter belongs to
title: Endpoint Naming Conventions
concepts: [api-design, naming]        # the concept TERMS this chapter covers
person_terms: [Diego Córdoba]         # optional: salient PERSONS (ADR-011)
summary: "REST resource naming: plural nouns, no verbs, versioned paths."
status: stable                        # draft | stable | deprecated
stale_after: 2026-12-01               # optional ISO date
sources:
  - id: raw/api-design.md
    uri: https://engineering.example.com/handbook/api-design
    note: ingested 2026-08-01
created_at: 2026-08-01T00:00:00.000Z
updated_at: 2026-08-01T00:00:00.000Z
# any unknown key survives verbatim
---
```

**Three fields carry the entire retrieval contract:**

| Field | Why |
|---|---|
| `parent` | Puts the chapter in a document. The TOC and the graph's `containment` edge come from it. No parent = an orphan `okf_lint` reports. |
| `concepts` | The index vocabulary. **A chapter with no `concepts` is unreachable by `okf_search`** — stored, and invisible. |
| `summary` | One line, and it does double duty: the description a human reads in the index/TOC, *and* the text the deterministic match runs against. |

A chapter written without those three is not an error — it is written, and silently unroutable. `okf_lint` flags it.

**`person_terms` is the optional fourth** (ADR-011): an array of **salient person names** — a sibling of `concepts`, never merged into it, original case preserved. On a chapter it names the key figures the chapter is *about*; on a document stub it names the **author**. The index derives `kind: person` for every name that appears in any such array; everything else is `kind: topic`. Nothing writes it but ingest — the shallow frontmatter merge preserves it verbatim.

**Document stub** (`concepts/<docId>.md`) is the same shape minus `parent`/`concepts`, with `type: document`, a `title`, a one-line `summary`, an optional `person_terms` (the author), `sources` (the original URL and/or `raw/` path — this is the "Open source" target) and timestamps.

**Lifecycle, trust and provenance are ordinary frontmatter.** `status` / `stale_after` for lifecycle, `verified` for the trust ladder (`unverified` → `machine-confirmed` → `human-reviewed`; machine-extracted content starts `unverified` and only a human moves it to `human-reviewed`), `sources` for provenance. There are no setter tools — `okf_upsert_concept` merges on fields, so they're set in the same call that writes the chapter.

## Concept index (`concept-index.md`)

Level 1. Frontmatter is machine-readable; body is the human listing. It is a `.md` and not a JSON sidecar because the index must be present in an export, greppable in an editor, and *one* artifact — a parallel JSON file would be a second thing to keep in sync, which is what the derived layer exists to avoid.

```markdown
---
type: concept-index
bundle: engineering
index_generated_at: 2026-10-09T00:00:00.000Z
terms:
  - name: api-design
    kind: topic                       # topic | person (DERIVED — ADR-011)
    covers:
      - { docId: api-design, docTitle: API Design Rules, chId: endpoint-naming,
          chTitle: Endpoint Naming Conventions,
          description: "REST resource naming: plural nouns, no verbs, versioned paths.",
          status: stable, stale: false }
      - { docId: error-handling, docTitle: Error Handling Standards, chId: error-response,
          chTitle: Error Response Format,
          description: "RFC-7807 problem+json envelope with stable error codes.",
          status: stable, stale: false }
  - name: rollback
    kind: topic
    covers:
      - { docId: deployment, docTitle: Deployment Checklist, chId: canary,
          chTitle: Canary & Rollback,
          description: "5% canary for 30m; auto-rollback on p99 / 5xx thresholds.",
          status: stable, stale: false }
  - name: Diego Córdoba                 # original case preserved for display
    kind: person
    covers:
      # an empty chId is a DOCUMENT-level cover — this person authored it
      - { docId: water-rights, docTitle: Water Rights in the Andes, chId: "",
          chTitle: Water Rights in the Andes,
          description: "Andean water governance.", status: stable, stale: false }
---
# Concept Index — Engineering Rules & Guidelines

*Derived from chapter frontmatter. Regenerable; not the source of truth.*

- **api-design** — 2 chapters
  - `API Design Rules` › *Endpoint Naming Conventions* — REST resource naming…
  - `Error Handling Standards` › *Error Response Format* — RFC-7807…
- **rollback** — 1 chapter
  - `Deployment Checklist` › *Canary & Rollback* — 5% canary…
```

`terms[]` is keyed by **distinct term**, so it is O(V) in vocabulary, not O(N) in documents — a bundle with hundreds of articles but a few hundred real topics keeps a small table. That's the property that makes the deterministic search pass affordable.

## Document TOC (`toc/<docId>.md`)

Level 2. Same pattern, derived from one document's chapters.

```markdown
---
type: toc
document: api-design
title: API Design Rules
index_generated_at: 2026-10-09T00:00:00.000Z
chapters:
  - { id: endpoint-naming, title: Endpoint Naming Conventions,
      summary: "REST resource naming: plural nouns, no verbs, versioned paths.",
      concepts: [api-design, naming], status: stable }
  - { id: versioning, title: Versioning Strategy,
      summary: "URL-path versioning; additive-only…",
      concepts: [api-design, versioning], status: deprecated }
---
# API Design Rules — Contents

1. **Endpoint Naming Conventions** — REST resource naming… · `api-design` `naming`
2. **Versioning Strategy** — URL-path versioning… · `api-design` `versioning`
```

### Freshness

Both artifacts carry `index_generated_at`. `getModel()` compares it to the newest chapter `updated_at` in the bundle; a stamp older than the content (a hand edit, a git pull, another tool) triggers one rebuild on read. The same rebuild runs on every write path that can change them, so an export is always current.

## `raw/sources.json` — the provenance ledger

```jsonc
{
  "sources": {
    "https://engineering.example.com/handbook/api-design": {
      "sourceKey": "https://engineering.example.com/handbook/api-design",
      "rawFile": "raw/api-design.md",
      "docId": "api-design",
      "ingestedAt": "2026-08-01T00:00:00.000Z"
    }
  }
}
```

`sourceKey` is the normalized source: a URL lowercased on host, stripped of its fragment and trailing slash; a path as-is. Two jobs:

1. **Dedup** — `triggerIngest` looks here first. A hit returns the existing `docId` and starts no run.
2. **The "Open source" target** — the reader pane's link resolves to the document's original URL, falling back to the stored `raw/` path when it was ingested from a file.

## Inline-asset block

The on-disk shape, as written into a chapter body:

```markdown
![Canary rollout console](raw/assets/deployment/canary-rollback-demo.mp4)

> **Interpretation (LLM, at ingest):** Screen-capture of the deploy console: the canary pod set is bumped 0→5%, error-rate and p99 sparklines render live, and when the 5xx threshold trips an "Auto-rollback armed" banner appears and pods drain back to 0%.
```

- The path is **bundle-relative** (`raw/assets/…`).
- The blockquote's first line starts `**Interpretation` — that's the marker `extractAssets` parses on.
- A failed asset still gets a block, with the interpretation marked unavailable. `okf_lint` reports it; the document is not failed.

`okf_read_concept` returns `assets: [{path, caption, kind, interpretation, interpretationAvailable}]` alongside the full body, so a reader gets the stored interpretation without re-running vision.

## `links.json`

```jsonc
[{ "from": "api-design/versioning", "to": "deployment/canary", "label": "related" }]
```

`okf_add_link` writes the edge **twice**: as a markdown link under a `## Links` section in the source chapter's body (human-readable, OKF-portable) and here (cheap graph derivation). `okf_lint` reconciles drift between the two.

## Graph shape (derived, on read)

```jsonc
{
  "bundle": "engineering",
  "nodes": [
    { "id": "api-design", "type": "doc", "label": "API Design Rules" },
    { "id": "api-design/endpoint-naming", "type": "chap", "label": "Endpoint Naming Conventions" },
    { "id": "api-design", "key": "concept:api-design", "type": "concept", "label": "api-design", "count": 2 },
    { "id": "diego córdoba", "key": "person:diego córdoba", "type": "person", "label": "Diego Córdoba", "count": 1 }
  ],
  "edges": [
    { "from": "api-design", "to": "api-design/endpoint-naming", "kind": "containment", "label": "contains" },
    { "from": "api-design/endpoint-naming", "to": "api-design", "kind": "coverage", "label": "covers" },
    { "from": "water-rights", "to": "diego córdoba", "kind": "coverage", "label": "covers" },
    { "from": "api-design/versioning", "to": "deployment/canary", "kind": "link", "label": "related" }
  ]
}
```

Nothing here is stored. `containment` comes from `parent`, `coverage` from the concept index, `link` from `links.json`.

A node's `id` is what edges reference (a term's lowercased name); `key` is `"<type>:<id>"`, which disambiguates the one collision the id space allows — a document whose id is also a concept term. `person` is the 4th node type (ADR-011): same shape and same count-driven radius as `concept`, same `coverage` edge kind — a person's covering edge runs from the chapter they are the subject of, or from the **document** they authored.

## Job record

In-memory hot map, mirrored to `<bundleRoot>/.jobs/jobs.json`. Service-level, newest first, capped at 200.

```jsonc
{
  "id": "run-1042",
  "status": "queued | running | completed | cancelled | failed",
  "bundleId": "engineering",
  "source": "https://example.com/performance-budgets",
  "maxDepth": 1,
  "maxWorkers": 3,
  "queuedAt": "2026-10-09T11:58:00.000Z",
  "startedAt": "2026-10-09T11:58:01.000Z",
  "endedAt": "2026-10-09T12:03:11.000Z",
  "durationMs": 310000,
  "progress": null,
  "summary": {
    "chapters": 6, "concepts": 8, "assets": 1, "refsSkipped": 2, "refsFailed": 0,
    "written": [],
    "text": "Wrote 6 chapters…",
    "toolCalls": 41
  },
  "error": null,
  "runId": "sub-8f2c…",      // captured from the run's run_started event (FR-052)
  "cancelRequested": false  // a cancel that landed before the runId existed
}
```

- `progress` is advanced by the launcher from the run's `{type:"tool"}` stream lines, and may be enriched by the agent via `POST /jobs/<id> {progress}`. It is cleared on a terminal transition.
- `summary` exists on `completed`. The counts are read out of the agent's prose where it states them plainly; `text` keeps the report verbatim, and is the authority when a count reads 0 because the agent phrased it differently.
- `error` exists on `failed`, including the reaper's "stale" reason. It is **null on `cancelled`**: an intentional stop is not an error (FR-050).
- `runId` is the handle `okf_cancel_job` aborts by. It is null until the run emits `run_started`; a cancel arriving in that window sets `cancelRequested`, and the launcher fires the abort the moment the id arrives.
- `cancelled` is terminal, so the reaper never touches it and `okf_delete_job` accepts it.
- **Terminal states are final.** A late transition against a terminal job is a recorded no-op, never a resurrection.
- `.jobs/` is operational state, not OKF content: it is excluded from `okf_export_bundle`.

## Export shape

```jsonc
{
  "name": "engineering",
  "files": [{ "path": "concept-index.md", "content": "…" }, { "path": "toc/api-design.md", "content": "…" }],
  "assets": [{ "path": "raw/assets/deployment/canary.mp4", "bytes": 4210432, "contentType": "video/mp4" }],
  "conceptIndexIncluded": true,
  "tocsIncluded": 4
}
```

Derived artifacts are **regenerated before the export**, so the manifest always carries a correct `concept-index.md` and every `toc/<docId>.md` — re-importing reproduces a queryable bundle. Binary assets are listed by path and size, not inlined.

On import, the index is rebuilt **best-effort** and the result reports `indexNeedsRegeneration` when the imported chapters lack `parent`/`concepts`/`summary` — a pre-redesign or hand-rolled bundle is readable immediately and becomes fully searchable after a re-ingest, rather than being served as a silently half-built index.
