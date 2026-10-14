---
name: Look things up in an OKF knowledge base
description: How to use an OKF knowledge base as a source — choose the bundle, browse its table of contents or search its full text, read only the chapters that answer, and cite them.
when_to_use: When a question should be answered from a knowledge base (an OKF bundle) — "what do we know about…", "check this against the rules", "who is…", "find where…".
created_by: seed
---

A knowledge base answers from what it holds, and says so when it holds nothing. This is the procedure; follow it in order.

## 1. Choose the bundle

Use the bundle the user named. Otherwise `okf_list_bundles` and pick the one whose subject fits — bundles are the unit of scope: checking a design against a rules bundle means asking that bundle, not every bundle.

## 2. Find your way in — browse or search

**Browse** when the question is about a topic, or you want to see what the bundle holds:

- `okf_read_toc({bundle})` — the bundle's documents, newest first, each with a short summary of what it is about; 50 per page (`offset`/`limit`; `total` says how many there are). Read the summaries and pick the documents that could answer.

**Search** for a specific fact, name, number or phrase, or whenever the bundle is too large to browse:

- `okf_search({bundle, query})` — matches concept and person terms, titles, summaries and the **full text** of every chapter. Each hit says what matched (`matchKind`) and, for a full-text match, shows an `excerpt` of where. Hits that match more of your words come first.
- `okf_search({bundle, query, groupBy: "document"})` — one row per document with its best chapters beneath: "which documents cover this?".

## 3. Choose the chapters

For each candidate document, `okf_read_toc({bundle, docId})` — its chapters, each with a one-line summary and its terms. Pick the chapters that answer; skip the rest.

## 4. Read only those, in full

`okf_read_concept({bundle, id: "<docId>/<chId>"})` — the whole chapter, including any figure's stored interpretation. An excerpt or a summary shows *where* an answer is; it is never the answer. Read the chapter before you rely on it.

## 5. Answer, and cite

- Cite the chapters you used by id, and the original source — `okf_read_concept`'s `source` (a URL, or the stored `raw/` file).
- Each hit and chapter carries `status` and staleness: say so when you rely on something `deprecated` or stale ("this is marked stale since …").
- Keep what the knowledge base says apart from what you know yourself. Never pass your own knowledge off as the bundle's.

## When nothing comes back

An empty search is **not yet proof** the bundle lacks it. Rephrase once (other words, a name instead of a description, fewer words), and browse the bundle's table of contents. Only when both come up empty, say plainly that it is not in this bundle — and what you searched.

## What a lookup does not do

- It **writes nothing**: no `okf_upsert_concept`, no `okf_add_link`, no merging — those change the knowledge base and are the user's call.
- It starts no ingest. If the answer is missing and you know where it is, *offer* to ingest that source.
- It never reads `raw/` sources directly: the chapters are what the knowledge base vouches for.
