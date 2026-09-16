# BMAD Method for BrowserOS

This pack carries **BMAD's own 32 skills** — 30 from the published `bmad-method`
package and 2 from `bmad-builder` — plus a small amount of BOS-specific content
on top. `method/upstream.json` records exactly which releases they came from.

## It is not a pipeline

BMAD is explicit about this, and it is the thing most people get wrong:

> *"These are independent tools, not stages. Pick the ones the gap calls for, in
> any order."* — and *"Size Follows the Intent."*

BOS lists the phases in an order because a list has to have one. **Nine of the
ten are marked optional.** Only `stories` — the work itself — is not.

Start by asking whether the intent is already well defined: what should be true
when the work is done, what must not change, what is out of scope. If it is, go
straight to `bmad-spec`.

| Path | What to run |
|---|---|
| **Trivial** | Change → edit → verify. Do not open BMAD for an obvious, low-risk edit. |
| **Epic-sized** | `bmad-spec` → story breakdown → `bmad-build` once per story → `bmad-retrospective` |
| **Project-sized** | The shared documents first (`bmad-prd`, `bmad-architecture`, `bmad-ux`), then the epic path across each epic |

## The skills

All of upstream's, by group:

- **Agents** — `bmad-agent-analyst`, `-pm`, `-architect`, `-dev`, `-ux-designer`
- **Thinking** — `bmad-brainstorming`, `bmad-forge-idea`, `bmad-deep-recon`,
  `bmad-advanced-elicitation`
- **Planning** — `bmad-product-brief`, `bmad-prfaq`, `bmad-prd`, `bmad-spec`,
  `bmad-ux`, `bmad-architecture`, `bmad-create-epics-and-stories`,
  `bmad-sprint-planning`, `bmad-project-context`
- **Shipping** — `bmad-build`, `bmad-build-auto`, `bmad-code-review`,
  `bmad-walkthrough`, `bmad-qa-generate-e2e-tests`, `bmad-retrospective`,
  `bmad-correct-course`
- **Meta** — `bmad-help`, `bmad-review`, `bmad-customize`, `bmad-party-mode`
- **Builders** (from `bmad-builder`) — `bmad-agent-builder`,
  `bmad-workflow-builder`: build or edit an agent or a workflow through
  conversational discovery

Ask `bmad-help` if you are not sure which to run.

### Three of them come in pairs

| | use it for |
|---|---|
| `bmad-architecture` | architecture for **your own** project |
| `bmad-bos-architecture` | architecture **for BrowserOS itself** — BOS's real containers, the Supervisor, worker services, the VFS |
| `bmad-ux` / `bmad-bos-ux` | same split; the BOS one targets the window model, the iframe/app-facet boundary, the A2UI catalog |
| `bmad-create-epics-and-stories` / `bmad-bos-stories` | same split; the BOS one shards into BOS's story shapes |

The question that picks between them is *which system are you building?*

## What is NOT here: CIS

BMAD's **Creative Intelligence Suite** — six facilitator personas (Storyteller,
Innovation Strategist, Design Thinking Coach, and three more) and four ideation
workflows — is a separate package, and it ships **manifests rather than
content**: `bmad-skill-manifest.yaml` files that BMAD's own installer renders
into skills. There is nothing to copy, so the pack does not pretend to have them.

Most of what you would reach CIS for is covered by skills that ARE here —
`bmad-brainstorming`, `bmad-forge-idea`, `bmad-deep-recon`,
`bmad-advanced-elicitation`, `bmad-party-mode`. What is missing is the six named
personas.

Getting them properly means running BMAD's own installer to render them; the pack
will not hand-reimplement someone else's renderer.

## The cast

| Persona | Produces |
|---|---|
| **Mary** — Business Analyst | `product-brief.md` |
| **John** — Product Manager | `prd.md` |
| **Sally** — UX Designer | `ux.md` |
| **Winston** — System Architect | `architecture.md` |
| **Amelia** — Senior Software Engineer | `stories/*.md` |

**Delegate-only**: they do not appear in the agent picker, because each depends
on the previous one's artifact and five chain-dependent personas would bury the
agents you actually start conversations with. Build Studio delegates to them; you
can too, with `agent_delegate`.

**Implementation is not one of them.** BMAD's Dev persona binds to BOS's own
`developer` agent — the one that holds repo access — rather than replacing it.

## Templates

**Per skill, under that skill's `assets/`** — `prd-template.md`,
`brief-template.md`, `spec-template.md`, `spine-template.md`,
`prfaq-template.md`, and more. There is no pack-level templates directory, and a
skill that needs a template ships it itself.

## `_bmad/` in your repository

Many BMAD skills shell out to Python for the mechanical half of their work —
exact word counts, deterministic ID checks, the customisation merge, the run
memlog. Those scripts live at **`_bmad/scripts/` inside your own repository**,
because that is where BMAD's own CLI expects them and where a team's committed
customisations belong.

BOS does not put them there on its own. Ask the assistant to install them
(*"install BMAD's runtime for this store"*), and it will tell you which
repository it is writing to first. If a skill's Python calls start failing,
`_bmad/` is missing — that is the fix.

Re-installing refreshes BMAD's own files and **never touches `_bmad/custom/`**,
which is yours.

## Customising

Two different things, and the cheaper one is usually right:

- **A skill's behaviour** — BMAD's own mechanism. Write
  `_bmad/custom/<skill>.toml` (team, committed) or
  `_bmad/custom/<skill>.user.toml` (personal). Sparse overrides only; never copy
  the whole `customize.toml`, which would freeze today's defaults so the next
  update silently does nothing. `bmad-customize` writes these for you in plain
  language.
- **A persona** — edits go to `/Methods/bmad/overlay/agents/<id>/AGENT.md`, which
  shadows the pack's copy and survives pack upgrades. Uninstalling keeps the
  overlay's content, so reinstalling restores your work.

## Upgrading

The skills are a **mirror, not an adaptation**. A newer BMAD release is one
command in the pack — `node tools/import-upstream.mjs <version> bmb` — and then a
diff to review. The BOS-specific skills have different ids, so a re-import cannot
touch them.

## Versions

Two, and they are unrelated:

- **This pack's version** (`method.json`) — bumps when the pack changes.
- **The BMAD release it carries** (`method/upstream.json`) — bumps when you
  re-import.

A BOS descriptor change and a BMAD release are different events, and conflating
them was a real bug: the pack once claimed `6.13.0-next` as its own version while
carrying `6.12.0`.
