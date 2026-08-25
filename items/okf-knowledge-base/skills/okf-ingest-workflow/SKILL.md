---
name: Ingest into an OKF knowledge base
description: The end-to-end flow for putting an article, document, or URL into an OKF knowledge base — what to call, in what order, and the mistakes that waste a lot of tokens.
when_to_use: When the user asks to ingest, add, save, or import something into a knowledge base / OKF bundle.
created_by: seed
---

You are the *orchestrating* agent. You do not write concepts yourself — a dedicated `okf-ingest` sub-agent does. Your job is to get the source into the bundle and hand off.

## Do this

**Call `okf_ingest` first, with whatever the user gave you** — a URL, a file path, anything:

```
okf_ingest({bundle: "<name>", source: "https://example.com/article"})
```

It never fetches or decomposes anything itself. It replies with the next calls to make:

- **`status: "acquisition_required"`** → run the `steps` array **in order, exactly as written**, then call `okf_ingest` again with the `rawFile` you got back.
- **`status: "delegation_required"`** → call `agent_delegate` with the `delegate` block verbatim. That is the last thing you do; the sub-agent takes it from there and reports back a summary.

That's the whole flow. Follow what it returns rather than composing your own equivalent — the arguments it specifies (particularly `output_path`) are what keep a long document out of your context.

## The mistakes that cost the most

**Never retype a document to move it.** If you find yourself putting a document's text into a tool argument — `file_write`, `okf_add_raw_source({content})`, `okf_import_bundle` — stop. You are regenerating the whole thing token by token. Every acquisition tool takes an `output_path`: with it, content goes straight to disk and you get back a receipt. Then pass the *path*.

```
web_fetch({url, output_path: "/workspace/article.md"})   ✅ a receipt comes back
web_fetch({url}) → file_write({path, content: <30k chars>})  ❌ you just retyped the article
```

**`concept: null` is not a failure.** `okf_add_raw_source` returns `{rawFile, stored: true, concept: null}` when you didn't ask for a concept stub. The source *is* saved. Do not "fix" it by importing the content again — that overwrites a correct raw source with whatever you type, and the sub-agent then has nothing real to read.

**Don't reach for `okf_import_bundle`.** It writes literal file contents and is for restoring an exported bundle, not for ingesting a source. If a bundle doesn't exist, `okf_ingest`'s steps already include `okf_init_bundle`.

**Don't read the raw source yourself.** Once it's in `raw/`, its whole purpose is that the sub-agent reads it and you don't. Reading it back pulls the document into your context — the exact cost this flow exists to avoid.

## Multiple sources

Ingest calls are independent, so issue them together in one turn rather than one at a time — parallel-safe tools genuinely run concurrently. Same for the reference crawl: the sub-agent handles that itself, bounded by the bundle's `maxDepth`/`maxWorkers`. Don't crawl references yourself.

## Reporting back

Say what landed: bundle, concepts created/updated, references ingested or skipped. Take those numbers from the sub-agent's summary. Never paste the source text into your reply.
