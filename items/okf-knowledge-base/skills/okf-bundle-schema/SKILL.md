---
name: OKF bundle conventions
description: The ingest, query, and lint conventions for OKF knowledge bundles — concept granularity, frontmatter families, linking, and provenance.
when_to_use: When ingesting a source into an OKF bundle, querying one, or linting one.
created_by: seed
---

The conventions below are the defaults for every OKF bundle. A bundle's own `schema.md` (read it with `okf_read_bundle_schema`) overrides them wherever the two differ — that file is the bundle owner's voice, this skill is only the fallback.

## What a concept is

One concept = one idea someone would look up on its own. Not one document, not one paragraph.

- A source usually yields several concepts. Splitting a source into one concept is almost always too coarse.
- A concept that only makes sense as part of another concept isn't its own concept — fold it in.
- Match the granularity the bundle already uses. Read a few existing concepts before deciding.
- **Extend before you create.** Search first (`okf_find_concepts`). Two concepts covering the same idea is the single most damaging thing you can do to a bundle, and it's very hard to undo later.

## Frontmatter

Only `type` is strictly required. Beyond that there are three families that carry the bundle's real value:

| Family | Keys | Rule |
|---|---|---|
| Provenance | `sources` | Every machine-written concept cites where it came from. No exceptions. |
| Trust | `trust`, `verified` | `unverified` → `machine-confirmed` → `human-reviewed`. Machine-extracted content starts at `unverified`. Only a human moves a concept to `human-reviewed`. |
| Lifecycle | `status`, `stale_after` | `draft` / `stable` / `deprecated`. Set `stale_after` when the content has a real shelf life (versions, prices, roadmaps). |

**Unknown frontmatter keys are preserved verbatim on every write, and preserving them is not optional.** If you find a key you don't recognise, leave it exactly as it is — it belongs to someone, and dropping it is silent data loss.

## Links

Links are the graph. A concept with no inbound and no outbound links is nearly invisible to retrieval, however well written.

- Link a new concept to the existing concepts it relates to, in both directions where that's true.
- Use `okf_backlinks` / `okf_neighbors` to find where a new concept belongs before assuming it's unconnected.
- A link asserts a real relationship. Don't link two concepts merely because they came from the same source.
- A link to a concept that doesn't exist is a warning, not an error — but fix it rather than leaving it.

## Ingest

1. Read `schema.md`, then `index.md` — know the conventions and what's already covered.
2. Read the raw source from `raw/`. It stays there, immutable; `raw/` is append-only and never edited.
3. Decide boundaries; search for existing concepts on each.
4. Write concepts with provenance, trust, and lifecycle set.
5. Link them into the graph.
6. Update `index.md` if the bundle's conventions maintain one, and append to `log.md`.

## Query

Read `index.md` first, then drill into concepts and traverse links — don't grep blindly. Weigh what you find by its trust level and lifecycle status, and say so when it matters ("this is `unverified` and `stale_after` has passed"). Cite the concepts you used.

## Lint

Look for: contradictions between concepts, claims superseded by a newer source, concepts past `stale_after`, orphans with no inbound links, and raw sources that no concept cites. Report them; fix only what you were asked to fix.
