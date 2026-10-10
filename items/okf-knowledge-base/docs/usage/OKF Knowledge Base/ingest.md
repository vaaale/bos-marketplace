# Ingesting documents

Ingest is how knowledge gets in. You give it a source; it comes back as organized chapters you and the assistant can retrieve.

## Two ways to start a run

**From the app.** Open a bundle in **Overview** and press **Ingest**. Paste a URL, a file path, or a `raw/` path already in the bundle, and press **Start ingest**. You get a run id back immediately.

**From the assistant.** Ask it to ingest something, or let it call the tool directly:

```
okf_ingest({ bundle: "engineering-rules", source: "https://example.com/handbook/api-design" })
```

Both do the identical thing — the button and the tool run the same code and produce the same job record. Nothing is relayed through you: there is no call to copy, no step to hand off, no second tool to run afterwards.

The call returns in a moment with `{jobId, status: "queued"}`. **It does not wait for the run.** Your assistant's turn is free immediately; the ingest keeps going in the background.

## What a run actually does

The service launches a bundled, deliberately narrow agent called **okf-ingest** and watches it work. That agent:

1. **Acquires the source.** A URL is fetched; a PDF/DOCX/PPTX/XLSX is converted to Markdown; a text file is taken as-is. In every case the content streams straight to disk — it never passes through anyone's context as text, which is what keeps a 200-page PDF from costing what a 200-page PDF would cost.
2. **Registers it in `raw/`**, which is append-only. The original is kept, immutably, forever. Re-ingesting a changed source adds a new version; it never overwrites the old one.
3. **Splits it into chapters** at the source's own heading structure. A source with no headings becomes a single chapter — it won't invent an outline the author didn't write.
4. **Assigns concept terms and writes a one-line summary** for each chapter. It checks the bundle's existing vocabulary first, so terms grow by extension rather than by accumulating near-duplicates.
5. **Downloads and interprets inline assets.** For every non-HTML image or video in a chapter, it saves a local copy and writes an interpretation of what the diagram actually says or the clip actually shows, directly beneath the link in the chapter. Ordinary hyperlinks to web pages stay as links — only real artifacts are copied. This happens **once**, at ingest: reading the chapter later gives you the diagram's content with no vision call.
6. **Follows references**, within limits — by default one hop, three at a time. Each followed reference becomes **its own run** with its own job. Anything already in the bundle is skipped rather than re-fetched.
7. **Reports.** The document TOC and the bundle's concept index are rebuilt automatically as chapters are written; there's no separate indexing step.

## Watching a run

The **Jobs** tab lists every run, newest first, with a status dot and a live elapsed clock:

| Status | Means |
|---|---|
| **queued** | The run has been created and the agent is starting. Nothing has been written yet. |
| **running** | In progress. Expand the row for the progress line. |
| **completed** | Finished. The detail shows the summary cells — chapters, concepts, assets, references skipped, references failed — and the agent's own report. |
| **failed** | Stopped. The detail shows why. |

The assistant can see the same records:

```
okf_list_jobs({})                              all runs
okf_list_jobs({ jobId: "run-1042" })           just the one you started
okf_list_jobs({ bundle: "engineering-rules", status: "failed" })
```

This is how you follow up on an ingest: `okf_ingest` returns only a job id, so `okf_list_jobs` is what turns that id into an outcome.

**The run's final status is written by the service, not by the agent.** The service launched the run and watched it end, so a run that crashes, loops, or stops talking still gets an honest record — it doesn't sit "running" because an agent forgot to say it finished.

## Ingesting the same thing twice

You can't, by accident. Every bundle keeps a provenance ledger of what it has ingested. A source already in it returns `already_ingested` with the document it already is, and **no run starts**. The Ingest modal tells you the same thing.

To deliberately re-ingest a source that has genuinely changed, pass its `raw/` path directly. The new content is stored as a new version alongside the old.

## A partial run is still a success

If a run hits the reference-depth limit after three of eight references, that is a **completed** run reporting five skipped — not a failure. `failed` means the document didn't get ingested at all. The summary is written to be honest about the difference, so read the numbers rather than just the dot.

Likewise, a single asset that won't download or won't interpret is marked "interpretation unavailable" in the chapter and counted in the summary; it doesn't fail the document. `okf_lint` (Overview → Health) lists them later.

## Tuning a run

`maxDepth` (reference hops beyond the seed source; default 1, `0` = seed only) and `maxWorkers` (how many references at once; default 3) can be set per call:

```
okf_ingest({ bundle: "research", source: "https://…", maxDepth: 2, maxWorkers: 5 })
```

or changed as bundle-wide defaults in the service's settings. Raising depth on a heavily-cited source can start a lot of runs — raise it deliberately.
