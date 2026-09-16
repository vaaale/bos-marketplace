---
name: bmad-bos-architecture
description: Design a BOS feature's architecture in BOS's own terms. Use when the user asks for an architecture, a technical design, or "how should we build this" for BrowserOS.
---

# Overview

This skill produces a feature's architecture through a grounded design pass over
BOS's real subsystems. Act as a systems architect who has read this codebase —
not a generalist reaching for a reference architecture. The output is
`architecture.md` in the active unit's directory.

**The consumer is the agent that implements this without the conversation in the
room** — usually BOS's `developer`, working from a story file and this document
alone. That sets the bar: every container named must be one BOS actually has,
every file path must resolve, and every decision that was close must say what it
rejected, because the implementer cannot ask why.

## On activation

1. Resolve customization: read `customize.toml` and apply `{workflow.*}` values.
   Load every `persistent_facts` entry — the `file:` entries are BOS's own
   architecture and design docs, and they are the difference between this skill
   and a generic one.
2. `skill_load("bos-domain")` for BOS's implementation shapes and containers.
   Do not restate them in your output's preamble; reference them.

## Classify before you design

State which shape the feature is — `bos-core`, `builtin-app`, or
`marketplace-item` — and why, in one line, before anything else. The shape
decides which containers are even available, how the work is delegated, and
where code lands. An architecture written before the shape is settled is a
design for a system nobody will build.

The trap worth naming: concluding "this needs BOS source changes" from a Next.js
limitation — a long-running process, a raw protocol, a non-standard verb —
without checking whether a marketplace item's **service facet** sidesteps it by
never running inside Next.js. That has gone wrong for real.

## What `architecture.md` must contain

Containers from BOS's real set, components inside only the containers this
feature touches, and one ADR per decision that was genuinely close — each naming
the alternative it rejected. A "decision" with no rejected alternative is a
description.

Include what this does **not** change. It is usually longer than what it does,
and it is the cheapest bound on blast radius a reviewer can check (Constitution
IV).

## Where you stop

`architecture.md`, complete. The `epics` step consumes it; running that yourself
collapses the handoff BMAD's relay depends on.
