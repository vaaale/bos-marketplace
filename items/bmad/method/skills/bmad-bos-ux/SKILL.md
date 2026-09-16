---
name: bmad-bos-ux
description: Design a BOS feature's UI against BOS's real surfaces. Use when the user asks for a UX spec, screen design, or "what should this look like" for BrowserOS.
---

# Overview

This skill produces a feature's UI design by working from BOS's actual surfaces
and its style guide. Act as a designer who knows this product's constraints —
BOS is an operating system in a browser, and its constraints are not a web
app's. The output is `ux.md` in the active unit's directory.

**The consumer is whoever builds the screen from this document alone.** They
cannot ask which component recipe you meant, so name the ones the style guide
documents rather than describing them.

## On activation

Resolve `customize.toml` and load its `persistent_facts` — BOS's style guide,
apps guide and component conventions. They are non-negotiable input, not
background reading: the style guide's §4 recipes are reproduced verbatim in real
BOS code, and a design that approximates them produces a screen that looks
subtly wrong in a way nobody can name.

Then `skill_load("bos-domain")` and establish the shape, because the shape
decides what UI is even possible.

## The shape decides the surface

| Shape | What you are designing |
|---|---|
| `bos-core` | A Settings tab, a desktop surface, or a panel inside an existing app. React, inside the Next.js process. |
| `builtin-app` | A window app under `src/apps/<id>/`, with BOS's window chrome. |
| `marketplace-item` | An **iframe**. It cannot import BOS components and does not share BOS's React tree. |

The iframe boundary is the one that bites: it is invisible in a mockup and
decides what is buildable. A design that assumes shared components is
undeliverable for a marketplace item.

## The UX gate is real

A feature with no user-facing surface **skips this step**. BMAD's chain gates it,
and BOS's descriptor models the skipped state as `na`, not `pending`. Producing a
UX document for a background service to be thorough wastes the reader's time and
misreports the pipeline.

## A2UI is a fixed catalog, not HTML

When the surface renders through A2UI, `<script>`, vanilla JavaScript,
`localStorage` and CSS `display:none` do not exist — they are silently dropped,
which is the most common cause of "the buttons don't work". Build multi-step
flows with the **Tabs** component and make interactions real through data-model
bindings.

Most features are not A2UI. Default to a self-contained HTML mockup matching the
style guide, and reach for A2UI only when the shipped feature genuinely renders
through it.

## What `ux.md` must contain

The surface and the constraints its shape imposes; every screen and state the
requirements imply — including empty and error, because a happy-path-only
document leaves exactly the ambiguity this step exists to remove; where it lives
in BOS; and the open questions the PRD did not settle.

Never invent a literal connection URL, hostname or port. Those depend on
deployment, they are the architect's to determine, and a plausible-looking one
has been mistaken for fact before.
