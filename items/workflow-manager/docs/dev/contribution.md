# Workflow Manager — Contribution Guide

How to extend the Workflow Manager service/app safely, and the conventions
its own code follows. Read `architecture.md` first for the module map.

## Adding a new tool

1. Add a declaration to `services/tools.js`'s `DECLARATIONS` array — `name`,
   `description`, `inputSchema` (JSON Schema). Mark it `readOnly(...)` (sets
   `parallelSafe: true`) only if the handler is genuinely read-only and takes
   no lock — every writer must stay sequential.
2. Add the implementation to `services/handlers.js`'s `makeHandlers()` return
   object, keyed by the exact tool name. Validate the shape of `args`
   defensively (`requireString`/similar) and throw a clear `Error` on bad
   input — `index.js`'s `tool_call` dispatch already converts any thrown error
   into a `tool_error` IPC message, so you never need to catch-and-format
   yourself.
3. If the app should also be able to trigger it, add a route in
   `services/http-bridge.js` that calls the SAME handler function — never
   duplicate handler logic between the tool path and the REST path.
4. Add a unit test in `services/__tests__/tools.test.js` (schema shape) and
   `services/__tests__/handlers.test.js` (behavior).

## Adding a new node output type

1. Extend `OUTPUT_TYPES` in `services/engine/node-model.js` and its
   normalization/description logic.
2. Teach `services/engine/validate.js` what a valid node of that type
   requires (mirroring how `"tool"` requires `toolName` and `"research"`
   requires `researchAgents`/`candidates`).
3. Teach `services/engine/scheduler.js`'s `runNodeOnce()` how to execute it —
   either inline (like `"ag-ui"`, which needs no network call) or via
   `services/engine/executor.js`'s `executeNode()` (like `"delegate"`/`"tool"`).
4. Update the app's `Graph.tsx`/`describeStep()` (and the equivalent in
   `node-model.js`'s `describeNode()`) so the new type gets a sensible
   "outputType · sub" label.
5. Add unit tests to `node-model.test.js`, `validate.test.js`, and
   `scheduler.test.js`.

## Adding a candidate-agent / routing feature

Dynamic routing lives entirely in `services/engine/router.js` and the
scheduler's integration points in `runNode()` (the `hasCandidates(node)`
branch) and the ready-set (`selectionAllows`). Two rules are load-bearing and
must not be softened:

1. **The selection is a structured signal** — a `select_branch` tool call, a
   structured output object, or a strict JSON envelope; never prose
   (`readSelectionSignal`). If you add a new signal form, add it there, with a
   unit test proving prose still yields `null`.
2. **Only declared candidate leaves are gated** by a selection (Option A);
   every other node is gated by its own `dependencies`. `buildCandidateIndex`
   is the single place that decides what "gated" means.

The corresponding authoring rules are enforced by `validate.js`
(`candidateTopologyErrors`) and documented in the bundled skill
(`skills/workflow-manager/SKILL.md`) — if you change the contract, update the
skill in the same change, since the assistant relies on that document to know
the contract exists at all (there's no other discovery mechanism).

## Adding an event type

Engine events flow `scheduler/executor → runs.js → engine/run-state.js`. To
add one: emit it via `ctx.emit(type, patch)`, fold it into the projection in
`RunState.apply()`, and — if it should appear as a lifecycle row rather than
trace data — add it to `EVENT_KIND` in `app/src/lib/trajectory.ts` and give it
a glyph in `TrajectoryPanel.tsx`'s `EVENT_GLYPH`. Everything persists and
replays for free, since the persisted log and the live projection go through
the same reducer.

## The 039 service-declared-tool contract

This service opts into `deploymentMode: "tools"` in `service.json`. If you're
unfamiliar with the contract (tool_declare handshake ordering, gating,
lifecycle cleanup on stop/crash/uninstall), read BOS's own
`docs/dev/apps/services.md` §15 before changing `index.js`'s handshake or
`tool_call` dispatch — getting the ordering wrong (e.g. gating tool_declare on
a VFS call succeeding) has caused real startup-timeout bugs in other
service items.

## Reaching the VFS — never a host path

Every read/write of workflow or run data MUST go through `services/vfs.js`'s
loopback `/api/fs` bridge. Do not add any `fs`/`path` logic that derives a
storage location from `configDirPath` (the service's OWN config directory,
`dataDir()/system/config/workflows/`) — that class of bug (writing to a host
path invisible to Files/the engine/the app) has shipped for real in another
marketplace item and is exactly what `migration.js` exists to recover from.
`configDirPath` is fine to touch directly via `fs` ONLY for the service's own
bookkeeping (e.g. reading its own `workflows.json` config file in
`index.js`'s `initialize` handler) — never for user content.

## Test conventions

Unit tests live in `services/__tests__/`, run with Node's built-in test
runner (no dependencies to install):

```
node --test services/__tests__/*.test.js
```

`services/__tests__/_fake-bos.js` is a shared fixture — a tiny in-process
HTTP server standing in for BOS's own `/api/fs` and `/api/subagents/delegate`
routes, backed by an in-memory filesystem map. Use it (rather than mocking
`vfs.js`/`executor.js` directly) so tests exercise the real HTTP/NDJSON
parsing paths, not just the calling code's assumptions about them. Pattern:

```js
const bos = await startFakeBos({ vfs: {...}, delegate: (body) => [...ndjson events...] });
process.env.NEXT_PUBLIC_APP_ORIGIN = bos.origin;
delete require.cache[require.resolve("../vfs")]; // vfs.js/executor.js resolve origin per-call, but require.cache
delete require.cache[require.resolve("../engine/executor")]; // must still be cleared between fake servers in the same file
// ... require the module under test AFTER setting the env ...
await bos.close(); // uses closeAllConnections() first — a still-pending request (e.g. simulating
                    // an in-flight run) keeps a socket open forever and would hang plain close()
```

Tests that exercise the scheduler/executor over ag-ui-only workflows need no
delegate mock at all (`executeNode` short-circuits ag-ui nodes without any
network call) — reach for that whenever a test doesn't care about the
delegate contract itself, to keep it simple and fast.

## The bos-core retirement

The old BOS-source workflow engine (`src/lib/workflows/*`, `/api/workflows/*`
routes, the `workflowTools()` server-tool set) is retired as part of this
same feature — it's a *separate* delegation from this item (a `bos-core`
change on a feature branch, not a marketplace-item change), because it was
shadowing this service's own tools (BOS's tool registry spreads service tools
first, but a same-named built-in still wins). If you're touching this item
and notice the old engine's files still present in BOS source, that's a sign
the retirement hasn't landed yet — flag it rather than working around it
here.
