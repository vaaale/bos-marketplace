---
name: Ingest into an OKF knowledge base
description: The end-to-end flow for putting an article, document, or URL into an OKF knowledge base — what to call, in what order, and the mistakes that waste a lot of tokens.
when_to_use: When the user asks to ingest, add, save, or import something into a knowledge base / OKF bundle.
created_by: seed
---

You are the *orchestrating* agent. You do not write concepts yourself — a dedicated `okf-ingest` sub-agent does, and the service starts it for you. Your job is one call.

## Do this

**Call `okf_ingest` with whatever the user gave you** — a URL, a file path, a `raw/` path:

```
okf_ingest({bundle: "<name>", source: "https://example.com/article"})
```

It returns at once with one of:

- **`status: "queued"`** + a `jobId` — the run is queued and the service starts it when a slot is free (at most the service's `maxConcurrentRuns` run at a time). Nothing else for you to call. Follow it with `okf_list_jobs({jobId})`, or point the user at the app's **Jobs** tab: it ends `completed` with a summary, or `failed` with a reason. A run takes minutes — **do not wait for it in a loop** (no `sleep` via `run_command`, no repeated polling): tell the user it is running and where to watch it, and check once if they ask.
- **`status: "already_ingested"`** + the existing `docId` — the source is already in the bundle; no run started. Read it with `okf_read_toc({bundle, docId})`. **Only if the user asks to re-ingest it**, call again with `reingest: true`: the document is re-acquired from its origin and rewritten under the same id. The current version stays readable until the run completes, and a failed or cancelled run changes nothing; `raw/` keeps every version. (A source whose document is gone is never `already_ingested` — it is simply queued again.)

Several sources? Issue the `okf_ingest` calls together — the queue keeps them from all running at once. Re-ingesting a whole bundle is the app's **Re-ingest all** button (Overview → the bundle).

## The mistakes that cost the most

**Never retype a document to move it.** If you find yourself putting a document's text into a tool argument — `file_write`, `okf_add_raw_source({content})`, `okf_import_bundle` — stop. You are regenerating the whole thing token by token. Every acquisition tool takes an `output_path`: with it, content goes straight to disk and you get back a receipt. Then pass the *path*.

```
web_fetch({url, output_path: "/workspace/article.md"})   ✅ a receipt comes back
web_fetch({url}) → file_write({path, content: <30k chars>})  ❌ you just retyped the article
```

**`concept: null` is not a failure.** `okf_add_raw_source` returns `{rawFile, stored: true, concept: null}` when you didn't ask for a concept stub. The source *is* saved. Do not "fix" it by importing the content again — that overwrites a correct raw source with whatever you type, and the sub-agent then has nothing real to read.

**Don't reach for `okf_import_bundle`.** It writes literal file contents and is for restoring an exported bundle, not for ingesting a source. If the bundle doesn't exist yet, create it with `okf_init_bundle` first.

**Don't read the raw source yourself.** Once it's in `raw/`, its whole purpose is that the sub-agent reads it and you don't. Reading it back pulls the document into your context — the exact cost this flow exists to avoid.

## Multiple sources

Ingest calls are independent, so issue them together in one turn rather than one at a time; the service queues the runs. Same for the reference crawl: the sub-agent handles that itself, one hop shallower per reference, bounded by `maxDepth`. Don't crawl references yourself.

## Reporting back

Say what landed: bundle, concepts created/updated, references ingested or skipped. Take those numbers from the sub-agent's summary. Never paste the source text into your reply.
