# Stage: delta specs

Creates `changes/<change-name>/specs/<capability-path>/spec.md` — one file per
capability listed in the proposal.

**These are DELTA SPECS, inside the change.** They are not the specs tree. The
specs tree (`<store>/specs/`) is current truth and is only ever updated by
archiving. Writing a delta into it rewrites truth that nobody agreed to change.

Use the **exact path** from the proposal. For a modified capability that is the
existing path from the specs tree — a mistyped path targets a capability that
does not exist rather than the one you meant, and nothing will say so.

## Delta operations — four verbs

`## ADDED Requirements` — new behaviour.

`## MODIFIED Requirements` — changed behaviour. **Copy the ENTIRE existing
requirement**, header through every scenario, then edit. The header text must
match the original exactly (whitespace-insensitive). A partial MODIFIED loses
the remainder at archive time. If you are adding a concern without changing
existing behaviour, that is ADDED.

`## REMOVED Requirements` — must include **Reason** and **Migration**.

`## RENAMED Requirements` — name changes only, `FROM:` / `TO:` format.

## Format — where silence bites

- Requirement: `### Requirement: <name>` followed by the requirement text.
- Scenario: `#### Scenario: <name>` — **exactly four hashtags**, then
  `- **WHEN**` / `- **THEN**` bullets. Three hashtags or plain bullets fail
  **silently**: the scenario is simply not seen.
- Every requirement needs at least one scenario.
- Use SHALL/MUST. Avoid should/may.

## `## Purpose` — conditional, and it corrupts truth if you get it wrong

- **New capability** — the delta MUST open with `## Purpose`, one or two
  sentences, 50+ characters. Archive copies it into the main spec it creates.
  Omit it and archive writes a `TBD ... Update Purpose after archive`
  placeholder into the specs tree, which then looks like real content.
- **Existing capability** — do NOT add `## Purpose`. That spec already has one
  and the delta's is ignored. To change it, edit the specs tree directly.

## Behaviour, not implementation

Good: observable behaviour, inputs, outputs, error conditions, external
constraints, testable scenarios.

Not here: internal class or function names, library choices, step-by-step plans.
Those belong in `design.md` and `tasks.md`.

> If the implementation can change without changing externally visible
> behaviour, it does not belong in the spec.

Each scenario should read as a potential test case.
