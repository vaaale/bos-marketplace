# Editor — the agent's tool surface

The seventeen `agentic_editor_*` tools, how they reach the app, and the skill
that teaches an agent to use them.

Related: [markdown rendering and the style registry](markdown-rendering.md) ·
[file handling](file-handling.md)

---

## 1. How an app-owned tool gets called at all

The editor does not register its tools with BOS. It hands them to the run:

```
chat-store.send()
  → POST /api/assistant/runs { conversationId, agentId, message, surfaceTools }
      → the server merges the declarations into the run's tool table as
        execution: "frontend"
  → a tool_call event arrives on the run's NDJSON stream
      → chat-store.dispatchFrontendTool()
          → TOOL_HANDLERS[name](args)
          → client.postToolResult(runId, callId, result)
```

Two consequences worth knowing before adding a tool:

- **The declarations are per-run.** They go out with every `send`, so a tool
  added here is live on the next message — there is no registration step, no BOS
  build, and nothing to re-tick in Settings. (`tools/registry.ts` explains why
  BOS's own `capabilities-registry.ts` is deliberately not involved: an agent's
  `tools` allowlist is a snapshot taken when the agent was created, so a tool id
  listed there but missing from the allowlist would be hidden from the model.)
- **It only works with the `assistant` capability.** The app declares it in
  `app/app.json`; the user grants it in Settings → Apps. Without the grant the
  chat pane answers every send with `Capability "assistant" not granted`, which
  looks exactly like a broken tool. See
  [the assistant broker](../assistant/assistant-broker.md) (the item's docs are
  overlaid into BOS's own `docs/dev/` tree, so that path resolves in the Docs
  app).

A `tool_call` for a tool that is NOT `agentic_editor_*` is somebody else's
frontend tool; `dispatchFrontendTool` leaves it for a real BOS surface to answer
and only unblocks the run (with an explanatory failure) if nobody does.

## 2. The two modules

| Module | Owns |
|---|---|
| `tools/assistant-tools.ts` | the twelve DOCUMENT tools, the agent context block, and the composed `TOOL_DECLARATIONS` / `TOOL_HANDLERS` |
| `tools/style-tools.ts` | the five CUSTOM-STYLE tools |
| `tools/result.ts` | `ok` / `fail` / `guarded` / `str` — one result shape for both |
| `tools/registry.ts` | startup registration, and the assertion that the two maps pair up |

They are separate because they answer to different owners: a document tool edits
a buffer the user can save or discard, a style tool edits app settings that apply
everywhere at once. They are exported as ONE list and ONE map because
`registerAppCapabilities()` asserts that every declaration has a handler and
every handler a declaration — a check that is worthless if a module can be
omitted from it.

## 3. Document tools

`open_file`, `create_document`, `save_document`, `save_all`, `add_content`,
`modify_content`, `remove_content`, `set_active_document`, `list_documents`,
`get_active_document`, `get_document_content`, `search_document`.

Two conventions run through all of them:

- **Default to active.** Every tool takes an optional `documentId` and falls back
  to the active tab. `resolveDocument()` also accepts a path or a filename, and
  opens a path that is not yet open rather than refusing it.
- **Edits are buffer-only.** Nothing writes to the VFS except the two save tools
  (FR-012). That is what makes an agent edit reviewable.

## 4. Style tools (v4, FR-030 → FR-034)

`list_styles`, `add_style`, `update_style`, `remove_style`, `reset_style` — the
same five operations the Settings → Custom Styles panel performs, through the
same store actions, so there is one writer path and not two.

```
agentic_editor_add_style
  → useEditorStore.getState().addStyle(name, css)
      → saveCustomStyles()   // module cache (renderer) + KV write (durable)
      → customStylesVersion++ // every open preview and the Settings list re-render
```

Three rules shape the handlers:

- **Built-in names are structural.** `Note`/`Info`/`Warning`/`Tip` ship in code,
  so they cannot be added, renamed or removed — only overridden and reset. Every
  refusal names the tool that DOES apply (`add_style` on a built-in points at
  `update_style`, `remove_style` points at `reset_style`), because a bare refusal
  makes an agent retry the identical call.
- **Validate, then VERIFY.** The store's actions return silently on input they
  will not apply (`addStyle` for a built-in name, `updateStyle` for a name it
  does not hold). A handler that dispatched and reported `ok` would be telling
  the model it changed something it did not, so each one re-reads the registry
  (`styleExists`, `effectiveCss`, `isOverridden`) before answering.
- **A name that cannot be referenced is refused.** A style is addressed as
  `::: {custom-style="Name"}` and the parser reads the quoted form with
  `[^"]*`, so a name containing a quote, brace or newline could never resolve.
  Refusing it beats a style that silently never applies.

`update_style` carries the rename, as remove + add with the CSS carried across —
the registry is keyed by name, so there is nothing else a rename could be. It is
reported as `renamedFrom` with a warning in the message, since documents still
naming the old style fall back to the neutral box.

**There is no save step.** Styles are app settings: `agentic_editor_save_document`
has nothing to do with them, and a style change applies to every open document the
moment the handler returns.

## 5. The skill

`skills/agentic-text-editor/SKILL.md` — bundled with the item, so installing it
symlinks the skill into `data/skills/<id>` read-only (035: install copies
nothing; the content stays in the marketplace clone and `git pull` updates it in
place). BOS lists it in the agent's skills index by `name` + `description`, and
the agent reads the body with `skill_load` when it becomes relevant.

It carries what the declarations cannot: the buffer-vs-disk rule, "don't save
unless asked", how to edit in the middle of a document without a line-insert
tool, the fenced-div syntax, that a ```` ```mermaid ```` block is drawn as a
diagram (so write one rather than describing a picture in prose), and the fact
that `css` REPLACES a declaration block rather than merging into it — the mistake
that silently strips a style's padding and border.

**Reconciliation is memoized per process.** A skill added to an ALREADY-INSTALLED
item appears after BOS restarts (`reconcileInstalledItemAssets`, called once per
data root by the skill and agent stores).

## 6. Adding a tool

1. Declare it and implement it in the same module — `registerAppCapabilities()`
   throws at startup for a declaration with no handler, and for a handler with no
   declaration, because a run otherwise only finds out by hanging.
2. Return `ok({...})` / `fail(message, { hint, ...context })` from
   `tools/result.ts`. The hint is what turns a refusal into the right next call.
3. Write the e2e first. `e2e/v4.spec.ts` drives real runs through the real
   dispatch path using BOS's scripted provider (`BOS_E2E_SCRIPTED=1` plus an
   `@@e2e {...}` line), so no model is involved and nothing is stubbed. A test
   that calls a handler directly proves nothing about the path above.
4. Teach the skill about it. A tool the agent never thinks to call is a tool that
   does not exist.
