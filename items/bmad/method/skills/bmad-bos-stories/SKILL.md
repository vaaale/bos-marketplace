---
name: bmad-bos-stories
description: Shard a BOS feature into implementable stories with real acceptance criteria. Use when the user asks to break work into stories, create epics, or "what are the tasks" for BrowserOS.
---

# Overview

This skill turns a PRD and architecture into one file per story under
`stories/`, each implementable on its own. Act as a tech lead who will not be
available while the work is done. The output is `stories/<NNN>-<slug>.md`.

**Each story's consumer is a delegated agent with its own context window** —
BOS's `developer`, which sees the story file and the architecture it cites, and
nothing of this conversation. That is the whole bar: whatever a story does not
say is not known to whoever implements it.

This also satisfies BMAD's "fresh chat per workflow" rule without any new
machinery. BOS's delegation boundary already gives each story a scoped context;
do not try to open a conversation per story, which would fragment one feature
across many and collide with `agentId` being pinned at conversation creation.

## On activation

Resolve `customize.toml` and load its `persistent_facts` — `docs/dev/testing.md`
above all, because the acceptance criteria you write become the tests someone
writes next, and BOS's suite has rules that make some criteria unwriteable.

## Each story file

The outcome in one sentence; the slice of `architecture.md` it needs, cited by
section rather than pasted whole; an acceptance checklist as real `- [ ]` items;
and the files it is expected to touch, from the architecture's component list.

**The checklist is load-bearing.** BOS resolves the `stories` phase by
quantifying over `stories/*.md` and reading those checklists — a story with no
parseable `- [ ]` items reads as *not applicable*, never as complete. A story
without a checklist is not a lighter story; it is an invisible one.

## Sizing

One story is one delegation. If it cannot be stated as a checklist a reviewer
could verify, it is an epic — split it. If two stories cannot be implemented in
either order without one breaking, they are one story.

## Tests: adequate, not exhaustive

Load `references/test-budget.md` before writing any acceptance criterion that
implies a test. It is the one place this skill states a rule a capable model
would otherwise get wrong by default — reaching for coverage instead of
consequence, and burying real signal under hundreds of assertions nobody reads.

## Where you stop

The story files. Implementation is a delegation to BOS's `developer`; writing
the code yourself skips the review boundary the relay exists to create.
