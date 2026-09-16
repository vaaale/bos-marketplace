# OpenSpec in BrowserOS

OpenSpec is a **lightweight, brownfield-first** spec framework — the alternative
to spec-kit for work on a system that already exists. Bind a store or a single
Project to it from Build Studio's **Method** dropdown.

Verified against **OpenSpec v1.13.0** (`Fission-AI/openspec@9d4e597`), whose
`/opsx:*` artifact-guided workflow is the surface this pack mirrors.

## Two trees, and why the difference matters

```
<store>/
├── config.yaml     project context, injected into every artifact
├── specs/          THE SPECS TREE — how the system behaves today
└── changes/        proposals in flight
    ├── add-dark-mode/{proposal.md, specs/, design.md, tasks.md}
    └── archive/    completed, frozen, read-only
```

The **specs tree** is current truth for the whole store. **Delta specs** live
inside a change and describe only what that change alters. Both are called
`specs` on disk, and BOS badges them so you can tell at a glance which you are
looking at: **Truth**, **Active**, **Archive**.

You never edit the specs tree by hand. It grows when a change is archived.

## Changes are named, not numbered

`add-dark-mode`, not `001-add-dark-mode`. OpenSpec has no ordering to express,
so BOS allocates no prefix for this method.

## "Available" does not mean "owed"

After the proposal exists, **delta specs and design are both Available at once**.
OpenSpec's own rule is that dependencies are *enablers, not gates* — they show
what is possible to create, not what you must do next. BOS therefore labels this
state **Available** rather than "Pending".

**Blocked** is different and means what it says: an artifact whose prerequisites
genuinely do not exist yet.

`Tasks` turns Done when the plan is **written**. `Apply` turns Done when the work
is **finished**.

## Two things that will surprise you

**1. Archiving does not happen inside BOS.**

Archiving merges each delta into the specs tree and moves the change under
`changes/archive/`. It is a real semantic operation, and BOS does not implement
it — a partially-correct merge would silently corrupt your source of truth, so
no partial version ships.

So inside BOS, `changes/` grows and **the specs tree never does**. To complete
the cycle, run the CLI in the store:

```
openspec archive <change-name>
```

If your specs tree looks permanently empty, this is why.

**2. Delta specs do not appear in the artifact pane.**

The artifact pane lists files directly inside a change. Delta specs are nested at
`<change>/specs/<capability>/spec.md`, so the phase strip can show
`Delta specs: Done` while the pane shows none. Browse them in the tree. This is
deliberate — surfacing nested files would change artifact listing for every
framework BOS supports.

## Archived changes are read-only

BOS refuses writes under `changes/archive/`, from the editor and from the
assistant alike. That is frozen history, and your specs tree was merged from it.

## The UI mockup is a BOS extension

If a change has a user interface, BOS's `ui-designer` writes
`design/ui-mockup.html`. OpenSpec has no UI artifact — this is a fork of its
schema, which OpenSpec supports explicitly.

**The upstream CLI does not know about it.** `ui-mockup.html` is invisible to
`openspec validate` and is not carried by CLI archiving. If you rely on the CLI,
keep a copy of anything you need to survive.

## Roles

OpenSpec defines no agents; BOS's own roles supply the quality floor:
`architect` writes the design, `architect-reviewer` gates it, `ui-designer`
produces the mockup, and `developer` applies the tasks. The `intent` **skill**
is loaded at the proposal stage.
