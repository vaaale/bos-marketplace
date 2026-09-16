# Stage: proposal

Creates `changes/<change-name>/proposal.md`. Establishes **why**, not how.

Name the change for what it does — `add-dark-mode`, `fix-opencode-commands`.
No numeric prefix: this framework has no ordering to express.

Load the **`intent`** skill before writing. (It is a skill, not an agent — there
is no `intent` role to delegate to.) A proposal that restates the user's request
back at them is the common failure.

## Sections

- **Why** — 1–2 sentences. The problem or opportunity, and why now.
- **What Changes** — bullets. Specific new capabilities, modifications,
  removals. Mark breaking changes **BREAKING**.
- **Capabilities** — the contract between this stage and the delta specs:
  - **New Capabilities** — each becomes `specs/<capability-path>/spec.md` in the
    change. Kebab-case for any path segment you introduce.
  - **Modified Capabilities** — existing capabilities whose REQUIREMENTS change.
    Only list one if spec-level behaviour changes, not just implementation. Use
    the **exact existing path** from the specs tree.
- **Impact** — affected code, APIs, dependencies, systems.

## Research the specs tree FIRST

The Capabilities section is the load-bearing part, and the failure is a
near-duplicate capability that splits truth in two. Before writing it, read what
already exists in the store's specs tree and **reuse an existing capability's
exact path** rather than inventing a similar name.

Reading a capability's requirement texts is not the same as reading its
scenarios. Before deciding something is already covered, read the spec in full.

## When there are no capabilities

A pure refactor, a tooling change, or docs-only work legitimately changes no
behaviour. Set `skip_specs: true` in the change's `.openspec.yaml`:

```yaml
schema: spec-driven
skip_specs: true
```

**Do not invent a requirement to get past validation.** Specs describe
behaviour; if behaviour does not change, no spec should.

Keep the proposal to 1–2 pages. Everything else builds on it.
