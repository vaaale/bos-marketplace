---
name: OKF bundle conventions
description: The ingest, query and lint conventions for OKF knowledge bundles — chapter decomposition, concept-term assignment, one-line summaries, the inline-asset block, and how the two-level derived index is maintained.
when_to_use: When ingesting a source into an OKF bundle, querying one, or linting one.
created_by: seed
---

These are the defaults for every OKF bundle. A bundle may carry its own `schema.md` — if it does, read it and let the bundle's voice win wherever the two differ. (There is no `okf_read_bundle_schema` tool any more: conventions live here, in the skill, and a per-bundle override is just a file you `file_read`.)

## The shape of a bundle

```
/KnowledgeBase/<bundle>/
├── index.md              human entry point (derived overview; regenerated on write)
├── log.md                append-only operational history
├── concept-index.md      DERIVED level 1 — concept term → covering (doc, chapter, description)
├── toc/<docId>.md        DERIVED level 2 — one document's chapters, descriptions, concept terms
├── links.json            machine-readable okf_add_link edges
├── raw/                  immutable sources (append-only, never edited)
│   ├── sources.json      provenance ledger: source → raw file, docId, ingestedAt
│   └── assets/<docId>/   downloaded non-HTML inline assets (immutable)
└── concepts/
    ├── <docId>.md        document stub      — type: document
    └── <docId>/<chId>.md chapter            — type: section  ← the retrieval unit
```

**Only the `concepts/` files and `raw/` are the source of truth.** `concept-index.md` and every `toc/*.md` are *derived* from chapter frontmatter and rebuilt by the service on every write. You never hand-edit them, and they can never be the only place something is recorded. If they drift (a git merge, an external editor), `okf_lint` rebuilds them from the content.

## A chapter is the unit

One chapter = one section a human would look up on its own.

- **Split at the source's own heading structure.** The author already decided where the ideas divide; respect that rather than imposing your own outline. A source with no headings is one chapter.
- A fragment that only makes sense inside its neighbour isn't its own chapter — fold it in.
- Match the granularity the bundle already uses. Read an existing TOC before deciding.
- **Extend before you create.** `okf_list_concepts` first. Two chapters covering the same idea under two near-identical terms is the single most damaging thing you can do to a bundle's routing, and only `okf_merge_concepts` can undo it.

## Chapter frontmatter

```yaml
---
id: api-design/endpoint-naming        # == the path under concepts/
type: section                         # section (chapter) | document (stub)
parent: api-design                    # the document this chapter belongs to
title: Endpoint Naming Conventions
concepts: [api-design, naming]        # the concept TERMS this chapter covers
summary: "REST resource naming: plural nouns, no verbs, versioned paths."
status: stable                        # draft | stable | deprecated
stale_after: 2026-12-01               # optional ISO date; stale once passed
sources:
  - id: api-design.md
    uri: https://engineering.example.com/handbook/api-design
created_at: 2026-08-01T00:00:00.000Z
updated_at: 2026-08-01T00:00:00.000Z
---
```

**Three fields carry the whole retrieval contract:**

| Field | Why it matters |
|---|---|
| `parent` | Makes the chapter part of a document — the TOC and the graph's `contains` edge come from it. A chapter with no parent is an orphan `okf_lint` reports. |
| `concepts` | The index vocabulary. **A chapter with no `concepts` is unreachable by `okf_search`** — it is stored, and invisible. |
| `summary` | One line. It is BOTH the description a user reads in the index/TOC and the text the deterministic match runs against. Write what someone searching would actually type; don't restate the title. |

Everything else is ordinary frontmatter, and **unknown keys are preserved verbatim on every write — preserving them is not optional.** If you find a key you don't recognise, leave it exactly as it is: it belongs to someone, and dropping it is silent data loss.

Lifecycle, trust and provenance are *also* just frontmatter on `okf_upsert_concept` (merge-on-fields). There are no separate setter tools: `status`/`stale_after` for lifecycle, `verified` for the trust ladder (`unverified` → `machine-confirmed` → `human-reviewed`; machine-extracted content starts `unverified` and only a human moves it to `human-reviewed`), `sources` for provenance. Set them in the same call that writes the chapter.

## Concept terms

A concept term is **not a file** — it is a key in `concept-index.md`, derived from the `concepts` arrays you write. So:

- Terms are lowercase, hyphenated, and name a *topic*, not a document (`rollback`, `rate-limiting`, `api-design` — not `the-deployment-doc`).
- Two to four per chapter is usually right. One is often too coarse to route; eight means the chapter is doing too much.
- The vocabulary grows organically. That is intended — but check it first (`okf_list_concepts`) so it grows by extension, not duplication.
- Near-duplicates are fixed with `okf_merge_concepts`, which rewrites every affected chapter's `concepts`, then the index and TOCs follow from the rebuild.

## The inline-asset block

For every **non-HTML** asset in a chapter's scope: download a local immutable copy into `raw/assets/<docId>/`, interpret it with `view_image` / `video_keyframes`, and write the link with the interpretation directly beneath:

```markdown
![Canary rollout console](raw/assets/deployment/canary-rollback-demo.mp4)

> **Interpretation (LLM, at ingest):** Screen-capture of the deploy console: the canary pod set is bumped 0→5%, error-rate and p99 sparklines render live, and when the 5xx threshold trips an "Auto-rollback armed" banner appears and pods drain back to 0%. The clip demonstrates that rollback is automatic and threshold-gated, not a manual step.
```

- The path is **bundle-relative** (`raw/assets/…`).
- The blockquote's first line starts `**Interpretation` — that is what makes it parse as the asset's interpretation rather than an ordinary quote.
- **Ordinary HTML hyperlinks stay remote references.** Only non-HTML artifacts become local copies.
- A failed download or interpretation still gets a block, marked unavailable, and is counted in the run summary. It does not fail the document.

The point is that the interpretation is written **once, at ingest, as stored text**: retrieving the chapter later hands an agent the diagram's knowledge with no vision call at query time. Skipping it loses that knowledge from retrieval entirely.

## Ingest

1. Read the conventions (this skill; the bundle's `schema.md` if it has one) and `okf_list_concepts` to see the existing vocabulary.
2. **Acquire the source with `output_path` pinned.** URL → `web_fetch({url, output_path})`; PDF/DOCX/PPTX/XLSX → `file_to_markdown({path, output_path})`; plain text → straight to `okf_add_raw_source({sourcePath})`. Then `okf_add_raw_source` registers it into `raw/`, which is append-only and never edited. Dropping `output_path` and passing the document back as `content` re-emits the whole thing as output tokens — it is the one mistake that makes this pipeline pointless.
3. Read the raw source from `raw/` with `file_read`.
4. Decide chapter boundaries at the source's headings. No headings = one chapter.
5. Upsert the document stub (`type: document`, with the original URL in `sources`), then each chapter with `parent` / `concepts` / `summary`.
6. Download, interpret and inline every non-HTML asset.
7. Link new chapters to the existing ones they genuinely relate to.
8. Finish with an honest summary (below).

The service rebuilds `concept-index.md` and `toc/<docId>.md` on every write. There is no manual index step.

### Dedup — do not ingest the same thing twice

`raw/sources.json` is the bundle's provenance ledger: normalized source key → `{rawFile, docId, ingestedAt}`. Every ingest consults it first.

- A source already in the ledger returns `already_ingested` with the existing `docId`, and **no run is started**. That is the correct outcome, not an error — read what is there.
- Before following a reference, check the ledger the same way. Skip-and-report beats re-fetch.
- Re-ingest only when the source genuinely **changed**: pass its `raw/` path directly. `raw/` is append-only, so the new content lands as `<base>.v2.<ext>` and the old bytes stay exactly as they were.
- An asset is deduped by its own URL under `raw/assets/<docId>/` on the same rule.

### Who finalizes a run

**Not the agent.** The service launches the ingest run and watches its stream, and writes the job's terminal state (`completed` / `failed`) from the run's own completion signal. There are no lifecycle callbacks to post. A `POST /jobs/<id>` with `{"progress": "…"}` is accepted as optional narration for the progress bar and is the only thing that route takes.

### Report honestly

The agent's final message becomes the run's report in the Jobs tab, so it has to be true:

- chapters written vs. extended, concept terms assigned (flagging any coined rather than reused), assets interpreted and failed, references ingested and skipped with a one-word reason.
- State counts plainly and in numerals — the service reads them out of the prose to fill the summary cells.
- **A partial-but-honest run is a success.** Hitting the depth limit after three of eight references is a finished job with five skipped, not a failure. `failed` means the document did not get ingested at all. A summary implying full coverage when there wasn't is worse than no summary.
- Never echo the source text back.

## Query

1. **`okf_search(bundle, query)` first.** It returns TOC rows — document, chapter, one-line description, and the concept term that matched. The match is deterministic and concept-anchored: it runs over the vocabulary and the stored descriptions, **not full text**.
2. **An empty result is a real answer.** It means nothing in the vocabulary matched, not that the bundle is empty. Widen the query, or read the vocabulary with `okf_list_concepts` and route semantically from there. Never invent a row.
3. Then fetch **full** content: `okf_read_toc(docId)` for a document's chapter list, `okf_read_concept(id)` for the entire chapter or document. Retrieval is whole documents or whole chapters — never a snippet.
4. Weigh what you find by its `status` and `stale_after`, and say so when it matters ("this is `deprecated` and `stale_after` has passed"). Cite the chapters you used by id.
5. Scope matters: search the bundle that holds the knowledge you want. Bundles are the unit of curation *and* of retrieval scope — checking a design against a rules bundle means querying that bundle, not everything.

## Lint

`okf_lint` checks what the derived model can actually get wrong:

- **concept-index / document-TOC drift** from the underlying chapters — rebuilt, not patched.
- **broken inline-asset links** (a chapter points at a `raw/` asset that isn't there).
- **orphan chapters** with no document stub.
- **`links.json` vs. markdown-link drift** (`okf_add_link` writes both).
- chapters missing `concepts` or `summary` — stored but unreachable.

Report what it finds; fix only what you were asked to fix. Contradictions between chapters, and claims a newer source supersedes, are *reasoning* work — lint can't see them, so look for them yourself when you're asked to review a bundle.
