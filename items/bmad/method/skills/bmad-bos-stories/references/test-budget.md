# Test budget

The default failure here is volume: asked for tests, a model writes one per
branch, per field, per error string, and ships four hundred assertions that pass
together and mean nothing individually. BOS's suite is the shared cost of that —
every test runs on every change, forever.

So the budget is stated as a bar, not a count.

## What earns a test

**A behaviour that would be silently wrong.** BOS's real bugs in this series
were all silent: a symlinked store skipped by `readdir`, a delegate-only agent
absent from `getAgent`, a pack's templates mounted one directory too high. None
threw. Each needed exactly one test.

**A rule with a stated reason.** If a design says "checklist quantifiers are
false on an empty list, because a vacuously-true *all done* would report work
nobody specified", that sentence is the test. Write it once.

**A contract another component depends on.** Precedence order, provenance,
refusal paths.

## What does not

- A second test for the same rule with different data. If the first passes and
  the second could not fail independently, it is one test typed twice.
- Assertions on wording an implementation may legitimately reword. Assert the
  refusal happened and that it names the thing; not its exact sentence.
- Coverage of a branch a type already makes unreachable.
- A test that would pass if the feature were deleted. This is the common one:
  it usually asserts against the helper the test just built rather than the path
  the feature uses.

## The shape that catches real bugs

Drive the **path the feature actually takes**, not the function you just wrote.
Three bugs in this codebase survived their own tests because the test called the
listing function directly while the product called something else.

State the *why* in the test name or one comment line. A failing test whose
purpose is unclear gets deleted or weakened by whoever meets it next, and a
weakened test is worse than none — it reports safety that is not there.

## Rough scale

For a story: **one to five** tests. Fewer than one means the story changed
nothing observable. More than five usually means the story is an epic — split
it, and the tests distribute with the work.

This is a smell test, not a quota. A parser genuinely needs a table of cases;
write it as one test over a table, not twenty tests.

## Where they go

`tests/**`, run by `npm run test:unit` — **never** a bare `npx playwright test`,
which drops the `NODE_OPTIONS` the suite needs and produces failures that look
like product bugs. The suite is hermetic: stub the model seam rather than
reaching a provider. Browser-level work goes in `e2e/**` and bundles its own
fixtures — a test that skips for want of environment state is not coverage.
