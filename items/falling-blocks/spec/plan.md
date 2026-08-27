# Implementation Plan: Falling Blocks

**Branch**: n/a — marketplace item (flat id: `falling-blocks`) | **Date**: 2026-08-27
**Spec**: `item-falling-blocks/spec.md` | **Design**: `item-falling-blocks/design.md` (binding) | **Mockup**: `item-falling-blocks/mockup.html` (binding UI contract)

## Summary

A single-player, keyboard-only, canvas-rendered falling-blocks (tetromino) game
delivered as **one self-contained `index.html`** — all HTML/CSS/JS inline, no
external libraries, CDNs, network calls, or images. Technical approach (details
and ADRs live in `design.md`, not repeated here): a fixed 220×440 playfield
canvas plus an 88×88 next-preview canvas; a `playing`/`game-over` state machine;
an ordered rotation-kick set for no-clip rotation (ADR-2); a `requestAnimationFrame`
fixed-timestep accumulator for wall-clock-deterministic gravity
(`fallMs = max(80, 800 − (level−1)·60)`, ADR-6); a classic scoring engine
(100/300/500/800 by lines + per-row soft/hard-drop bonuses); and a top-10
high-score store backed by a one-shot capability-probed `localStorage` with an
in-memory fallback that never throws (ADR-3). The mockup is the binding visual
contract for layout, the 7 piece colours, the dark theme, the drop-ghost, and the
game-over overlay.

## Technical Context

**Language/Version**: HTML5 + CSS3 + vanilla JavaScript (ES2020) — one file, no build step
**Primary Dependencies**: None (browser platform only — Canvas 2D, DOM, `localStorage`)
**Storage**: `localStorage` (top-10 leaderboard) with in-memory fallback if unavailable (ADR-3)
**Testing**: Manual validation against `quickstart` scenarios (SC-001…SC-009 in spec) — no test framework for a single-file game
**Target Platform**: Desktop browser (installed as a BOS static app at `/apps/falling-blocks/`)
**Project Type**: Web app — single self-contained HTML file (marketplace item, app facet only)
**Performance Goals**: ~60 fps smooth loop; gravity wall-clock-deterministic across 60/120/144Hz (ADR-6); lag-free keyboard response (NFR-002)
**Constraints**: NFR-001 — no external libraries/CDNs/network/images; NFR-003 — legible at the fixed 672px layout without scrolling; fixed 22px cells / 672px window (ADR-1)
**Scale/Scope**: 1 file, ~10 labelled inline script sections, 10×20 grid, 7 tetrominoes

## Constitution Check

*Gated against `item-falling-blocks/design.md` §2 (already run by Architect — carried forward, not re-derived).*

| Principle | Status |
|---|---|
| Spec-Driven | ✅ Derives from ratified `spec.md`; `tasks.md` follows this plan. |
| Server Authority / SSR boundary | ✅ N/A — no server code, no secrets, no Node APIs; all state browser-local. |
| Always Delegate; Claude Codes | ✅ Implementation is delegated (`contentOnly:true`) → `app_install`; Build Studio never writes the file. |
| Minimize Blast Radius | ✅ No BOS-source change; install lands on the `user-apps` `app-candidate` draft branch (Topbar "Promote app"/"Discard app"). |
| The VFS Is Not the Source | ✅ Item content lives in the `user-apps` GitFS repo, not BOS source. |
| Specs & Docs Stay in Sync | ✅ Item ships its own `spec/`; no BOS `docs/` affected. |
| Respect Boundaries | ✅ No `package.json`/lockfile/build-config edits; no new external dependency. |

**Gate result: PASS** — no violations to justify.

## Project Structure

### Documentation (this feature) — inside the item

```text
item-falling-blocks/
├── spec.md              # Source of truth
├── design.md            # Architecture, component map, ADRs (binding)
├── mockup.html          # Binding UI contract (layout, colours, states)
├── plan.md              # This file
├── tasks.md             # Phase 2 output (next step — not created here)
└── app/index.html       # THE deliverable (created at implement time, not now)
```

No `research.md` / `data-model.md` / `contracts/` — not warranted for a single
self-contained file; the data model and architecture are already captured in
`design.md` §3/§4.

### Source Code (what exists once `implement` runs)

```text
falling-blocks/
└── app/
    ├── index.html       # THE deliverable — single self-contained file
    └── app.json         # name/icon — written by app_install (not hand-authored)
```

**Structure Decision**: The "app only, trivial — one static HTML file" shape.
`index.html` holds an inline `<style>` (theme + layout, per `mockup.html`) and one
inline `<script>` organised into the 10 labelled sections in `design.md` §4
(§1 config, §2 tetromino table, §3 high-score store, §4 state model,
§5 movement/rotation engine, §6 input/DAS, §7 scoring/level, §8 rendering,
§9 rAF loop, §10 bootstrap). No `services/`, `config/`, `hooks/`, or plugin facets;
no `src/`, no `manifest.ts`, no `data/user-apps` hand-edits.

## Design Notes (from `design.md` — referenced, not repeated)

- **Component decomposition** — see `design.md` §3; the inline-section map in §4 is the implementation unit.
- **State machine** — `playing`/`game-over` (design.md §3.2): game-over triggers the instant `spawn()`'s piece collides at its start position; Enter resets grid/score/lines/level/next and returns to playing.
- **Tetrominoes** — 7 shapes, fixed colours matching the mockup (`I #22d3ee, O #fde047, T #c084fc, S #4ade80, Z #f87171, J #60a5fa, L #fb923c`); I in a 4×4 box, O in a 2×2 box (rotation no-op), rest in 3×3 (design.md §3.1).
- **Rotation / no-clip** — ordered rotation-kick set `[ (0,0),(0,−1),(0,+1),(0,−2),(0,+2),(−1,0),(+1,0) ]`, same for every piece/transition; reject if none valid; T-spin/I-spin intentionally omitted (ADR-2).
- **Input** — DAS for held keys (170ms delay, 40ms repeat), stepped off the rAF clock so no path can clip; `blur`/`visibilitychange` → pause (ADR-4).
- **Scoring / level** — 100/300/500/800 by lines cleared in one lock; soft-drop +1/row, hard-drop +2/row (per row actually dropped); `level = floor(lines/10)+1`; `fallMs = max(80, 800−(level−1)·60)` (ADR-6).
- **High scores** — top-10 score-only, descending, stable sort (insert-after-existing-equal); "New high score" badge iff `record(finalScore)` returns rank 0..9; empty state renders no badge / muted placeholder; side panel and overlay both key off the same `record()` rank (ADR-3).
- **Rendering** — canvas owns only the board (locked cells → faint grid → drop-ghost → active piece with glow) and the next preview; DOM owns the HUD, high-score lists, controls legend, and the game-over overlay (design.md §3 item 8).

## Implementation-time verification (carried from `design.md` §7)

1. **Same-origin persistence** — confirm the installed app's iframe is same-origin
   so the top-10 persists across a reload (SC-008). If opaque-origin, the
   in-memory fallback is the expected non-buggy outcome (SC-009 still holds).
2. **Pause on focus loss** — the design implements the spec's focus-loss edge case
   as *pause* (stops gravity + ignores keys), not merely "ignore stray keys."
3. **Per-row drop bonus** — soft/hard-drop points are awarded per row actually
   dropped (the move's delta), not per keypress — phrase `tasks.md` accordingly.
