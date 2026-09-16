# Stage: design

Creates `changes/<change-name>/design.md`. Explains **how**. Available as soon
as the proposal exists — in parallel with delta specs, not after them.

Delegate to the **`architect`** role, and gate with **`architect-reviewer`**.
This is where BOS's role layer earns its place: OpenSpec defines no agents of
its own, so without these a design is grounded in nothing but the proposal.

## Create one only if it earns its place

- Cross-cutting change, or a new architectural pattern
- A new external dependency, or significant data-model change
- Security, performance, or migration complexity
- Ambiguity worth resolving before code

A design doc for a one-file change is noise. Skipping it does not block `tasks`
— but the phase then stays Available rather than Done, which is accurate.

## Sections

- **Context** — current state and constraints only. Reference `proposal.md` for
  motivation instead of restating it.
- **Goals / Non-Goals** — design-level boundaries. Do not restate the
  proposal's scope.
- **Decisions** — each with rationale and the alternatives considered. "Why X
  over Y" is the content; a decision without a rejected alternative is a note.
- **Risks / Trade-offs** — `[Risk] → Mitigation`.
- **Migration Plan** — deploy and rollback, if applicable.
- **Open Questions** — omit if none.

## Open questions are for DEFERRABLE unknowns

Only for things that can safely be answered later without changing the specs,
the approach, or the task breakdown.

If a question would change any of those, resolve it now — **ask the user rather
than guessing**. An open question is not a place to park a decision you skipped;
the `tasks` stage will bake your unstated assumption in.

## The UI artifact — a BOS addition

If the change has a user interface, delegate to **`ui-designer`**, which writes
`design/ui-mockup.html`.

**This is BOS's extension to OpenSpec's schema, not part of OpenSpec.** It is
legitimate — OpenSpec supports forked schemas explicitly — but say so when it
matters: a user running the upstream `openspec` CLI against the same repository
will not see `ui-mockup.html`. It is invisible to CLI validation and is not
carried by CLI archiving. A mockup can be lost that way with nothing reporting
it.
