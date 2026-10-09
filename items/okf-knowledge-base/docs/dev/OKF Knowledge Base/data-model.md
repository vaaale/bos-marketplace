# Data model — OKF Knowledge Base

Everything is plain Markdown with YAML frontmatter under the VFS. A bundle is a directory you can open in the Files app, grep, or commit to git with no tooling at all.

## Bundle layout

```
/KnowledgeBase/<bundle>/
├── index.md                 Human entry point + a derived "concepts covered" overview.
│                            Regenerated on write; the concept index is the authoritative
│                            routing artifact.
├── log.md                   Append-only operational history (init / ingest / merge / delete).
│                            Internal — there is no tool to write to it.
├── concept-index.md         DERIVED, level 1. The O(V) routing table. Frontmatter carries
│                            the machine-readable index; the body is a human listing.
├── toc/
│   └── <docId>.md           DERIVED, level 2. One per document: its chapters with
│                            descriptions and covered terms.
├── links.json               Sidecar: [{from, to, label}] for okf_add_link edges.
├── raw/                     IMMUTABLE (append-only, never edited or overwritten).
│   ├── <source>.md          Ingested sources (text / converted-document markdown).
│   ├── <source>.v2.md       A changed source re-registered: a NEW version; the old stays.
│   ├── sources.json         Provenance ledger (dedup + the "Open source" target).
│   └── assets/<docId>/      Downloaded non-HTML inline assets. Immutable.
└── concepts/                CANONICAL CONTENT — the source of truth.
    ├── <docId>.md           Document stub       type: document
    └── <docId>/<chId>.md    Chapter             type: section   ← the retrieval unit
```

Two invariants worth stating outright:

- **`concepts/` and `raw/` are the only source of truth.** `concept-index.md` and `toc/*.md` are views. Delete them and the next read regenerates them; edit them by hand and the next read overwrites your edit. That asymmetry is the point.
- **`raw/` is never edited.** A changed source becomes a new version file. An asset is written once.

A chapter is nested *under* its document (`concepts/api-design/endpoint-naming.md`), so "which chapters belong to this document" is one directory listing. `parent` is still carried in frontmatter — redundantly, deliberately — so the file is portable on its own and the graph derivation doesn't depend on path shape.

**Concept terms are not files.** A term exists exactly as long as some chapter lists it in `concepts`. That is why merging terms is a frontmatter rewrite and why deleting the last chapter covering a term removes it from the index with nothing to clean up.

## Chapter frontmatter (`type: section`)

```yaml
---
id: api-design/endpoint-naming        # == the path under concepts/
type: section
parent: api-design                    # the document (docId) this chapter belongs to
title: Endpoint Naming Conventions
concepts: [api-design, naming]        # the concept TERMS this chapter covers
summary: "REST resource naming: plural nouns, no verbs, versioned paths."
status: stable                        # draft | stable | deprecated
stale_after: 2026-12-01               # optional ISO date; stale once passed
verified: unverified                  # unverified | machine-confirmed | human-reviewed
sources:
  - id: api-design.md
    uri: https://engineering.example.com/handbook/api-design
created_at: 2026-08-01T00:00:00.000Z
updated_at: 2026-08-01T00:00:00.000Z
# unknown keys are preserved verbatim on every write
---
```

| Field | Role |
|---|---|
| `parent` | containment. Feeds the document TOC and the graph's `contains` edge. A chapter with no resolvable parent is an orphan `okf_lint` reports. |
| `concepts` | the index vocabulary. **No terms ⇒ unreachable by `okf_search`.** |
| `summary` | one line, used *twice*: as the description shown in the index and TOC, and as the text the deterministic match runs against. Its quality is the retrieval surface. |
| `status` / `stale_after` | lifecycle; drives `okf_stale_report` and the Health tab. |
| `verified` | the trust ladder. Machine-extracted content starts `unverified`; only a human sets `human-reviewed`. |
| `sources` | provenance. A `uri` that is an `http(s)` URL becomes the app's "Open source" target; otherwise the stored `raw/` path is. |

**Document stubs** (`type: document`) are the same shape minus `parent`/`concepts`, with a `title`, a one-line `summary`, `sources` and timestamps. `okf_read_concept` on a document id returns the stub; its chapter listing is `okf_read_toc`.

### Merge semantics

`okf_upsert_concept` shallow-merges `{...existing, ...patch}`, so **unknown keys survive every write**. Two exceptions, because a naive shallow merge would silently discard history:

- `sources` merges **by identity** (`id` or `uri`) rather than replacing the array.
- `attestations` **appends**.

The frontmatter parser/serializer is a dependency-free YAML subset. It round-trips every key and value — including nested arrays of objects, which is what the concept index's `terms[].covers[]` needs — but not comments or quoting style. It is not a byte-for-byte YAML round trip, and it isn't trying to be.

## Level 1 — `concept-index.md`

```markdown
---
type: concept-index
bundle: engineering
terms:
  - name: api-design
    count: 2
    covers:
      - docId: api-design
        docTitle: API Design Rules
        chId: endpoint-naming
        chTitle: Endpoint Naming Conventions
        description: "REST resource naming: plural nouns, no verbs, versioned paths."
        status: stable
        stale: false
      - docId: error-handling
        docTitle: Error Handling Standards
        chId: error-response
        chTitle: Error Response Format
        description: "RFC-7807 problem+json envelope with stable error codes."
        status: stable
        stale: false
    stale: false
index_generated_at: 2026-10-09T11:02:17.441Z
---
# Concept Index — engineering

*Derived from chapter frontmatter. Regenerable; not the source of truth.*

- **api-design** — 2 chapters
  - `API Design Rules` › *Endpoint Naming Conventions* — REST resource naming: plural nouns…
  - `Error Handling Standards` › *Error Response Format* — RFC-7807 problem+json envelope…
```

**Why `.md` with the data in frontmatter** rather than a JSON sidecar: the index must be a plain Markdown file inside the bundle (portable, greppable, present in an export), *and* it must be the machine-readable search input. A separate `concept-index.json` would be a second artifact to keep in sync — the exact failure the derived model exists to prevent. Frontmatter gives one regenerable file that is both.

**Size is O(V)** — keyed by distinct term, not by document or chapter. A bundle with hundreds of articles but a few hundred real topics keeps a small, cheap-to-route table. That is the property the retrieval contract rests on.

## Level 2 — `toc/<docId>.md`

```markdown
---
type: toc
document: api-design
title: API Design Rules
index_generated_at: 2026-10-09T11:02:17.441Z
updated: 2026-10-09T11:02:17.441Z
chapters:
  - id: endpoint-naming
    title: Endpoint Naming Conventions
    summary: "REST resource naming: plural nouns, no verbs, versioned paths."
    concepts: [api-design, naming]
    status: stable
---
# API Design Rules — Contents

1. **Endpoint Naming Conventions** — REST resource naming: plural nouns… · `api-design` `naming`
```

Same pattern, same regenerability. `okf_read_toc` returns this; a TOC whose document no longer exists is pruned on the next rebuild.

## Staleness and regeneration

Both levels carry `index_generated_at`. On read, `getModel()` compares it against the newest chapter `updated_at`:

- stamp newer than every chapter → serve the stored index
- any chapter newer, or no index at all → **rebuild from content**, write both levels, serve that

Writes rebuild eagerly too, so an export always carries a correct index. The read-through path is the repair mechanism for anything that changed the bundle outside the service — a git pull, an editor, another tool — and it is why a pre-redesign bundle with no `concept-index.md` simply grows one on first read instead of needing a migration.

The stored index is also shape-validated before it is trusted: terms must be objects with a `name` and a `covers` array, or the model is derived from content instead. A hand-edited or third-party-written index can't mis-route queries.

### Pre-redesign chapters

The old model stored `title`/`status`/`verified`/`sources` — no `parent`, `concepts` or `summary`. Classification handles that **best-effort and non-destructively**:

| Situation | Read as |
|---|---|
| `type: document` | a document |
| `type: section`, or carries `parent` | a chapter of that document |
| legacy, id has a prefix (`ai/attention`) | a chapter of document `ai` (synthesised if no stub exists) |
| legacy, flat id | a document with no chapters |
| terms | `concepts`, else `tags`, else `topics`, else none |
| description | `summary`, else `description`, else the first line of prose |

Nothing is rewritten. `indexNeedsRegeneration` is reported on bundle health, on import, and in the app's banner, so the user is told routing is partial rather than shown a confident-looking index that isn't complete.

## `raw/sources.json` — the provenance ledger

```json
{
  "sources": {
    "https://engineering.example.com/handbook/api-design": {
      "rawFile": "raw/api-design.md",
      "docId": "api-design",
      "originUrl": "https://engineering.example.com/handbook/api-design",
      "ingestedAt": "2026-10-09T11:00:03.218Z",
      "sourceKey": "https://engineering.example.com/handbook/api-design"
    }
  }
}
```

Keys are normalized (lowercased host, no fragment, no trailing slash) so trivially different URLs for the same page dedupe. Two jobs:

1. **Dedup** — `okf_ingest` returns `already_ingested` with the existing `docId` instead of creating a duplicate document.
2. **"Open source"** — the app resolves the document's original URL from here and from `sources` frontmatter, falling back to the stored `raw/` path.

Assets are recorded too, with `kind: "asset"`.

## The inline-asset block

```markdown
![Request lifecycle & correlation-ID propagation](raw/assets/error-handling/correlation-flow.png)

> **Interpretation (LLM, at ingest):** Flow diagram: an inbound request enters the gateway where
> a req_id is minted, then injected into the X-Request-Id header, the structured-log context, the
> downstream RPC context, and the queue envelope. Every log line and child span carries the same
> req_id, so one grep reconstructs the cross-service trace.
```

Rules the parser enforces:

- the image target is **bundle-relative** and starts `raw/` (a `../../raw/…` form is accepted and normalized; an `http(s)` target is a remote reference, not a stored asset)
- the interpretation is the blockquote run immediately following, whose first line starts `**Interpretation`
- a block whose interpretation is missing or begins "Interpretation unavailable" is reported by `okf_lint` rather than silently passing

The layering is Karpathy's: bytes in `raw/` (immutable), the interpretation as LLM-written wiki text, the markdown link as the edge. Because the interpretation is **stored text written once at ingest**, `okf_read_concept` hands an agent the diagram's knowledge with no vision call at query time — and `okf_search`'s deterministic pass could not have run vision anyway.

## Job records — `<bundleRoot>/.jobs/jobs.json`

```jsonc
{
  "seq": 1042,
  "jobs": [{
    "id": "run-1042",
    "status": "queued | running | completed | failed",
    "bundleId": "engineering",
    "source": "raw/performance-budgets.md",
    "queuedAt": "2026-10-09T11:58:00.000Z",
    "startedAt": "2026-10-09T11:58:04.112Z",
    "endedAt": null,
    "durationMs": null,
    "progress": "Interpreting raw/assets/…/perf-chart.png · writing 3 of 6 chapters",
    "summary": { "chapters": 6, "concepts": 8, "assets": 1,
                 "refsSkipped": 2, "refsFailed": 0, "written": ["…"] },
    "error": null
  }]
}
```

**Service-level, not bundle-level**: the Jobs tab is global, and a run must survive its target bundle being deleted mid-flight. **Operational state, not OKF content** — excluded from `okf_export_bundle`. Capped at 200 records. **Terminal states are final**, so a late callback can't resurrect a finished run — which is what makes it safe for both the sub-agent and the assistant's safety net to report the same run.

## Path safety

Every path operation goes through `safeJoin`, which resolves and verifies the result stays under its root. Bundle names match `^[A-Za-z0-9][A-Za-z0-9._-]*$`; concept ids allow `/` (chapters are nested) but reject `..`, leading `/`, and anything outside `[A-Za-z0-9._/-]`. Asset paths must start `raw/` and resolve inside the bundle. A traversal attempt throws before any read or write is attempted — including through the app's asset-proxy route.
