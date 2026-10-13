# Troubleshooting

## "I know it's in there, but search returns nothing"

This is the one that surprises people, so it's first.

**Search is concept-anchored, not full-text.** It matches your query against two things only: the bundle's **concept term names**, and the **one-line summary** stored for each chapter. It does not scan chapter bodies. A query that paraphrases something buried in a paragraph, using words that appear neither in the vocabulary nor in any summary, correctly returns nothing.

An empty result is a real answer. What to do with it:

1. **Widen the query.** Fewer words, more topical ones. "rollback" beats "what happens if the canary deploy goes wrong".
2. **Read the vocabulary.** Overview → Concept Index, or ask the assistant for `okf_list_concepts`. Pick the term that's actually there and search that. This is almost always the fastest fix.
3. **Browse the document.** Overview → Documents → the document's TOC. If the knowledge is in a chapter whose summary didn't capture it, you'll see it here.
4. **Improve the summary.** If a chapter is genuinely about something its one-line summary doesn't say, that summary is the bug. Ask the assistant to update it (`okf_upsert_concept` with a better `summary`) — it is the retrieval surface, so it's worth getting right.

The trade is deliberate: a deterministic match over a small vocabulary is fast, explainable (every row names the term that matched), and can't hallucinate a row. Full-text and fuzzy matching would return things that merely contain your words.

## Two terms mean the same thing

Vocabularies grow organically, and eventually you get `api-design` and `api-conventions` covering the same chapters. Overview → Concept Index → **Merge** consolidates them: every chapter that referenced either ends up with the single canonical term, and the index and TOCs follow.

The assistant can do the same with `okf_merge_concepts({bundle, from, to})`.

Merging is the only way to undo a near-duplicate, which is why the ingest agent checks the existing vocabulary before coining a term.

## Something says it's stale

Overview → Health shows the **stale report**: chapters past their `stale_after` date, and chapters marked `deprecated`.

Stale does not mean wrong — it means *nobody has vouched for it lately*. The content is still there and still retrievable; search results carry the flag so you can weigh it. Re-ingest the source to refresh it, or ask the assistant to update the chapter's `status` / `stale_after` if it's still good.

## A run is stuck on "running"

First, give it a minute: a long document with assets and references genuinely takes a while, and the elapsed clock is live.

If it really is stuck, the **reaper** handles it. It watches two things: a run that has gone **silent** — no progress of any kind for 30 minutes by default — and a run that has been going for more than 6 hours whatever it is doing. Either one marks the run **failed** with a "stale" reason that says which of the two it was. Silence is measured from the run's last activity, not from when it started, so a long ingest that is still working is never cut off; when it is reaped, the message names the honest possibilities (a long model generation, a provider stall, or BOS restarting and dropping the stream) rather than guessing one. (You can also stop it yourself with the row's **Cancel** button — that ends it as **cancelled**, which is not a failure.) The reaper also sweeps immediately whenever the service starts, because a restart is exactly the event that orphans runs: it doesn't wait out the interval to admit a run it knows it isn't running.

A reaped run is not destructive. Every write is atomic and the derived index rebuilds from content, so a half-finished run leaves a smaller bundle, not a broken one. Re-run the ingest to finish the job.

Both limits are in the service's settings (Settings → Plugins → OKF Knowledge Base): the **inactivity timeout** (`staleJobMs`) and the **maximum total runtime** (`maxTotalTimeoutMs`). Raise the inactivity timeout if you ingest asset-heavy documents whose single interpretation steps run long; don't lower it below a realistic quiet gap or healthy runs will be killed off as stale. Changes apply to subsequent runs.

## A run failed — now what?

Expand the row in Jobs. The error card says what stopped it. Common ones:

- **The source couldn't be fetched** — bad URL, site refused the request, file not found. Fix the source and re-run.
- **The run hit its step budget** (`max_steps`). The document was too big or too tangled to finish in one run. Some of it was probably written; check the bundle's Documents view, then re-run, or ingest sections separately.
- **The service couldn't reach the agent** — the ingest agent isn't installed, or BOS's own API wasn't up. Check Settings → Plugins.

Re-running is always safe: `raw/` is append-only and chapter writes are merge-on-fields, so nothing is clobbered.

## "Service unreachable" in the app

Two causes, in order of likelihood:

1. **The app hasn't been granted `services:read`.** The app reaches its service over that service's own loopback port, and that capability is what lets it look the port up. Grant it in **Settings → Apps**. One-time.
2. **The service isn't running.** Check **Settings → Plugins** and start it. The assistant's `okf_*` tools vanish when the service stops too — if those are also missing, this is the cause.

The app retries for about fifteen seconds while the service is binding its port, so a message that appears right after a restart may clear on its own.

## The tools aren't there

The 21 `okf_*` tools are declared by the service at startup and removed when it stops. If the assistant says it has no such tool, the service isn't running — Settings → Plugins.

If the service is running but tools are missing, check its log in Settings → Plugins: a declaration rejected at startup reports its reason there.

## Import and export

**Export** (Overview → Import · Export) produces a spec-conformant OKF manifest: every document, every chapter, the concept index, and every document TOC. The derived artifacts are regenerated before the export, so what you get is always current. Binary assets are listed by path and size rather than inlined.

**Import** takes a directory already in the VFS. Point it at the path and give the new bundle a name.

Importing from a **git URL or a tarball**? Ask the assistant to fetch and unpack it into the VFS first, then import that directory by path — the service runs in a worker thread and has no shell of its own.

A bundle imported from somewhere else (or created before this version) may not carry the `parent` / `concepts` / `summary` frontmatter the index is derived from. The index is then rebuilt **best-effort** and the result says so plainly rather than quietly serving a half-built index. Those documents are still readable; to make them fully searchable, re-ingest their sources.

## Where the files actually are

`/KnowledgeBase/<bundle>/` in the Files app — plain Markdown, editable by hand, under git if you want. The derived `concept-index.md` and `toc/*.md` are rebuilt from the chapters on the next read, so hand-editing content is safe; editing those two is pointless rather than harmful.
