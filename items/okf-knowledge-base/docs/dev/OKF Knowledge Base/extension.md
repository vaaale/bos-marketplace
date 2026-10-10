# Extending it

Most things you'd want to change about how this knowledge base behaves are **conventions**, not code. Know which is which before you open an editor.

## The skill is the seam

`skills/okf-bundle-schema/SKILL.md` is the authoritative source of bundle conventions: chapter frontmatter, concept-term naming and merge policy, the inline-asset block format, dedup rules, the ingest sequence, the query discipline, and the report-honestly rule. It is attached to the `okf-ingest` agent, so the agent reads it at the start of every run.

**If the change is about how knowledge should be shaped, it belongs in the skill.** Examples:

- "Chapters in our bundles should carry an `owner` field." → Document it in the skill's frontmatter section. Nothing in the service needs to know: unknown keys are preserved verbatim on every write, so the field survives round-trips without a schema change.
- "Concept terms should be noun phrases, never verbs." → The concept-terms section.
- "Two to four concepts per chapter is too many for us; we want one to three." → Same section.
- "Prefer splitting at `##` and never at `###`." → The chapter-boundary section.

This is why there is no `okf_read_bundle_schema` tool and no per-bundle `schema.md` in the service's model. A bundle *may* still carry a `schema.md`, and the skill says the bundle's own voice wins where the two differ — a per-bundle override is just a file the agent `file_read`s, not a mechanism anyone had to build.

**Why this is the right seam:** conventions change often, the storage engine almost never. Keeping them in a prompt artifact means a convention change is a text edit that takes effect on the next run — no service restart, no tool redeclaration, no migration.

## Adding a per-bundle convention

1. Create `<bundleRoot>/<bundle>/schema.md`.
2. Write only what differs from the skill. The skill is the default; this is an override, not a replacement.
3. Nothing else. The agent reads it when the bundle has one.

## When it is NOT a convention

### A new derived view

The two derived artifacts (`concept-index.md`, `toc/<docId>.md`) are rebuilt by `rebuildDerived()` in `okf-core.js` on every write path that can change them, from `classifyBundle()`'s walk of chapter frontmatter. A third derived artifact goes there, alongside `buildConceptIndex` / `buildToc`:

- Build it in `classifyBundle`'s output, write it in `rebuildDerived`, stamp it `index_generated_at`.
- Include it in `exportBundle`. If it isn't in the export, re-import produces a bundle that is silently missing it.
- Make it **regenerable and never the sole source of truth**. The moment a derived artifact holds something the content can't reproduce, every self-healing property in this design is gone.

### A new search behaviour

`core.search()` is the single implementation behind both `okf_search` and `GET /bundles/<b>/search`. Change it there and both surfaces move together — that is the point, and it is why the HTTP route must never grow matching logic of its own.

Keep it **deterministic and LLM-free**. Ranking changes are fine; a model call in the match is not. The e2e suite asserts the same query returns the same rows, and the explainability of `matchedConcept` depends on the match being a lookup.

If the vocabulary genuinely outgrows a single deterministic pass — roughly 50k tokens of index text or ~2s at p95 — the first escalation is a keyword/BM25 pre-filter over term names and descriptions, still chapter-granular, still no vector store. Write the measurement into [architecture.md](architecture.md) *before* adopting it.

### A new tool

19 is a contract, not an accident: `service.json`'s description, `GET /tools`, the app badge and the e2e suite all reflect the real declared list, so adding one is a deliberate, visible act.

Before adding, check the two folds this surface already made:

- **Is it a field setter?** It belongs in `okf_upsert_concept`'s frontmatter merge. That's where `okf_set_status`, `okf_set_trust`, `okf_add_source`, `okf_attest` and `okf_provenance` went.
- **Is it a view the app needs?** It belongs in `http-bridge.js` as a route over an existing `core` function. App views add **zero** tools. That's the whole of ADR-003, and it's why the graph and the jobs list are routes rather than tools.

If it is genuinely a new agent capability, declare it in `lib/tools.js`, give it a handler that delegates to `okf-core` (handlers validate shape; `okf-core` owns storage semantics), wrap it in `readOnly()` if and only if it is read-only, and update [tool-surface.md](tool-surface.md) and the agent's allowlist.

### A new app view

Add a route in `http-bridge.js` over existing `core` functions, a typed client in `app/src/lib/serviceClient.ts`, and the component. Three rules:

- **No new runtime dependency.** The app has zero, including the force-directed graph (`query/forceSim.ts` is an in-app Coulomb + spring + centering simulation, not d3). Adding one for a view is a bad trade.
- **Reach the service only through `serviceClient.ts`.** It is the single place that knows `httpPath`-else-`runtime.port` and the `window.__bos` broker fallback. A second place that learns it is a second place that breaks under the Supervisor.
- **Nothing hardcodes what the service declares.** The tool badge reads `GET /tools`. A literal there goes stale silently.

### Changing ingest behaviour

Three different places, depending on what you mean:

| You want to change | Edit |
|---|---|
| What the agent *does* with a source | `skills/okf-bundle-schema/SKILL.md` (conventions) or `agents/okf-ingest/AGENT.md` (procedure) |
| What the agent is *told* about this specific run | `buildIngestTask()` in `okf-core.js` — the task text, including the acquisition first steps |
| How a run is *launched and watched* | `triggerIngest` / `driveRun` in `okf-core.js`, and `lib/delegate-bridge.js` |

Two invariants when touching the last row:

- **Every acquisition step pins `output_path`.** It is what keeps the source off the token bill. A step without it silently reintroduces the cost this whole pipeline exists to remove.
- **The launcher owns terminal state.** `driveRun` derives `completed` / `failed` from the run's own `endedReason`, and `POST /jobs/<id>` rejects a `status` field. Do not add a path by which a run declares itself finished — that is the failure mode the rework removed.

### A new source type

`acquisitionFirstSteps()` in `okf-core.js` maps a source to its acquisition calls (URL → `web_fetch`; convertible document → `file_to_markdown`; plain text → straight to `okf_add_raw_source`). A new type is a branch there, plus the matching tool on the agent's allowlist in `AGENT.md`.

## Changing the agent's allowlist

`agents/okf-ingest/AGENT.md`'s `tools:` frontmatter. The agent is deliberately **self-sufficient but narrow**: the full 19-tool `okf_*` surface plus `web_search`, `web_fetch`, `file_to_markdown`, `view_image`, `video_keyframes`, `file_read`, `file_list`.

Self-sufficient, because an ingest that has to stop and ask for a capability doesn't finish. Narrow, because it never needs unrestricted `run_command` or `agent_delegate`, and granting either would widen a background agent's reach well past its job. Add to this list only what a run genuinely cannot complete without.

## Testing a change

`e2e/okf-knowledge-base.spec.ts` (Playwright, feature-id `okf-knowledge-base`) runs against a branch preview:

```
BOS_PREVIEW_URL=<preview> npx playwright test e2e/okf-knowledge-base.spec.ts
```

It asserts the tool-surface count against `GET /tools` (not a literal), search determinism across both surfaces, the auto-trigger contract (a `jobId` with no instruction block; the reaper marking an overrun run `failed(stale)`), the inline-asset block shape, graph derivation, import/export conformance, and the app's three tabs.

If you change the tool count, the search ranking, the job record shape or the route list, that file is where it shows up first.
