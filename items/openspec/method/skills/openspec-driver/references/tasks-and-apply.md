# Stages: tasks, then apply

Two stages, deliberately separate. `tasks` is the plan; `apply` is the work.

## tasks

Creates `changes/<change-name>/tasks.md`. Available once delta specs **and**
design are both done.

Before writing, check `design.md` for Open Questions. If any would change what
gets built, resolve it with the user first — do not bake an unstated assumption
into the task list.

**Format is parsed, not decorative.** The apply stage tracks progress by reading
checkboxes:

```
## 1. Setup

- [ ] 1.1 Create the module and verify the expected files are present
- [ ] 1.2 Add dependencies and verify installation succeeds

## 2. Core

- [ ] 2.1 Implement the export function and verify its test passes
```

- Group under `##` numbered headings.
- Every task is `- [ ] X.Y description`. Anything else is invisible to tracking.
- Small enough to finish in one session, ordered by dependency.
- **Each task states how to verify it is complete** — a test, a command, an
  observable behaviour, or a delivered artifact — in the checkbox text itself.
  Use a separate verification task only for integration spanning several tasks.

Reference the delta specs for what to build and `design.md` for how.

This stage is **done when the plan is written**, not when it is executed. A
complete task list with nothing ticked is a finished artifact.

## apply

Delegate to the **`developer`** role. Work through the pending tasks, ticking
each as it completes. Pause on a blocker or where clarification is needed rather
than guessing.

`apply` is done when every box is ticked. It produces no new artifact — which is
why it has no template and why upstream declares it outside the artifact list.

## Then: archive — OUTSIDE BOS

Completing the tasks does not close the change. Archiving merges each delta into
the specs tree and moves the change to `changes/archive/<date>-<name>/`.

**BOS does not implement archiving.** Run `openspec archive <change>` from the
CLI. Until then the change stays in `changes/` and the specs tree does not grow.
Tell the user this rather than letting them discover it — the specs tree not
growing is the one thing that makes OpenSpec look broken.
