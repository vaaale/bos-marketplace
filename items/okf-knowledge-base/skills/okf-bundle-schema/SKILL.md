---
name: OKF bundle conventions
description: The ingest and lint conventions for OKF knowledge bundles (querying one is the okf-lookup skill) — chapter decomposition, concept-term assignment, person extraction, one-line summaries, the inline-asset block, and how the two-level derived index is maintained.
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
├── .chunks/<docId>/      OPERATIONAL — the mechanical pre-split of one source
│   └── NNN.md            001.md, 002.md, … one bounded chunk each; a derived
│                         cache, excluded from export, cleared on re-ingest
├── raw/                  immutable sources (append-only, never edited)
│   ├── sources.json      provenance ledger: source → raw file, docId, ingestedAt
│   └── assets/<docId>/   downloaded non-HTML inline assets (immutable)
└── concepts/
    ├── <docId>.md        document stub      — type: document
    └── <docId>/<chId>.md chapter            — type: section  ← the retrieval unit
```

`.chunks/` is **operational**, like the service's job records — not OKF content. It holds a mechanical re-cut of a source whose bytes already live byte-exact in `raw/`, so it is excluded from `okf_export_bundle`, invisible to `okf_list_bundles`/health/`okf_lint`, and it is **cleared and rewritten** when a source is re-ingested. The append-only rule covers `raw/`; it does not cover a cache.

**Only the `concepts/` files and `raw/` are the source of truth.** `concept-index.md` and every `toc/*.md` are *derived* from chapter frontmatter and rebuilt by the service on every write. You never hand-edit them, and they can never be the only place something is recorded. If they drift (a git merge, an external editor), `okf_lint` rebuilds them from the content.

## A chapter is the unit

One chapter = one section a human would look up on its own.

- **Split at the source's own section structure.** The author already decided where the ideas divide; respect that rather than imposing your own outline. The service has already found those sections — the `headings` list in each chunk — including the numbered and conventional section titles of a document with no Markdown `#` headings (a converted PDF). If what it found does not match the document, merge or use `whole`; never rebuild or re-type the source to add headings.
- A fragment that only makes sense inside its neighbour isn't its own chapter — fold it in.
- Match the granularity the bundle already uses. Read an existing TOC before deciding.
- **Extend before you create.** Query the vocabulary first — `okf_list_concepts({bundle, query: "<part of the term>"})`; it is paged, and a large bundle's whole vocabulary is thousands of terms. Two chapters covering the same idea under two near-identical terms is the single most damaging thing you can do to a bundle's routing, and only `okf_merge_concepts` can undo it.

## Chapter frontmatter

```yaml
---
id: api-design/endpoint-naming        # == the path under concepts/
type: section                         # section (chapter) | document (stub)
parent: api-design                    # the document this chapter belongs to
title: Endpoint Naming Conventions
concepts: [api-design, naming]        # the concept TERMS this chapter covers
person_terms: [Diego Córdoba]         # salient PERSONS — parallel to concepts
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

(`person_terms` is the fourth retrieval-bearing field, and it is optional — see **Person terms** below.)

Everything else is ordinary frontmatter, and **unknown keys are preserved verbatim on every write — preserving them is not optional.** If you find a key you don't recognise, leave it exactly as it is: it belongs to someone, and dropping it is silent data loss.

Lifecycle, trust and provenance are *also* just frontmatter on `okf_upsert_concept` (merge-on-fields). There are no separate setter tools: `status`/`stale_after` for lifecycle, `verified` for the trust ladder (`unverified` → `machine-confirmed` → `human-reviewed`; machine-extracted content starts `unverified` and only a human moves it to `human-reviewed`), `sources` for provenance. Set them in the same call that writes the chapter.

## Concept terms

A concept term is **not a file** — it is a key in `concept-index.md`, derived from the `concepts` arrays you write. So:

- Terms are lowercase, hyphenated, and name a *topic*, not a document (`rollback`, `rate-limiting`, `api-design` — not `the-deployment-doc`).
- Two to four per chapter is usually right. One is often too coarse to route; eight means the chapter is doing too much.
- The vocabulary grows organically. That is intended — but check it first (`okf_list_concepts({bundle, query})`) so it grows by extension, not duplication.
- Near-duplicates are fixed with `okf_merge_concepts`, which rewrites every affected chapter's `concepts` **and `person_terms`** (a person term is a term — merging "D. Córdoba" into "Diego Córdoba" rewrites both arrays), then the index and TOCs follow from the rebuild.
- A term that names a **person** does not follow the lowercase-hyphenated rule and does not live in `concepts` — see **Person terms** below.

## Person terms — `person_terms`, parallel to `concepts`

A bundle is about **topics** and, often, about **people**. Both are terms in the same derived index; a person's term simply carries `kind: person`. Nothing else differs — same index, same `okf_search`, same covering rows.

**Who is salient.** Two groups, and no more:

- **The author — always.** Registered at **document** level, on the document stub's `person_terms`.
- **Named key figures who are *subjects* of the content.** Registered at **chapter** level, on the `person_terms` of the chapters they are the subject of.

Not every name that appears. Someone quoted in passing, cited in a footnote, or listed in a reference is **not** salient; registering them floods the vocabulary with people the bundle isn't actually about.

**Where it goes.** `person_terms` is a frontmatter array — a **sibling of `concepts`**, same shape (an array of strings) — on the chapter stub and/or the document stub:

```yaml
# concepts/water-rights.md — the document stub: the AUTHOR
person_terms: [Diego Córdoba]

# concepts/water-rights/history.md — a chapter: a named KEY FIGURE
concepts: [water-rights, andean-history]
person_terms: [María Quispe]
```

**Never in `concepts`.** They are parallel arrays. If you are genuinely unsure whether someone is salient, `concepts` is the safe default — a person's name there is still searchable, it is just tagged `topic` instead of `person`. What you must not do is put the same name in both and hope.

**Reusing a person across chapters.** Add the name to **each** relevant chapter's `person_terms`, plus the document stub's when they are the author. The derived index consolidates every mention into **one** term with `kind: person`, whose `count` is the number of covering chapters/documents — exactly how a topic term consolidates.

**Original case.** Write the name as the source writes it — "Diego Córdoba", not "diego-córdoba". The service lowercases internally for kind derivation and for search matching (so `Diego`, `Córdoba` and `diego córdoba` all hit), and keeps your spelling as the display name. This is the one place the lowercase-hyphenated term rule does **not** apply.

**It is derived, never stored by hand.** You write `person_terms`; the service derives the `kind` on every index rebuild. There is no per-person file, no second place to keep in sync, and nothing to migrate — a bundle with no `person_terms` is simply all-`topic`.

## The inline-asset block

For every **non-HTML** asset in a chapter's scope: download a local immutable copy into `raw/assets/<docId>/`, interpret it with `view_image` / `video_keyframes`, and hand the interpretation to the chapter write as an `interpretations` entry (see *The chapter write protocol*). What ends up **stored** is the link with the interpretation directly beneath it:

```markdown
![Canary rollout console](raw/assets/deployment/canary-rollback-demo.mp4)

> **Interpretation (LLM, at ingest):** Screen-capture of the deploy console: the canary pod set is bumped 0→5%, error-rate and p99 sparklines render live, and when the 5xx threshold trips an "Auto-rollback armed" banner appears and pods drain back to 0%. The clip demonstrates that rollback is automatic and threshold-gated, not a manual step.
```

- The path is **bundle-relative** (`raw/assets/…`) — and on an ingested chapter the **service** writes that line, from the `assetLine` you copied out of the chunk. You pass `{assetLine, interpretation}`; you never compose the block.
- The blockquote's first line starts `**Interpretation` — that is what makes it parse as the asset's interpretation rather than an ordinary quote.
- **Ordinary HTML hyperlinks stay remote references.** Only non-HTML artifacts become local copies.
- A failed download or interpretation still gets a block, marked unavailable, and is counted in the run summary. It does not fail the document.

The point is that the interpretation is written **once, at ingest, as stored text**: retrieving the chapter later hands an agent the diagram's knowledge with no vision call at query time. Skipping it loses that knowledge from retrieval entirely.

## Ingest

1. Read the conventions (this skill; the bundle's `schema.md` if it has one) and `okf_list_concepts({bundle, query})` for each topic you are about to tag.
2. **Acquire the source with `output_path` pinned.** URL → `web_fetch({url, output_path})`; PDF/DOCX/PPTX/XLSX → `file_to_markdown({path, output_path})`; plain text → straight to `okf_add_raw_source({sourcePath})`. Then `okf_add_raw_source` registers it into `raw/`, which is append-only and never edited. Dropping `output_path` and passing the document back as `content` re-emits the whole thing as output tokens — it is the one mistake that makes this pipeline pointless.
3. **Read the source one chunk at a time** — see *Chunks* below. `okf_add_raw_source`'s response carries `chunks`; read those, not the whole `rawFile`.
4. Decide chapter boundaries at the sections the service found — each chunk's `headings` list. Only a source where it found none is one chapter (`{whole: true}`).
5. Upsert the document stub (`type: document`, with the original URL in `sources`, and the **author** in `person_terms`), then each chapter with `parent` / `concepts` / `summary` — plus `person_terms` for any named key figure the chapter is about. A chapter that came from a source is written **metadata-only**, with a `sourceRange` instead of a body: see *The chapter write protocol*.
6. Download, interpret and inline every non-HTML asset.
7. Link new chapters to the existing ones they genuinely relate to.
8. Finish with an honest summary (below).

The service rebuilds `concept-index.md` and `toc/<docId>.md` on every write. There is no manual index step.

### Chunks — the source arrives pre-split, and is read one piece at a time

`okf_add_raw_source` registers the bytes into `raw/` **and** splits them mechanically into `.chunks/<docId>/NNN.md`, bounded by the service's `maxChunkSize` (default 32000 characters, ~8K tokens). The split is at heading boundaries first, then paragraphs inside an oversized section, then sentences inside an oversized paragraph. No model is involved; nothing is summarised or dropped.

The response carries the id and the paths. **The `docId` it returns is the document's one id** — derived by the service from the source's real origin (`originUrl`, else the source path), stable across re-ingests, and already used to key `.chunks/<docId>/` and the `raw/sources.json` entry. Write the stub (`concepts/<docId>.md`), the chapters (`<docId>/<chId>`, `parent: <docId>`) and therefore the TOC (`toc/<docId>.md`) under that exact id; a second id coined for the stub leaves the TOC empty.

```json
{ "rawFile": "raw/numerical-methods.md", "docId": "numerical-methods", "maxChunkSize": 32000,
  "chunks": [ {"path": ".chunks/numerical-methods/001.md", "ordinal": 1, "total": 12 },
              {"path": ".chunks/numerical-methods/002.md", "ordinal": 2, "total": 12 } ] }
```

Each chunk file is a normal frontmatter document:

```markdown
---
chunk: 3
total: 12
headingPath:
  - "Part II: Numerical Methods"
  - "Section 4: Spectral Methods"
headings:
  - 11
  - 12
---
## Section 4: Spectral Methods

…the chunk's markdown…
```

**The protocol:**

1. `file_read` chunk `001.md`, decompose **it** into chapters, write them with `okf_upsert_concept`.
2. Then `002.md`. Then `003.md`. **One at a time, in order** — never read several ahead, and never read the whole `rawFile` when `total > 1`. That single call is what exhausts the run's context before a chapter is written.
3. Write the **document stub after the first chunk** (by then the title, author and shape are known).
4. Write the **TOC after the last chunk**, and let the index rebuild then — the whole-document work happens once, at the end, not once per chunk.

**`headings` is the chunk's reference vocabulary.** It lists the **global** indices — into the document's heading map, `.chunks/<docId>/headings.json` — of the headings *in* this chunk plus the one immediately *after* it. Those integers are how a chapter write names its part of the source (*The chapter write protocol*). They are global, not chunk-local, so a `toHeading` merge and a section that runs past the chunk boundary both resolve correctly. Never count headings yourself and never re-type heading text: copy an index out of this list.

**`headingPath` is positional context, not a chapter list.** It is the stack of headings open at that point in the document, deepest last, so you know where you are without having re-read what came before. A chunk is a **context window**: the chapter decomposition is still yours, one chunk may contain several chapters, and a section split across two chunks is still **one** chapter — carry it and write it once, when its last piece has been read.

A source that fits inside `maxChunkSize` comes back as a **single chunk** with an empty `headingPath` — identical handling, no special case.

### The chapter write protocol — metadata in, body assembled by the service

A chapter extracted from an ingested source is written **without its body**. The body already exists, byte-for-byte, at `raw/<source>.md`; re-emitting it as output tokens is the dominant cost of an ingest run and the longest event-less generation in it. So the agent emits what it **authored** and the service assembles the file:

> **authored frontmatter + verbatim body slice + inserted interpretations** — and removing the interpretations leaves a byte-exact slice of `raw/<source>.md`. That invariant is the contract; it is what makes "the service wrote the body" safe to trust.

```json
{"bundle": "kb", "id": "<docId>/<chId>",
 "sourceRange": {"startHeading": 11},
 "frontmatter": {"type": "section", "parent": "<docId>", "title": "…", "concepts": ["…"],
                 "person_terms": ["…"], "summary": "one line", "status": "draft", "sources": [{"id": "…", "uri": "…"}]},
 "interpretations": [{"assetLine": "![Canary rollout console](https://cdn.example.com/canary-rollback-demo.mp4)",
                      "interpretation": "Screen-capture of the deploy console: …"}]}
```

**`sourceRange`** — integers and a rule, never heading text:

| shape | means |
| --- | --- |
| `{startHeading: n}` | from heading `n` to just before the next heading of the **same or a higher level** (`nextSameOrHigher`, the default end rule) — the normal one-heading-one-chapter case |
| `{startHeading: n, toHeading: m}` | from heading `n` up to (not including) heading `m` — how two or more short sections are **merged** into one chapter |
| `{whole: true}` | the entire source — the **no-heading** single-chapter case |
| `{startHeading: -1}` | the **preamble**, everything before the first heading |

`n` and `m` are always copied from the reading chunk's `headings:` list. The end rule is resolved against the whole source, so a section split across chunks is still one chapter with one `startHeading`.

**`interpretations`** — `[{assetLine, interpretation}]`, one entry per inline asset. `assetLine` is the asset's markdown line **verbatim from the source** (original URL included); the `blockTemplate` returned by `okf_add_raw_source` / `addRawAsset` is the reference for that string, not body to compose. The service matches it in the slice, links the stored local copy at `raw/assets/<docId>/<name>`, and inserts the interpretation blockquote beneath it. If the line cannot be matched the interpretation is appended behind an `<!-- interpretation: … -->` marker that `okf_lint` reports — it is never dropped.

**One `okf_upsert_concept` call per chapter**, never batched: each call is both a bounded output and a liveness event for the run's inactivity timer. `body` stays available for a chapter genuinely **authored** rather than extracted; when `sourceRange` is present the body is extracted and any `body` passed alongside it is ignored. No tool is added for any of this — `okf_upsert_concept` simply accepts two more optional fields.

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

Using a bundle as a source — browsing it, searching it, reading what answers, and citing it — is the **`okf-lookup`** skill. Load it (`skill_load okf-lookup`) rather than improvising: it is the one place that procedure lives.

## Lint

`okf_lint` checks what the derived model can actually get wrong:

- **concept-index / document-TOC drift** from the underlying chapters — rebuilt, not patched.
- **broken inline-asset links** (a chapter points at a `raw/` asset that isn't there).
- **orphan chapters** with no document stub.
- **`links.json` vs. markdown-link drift** (`okf_add_link` writes both).
- chapters missing `concepts` or `summary` — stored but unreachable.

Report what it finds; fix only what you were asked to fix. Contradictions between chapters, and claims a newer source supersedes, are *reasoning* work — lint can't see them, so look for them yourself when you're asked to review a bundle.
