# Troubleshooting — OKF Knowledge Base

## The app says "Service unreachable"

The app is a window onto the Knowledge Base **service**; with the service stopped there is nothing to show.

1. **Settings → Plugins** — find *OKF Knowledge Base* and check it is running. Start it if it isn't.
2. If it was just installed or updated, give it a few seconds: the app polls for up to ~15 seconds while the service binds its port, then reports offline.
3. **Settings → Apps → OKF Knowledge Base** — the app needs the **`services:read`** capability. Without it, an app installed from a remote marketplace can't reach its own service and this is the error you get.
4. Still stuck? The service writes startup messages to its log in Settings → Plugins. A line like `could not pre-create bundleRoot` is harmless at startup; a repeated crash is not.

## My search returns nothing, but I can see the words in a chapter

**This is expected.** Search here is *concept-anchored*, not full text. It matches two things:

- the bundle's **concept terms** (its vocabulary), and
- the **one-line summary** stored for each chapter.

A phrase that appears only in a chapter's body matches neither. Options:

- Search a broader topic word instead of a phrase.
- Open **Overview → Concept Index** and read the actual vocabulary — then search a term you see there.
- If a chapter genuinely covers a topic its summary doesn't mention, that's a gap in the chapter, not in the search. Ask the assistant to improve it:
  > In the `engineering` KB, update `api-design/endpoint-naming`'s summary to mention versioned paths.

This trade is deliberate: it is what keeps retrieval cheap and explainable (every result tells you which concept matched), and it is why there is no vector database here.

## A bundle shows "this bundle's derived index is partial"

Its chapters are missing the `parent` / `concepts` / `summary` frontmatter the index is built from — almost always a bundle created before the redesign, or one imported from elsewhere.

Nothing was lost or rewritten: the content is all there and readable, the routing is just incomplete. To fix it, either re-ingest the sources, or ask the assistant to fill in the missing fields:

> For every chapter in the `legacy-kb` knowledge base that has no `concepts`, read it and set `concepts` and a one-line `summary`.

## An ingest run sits at "queued" or "running" forever

- **Queued** means the service recorded the run but the ingest agent hasn't started writing. If the assistant's turn ended without delegating, nothing is running — just ask again.
- **Running with no progress** is normal for a short document; the progress line is optional.
- **Running for a very long time** usually means the agent stopped without reporting. The next thing to check is the assistant's own transcript for that turn — it reports the delegation's outcome, and it marks the run failed when the delegation errors.

Nothing is left half-written either way: each file write is atomic and the index is rebuilt from content, so a dead run leaves the bundle consistent.

## An ingest failed

Open the run in **Jobs** and read the error. Common ones:

| Error | What it means |
|---|---|
| `Source unreachable (HTTP 4xx/5xx)` | The fetch failed before decomposition. Nothing was written. |
| `no such raw source: raw/…` | `okf_ingest` was called with a path that isn't in the bundle. Ingest the original URL or file path instead — it plans the acquisition for you. |
| `bundle not found` | Create the knowledge base first (Overview → **+ New Knowledge Base**). |

Retry by asking the assistant to ingest the same source again.

## A figure shows as "Interpretation unavailable"

The asset was recorded but couldn't be downloaded or interpreted at ingest. The chapter keeps the block (so you can see something is missing) and **Health → Lint** counts it under *Broken inline-asset links*. Re-ingesting the source retries it.

## Health shows index or TOC drift

Drift means the derived files no longer match the chapters — usually after editing files directly, a git pull, or another tool writing into the bundle. **Running the lint rebuilds them**, which is why the counts drop to zero after you press *Re-run lint*. Nothing is patched by hand; the index is regenerated from the chapters, which are the source of truth.

## I deleted a chapter and the concept term vanished

Expected. Concept terms aren't files — a term exists exactly as long as some chapter lists it in `concepts`. Delete the last chapter covering a term and the term leaves the index on the next rebuild.

## Two concept terms mean the same thing

Merge them from **Overview → Concept Index**: the layers button on a term opens a picker for the canonical term to keep. Or ask the assistant:

> In the `engineering` KB, merge the concept term `rate-limit` into `rate-limiting`.

Either way it rewrites every affected chapter's frontmatter; the index and the document TOCs follow automatically, because both are derived.

## Export / import

- **Export** regenerates the derived files first, so the manifest always carries a correct `concept-index.md` and every `toc/*.md`. The Import/Export tab reports both, so you can see it rather than assume it.
- **Import** takes a flat manifest or a VFS directory path. For a **git repo or a tarball**, ask the assistant to fetch and unpack it into the VFS first, then import that directory — the service has no shell of its own.
- Binary inline assets are listed by path in an export manifest rather than inlined; copy the directory to move them.

## Where to look when all else fails

The bundle is plain files at `/KnowledgeBase/<bundle>/` in the Files app. Chapters are under `concepts/`, sources under `raw/`, and the operational history is in `log.md`. If the app and the files disagree, the files are right — run a lint and the derived views catch up.
